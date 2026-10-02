// Offline tool: run quickCanon over every structural position reachable from the n-spot start
// and report how many times each Collection member (and the crit-cell/scab-cell
// boundary-merge trick) actually fired as the applied reduction -- "how much mileage are we
// getting out of each Shue Collection member." See collections.hpp's quickReductionCounts for
// what's counted and how the key text is built. Every registered collection element is reported
// even if it never fired (count 0) -- seeded from allCollectionRosters(), see below.
//
// Usage: quick_reduction_counts <n> [out.csv] [--master out.sprout]
// Default output path: "<n>_spot_quick_reductions.csv" in the current directory.
//
// --master: instead of the plain BFS + quickCanon pass (impractical at n>=7: no memoization), build
// the Quick-mode GameGraph rooted at the n-spot start (memoized, same graph the master saves use),
// save its minimal-node subgraph to out.sprout, reload + verify, and tally the counters over every
// quickCanon() call the build makes. The "1-sub" figure is then the saved node count (one per
// distinct single-component quick-canon position); the counts are per-call, so they are not
// directly comparable to the BFS mode's one-call-per-structural-position tallies.

#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "savefile.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <exception>
#include <fstream>
#include <iostream>
#include <set>
#include <string>
#include <vector>

using namespace stalks;

namespace {

// The key alphabet (digits, 'a'-'z' ports, ',', brackets, '|', 'M' for multi-region) never
// contains a double quote, but commas are common -- always quote the field for safety.
std::string csvQuote(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
        if (c == '"')
            out += "\"\"";
        else
            out += c;
    }
    out += "\"";
    return out;
}

}  // namespace

static int run(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: quick_reduction_counts <n> [out.csv]\n";
        return 1;
    }
    const int n = std::atoi(argv[1]);
    const std::string outPath = argc >= 3 ? argv[2] : (std::to_string(n) + "_spot_quick_reductions.csv");

    std::string masterPath;
    for (int i = 3; i + 1 < argc; ++i)
        if (std::string(argv[i]) == "--master")
            masterPath = argv[i + 1];

    resetQuickReductionCounts();
    std::string summary;
    if (masterPath.empty()) {
        const auto positions = reachablePositions(n);
        // Also tally the collapsed quick-canon rep set alongside the mileage counters -- same
        // methodology as testQuickNimber's count-reduction check (test_main.cpp), so this number
        // is directly comparable to that check's reported "-> quick N (1-sub M)" line and to the
        // historical structural/quick count series recorded for prior n=6 runs.
        std::set<std::string> qset;
        long long quickSingle = 0;
        for (const auto& enc : positions) {
            const Position rep = quickCanon(parsePosition(enc)).rep;
            if (qset.insert(serialize(rep)).second && rep.components.size() == 1)
                ++quickSingle;
        }
        summary = "structural " + std::to_string(positions.size()) + " -> quick " +
                  std::to_string(qset.size()) + " (1-sub " + std::to_string(quickSingle) + ")";
    } else {
        const auto t0 = std::chrono::steady_clock::now();
        GameGraph g(GameGraph::Mode::Quick);
        const Position start = parsePosition(startEncoding(n));
        int off = 0;
        for (int k = 2; k < n; ++k)  // same incremental build order as the master-save harness
            g.ensure(parsePosition(startEncoding(k)));
        Node* root = g.ensure(start, &off);
        const int trueVal = root->nimber ^ off;
        const std::size_t cnt = saveSubgraphToFile(g, root, masterPath);
        const SolvedDB db = loadGraphFromFile(masterPath);
        SolvedDB::Value v;
        int loadOff = 0;
        const bool ok = db.value(start, v, &loadOff);
        const bool good = ok && (v.nimber ^ loadOff) == trueVal && db.size() == cnt;
        summary = "quick graph " + std::to_string(g.size()) + " nodes, 1-sub " + std::to_string(cnt) +
                  " saved to " + masterPath + (good ? " [verified G" + std::to_string(trueVal) + "]" : " [VERIFY FAIL]") +
                  ", " + std::to_string(std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count()) + "s";
    }

    // Seed every registered collection element's key at 0 before folding in the observed counts,
    // so an element that never fired still shows up (previously the map only ever held keys that
    // had fired at least once -- silently indistinguishable from "not a registered element at
    // all"). Only registry-based elements (single-crit/double-crit/multi-region -- the ones with
    // an authored `display` text) are enumerable this way; the crit-cell/scab-cell/special-cell
    // congruity tricks have no fixed roster (their key is a freshly-computed region text), so they
    // aren't seeded and simply won't appear unless they actually fire, same as before.
    std::map<std::string, long long> withZeros = quickReductionCounts();
    for (const auto& roster : allCollectionRosters())
        for (const auto& element : roster.elements)
            withZeros.emplace("[" + element + "/", 0);

    // Sort by count descending, then key ascending, for a readable report.
    std::vector<std::pair<std::string, long long>> rows(withZeros.begin(), withZeros.end());
    std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
        if (a.second != b.second)
            return a.second > b.second;
        return a.first < b.first;
    });

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << "value,count\n";
    for (const auto& [key, count] : rows)
        f << csvQuote(key) << "," << count << "\n";

    std::cerr << n << "-spot: " << summary << "; " << rows.size()
              << " distinct reduction values -> " << outPath << '\n';
    return 0;
}

int main(int argc, char** argv) {
    try {
        return run(argc, argv);
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << '\n';
        return 1;
    }
}
