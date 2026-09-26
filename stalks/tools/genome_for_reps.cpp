// For a given LIST of quick-canon left-side rep encodings (registered or not), computes the full
// genome text "(R,D,{L},{Z},[T])" for each -- fills a real gap in alpha_genome.cpp's own tooling:
// unregistered_left_sides.cpp explicitly skips anything already-registered, so it can never produce
// genome text for an already-registered family's own rep; this tool does, for an arbitrary target
// list, registered or not.
//
// Solves each target rep's OWN left-side encoding directly -- it's already a closed single-alpha
// position (the crit port IS the literal ascii 'a'/ALPHA token in the stored rep text, same
// convention buildRepCanonSet relies on) -- against one SHARED GameGraph (Mode::Exact), reused
// across every target for memoization (see feedback_gamegraph_reuse -- never build a fresh
// GameGraph per call). The solved subgraph is then serialized in-memory (saveSpecGraph ->
// stringstream -> loadSpecGraph) into a SpecDB purely so the EXISTING classifyAlphaGenome/
// fullGenomeText/tChildrenOf machinery (written against SpecDB, not GameGraph, since it was built
// for corpus audits) can run unchanged -- no disk I/O, no corpus file needed at all.
//
// 2026-09-21: replaced an earlier version of this tool that scanned a multi-million-node .spec
// corpus looking for a raw sample whose quickCanon reduction happened to match each target rep --
// correct, but took minutes for a couple hundred targets (dominated by the corpus scan, not the
// actual genome computation). This direct-solve approach takes ~2 seconds for the same workload,
// since a rep's own left-side text needs no "sample" search at all -- it already IS a valid,
// directly-parseable position. Flagged by the user as an obvious inefficiency (why scan 2.4M
// positions when the target position is already known?), confirmed correct via extensive
// pristine-vs-renamed A/B testing during the S_1-S_32 rename work (project_genome_renaming_tool.md)
// before replacing the corpus-based version outright.
//
// Also avoids a "self-fold" bug (see project_collect_collections_panel.md's "self-fold bug"
// section): a rep's own quickCanon reduction IS itself, so a plain fullGenomeText(rootPos) call
// would fold the ENTIRE root straight to its own family name via the registry-fold path (779c86f)
// instead of showing its real structure. Root's own (R,D,{L},{Z}) head is built directly via
// classifyAlphaGenome instead; only its real T-CHILDREN are folded via the ordinary fullGenomeText
// (T-children folding to a name there is correct/desired, unlike at the root).
//
// Size safety: gated at the same kMaxLives2=32 (16 lives) cap analyze.cpp's analyzeFullJson uses
// for its own most-permissive real-time exact solve -- GameGraph::ensure() has no built-in bound of
// its own, and every rep this tool has ever been used on is tiny (a handful of lives), but a
// standing tool should not hang/OOM outright if ever pointed at something unexpectedly large.
//
// Usage: genome_for_reps <targets.txt> [out.tsv]
// targets.txt: one raw left-side rep encoding per line (as stored in collectionsRoster.json's own
// "rep" field, e.g. "2,3,5a" or "3AB|ACD|BCDa" -- crit port already literal ascii 'a').
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;

namespace {

constexpr int kMaxLives2 = 32;  // 16 lives -- same gate as analyze.cpp's analyzeFullJson

int maxSubLives2(const Position& p) {
    int m = 0;
    for (const auto& comp : p.components) m = std::max(m, comp.lives2());
    return m;
}

std::string rootGenomeText(const Position& p, const SpecDB& db) {
    auto g = stalks_tools::classifyAlphaGenome(p, db);
    if (!g) return "(UNCLASSIFIABLE)";
    std::ostringstream out;
    out << "(" << g->R << "," << g->D << ",{";
    bool first = true;
    for (int v : g->L) { if (!first) out << ","; out << v; first = false; }
    out << "},{";
    first = true;
    for (int v : g->Z) { if (!first) out << ","; out << v; first = false; }
    out << "},[";
    auto children = stalks_tools::tChildrenOf(p);
    std::vector<std::string> tTexts;
    for (const auto& child : children) tTexts.push_back(stalks_tools::fullGenomeText(child, db));
    std::sort(tTexts.begin(), tTexts.end());
    first = true;
    for (const auto& t : tTexts) { if (!first) out << ","; out << t; first = false; }
    out << "])";
    return out.str();
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: genome_for_reps <targets.txt> [out.tsv]\n";
        return 1;
    }
    std::string outPath = (argc >= 3) ? argv[2] : "genome_for_reps.tsv";

    std::vector<std::string> targets;
    {
        std::ifstream in(argv[1]);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!line.empty()) targets.push_back(line);
        }
    }
    std::cerr << "targets: " << targets.size() << "\n";

    GameGraph g(GameGraph::Mode::Exact);
    std::vector<const Node*> roots;
    std::map<std::string, Position> targetPos;  // rep -> canonicalized position
    std::map<std::string, std::string> skipped;  // rep -> reason
    for (const std::string& rep : targets) {
        Position p;
        try {
            p = canonicalize(parsePosition("[" + rep + "]"));
        } catch (const EncodingError& e) {
            std::cerr << "skipping unparsable rep \"" << rep << "\": " << e.what() << "\n";
            skipped[rep] = "(PARSE ERROR)";
            continue;
        }
        if (maxSubLives2(p) > kMaxLives2) {
            std::cerr << "skipping oversized rep \"" << rep << "\" (maxSubLives2="
                       << maxSubLives2(p) << " > " << kMaxLives2 << ")\n";
            skipped[rep] = "(TOO LARGE)";
            continue;
        }
        Node* n = g.ensure(p);
        roots.push_back(n);
        targetPos[rep] = p;
    }
    std::cerr << "solved " << roots.size() << "/" << targets.size() << " target positions\n";

    std::stringstream specStream;
    saveSpecGraph(g, roots, specStream);
    SpecDB db = loadSpecGraph(specStream);
    std::cerr << "in-memory SpecDB: " << db.size() << " nodes\n";

    std::ofstream out(outPath);
    out << "rep\tgenome\n";
    for (const std::string& rep : targets) {
        auto sk = skipped.find(rep);
        if (sk != skipped.end()) {
            out << rep << "\t" << sk->second << "\n";
            continue;
        }
        out << rep << "\t" << rootGenomeText(targetPos.at(rep), db) << "\n";
    }
    std::cerr << "wrote " << outPath << "\n";
    return 0;
}
