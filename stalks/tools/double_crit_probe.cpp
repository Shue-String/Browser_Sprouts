// Diagnostic tool for the paper's new "Double-crit Genomes" section: for a position with exactly
// two special-point crits, dumps every child's RAW (movetype_tok1, movetype_tok2) classification
// pair -- per moves.hpp's specialPointMovetypes, which returns one movetype (1=R,2=D,3=L,4=T',
// 5=T/untouched) for EVERY special-point token present in the parent, on EVERY move.
//
// This exists to get real engine numbers before committing to the exact bucketing rule for the
// double-crit genome tuple g(p) = (RR,DD,{LL},{T'T'}, RaDb,RbDa,{LaT'b},{LbT'a},
// g(Ra),g(Rb),g(Da),g(Db), {g(La)},{g(Lb)},{g(T'a)},{g(T'b)}, [T(p)]) -- rather than hand-deriving
// which of the 25 possible (mt1,mt2) combinations map to which of the formula's 16 slots. The
// mapping below is this tool's own best-guess label for each combination the formula names
// explicitly; anything else prints as UNMAPPED so a real occurrence is visible, not silently
// absorbed into a guess.
//
// Usage: double_crit_probe <candidate1> [<candidate2> ...]
// Candidate text is roster-style left-side text (same convention as yellow_check.cpp): e.g.
// "aC|12C32b", optionally still wrapped in "[...]" or "[.../ " -- brackets/slash are stripped.
// Must contain exactly two distinct special-point letters ('a'-'j').
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "double_crit_genome.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

namespace {

char movetypeChar(int mt) {
    switch (mt) {
        case 1: return 'R';
        case 2: return 'D';
        case 3: return 'L';
        case 4: return 'P';  // T' ("prime")
        case 5: return 'T';
        default: return '?';
    }
}

// This tool's own label for each (mt1, mt2) pair the paper's formula names explicitly. mt1 is
// always tok1's movetype, mt2 always tok2's -- so e.g. (1,2) is "R{tok1}D{tok2}", not a symmetric
// "RD" bucket; the caller substitutes the real crit letters into the '?' placeholders below.
std::string bucketLabel(int mt1, int mt2, char c1, char c2) {
    auto pair = [&](int a, int b) { return mt1 == a && mt2 == b; };
    if (pair(1, 1)) return "RR (direct nimber)";
    if (pair(2, 2)) return "DD (direct nimber)";
    if (pair(3, 3)) return "LL (direct nimber, set)";
    if (pair(4, 4)) return "T'T' (direct nimber, set)";
    if (pair(1, 2)) return std::string("R") + c1 + "D" + c2 + " (direct nimber)";
    if (pair(2, 1)) return std::string("R") + c2 + "D" + c1 + " (direct nimber)";
    if (pair(3, 4)) return std::string("L") + c1 + "T'" + c2 + " (direct nimber, set)";
    if (pair(4, 3)) return std::string("L") + c2 + "T'" + c1 + " (direct nimber, set)";
    if (pair(1, 5)) return std::string("R") + c1 + "(p)  [recurse g(), " + c2 + " remains single-crit]";
    if (pair(5, 1)) return std::string("R") + c2 + "(p)  [recurse g(), " + c1 + " remains single-crit]";
    if (pair(2, 5)) return std::string("D") + c1 + "(p)  [recurse g(), " + c2 + " remains single-crit]";
    if (pair(5, 2)) return std::string("D") + c2 + "(p)  [recurse g(), " + c1 + " remains single-crit]";
    if (pair(3, 5)) return std::string("L") + c1 + "(p) set [recurse g(), " + c2 + " remains single-crit]";
    if (pair(5, 3)) return std::string("L") + c2 + "(p) set [recurse g(), " + c1 + " remains single-crit]";
    if (pair(4, 5)) return std::string("T'") + c1 + "(p) set [recurse g(), " + c2 + " remains single-crit]";
    if (pair(5, 4)) return std::string("T'") + c2 + "(p) set [recurse g(), " + c1 + " remains single-crit]";
    if (pair(5, 5)) return "T(p) member [recurse full g(), both crits remain]";
    return "UNMAPPED -- not named in the formula as given";
}

std::set<Token> distinctSpecialTokens(const std::string& s) {
    std::set<Token> out;
    for (char ch : s)
        if (ch >= 'a' && ch <= 'j') out.insert(charToken(ch));
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: double_crit_probe <candidate1> [<candidate2> ...]\n";
        return 1;
    }

    for (int i = 1; i < argc; ++i) {
        const std::string raw = toEmbeddable(argv[i]);
        std::cout << "=== " << argv[i] << " ===\n";
        try {
            const std::set<Token> toks = distinctSpecialTokens(raw);
            if (toks.size() != 2) {
                std::cout << "  ERROR: expected exactly 2 distinct crit letters, found "
                          << toks.size() << "\n";
                continue;
            }
            const Token tok1 = *toks.begin();
            const Token tok2 = *std::next(toks.begin());
            const char c1 = tokenChar(tok1);
            const char c2 = tokenChar(tok2);

            Position root = canonicalize(parsePosition("[" + raw + "]"));

            GameGraph g;
            Node* rootNode = g.ensure(root);
            std::vector<const Node*> roots = {rootNode};
            std::stringstream ss;
            saveSpecGraph(g, roots, ss);
            const SpecDB db = loadSpecGraph(ss);

            std::map<std::pair<int, int>, int> tally;

            for (const DoubleCritChild& dc : classifyDoubleCritChildren(root, db, tok1, tok2)) {
                std::cout << "  " << serialize(dc.child) << "  " << c1 << "=" << movetypeChar(dc.mt1)
                          << "(" << dc.mt1 << ") " << c2 << "=" << movetypeChar(dc.mt2) << "(" << dc.mt2
                          << ")  nimber=" << (dc.hasValue ? std::to_string(dc.value.nimber) : std::string("?"))
                          << "  -> " << bucketLabel(dc.mt1, dc.mt2, c1, c2) << "\n";

                tally[{dc.mt1, dc.mt2}]++;
            }

            std::cout << "  --- tally by (mt_" << c1 << ", mt_" << c2 << ") ---\n";
            for (const auto& [key, count] : tally) {
                std::cout << "  (" << key.first << "," << key.second << ") x" << count << "  "
                          << bucketLabel(key.first, key.second, c1, c2) << "\n";
            }

            std::cout << "  --- genome ---\n  " << doubleCritGenomeText(root, db, tok1, tok2) << "\n";
        } catch (const std::exception& e) {
            std::cout << "  ERROR: " << e.what() << "\n";
        }
    }
    return 0;
}
