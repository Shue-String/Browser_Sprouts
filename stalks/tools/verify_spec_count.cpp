// Independent verification tool: builds the SAME two-root graph save_spec.exe does, but counts
// reachable minimal nodes via a plain BFS (no specfile.cpp code at all) -- ground truth to check
// the .spec writer/reader against, plus per-root breakdown and a duplicate-encoding check on the
// loaded file.
//
// Usage: verify_spec_count <spec-file> <enc1> [enc2 ...]
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <iostream>
#include <set>
#include <string>
#include <unordered_set>
#include <vector>

using namespace stalks;

namespace {
std::unordered_set<const Node*> reachableMinSet(const std::vector<const Node*>& roots) {
    std::unordered_set<const Node*> minSet;
    std::unordered_set<const Node*> seen;
    std::vector<const Node*> stack(roots.begin(), roots.end());
    for (const Node* r : roots) seen.insert(r);
    while (!stack.empty()) {
        const Node* n = stack.back(); stack.pop_back();
        if (!n->isSum()) minSet.insert(n);
        for (const Node* c : n->children) if (seen.insert(c).second) stack.push_back(c);
        for (const Node* s : n->subpositions) if (seen.insert(s).second) stack.push_back(s);
    }
    return minSet;
}
}

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: verify_spec_count <spec-file> <enc1> [enc2 ...]\n"; return 1; }
    const std::string specPath = argv[1];
    std::vector<std::string> encs;
    for (int i = 2; i < argc; ++i) encs.push_back(argv[i]);

    GameGraph g;
    std::vector<const Node*> roots;
    for (const std::string& e : encs) roots.push_back(g.ensure(parsePosition(e)));

    std::cout << "total nodes in live GameGraph (incl. sums): " << g.size() << "\n";

    std::vector<std::unordered_set<const Node*>> perRoot;
    for (std::size_t i = 0; i < roots.size(); ++i) {
        auto s = reachableMinSet({roots[i]});
        std::cout << "root " << encs[i] << ": " << s.size() << " reachable minimal nodes\n";
        perRoot.push_back(std::move(s));
    }

    const auto combined = reachableMinSet(roots);
    std::cout << "combined (union of all roots): " << combined.size() << " reachable minimal nodes\n";

    if (perRoot.size() == 2) {
        std::size_t overlap = 0;
        for (const Node* n : perRoot[0]) if (perRoot[1].count(n)) ++overlap;
        std::cout << "overlap between the two roots' subtrees: " << overlap << " nodes\n";
        std::cout << "sanity: |A|+|B|-|overlap| = " << (perRoot[0].size() + perRoot[1].size() - overlap)
                  << " (should equal combined count above)\n";
    }

    // Cross-check against the saved file.
    const SpecDB db = loadSpecGraphFromFile(specPath);
    std::cout << "\n.spec file node count: " << db.size() << "\n";
    std::cout << (db.size() == combined.size() ? "MATCH" : "MISMATCH")
              << " vs live-graph combined reachable count\n";

    std::set<std::string> uniqueEncs;
    for (const auto& n : db.nodes()) uniqueEncs.insert(n.enc);
    std::cout << "unique encodings in file: " << uniqueEncs.size() << " (out of " << db.size() << " rows) "
              << (uniqueEncs.size() == db.size() ? "OK, no duplicates" : "DUPLICATES FOUND") << "\n";

    // Spot-check a handful of live-graph nodes against the loaded DB.
    std::size_t checked = 0, mismatches = 0;
    for (const Node& n : g.nodes()) {
        if (n.isSum() || n.placeholder) continue;
        if (checked >= 2000) break;  // sample, not exhaustive -- full graph is huge
        SpecValue v;
        if (!db.value(parsePosition(n.enc), v)) {
            std::cout << "MISSING from file: " << n.enc << "\n";
            ++mismatches;
        } else if (v.nimber != n.nimber || v.minMoves != n.minMoves || v.maxMoves != n.maxMoves) {
            std::cout << "VALUE MISMATCH " << n.enc << ": live nimber=" << n.nimber << " file nimber="
                      << v.nimber << "\n";
            ++mismatches;
        }
        ++checked;
    }
    std::cout << "spot-checked " << checked << " live nodes against file: " << mismatches << " mismatches\n";
    return 0;
}
