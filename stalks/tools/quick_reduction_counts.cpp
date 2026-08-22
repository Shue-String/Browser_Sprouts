// Offline tool: run quickCanon over every structural position reachable from the n-spot start
// and report how many times each Advanced-Collection member (and the crit-cell/scab-cell
// boundary-merge trick) actually fired as the applied reduction -- "how much mileage are we
// getting out of each Shue Collection member." See collections.hpp's quickReductionCounts for
// what's counted and how the key text is built.
//
// Usage: quick_reduction_counts <n> [out.csv]
// Default output path: "<n>_spot_quick_reductions.csv" in the current directory.

#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"

#include <algorithm>
#include <cstdlib>
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

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: quick_reduction_counts <n> [out.csv]\n";
        return 1;
    }
    const int n = std::atoi(argv[1]);
    const std::string outPath = argc >= 3 ? argv[2] : (std::to_string(n) + "_spot_quick_reductions.csv");

    resetQuickReductionCounts();
    const auto positions = reachablePositions(n);
    // Also tally the collapsed quick-canon rep set alongside the mileage counters -- same
    // methodology as testQuickNimber's count-reduction check (test_main.cpp), so this number is
    // directly comparable to that check's reported "-> quick N (1-sub M)" line and to the
    // historical structural/quick count series recorded for prior n=6 runs.
    std::set<std::string> qset;
    long long quickSingle = 0;
    for (const auto& enc : positions) {
        const Position rep = quickCanon(parsePosition(enc)).rep;
        if (qset.insert(serialize(rep)).second && rep.components.size() == 1)
            ++quickSingle;
    }

    // Sort by count descending, then key ascending, for a readable report.
    std::vector<std::pair<std::string, long long>> rows(quickReductionCounts().begin(),
                                                          quickReductionCounts().end());
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

    std::cerr << n << "-spot: structural " << positions.size() << " -> quick " << qset.size()
              << " (1-sub " << quickSingle << "); " << rows.size()
              << " distinct reduction values -> " << outPath << "\n";
    return 0;
}
