// Mechanically transcribes the hand-authored genomes in src/data/collectionElements.json (the
// single source of the alpha-genome family shapes -- see src/model/collectAlpha.ts's own doc
// comment on GENOME_DEFS; genomes flagged "derived" are engine-computed snapshots and are skipped)
// into stalks/tools/genome_defs.generated.hpp: a compile-time C++ literal with the exact same
// shape, in the exact same order (collection order in the JSON; order is load-bearing -- see collectAlpha.ts's buildRegistry
// doc comment on collision-resolution priority).
//
// This script does NO derivation -- it only reshapes JSON into C++ struct-literal syntax. The
// fold/collision algorithm (resolveGenome/buildRegistry) is ported natively in alpha_genome.cpp
// and consumes the generated table the same way collectAlpha.ts consumes the JSON directly, so
// the algorithm itself is the only thing that (deliberately) exists in both languages -- the DATA
// exists in exactly one hand-edited place.
//
// Run after editing collectionElements.json: `node scripts/genGenomeDefsHeader.cjs`

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { JSON_PATH } = require('./collectionsJson.cjs');
const OUT_PATH = path.join(REPO_ROOT, 'stalks', 'tools', 'genome_defs.generated.hpp');

function cppStr(s) {
  // Genome family names/keys are plain ASCII plus U+2295 (⊕); escape only what C++ needs.
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function intArrayLiteral(nums) {
  return '{' + nums.join(', ') + '}';
}

function tChildLiteral(t) {
  const name = cppStr(t.name);
  const shift = t.shift ?? 0;
  return `{${name}, ${shift}}`;
}

function genomeDefLiteral(def) {
  const L = intArrayLiteral(def.L);
  const Z = intArrayLiteral(def.Z);
  const T = '{' + def.T.map(tChildLiteral).join(', ') + '}';
  return `{${def.R}, ${def.D}, ${L}, ${Z}, ${T}}`;
}

// [name, genome] for every collection with a hand-authored (non-derived) genome, in JSON order.
function authoredGenomes(data) {
  return data.collections.filter(c => c.genome && !c.genome.derived).map(c => [c.name, c.genome]);
}

// Pure: JSON data in, generated file text out -- no disk I/O, so scripts/checkGeneratedHeaders.cjs
// can reuse this exact logic to check OUT_PATH for staleness without re-deriving it.
function generateContent(data) {
  const familyEntries = authoredGenomes(data)
    .map(([name, def]) => `    {${cppStr(name)}, ${genomeDefLiteral(def)}},`)
    .join('\n');

  return `// GENERATED FILE -- do not hand-edit.
// Produced by scripts/genGenomeDefsHeader.cjs from src/data/collectionElements.json (the
// single source of these shapes -- see src/model/collectAlpha.ts's GENOME_DEFS doc
// comment). Re-run that script after editing the JSON, then rebuild the native tools that
// #include this header (alpha_genome.cpp -- collect_alpha_genetics, unregistered_left_sides).
#pragma once

#include <string>
#include <vector>

namespace stalks_tools {
namespace genome_defs_generated {

struct TChildDef {
    std::string name;
    int shift;
};

struct GenomeDef {
    int R;
    int D;
    std::vector<int> L;
    std::vector<int> Z;
    std::vector<TChildDef> T;
};

constexpr int kMaxShift = ${data.maxShift};
constexpr int kMaxFoldDepth = ${data.maxFoldDepth};

// Declaration order matches collectionElements.json exactly -- required for buildRegistry's
// collision-resolution priority (base forms before shifted forms, in this order).
inline const std::vector<std::pair<std::string, GenomeDef>>& familyDefs() {
    static const std::vector<std::pair<std::string, GenomeDef>> kDefs = {
${familyEntries}
    };
    return kDefs;
}

}  // namespace genome_defs_generated
}  // namespace stalks_tools
`;
}

function generate() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  fs.writeFileSync(OUT_PATH, generateContent(data), 'utf8');
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_PATH)} (${authoredGenomes(data).length} families)`);
}

module.exports = { JSON_PATH, OUT_PATH, generateContent };

if (require.main === module) generate();
