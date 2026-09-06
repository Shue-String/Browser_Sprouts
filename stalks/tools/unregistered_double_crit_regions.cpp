// Offline discovery tool: over every quick-canon-distinct, single-component position reachable at
// <n> spots (same "Quick build" set as region_frequency.cpp/quick_reduction_counts.cpp), enumerate
// every double-crit CANDIDATE region (collections.cpp's enumerateDoubleCrits -- a region with
// exactly two membrane occurrences, both paired outward with distinct pairings, purely structural,
// no synthetic alpha/beta token involved at this stage) and report which candidate leftSideKeys are
// NOT already in doubleCritRegistry() (currently just Z_1/Z_2). This is the double-crit analogue of
// unregistered_left_sides.cpp, but working from raw candidate region keys straight out of the real
// structural game tree rather than from a pre-built single-alpha .spec corpus -- no such corpus
// exists for two crits, and building one isn't needed just to ANSWER "do more double-crit shapes
// exist": enumerateDoubleCrits already finds every candidate directly.
//
// Usage: unregistered_double_crit_regions <n> [out.csv]
// Default output path: "<n>_spot_unregistered_double_crit.csv" in the current directory.
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

using namespace stalks;

namespace {
std::string csvQuote(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
        if (c == '"') out += "\"\"";
        else out += c;
    }
    out += "\"";
    return out;
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: unregistered_double_crit_regions <n> [out.csv]\n";
        return 1;
    }
    const int n = std::atoi(argv[1]);
    const std::string outPath =
        argc >= 3 ? argv[2] : (std::to_string(n) + "_spot_unregistered_double_crit.csv");

    const std::set<std::string> registered = registeredDoubleCritKeys();
    std::cerr << "registered double-crit keys: " << registered.size() << "\n";

    const auto positions = reachablePositions(n);
    std::set<std::string> qset;
    std::map<std::string, long long> unregisteredCounts;
    std::map<std::string, long long> registeredCounts;
    long long totalPositions = 0, totalCandidates = 0;

    for (const auto& enc : positions) {
        const Position rep = quickCanon(parsePosition(enc)).rep;
        const std::string key = serialize(rep);
        if (!qset.insert(key).second) continue;
        if (rep.components.size() != 1) continue;
        ++totalPositions;

        for (const std::string& leftKey : detachableDoubleCritLeftSideKeys(rep)) {
            ++totalCandidates;
            if (registered.count(leftKey)) {
                ++registeredCounts[leftKey];
            } else {
                ++unregisteredCounts[leftKey];
            }
        }
    }

    std::vector<std::pair<std::string, long long>> rows(unregisteredCounts.begin(), unregisteredCounts.end());
    std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
        if (a.second != b.second) return a.second > b.second;
        return a.first < b.first;
    });

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << "leftSideKey,count\n";
    for (const auto& [key, count] : rows) f << csvQuote(key) << "," << count << "\n";

    long long registeredHits = 0;
    for (const auto& [k, c] : registeredCounts) registeredHits += c;

    std::cerr << n << "-spot quick-canon tree: " << totalPositions << " distinct single-component positions, "
              << totalCandidates << " double-crit candidate occurrences (" << registeredHits
              << " already-registered hits, " << rows.size() << " distinct UNREGISTERED shapes) -> "
              << outPath << "\n";
    return 0;
}
