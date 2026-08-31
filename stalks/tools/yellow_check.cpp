// Ad-hoc verification tool for isYellowCandidate/resolvedGenomeName (see alpha_genome.hpp) -- ports
// collect.ts's renderRequiredLine/computeRowInfos/findBypassMatches to native code (see
// SESSION_NOTES_2026-08-30.md Part 2). This tool exists to cross-check that native port against the
// real browser app's own "yellow bar" on a handful of known cases BEFORE trusting it at scale over
// thousands of candidates.
//
// Each candidate is given as roster left-side text (e.g. "17a8", "1a") -- same syntax as
// collections.cpp's own registry strings, with lowercase 'a' as the ALPHA special-point token --
// wrapped in "[...]" to form a one-region position, matching verify_left_side.cpp's own convention.
//
// Builds its own small Exact GameGraph rooted at each candidate (no pre-built .spec file needed) and
// prints: the candidate's own classified genome, its top-level T-children with each one's resolved
// name / bypass / extra verdict (mirroring the T-gene table's own per-row breakdown), and the final
// isYellowCandidate() verdict.
//
// Usage: yellow_check <searchedFamilyName> <candidate1> [<candidate2> ...]
#include "alpha_genome.hpp"
#include "canon.hpp"
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

// Browser UI display labels render the ALPHA special-point token as Greek "α" (U+03B1, UTF-8
// 0xCE 0xB1); the engine's own parser expects the ASCII 'a' -- this undoes that display step so
// text copied straight from the Collect pane's own history list can be fed back in.
std::string alphaGreekToAscii(const std::string& s) {
    std::string out;
    for (std::size_t i = 0; i < s.size(); ) {
        if (i + 1 < s.size() && static_cast<unsigned char>(s[i]) == 0xCE && static_cast<unsigned char>(s[i + 1]) == 0xB1) {
            out.push_back('a');
            i += 2;
        } else {
            out.push_back(s[i]);
            ++i;
        }
    }
    return out;
}

std::string toEmbeddable(const std::string& raw) {
    std::string out;
    for (char ch : alphaGreekToAscii(raw)) {
        if (ch == '[' || ch == ']' || ch == '/' || ch == ' ' || ch == '\t') continue;
        out.push_back(ch);
    }
    return out;
}

// A shell/console round-trip can mangle the literal "⊕" (U+2295) in a family name typed on the
// command line (Windows argv is in the system codepage, not UTF-8) -- so this tool accepts the
// search-bar-style '+' shorthand instead (e.g. "S_1+1") and expands it here, mirroring
// collectAlpha.ts's own `name.replace(/⊕/g, '+')` shorthand convention in reverse.
std::string expandPlusShorthand(const std::string& s) {
    std::string out;
    for (char ch : s) {
        if (ch == '+') out += "\xE2\x8A\x95";  // UTF-8 for U+2295 (CIRCLED PLUS)
        else out.push_back(ch);
    }
    return out;
}

}  // namespace

// The old "--verify-ac" batch mode (cross-checked isInAdvancedCollection() against the Collect
// pane's "!"/"!!" marker column) was removed along with isInAdvancedCollection/acMarker themselves
// (see alpha_genome.hpp's resolvedGenomeName doc comment) -- there is no longer a marker column in
// the browser to cross-check against.
int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: yellow_check <searchedFamilyName> <candidate1> [<candidate2> ...]\n";
        return 1;
    }
    const std::string searchedFamilyName = expandPlusShorthand(argv[1]);

    for (int i = 2; i < argc; ++i) {
        const std::string raw = toEmbeddable(argv[i]);
        std::cout << "=== " << argv[i] << " ===\n";
        try {
            Position root = canonicalize(parsePosition("[" + raw + "]"));

            GameGraph g;
            Node* rootNode = g.ensure(root);
            std::vector<const Node*> roots = {rootNode};
            std::stringstream ss;
            saveSpecGraph(g, roots, ss);
            const SpecDB db = loadSpecGraph(ss);

            const auto genome = classifyAlphaGenome(root, db);
            if (!genome) {
                std::cout << "  (could not classify genome)\n";
                continue;
            }
            std::cout << "  genome core: " << genomeKey(*genome) << "\n";
            std::cout << "  full fold:   " << fullGenomeText(root, db) << "\n";

            const auto topResolved = resolvedGenomeName(root, db);
            std::cout << "  own resolvedGenomeName: " << (topResolved ? *topResolved : "(none)") << "\n";

            const bool yellow = isYellowCandidate(root, db, searchedFamilyName);
            std::cout << "  YELLOW vs " << searchedFamilyName << ": " << (yellow ? "YES" : "no") << "\n";
        } catch (const std::exception& e) {
            std::cout << "  ERROR: " << e.what() << "\n";
        }
    }
    return 0;
}
