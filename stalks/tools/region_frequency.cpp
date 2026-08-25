// Offline tool: over every SINGLE-SUBPOSITION position in the n-spot quick-canon game tree (the
// deduped set of quickCanon() representatives reached from the full structural game tree -- same
// "Quick build" set as tools/quick_reduction_counts.cpp, restricted to its "1-sub" subset: exactly
// one component), tally how often each distinct REGION shape occurs, counting every occurrence in
// every position (a region seen twice in one position counts twice). Multi-component (sum)
// positions are skipped entirely -- their nimber is just the XOR of their subpositions' own
// values, and each subposition is itself reachable (and counted) as its own single-component
// position elsewhere in the tree, so including the sum's copy would double-count its regions.
//
// Region normalization:
//   - Membrane tokens are already stored as the raw agnostic MEMB value (9) on Component::regions
//     -- letters only get assigned during serialize()'s display pass -- so reading raw tokens via
//     tokenChar() already satisfies "replace membrane names with 9" for free.
//   - A region with multiple boundaries is rendered as its boundaries' strings joined by ',',
//     matching the encoding's own boundary-separator convention.
//   - Chirality: a region can be walked in either direction (mirrored()); the reported form is
//     whichever of {as-stored, fully-mirrored} is lexicographically smaller.
//
// Usage: region_frequency <n> [out.csv] [topN] [membraneCount]
// Default output path: "<n>_spot_region_frequency.csv" in the current directory. Default topN=100.
// membraneCount, if given and >= 0, restricts the tally to regions with exactly that many
// membrane (MEMB, token '9') occurrences -- counted on the normalized key, so it's invariant to
// the chirality-flip choice.

#include "boundary.hpp"
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
        if (c == '"')
            out += "\"\"";
        else
            out += c;
    }
    out += "\"";
    return out;
}

std::string bndToChars(const Bnd& b) {
    std::string s;
    s.reserve(b.size());
    for (Token t : b)
        s += tokenChar(t);
    return s;
}

// Join a region's boundaries (in stored order) into one comma-separated string, once as stored
// and once fully mirrored, and return the lexicographically smaller.
std::string regionKey(const std::vector<Bnd>& boundaries) {
    std::string fwd, rev;
    for (std::size_t i = 0; i < boundaries.size(); ++i) {
        if (i) {
            fwd += ',';
            rev += ',';
        }
        fwd += bndToChars(boundaries[i]);
        rev += bndToChars(mirrored(boundaries[i]));
    }
    return std::min(fwd, rev);
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: region_frequency <n> [out.csv] [topN]\n";
        return 1;
    }
    const int n = std::atoi(argv[1]);
    const std::string outPath =
        argc >= 3 ? argv[2] : (std::to_string(n) + "_spot_region_frequency.csv");
    const int topN = argc >= 4 ? std::atoi(argv[3]) : 100;
    const int membraneCount = argc >= 5 ? std::atoi(argv[4]) : -1;

    const auto positions = reachablePositions(n);
    std::set<std::string> qset;
    std::map<std::string, long long> regionCounts;
    long long totalPositions = 0;
    long long totalRegionOccurrences = 0;

    for (const auto& enc : positions) {
        const Position rep = quickCanon(parsePosition(enc)).rep;
        const std::string key = serialize(rep);
        if (!qset.insert(key).second)
            continue;
        if (rep.components.size() != 1)
            continue;
        ++totalPositions;
        for (const auto& comp : rep.components) {
            for (const auto& region : comp.regions) {
                const std::string rkey = regionKey(region);
                if (membraneCount >= 0 &&
                    std::count(rkey.begin(), rkey.end(), '9') != membraneCount)
                    continue;
                ++totalRegionOccurrences;
                ++regionCounts[rkey];
            }
        }
    }

    std::vector<std::pair<std::string, long long>> rows(regionCounts.begin(), regionCounts.end());
    std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
        if (a.second != b.second)
            return a.second > b.second;
        return a.first < b.first;
    });
    if (static_cast<int>(rows.size()) > topN)
        rows.resize(topN);

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << "region,count\n";
    for (const auto& [key, count] : rows)
        f << csvQuote(key) << "," << count << "\n";

    std::cerr << n << "-spot quick-canon tree: " << totalPositions << " distinct positions, "
              << totalRegionOccurrences << " region occurrences, " << regionCounts.size()
              << " distinct region shapes -> top " << rows.size() << " written to " << outPath
              << "\n";
    return 0;
}
