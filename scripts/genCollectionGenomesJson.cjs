// Emits src/data/collectionGenomes.generated.json: every Collection's genome (hand-authored AND
// engine-derived, see collectionsJson.cjs) plus maxShift/maxFoldDepth, taken from
// src/data/collectionElements.json. A small slice of that file on purpose -- collectAlpha.ts and
// collect.ts need only the genomes, and importing the full element lists would add ~320KB of
// left-side encodings to the front-end bundle. Pure derivation, no data of its own.
//
// Run after editing collectionElements.json: `node scripts/genCollectionGenomesJson.cjs`
const fs = require('fs');
const path = require('path');
const { JSON_PATH } = require('./collectionsJson.cjs');

const OUT_PATH = path.resolve(__dirname, '..', 'src', 'data', 'collectionGenomes.generated.json');

// Pure: JSON data in, generated file text out (same contract as the other generators, so
// scripts/checkGeneratedHeaders.cjs can reuse it to check OUT_PATH for staleness).
function generateContent(data) {
  const rows = data.collections
    .filter(c => c.genome)
    .map(c => '    ' + JSON.stringify({ name: c.name, genome: c.genome }));
  return `{
  "_generated": "GENERATED FILE -- do not hand-edit. Produced by scripts/genCollectionGenomesJson.cjs from src/data/collectionElements.json.",
  "maxShift": ${data.maxShift},
  "maxFoldDepth": ${data.maxFoldDepth},
  "collections": [
${rows.join(',\n')}
  ]
}
`;
}

function generate() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  fs.writeFileSync(OUT_PATH, generateContent(data), 'utf8');
  console.log(`Wrote ${path.relative(path.resolve(__dirname, '..'), OUT_PATH)} (${data.collections.filter(c => c.genome).length} genomes)`);
}

module.exports = { JSON_PATH, OUT_PATH, generateContent };

if (require.main === module) generate();
