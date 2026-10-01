// Renames Collections across the one hand-maintained source file, src/data/collectionElements.json,
// and regenerates everything derived from it. Built as a standing tool because this codebase has
// already renamed collections multiple times (see project_advanced_collections.md's rename
// history, and collections.cpp's own 2026-08-29 "NAMING NOTE" doc comment) and is expected to
// again -- no other file hand-duplicates a collection name; everything else (the two .generated.hpp
// files, collectionGenomes.generated.json, collectionsRoster.json, collectAlpha.ts's in-memory
// registry) is a mechanical derivation of that one file, rebuilt by the pipeline this script drives.
//
// Usage: node scripts/renameGenomes.cjs <mapping.json> [--dry-run] [--skip-native]
//
// mapping.json: { "OldName": "NewName", ... } -- BASE collection names only, exactly as they appear
// as collectionElements.json collections[].name (no "⊕n" suffix -- an offset is a structural
// `offset` field on a group there, never part of a stored name). Every key must currently exist.
// Omit a collection to leave its name unchanged. The resulting full name set (renamed + unrenamed)
// must stay a bijection -- checked before anything is written, and nothing is written at all if
// validation fails.
//
// What this touches, all inside collectionElements.json: every collections[].name, and every
// genome T-child reference to a renamed collection (at any nesting depth -- a derived genome's T
// list can hold nested genomes). Nothing else in the file mentions a collection name (group names
// are derived from name + offset). The rename is a two-phase (old -> sentinel -> new) structural
// rewrite, so cyclic/chained mappings (A->B, B->A) are safe by construction.
//
// Collection ORDER is NOT touched, even cosmetically: among hand-authored genomes it is
// load-bearing for collision-priority resolution whenever two+ share a bare (R,D,{L},{Z}) core with
// different T-lists (scripts/genGenomeDefsHeader.cjs: "order is load-bearing"; confirmed
// empirically 2026-09-20 -- an earlier version of this tool DID reorder "for readability" and
// silently changed several T-gene fold counts, since bypassOnlyFold/familyForCoreKey pick the FIRST
// declared family for an ambiguous core). Renaming must be a pure relabeling with zero fold-behavior
// change -- reorder the file by hand afterward, as a SEPARATE, deliberately-reviewed step, if wanted.
//
// Also regenerates, via `npm run gen:headers`'s three scripts: both .generated.hpp files and
// src/data/collectionGenomes.generated.json. Unless --skip-native it then rebuilds the native
// engine (stalks/build.bat) and re-dumps src/data/collectionsRoster.json.
//
// What this does NOT do (finish manually, in order):
//  1. Rebuild WASM (stalks/build_wasm.bat) -- not run automatically since it's the flakiest step in
//     this codebase (see reference_stalks_wasm_build_gotcha), worth doing watched.
//  2. `npx tsc --noEmit` and a live browser check of the Collect pane / Collections panel.
//  3. Regenerate src/data/collectAlphaGenomes.json ONLY if you also changed genome bucket data
//     (R/D/L/Z shapes) -- a pure rename never does.
// Also does not touch historical prose comments that reference old names for context (established
// project convention -- see collections.cpp's own NAMING NOTE, which deliberately left its OWN
// prior-rename history using the OLD names it was describing at the time).
//
// Safety: run with --dry-run first to see the exact result without writing anything. NEVER run the
// --skip-native-less (native-rebuilding) form while a Vite dev server is watching this repo -- see
// reference_dev_server_vs_native_build_collision.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { read, write } = require('./collectionsJson.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROSTER_JSON_PATH = path.join(REPO_ROOT, 'src', 'data', 'collectionsRoster.json');

function fail(msg) {
  console.error(`renameGenomes: ${msg}`);
  process.exit(1);
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

// ---- Validate against the current collection set ----
const data = read();
const currentNames = data.collections.map(c => c.name);
const currentSet = new Set(currentNames);

for (const [oldName] of realRenames) {
  if (!currentSet.has(oldName)) fail(`mapping key "${oldName}" is not a current collectionElements.json collection`);
}
const newNameValues = realRenames.map(([, n]) => n);
const dupNew = newNameValues.find((n, i) => newNameValues.indexOf(n) !== i);
if (dupNew) fail(`mapping is not injective: multiple old names map to "${dupNew}"`);

const finalNames = currentNames.map(o => mapping[o] ?? o);
if (new Set(finalNames).size !== finalNames.length) {
  const seen = new Set();
  const dup = finalNames.find(n => (seen.has(n) ? true : (seen.add(n), false)));
  fail(`resulting name set has a collision at "${dup}" -- check for an unmapped collection whose current ` +
       `name equals some other collection's mapping target`);
}
console.log(`renameGenomes: ${realRenames.length} real rename(s) validated against ${currentNames.length} ` +
            `current collections -- resulting name set is a clean bijection.`);

// ---- Rename: two-phase (old -> sentinel -> new) so chained/cyclic mappings can't clobber ----
const SENTINEL = i => `__RENAME_SENTINEL_${i}__`;
const toSentinel = new Map(realRenames.map(([o], i) => [o, SENTINEL(i)]));
const fromSentinel = new Map(realRenames.map(([, n], i) => [SENTINEL(i), n]));

let nameRefs = 0;
function mapNames(map) {
  const renameIn = name => {
    if (!map.has(name)) return name;
    nameRefs++;
    return map.get(name);
  };
  const walkGenome = g => {
    for (const t of g.T) {
      if ('name' in t) t.name = renameIn(t.name);
      else walkGenome(t);
    }
  };
  for (const c of data.collections) {
    c.name = renameIn(c.name);
    if (c.genome) walkGenome(c.genome);
  }
}
mapNames(toSentinel);
nameRefs = 0;
mapNames(fromSentinel);
console.log(`renameGenomes: ${nameRefs} name reference(s) rewritten (collection names + genome T-children).`);

// Order must be byte-for-byte the expected renamed-in-place result.
const renamedOrder = data.collections.map(c => c.name);
if (!renamedOrder.every((n, i) => n === finalNames[i])) {
  fail('rewritten collection order does not match the expected renamed-in-place result');
}

// ---- Report + write ----
console.log('\nFull mapping applied:');
for (const [o, n] of realRenames) console.log(`  ${o} -> ${n}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

write(data);
console.log('\nWrote src/data/collectionElements.json');

// ---- Regenerate + rebuild pipeline ----
function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  execFileSync(cmd, cmdArgs, { cwd: REPO_ROOT, stdio: 'inherit', shell: true, ...opts });
}

run('node', ['scripts/genGenomeDefsHeader.cjs']);
run('node', ['scripts/genCollectionElementsHeader.cjs']);
run('node', ['scripts/genCollectionGenomesJson.cjs']);
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
