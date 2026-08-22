// Ad-hoc debug tool: analyze a single position encoding and dump its children.
// Usage: query_position "<encoding>" [--decompress]
#include "analyze.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include <cstdio>
#include <iostream>
#include <set>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: query_position <encoding> [--decompress]\n";
        return 1;
    }
    std::string enc = argv[1];
    if (argc >= 3 && std::string(argv[2]) == "--decompress") {
        stalks::Position p = stalks::parsePosition(enc);
        stalks::Position d = p.decompressed();
        std::cout << stalks::serialize(d) << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--children-tracked") {
        std::cout << stalks::childrenTrackedJson(enc) << "\n";
        return 0;
    }
    if (argc >= 6 && std::string(argv[2]) == "--region-moves") {
        const int comp = std::atoi(argv[3]);
        const int region = std::atoi(argv[4]);
        const int boundary = std::atoi(argv[5]);
        const int token = std::atoi(argv[6]);
        std::cout << stalks::regionMovesTrackedJson(enc, comp, region, boundary, token) << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--all-moves") {
        std::cout << stalks::allMovesTrackedJson(enc) << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--canon-only") {
        std::cout << stalks::canonOnly(enc) << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--quick-canon-only") {
        stalks::Position p = stalks::canonicalize(stalks::parsePosition(enc));
        const stalks::QuickCanonResult qc = stalks::quickCanon(p);
        std::cout << stalks::serialize(qc.rep) << " offset=" << qc.offset << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--quick-canon-trace") {
        stalks::resetQuickReductionCounts();
        stalks::Position p = stalks::canonicalize(stalks::parsePosition(enc));
        const stalks::QuickCanonResult qc = stalks::quickCanon(p);
        std::cout << stalks::serialize(qc.rep) << " offset=" << qc.offset << "\n";
        for (const auto& [key, count] : stalks::quickReductionCounts())
            std::cout << "  " << key << " x" << count << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--graph-ensure-only") {
        stalks::Position p = stalks::canonicalize(stalks::parsePosition(enc));
        stalks::GameGraph g;
        const stalks::Node* root = g.ensure(p);
        std::cout << "nimber=" << root->nimber << " minMoves=" << root->minMoves
                   << " maxMoves=" << root->maxMoves << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--find-mismatch") {
        // Walk every position reachable (via real moves) from the given start, comparing exact
        // structural nimber to quick-canon nimber at each one. Prints every mismatch found, in
        // BFS order (shallowest/smallest first) -- the first one printed whose own children are
        // ALL sound is the root cause; anything printed after it may just be inheriting the bug.
        stalks::Position root = stalks::canonicalize(stalks::parsePosition(enc));
        stalks::GameGraph gExact(stalks::GameGraph::Mode::Exact);
        stalks::GameGraph gQuick(stalks::GameGraph::Mode::Quick);
        std::set<std::string> visited;
        std::vector<stalks::Position> queue{root};
        visited.insert(stalks::serialize(root));
        int checked = 0, mismatches = 0;
        while (!queue.empty()) {
            stalks::Position p = std::move(queue.front());
            queue.erase(queue.begin());
            const stalks::Node* ex = gExact.ensure(p);
            int qoff = 0;
            const stalks::Node* qu = gQuick.ensure(p, &qoff);
            const int q = qu->nimber ^ qoff;
            ++checked;
            if (ex->nimber != q) {
                ++mismatches;
                std::cout << stalks::serialize(p) << ": exact=" << ex->nimber << " quick=" << q
                          << "\n";
            }
            for (auto& child : stalks::childrenAll(p)) {
                child.validate();
                stalks::Position c = stalks::canonicalize(child);
                if (visited.insert(stalks::serialize(c)).second)
                    queue.push_back(std::move(c));
            }
        }
        std::cerr << "checked " << checked << " positions, " << mismatches << " mismatches\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--graph-ensure-quick") {
        stalks::Position p = stalks::canonicalize(stalks::parsePosition(enc));
        stalks::GameGraph g(stalks::GameGraph::Mode::Quick);
        int off = 0;
        const stalks::Node* root = g.ensure(p, &off);
        std::cout << "nimber=" << (root->nimber ^ off) << " (rep nimber=" << root->nimber
                   << " offset=" << off << ")\n";
        return 0;
    }
    std::string result = stalks::analyzeFullJson(enc);
    std::cout << result << "\n";
    return 0;
}
