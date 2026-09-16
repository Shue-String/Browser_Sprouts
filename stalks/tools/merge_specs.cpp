// Offline tool: union N already-solved .spec corpora (see specfile.hpp) into ONE .spec file, by
// encoding, with NO recomputation -- every discovery/audit tool in this directory (find_yellow_
// candidates, unregistered_left_sides, audit_registry, ...) currently takes a variadic list of
// .spec paths and scans each independently; in practice that's always the same fixed set (the
// three corpora listed in .gitignore: alpha_beta_pair_vs_split.spec, single_alpha_5real.spec,
// single_alpha_5real_richboundary.spec). This tool lets that set be merged once so downstream
// tools can take a single path instead.
//
// How this avoids re-solving: loadSpecGraph (specfile.cpp), when asked via retainChildIndices,
// keeps each edge's target(s) as indices into its OWN file's node list (not just the resolved
// value, which is all it normally retains). A source .spec file is always closed under its own
// edges (writeMinimalSpec's own invariant) and is written in a valid topological order, so a
// straightforward order-preserving, dedup-by-encoding concatenation of several such files is
// STILL a valid topological order for the union (a node's dependency, if new, was already before
// it in the same source file; if it's a duplicate of something from an earlier source file, it was
// already emitted before this file was even processed) -- no separate topological re-sort needed.
// See specfile.hpp's saveSpecNodes doc comment for the formal contract this relies on.
//
// Usage: merge_specs <out.spec> <spec1.spec> <spec2.spec> [spec3.spec ...]
#include "specfile.hpp"

#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>

using namespace stalks;

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: merge_specs <out.spec> <spec1.spec> <spec2.spec> [spec3.spec ...]\n";
        return 1;
    }
    const std::string outPath = argv[1];
    std::vector<std::string> inPaths;
    for (int i = 2; i < argc; ++i)
        inPaths.push_back(argv[i]);

    std::vector<SpecNode> merged;
    std::unordered_map<std::string, std::size_t> encToGlobal;
    bool haveMode = false;
    GameGraph::Mode mode = GameGraph::Mode::Exact;
    std::size_t totalIn = 0, duplicates = 0, mismatches = 0;

    for (const std::string& path : inPaths) {
        SpecDB db;
        try {
            db = loadSpecGraphFromFile(path, /*retainChildIndices=*/true);
        } catch (const std::exception& e) {
            std::cerr << "error loading " << path << ": " << e.what() << "\n";
            return 1;
        }
        std::cerr << path << ": " << db.size() << " nodes (mode="
                  << (db.mode() == GameGraph::Mode::Quick ? "Quick" : "Exact") << ")\n";
        if (!haveMode) {
            mode = db.mode();
            haveMode = true;
        } else if (db.mode() != mode) {
            std::cerr << "error: " << path << " is a different mode than earlier inputs -- "
                      << "cannot merge Quick and Exact corpora into one file\n";
            return 1;
        }

        totalIn += db.nodes().size();
        std::vector<std::size_t> localToGlobal(db.nodes().size());
        for (std::size_t i = 0; i < db.nodes().size(); ++i) {
            const SpecNode& src = db.nodes()[i];
            const auto it = encToGlobal.find(src.enc);
            if (it != encToGlobal.end()) {
                ++duplicates;
                const SpecNode& existing = merged[it->second];
                if (existing.value.nimber != src.value.nimber ||
                    existing.value.minMoves != src.value.minMoves ||
                    existing.value.maxMoves != src.value.maxMoves) {
                    ++mismatches;
                    std::cerr << "MISMATCH: '" << src.enc << "' has value ("
                              << existing.value.nimber << "," << existing.value.minMoves << ","
                              << existing.value.maxMoves << ") from an earlier file but ("
                              << src.value.nimber << "," << src.value.minMoves << ","
                              << src.value.maxMoves << ") in " << path
                              << " -- same encoding must always be the same game value; the source"
                              << " corpora disagree, not just duplicate each other\n";
                }
                localToGlobal[i] = it->second;
                continue;
            }
            const std::size_t g = merged.size();
            encToGlobal.emplace(src.enc, g);
            localToGlobal[i] = g;

            SpecNode node;
            node.enc = src.enc;
            node.value = src.value;
            node.edges.reserve(src.edges.size());
            for (const SpecEdge& e : src.edges) {
                SpecEdge ne;
                ne.child = e.child;
                ne.movetype = e.movetype;
                ne.offset = e.offset;
                ne.childIndices.reserve(e.childIndices.size());
                for (std::size_t ci : e.childIndices)
                    ne.childIndices.push_back(localToGlobal[ci]);  // ci < i always (topological)
                node.edges.push_back(std::move(ne));
            }
            merged.push_back(std::move(node));
        }
    }

    if (mismatches > 0) {
        std::cerr << mismatches << " value mismatch(es) found -- refusing to write a merged file "
                  << "that could silently hide a real discrepancy between corpora\n";
        return 1;
    }

    std::cerr << "merging: " << totalIn << " total input nodes, " << duplicates
              << " duplicate(s) dropped, " << merged.size() << " unique node(s) written\n";

    try {
        saveSpecNodesToFile(mode, merged, outPath);
    } catch (const std::exception& e) {
        std::cerr << "error writing " << outPath << ": " << e.what() << "\n";
        return 1;
    }
    std::cerr << "wrote " << outPath << "\n";
    return 0;
}
