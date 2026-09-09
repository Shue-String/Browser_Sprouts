// Offline tool: read master save files (both exact and quick mode) and emit two merged JSON files
// mapping each stored minimal node's own encoding -> {nimber, minMoves, maxMoves}, so the frontend
// can seed its positionCache meta stores at startup instead of recomputing everything on demand.
//
// Exact-mode saves are keyed by structural canon -- the same key positionCache.meta uses, so entries
// merge in directly. Quick-mode saves are keyed by quick-canon representative encoding instead;
// `nimber` there is the representative's OWN value (offset 0) -- a caller combining it with some
// specific position's own quick-canon offset must XOR that offset in itself, exactly like the
// engine's own quickAnalysis()/fullAnalysis() JSON (analyze.cpp) already works.
//
// Usage: dump_master_meta <out_exact.json> <out_quick.json> <save1.sprout> [save2.sprout ...]
// Each input file's mode is read from its own header (SolvedDB::mode()) -- exact and quick saves can
// be passed in any order, mixed together. Later files win on duplicate encodings within a mode
// (harmless -- values are recomputed identically).

#include "json_keys.hpp"
#include "json_util.hpp"
#include "savefile.hpp"

#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <string>

using namespace stalks;

namespace {

void writeMergedJson(const std::map<std::string, SolvedDB::Value>& merged, const std::string& outPath) {
    std::string out = "{";
    bool first = true;
    for (const auto& [enc, v] : merged) {
        if (!first) out += ',';
        first = false;
        jsonStr(out, enc);
        out += ":{";
        appendKey(out, kNimberKey, /*firstField=*/true);
        out += std::to_string(v.nimber);
        appendKey(out, kMinMovesKey);
        out += std::to_string(v.minMoves);
        appendKey(out, kMaxMovesKey);
        out += std::to_string(v.maxMoves);
        appendKey(out, kSubposCountKey);
        out += "1}";
    }
    out += "}";

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        std::exit(1);
    }
    f << out;
    std::cerr << "wrote " << merged.size() << " total entries to " << outPath << "\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: dump_master_meta <out_exact.json> <out_quick.json> <save1.sprout> "
                     "[save2.sprout ...]\n";
        return 1;
    }
    const std::string outExactPath = argv[1];
    const std::string outQuickPath = argv[2];

    std::map<std::string, SolvedDB::Value> mergedExact;
    std::map<std::string, SolvedDB::Value> mergedQuick;
    for (int i = 3; i < argc; ++i) {
        const std::string path = argv[i];
        SolvedDB db = loadGraphFromFile(path);
        auto& merged = (db.mode() == GameGraph::Mode::Exact) ? mergedExact : mergedQuick;
        for (const auto& e : db.entries()) merged[e.enc] = e.val;
        std::cerr << path << " (" << (db.mode() == GameGraph::Mode::Exact ? "exact" : "quick")
                   << "): " << db.size() << " nodes\n";
    }

    writeMergedJson(mergedExact, outExactPath);
    writeMergedJson(mergedQuick, outQuickPath);
    return 0;
}
