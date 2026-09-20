// Ad-hoc research tool: for a given LIST of quick-canon left-side rep encodings (registered or
// not), scan an alpha-genome .spec corpus ONCE and, for the first raw structural sample found
// whose quickCanon() reduction matches each target rep, record its classified genome text
// (alpha_genome.hpp's fullGenomeText -- the SAME classification unregistered_left_sides.cpp uses,
// just not restricted to already-unregistered shapes). Genome text is only ever computed on a raw
// structural sample reachable in the corpus's own move graph, never on the rep text directly (see
// unregistered_left_sides.cpp's own doc comment on this) -- this tool exists because that other
// tool explicitly skips anything already registered, so it never produces genome text for an
// already-registered family's own rep.
//
// Usage: genome_for_reps <targets.txt> <spec1.spec> [spec2.spec ...] [out.tsv]
// targets.txt: one quick-canon rep encoding per line (as serialize()'d, e.g. "2,3,5a" or "3AB|ACD|BCDa").
// The last argument is treated as the output TSV path if it doesn't end in ".spec".
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

using namespace stalks;

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: genome_for_reps <targets.txt> <spec1.spec> [spec2.spec ...] [out.tsv]\n";
        return 1;
    }
    std::string outPath = "genome_for_reps.tsv";
    std::vector<std::string> specPaths;
    for (int i = 2; i < argc; ++i) {
        const std::string a = argv[i];
        if (a.size() > 5 && a.substr(a.size() - 5) == ".spec")
            specPaths.push_back(a);
        else
            outPath = a;
    }

    std::set<std::string> targets;
    {
        std::ifstream in(argv[1]);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!line.empty()) targets.insert(line);
        }
    }
    std::cerr << "targets: " << targets.size() << "\n";

    std::map<std::string, std::string> found;  // target rep -> genome text (first sample only)
    std::set<std::string> seenQuickEnc;

    for (const std::string& path : specPaths) {
        SpecDB db;
        try {
            db = loadSpecGraphFromFile(path);
        } catch (const std::exception& e) {
            std::cerr << "skipping " << path << ": " << e.what() << "\n";
            continue;
        }
        std::cerr << path << ": " << db.size() << " nodes\n";

        std::size_t scanned = 0;
        for (const SpecNode& node : db.nodes()) {
            ++scanned;
            if (scanned % 500000 == 0) {
                std::cerr << "  ..." << scanned << "/" << db.size() << "  (" << found.size() << "/"
                           << targets.size() << " targets found)\n";
                std::cerr.flush();
            }
            if (found.size() == targets.size()) break;  // all targets satisfied, stop early
            if (!stalks_tools::isSingleAlpha(node.enc)) continue;

            Position pBase;
            try {
                pBase = canonicalize(parsePosition(node.enc));
            } catch (const EncodingError&) {
                continue;
            }
            if (!hasSpecialPoint(pBase)) continue;

            const QuickCanonResult qc = quickCanon(pBase);
            const std::string quickEnc = serialize(qc.rep);
            if (!seenQuickEnc.insert(quickEnc).second) continue;
            if (!targets.count(quickEnc) || found.count(quickEnc)) continue;

            found[quickEnc] = stalks_tools::fullGenomeText(pBase, db);
        }
        std::cerr << "  scanned " << scanned << "/" << db.size() << ", " << found.size() << "/"
                   << targets.size() << " targets found so far\n";
        if (found.size() == targets.size()) break;
    }

    std::ofstream out(outPath);
    out << "rep\tgenome\n";
    for (const auto& t : targets) {
        out << t << "\t" << (found.count(t) ? found.at(t) : "(NOT FOUND IN CORPUS)") << "\n";
    }
    std::cerr << found.size() << "/" << targets.size() << " targets found. wrote " << outPath << "\n";
    return 0;
}
