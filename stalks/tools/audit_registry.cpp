// Audit tool (2026-09-15): for every "<family>\t<encoding>" pair read from stdin (the currently- or
// previously-registered roster, one row per element), builds a small standalone GameGraph exactly
// like yellow_check.cpp does and re-checks isYellowCandidate(candidate, db, family) under CURRENT
// classification logic. Prints one "<family>\t<encoding>\t<PASS|FAIL>" row per input so a caller can
// see exactly which previously-registered elements the current logic would still accept vs. no
// longer accept -- registry-independent (isYellowCandidate is a pure function of the structural
// position + genomeDefs.json, never the collections.cpp roster), so this doesn't need any particular
// registry state loaded to be meaningful.
//
// Usage: audit_registry < roster.tsv   (each line: "<family>\t<encoding>")
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <iostream>
#include <sstream>
#include <string>

using namespace stalks;
using namespace stalks_tools;

int main() {
    std::string line;
    long long total = 0, pass = 0, fail = 0;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        const auto tab = line.find('\t');
        if (tab == std::string::npos) continue;
        const std::string family = line.substr(0, tab);
        const std::string enc = line.substr(tab + 1);
        ++total;
        try {
            Position root = canonicalize(parsePosition("[" + enc + "]"));
            GameGraph g;
            Node* rootNode = g.ensure(root);
            std::vector<const Node*> roots = {rootNode};
            std::stringstream ss;
            saveSpecGraph(g, roots, ss);
            const SpecDB db = loadSpecGraph(ss);
            const bool yellow = isYellowCandidate(root, db, family);
            std::cout << family << "\t" << enc << "\t" << (yellow ? "PASS" : "FAIL") << "\n";
            if (yellow) ++pass; else ++fail;
        } catch (const std::exception& e) {
            std::cout << family << "\t" << enc << "\tERROR\t" << e.what() << "\n";
        }
        if (total % 100 == 0) { std::cerr << "  " << total << " checked (pass=" << pass << " fail=" << fail << ")\n"; std::cerr.flush(); }
    }
    std::cerr << "DONE: total=" << total << " pass=" << pass << " fail=" << fail << "\n";
    return 0;
}
