// Throwaway debug tool: for ONE hardcoded root position, print its T-children and, for each
// T-child, its own T-children (grandchildren) with their fullGenomeText -- to see directly whether
// a specific expected bypass grandchild is (a) genuinely absent from tChildrenOf's enumeration, or
// (b) present but not folding to the expected name. Built to investigate a real disagreement found
// 2026-09-21: isYellowCandidate says "1Aa|2AB|6,B" (which resolves to S_1⊕1) is NOT clean for
// S_1⊕1, but a manual trace found real S_1⊕1 grandchildren under its two "extra" T-children that
// the automated bypass search isn't finding.
//
// Not meant to be kept -- delete once the investigation is done.
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <iostream>
#include <sstream>
#include <string>

using namespace stalks;
using namespace stalks_tools;

int main() {
    const std::string target = "S_1\xE2\x8A\x95""1";  // UTF-8 for "S_1⊕1", embedded directly to
                                                         // dodge the argv codepage-mangling issue.

    Position root = canonicalize(parsePosition("[1Aa|2AB|6,B]"));
    GameGraph g;
    Node* rootNode = g.ensure(root);
    std::vector<const Node*> roots = {rootNode};
    std::stringstream ss;
    saveSpecGraph(g, roots, ss);
    const SpecDB db = loadSpecGraph(ss);

    std::cout << "root: " << serialize(root) << "\n";
    std::cout << "root resolvedGenomeName: "
              << (resolvedGenomeName(root, db) ? *resolvedGenomeName(root, db) : "(none)") << "\n\n";

    int idx = 0;
    for (const Position& t : tChildrenOf(root)) {
        ++idx;
        const auto tName = resolvedGenomeName(t, db);
        std::cout << "T-child " << idx << ": " << serialize(t)
                  << "  resolvedGenomeName=" << (tName ? *tName : "(none)") << "\n";

        int gidx = 0;
        bool found = false;
        for (const Position& gc : tChildrenOf(t)) {
            ++gidx;
            const std::string gcFull = fullGenomeText(gc, db);
            const bool match = (gcFull == target);
            if (match) found = true;
            std::cout << "    grandchild " << gidx << ": " << serialize(gc) << "  fullGenomeText="
                      << gcFull << (match ? "   <-- MATCHES S_1\xE2\x8A\x95""1" : "") << "\n";
        }
        std::cout << "    total grandchildren: " << gidx
                  << "  found S_1\xE2\x8A\x95"
                     "1 bypass: " << (found ? "YES" : "NO") << "\n\n";
    }
    return 0;
}
