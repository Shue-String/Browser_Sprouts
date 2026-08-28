// Mechanically transcribes src/data/genomeDefs.json (the single hand-authored source of the
// alpha-genome family shapes -- see src/model/collectAlpha.ts's own doc comment on GENOME_DEFS)
// into stalks/tools/genome_defs.generated.hpp: a compile-time C++ literal with the exact same
// shape, in the exact same order (order is load-bearing -- see collectAlpha.ts's buildRegistry
// doc comment on collision-resolution priority).
//
// This script does NO derivation -- it only reshapes JSON into C++ struct-literal syntax. The
// fold/collision algorithm (resolveGenome/buildRegistry) is ported natively in alpha_genome.cpp
// and consumes the generated table the same way collectAlpha.ts consumes the JSON directly, so
// the algorithm itself is the only thing that (deliberately) exists in both languages -- the DATA
// exists in exactly one hand-edited place.
//
// Run after editing genomeDefs.json: `node scripts/genGenomeDefsHeader.cjs`

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const JSON_PATH = path.join(REPO_ROOT, 'src', 'data', 'genomeDefs.json');
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
  const Tprime = intArrayLiteral(def.Tprime);
  const T = '{' + def.T.map(tChildLiteral).join(', ') + '}';
  return `{${def.R}, ${def.D}, ${L}, ${Tprime}, ${T}}`;
}

function generate() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  const familyEntries = Object.entries(data.families)
    .map(([name, def]) => `    {${cppStr(name)}, ${genomeDefLiteral(def)}},`)
    .join('\n');

  const legacyEntries = data.legacyFoldKeys
    .map(({ key, name, tChildPlains }) => {
      const plains = '{' + tChildPlains.map(cppStr).join(', ') + '}';
      return `    {${cppStr(key)}, ${cppStr(name)}, ${plains}},`;
    })
    .join('\n');

  const header = `// GENERATED FILE -- do not hand-edit.
// Produced by scripts/genGenomeDefsHeader.cjs from src/data/genomeDefs.json (the single
// hand-authored source of these shapes -- see src/model/collectAlpha.ts's GENOME_DEFS doc
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
    std::vector<int> Tprime;
    std::vector<TChildDef> T;
};

struct LegacyFoldKey {
    std::string key;
    std::string name;
    std::vector<std::string> tChildPlains;
};

constexpr int kMaxShift = ${data.maxShift};

// Declaration order matches genomeDefs.json exactly -- required for buildRegistry's
// collision-resolution priority (base forms before shifted forms, in this order).
inline const std::vector<std::pair<std::string, GenomeDef>>& familyDefs() {
    static const std::vector<std::pair<std::string, GenomeDef>> kDefs = {
${familyEntries}
    };
    return kDefs;
}

inline const std::vector<LegacyFoldKey>& legacyFoldKeys() {
    static const std::vector<LegacyFoldKey> kKeys = {
${legacyEntries}
    };
    return kKeys;
}

}  // namespace genome_defs_generated
}  // namespace stalks_tools
`;

  fs.writeFileSync(OUT_PATH, header, 'utf8');
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_PATH)} (${Object.keys(data.families).length} families, ${data.legacyFoldKeys.length} legacy keys)`);
}

generate();
