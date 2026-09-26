// Fails (nonzero exit) if either committed .generated.hpp is stale relative to its hand-authored
// JSON source -- i.e. if re-running the generator right now would produce different bytes than
// what's on disk. Catches both failure modes the JSON->hpp step of the Collections /
// genome-defs data pipeline is otherwise silent about: editing the JSON and forgetting to re-run
// the generator, and hand-editing the "do not hand-edit" .generated.hpp directly.
//
// Reuses each generator's own generateContent(data) (see genCollectionElementsHeader.cjs /
// genGenomeDefsHeader.cjs) rather than re-deriving the JSON->C++ shape here, so this check can never
// drift out of sync with what the generators actually produce.
//
// This only covers the JSON->hpp leg. The remaining leg -- rebuilding the native engine and
// re-running stalks/tools/dump_collections_roster.cpp to refresh src/data/collectionsRoster.json --
// needs a native build and isn't something a plain Node script can enforce; this check at least
// guarantees that IF the native build sees fresh input, it starts from the .hpp the JSON actually
// describes.
//
// Run directly (`node scripts/checkGeneratedHeaders.cjs`), or via `npm run build` where it's wired
// in as a pre-check.

const fs = require('fs');

const collectionElements = require('./genCollectionElementsHeader.cjs');
const genomeDefs = require('./genGenomeDefsHeader.cjs');

const TARGETS = [
  { label: 'collection elements', ...collectionElements, regenCmd: 'node scripts/genCollectionElementsHeader.cjs' },
  { label: 'genome defs', ...genomeDefs, regenCmd: 'node scripts/genGenomeDefsHeader.cjs' },
];

// core.autocrlf=true in this repo (no .gitattributes override) means a freshly checked-out
// .generated.hpp has CRLF line endings on disk even though the generators (and git's own stored
// blob) use bare LF -- normalize both sides so that difference alone never reads as staleness.
function normalizeEol(s) {
  return s.replace(/\r\n/g, '\n');
}

function check({ label, JSON_PATH, OUT_PATH, generateContent, regenCmd }) {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const expected = normalizeEol(generateContent(data));
  const actual = fs.existsSync(OUT_PATH) ? normalizeEol(fs.readFileSync(OUT_PATH, 'utf8')) : null;
  if (actual === expected) return null;
  return { label, OUT_PATH, regenCmd, missing: actual === null };
}

function main() {
  const stale = TARGETS.map(check).filter(Boolean);
  if (stale.length === 0) {
    console.log('Generated headers are up to date with their JSON sources.');
    return;
  }
  console.error('Stale or hand-edited generated header(s) found:\n');
  for (const s of stale) {
    console.error(`  ${s.OUT_PATH}`);
    console.error(`    ${s.missing ? 'does not exist' : "doesn't match its JSON source"} -- run: ${s.regenCmd}`);
  }
  console.error('\nAfter regenerating, rebuild the native engine (stalks/build.bat) before trusting');
  console.error('its output -- and if collectionElements.json changed, re-run');
  console.error('stalks/tools/dump_collections_roster.exe to refresh src/data/collectionsRoster.json too.');
  process.exit(1);
}

main();
