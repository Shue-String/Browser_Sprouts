// Throwaway debug tool: for each hardcoded element, exclude its OWN literal registry entry
// (collections.hpp's setExcludedRegistryKey -- the same leave-one-out mechanism
// audit_registry_necessity.cpp uses) and check whether it's still recognized as S_1⊕1 -- both
// structurally (does quickCanon still reduce it to the bare rep at all, via some OTHER rule) and
// via a fresh yellow-line scan (isYellowCandidate, the discovery-side heuristic a NEW candidate
// would be judged by). Investigates whether three specific S_1⊕1 registry elements were only ever
// self-matching (i.e. would never have been discovered/validated by the CURRENT logic on their
// own), suggesting they were inserted by an older, buggy verification pass.
//
// Not meant to be kept -- delete once the investigation is done.
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

namespace {

void check(const std::string& element) {
    std::cout << "=== " << element << " ===\n";

    const std::string ownKey = "[" + element + "/";
    setExcludedRegistryKey(ownKey);

    Position p;
    try {
        p = canonicalize(parsePosition("[" + element + "]"));
    } catch (const std::exception& e) {
        std::cout << "  parse error: " << e.what() << "\n";
        setExcludedRegistryKey("");
        return;
    }

    const QuickCanonResult qc = quickCanon(p);
    std::cout << "  quickCanon WITH OWN ENTRY EXCLUDED: " << serialize(qc.rep) << " offset=" << qc.offset << "\n";

    GameGraph g;
    Node* rootNode = g.ensure(p);
    std::vector<const Node*> roots = {rootNode};
    std::stringstream ss;
    saveSpecGraph(g, roots, ss);
    const SpecDB db = loadSpecGraph(ss);

    const auto name = resolvedGenomeName(p, db);
    std::cout << "  resolvedGenomeName (own entry excluded): " << (name ? *name : "(none)") << "\n";
    for (const Position& t : tChildrenOf(p)) {
        std::cout << "    T-child: " << serialize(t) << "  fullGenomeText=" << fullGenomeText(t, db) << "\n";
    }

    try {
        const bool yellow = isYellowCandidate(p, db, "S_1\xE2\x8A\x95""1");
        std::cout << "  isYellowCandidate vs S_1\xE2\x8A\x95""1 (own entry excluded): " << (yellow ? "YES" : "no") << "\n";
    } catch (const std::exception& e) {
        std::cout << "  isYellowCandidate error: " << e.what() << "\n";
    }

    setExcludedRegistryKey("");
    std::cout << "\n";
}

}  // namespace

int main() {
    warmRegistryNameIndex();  // MUST happen before any setExcludedRegistryKey call -- see its own doc comment.
    check("AB|2a,4A|1,2,B");
    check("1AB|a,CDEF|AB,CDEF");
    check("4A|2,BCDE|Aa,BCDE");
    return 0;
}
