// Offline reporting tool: for every UNREGISTERED double-crit candidate leftSideKey found by
// unregistered_double_crit_regions.cpp's own scan at <n> spots, build the standalone position,
// compute its double-crit genome (double_crit_genome.hpp), and write a report grouped by genome
// text -- so left sides that turn out to share an identical genome (a likely single family, e.g.
// the "2ab" vs "Z_1" case found by hand this session) cluster together instead of scrolling past
// each other in a flat alphabetical list.
//
// The genome is computed at fold depth 1 (not 0): still the position's own full 16-slot core with
// real recursion into it, but each [T(p)] member is left as its own BARE core (one level of peek,
// not fully expanded) -- full depth-0 output nests too deep to skim across dozens of candidates at
// once (see the aC|12C32b example from earlier this session). Use double_crit_probe.exe directly
// on any single candidate from this report for the full expansion.
//
// Usage: double_crit_candidates_report <n> [out.csv]
// Default output path: "<n>_spot_double_crit_candidates.csv" in the current directory.
#include "canon.hpp"
#include "collections.hpp"
#include "double_crit_genome.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

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

std::set<Token> distinctSpecialTokens(const std::string& s) {
    std::set<Token> out;
    for (char ch : s)
        if (ch >= 'a' && ch <= 'j') out.insert(charToken(ch));
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: double_crit_candidates_report <n> [out.csv]\n";
        return 1;
    }
    const int n = std::atoi(argv[1]);
    const std::string outPath =
        argc >= 3 ? argv[2] : (std::to_string(n) + "_spot_double_crit_candidates.csv");

    const std::set<std::string> registered = registeredDoubleCritKeys();

    const auto positions = reachablePositions(n);
    std::set<std::string> qset;
    std::map<std::string, long long> counts;  // unregistered leftSideKey -> occurrence count

    for (const auto& enc : positions) {
        const Position rep = quickCanon(parsePosition(enc)).rep;
        const std::string key = serialize(rep);
        if (!qset.insert(key).second) continue;
        if (rep.components.size() != 1) continue;

        for (const std::string& leftKey : detachableDoubleCritLeftSideKeys(rep)) {
            if (!registered.count(leftKey)) ++counts[leftKey];
        }
    }

    std::cerr << n << "-spot scan: " << counts.size() << " distinct unregistered candidates -- computing genomes...\n";

    // genome text -> list of (leftSideKey, count), so identical-genome candidates cluster.
    std::map<std::string, std::vector<std::pair<std::string, long long>>> byGenome;
    long long done = 0;
    for (const auto& [leftKey, count] : counts) {
        ++done;
        if (done % 100 == 0) { std::cerr << "  ..." << done << "/" << counts.size() << "\n"; std::cerr.flush(); }

        const std::set<Token> toks = distinctSpecialTokens(leftKey);
        if (toks.size() != 2) {
            std::cerr << "  skipping '" << leftKey << "': expected 2 crit letters, found " << toks.size() << "\n";
            continue;
        }
        const Token tok1 = *toks.begin();
        const Token tok2 = *std::next(toks.begin());

        std::string genomeText;
        try {
            Position root = canonicalize(parsePosition("[" + leftKey + "]"));
            GameGraph g;
            Node* rootNode = g.ensure(root);
            std::vector<const Node*> roots = {rootNode};
            std::stringstream ss;
            saveSpecGraph(g, roots, ss);
            const SpecDB db = loadSpecGraph(ss);
            genomeText = doubleCritGenomeText(root, db, tok1, tok2, 1);
        } catch (const std::exception& e) {
            genomeText = std::string("ERROR: ") + e.what();
        }

        byGenome[genomeText].push_back({leftKey, count});
    }

    // Sort groups by total occurrence (descending) so the most common shapes surface first;
    // within a group, sort members by leftSideKey for stable, readable output.
    std::vector<std::pair<std::string, std::vector<std::pair<std::string, long long>>>> groups(
        byGenome.begin(), byGenome.end());
    for (auto& [genome, members] : groups)
        std::sort(members.begin(), members.end());
    std::sort(groups.begin(), groups.end(), [](const auto& a, const auto& b) {
        long long ta = 0, tb = 0;
        for (const auto& [k, c] : a.second) ta += c;
        for (const auto& [k, c] : b.second) tb += c;
        if (ta != tb) return ta > tb;
        return a.first < b.first;
    });

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    // leftSideKey leads (it's the actual usable left side -- feed it straight to
    // double_crit_probe.exe, or drop it into "[<leftSideKey>/" for the paper's own left-side
    // notation) with genome trailing, so the identifying text isn't buried after a long genome
    // string when skimmed as a table.
    f << "leftSideKey,displayLeftSide,count,genome\n";
    for (const auto& [genome, members] : groups)
        for (const auto& [key, count] : members)
            f << csvQuote(key) << "," << csvQuote("[" + key + "/") << "," << count << "," << csvQuote(genome) << "\n";

    std::cerr << n << "-spot: " << groups.size() << " distinct genomes across " << counts.size()
              << " unregistered candidates -> " << outPath << "\n";
    return 0;
}
