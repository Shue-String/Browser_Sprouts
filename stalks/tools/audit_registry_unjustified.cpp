// Full leave-one-out sweep: for EVERY currently-registered single-crit element, exclude its OWN
// literal registry entry (collections.hpp's setExcludedRegistryKey -- the same mechanism
// audit_registry_necessity.cpp uses) and check whether it's still justified under the CURRENT
// (2026-09-22) logic by EITHER of two independent paths:
//   (a) resolvedGenomeName(p, db) still folds it to its OWN family's name -- via ANY mechanism
//       (structural quickCanon match to some OTHER already-registered rep, an exact namedGenomes()
//       text match, or the T-gene/same-shift/bypass heuristic) -- this subsumes
//       audit_registry_necessity.cpp's own narrower "still reduces via some other rule" test.
//   (b) failing that, does isYellowCandidate -- the T-gene/bypass/same-shift heuristic a brand-new
//       discovery candidate would be judged by -- independently validate it against its OWN
//       family's name specifically? (kept as a separate check from (a) since resolvedGenomeName can
//       pick a DIFFERENT family when several share a bare core and priority order doesn't favor
//       this element's own registered family.)
// An element failing BOTH is "unjustified" -- nothing about it, other than its own literal presence
// in the registry, currently supports its membership. Built 2026-09-22 after three such elements
// were found by hand while investigating check_ttree_extras "extra" false positives in S_1⊕1 --
// user's own diagnosis was that these were inserted by an older, buggy verification pass and never
// independently re-confirmed since. This tool checks the whole registry for the same pattern.
//
// CRITICAL ORDERING: warmRegistryNameIndex() MUST run before the FIRST setExcludedRegistryKey call
// -- alpha_genome.cpp's registryNameIndex() is a lazily-built `static` (built once, on first use);
// if its first build happened under an active exclusion, every registered element's own reduction
// during that build would ALSO run excluded, poisoning the whole index with self-referential
// entries (root-caused earlier this session debugging exactly this).
//
// Usage: audit_registry_unjustified <out.tsv>
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "registry_audit_common.hpp"
#include "specfile.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: audit_registry_unjustified <out.tsv>\n";
        return 1;
    }
    const std::string outPath = argv[1];

    warmRegistryNameIndex();  // MUST be first -- see top-of-file doc comment.

    std::ofstream out(outPath, std::ios::binary);
    if (!out) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    out << "family\telement\tresolvedName\tisYellowCandidate\tverdict\n";

    GameGraph g;  // shared across the whole run -- see check_ttree_extras.cpp's own doc comment on
                   // why a shared graph matters (overlapping subtrees solved once, not per element).

    long long total = 0, ok = 0, unjustified = 0, errors = 0;
    for (const CollectionRoster& r : allCollectionRosters()) {
        for (const std::string& elem : r.elements) {
            if (distinctPortLetters(elem) != 1) continue;  // double-crit: out of scope, same as
                                                              // registryNameIndex's own skip rule.
            ++total;
            if (total % 200 == 0) { std::cerr << "  ..." << total << "\n"; std::cerr.flush(); }

            const std::string ownKey = "[" + elem + "/";
            setExcludedRegistryKey(ownKey);

            try {
                Position p = canonicalize(parsePosition("[" + elem + "]"));

                Node* rootNode = g.ensure(p);
                std::vector<const Node*> roots = {rootNode};
                std::stringstream ss;
                saveSpecGraph(g, roots, ss);
                const SpecDB db = loadSpecGraph(ss);

                const auto resolved = resolvedGenomeName(p, db);
                const bool foldsToOwnFamily = resolved && *resolved == r.name;

                bool yellowLineJustified = false;
                if (hasNamedFamilyEntry(r.name)) {
                    try {
                        yellowLineJustified = isYellowCandidate(p, db, r.name);
                    } catch (const std::exception&) {
                        yellowLineJustified = false;
                    }
                }

                const bool justified = foldsToOwnFamily || yellowLineJustified;
                const std::string verdict = justified ? "OK" : "UNJUSTIFIED";
                if (justified) ++ok; else ++unjustified;

                out << r.name << "\t" << elem << "\t" << (resolved ? *resolved : "(none)") << "\t"
                    << (yellowLineJustified ? "yes" : "no") << "\t" << verdict << "\n";
                if (!justified) {
                    std::cout << "UNJUSTIFIED  " << r.name << "  " << elem << "\n";
                    std::cout.flush();
                }
            } catch (const std::exception& e) {
                ++errors;
                std::cerr << "ERROR  " << r.name << "  " << elem << "  (" << e.what() << ")\n";
                out << r.name << "\t" << elem << "\tERROR\tERROR\tERROR\n";
            }

            setExcludedRegistryKey("");
        }
    }

    std::cerr << "checked " << total << ": " << ok << " OK, " << unjustified << " UNJUSTIFIED, "
              << errors << " errors\n";
    return 0;
}
