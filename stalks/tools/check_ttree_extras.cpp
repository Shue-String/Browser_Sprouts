// Independent, whole-tree cross-check of isYellowCandidate (see alpha_genome.hpp), built for the
// 2026-09-16 registry-rebuild-from-scratch: a candidate that goes yellow only has its OWN top-level
// T-children checked for "required" (folds to one of its family's tChildPlains) or "bypassed" (a
// grandchild folds back to the family) -- exactly one level, matching the Collect pane's T-gene
// table / the T-Tree pane's per-node classification (src/model/ttree.ts, src/ui/ttree.ts's dashed
// grey "extra" arrow). It does NOT recurse further to ask whether a REQUIRED child (or a bypass's
// own witness) is itself internally consistent -- normally moot, since a required child is by
// definition already an established named family, but a registry built by trusting a from-scratch
// discovery scan is exactly the situation where "normally moot" is worth actually checking rather
// than assuming (see [[feedback_no_unsourced_theory_claims]]-flavored caution: don't declare
// something sound without verifying it against the real engine).
//
// This tool builds the FULL T-Tree exactly as src/model/ttree.ts's buildTTree does -- required and
// extra children are expanded (queued) into their own nodes; a bypass's intermediate (bypassed)
// child is not separately expanded, but its witness (the grandchild that resolves back) is -- and
// re-runs isYellowCandidate at EVERY expanded node against that node's OWN resolvedGenomeName,
// reporting any node anywhere in the tree (not just the root) that would show a dashed-grey "extra"
// arrow. A candidate is only truly clean if the root AND every required/bypass-witness descendant
// all come back clean.
//
// Self-contained per candidate: builds its own small Exact GameGraph rooted at the candidate (same
// technique as yellow_check.cpp), so it needs no pre-built .spec corpus -- the graph reachable from
// a <=8-life left side is tiny.
//
// Usage: check_ttree_extras <candidates.tsv> [<out_report.tsv>]
//   <candidates.tsv>: the TSV find_yellow_candidates.exe writes -- header
//   "lives\tfamily\tquickEnc\tgenome", one candidate per row. Only `family` and `quickEnc` are used.
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <deque>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

namespace {

struct Candidate {
    int lives = 0;
    std::string family;
    std::string quickEnc;
};

std::vector<Candidate> readCandidates(const std::string& path) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("cannot open " + path);
    std::vector<Candidate> out;
    std::string line;
    bool first = true;
    while (std::getline(f, line)) {
        if (first) { first = false; continue; }  // header
        if (line.empty()) continue;
        std::stringstream ss(line);
        std::string livesStr, family, quickEnc;
        std::getline(ss, livesStr, '\t');
        std::getline(ss, family, '\t');
        std::getline(ss, quickEnc, '\t');
        out.push_back({std::atoi(livesStr.c_str()), family, quickEnc});
    }
    return out;
}

// Whole-tree result for one candidate: every node reached (required expansion + bypass witnesses,
// mirroring ttree.ts's queue), and which of those failed their OWN isYellowCandidate check.
struct TreeCheck {
    int nodesChecked = 0;
    int nodesUnclassified = 0;  // no resolvedGenomeName -- can't classify further, matches ttree.ts's
                                 // graceful "not shown" degradation for a non-root node
    std::vector<std::string> extraAt;  // "<enc> (<name>)" for every node whose own check failed
};

TreeCheck checkWholeTree(const Position& root, const SpecDB& db) {
    TreeCheck result;
    std::set<std::string> visited;
    std::deque<Position> queue{root};
    while (!queue.empty()) {
        Position node = queue.front();
        queue.pop_front();
        const std::string key = serialize(node);
        if (!visited.insert(key).second) continue;
        ++result.nodesChecked;

        const auto name = resolvedGenomeName(node, db);
        if (!name) { ++result.nodesUnclassified; continue; }

        if (!isYellowCandidate(node, db, *name)) result.extraAt.push_back(key + " (" + *name + ")");

        // Recurse into every T-child reachable from this node -- a strict superset of ttree.ts's own
        // expansion set (which skips a bypassed T-child itself, only expanding its witness): checking
        // a bypassed child's own subtree too is extra rigor, never a false alarm, since it's checked
        // against ITS OWN resolved family, not the parent's.
        for (const Position& t : tChildrenOf(node)) queue.push_back(t);
    }
    return result;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: check_ttree_extras <candidates.tsv> [<out_report.tsv>]\n";
        return 1;
    }
    const std::vector<Candidate> candidates = readCandidates(argv[1]);
    std::cerr << "loaded " << candidates.size() << " candidates\n";

    std::ofstream* reportFile = nullptr;
    std::ofstream reportStream;
    if (argc >= 3) {
        reportStream.open(argv[2], std::ios::binary);
        reportFile = &reportStream;
        (*reportFile) << "lives\tfamily\tquickEnc\tnodesChecked\tunclassified\tclean\textraNodes\n";
    }

    int cleanCount = 0, dirtyCount = 0, errorCount = 0;
    for (const Candidate& c : candidates) {
        try {
            const Position root = canonicalize(parsePosition("[" + c.quickEnc + "]"));

            GameGraph g;
            Node* rootNode = g.ensure(root);
            std::vector<const Node*> roots = {rootNode};
            std::stringstream ss;
            saveSpecGraph(g, roots, ss);
            const SpecDB db = loadSpecGraph(ss);

            const TreeCheck check = checkWholeTree(root, db);
            const bool clean = check.extraAt.empty();
            if (clean) ++cleanCount; else ++dirtyCount;

            if (!clean) {
                std::cout << "DIRTY  lives=" << c.lives << " family=" << c.family
                          << " quickEnc=" << c.quickEnc << "\n";
                for (const std::string& e : check.extraAt) std::cout << "    extra at: " << e << "\n";
            }

            if (reportFile) {
                std::string joined;
                for (std::size_t i = 0; i < check.extraAt.size(); ++i) {
                    if (i) joined += " | ";
                    joined += check.extraAt[i];
                }
                (*reportFile) << c.lives << "\t" << c.family << "\t" << c.quickEnc << "\t"
                              << check.nodesChecked << "\t" << check.nodesUnclassified << "\t"
                              << (clean ? "yes" : "no") << "\t" << joined << "\n";
            }
        } catch (const std::exception& e) {
            ++errorCount;
            std::cout << "ERROR  family=" << c.family << " quickEnc=" << c.quickEnc << ": " << e.what()
                      << "\n";
            if (reportFile)
                (*reportFile) << c.lives << "\t" << c.family << "\t" << c.quickEnc << "\t0\t0\terror\t"
                              << e.what() << "\n";
        }
    }

    std::cerr << "checked " << candidates.size() << " candidates: " << cleanCount << " clean, "
              << dirtyCount << " with a hidden extra somewhere in the tree, " << errorCount
              << " errored\n";
    return 0;
}
