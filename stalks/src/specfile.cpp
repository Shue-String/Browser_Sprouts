#include "specfile.hpp"

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "moves.hpp"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <map>
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

// --- 6-bit packed alphabet ---
//
// Widens .sprout's 5-bit alphabet (32 codes: digits/|/,/A-T -- already full) to 6 bits (64 codes),
// per explicit user decision: this format will never need more than 22 membrane letters (A-V) or
// more than 4 distinct special-point symbols in one component, so the freed-up capacity is spent as
// digits(10) + '|' + ',' (2) + A-V (22 membranes) + 4 dedicated special-point codes (conceptually
// "W,X,Y,Z", the last 4 letters of the alphabet) = 38 of the 64 available codes, comfortably inside
// one byte's worth of headroom (26 spare codes) without needing a 7th bit.
constexpr int kMaxMembranes = 22;       // A-V
constexpr int kMaxSpecialPacked = 4;    // this format's own cap (tighter than tokens.hpp's general
                                         // MAX_SPECIAL_POINTS=10) -- a 5th+ symbol is rejected below

// Char -> 6-bit code, or -1 if outside the packable alphabet (including a 5th+ special-point symbol
// or a 23rd+ membrane letter -- both explicitly out of scope for this format, see kMax* above).
int codeOf(char ch) {
    if (ch >= '0' && ch <= '9')
        return ch - '0';
    if (ch == '|')
        return 10;
    if (ch == ',')
        return 11;
    if (ch >= 'A' && ch < 'A' + kMaxMembranes)
        return 12 + (ch - 'A');
    if (ch >= 'a' && ch < 'a' + kMaxSpecialPacked)
        return 12 + kMaxMembranes + (ch - 'a');
    return -1;
}

char charOf(int code) {
    if (code <= 9)
        return static_cast<char>('0' + code);
    if (code == 10)
        return '|';
    if (code == 11)
        return ',';
    if (code < 12 + kMaxMembranes)
        return static_cast<char>('A' + (code - 12));
    return static_cast<char>('a' + (code - 12 - kMaxMembranes));
}

// varint length (in CHARS, not bytes), then the chars packed 6 bits each (little-endian bit order),
// byte-aligned per string. Same shape as savefile.cpp's putPackedString/getPackedString, freshly
// reimplemented at 6 bits -- no shared code path, per the format-separation directive.
void putPackedString(std::ostream& out, const std::string& s) {
    putVarint(out, s.size());
    std::uint32_t acc = 0;
    int nbits = 0;
    for (char ch : s) {
        const int code = codeOf(ch);
        if (code < 0)
            throw std::runtime_error(
                std::string("specfile: character '") + ch +
                "' is outside the 6-bit alphabet -- this position has more than " +
                std::to_string(kMaxMembranes) + " membranes or more than " +
                std::to_string(kMaxSpecialPacked) +
                " distinct special-point symbols in one component and cannot be saved in this format");
        acc |= static_cast<std::uint32_t>(code) << nbits;
        nbits += 6;
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
        while (nbits < 6) {
            acc |= static_cast<std::uint32_t>(getByte(in)) << nbits;
            nbits += 8;
        }
        s.push_back(charOf(static_cast<int>(acc & 0x3F)));
        acc >>= 6;
        nbits -= 6;
    }
    return s;
}

// Count of special-point tokens present in `enc` -- ordering-priority use only (see topoOrderMulti
// below), not a correctness-critical value. Every special point serializes as one lowercase 'a'-'j'
// char (tokenChar(), tokens.hpp), so a direct character scan is exact -- no parsing needed.
int specialCountOf(const std::string& enc) {
    return static_cast<int>(
        std::count_if(enc.begin(), enc.end(), [](char ch) { return ch >= 'a' && ch <= 'j'; }));
}

// The minimal-node component list a child edge points at: the child itself if it is minimal, or the
// child's subposition parts if it is a sum. Every returned node is a stored (minimal) node.
std::vector<const Node*> childComponents(const Node* child) {
    if (child->isSum())
        return {child->subpositions.begin(), child->subpositions.end()};
    return {child};
}

// .sprout's ascending-lives2() ordering ("every move strictly reduces lives, so a child always
// precedes its parent") does NOT hold once special points are involved: lives2() deliberately
// returns 0 for a special-point token in place (Phase 1's locked semantics), but the movetype-2
// transformation ("becomes a scab") replaces it with a token that DOES carry lives2 -- a scab
// occupying its own standalone one-token boundary was empirically found (debug_spec_order.exe on
// "[0,a]") to carry MORE remaining capacity than the special point it replaced, so lives2() can
// flat-out INCREASE across that one edge. Sorting by any numeric proxy derived from the encoding is
// therefore unsound on its own (an earlier plain-DFS-post-order version of this function sidestepped
// the problem instead of solving the underlying ask).
//
// This version keeps the fewest-lives-first SPIRIT while staying provably correct: a priority-driven
// Kahn's algorithm. Correctness comes from the dependency structure itself (a node is only ever
// EMITTED once every node it depends on has already been emitted -- true by definition, regardless
// of what lives2/specialCount do), and "fewest lives first" is applied only as the tie-break for
// CHOOSING among nodes that are currently eligible: at each step, among all nodes whose every
// dependency has already been written, emit the one with the smallest (lives2, specialPointCount,
// enc) key. The graph is guaranteed acyclic (built by graph.cpp's memoized recursion, which only
// terminates because no position is ever its own ancestor), so this always makes full progress.
std::vector<const Node*> topoOrderMulti(const std::vector<const Node*>& roots) {
    // Reachability sweep (child + subposition links), same as before -- collects every minimal node
    // reachable from ANY root, deduped, before any ordering decision is made.
    std::vector<const Node*> allMin;
    std::unordered_set<const Node*> seen;
    {
        std::vector<const Node*> stack(roots.begin(), roots.end());
        for (const Node* r : roots)
            seen.insert(r);
        while (!stack.empty()) {
            const Node* n = stack.back();
            stack.pop_back();
            if (!n->isSum())
                allMin.push_back(n);
            for (const Node* c : n->children)
                if (seen.insert(c).second)
                    stack.push_back(c);
            for (const Node* s : n->subpositions)
                if (seen.insert(s).second)
                    stack.push_back(s);
        }
    }

    // Each minimal node's DISTINCT dependencies (its children's minimal component parts, deduped --
    // Kahn's algorithm only needs to know WHICH nodes block it, not how many edges reference each),
    // plus the reverse map (a dependency -> the nodes waiting on it) used to discover newly-eligible
    // nodes as their blockers get emitted.
    std::unordered_map<const Node*, int> remaining;
    std::unordered_map<const Node*, std::vector<const Node*>> dependents;
    for (const Node* n : allMin) {
        std::unordered_set<const Node*> uniqueDeps;
        for (const Node* c : n->children)
            for (const Node* comp : childComponents(c))
                uniqueDeps.insert(comp);
        remaining[n] = static_cast<int>(uniqueDeps.size());
        for (const Node* d : uniqueDeps)
            dependents[d].push_back(n);
    }

    using Key = std::tuple<int, int, std::string>;  // (lives2, specialCount, enc) -- enc is a final
                                                      // deterministic tiebreak, and already unique.
    auto keyOf = [](const Node* n) {
        return Key{parsePosition(n->enc).lives2(), specialCountOf(n->enc), n->enc};
    };

    std::map<Key, const Node*> ready;  // ordered set-like map; begin() is always the smallest key
    for (const Node* n : allMin)
        if (remaining.at(n) == 0)
            ready.emplace(keyOf(n), n);

    std::vector<const Node*> out;
    out.reserve(allMin.size());
    while (!ready.empty()) {
        const auto it = ready.begin();
        const Node* n = it->second;
        ready.erase(it);
        out.push_back(n);
        const auto depIt = dependents.find(n);
        if (depIt != dependents.end())
            for (const Node* dependent : depIt->second)
                if (--remaining.at(dependent) == 0)
                    ready.emplace(keyOf(dependent), dependent);
    }
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
        putPackedString(out, n->enc);
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
        node.enc = getPackedString(in);
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
