// Renames Collections / genome families across the two hand-maintained JSON source files
// and regenerates everything derived from them. Built as a standing tool because this codebase has
// already renamed genome families multiple times (see project_advanced_collections.md's rename
// history, and collections.cpp's own 2026-08-29 "NAMING NOTE" doc comment) and is expected to
// again -- no other file hand-duplicates a family name; everything else (the two .generated.hpp
// files, collectionsRoster.json, collectAlpha.ts's in-memory registry) is a mechanical derivation
// of these two JSON files, rebuilt by the pipeline this script drives.
//
// Usage: node scripts/renameGenomes.cjs <mapping.json> [--dry-run] [--skip-native]
//
// mapping.json: { "OldName": "NewName", ... } -- BASE family names only, exactly as they appear as
// src/data/genomeDefs.json object keys (no "⊕n" suffix -- that's a separate `shift` field there).
// Every key must currently exist in genomeDefs.json. Omit a family to leave its name unchanged.
// The resulting full name set (renamed + unrenamed) must stay a bijection -- checked before
// anything is written, and nothing is written at all if validation fails.
//
// What this touches:
//  - src/data/genomeDefs.json: family object keys + every T[].name reference (base names only),
//    via an exact-quoted-string two-phase (old -> sentinel -> new) text replace that preserves the
//    file's existing hand-curated one-line-per-family formatting AND declaration order exactly.
//    Declaration order is NOT touched, even cosmetically: it is load-bearing for collision-priority
//    resolution whenever two+ families share a bare (R,D,{L},{Z}) core with different T-lists
//    (scripts/genGenomeDefsHeader.cjs's own header comment: "order is load-bearing"; confirmed
//    empirically 2026-09-20 -- an earlier version of this tool DID reorder to new-numeric order "for
//    readability" and silently changed several T-gene fold counts as a result, since bypassOnlyFold
//    /familyForCoreKey pick the FIRST declared family for an ambiguous core. Renaming must be a
//    pure relabeling with zero fold-behavior change -- reorder the file by hand afterward, as a
//    SEPARATE, deliberately-reviewed step, if wanted).
//  - src/data/collectionElements.json: every groups[].name field across single/double/multi,
//    using the EXPANDED mapping (base name plus its "⊕1"/"⊕2"/"⊕3" siblings, since roster group
//    names carry the offset suffix literally, unlike genomeDefs.json's separate shift field).
//  - Unless --skip-native: regenerates both .generated.hpp files, rebuilds the native stalks_tests
//    / dump_collections_roster targets, re-dumps src/data/collectionsRoster.json, and runs
//    stalks_tests.exe to confirm no collision/regression.
//
// What this does NOT do (finish manually, in order):
//  1. Rebuild WASM (stalks/build_wasm.bat) -- not run automatically since it's the flakiest step in
//     this codebase (see reference_stalks_wasm_build_gotcha), worth doing watched.
//  2. `npx tsc --noEmit` and a live browser check of the Collect pane / Collections panel.
//  3. Regenerate src/data/collectAlphaGenomes.json ONLY if you also changed genome bucket data
//     (R/D/L/Z shapes) -- a pure rename never does; names are resolved live from genomeDefs.json,
//     never baked into that snapshot, so it does not need touching for a rename alone.
// Also does not touch historical prose comments that reference old names for context (established
// project convention -- see collections.cpp's own NAMING NOTE, which deliberately left its OWN
// prior-rename history using the OLD names it was describing at the time).
//
// Safety: run with --dry-run first to see the exact diff without writing anything. NEVER run the
// --skip-native-less (native-rebuilding) form while a Vite dev server is watching this repo -- see
// reference_dev_server_vs_native_build_collision.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENOME_DEFS_PATH = path.join(REPO_ROOT, 'src', 'data', 'genomeDefs.json');
const COLLECTION_ELEMENTS_PATH = path.join(REPO_ROOT, 'src', 'data', 'collectionElements.json');
const ROSTER_JSON_PATH = path.join(REPO_ROOT, 'src', 'data', 'collectionsRoster.json');

function fail(msg) {
  console.error(`renameGenomes: ${msg}`);
  process.exit(1);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- CLI ----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipNative = args.includes('--skip-native');
const mappingPath = args.find(a => !a.startsWith('--'));
if (!mappingPath) fail('usage: node scripts/renameGenomes.cjs <mapping.json> [--dry-run] [--skip-native]');

const mapping = JSON.parse(fs.readFileSync(path.resolve(mappingPath), 'utf8'));
const realRenames = Object.entries(mapping).filter(([o, n]) => o !== n);
if (realRenames.length === 0) {
  console.log('renameGenomes: mapping has no actual renames (every entry maps to itself). Nothing to do.');
  process.exit(0);
}

// ---- Validate against genomeDefs.json's current family set ----
const genomeDefsRaw = fs.readFileSync(GENOME_DEFS_PATH, 'utf8');
const genomeDefs = JSON.parse(genomeDefsRaw);
const currentNames = Object.keys(genomeDefs.families);
const currentSet = new Set(currentNames);

for (const [oldName] of realRenames) {
  if (!currentSet.has(oldName)) fail(`mapping key "${oldName}" is not a current genomeDefs.json family`);
}
const newNameValues = realRenames.map(([, n]) => n);
const dupNew = newNameValues.find((n, i) => newNameValues.indexOf(n) !== i);
if (dupNew) fail(`mapping is not injective: multiple old names map to "${dupNew}"`);

const finalNames = currentNames.map(o => mapping[o] ?? o);
const finalSet = new Set(finalNames);
if (finalSet.size !== finalNames.length) {
  const seen = new Set();
  const dup = finalNames.find(n => (seen.has(n) ? true : (seen.add(n), false)));
  fail(`resulting name set has a collision at "${dup}" -- check for an unmapped family whose current ` +
       `name equals some other family's mapping target`);
}
console.log(`renameGenomes: ${realRenames.length} real rename(s) validated against ${currentNames.length} ` +
            `current genomeDefs.json families -- resulting name set is a clean bijection.`);

// ---- 1. genomeDefs.json: exact-quoted-string two-phase text replace, preserving formatting AND
// declaration order exactly (see this file's own header comment on why order must never change) ----
const SENTINEL = i => `__RENAME_SENTINEL_${i}__`;
let genomeDefsText = genomeDefsRaw;
realRenames.forEach(([oldName], i) => {
  const re = new RegExp(`"${escapeRegExp(oldName)}"`, 'g');
  genomeDefsText = genomeDefsText.replace(re, `"${SENTINEL(i)}"`);
});
realRenames.forEach(([, newName], i) => {
  genomeDefsText = genomeDefsText.split(`"${SENTINEL(i)}"`).join(`"${newName}"`);
});

// Verify the rewritten text is still valid JSON and has exactly the expected final family set (in
// the SAME declaration order as before), before writing anything to disk.
let rewritten;
try {
  rewritten = JSON.parse(genomeDefsText);
} catch (e) {
  fail(`rewritten genomeDefs.json failed to re-parse as JSON: ${e.message}`);
}
const rewrittenNames = Object.keys(rewritten.families);
const expectedOrder = currentNames.map(o => mapping[o] ?? o);
const orderMatches = rewrittenNames.length === expectedOrder.length &&
  rewrittenNames.every((n, i) => n === expectedOrder[i]);
if (!orderMatches) {
  fail('rewritten genomeDefs.json family set/order does not match the expected renamed-in-place result');
}

// ---- 2. collectionElements.json: rename groups[].name across single/double/multi ----
const expandedMapping = {};
for (const [oldName, newName] of realRenames) {
  expandedMapping[oldName] = newName;
  for (let k = 1; k <= (genomeDefs.maxShift ?? 3); k++) {
    expandedMapping[`${oldName}⊕${k}`] = `${newName}⊕${k}`;
  }
}
const collectionElements = JSON.parse(fs.readFileSync(COLLECTION_ELEMENTS_PATH, 'utf8'));
let groupRenameCount = 0;
for (const bucket of ['single', 'double', 'multi']) {
  for (const fam of collectionElements[bucket] ?? []) {
    for (const group of fam.groups ?? []) {
      if (Object.prototype.hasOwnProperty.call(expandedMapping, group.name)) {
        group.name = expandedMapping[group.name];
        groupRenameCount++;
      }
    }
  }
}
console.log(`renameGenomes: ${groupRenameCount} roster group name(s) renamed in collectionElements.json ` +
            `(base + ⊕n siblings).`);
const collectionElementsText = JSON.stringify(collectionElements, null, 2) + '\n';

// ---- Report + write ----
console.log('\nFull mapping applied:');
for (const [o, n] of realRenames) console.log(`  ${o} -> ${n}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

fs.writeFileSync(GENOME_DEFS_PATH, genomeDefsText);
fs.writeFileSync(COLLECTION_ELEMENTS_PATH, collectionElementsText);
console.log(`\nWrote ${GENOME_DEFS_PATH}\nWrote ${COLLECTION_ELEMENTS_PATH}`);

// ---- Regenerate + rebuild pipeline ----
function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  execFileSync(cmd, cmdArgs, { cwd: REPO_ROOT, stdio: 'inherit', shell: true, ...opts });
}

run('node', ['scripts/genGenomeDefsHeader.cjs']);
run('node', ['scripts/genCollectionElementsHeader.cjs']);
run('node', ['scripts/checkGeneratedHeaders.cjs']);

if (skipNative) {
  console.log('\n--skip-native: stopping here. Remaining manual steps: native rebuild, ' +
              'dump_collections_roster, stalks_tests, WASM rebuild, tsc, live verification.');
  process.exit(0);
}

run('cmd', ['/c', 'stalks\\build.bat']);
run(path.join('stalks', 'build', 'dump_collections_roster.exe'), [
  path.relative(path.join(REPO_ROOT, 'stalks'), ROSTER_JSON_PATH),
], { cwd: path.join(REPO_ROOT, 'stalks') });

console.log('\nDone. Remaining manual steps: rebuild WASM (stalks/build_wasm.bat), `npx tsc --noEmit`, ' +
            'live-verify the Collect pane / Collections panel in the browser.');
