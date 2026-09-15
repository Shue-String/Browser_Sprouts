// Ad-hoc audit tool (2026-09-14): given a target T-child encoding and a list of candidate parent
// encodings (one per line on stdin, bare left-side text -- no brackets/quotes), report which
// candidates have the target as one of their own real T-children (tChildrenOf, movetype 5) --
// i.e. which currently-registered elements are actually resting on that specific move. Built to
// trace a specific data-integrity issue: [12,27a8/ was found NOT to fold back to S_1 or any other
// named family (see the T-Tree pane's "extra" grey-arrow flag), so any registered S_1-family
// element that reaches it as a T-child was accepted on a bypass that doesn't actually hold under
// current classification logic and needs to come out of the registry. Reuses alpha_genome.hpp's
// own tChildrenOf (the exact movetype-5 enumeration isYellowCandidate itself uses) rather than
// re-deriving movetype classification here.
//
// Usage: find_child_parents <targetChildEncoding> < candidates.txt
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "position.hpp"

#include <iostream>
#include <string>

using namespace stalks;
using namespace stalks_tools;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: find_child_parents <targetChildEncoding> < candidates.txt\n";
        return 1;
    }
    const Position target = canonicalize(parsePosition(argv[1]));
    const std::string targetSer = serialize(target);

    std::string line;
    long long total = 0, hits = 0;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        ++total;
        try {
            const Position p = canonicalize(parsePosition(line));
            for (const Position& child : tChildrenOf(p)) {
                if (serialize(child) == targetSer) {
                    std::cout << line << "\n";
                    ++hits;
                    break;
                }
            }
        } catch (const std::exception& e) {
            std::cerr << "  ERROR on \"" << line << "\": " << e.what() << "\n";
        }
    }
    std::cerr << "checked " << total << " candidates, " << hits << " have " << argv[1] << " as a T-child\n";
    return 0;
}
