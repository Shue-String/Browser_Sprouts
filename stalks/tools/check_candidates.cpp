// Redundancy-check CLI for candidate single-crit (k=1) left-side text BEFORE it's added to the
// Advanced Collections registry -- e.g. for vetting rows pulled from the Shue-pairings paper
// extraction CSV. Unlike find_yellow_candidates.cpp/unregistered_left_sides.cpp (which already run
// every scanned candidate through quickCanon()+buildRepCanonSet() automatically), positions sourced
// from the paper/CSV go through manual review and never pass through that automated filter -- this
// tool closes that gap without duplicating the logic: same alpha_genome.hpp helper
// (buildRepCanonSet), same "already registered" rule, just driven by a human-supplied candidate list
// instead of a .spec corpus scan. This is the automated analogue of the Shue-pairings paper's own
// "^{\dagger}" convention (a position marked as a collapsed form of a simpler one already covered by
// an existing collection, not a distinct identity worth its own registry entry).
//
// Usage: check_candidates <enc1> [<enc2> ...]   (candidates as CLI args)
//    or: check_candidates -                      (reads one candidate per line from stdin; blank
//                                                  lines and lines starting with '#' are skipped)
// Each candidate may be pasted straight from the paper or the Collect pane ("[17a8/", Greek alpha,
// stray whitespace) -- alphaGreekToAscii + toEmbeddable (alpha_genome.hpp) are applied first, same
// convention yellow_check/double_crit_probe already use for pasted text.
//
// Only single-crit (k=1) candidates can be checked this way -- buildRepCanonSet() itself only
// indexes single-port family reps (a double-crit rep needs two distinct special-point tokens, which
// can't stand alone as "the" position the way a single-alpha one can); a k=2 candidate is reported
// SKIP, not silently treated as novel.
//
// Output per candidate:
//   REDUNDANT  <raw>  ->  [<quickEnc>/ offset=<0|1>  (already covered by: <family name(s)>)
//   NOVEL      <raw>  ->  [<quickEnc>/ offset=<0|1>
//   SKIP       <raw>  (reason)
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "position.hpp"
#include "tokens.hpp"

#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

namespace {

// repText -> family name(s) sharing that exact rep text. Per CollectionRoster's own doc comment,
// only one group of an offset-0/offset-1 pair carries non-empty rep text (the other shares it
// implicitly) -- so this intentionally only names the group(s) that literally own the text; a
// pair-partner sharing the same underlying rep identity isn't separately distinguished, which is an
// honest limitation of the roster data itself, not something this tool can resolve better.
std::map<std::string, std::vector<std::string>> buildFamilyNamesByRepText() {
    std::map<std::string, std::vector<std::string>> out;
    for (const CollectionRoster& r : allCollectionRosters()) {
        if (r.rep.empty()) continue;
        out[r.rep].push_back(r.name);
    }
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: check_candidates <enc1> [<enc2> ...]\n"
                     "   or: check_candidates -   (reads candidates from stdin, one per line)\n";
        return 1;
    }

    std::vector<std::string> candidates;
    if (argc == 2 && std::string(argv[1]) == "-") {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            const std::size_t start = line.find_first_not_of(" \t");
            if (start == std::string::npos || line[start] == '#') continue;
            candidates.push_back(line.substr(start));
        }
    } else {
        for (int i = 1; i < argc; ++i) candidates.push_back(argv[i]);
    }

    const std::set<std::string> repCanon = buildRepCanonSet();
    const auto namesByRep = buildFamilyNamesByRepText();

    // quickEnc -> repText, computed once per unique family rep via the EXACT same steps
    // buildRepCanonSet() uses internally (same distinctPortLetters guard, same un-canonicalized
    // parsePosition->quickCanon call -- no canonicalize() in between) so its keys line up with
    // repCanon's, and a REDUNDANT report can name which family(ies) own the match.
    std::map<std::string, std::string> quickEncToRepText;
    for (const auto& [repText, names] : namesByRep) {
        if (distinctPortLetters(repText) != 1) continue;  // matches buildRepCanonSet's own skip
        quickEncToRepText[serialize(quickCanon(parsePosition("[" + repText + "]")).rep)] = repText;
    }

    int redundant = 0, novel = 0, skipped = 0;
    for (const std::string& raw : candidates) {
        const std::string cleaned = toEmbeddable(raw);
        if (distinctPortLetters(cleaned) != 1) {
            std::cout << "SKIP       " << raw << "  (not single-crit -- this check only covers k=1 shapes)\n";
            ++skipped;
            continue;
        }
        Position p;
        try {
            p = canonicalize(parsePosition("[" + cleaned + "]"));
        } catch (const EncodingError& e) {
            std::cout << "SKIP       " << raw << "  (parse error: " << e.what() << ")\n";
            ++skipped;
            continue;
        }
        const QuickCanonResult qc = quickCanon(p);
        const std::string quickEnc = serialize(qc.rep);

        if (repCanon.count(quickEnc) > 0) {
            ++redundant;
            std::cout << "REDUNDANT  " << raw << "  ->  [" << quickEnc << "/ offset=" << qc.offset;
            const auto it = quickEncToRepText.find(quickEnc);
            if (it != quickEncToRepText.end()) {
                const auto namesIt = namesByRep.find(it->second);
                if (namesIt != namesByRep.end()) {
                    std::cout << "  (already covered by: ";
                    for (std::size_t i = 0; i < namesIt->second.size(); ++i) {
                        if (i) std::cout << "/";
                        std::cout << namesIt->second[i];
                    }
                    std::cout << ")";
                }
            }
            std::cout << "\n";
        } else {
            ++novel;
            std::cout << "NOVEL      " << raw << "  ->  [" << quickEnc << "/ offset=" << qc.offset << "\n";
        }
    }

    std::cerr << candidates.size() << " candidates: " << novel << " novel, " << redundant
              << " redundant, " << skipped << " skipped\n";
    return 0;
}
