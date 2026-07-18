// Offline tool: read the master save files (exact mode) and emit a single merged JSON object
// mapping each stored minimal node's canonical encoding -> {nimber, minMoves, maxMoves}, so the
// frontend can seed its positionCache.meta store at startup instead of recomputing everything on
// demand. Only exact-mode saves are used: they're keyed by structural canon, the same key
// positionCache.meta uses, so entries can be merged in directly. Quick-mode saves are keyed by
// quick-canon representative + offset and would need different handling, so they're skipped here.
//
// Usage: dump_master_meta <out.json> <save1.sprout> [save2.sprout ...]
// Later files win on duplicate encodings (harmless -- values are recomputed identically).

#include "json_util.hpp"
#include "savefile.hpp"

#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <string>

using namespace stalks;

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: dump_master_meta <out.json> <save1.sprout> [save2.sprout ...]\n";
        return 1;
    }
    const std::string outPath = argv[1];

    std::map<std::string, SolvedDB::Value> merged;
    for (int i = 2; i < argc; ++i) {
        const std::string path = argv[i];
        SolvedDB db = loadGraphFromFile(path);
        if (db.mode() != GameGraph::Mode::Exact) {
            std::cerr << "skipping non-exact save: " << path << "\n";
            continue;
        }
        const auto& encs = db.encs();
        const auto& vals = db.values();
        for (std::size_t j = 0; j < encs.size(); ++j) merged[encs[j]] = vals[j];
        std::cerr << path << ": " << encs.size() << " nodes\n";
    }

    std::string out = "{";
    bool first = true;
    for (const auto& [enc, v] : merged) {
        if (!first) out += ',';
        first = false;
        jsonStr(out, enc);
        out += ":{\"nimber\":" + std::to_string(v.nimber) +
               ",\"minMoves\":" + std::to_string(v.minMoves) +
               ",\"maxMoves\":" + std::to_string(v.maxMoves) +
               ",\"subposCount\":1}";
    }
    out += "}";

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << out;
    std::cerr << "wrote " << merged.size() << " total entries to " << outPath << "\n";
    return 0;
}
