#pragma once
#include "collections.hpp"  // QuickCanonResult (quick-canon identity form)
#include "moves.hpp"        // MoveTag
#include "position.hpp"

#include <deque>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace stalks {

// The n-spot start encoding, "[0,0,...,0]" (n spots). The single source for every caller,
// test, or diagnostic harness that needs a fresh game's root.
std::string startEncoding(int spots);

// One position in the game graph. The node OWNS its canonical encoding (`enc`); every link
// is a non-owning pointer into the owning GameGraph's node storage, whose addresses are
// stable for the graph's lifetime. Need a child's string? Read `child->enc` -- no redundant
// copies.
//
// A node with a non-empty `subpositions` list is a disjoint SUM of >=2 minimal subpositions:
// it is NEVER expanded by real moves (its value is recoverable from the parts), so `children`
// stays empty and its play-children are synthesized on the fly from the subposition nodes.
// An empty `subpositions` list means a single minimal subposition, expanded into `children`.
struct Node {
    std::string enc;                  // canonical (structural) encoding -- the node's identity
    int nimber = 0;                   // Grundy value: mex of children, or XOR of subpositions
    int minMoves = 0;                 // fewest moves to finish the game from here
    int maxMoves = 0;                 // most moves to finish the game from here

    // True for a lightweight marker registered by placeholderFor() for a position that's been
    // *seen* (e.g. reported as an unvalued child of an oversized position) but never expanded --
    // nimber/minMoves/maxMoves are the -1 sentinel, not real values. build() checks this flag: a
    // placeholder hit is expanded in place rather than trusted as an already-built node, so a
    // later full analysis reaching the same position via ensure()/resolveChild always computes it
    // properly instead of mex()-ing over a stale -1.
    bool placeholder = false;

    std::vector<Node*> subpositions;  // non-empty => this is a sum; do not expand
    std::vector<Node*> children;      // single-subposition only (sum children are on the fly)
    std::vector<Node*> parents;       // back-links along the computed tree

    // Per-child-edge move identity (parallel to `children`): the first raw move (component,
    // region, boundary/b1/b2, i, j, mask) that was found to reach that edge. Lets callers
    // (e.g. the analysis JSON) report which move to play to reach a given child, not just the
    // child itself. Empty in sum nodes (children is empty there too).
    std::vector<MoveTag> childMoves;

    // Per-child-edge nimber offset (oplus-a tag), parallel to `children`. Only populated in
    // quick-canon mode: a child position that quick-canonicalizes to `children[i]` contributes
    // `children[i]->nimber ^ childOffsets[i]` to this node's mex. Empty (all-zero) in exact mode,
    // where every move maps to its child's true structural value. See GameGraph::Mode.
    std::vector<int> childOffsets;

    bool isSum() const { return !subpositions.empty(); }

    // Offset on the edge to children[i] (0 when offsets are not stored, i.e. exact mode).
    int childOffset(std::size_t i) const { return childOffsets.empty() ? 0 : childOffsets[i]; }
};

// The game graph reachable from an n-spot start, built in ONE pass: as the tree is grown,
// each node's nimber / minMoves / maxMoves are computed bottom-up and parent<->child links
// are wired. Single-subposition nodes are expanded by real enclosure/join moves; sum nodes
// link to their subposition nodes instead and combine values (XOR for nimber, + for move
// bounds). The node set is therefore the subposition-pruned "solver-minimal" set.
class GameGraph {
public:
    // How positions are identified (and therefore how many nodes are expanded).
    //   Exact -- structural canonical form (the base game graph). Distinct positions stay
    //            distinct; every reachable position is a node. This is the historical behavior.
    //   Quick -- Advanced Collections quick-canon form. A position is identified with its
    //            oplus-0 quick-canon representative and each edge carries the swap's nimber offset
    //            (0/1). Collections-equivalent positions collapse to one node, so far fewer nodes
    //            are expanded and valued -- the whole point of quick-canon -- while the root's
    //            true Grundy value is still recovered exactly (rootNimber()). Independent of the
    //            STALKS_COLLECTIONS env toggle: the mode is chosen here, explicitly.
    //
    //  IMPORTANT (Quick mode): only the NIMBER is preserved. A collections swap replaces a chunk
    //  with a value-equivalent representative that is generally a DIFFERENT game -- so minMoves /
    //  maxMoves on Quick nodes describe the representatives, NOT the original position, and are not
    //  trustworthy game lengths (they typically come out shorter). Use Quick mode for Grundy
    //  values; use Exact mode when you need move bounds.
    enum class Mode { Exact, Quick };

    // Empty graph (no root yet); grow it incrementally with ensure(). Used for the persistent,
    // cross-call graphs behind the Position Browser's on-demand analysis, so nodes computed for
    // one position are reused (never recomputed) when a later position's subtree reaches them.
    explicit GameGraph(Mode mode = Mode::Exact) : mode_(mode) {}

    explicit GameGraph(int spots, Mode mode = Mode::Exact);

    // Build the graph rooted at an arbitrary position (any encoding, not just an n-spot start).
    // The position is canonicalized first; the whole reachable subtree below it is built and
    // valued in one pass (see build()). Used by the analysis entry point (analyze.cpp).
    explicit GameGraph(const Position& start, Mode mode = Mode::Exact);

    // Find-or-build the node for an arbitrary position (canonicalized into this graph's identity
    // form first), reusing any already-built nodes. Returns the node; if `offsetOut` is non-null it
    // receives the identity-form nimber offset (always 0 in Exact mode; 0/1 in Quick mode). The
    // whole reachable subtree below it is built and valued in one pass on first encounter. This is
    // the incremental entry point: successive calls accumulate into one shared node set.
    Node* ensure(const Position& start, int* offsetOut = nullptr);

    // Find-or-create a placeholder node for `p` (identity-form canonicalized first): a cheap
    // marker recording that this position has been seen, with nimber/minMoves/maxMoves set to
    // the -1 "not yet computed" sentinel. Does not expand moves or recurse -- cost is independent
    // of the position's size. If a node (placeholder or fully built) already exists, it's
    // returned unchanged. See Node::placeholder and build()'s placeholder-aware expansion.
    Node* placeholderFor(const Position& p);

    Node* root() const { return root_; }
    Mode mode() const { return mode_; }
    std::size_t size() const { return nodes_.size(); }

    // True Grundy value / nimber offset of the whole start position. In Exact mode the offset is
    // always 0 and rootNimber() == root()->nimber. In Quick mode the root node holds the value of
    // its quick-canon representative, and the start's true value is root()->nimber ^ rootOffset().
    int rootOffset() const { return rootOffset_; }
    int rootNimber() const { return root_->nimber ^ rootOffset_; }

    // Read-only sweep over every node (for analysis: histograms, P-position lists, etc.).
    const std::deque<Node>& nodes() const { return nodes_; }

    // Find a node by encoding (canonicalizes the argument first). Null if absent.
    Node* find(const std::string& enc) const;

private:
    // Find-or-create the node for an already-canonical position, recursively building and
    // valuing it (and everything below) on first encounter. Cycles are impossible (moves
    // strictly reduce lives), so a simple memoized recursion terminates.
    Node* build(const Position& canonical);

    // A resolved child edge: the destination node plus the nimber offset picked up reducing the
    // raw child to it (always 0 in Exact mode; 0/1 in Quick mode from the quick-canon swaps).
    struct ChildLink {
        Node* node = nullptr;
        int offset = 0;
    };

    // Resolve one raw (post-move, slack-normalized) child position to its node + edge offset,
    // memoizing on the raw serialization so the expensive canonicalization is paid once per
    // distinct raw child rather than once per edge. Exact mode canonicalizes structurally
    // (offset 0); Quick mode quick-canonicalizes (offset from the collections swaps). Identical
    // raw positions reduce identically, so caching the result is exact -- see graph.cpp.
    ChildLink resolveChild(const Position& raw);

    // Canonicalize a position into the current mode's identity form (structural vs quick-canon).
    // Used for the root and for find(). Returns the mode's canonical position and, for Quick,
    // the accumulated nimber offset (0 in Exact).
    QuickCanonResult identityForm(const Position& p) const;

    Mode mode_ = Mode::Exact;
    std::deque<Node> nodes_;                            // pointer-stable node storage
    std::unordered_map<std::string_view, Node*> index_; // view into each node's owned enc
    std::unordered_map<std::string, ChildLink> childCache_; // raw child serialization -> edge
    Node* root_ = nullptr;
    int rootOffset_ = 0;
};

} // namespace stalks
