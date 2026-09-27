// One-off audit (2026-09-27): for every registered BASE (offset-0) collection's own rep, run the
// real isYellowCandidate() check against every one of the 32 hand-authored NAMED_FAMILIES entries
// (all shifts 0..kMaxShift) OTHER than whatever family the rep itself already resolves to -- looking
// for another S_192-style case (a registry-only family whose rep secretly also satisfies some named
// family's required-T-genes-with-bypass rule, the same check that caught S_192 vs S_5 this session).
// See [[feedback_use_yellow_line_for_collection_matching]] -- this is exactly the kind of question
// the existing isYellowCandidate/yellow_check machinery is for, so this tool is a thin batch driver
// around it, not a new comparison algorithm.
//
// Usage: audit_yellow_bases <bases.txt> [<out.tsv>]
//   bases.txt: one base rep encoding per line (e.g. "2a", "4A|3Aa").
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "genome_defs.generated.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

namespace {

std::string foldedName(const std::string& family, int shift) {
    if (shift == 0) return family;
    return family + "\xE2\x8A\x95" + std::to_string(shift);  // UTF-8 U+2295
}

std::vector<std::string> allNamedFamilyNames() {
    std::vector<std::string> names;
    for (const auto& [family, def] : genome_defs_generated::familyDefs()) {
        for (int shift = 0; shift <= genome_defs_generated::kMaxShift; ++shift) {
            const std::string name = foldedName(family, shift);
            if (hasNamedFamilyEntry(name)) names.push_back(name);
        }
    }
    return names;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: audit_yellow_bases <bases.txt> [<out.tsv>]\n";
        return 1;
    }
    const std::string outPath = (argc >= 3) ? argv[2] : "audit_yellow_bases.tsv";

    std::vector<std::string> reps;
    {
        std::ifstream in(argv[1]);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!line.empty()) reps.push_back(line);
        }
    }
    std::cerr << "bases: " << reps.size() << "\n";

    GameGraph g(GameGraph::Mode::Exact);
    std::vector<const Node*> roots;
    std::map<std::string, Position> repPos;
    for (const std::string& rep : reps) {
        try {
            Position p = canonicalize(parsePosition("[" + rep + "]"));
            Node* n = g.ensure(p);
            roots.push_back(n);
            repPos[rep] = p;
        } catch (const std::exception& e) {
            std::cerr << "skipping unparsable rep \"" << rep << "\": " << e.what() << "\n";
        }
    }
    std::cerr << "solved " << roots.size() << "/" << reps.size() << " target positions\n";

    std::stringstream specStream;
    saveSpecGraph(g, roots, specStream);
    const SpecDB db = loadSpecGraph(specStream);
    std::cerr << "in-memory SpecDB: " << db.size() << " nodes\n";

    const std::vector<std::string> families = allNamedFamilyNames();
    std::cerr << "named families to test against: " << families.size() << "\n";

    std::ofstream out(outPath);
    out << "rep\townResolvedName\tmatchedFamily\n";
    long long hits = 0, checked = 0;
    for (const auto& [rep, pos] : repPos) {
        const auto own = resolvedGenomeName(pos, db);
        for (const std::string& family : families) {
            if (own && *own == family) continue;  // trivial self-match
            ++checked;
            if (isYellowCandidate(pos, db, family)) {
                out << rep << "\t" << (own ? *own : "(none)") << "\t" << family << "\n";
                std::cerr << "HIT: " << rep << " (" << (own ? *own : "(none)") << ") vs " << family << "\n";
                ++hits;
            }
        }
    }
    std::cerr << "checked " << checked << " (rep, family) pairs, " << hits << " unexpected yellow hits\n";
    std::cerr << "wrote " << outPath << "\n";
    return 0;
}
