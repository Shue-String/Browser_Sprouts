// GENERATED FILE -- do not hand-edit.
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

constexpr int kMaxShift = 3;

// Declaration order matches genomeDefs.json exactly -- required for buildRegistry's
// collision-resolution priority (base forms before shifted forms, in this order).
inline const std::vector<std::pair<std::string, GenomeDef>>& familyDefs() {
    static const std::vector<std::pair<std::string, GenomeDef>> kDefs = {
    {"S_1", {0, 1, {0}, {}, {}}},
    {"S_2", {1, 1, {0}, {0}, {}}},
    {"S_3", {1, 2, {1}, {0}, {{"S_1", 0}}}},
    {"S_4", {2, 0, {1}, {}, {{"S_2", 0}, {"S_1", 0}}}},
    {"S_5", {2, 0, {1}, {1}, {{"S_2", 0}, {"S_1", 0}}}},
    {"S_6", {0, 1, {0, 2}, {}, {{"S_1", 1}}}},
    {"S_7", {0, 2, {0, 1}, {}, {{"S_1", 1}}}},
    {"S_8", {2, 3, {0, 2}, {}, {{"S_1", 0}, {"S_1", 1}}}},
    {"S_9", {0, 2, {0}, {}, {{"S_2", 0}, {"S_1", 1}}}},
    {"S_10", {0, 2, {0, 1}, {}, {{"S_2", 0}, {"S_1", 1}}}},
    {"S_11", {0, 3, {2}, {}, {{"S_2", 0}, {"S_1", 1}}}},
    {"S_12", {0, 3, {0, 2}, {}, {{"S_2", 0}, {"S_1", 1}}}},
    {"S_13", {0, 3, {1, 2}, {}, {{"S_2", 0}, {"S_1", 1}}}},
    {"S_14", {0, 3, {0, 1, 2}, {}, {{"S_2", 0}, {"S_1", 1}}}},
    {"S_15", {2, 3, {2}, {}, {{"S_1", 0}, {"S_2", 0}, {"S_1", 1}}}},
    {"S_16", {2, 2, {0, 1}, {}, {{"S_1", 0}, {"S_2", 0}, {"S_1", 1}}}},
    {"S_17", {2, 3, {0, 2}, {}, {{"S_2", 0}, {"S_1", 0}, {"S_1", 1}}}},
    {"S_18", {2, 3, {0, 1, 2}, {}, {{"S_2", 0}, {"S_1", 0}, {"S_1", 1}}}},
    {"S_19", {0, 0, {2}, {1}, {{"S_2", 0}, {"S_3", 0}}}},
    {"S_20", {0, 1, {0, 2}, {}, {{"S_3", 0}, {"S_1", 1}}}},
    {"S_21", {0, 3, {0, 1}, {}, {{"S_3", 0}, {"S_1", 1}}}},
    {"S_22", {0, 3, {0}, {}, {{"S_2", 0}, {"S_3", 0}, {"S_1", 1}}}},
    {"S_23", {0, 3, {2}, {1}, {{"S_2", 0}, {"S_3", 0}, {"S_1", 1}}}},
    {"S_24", {0, 3, {0, 1}, {}, {{"S_2", 0}, {"S_1", 1}, {"S_3", 0}}}},
    {"S_25", {0, 3, {0, 2}, {}, {{"S_2", 0}, {"S_3", 0}, {"S_1", 1}}}},
    {"S_26", {0, 3, {0, 1, 2}, {}, {{"S_2", 0}, {"S_3", 0}, {"S_1", 1}}}},
    };
    return kDefs;
}

inline const std::vector<LegacyFoldKey>& legacyFoldKeys() {
    static const std::vector<LegacyFoldKey> kKeys = {
    {"(0,1,{0},{},[S_1⊕1])", "S_1", {"S_1⊕1"}},
    {"(0,1,{0},{},[S_3,S_1⊕1])", "S_1", {"S_3", "S_1⊕1"}},
    };
    return kKeys;
}

}  // namespace genome_defs_generated
}  // namespace stalks_tools
