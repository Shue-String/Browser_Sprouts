#include "graph.hpp"

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "moves.hpp"

#include <algorithm>
#include <set>
#include <utility>

namespace stalks {

std::string startEncoding(int spots) {
    std::string s = "[";
    for (int i = 0; i < spots; ++i)
        s += (i ? ",0" : "0");
    s += "]";
    return s;
}

GameGraph::GameGraph(int spots, Mode mode) : mode_(mode) {
    const QuickCanonResult r = identityForm(parsePosition(startEncoding(spots)));
    rootOffset_ = r.offset;
    root_ = build(r.rep);
}

GameGraph::GameGraph(const Position& start, Mode mode) : mode_(mode) {
    const QuickCanonResult r = identityForm(start);
    rootOffset_ = r.offset;
    root_ = build(r.rep);
}

Node* GameGraph::ensure(const Position& start, int* offsetOut) {
    const QuickCanonResult r = identityForm(start);
    if (offsetOut)
        *offsetOut = r.offset;
    Node* n = build(r.rep);
    if (!root_)
        root_ = n;  // first ensure seeds root_ (unused by incremental callers, but keeps it valid)
    return n;
}

// Reduce a position to the current mode's canonical identity. Exact -> structural canonical form
// (offset always 0). Quick -> the oplus-0 quick-canon representative + accumulated offset.
QuickCanonResult GameGraph::identityForm(const Position& p) const {
    if (mode_ == Mode::Quick)
        return quickCanon(p);
    return {canonicalize(p), 0};
}

Node* GameGraph::find(const std::string& enc) const {
    const std::string key = serialize(identityForm(parsePosition(enc)).rep);
    const auto it = index_.find(key);
    return it == index_.end() ? nullptr : it->second;
}

Node* GameGraph::placeholderFor(const Position& p) {
    const QuickCanonResult r = identityForm(p);
    const std::string enc = serialize(r.rep);
    if (const auto it = index_.find(enc); it != index_.end())
        return it->second;
    nodes_.push_back(Node{});
    Node* n = &nodes_.back();
    n->enc = enc;
    n->nimber = -1;
    n->minMoves = -1;
    n->maxMoves = -1;
    n->placeholder = true;
    index_.emplace(std::string_view(n->enc), n);
    return n;
}

// Memoize the canonicalize+build of a raw child on its raw serialization. build() hand-rolls
// the move loop (rather than using childrenAll), so the same normalized raw child recurs both
// within one parent (many moves land on it) and across parents (~11 arrivals per node at
// 5-spot); without this, canonicalize -- the dominant cost -- runs once per edge instead of
// once per distinct raw child. serialize is a faithful position identity (build/find already
// rely on it), so identical raw positions map to the same node and distinct positions never
// collide; nodes live in a deque, so the cached pointer stays valid.
GameGraph::ChildLink GameGraph::resolveChild(const Position& raw) {
    std::string key = serialize(raw);
    if (const auto it = childCache_.find(key); it != childCache_.end())
        return it->second;
    const QuickCanonResult r = identityForm(raw);
    ChildLink link{build(r.rep), r.offset};
    childCache_.emplace(std::move(key), link);
    return link;
}

// Recursive, memoized build. `canonical` must already be in structural canonical form.
// The graph is acyclic (every move strictly reduces total lives), so a node is never its
// own descendant and simple recursion terminates without cycle guards.
Node* GameGraph::build(const Position& canonical) {
    const std::string enc = serialize(canonical);
    Node* n = nullptr;
    if (const auto it = index_.find(enc); it != index_.end()) {
        if (!it->second->placeholder)
            return it->second;
        // Was only a cheap placeholder (see placeholderFor) -- expand it for real now instead of
        // trusting its -1 sentinel. Its subpositions/children are guaranteed empty (placeholders
        // are never expanded), so falling through into the normal build logic below is safe.
        n = it->second;
    } else {
        // Create the node and register it (owning its encoding) before recursing, so shared
        // descendants (diamonds) resolve to the one node.
        nodes_.push_back(Node{});
        n = &nodes_.back();  // deque: address stable across later push_backs
        n->enc = enc;
        index_.emplace(std::string_view(n->enc), n);
    }
    n->placeholder = false;

    if (canonical.components.size() > 1) {
        // Sum of >=2 minimal subpositions: link the parts, combine values (XOR for the
        // nimber, sum for the move bounds). Never expanded by moves.
        int nim = 0, mn = 0, mx = 0;
        for (const auto& comp : canonical.components) {
            Position sub;
            sub.components.push_back(comp);
            Node* s = build(sub);
            n->subpositions.push_back(s);
            nim ^= s->nimber;
            mn += s->minMoves;
            mx += s->maxMoves;
        }
        n->nimber = nim;
        n->minMoves = mn;
        n->maxMoves = mx;
        return n;
    }

    // Single minimal subposition: expand real enclosure/join moves on the decompressed form.
    // Each edge is (destination node, nimber offset); the offset is always 0 in Exact mode and
    // 0/1 in Quick mode. A child's contribution to this node's mex is child->nimber ^ offset.
    struct Candidate {
        ChildLink link;
        MoveTag tag;
    };
    std::vector<Candidate> kids;
    const Position d = canonical.decompressed();
    for (std::size_t k = 0; k < d.components.size(); ++k) {
        if (d.components[k].dead)
            continue;
        for (const auto& mv : enclosureMoves(d.components[k])) {
            MoveTag tag{MoveKind::Enclosure, k, mv.region, mv.boundary, mv.mask, 0, 0, mv.i, mv.j};
            kids.push_back({resolveChild(applyEnclosure(d, k, mv)), tag});
        }
        for (const auto& mv : joinMoves(d.components[k])) {
            MoveTag tag{MoveKind::Join, k, mv.region, 0, 0, mv.b1, mv.b2, mv.i, mv.j};
            kids.push_back({resolveChild(applyJoin(d, k, mv)), tag});
        }
    }
    // Distinct edges only (many moves can land on the same child + offset). In Quick mode the
    // same node can be reached with two different offsets -- those are genuinely distinct edges
    // (distinct game values), so we dedup on the (node, offset) pair, not the node alone. Sort is
    // stable so the first move (candidate order above) reaching each edge keeps its tag.
    std::stable_sort(kids.begin(), kids.end(), [](const Candidate& a, const Candidate& b) {
        return a.link.node != b.link.node ? a.link.node < b.link.node : a.link.offset < b.link.offset;
    });
    kids.erase(std::unique(kids.begin(), kids.end(),
                           [](const Candidate& a, const Candidate& b) {
                               return a.link.node == b.link.node && a.link.offset == b.link.offset;
                           }),
               kids.end());

    if (kids.empty()) {
        // Terminal (dead) position: mex of nothing is 0, no moves remain.
        n->nimber = 0;
        n->minMoves = 0;
        n->maxMoves = 0;
        return n;
    }

    std::set<int> vals;
    int mn = kids.front().link.node->minMoves;
    int mx = kids.front().link.node->maxMoves;
    const bool storeOffsets = (mode_ == Mode::Quick);
    for (const Candidate& c : kids) {
        const ChildLink& ch = c.link;
        n->children.push_back(ch.node);
        n->childMoves.push_back(c.tag);
        if (storeOffsets)
            n->childOffsets.push_back(ch.offset);
        ch.node->parents.push_back(n);
        vals.insert(ch.node->nimber ^ ch.offset);  // offset is 0 in Exact mode
        mn = std::min(mn, ch.node->minMoves);
        mx = std::max(mx, ch.node->maxMoves);
    }
    int m = 0;
    while (vals.count(m))
        ++m;
    n->nimber = m;
    n->minMoves = 1 + mn;
    n->maxMoves = 1 + mx;
    return n;
}

}  // namespace stalks
