// Offline discovery tool: of every single-subposition (minimal), single-alpha left side reachable
// from the given .spec file(s) whose (R,D,{L},{T'}) core matches ANY currently-named family exactly
// (via familyNameForCoreKey) and whose left-side lives (leftSideLives2()/2) is <= 6, and which is NOT
// already registered under any Advanced Collection (same repCanon check as
// unregistered_left_sides.cpp) -- report which ones "go yellow" per isYellowCandidate (see
// alpha_genome.hpp), i.e. are genuine new members of THEIR OWN matching family by the same rule
// collect.ts's renderRequiredLine uses. Originally scoped to S_1/S_1⊕1 only (see
// SESSION_NOTES_2026-08-30.md Part 2); generalized to every named family 2026-08-30 (later session)
// after the user noticed the Collect pane still showing many uncaptured left sides outside those two
// families -- isYellowCandidate/familyNameForCoreKey were already fully general, only this driver's
// two-family hardcoding needed to change.
//
// Shares its isSingleAlpha/distinctPortLetters/buildRepCanonSet machinery with
// unregistered_left_sides.cpp -- factored into alpha_genome.hpp/.cpp (2026-08-31) after both tools'
// copies were found byte-identical; see that header's own doc comments for the reasoning behind
// quick-canon identity and the rep-set membership check. Each tool's own scan/filter/output shape
// still differs enough that only these three predicates were worth sharing, not the whole loop.
//
// Usage: find_yellow_candidates <out.tsv> <spec1.spec> [spec2.spec ...]
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: find_yellow_candidates <out.tsv> <spec1.spec> [spec2.spec ...]\n";
        return 1;
    }
    const std::string outPath = argv[1];
    const std::set<std::string> repCanon = stalks_tools::buildRepCanonSet();
    std::cerr << "rep set: " << repCanon.size() << " distinct canonical forms\n";

    std::set<std::string> seenQuickEnc;
    struct Row {
        int lives;
        std::string quickEnc;
        std::string family;
        std::string genome;
    };
    std::vector<Row> yellowRows;
    long long candidatesChecked = 0;

    for (int i = 2; i < argc; ++i) {
        const std::string path = argv[i];
        SpecDB db;
        try {
            db = loadSpecGraphFromFile(path);
        } catch (const std::exception& e) {
            std::cerr << "skipping " << path << ": " << e.what() << "\n";
            continue;
        }
        std::cerr << path << ": " << db.size() << " nodes\n";

        std::size_t scanned = 0, qualifying = 0;
        for (const SpecNode& node : db.nodes()) {
            ++scanned;
            if (scanned % 500000 == 0) { std::cerr << "  ..." << scanned << "/" << db.size() << "\n"; std::cerr.flush(); }
            if (!isSingleAlpha(node.enc)) continue;

            Position pBase;
            try {
                pBase = canonicalize(parsePosition(node.enc));
            } catch (const EncodingError&) {
                continue;
            }
            if (!hasSpecialPoint(pBase)) continue;

            const QuickCanonResult qc = quickCanon(pBase);
            const std::string quickEnc = serialize(qc.rep);
            if (!seenQuickEnc.insert(quickEnc).second) continue;
            ++qualifying;

            const int lives = qc.rep.leftSideLives2() / 2;
            if (lives < 1 || lives > 6) continue;

            if (repCanon.count(quickEnc) > 0) continue;  // already registered somewhere

            const auto genome = classifyAlphaGenome(pBase, db);
            if (!genome) continue;
            const std::string core = genomeKey(*genome);

            const auto familyName = familyNameForCoreKey(core);
            if (!familyName) continue;
            const std::string family = *familyName;

            ++candidatesChecked;
            if (candidatesChecked % 100 == 0) { std::cerr << "  checked " << candidatesChecked << " candidates...\n"; std::cerr.flush(); }

            if (isYellowCandidate(pBase, db, family)) {
                yellowRows.push_back({lives, quickEnc, family, fullGenomeText(pBase, db)});
            }
        }
        std::cerr << "  scanned " << scanned << ", qualifying single-alpha " << qualifying << "\n";
    }

    std::cerr << "checked " << candidatesChecked << " named-family-core candidates, "
              << yellowRows.size() << " went yellow\n";

    std::sort(yellowRows.begin(), yellowRows.end(), [](const Row& a, const Row& b) {
        if (a.lives != b.lives) return a.lives < b.lives;
        if (a.family != b.family) return a.family < b.family;
        return a.quickEnc < b.quickEnc;
    });

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << "lives\tfamily\tquickEnc\tgenome\n";
    for (const Row& r : yellowRows)
        f << r.lives << "\t" << r.family << "\t" << r.quickEnc << "\t" << r.genome << "\n";
    std::cerr << "wrote " << yellowRows.size() << " yellow candidates to " << outPath << "\n";

    return 0;
}
