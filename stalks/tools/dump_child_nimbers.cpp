// Offline tool: build the exact 6-spot game graph and, for every minimal (single-subposition)
// node, emit a CSV row: canonical encoding, its nimber, its number of child positions, then the
// count of children with each nimber (columns per distinct child nimber, ascending nimber value).
//
// Rows are sorted by the number of nimber-0 children, descending.
//
// Usage: dump_child_nimbers <spots> <out.csv>

#include "graph.hpp"
#include "position.hpp"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using namespace stalks;

namespace {

void csvField(std::string& out, const std::string& s) {
    // Encodings contain commas -> always quote; double any embedded quotes.
    out += '"';
    for (char c : s) {
        if (c == '"') out += '"';
        out += c;
    }
    out += '"';
}

struct Row {
    std::string enc;
    int nimber = 0;
    int numChildren = 0;
    std::map<int, int> childNimberCounts;  // child nimber -> count
};

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: dump_child_nimbers <spots> <out.csv>\n";
        return 1;
    }
    const int spots = std::atoi(argv[1]);
    const std::string outPath = argv[2];

    std::cerr << "building exact " << spots << "-spot game graph...\n";
    GameGraph g(spots, GameGraph::Mode::Exact);
    std::cerr << "graph has " << g.size() << " nodes\n";

    std::vector<Row> rows;
    int maxNimber = 0;
    for (const Node& n : g.nodes()) {
        if (n.isSum()) continue;       // master files store only minimal nodes
        if (n.placeholder) continue;   // never expanded, no real value

        Row r;
        r.enc = n.enc;
        r.nimber = n.nimber;
        r.numChildren = static_cast<int>(n.children.size());
        for (const Node* c : n.children) {
            r.childNimberCounts[c->nimber]++;
            maxNimber = std::max(maxNimber, c->nimber);
        }
        rows.push_back(std::move(r));
    }

    // Sort by number of nimber-0 children, descending.
    std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) {
        auto ia = a.childNimberCounts.find(0);
        auto ib = b.childNimberCounts.find(0);
        int za = (ia == a.childNimberCounts.end()) ? 0 : ia->second;
        int zb = (ib == b.childNimberCounts.end()) ? 0 : ib->second;
        return za > zb;
    });

    std::string out;
    // Header
    out += "encoding,nimber,num_children,pct_n0_children";
    for (int k = 0; k <= maxNimber; ++k) out += ",n" + std::to_string(k) + "_children";
    out += "\n";

    for (const Row& r : rows) {
        csvField(out, r.enc);
        out += "," + std::to_string(r.nimber);
        out += "," + std::to_string(r.numChildren);
        {
            auto it = r.childNimberCounts.find(0);
            int zero = (it == r.childNimberCounts.end()) ? 0 : it->second;
            double pct = (r.numChildren > 0) ? (100.0 * zero / r.numChildren) : 0.0;
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%.2f", pct);
            out += ",";
            out += buf;
        }
        for (int k = 0; k <= maxNimber; ++k) {
            auto it = r.childNimberCounts.find(k);
            out += "," + std::to_string(it == r.childNimberCounts.end() ? 0 : it->second);
        }
        out += "\n";
    }

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << out;
    std::cerr << "wrote " << rows.size() << " rows to " << outPath << "\n";
    return 0;
}
