// Ad-hoc tool: dump every currently-REGISTERED Collection element as a
// "lives\tfamily\tquickEnc\tgenome" row -- the same TSV shape find_yellow_candidates.exe writes,
// which check_ttree_extras.exe already knows how to consume. This lets check_ttree_extras's
// whole-T-tree isYellowCandidate audit be run against ALREADY-REGISTERED elements, not just
// newly-discovered candidates -- e.g. to check whether an earlier registration batch (such as the
// original <=8-lives sweep, before check_ttree_extras existed) holds up under the current logic.
//
// `lives` is computed the same way find_yellow_candidates.cpp does it (quickCanon(p).rep's
// leftSideLives2()/2), so a maxLives filter here means the same thing an earlier sweep's own
// maxLives argument did -- apples to apples.
//
// Usage: dump_registry_for_ttree_check <out.tsv> [maxLives]
//   maxLives: omit for no cap (every registered element).
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "position.hpp"
#include "registry_audit_common.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>

using namespace stalks;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: dump_registry_for_ttree_check <out.tsv> [maxLives]\n";
        return 1;
    }
    const std::string outPath = argv[1];
    const int maxLives = argc >= 3 ? std::atoi(argv[2]) : std::numeric_limits<int>::max();

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << stalks_tools::kYellowRowTsvHeader;

    int written = 0, skipped = 0;
    for (const CollectionRoster& r : allCollectionRosters()) {
        for (const std::string& enc : r.elements) {
            try {
                const Position p = canonicalize(parsePosition("[" + enc + "]"));
                const QuickCanonResult qc = quickCanon(p);
                const int lives = qc.rep.leftSideLives2() / 2;
                if (lives > maxLives) continue;
                f << stalks_tools::yellowRowTsvLine(lives, r.name, serialize(qc.rep), "-");
                ++written;
            } catch (const std::exception& e) {
                std::cerr << "skipping " << r.name << " \"" << enc << "\": " << e.what() << "\n";
                ++skipped;
            }
        }
    }
    std::cerr << "wrote " << written << " registered elements (skipped " << skipped << ") to "
              << outPath << "\n";
    return 0;
}
