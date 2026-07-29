#include "specfile.hpp"

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "moves.hpp"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <functional>
#include <set>
#include <stdexcept>
#include <unordered_set>

namespace stalks {

namespace {

constexpr char kMagic[4] = {'S', 'P', 'E', 'C'};
constexpr std::uint8_t kVersion = 1;

// --- LEB128 unsigned varints (own copies -- deliberately not shared with savefile.cpp's, which
// are file-local anyway; the whole point of this format is to have no shared code path with it) ---

void putVarint(std::ostream& out, std::uint64_t v) {
    do {
        std::uint8_t b = static_cast<std::uint8_t>(v & 0x7F);
        v >>= 7;
        if (v)
            b |= 0x80;
        out.put(static_cast<char>(b));
    } while (v);
}

void putByte(std::ostream& out, std::uint8_t b) { out.put(static_cast<char>(b)); }

std::uint8_t getByte(std::istream& in) {
    const int c = in.get();
    if (c == std::char_traits<char>::eof())
        throw std::runtime_error("specfile: unexpected end of stream");
    return static_cast<std::uint8_t>(c);
}

std::uint64_t getVarint(std::istream& in) {
    std::uint64_t v = 0;
    int shift = 0;
    for (;;) {
        const std::uint8_t b = getByte(in);
        v |= static_cast<std::uint64_t>(b & 0x7F) << shift;
        if (!(b & 0x80))
            return v;
        shift += 7;
        if (shift >= 64)
            throw std::runtime_error("specfile: varint too long");
    }
}

// --- Raw (unpacked) strings: no 5-bit alphabet restriction, so special-point letters 'a'-'j' need
// no special handling at all -- unlike savefile.cpp's putPackedString, which must reject them. ---

void putRawString(std::ostream& out, const std::string& s) {
    putVarint(out, s.size());
    out.write(s.data(), static_cast<std::streamsize>(s.size()));
}

std::string getRawString(std::istream& in) {
    const std::uint64_t len = getVarint(in);
    std::string s;
    s.resize(static_cast<std::size_t>(len));
    if (len > 0 && !in.read(&s[0], static_cast<std::streamsize>(len)))
        throw std::runtime_error("specfile: unexpected end of stream reading encoding");
    return s;
}

// The minimal-node component list a child edge points at: the child itself if it is minimal, or the
// child's subposition parts if it is a sum. Every returned node is a stored (minimal) node.
std::vector<const Node*> childComponents(const Node* child) {
    if (child->isSum())
        return {child->subpositions.begin(), child->subpositions.end()};
    return {child};
}

// .sprout's ascending-lives2() ordering ("every move strictly reduces lives, so a child always
// precedes its parent") does NOT hold once special points are involved. lives2() deliberately
// returns 0 for a special-point token in place (Phase 1's locked semantics), but the specific
// movetype-2 transformation ("becomes a scab") replaces it with a token that DOES carry lives2 --
// a scab occupying its own standalone one-token boundary was empirically found (via
// debug_spec_order.exe on "[0,a]") to carry MORE remaining capacity than the special point it
// replaced, so lives2() can flat-out INCREASE across that one edge. No numeric proxy derived from
// the encoding is safe to sort by here.
//
// The robust fix: don't derive an ordering key from the position at all. Walk the GameGraph's own
// child/subposition edges in DFS POST-ORDER. The graph is acyclic by construction -- it was built
// by graph.cpp's memoized recursion, which only terminates because no position is ever revisited as
// its own ancestor -- so a post-order traversal unconditionally emits every child (and every sum's
// component parts) strictly before the node that references it, with zero assumptions about what
// any per-position numeric quantity does. Also serves as the multi-root reachability sweep: a node
// shared by two roots' subtrees is visited (and written) exactly once.
std::vector<const Node*> topoOrderMulti(const std::vector<const Node*>& roots) {
    std::vector<const Node*> out;
    std::unordered_set<const Node*> visited;
    std::function<void(const Node*)> visit = [&](const Node* n) {
        if (!visited.insert(n).second)
            return;
        for (const Node* c : n->children)
            visit(c);
        for (const Node* s : n->subpositions)
            visit(s);
        if (!n->isSum())
            out.push_back(n);  // post-order: only after every dependency is already in `out`
    };
    for (const Node* r : roots)
        visit(r);
    return out;
}

// Write a set of minimal nodes (and their edges) as a complete .spec stream, in the given
// (already-topological) order. `mins` must be closed under edge references -- every component of
// every edge is itself in `mins` -- which topoOrderMulti's traversal guarantees.
std::size_t writeMinimalSpec(const GameGraph& g, const std::vector<const Node*>& mins, std::ostream& out) {
    std::unordered_map<const Node*, std::size_t> indexOf;
    indexOf.reserve(mins.size() * 2);
    for (std::size_t i = 0; i < mins.size(); ++i)
        indexOf.emplace(mins[i], i);

    const bool quick = (g.mode() == GameGraph::Mode::Quick);

    out.write(kMagic, sizeof(kMagic));
    putByte(out, kVersion);
    putByte(out, quick ? 1 : 0);
    putVarint(out, mins.size());

    for (std::size_t rank = 0; rank < mins.size(); ++rank) {
        const Node* n = mins[rank];
        putRawString(out, n->enc);
        putVarint(out, n->children.size());
        for (std::size_t c = 0; c < n->children.size(); ++c) {
            const std::vector<const Node*> comps = childComponents(n->children[c]);
            if (comps.size() == 1) {
                const std::size_t ci = indexOf.at(comps[0]);  // < rank (post-order guarantee)
                putVarint(out, (rank - ci) << 1);
            } else {
                putVarint(out, (comps.size() << 1) | 1);
                for (const Node* comp : comps)
                    putVarint(out, rank - indexOf.at(comp));
            }
            if (quick)
                putByte(out, static_cast<std::uint8_t>(n->childOffset(c) & 1));
            putVarint(out, static_cast<std::uint64_t>(n->childMoveType(c)));
        }
    }
    return mins.size();
}

}  // namespace

std::size_t saveSpecGraph(const GameGraph& g, const std::vector<const Node*>& roots, std::ostream& out) {
    return writeMinimalSpec(g, topoOrderMulti(roots), out);
}

std::size_t saveSpecGraphToFile(const GameGraph& g, const std::vector<const Node*>& roots,
                                 const std::string& path) {
    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("specfile: cannot open '" + path + "' for writing");
    return saveSpecGraph(g, roots, out);
}

SpecDB loadSpecGraph(std::istream& in) {
    char magic[4];
    if (!in.read(magic, sizeof(magic)) || std::memcmp(magic, kMagic, sizeof(magic)) != 0)
        throw std::runtime_error("specfile: bad magic");
    const std::uint8_t version = getByte(in);
    if (version != kVersion)
        throw std::runtime_error("specfile: unsupported version");
    const std::uint8_t modeByte = getByte(in);
    const bool quick = (modeByte == 1);

    SpecDB db;
    db.mode_ = quick ? GameGraph::Mode::Quick : GameGraph::Mode::Exact;

    const std::uint64_t count = getVarint(in);
    db.nodes_.reserve(static_cast<std::size_t>(count));
    db.index_.reserve(static_cast<std::size_t>(count) * 2);

    for (std::uint64_t i = 0; i < count; ++i) {
        SpecNode node;
        node.enc = getRawString(in);
        const std::uint64_t childCount = getVarint(in);
        node.edges.reserve(static_cast<std::size_t>(childCount));

        // Recompute this node's value from its edges, exactly like savefile.cpp's loader: mex over
        // child nimbers, 1 + best move bounds. Movetype never affects this -- two edges with
        // different movetype but the same underlying child position contribute the same (nim,mn,mx)
        // triple, and std::set/min/max are naturally idempotent on repeats (mirrors graph.cpp's own
        // "mex dedups by (node,offset) alone" rule).
        std::set<int> vals;
        int minChild = 0, maxChild = 0;
        bool haveChild = false;
        auto applyDelta = [&](std::uint64_t delta, int& nim, int& mn, int& mx) {
            if (delta == 0 || delta > i)
                throw std::runtime_error("specfile: child index out of range");
            const SpecValue& cv = db.nodes_[static_cast<std::size_t>(i - delta)].value;
            nim ^= cv.nimber;
            mn += cv.minMoves;
            mx += cv.maxMoves;
        };
        for (std::uint64_t c = 0; c < childCount; ++c) {
            const std::uint64_t desc = getVarint(in);
            int nim = 0, mn = 0, mx = 0;
            if ((desc & 1) == 0) {
                applyDelta(desc >> 1, nim, mn, mx);
            } else {
                const std::uint64_t compCount = desc >> 1;
                for (std::uint64_t k = 0; k < compCount; ++k)
                    applyDelta(getVarint(in), nim, mn, mx);
            }
            if (quick)
                nim ^= (getByte(in) & 1);
            const int movetype = static_cast<int>(getVarint(in));

            SpecEdge edge;
            edge.child.nimber = nim;
            edge.child.minMoves = mn;
            edge.child.maxMoves = mx;
            edge.movetype = movetype;
            node.edges.push_back(edge);

            vals.insert(nim);
            if (!haveChild) {
                minChild = mn;
                maxChild = mx;
                haveChild = true;
            } else {
                minChild = std::min(minChild, mn);
                maxChild = std::max(maxChild, mx);
            }
        }

        if (haveChild) {
            int m = 0;
            while (vals.count(m))
                ++m;
            node.value.nimber = m;
            node.value.minMoves = 1 + minChild;
            node.value.maxMoves = 1 + maxChild;
        }  // else terminal: 0/0/0

        db.index_.emplace(node.enc, db.nodes_.size());
        db.nodes_.push_back(std::move(node));
    }
    return db;
}

SpecDB loadSpecGraphFromFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in)
        throw std::runtime_error("specfile: cannot open '" + path + "' for reading");
    return loadSpecGraph(in);
}

const SpecNode* SpecDB::findMinimal(const std::string& enc) const {
    const auto it = index_.find(enc);
    return it == index_.end() ? nullptr : &nodes_[it->second];
}

bool SpecDB::value(const Position& p, SpecValue& out, int* offsetOut) const {
    Position rep;
    int offset = 0;
    if (mode_ == GameGraph::Mode::Quick) {
        const QuickCanonResult r = quickCanon(p);
        rep = r.rep;
        offset = r.offset;
    } else {
        rep = canonicalize(p);
    }
    if (offsetOut)
        *offsetOut = offset;

    SpecValue acc;
    for (const Component& comp : rep.components) {
        Position one;
        one.components.push_back(comp);
        const SpecNode* n = findMinimal(serialize(one));
        if (!n)
            return false;
        acc.nimber ^= n->value.nimber;
        acc.minMoves += n->value.minMoves;
        acc.maxMoves += n->value.maxMoves;
    }
    out = acc;
    return true;
}

}  // namespace stalks
