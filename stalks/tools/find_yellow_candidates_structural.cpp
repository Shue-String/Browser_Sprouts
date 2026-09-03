// Offline discovery tool: over every quick-canon-distinct, single-component STRUCTURAL position
// reachable at <n> spots (same "Quick build" set as quick_reduction_counts.cpp/
// unregistered_double_crit_regions.cpp), enumerate every single-crit candidate region
// (collections.hpp's detachableLeftSideKeys, single-region k=1) AND multi-region candidate chunk
// (detachableMultiCritLeftSideKeys) directly from the real structural game tree, then classify each
// UNREGISTERED candidate's genome and report which ones "go yellow" for their own matching family,
// exactly like find_yellow_candidates.cpp -- but working from candidate region keys straight out of
// quickCanon's own crit-finder, not from a pre-built single-alpha .spec corpus.
//
// Why this exists (see [[project_advanced_collections]] for the full story): every prior discovery
// scan ran against stalks/saves/alpha_beta_pair_vs_split*.spec, which is seeded from an alpha-BETA
// PAIR at n<=4 REAL spots (built for the double-crit work, reused here since single-alpha
// descendants fall out of it naturally as beta resolves) -- since moves only ever shrink a position,
// nothing in that corpus can ever exceed ~4 real spots, no matter how high a "lives<=6" cap is set.
// Building an actual n=6-real-spot alpha-seeded .spec file to fix this turned out to be wildly
// inefficient (the exact GameGraph for a 6-real-spot+alpha root grows combinatorially -- the n=4->n=5
// pilot alone went from 9.5s/12,303 nodes to 4m39s/171,745 nodes, and n=6 was still running after two
// hours with no end in sight before being killed). This tool sidesteps that entirely: candidate LEFT
// SIDES are enumerated directly from quickCanon's own crit-finder (detachableLeftSideKeys/
// detachableMultiCritLeftSideKeys), which already finds every candidate region in a structural
// position without needing alpha embedded in a real played-out game at all -- exactly the same
// insight unregistered_double_crit_regions.cpp/double_crit_candidates_report.cpp already exploit for
// the double-crit case ("no such corpus exists for two crits, and building one isn't needed just to
// answer 'do more shapes exist': enumerateDoubleCrits already finds every candidate directly").
// Genome is computed on the BARE candidate alone (no host attached, mirroring yellow_check.exe's own
// method) -- relies on genome being host-invariant, which is the whole theoretical premise of "left
// side" classification in the first place, and is exactly how double_crit_candidates_report.cpp
// already validated cleanly against Z_1/Z_2. Each candidate gets its own small on-demand GameGraph
// (solved via ensure(), not a giant pre-solved corpus) -- cheap, since a bare left-side chunk's own
// reachable subtree is small regardless of how large an n the structural scan explored to FIND it.
//
// Usage: find_yellow_candidates_structural <n> <out.tsv>
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

namespace {

// enumerateMultiCrits' own leftKey (collections.cpp) is an internal REGISTRY LOOKUP key, not
// directly parseable position text: it's prefixed 'M' (belt-and-suspenders collision avoidance vs.
// single-/double-crit keys, see multiChunkKey's own doc comment) and renders its one crit occurrence
// as the agnostic membrane sentinel '9' (extractChunk excludes the crossing bridge from newPairings
// so it serializes that way -- see that function's own doc comment), never as a real port letter,
// since at enumeration time from a bare structural position there's no special point yet to give it
// an identity. detachableLeftSideKeys' single-/double-region keys need no such conversion (their
// crit already renders as a literal port letter -- see leftSideKey's own doc comment). Converts 'M'-
// prefixed text back to embeddable single-alpha left-side text; passes anything else through as-is.
std::string toParseableLeftSide(const std::string& leftKey) {
    if (leftKey.empty() || leftKey[0] != 'M') return leftKey;
    std::string out = leftKey.substr(1);
    const auto agnostic = out.find('9');
    if (agnostic != std::string::npos) out[agnostic] = 'a';
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: find_yellow_candidates_structural <n> <out.tsv>\n";
        return 1;
    }
    const int n = std::atoi(argv[1]);
    const std::string outPath = argv[2];

    const std::set<std::string> repCanon = buildRepCanonSet();
    std::cerr << "rep set: " << repCanon.size() << " distinct canonical forms\n";

    const auto positions = reachablePositions(n);
    std::cerr << n << "-spot: " << positions.size() << " reachable structural encodings\n";

    std::set<std::string> candidateKeys;
    long long totalReps = 0;

    for (const auto& enc : positions) {
        // Deliberately NOT quickCanon here (unlike unregistered_double_crit_regions.cpp, which gets
        // away with it because the double-crit registry is nearly empty) -- quickCanon's own fixpoint
        // actively swaps away every region matching any of the ~670 already-registered single-crit
        // elements before detachableLeftSideKeys ever sees it, which starves this scan down to almost
        // nothing (measured: n=4 found only 49 candidate shapes this way, vs hundreds previously found
        // by scanning real game positions). reachablePositions already returns raw STRUCTURAL
        // canonical encodings (see graph.cpp -- canonicalize() only, no quick-canon collapsing), which
        // is exactly what find_yellow_candidates.cpp's own pBase (real positions, structural-only) is
        // -- so working from that raw form here matches the population that tool already scans, just
        // sourced directly from the structural game tree instead of a real single-alpha .spec corpus.
        const Position p = parsePosition(enc);
        if (p.components.size() != 1) continue;
        ++totalReps;

        for (const std::string& lk : detachableLeftSideKeys(p)) candidateKeys.insert(lk);
        for (const std::string& lk : detachableMultiCritLeftSideKeys(p)) candidateKeys.insert(lk);
    }
    std::cerr << totalReps << " distinct single-component structural positions, " << candidateKeys.size()
              << " distinct candidate left-side shapes\n";

    struct Row {
        int lives;
        std::string quickEnc;
        std::string family;
        std::string genome;
    };
    std::vector<Row> yellowRows;
    long long checked = 0, skippedRegistered = 0, skippedNoCore = 0, errors = 0, done = 0;

    for (const std::string& leftKey : candidateKeys) {
        ++done;
        if (done % 2000 == 0) {
            std::cerr << "  ..." << done << "/" << candidateKeys.size() << " (" << yellowRows.size()
                       << " yellow so far)\n";
            std::cerr.flush();
        }
        try {
            Position pBase = canonicalize(parsePosition("[" + toParseableLeftSide(leftKey) + "]"));
            if (!hasSpecialPoint(pBase)) continue;

            const QuickCanonResult qc = quickCanon(pBase);
            const std::string quickEnc = serialize(qc.rep);

            const int lives = qc.rep.leftSideLives2() / 2;
            if (lives < 1 || lives > 6) continue;

            if (repCanon.count(quickEnc) > 0) {
                ++skippedRegistered;
                continue;
            }

            GameGraph g;
            Node* rootNode = g.ensure(pBase);
            std::vector<const Node*> roots = {rootNode};
            std::stringstream ss;
            saveSpecGraph(g, roots, ss);
            const SpecDB db = loadSpecGraph(ss);

            const auto genome = classifyAlphaGenome(pBase, db);
            if (!genome) {
                ++skippedNoCore;
                continue;
            }
            const std::string core = genomeKey(*genome);
            const auto familyName = familyNameForCoreKey(core);
            if (!familyName) continue;

            ++checked;
            if (isYellowCandidate(pBase, db, *familyName)) {
                yellowRows.push_back({lives, quickEnc, *familyName, fullGenomeText(pBase, db)});
            } else if (const char* v = std::getenv("STALKS_DEBUG_NOTYELLOW"); v && v[0] == '1') {
                std::cerr << "  not-yellow: " << quickEnc << " vs " << *familyName
                          << "  genome=" << fullGenomeText(pBase, db) << "\n";
            }
        } catch (const std::exception& e) {
            ++errors;
            if (const char* v = std::getenv("STALKS_DEBUG_ERRORS"); v && v[0] == '1')
                std::cerr << "  ERROR on '" << leftKey << "': " << e.what() << "\n";
        }
    }

    std::cerr << "checked " << checked << " named-family-core candidates (" << skippedRegistered
              << " already registered, " << skippedNoCore << " unclassifiable, " << errors
              << " errors), " << yellowRows.size() << " went yellow\n";

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
