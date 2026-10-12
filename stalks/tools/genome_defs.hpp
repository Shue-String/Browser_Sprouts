#pragma once
// The collection genomes that feed the fold/collision registry, read at runtime straight from
// src/data/collectionElements.json (the single source of record for every collection, its genome
// and its elements -- see scripts/collectionsJson.cjs for the schema). Only genomes whose T-genes
// are ALL collection names are loaded: one still holding a nested, unnamed T genome can't be
// expressed as a GenomeDef and is display-only. The registry built from these is
// alpha_genome.cpp's buildNamedGenomes/namedFamilies, mirroring collectAlpha.ts's
// GENOME_DEFS/buildRegistry.
//
// Read via stalks::collectionElementsJson() (collections.hpp), whose path CMake bakes in
// (STALKS_COLLECTION_ELEMENTS_JSON) -- an edit to the JSON takes effect on the next run, no rebuild.
#include <string>
#include <utility>
#include <vector>

namespace stalks_tools {
namespace genome_defs {

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

struct GenomeDefs {
    int maxShift;
    int maxFoldDepth;
    // In the JSON's collection order -- load-bearing: buildRegistry's collision-resolution
    // priority is base forms before shifted forms, in this order.
    std::vector<std::pair<std::string, GenomeDef>> families;
};

// Loaded once, on first call; throws std::runtime_error (naming the path) if the file is missing or
// malformed.
const GenomeDefs& genomeDefs();

}  // namespace genome_defs
}  // namespace stalks_tools
