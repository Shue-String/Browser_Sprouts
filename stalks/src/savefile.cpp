#include "savefile.hpp"

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <set>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace stalks {

namespace {

constexpr char kMagic[4] = {'S', 'P', 'R', 'T'};
constexpr std::uint8_t kVersion = 1;

// --- LEB128 unsigned varints + length-prefixed strings ---

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
        throw std::runtime_error("savefile: unexpected end of stream");
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
            throw std::runtime_error("savefile: varint too long");
    }
}

// --- 5-bit encoding alphabet ---
//
// A single minimal-node encoding uses only: digits 0-9, the two separators '|' and ',', and the
// membrane letters. That is 12 fixed symbols; the remaining 20 codes cover letters A..T, so a
// component may carry up to 20 distinct membranes (letters come in pairs => ~10 spots) before it
// no longer fits 5 bits. Every char therefore packs into 5 bits and each node's encoding is stored
// as a varint length + ceil(5*len/8) packed bytes. A 21st membrane letter (U+, i.e. a >20-membrane
// component) cannot be represented and the whole save is rejected -- these positions are far beyond
// what is analyzed today and want a different, wider scheme anyway.
constexpr char kAlphabet[32] = {'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '|', ',',
                                'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L',
                                'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'};

// Char -> 5-bit code, or -1 if the char is outside the packable alphabet.
int codeOf(char ch) {
    if (ch >= '0' && ch <= '9')
        return ch - '0';
    if (ch == '|')
        return 10;
    if (ch == ',')
        return 11;
    if (ch >= 'A' && ch <= 'T')
        return 12 + (ch - 'A');
    return -1;
}

char charOf(int code) { return kAlphabet[code & 0x1F]; }

// varint length, then the chars packed 5 bits each (little-endian bit order), byte-aligned per
// string (<1 byte of padding per node -- negligible vs. the size the packing saves).
void putPackedString(std::ostream& out, const std::string& s) {
    putVarint(out, s.size());
    std::uint32_t acc = 0;
    int nbits = 0;
    for (char ch : s) {
        const int code = codeOf(ch);
        if (code < 0)
            throw std::runtime_error(
                std::string("savefile: character '") + ch +
                "' is outside the 5-bit alphabet -- this position has more than 20 membranes in "
                "one component and cannot be saved");
        acc |= static_cast<std::uint32_t>(code) << nbits;
        nbits += 5;
        while (nbits >= 8) {
            out.put(static_cast<char>(acc & 0xFF));
            acc >>= 8;
            nbits -= 8;
        }
    }
    if (nbits > 0)
        out.put(static_cast<char>(acc & 0xFF));
}

std::string getPackedString(std::istream& in) {
    const std::uint64_t len = getVarint(in);
    std::string s;
    s.reserve(static_cast<std::size_t>(len));
    std::uint32_t acc = 0;
    int nbits = 0;
    for (std::uint64_t i = 0; i < len; ++i) {
        while (nbits < 5) {
            acc |= static_cast<std::uint32_t>(getByte(in)) << nbits;
            nbits += 8;
        }
        s.push_back(charOf(static_cast<int>(acc & 0x1F)));
        acc >>= 5;
        nbits -= 5;
    }
    return s;
}

// Total lives of a stored minimal node, from its encoding (parsed once per node at save time).
// Used only to order nodes; the exact value is irrelevant, only that a child's is strictly smaller.
int livesOf(const std::string& enc) { return parsePosition(enc).lives2(); }

// The minimal-node component list a child edge points at: the child itself if it is minimal, or the
// child's subposition parts if it is a sum. Every returned node is a stored (minimal) node.
std::vector<const Node*> childComponents(const Node* child) {
    if (child->isSum())
        return {child->subpositions.begin(), child->subpositions.end()};
    return {child};
}

// The minimal (single-subposition) nodes reachable from `root` via child + subposition links.
// Every component a stored edge references is itself reachable (children of a reachable node, and a
// sum child's subpositions, are all followed), so the returned set is closed under edge references.
std::vector<const Node*> reachableMinimal(const Node* root) {
    std::vector<const Node*> out;
    std::unordered_set<const Node*> seen;
    std::vector<const Node*> stack{root};
    seen.insert(root);
    while (!stack.empty()) {
        const Node* n = stack.back();
        stack.pop_back();
        if (!n->isSum())
            out.push_back(n);
        for (const Node* c : n->children)
            if (seen.insert(c).second)
                stack.push_back(c);
        for (const Node* s : n->subpositions)
            if (seen.insert(s).second)
                stack.push_back(s);
    }
    return out;
}

// Write a set of minimal nodes (and their edges) as a complete .sprout stream. `mins` must be closed
// under edge references -- every component of every edge is itself in `mins` -- which holds both for
// a whole graph's minimal nodes and for the reachable-from-a-root subset.
std::size_t writeMinimal(const GameGraph& g, std::vector<const Node*> mins, std::ostream& out) {
    // Order by ascending lives, so every child -- always strictly fewer lives -- precedes its
    // parents. Tie-break on the encoding purely for a reproducible byte stream (ties never sit on an
    // edge, so any order is a valid topo order).
    std::vector<int> lives(mins.size());
    for (std::size_t i = 0; i < mins.size(); ++i)
        lives[i] = livesOf(mins[i]->enc);

    std::vector<std::size_t> order(mins.size());
    for (std::size_t i = 0; i < order.size(); ++i)
        order[i] = i;
    std::sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) {
        if (lives[a] != lives[b])
            return lives[a] < lives[b];
        return mins[a]->enc < mins[b]->enc;
    });

    std::unordered_map<const Node*, std::size_t> indexOf;
    indexOf.reserve(mins.size() * 2);
    for (std::size_t rank = 0; rank < order.size(); ++rank)
        indexOf.emplace(mins[order[rank]], rank);

    const bool quick = (g.mode() == GameGraph::Mode::Quick);

    out.write(kMagic, sizeof(kMagic));
    putByte(out, kVersion);
    putByte(out, quick ? 1 : 0);
    putVarint(out, mins.size());

    for (std::size_t rank = 0; rank < order.size(); ++rank) {
        const Node* n = mins[order[rank]];
        putPackedString(out, n->enc);
        putVarint(out, n->children.size());
        for (std::size_t c = 0; c < n->children.size(); ++c) {
            const std::vector<const Node*> comps = childComponents(n->children[c]);
            // Edge descriptor, parity-tagged so the common single-component child needs no separate
            // count byte: even value = one component, holding (delta << 1); odd value = a sum child,
            // holding (compCount << 1 | 1) followed by compCount deltas. A sum always has >= 2 parts,
            // so an odd descriptor never collides with a (>= 2, even) single-child delta.
            if (comps.size() == 1) {
                const std::size_t ci = indexOf.at(comps[0]);  // < rank (strictly fewer lives)
                putVarint(out, (rank - ci) << 1);
            } else {
                putVarint(out, (comps.size() << 1) | 1);
                for (const Node* comp : comps)
                    putVarint(out, rank - indexOf.at(comp));
            }
            if (quick)
                putByte(out, static_cast<std::uint8_t>(n->childOffset(c) & 1));
        }
    }
    return mins.size();
}

}  // namespace

std::size_t saveGraph(const GameGraph& g, std::ostream& out) {
    std::vector<const Node*> mins;
    for (const Node& n : g.nodes())
        if (!n.isSum())
            mins.push_back(&n);
    return writeMinimal(g, std::move(mins), out);
}

std::size_t saveSubgraph(const GameGraph& g, const Node* root, std::ostream& out) {
    return writeMinimal(g, reachableMinimal(root), out);
}

std::size_t saveGraphToFile(const GameGraph& g, const std::string& path) {
    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("savefile: cannot open '" + path + "' for writing");
    return saveGraph(g, out);
}

std::size_t saveSubgraphToFile(const GameGraph& g, const Node* root, const std::string& path) {
    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("savefile: cannot open '" + path + "' for writing");
    return saveSubgraph(g, root, out);
}

SolvedDB loadGraph(std::istream& in) {
    char magic[4];
    if (!in.read(magic, sizeof(magic)) || std::memcmp(magic, kMagic, sizeof(magic)) != 0)
        throw std::runtime_error("savefile: bad magic");
    const std::uint8_t version = getByte(in);
    if (version != kVersion)
        throw std::runtime_error("savefile: unsupported version");
    const std::uint8_t modeByte = getByte(in);
    const bool quick = (modeByte == 1);

    SolvedDB db;
    db.mode_ = quick ? GameGraph::Mode::Quick : GameGraph::Mode::Exact;

    const std::uint64_t count = getVarint(in);
    db.encs_.reserve(static_cast<std::size_t>(count));
    db.vals_.reserve(static_cast<std::size_t>(count));
    db.index_.reserve(static_cast<std::size_t>(count) * 2);

    for (std::uint64_t i = 0; i < count; ++i) {
        std::string enc = getPackedString(in);
        const std::uint64_t childCount = getVarint(in);

        // Recompute this node's value from its edges: mex over child nimbers, 1 + best move bounds.
        std::set<int> vals;
        int minChild = 0, maxChild = 0;
        bool haveChild = false;
        auto applyDelta = [&](std::uint64_t delta, int& nim, int& mn, int& mx) {
            if (delta == 0 || delta > i)
                throw std::runtime_error("savefile: child index out of range");
            const SolvedDB::Value& cv = db.vals_[static_cast<std::size_t>(i - delta)];
            nim ^= cv.nimber;
            mn += cv.minMoves;
            mx += cv.maxMoves;
        };
        for (std::uint64_t c = 0; c < childCount; ++c) {
            // Parity-tagged edge descriptor (see the writer): even => one component whose delta is
            // desc >> 1; odd => a sum child of (desc >> 1) components, each a following delta varint.
            const std::uint64_t desc = getVarint(in);
            int nim = 0, mn = 0, mx = 0;  // the child value: XOR nimbers, sum move bounds
            if ((desc & 1) == 0) {
                applyDelta(desc >> 1, nim, mn, mx);
            } else {
                const std::uint64_t compCount = desc >> 1;
                for (std::uint64_t k = 0; k < compCount; ++k)
                    applyDelta(getVarint(in), nim, mn, mx);
            }
            if (quick)
                nim ^= (getByte(in) & 1);
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

        SolvedDB::Value v;
        if (haveChild) {
            int m = 0;
            while (vals.count(m))
                ++m;
            v.nimber = m;
            v.minMoves = 1 + minChild;
            v.maxMoves = 1 + maxChild;
        }  // else terminal: 0/0/0

        db.index_.emplace(enc, static_cast<std::size_t>(i));
        db.encs_.push_back(std::move(enc));
        db.vals_.push_back(v);
    }
    return db;
}

SolvedDB loadGraphFromFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in)
        throw std::runtime_error("savefile: cannot open '" + path + "' for reading");
    return loadGraph(in);
}

const SolvedDB::Value* SolvedDB::findMinimal(const std::string& enc) const {
    const auto it = index_.find(enc);
    return it == index_.end() ? nullptr : &vals_[it->second];
}

bool SolvedDB::value(const Position& p, Value& out, int* offsetOut) const {
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

    Value acc;
    for (const Component& comp : rep.components) {
        Position one;
        one.components.push_back(comp);
        const Value* v = findMinimal(serialize(one));
        if (!v)
            return false;
        acc.nimber ^= v->nimber;
        acc.minMoves += v->minMoves;
        acc.maxMoves += v->maxMoves;
    }
    out = acc;
    return true;
}

}  // namespace stalks
