#include "analyze.hpp"

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "json_util.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <cstddef>
#include <optional>
#include <set>
#include <string>
#include <unordered_set>
#include <vector>

namespace stalks {

namespace {

// --- tiny hand-rolled JSON writer (jsonStr is shared, see json_util.hpp) ---

void jsonInt(std::string& out, long long v) { out += std::to_string(v); }

// Number of minimal subpositions of a canonical position (its component count).
int subposCount(const Position& p) { return static_cast<int>(p.components.size()); }

int subposCount(const Node* n) {
    return n->isSum() ? static_cast<int>(n->subpositions.size()) : 1;
}

struct Val {
    int nimber = 0;
    int minMoves = 0;
    int maxMoves = 0;
};

// Sentinel for "not yet computed" -- real nimber/minMoves/maxMoves are always >= 0, so -1 is
// unambiguous. Mirrors Node's placeholder sentinel (see graph.hpp); the frontend renders it as "?".
constexpr Val kUnknownVal{-1, -1, -1};

void writeQuickCanon(std::string& out, const QuickCanonResult& qc) {
    out += "{\"enc\":";
    jsonStr(out, serialize(qc.rep));
    out += ",\"offset\":";
    jsonInt(out, qc.offset);
    out += "}";
}

// Value an arbitrary canonical position by combining its minimal-subposition node values (XOR for
// the nimber, sum for the move bounds). Every minimal subposition reachable in the subtree is a
// node in `g` (build() creates a node for each subposition of every sum it encounters), so a
// play-child of a sum root -- which is never itself a node -- is still valued from its parts.
Val valueOf(const GameGraph& g, const Position& q) {
    Val v;
    for (const auto& comp : q.components) {
        Position one;
        one.components.push_back(comp);
        const Node* n = g.find(serialize(one));
        if (!n)
            continue;  // defensive: should not happen for reachable children
        v.nimber ^= n->nimber;
        v.minMoves += n->minMoves;
        v.maxMoves += n->maxMoves;
    }
    return v;
}

// {"enc":..,"nimber":..,"subposCount":..,"minMoves":..,"maxMoves":..,"move":{...}[,"quickCanon":..]}
// `move` identifies which move on the parent reaches this child: kind, the component it was
// applied to, the region, and either boundary/i/j/mask (enclosure) or b1/b2/i/j (join). `v` is
// kUnknownVal (-1 sentinel fields) when the child hasn't been valued -- too expensive to value
// every child of an oversized position; the frontend renders -1 as "?". `quick`, when non-null, is
// the child's own quick-canon representative (only populated where a caller needs it per-child).
void writeChild(std::string& out, const std::string& enc, const Val& v, int nsub,
                const MoveTag* tag = nullptr, const QuickCanonResult* quick = nullptr) {
    out += "{\"enc\":";
    jsonStr(out, enc);
    out += ",\"nimber\":";
    jsonInt(out, v.nimber);
    out += ",\"subposCount\":";
    jsonInt(out, nsub);
    out += ",\"minMoves\":";
    jsonInt(out, v.minMoves);
    out += ",\"maxMoves\":";
    jsonInt(out, v.maxMoves);
    if (tag) {
        out += ",\"move\":{\"kind\":";
        jsonInt(out, static_cast<int>(tag->kind));
        out += ",\"component\":";
        jsonInt(out, static_cast<int>(tag->component));
        out += ",\"region\":";
        jsonInt(out, static_cast<int>(tag->region));
        out += ",\"boundary\":";
        jsonInt(out, static_cast<int>(tag->boundary));
        out += ",\"mask\":";
        jsonInt(out, static_cast<int>(tag->mask));
        out += ",\"b1\":";
        jsonInt(out, static_cast<int>(tag->b1));
        out += ",\"b2\":";
        jsonInt(out, static_cast<int>(tag->b2));
        out += ",\"i\":";
        jsonInt(out, tag->i);
        out += ",\"j\":";
        jsonInt(out, tag->j);
        out += "}";
    }
    if (quick) {
        out += ",\"quickCanon\":";
        writeQuickCanon(out, *quick);
    }
    out += "}";
}

// Size gates, in half-lives (lives2). <= AUTO: analyzed automatically on open. AUTO < .. <= MAX:
// analyzed only on demand (the Calculate buttons). > MAX: not supported.
constexpr int kAutoLives2 = 20;  // 10 lives
constexpr int kMaxLives2 = 32;   // 16 lives

// Above MAX, we still enumerate immediate children cheaply (unvaluedChildren). This used to grow
// factorially with the number of interchangeable "other" boundaries in a region (bare SPOT/SCAB/
// HOLL-style boundaries with no membrane/joint identity) -- both in canonicalize() itself
// (groupedPermutations, canon.cpp) and in enclosure move generation (the mask distributing those
// others between an enclosure's two new regions, moves.cpp's enclosureMasks) -- e.g. a fresh
// n-isolated-spot position took ~11s to enumerate at n=9 and OOM'd the WASM runtime at n=10. Both
// are now fixed to collapse interchangeable boundaries/masks to one representative instead of
// enumerating every permutation/subset (exact, not approximate -- see the comments there), which
// turned that same n=9 case into <20ms and pushed the practical limit past the app's own 20-spot
// game-start cap (n=20 isolated spots: ~150ms; the encoding format's own 32-boundary-per-region
// limit throws a clean error well before this cap would matter again). Kept as a generous safety
// net rather than removed outright, in case some other position shape turns out to still be
// expensive in a way the isolated-spot benchmark didn't exercise.
constexpr int kChildrenLives2Cap = 200;  // 100 lives

int maxSubLives2(const Position& p) {
    int m = 0;
    for (const auto& comp : p.components)
        m = std::max(m, comp.lives2());
    return m;
}

// Whether every minimal subposition of `p` already has a node in `g`. When true, reporting `p`
// costs nothing regardless of its size -- a prior analysis already built its parts (e.g. it's a
// child of a position whose game tree was already computed), so the size gate would otherwise
// wrongly hide data that's already sitting in the graph.
bool allComponentsKnown(const GameGraph& g, const Position& p) {
    for (const auto& comp : p.components) {
        Position one;
        one.components.push_back(comp);
        const Node* n = g.find(serialize(one));
        // A placeholder is cheap to have around (see placeholderFor) -- it doesn't mean the cost
        // of a full valuation has actually been paid, so it must not count as "known" here.
        if (!n || n->placeholder)
            return false;
    }
    return true;
}

// Persistent, module-lifetime graphs. They accumulate nodes across analysis calls so a subtree
// built for one position is reused (never recomputed) when a later position reaches it. Separate
// graphs per identity mode: exact structural canon vs quick-canon.
GameGraph& exactGraph() {
    static GameGraph g(GameGraph::Mode::Exact);
    return g;
}
GameGraph& quickGraph() {
    static GameGraph g(GameGraph::Mode::Quick);
    return g;
}

// Nodes reachable from `root` via child + subposition links. Because the graphs are now persistent
// (they hold every position ever analyzed), graphMeta must be scoped to this position's own subtree
// rather than dumping the whole accumulated node set. For a subtree freshly built by ensure() this
// is exactly the set a fresh single-root graph would have contained.
std::vector<const Node*> reachable(const Node* root) {
    std::vector<const Node*> out;
    std::unordered_set<const Node*> seen;
    std::vector<const Node*> stack{root};
    seen.insert(root);
    while (!stack.empty()) {
        const Node* n = stack.back();
        stack.pop_back();
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

// {"ok":false,"reason":..,"canon":..,"maxLives2":..[,"quickCanon":..][,"children":[...]]}
// `childrenJson`, when non-null, is a pre-built JSON array literal (see unvaluedChildren) of the
// position's immediate play-children -- cheap to enumerate even when the position is too large to
// fully value, so callers can still show what moves are available.
std::string sizeError(const char* reason, const std::string& canon, int maxLives2,
                      const QuickCanonResult* quick, const std::string* childrenJson = nullptr) {
    std::string out = "{\"ok\":false,\"reason\":\"";
    out += reason;
    out += "\",\"canon\":";
    jsonStr(out, canon);
    out += ",\"maxLives2\":";
    jsonInt(out, maxLives2);
    if (quick) {
        out += ",\"quickCanon\":";
        writeQuickCanon(out, *quick);
    }
    if (childrenJson) {
        out += ",\"children\":";
        out += *childrenJson;
    }
    out += "}";
    return out;
}

// The immediate play-children of `p`: canonical enc + subposCount + move + the child's own
// quick-canon representative, but not valued -- nimber/minMoves/maxMoves come back as the -1
// sentinel (kUnknownVal), since valuing requires building each child's own subtree, exactly what's
// too expensive for an oversized position. Each child is registered as a placeholder node in the
// persistent exact graph (see GameGraph::placeholderFor) so that if a later full analysis reaches
// the same position, build() re-expands it for real instead of trusting the -1 sentinel.
//
// Returns nullopt (rather than a JSON array literal) if even this cheap enumeration would be too
// expensive -- see kChildrenLives2Cap.
std::optional<std::string> unvaluedChildren(const Position& p) {
    if (maxSubLives2(p) > kChildrenLives2Cap)
        return std::nullopt;
    std::string out = "[";
    bool first = true;
    for (const auto& [kid, tag] : childrenAllWithMoveTag(p)) {
        exactGraph().placeholderFor(kid);
        const QuickCanonResult qc = quickCanon(kid);
        if (!first)
            out += ',';
        first = false;
        writeChild(out, serialize(kid), kUnknownVal, subposCount(kid), &tag, &qc);
    }
    out += "]";
    return out;
}

// The shared full (exact) analysis body: everything analyzeJson's ok result contains. Uses the
// persistent exact graph so shared subtrees are computed once across the whole session.
std::string fullAnalysis(const Position& p, const std::string& canon) {
    Node* root = exactGraph().ensure(p);
    const GameGraph& g = exactGraph();

    std::string out;
    out += "{\"ok\":true,\"canon\":";
    jsonStr(out, canon);
    out += ",\"nimber\":";
    jsonInt(out, root->nimber);
    out += ",\"minMoves\":";
    jsonInt(out, root->minMoves);
    out += ",\"maxMoves\":";
    jsonInt(out, root->maxMoves);
    out += ",\"subposCount\":";
    jsonInt(out, subposCount(root));

    // Per-subposition nimber breakdown, in canon (component) order.
    out += ",\"nimberBreakdown\":[";
    if (root->isSum()) {
        for (std::size_t i = 0; i < root->subpositions.size(); ++i) {
            if (i)
                out += ',';
            jsonInt(out, root->subpositions[i]->nimber);
        }
    } else {
        jsonInt(out, root->nimber);
    }
    out += "]";

    // Play-children of the whole position (works for sum roots too, whose node has no children).
    out += ",\"children\":[";
    {
        bool first = true;
        for (const auto& [kid, tag] : childrenAllWithMoveTag(p)) {
            if (!first)
                out += ',';
            first = false;
            const Val v = valueOf(g, kid);
            writeChild(out, serialize(kid), v, subposCount(kid), &tag);
        }
    }
    out += "]";

    // Quick-canon (Advanced Collections) view of the whole position.
    out += ",\"quickCanon\":";
    writeQuickCanon(out, quickCanon(p));

    // Quick-canon children: each play-child reduced by quickCanon, deduped by (rep, offset).
    out += ",\"quickChildren\":[";
    {
        std::set<std::string> seen;
        bool first = true;
        for (const auto& kid : childrenAll(p)) {
            const QuickCanonResult qk = quickCanon(kid);
            const std::string enc = serialize(qk.rep);
            if (!seen.insert(enc + '|' + std::to_string(qk.offset)).second)
                continue;
            const Val v = valueOf(g, kid);
            if (!first)
                out += ',';
            first = false;
            out += "{\"enc\":";
            jsonStr(out, enc);
            out += ",\"offset\":";
            jsonInt(out, qk.offset);
            out += ",\"nimber\":";
            jsonInt(out, v.nimber);
            out += ",\"subposCount\":";
            jsonInt(out, static_cast<int>(qk.rep.components.size()));
            out += "}";
        }
    }
    out += "]";

    // Every node in this position's subtree: metadata + minimal-subposition child edges.
    out += ",\"graphMeta\":[";
    {
        bool first = true;
        for (const Node* n : reachable(root)) {
            if (!first)
                out += ',';
            first = false;
            out += "{\"enc\":";
            jsonStr(out, n->enc);
            out += ",\"nimber\":";
            jsonInt(out, n->nimber);
            out += ",\"minMoves\":";
            jsonInt(out, n->minMoves);
            out += ",\"maxMoves\":";
            jsonInt(out, n->maxMoves);
            out += ",\"subposCount\":";
            jsonInt(out, subposCount(n));
            out += ",\"children\":[";
            for (std::size_t i = 0; i < n->children.size(); ++i) {
                if (i)
                    out += ',';
                jsonStr(out, n->children[i]->enc);
            }
            out += "]}";
        }
    }
    out += "]}";
    return out;
}

// Quick-canon nimber analysis: the true Grundy value via the (small) quick-canon graph, the
// quick-canon representative, and the deduped quick-canon children with their true nimbers.
std::string quickAnalysis(const Position& p, const std::string& canon) {
    GameGraph& g = quickGraph();
    int rootOff = 0;
    const Node* root = g.ensure(p, &rootOff);
    const int nimber = root->nimber ^ rootOff;
    const QuickCanonResult qc = quickCanon(p);

    std::string out;
    out += "{\"ok\":true,\"reason\":\"quick\",\"canon\":";
    jsonStr(out, canon);
    out += ",\"nimber\":";
    jsonInt(out, nimber);
    out += ",\"quickCanon\":";
    writeQuickCanon(out, qc);

    out += ",\"quickChildren\":[";
    {
        std::set<std::string> seen;
        bool first = true;
        for (const auto& kid : childrenAll(p)) {
            const QuickCanonResult qk = quickCanon(kid);
            const std::string enc = serialize(qk.rep);
            if (!seen.insert(enc + '|' + std::to_string(qk.offset)).second)
                continue;
            int off = 0;
            const Node* kn = g.ensure(kid, &off);
            if (!first)
                out += ',';
            first = false;
            out += "{\"enc\":";
            jsonStr(out, enc);
            out += ",\"offset\":";
            jsonInt(out, qk.offset);
            out += ",\"nimber\":";
            jsonInt(out, kn->nimber ^ off);  // true game value of the child
            out += ",\"subposCount\":";
            jsonInt(out, static_cast<int>(qk.rep.components.size()));
            out += "}";
        }
    }
    out += "]}";
    return out;
}

}  // namespace

std::string canonOnly(const std::string& enc) {
    return serialize(canonicalize(parsePosition(enc)));
}

std::string decompressedJson(const std::string& enc) {
    try {
        std::string out = "{\"ok\":true,\"enc\":";
        jsonStr(out, serialize(parsePosition(enc).decompressed()));
        out += "}";
        return out;
    } catch (const EncodingError& e) {
        std::string err = "{\"ok\":false,\"reason\":\"parse-error\",\"message\":";
        jsonStr(err, e.what());
        err += "}";
        return err;
    }
}

std::string childrenTrackedJson(const std::string& enc) {
    try {
        const Position p = parsePosition(enc);
        if (maxSubLives2(p) > kMaxLives2) {
            std::string err = "{\"ok\":false,\"reason\":\"too-large\"}";
            return err;
        }
        // ensure() builds (and values) the full subtree rooted at p's canonical form -- cheap at
        // this size (see the kMaxLives2 gate above) and exactly what real nimbers here need, since
        // valueOf only finds a position that's already a built node. Matches fullAnalysis's own
        // pattern; the persistent exactGraph means a position reached from multiple callers (e.g.
        // the same T-child explored by more than one DisaPoint) is only ever built once.
        exactGraph().ensure(p);
        const GameGraph& g = exactGraph();
        std::string out = "{\"ok\":true,\"children\":[";
        bool first = true;
        for (const auto& [kid, tag] : childrenAllWithMoveTag(p)) {
            if (!first)
                out += ',';
            first = false;
            const Val v = valueOf(g, kid);
            writeChild(out, serialize(kid), v, subposCount(kid), &tag);
        }
        out += "]}";
        return out;
    } catch (const EncodingError& e) {
        std::string err = "{\"ok\":false,\"reason\":\"parse-error\",\"message\":";
        jsonStr(err, e.what());
        err += "}";
        return err;
    }
}

std::string regionMovesTrackedJson(const std::string& enc, int component, int region, int boundary, int token) {
    try {
        const Position p = parsePosition(enc);
        if (component < 0 || static_cast<std::size_t>(component) >= p.components.size()) {
            return "{\"ok\":false,\"reason\":\"bad-move\",\"message\":\"component index out of range\"}";
        }
        if (maxSubLives2(p) > kMaxLives2) {
            return "{\"ok\":false,\"reason\":\"too-large\"}";
        }
        exactGraph().ensure(p);  // see childrenTrackedJson -- same valuing rationale
        const GameGraph& g = exactGraph();
        // enclosureMoves/joinMoves refuse to run at all if ANY boundary of the component still holds
        // a compressed pseudo-point (3/4/5/6) ANYWHERE in it -- not just in the target's own boundary
        // -- so a Hollow/Split/Triplet organ elsewhere in the SAME component as the DisaPoint (`enc`
        // is `analyze().canon`, which can legitimately still contain one -- see collectGenetics.ts's
        // corrected note on this) silently made this whole function throw "decompress pseudo-points
        // before generating moves", which computeLReachable's caller then swallowed into an empty L
        // set. Mirror childrenAllWithMoveTag's own fix for the exact same class of bug: decompress
        // before enumerating/applying moves. Component count and (for any region/boundary that isn't
        // itself the one being expanded) region/boundary/token indices are unchanged by decompression
        // (interior regions are only ever APPENDED after existing ones) -- ensure()/valuing above
        // intentionally still uses the original `p`, matching every sibling function's pattern.
        const Position d = p.decompressed();
        const Component& c = d.components[static_cast<std::size_t>(component)];

        std::string out = "{\"ok\":true,\"children\":[";
        bool first = true;
        auto emit = [&](Position&& raw, const MoveTag& tag) {
            Position child = canonicalize(raw);
            child.validate();
            const Val v = valueOf(g, child);
            if (!first)
                out += ',';
            first = false;
            writeChild(out, serialize(child), v, subposCount(child), &tag);
        };

        // enclosureMoves/joinMoves enumerate every legal move of the WHOLE component; filter down to
        // the ones that touch (region, boundary, token) -- i.e. target's own DisaPoint occurrence.
        // This is the ground-truth counterpart to the TS side's old "transplant a move the engine's
        // own (deduped) children list happened to keep, and hope the boundary indices line up"
        // approach, which silently missed an L-move whenever its result coincided with a
        // differently-shaped-but-isomorphic move elsewhere in the position (the engine's children
        // dedup keeps only the first-generated MoveTag for a given canonical result) -- e.g. joining
        // a DisaPoint straight to a scab in its own region can land on the exact same position as
        // self-enclosing its detached-pair region, and only one of those two MoveTags survives dedup.
        // Enumerating directly here needs no such correspondence: every move that structurally
        // touches the target token is included, however its resulting position happens to compare to
        // anything else.
        for (const auto& mv : enclosureMoves(c)) {
            if (static_cast<int>(mv.region) != region || static_cast<int>(mv.boundary) != boundary)
                continue;
            if (mv.i != token && mv.j != token)
                continue;
            emit(applyEnclosure(d, static_cast<std::size_t>(component), mv),
                 MoveTag{MoveKind::Enclosure, static_cast<std::size_t>(component), mv.region, mv.boundary,
                         mv.mask, 0, 0, mv.i, mv.j});
        }
        for (const auto& mv : joinMoves(c)) {
            if (static_cast<int>(mv.region) != region)
                continue;
            const bool touches = (static_cast<int>(mv.b1) == boundary && mv.i == token) ||
                                  (static_cast<int>(mv.b2) == boundary && mv.j == token);
            if (!touches)
                continue;
            emit(applyJoin(d, static_cast<std::size_t>(component), mv),
                 MoveTag{MoveKind::Join, static_cast<std::size_t>(component), mv.region, 0, 0, mv.b1, mv.b2,
                         mv.i, mv.j});
        }

        out += "]}";
        return out;
    } catch (const EncodingError& e) {
        std::string err = "{\"ok\":false,\"reason\":\"engine-error\",\"message\":";
        jsonStr(err, e.what());
        err += "}";
        return err;
    }
}

std::string allMovesTrackedJson(const std::string& enc) {
    try {
        const Position p = parsePosition(enc);
        if (maxSubLives2(p) > kMaxLives2) {
            return "{\"ok\":false,\"reason\":\"too-large\"}";
        }
        exactGraph().ensure(p);
        const GameGraph& g = exactGraph();

        std::string out = "{\"ok\":true,\"children\":[";
        bool first = true;
        auto emit = [&](Position&& raw, const MoveTag& tag) {
            Position child = canonicalize(raw);
            child.validate();
            const Val v = valueOf(g, child);
            if (!first)
                out += ',';
            first = false;
            writeChild(out, serialize(child), v, subposCount(child), &tag);
        };

        // Every legal Enclosure/Join move of every (non-dead) component, with NO dedup by canonical
        // result -- unlike childrenTrackedJson/childrenAllWithMoveTag's `seen.insert(serialize(child))`,
        // which keeps only the first MoveTag reaching any given canonical child. That dedup is correct
        // for "list the children of this position" but wrong for retracing a SPECIFIC tracked token's
        // provenance through a grandchild move: when two moves are canonically identical because of a
        // genuine structural symmetry (e.g. two isomorphic detached-pair regions, each self-enclosable
        // to the same canonical result), only one of the two keeps a MoveTag, and if that one doesn't
        // happen to be the move that preserves the caller's tracked token, provenance-based bypass
        // detection sees "target not found" and wrongly reports no match -- even though the OTHER
        // (deduped-away) move would have preserved it and, by the same symmetry, matches just as well.
        // See collectGenetics.ts's analyzeTEntry, the caller this exists for (the Grandparent Bypass
        // grandchild retrace).
        //
        // Decompress before enumerating, same fix and same reason as regionMovesTrackedJson just
        // above: enclosureMoves/joinMoves throw outright if ANY boundary of the component still holds
        // a compressed pseudo-point. The caller (analyzeTEntry) is documented to always pass an
        // already-decompressed `enc`, so this is normally a no-op, but doing it unconditionally here
        // too costs nothing and removes the same latent failure mode for good.
        const Position d = p.decompressed();
        for (std::size_t k = 0; k < d.components.size(); ++k) {
            if (d.components[k].dead)
                continue;
            const Component& c = d.components[k];
            for (const auto& mv : enclosureMoves(c))
                emit(applyEnclosure(d, k, mv),
                     MoveTag{MoveKind::Enclosure, k, mv.region, mv.boundary, mv.mask, 0, 0, mv.i, mv.j});
            for (const auto& mv : joinMoves(c))
                emit(applyJoin(d, k, mv),
                     MoveTag{MoveKind::Join, k, mv.region, 0, 0, mv.b1, mv.b2, mv.i, mv.j});
        }

        out += "]}";
        return out;
    } catch (const EncodingError& e) {
        std::string err = "{\"ok\":false,\"reason\":\"engine-error\",\"message\":";
        jsonStr(err, e.what());
        err += "}";
        return err;
    }
}

namespace {

// Parse + canonicalize, capturing a parse error as the shared JSON error string. On success returns
// true and fills p/canon/maxLives2; on failure returns false and fills `err`.
bool prepare(const std::string& enc, Position& p, std::string& canon, int& maxLives2,
             std::string& err) {
    try {
        p = canonicalize(parsePosition(enc));
    } catch (const EncodingError& e) {
        err = "{\"ok\":false,\"reason\":\"parse-error\",\"message\":";
        jsonStr(err, e.what());
        err += "}";
        return false;
    }
    canon = serialize(p);
    maxLives2 = maxSubLives2(p);
    return true;
}

}  // namespace

std::string analyzeJson(const std::string& enc) {
    Position p;
    std::string canon, err;
    int maxLives2 = 0;
    if (!prepare(enc, p, canon, maxLives2, err))
        return err;

    if (!allComponentsKnown(exactGraph(), p)) {
        if (maxLives2 > kMaxLives2) {
            const std::optional<std::string> children = unvaluedChildren(p);
            return sizeError("too-large", canon, maxLives2, nullptr, children ? &*children : nullptr);
        }
        if (maxLives2 > kAutoLives2) {
            // 13-16 lives: not analyzed automatically. Offer the Calculate buttons; include the
            // cheap quick-canon representative plus cheap unvalued children so the browser can
            // show available moves immediately, without waiting on a manual Calculate click.
            const QuickCanonResult qc = quickCanon(p);
            const std::optional<std::string> children = unvaluedChildren(p);
            return sizeError("needs-calculation", canon, maxLives2, &qc, children ? &*children : nullptr);
        }
    }
    return fullAnalysis(p, canon);
}

std::string analyzeFullJson(const std::string& enc) {
    Position p;
    std::string canon, err;
    int maxLives2 = 0;
    if (!prepare(enc, p, canon, maxLives2, err))
        return err;

    if (maxLives2 > kMaxLives2 && !allComponentsKnown(exactGraph(), p)) {
        const std::optional<std::string> children = unvaluedChildren(p);
        return sizeError("too-large", canon, maxLives2, nullptr, children ? &*children : nullptr);
    }
    return fullAnalysis(p, canon);
}

std::string analyzeNimberJson(const std::string& enc) {
    Position p;
    std::string canon, err;
    int maxLives2 = 0;
    if (!prepare(enc, p, canon, maxLives2, err))
        return err;

    if (maxLives2 > kMaxLives2 && !allComponentsKnown(quickGraph(), p)) {
        const std::optional<std::string> children = unvaluedChildren(p);
        return sizeError("too-large", canon, maxLives2, nullptr, children ? &*children : nullptr);
    }
    return quickAnalysis(p, canon);
}

}  // namespace stalks
