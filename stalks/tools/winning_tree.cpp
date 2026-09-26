// Offline tool: build the "winning game tree" for the n-spot start, either against the exact
// structural game graph (default) or, with --quick, against the Collections quick-canon
// graph (each position identity-reduced to its quick-canon representative; sub-positions are
// quick-canonized right along with everything else -- see the mode-agnostic traversal below).
//
// This is a filtered VIEW over the underlying graph, not a new solver: a position with nimber !=
// 0 (an N-position -- the player to move can force a win) keeps edges only to children whose
// nimber == 0 (the winning moves); a position with nimber == 0 (a P-position -- every move
// loses) keeps ALL of its children, since no move is better than any other once you're already
// lost under optimal play. Some positions are therefore never touched at all -- that's expected,
// not a bug.
//
// Unlike GameGraph::Node::children (which stays EMPTY on a sum/multi-subposition node -- see
// graph.hpp's doc comment: "its play-children are synthesized on the fly from the subposition
// nodes"), this tool includes sum positions and their real play-children too, using the same
// general childrenAllWithMoveTag() the Position Browser's analyze.cpp already uses for "works
// for sum roots too, whose node has no children" (see fullAnalysis). A GameGraph (Exact or
// Quick) is used underneath (via ensure()) to get/build each position's identity-form node --
// for a sum position that's just the XOR of its already-built parts, so visiting a newly-formed
// combination is cheap.
//
// --quick mode and the offset, precisely: a node's OWN nimber (Node::nimber) is always its
// intrinsic, standalone value -- GameGraph::build() computes it by expanding real moves directly
// on the node's own (already quick-canon) structure, exactly as if that representative were
// itself the position being played (see graph.cpp; also how the Position Browser's `enc` field
// for a quick child is the REP's own encoding, not the literal pre-reduction position -- clicking
// into it continues browsing from the rep). So once a node is "self" -- the position currently
// being expanded, whether that's the literal n-spot root or a rep substituted in a few moves
// back -- filtering its OWN outgoing edges uses self->nimber alone, with NO inherited offset from
// however self was first reached. The offset only lives on an EDGE: ensure(childRaw, &offset)
// returns, for THIS SPECIFIC move from THIS SPECIFIC parent, the 0/1 parity shift between the
// child's own representative nimber and the true value of the actual move's result (see
// graph.hpp: "the same [representative] node can be reached with two different offsets -- those
// are genuinely distinct edges" and analyze.cpp's quickAnalysis, which reports exactly
// `kn->nimber ^ off` as "true game value of the child" per edge). That true per-edge value is
// what decides whether THIS edge is a winning move; it is NOT what the child uses to classify
// itself once expansion continues from it. (In Exact mode every offset is always 0, so this all
// collapses to the obvious case.)
//
// The traversal dedupes by Node* (pointer-stable for the graph's lifetime): a rep reached from
// two different parents -- possibly with two different offsets -- is expanded exactly once (its
// own further children don't depend on how it was reached) but gets one recorded edge per parent.
// The result is therefore a DAG, not a strict tree -- consistent with how GameGraph itself shares
// nodes.
//
// After the tree is built, a second pass computes each node's ADVERSARIAL worst-case move count:
// how many more moves the game guaranteed-at-worst takes if the winning side always picks the
// tree edge that MINIMIZES this count (an N-position node -- the winner is choosing, so its value
// is 1 + the MIN over its already-winning-filtered children) while the losing side is modeled as
// actively trying to MAXIMIZE it (a P-position node -- every move is already kept, so its value is
// 1 + the MAX over all of them). This is a different question from Node::minMoves/maxMoves (which
// bound the game length under ANY play, winning or not); restricting the winner's own choice set
// to only the moves that were already kept by the P/N filter above is what answers "what should
// the winning player actually play to minimize the worst case." Every edge is then tagged
// `optimal`: for a P-position parent, always 1 (the winner must be prepared for every reply); for
// an N-position parent, 1 only if that child achieves the min, i.e. is one of the (possibly
// several, tied) best moves. Filtering the CSV to optimal=1 rows is the winning strategy itself.
//
// Usage: winning_tree <spots> <out.csv> [--quick]

#include "encoding.hpp"
#include "graph.hpp"
#include "moves.hpp"
#include "position.hpp"

#include <cstdio>
#include <fstream>
#include <functional>
#include <iostream>
#include <limits>
#include <string>
#include <unordered_map>
#include <unordered_set>
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

const char* moveKindName(MoveKind k) {
    switch (k) {
        case MoveKind::Enclosure: return "Enclosure";
        case MoveKind::Join: return "Join";
        case MoveKind::InteriorPseudo: return "InteriorPseudo";
        case MoveKind::External: return "External";
    }
    return "?";
}

// A node's own subposition count. Mirrors analyze.cpp's Node-based subposCount: reading it off
// the Node (rather than some raw pre-reduction position) matters in Quick mode, where a
// collections swap can change component count relative to the raw child childrenAllWithMoveTag
// produced -- "child_enc" names the REPRESENTATIVE, so its subpos count should too.
int subposCount(const Node* n) { return n->isSum() ? static_cast<int>(n->subpositions.size()) : 1; }

struct Edge {
    Node* parentNode = nullptr;
    Node* childNode = nullptr;
    std::string parentEnc;
    int parentNimber = 0;
    int parentSubpos = 0;
    std::string childEnc;
    int childOffset = 0;  // this edge's 0/1 parity shift (always 0 in Exact mode)
    int childNimber = 0;  // the TRUE value of this specific move's result: child->nimber ^ offset
    int childSubpos = 0;
    MoveTag move;
};

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: winning_tree <spots> <out.csv> [--quick]\n";
        return 1;
    }
    const int spots = std::atoi(argv[1]);
    const std::string outPath = argv[2];
    bool quick = false;
    for (int i = 3; i < argc; ++i)
        if (std::string(argv[i]) == "--quick")
            quick = true;
    const GameGraph::Mode mode = quick ? GameGraph::Mode::Quick : GameGraph::Mode::Exact;

    std::cerr << "building " << (quick ? "quick-canon" : "exact") << " " << spots
              << "-spot game graph...\n";
    GameGraph g(spots, mode);
    std::cerr << "base graph has " << g.size() << " nodes\n";

    Node* const root = g.root();

    std::vector<Edge> edges;
    std::unordered_set<Node*> visited;  // nodes already expanded in the winning tree
    std::vector<Node*> stack{root};
    visited.insert(root);

    long long nPositions = 0, pPositions = 0;

    while (!stack.empty()) {
        Node* self = stack.back();
        stack.pop_back();

        // The node's own encoding is a concrete, serialize-ready position (structural canonical
        // in Exact mode, quick-canon rep in Quick mode) -- parsing it back gives a real position
        // to enumerate real moves against, exactly as GameGraph::build() itself does.
        const Position p = parsePosition(self->enc);
        const int selfNimber = self->nimber;
        if (selfNimber == 0)
            ++pPositions;
        else
            ++nPositions;

        for (auto& [childRaw, tag] : childrenAllWithMoveTag(p)) {
            int childOffset = 0;
            Node* childNode = g.ensure(childRaw, &childOffset);
            const int childTrueNimber = childNode->nimber ^ childOffset;

            // N-position (nimber != 0): keep only the winning moves, i.e. edges whose true result
            // is a P-position. P-position (nimber == 0): keep every move -- none is "more
            // optimal" than another once you're already lost.
            if (selfNimber != 0 && childTrueNimber != 0)
                continue;

            edges.push_back(Edge{self, childNode, self->enc, selfNimber, subposCount(self),
                                  childNode->enc, childOffset, childTrueNimber,
                                  subposCount(childNode), tag});

            if (visited.insert(childNode).second)
                stack.push_back(childNode);
        }
    }

    // Adjacency for the DP: each node's already-filtered kept children (winning moves only for an
    // N-position, every move for a P-position -- exactly the edges just recorded above).
    std::unordered_map<Node*, std::vector<Node*>> kept;
    for (const Edge& e : edges)
        kept[e.parentNode].push_back(e.childNode);

    // worstCase[n] = the guaranteed number of further moves in this subtree if the winner always
    // picks the tree edge that minimizes it and the loser always picks the reply that maximizes
    // it. A node with no kept children is a leaf (terminal, or -- for a P-position -- simply out
    // of real moves): 0 further moves.
    std::unordered_map<Node*, long long> worstCase;
    std::function<long long(Node*)> solve = [&](Node* n) -> long long {
        if (const auto it = worstCase.find(n); it != worstCase.end())
            return it->second;
        const auto kit = kept.find(n);
        long long value = 0;
        if (kit != kept.end() && !kit->second.empty()) {
            const bool minimizer = n->nimber != 0;  // N-position: the winner is choosing
            value = minimizer ? std::numeric_limits<long long>::max()
                               : std::numeric_limits<long long>::min();
            for (Node* c : kit->second) {
                const long long v = 1 + solve(c);
                value = minimizer ? std::min(value, v) : std::max(value, v);
            }
        }
        worstCase[n] = value;
        return value;
    };
    const long long rootWorstCase = solve(root);

    long long optimalEdges = 0;
    std::string out;
    out += "parent_enc,parent_nimber,parent_subpos,parent_worst_case,child_enc,child_offset,"
           "child_nimber,child_subpos,child_worst_case,optimal,move_kind,move_component,"
           "move_region,move_boundary,move_mask,move_b1,move_b2,move_i,move_j\n";
    for (const Edge& e : edges) {
        const long long pv = worstCase.at(e.parentNode);
        const long long cv = worstCase.at(e.childNode);
        // For a P-position parent every kept edge is on the strategy (the winner must be
        // prepared for any reply); for an N-position parent, only the edge(s) achieving the min.
        const bool optimal = (e.parentNimber == 0) || (1 + cv == pv);
        if (optimal)
            ++optimalEdges;

        csvField(out, e.parentEnc);
        out += "," + std::to_string(e.parentNimber);
        out += "," + std::to_string(e.parentSubpos);
        out += "," + std::to_string(pv);
        out += ",";
        csvField(out, e.childEnc);
        out += "," + std::to_string(e.childOffset);
        out += "," + std::to_string(e.childNimber);
        out += "," + std::to_string(e.childSubpos);
        out += "," + std::to_string(cv);
        out += "," + std::to_string(optimal ? 1 : 0);
        out += ",";
        out += moveKindName(e.move.kind);
        out += "," + std::to_string(static_cast<long long>(e.move.component));
        out += "," + std::to_string(static_cast<long long>(e.move.region));
        out += "," + std::to_string(static_cast<long long>(e.move.boundary));
        out += "," + std::to_string(static_cast<long long>(e.move.mask));
        out += "," + std::to_string(static_cast<long long>(e.move.b1));
        out += "," + std::to_string(static_cast<long long>(e.move.b2));
        out += "," + std::to_string(e.move.i);
        out += "," + std::to_string(e.move.j);
        out += "\n";
    }

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << out;

    std::cerr << "winning tree: " << visited.size() << " positions ("
              << pPositions << " P-positions, " << nPositions << " N-positions), "
              << edges.size() << " edges (" << optimalEdges << " on the optimal strategy)\n";
    std::cerr << "root nimber: " << root->nimber << "\n";
    std::cerr << "guaranteed worst-case " << (quick ? "quick-canon " : "") << "moves from root "
              << "under adversarial play: " << rootWorstCase << "\n";
    std::cerr << "wrote " << edges.size() << " edges to " << outPath << "\n";
    return 0;
}
