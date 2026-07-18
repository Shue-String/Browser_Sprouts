#define _CRT_SECURE_NO_WARNINGS  // getenv in the diagnostic harnesses below

#include "boundary.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "savefile.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace {

int failures = 0;
int checks = 0;

void report(bool ok, const std::string& what) {
    ++checks;
    if (!ok) {
        ++failures;
        std::cout << "FAIL: " << what << "\n";
    }
}

#define CHECK(cond) report((cond), #cond)

void checkEq(const std::string& got, const std::string& want, const std::string& what) {
    ++checks;
    if (got != want) {
        ++failures;
        std::cout << "FAIL: " << what << "\n  want: " << want << "\n  got:  " << got << "\n";
    }
}

void checkEqInt(long long got, long long want, const std::string& what) {
    ++checks;
    if (got != want) {
        ++failures;
        std::cout << "FAIL: " << what << "  want: " << want << "  got: " << got << "\n";
    }
}

template <typename Fn>
void checkThrows(Fn&& fn, const std::string& what) {
    ++checks;
    try {
        fn();
        ++failures;
        std::cout << "FAIL (no throw): " << what << "\n";
    } catch (const stalks::EncodingError&) {
        // expected
    }
}

stalks::Bnd toBnd(const std::string& digits) {
    stalks::Bnd b;
    for (char ch : digits)
        b.push_back(static_cast<stalks::Token>(ch - '0'));
    return b;
}

std::string fromBnd(const stalks::Bnd& b) {
    std::string s;
    for (stalks::Token t : b)
        s.push_back(static_cast<char>('0' + t));
    return s;
}

// serialize() now emits ASCII ('+' for the nim-sum separator, 'N' for the dead component) and
// NO group brackets -- the '[' ']' carry no information (the parser strips them) and components
// are unambiguously '+'-separated. The tests below were written against the bracketed display
// form, so ser() wraps serialize()'s raw output back in '[' ']' (mirroring the app's display-time
// bracketing). Raw serialize() is exercised directly for the no-bracket invariant in
// testParseSerialize. (The parser still accepts the UTF-8 forms ⊕/φ on input; see the
// backward-compat test.)
const std::string OPLUS = "+";
const std::string PHI = "N";

// Re-add display brackets to serialize() output so the (bracketed) expectations below stay
// readable. A dead component serializes as bare 'N' (no brackets) in both forms.
std::string ser(const stalks::Component& c, bool agnostic = false) {
    std::string s = stalks::serialize(c, agnostic);
    return s == "N" ? s : "[" + s + "]";
}
std::string ser(const stalks::Position& p, bool agnostic = false) {
    std::string out;
    for (std::size_t i = 0; i < p.components.size(); ++i) {
        if (i) out += '+';
        out += ser(p.components[i], agnostic);
    }
    return out;
}

// startEncoding(spots) now lives in graph.hpp/graph.cpp (stalks::startEncoding) — the single
// source for every test and diagnostic harness that needs a fresh game's root.
using stalks::startEncoding;

void testBoundaryOps() {
    using namespace stalks;

    // Canonical rotation of a plain boundary (paper's 99919 example).
    checkEq(fromBnd(canonicalRotation(toBnd("99919"))), "19999", "canonical 99919");

    // Rotation with a joint: rotating re-emits 7/8 in first-seen order.
    checkEq(fromBnd(rotated(toBnd("7182"), 1)), "1728", "rotate 7182 by 1");
    checkEq(fromBnd(rotated(toBnd("7182"), 2)), "7281", "rotate 7182 by 2");
    checkEq(fromBnd(canonicalRotation(toBnd("7182"))), "1728", "canonical 7182");

    // Nested joints survive rotation through the wrap point.
    checkEq(fromBnd(canonicalRotation(toBnd("771882"))), "177288", "canonical 771882");
    for (int s = 0; s < 6; ++s)
        checkEq(fromBnd(canonicalRotation(rotated(toBnd("771882"), s))), "177288",
                "canonical invariant under pre-rotation, shift " + std::to_string(s));

    // Mirroring: a chiral boundary differs from its mirror even after canonicalization.
    const auto b = toBnd("00112");
    checkEq(fromBnd(canonicalRotation(b)), "00112", "canonical 00112");
    checkEq(fromBnd(canonicalRotation(mirrored(b))), "00211", "canonical mirror of 00112");
    CHECK(canonicalRotation(b) != canonicalRotation(mirrored(b)));

    // An achiral boundary equals its mirror.
    const auto sym = toBnd("112");
    CHECK(canonicalRotation(sym) == canonicalRotation(mirrored(sym)));

    // Rotational automorphisms.
    checkEqInt(static_cast<long long>(canonicalShifts(toBnd("1212")).size()), 2,
               "1212 has two canonical shifts");
    checkEqInt(static_cast<long long>(canonicalShifts(toBnd("112")).size()), 1,
               "112 has one canonical shift");

    // Joint validity: nothing between the two visits => distal, must be a scab.
    checkThrows([] { validateJoints(toBnd("78")); }, "78 invalid");
    checkThrows([] { validateJoints(toBnd("7788")); }, "7788 inner joint adjacent, invalid");
    checkThrows([] { validateJoints(toBnd("718")); }, "718 wraps adjacent, invalid");
    validateJoints(toBnd("7182"));  // fine
    checkThrows([] { (void)jointPairs(toBnd("87")); }, "87 unbalanced");
    checkThrows([] { (void)jointPairs(toBnd("717")); }, "717 unbalanced");

    // Body parts via the stacked Dyck path algorithm.
    const auto parts = bodyParts(toBnd("17279828"));
    const std::vector<int> want{0, 1, 1, 2, 2, 2, 1, 1};
    CHECK(parts == want);

    // Doubled lives.
    checkEqInt(lives2(toBnd("0")), 6, "lives2 spot");
    checkEqInt(lives2(toBnd("7182")), 2 + 4 + 2 + 0, "lives2 7182");
}

void testParseSerialize() {
    using namespace stalks;

    // Round trips on strings from the paper (letters already in first-seen order).
    const std::string ex1 = "[17237A828|0,12BC|BC|0,A|177187288]";
    checkEq(ser(parsePosition(ex1)), ex1, "round-trip example position");

    const std::string ex2 = "[177187288]" + OPLUS + "[0,A|0,124,17237A828]";
    checkEq(ser(parsePosition(ex2)), ex2, "round-trip canon example");

    // Raw serialize() emits no group brackets and joins components with '+'.
    CHECK(stalks::serialize(parsePosition("[0,0]")).find('[') == std::string::npos);
    checkEq(stalks::serialize(parsePosition("[0,0]")), "0,0", "raw serialize omits brackets");
    checkEq(stalks::serialize(parsePosition("[0,0]+[1,1]")), "0,0+1,1",
            "raw serialize joins components with + and no brackets");
    checkEq(stalks::serialize(parsePosition("[2,2]+N")), "2,2+N", "raw serialize dead component");

    // Idempotence.
    checkEq(ser(parsePosition(ser(parsePosition(ex1)))),
            ser(parsePosition(ex1)), "serialize idempotent");

    // Membrane-agnostic output, and agnostic input parses fine.
    checkEq(ser(parsePosition(ex1), true),
            "[172379828|0,1299|99|0,9|177187288]", "agnostic serialization");
    checkEq(ser(parsePosition("[172379828|0,1299|99|0,9|177187288]")),
            "[172379828|0,1299|99|0,9|177187288]", "agnostic round-trip");

    // ASCII aliases: '+' for the nim-sum delimiter.
    checkEq(ser(parsePosition("[0,0]+[1,1]")),
            "[0,0]" + OPLUS + "[1,1]", "plus alias for oplus");

    // Dead component.
    checkEq(ser(parsePosition("[0,0]" + OPLUS + PHI)),
            "[0,0]" + OPLUS + PHI, "phi component");
    checkEq(ser(parsePosition("[2,2]+N")), "[2,2]" + OPLUS + PHI, "N alias for phi");

    // Backward compat: the UTF-8 forms ⊕/φ still parse, though serialize now emits ASCII.
    checkEq(ser(parsePosition("[0,0]\xE2\x8A\x95[1,1]")), "[0,0]+[1,1]",
            "UTF-8 oplus still parses");
    checkEq(ser(parsePosition("[2,2]\xE2\x8A\x95\xCF\x86")), "[2,2]+N",
            "UTF-8 phi still parses");

    // Boundary duplication.
    checkEq(ser(parsePosition("[0*3,AB|0*6,AB]")),
            "[0,0,0,AB|0,0,0,0,0,0,AB]", "boundary duplication");
    checkThrows([] { parsePosition("[0A*2|AA]"); }, "duplication with membranes rejected");

    // Letter misuse.
    checkThrows([] { parsePosition("[A|A|A,A]"); }, "letter four times rejected");
    checkThrows([] { parsePosition("[A|0]"); }, "unmatched letter rejected");
    checkThrows([] { parsePosition("[AA|0]"); }, "letter twice in one region rejected");
    checkThrows([] { parsePosition("[0,a]"); }, "lowercase rejected");

    // Joint misuse inside full positions.
    checkThrows([] { parsePosition("[78]"); }, "joint-as-distal rejected");
    checkThrows([] { parsePosition("[0,717]"); }, "unbalanced joints rejected");
}

void testPlanarityRule() {
    using namespace stalks;

    // Two boundaries of one region membrane-connected through another region: invalid.
    checkThrows([] { parsePosition("[A,B|AB]"); }, "[A,B|AB] not planar");

    // The double-membrane pair (old LONELYBOUNDARYPAIR shape) is fine.
    (void)parsePosition("[AB|AB]");

    // A bigger valid position exercises joints + membranes together.
    (void)parsePosition("[17237A828|0,12BC|BC|0,A|177187288]");

    // Distinct body parts on the SAME boundary must not be membrane-connected either.
    // [7A8B|AB]: parts of A and B differ on boundary 0 but connect via region 1.
    checkThrows([] { parsePosition("[7A8B|AB]"); }, "cross-body-part link rejected");
}

void testDecompression() {
    using namespace stalks;

    // Paper example: [13,24] decompresses to [2A|BC|1A,2BC] (region order: interiors
    // appended after the originals).
    const auto p = parsePosition("[13,24]");
    const auto d = p.decompressed();
    d.validate();
    checkEq(ser(d), "[1A,2BC|2A|BC]", "decompress [13,24]");

    // Lives are preserved by decompression.
    checkEqInt(p.lives2(), 14, "lives2 [13,24]");
    checkEqInt(d.lives2(), 14, "lives2 decompressed");

    // Split point and triplet.
    const auto ps = parsePosition("[0,5]");
    const auto ds = ps.decompressed();
    ds.validate();
    checkEq(ser(ds), "[0,AB|AC|BC]", "decompress split point");
    checkEqInt(ps.lives2(), ds.lives2(), "split lives preserved");

    const auto pt = parsePosition("[0,6]");
    const auto dt = pt.decompressed();
    dt.validate();
    checkEq(ser(dt), "[0,ABC|ABC]", "decompress triplet");
    checkEqInt(pt.lives2(), dt.lives2(), "triplet lives preserved");

    // Already-decompressed positions pass through unchanged.
    checkEq(ser(parsePosition("[0,0,0]").decompressed()), "[0,0,0]",
            "no-op decompression");
}

void testLives() {
    using namespace stalks;
    checkEqInt(parsePosition("[0,0,0]").lives2(), 18, "three spots");
    checkEqInt(parsePosition("[0,0,0]" + OPLUS + PHI).lives2(), 18, "phi adds nothing");
    checkEqInt(parsePosition("[2,2]").lives2(), 4, "two scabs");
}

std::set<std::string> childSet(const std::string& enc) {
    std::set<std::string> out;
    for (const auto& child : stalks::enclosureChildren(stalks::parsePosition(enc)))
        out.insert(ser(child));
    return out;
}

std::string applySer(const std::string& enc, const stalks::Enclosure& m) {
    const auto p = stalks::parsePosition(enc);
    const auto child = stalks::applyEnclosure(p, 0, m);
    child.validate();
    return ser(child);
}

std::string applyJoinSer(const std::string& enc, const stalks::Join& m) {
    const auto p = stalks::parsePosition(enc);
    const auto child = stalks::applyJoin(p, 0, m);
    child.validate();
    return ser(child);
}

std::set<std::string> joinChildSet(const std::string& enc) {
    std::set<std::string> out;
    for (const auto& child : stalks::joinChildren(stalks::parsePosition(enc)))
        out.insert(ser(child));
    return out;
}

std::set<std::string> allChildSet(const std::string& enc) {
    std::set<std::string> out;
    for (const auto& child : stalks::childrenAll(stalks::parsePosition(enc)))
        out.insert(ser(child));
    return out;
}

std::set<std::string> interiorSet(const std::string& enc) {
    std::set<std::string> out;
    for (const auto& child : stalks::interiorPseudoChildren(stalks::parsePosition(enc)))
        out.insert(ser(child));
    return out;
}

// The full game tree from an n-spot start, returning the set of distinct canonical
// positions (including the start and the terminal dead position). childrenAll already
// returns canonical positions, so dedup is by serialization. Every position is validated.
// Children in fully decompressed ("base") canonical form: enclosure and join moves on the
// decompressed position, each result canonicalized without recompression. No interior
// pseudo moves are needed because a decompressed organ's moves are ordinary enclosure/join
// moves. This keeps game-distinct positions distinct (unlike the compressed engine, which
// identifies pseudo-point-equivalent positions).
std::vector<stalks::Position> decompChildren(const stalks::Position& p) {
    std::vector<stalks::Position> out;
    std::set<std::string> seen;
    for (std::size_t k = 0; k < p.components.size(); ++k) {
        if (p.components[k].dead)
            continue;
        auto add = [&](stalks::Position&& raw) {
            stalks::Position ch = stalks::canonicalizeDecompressed(raw);
            ch.validate();
            if (seen.insert(ser(ch)).second)
                out.push_back(std::move(ch));
        };
        for (const auto& mv : stalks::enclosureMoves(p.components[k]))
            add(stalks::applyEnclosure(p, k, mv));
        for (const auto& mv : stalks::joinMoves(p.components[k]))
            add(stalks::applyJoin(p, k, mv));
    }
    return out;
}

// Real-move children (enclosure + join only, no interior-pseudo identities), but with the
// child kept in COMPACT structural canonical form instead of fully decompressed. Same move
// set as decompChildren -- so the same game tree and the same nimbers -- but nodes stay
// small, so canonical labeling is cheap (no exploded all-membrane organ regions).
std::vector<stalks::Position> structChildren(const stalks::Position& p) {
    std::vector<stalks::Position> out;
    std::set<std::string> seen;
    const stalks::Position d = p.decompressed();
    for (std::size_t k = 0; k < d.components.size(); ++k) {
        if (d.components[k].dead)
            continue;
        auto add = [&](stalks::Position&& raw) {
            stalks::Position ch = stalks::canonicalize(raw);
            ch.validate();
            if (seen.insert(ser(ch)).second)
                out.push_back(std::move(ch));
        };
        for (const auto& mv : stalks::enclosureMoves(d.components[k]))
            add(stalks::applyEnclosure(d, k, mv));
        for (const auto& mv : stalks::joinMoves(d.components[k]))
            add(stalks::applyJoin(d, k, mv));
    }
    return out;
}

// Memoized bottom-up Grundy value of `p` on the decompressed (base) game graph: mex of the
// children's values, children generated by real enclosure/join moves (decompChildren). This is
// the encoding-independent game value. The memo is caller-owned, so a batch of queries over one
// tree reuses each other's subtrees; the diagnostic harnesses below share this single definition
// rather than each re-declaring the same recursive lambda.
int decompNimber(const stalks::Position& p, std::map<std::string, int>& memo) {
    const std::string k = ser(p);
    if (const auto it = memo.find(k); it != memo.end())
        return it->second;
    std::set<int> s;
    for (const auto& c : decompChildren(p))
        s.insert(decompNimber(c, memo));
    int m = 0;
    while (s.count(m))
        ++m;
    return memo[k] = m;
}

std::set<std::string> treeSet(int spots, bool decompressed = false) {
    const std::string start = startEncoding(spots);
    std::set<std::string> visited;
    if (decompressed) {
        const stalks::Position root =
            stalks::canonicalizeDecompressed(stalks::parsePosition(start));
        std::vector<stalks::Position> stack{root};
        visited.insert(ser(root));
        while (!stack.empty()) {
            const stalks::Position p = std::move(stack.back());
            stack.pop_back();
            for (auto& child : decompChildren(p))
                if (visited.insert(ser(child)).second)
                    stack.push_back(std::move(child));
        }
        return visited;
    }
    const stalks::Position root = stalks::canonicalize(stalks::parsePosition(start));
    std::vector<stalks::Position> stack{root};
    visited.insert(ser(root));
    while (!stack.empty()) {
        const stalks::Position p = std::move(stack.back());
        stack.pop_back();
        for (auto& child : stalks::childrenAll(p)) {
            child.validate();
            if (visited.insert(ser(child)).second)
                stack.push_back(std::move(child));
        }
    }
    return visited;
}

long long treeCount(int spots, bool decompressed = false) {
    return static_cast<long long>(treeSet(spots, decompressed).size());
}

void testEnclosures() {
    using namespace stalks;

    // Spot self-connection makes a bigon, which recompresses to a lone hollow point.
    {
        const auto kids = childSet("[0]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0] has one enclosure child");
        CHECK(kids.count("[4]") == 1);
    }

    // The spot-self move of [0,0,0] with both other boundaries outside recompresses to
    // [0,0,4]; the only other distinct child puts one spot inside the loop.
    {
        const auto kids = childSet("[0,0,0]");
        checkEqInt(static_cast<long long>(kids.size()), 2, "[0,0,0] enclosure children");
        CHECK(kids.count("[0,0,4]") == 1);
        CHECK(kids.count("[0,AB|0,AB]") == 1);
    }

    // A lone appendage's self-connection kills everything.
    {
        const auto kids = childSet("[1]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[1] has one enclosure child");
        CHECK(kids.count(PHI) == 1);
    }

    // Appendage-to-appendage across a joint: both endpoints become membrane pairs and
    // the joint transmutes, giving the 4-cycle of membranes.
    checkEq(applySer("[0,1718]", {0, 1, 0, 2, 0}), "[ABCD|0,CBAD]",
            "appendage-appendage enclosure on [0,1718]");

    // Appendage self-connections on the same walk (old hangingToSelf), empty side and
    // spot-enclosing side.
    {
        const auto kids = childSet("[0,1718]");
        CHECK(kids.count("[17A8|0,A]") == 1);
        CHECK(kids.count("[0,1728]") == 1);
    }

    // Consumed membrane endpoint: partner occurrence dies cross-region and the
    // component splits.
    checkEq(applySer("[0,A|1A]", {1, 0, 0, 1, 0}), "[0]" + OPLUS + "[AB|AB]",
            "membrane consumption splits off [0]");

    // Hollow-point interior in decompressed form: enclosure across the two membranes
    // triggers decay and isolation, matching the paper rewrite (4 q*) = (q*).
    checkEq(applySer("[0,AB|AB]", {1, 0, 0, 1, 0}), "[0]",
            "hollow interior enclosure decays away");

    // Chop: deleting the membrane between joint visits leaves an adjacent joint, which
    // collapses to a distal scab.
    checkEq(applySer("[17A8|22A]", {1, 0, 0, 2, 0}), "[12]" + OPLUS + "[22]",
            "chop after cross-region membrane deletion");

    // Invalid moves are rejected.
    checkThrows([] {
        applyEnclosure(parsePosition("[0,2]").components[0], Enclosure{0, 1, 0, 0, 0});
    }, "scab self-connection rejected");
    checkThrows([] {
        applyEnclosure(parsePosition("[0,17281]").components[0], Enclosure{0, 1, 1, 3, 0});
    }, "joint to its own other side rejected");

    // A joints-and-membranes position from the paper (decompressed first — it holds a
    // compressed DisaPoint): every enclosure child validates (validation runs inside
    // enclosureChildren).
    {
        const auto p = parsePosition("[17237A828|0,12BC|BC|0,A|177187288]").decompressed();
        CHECK(!enclosureChildren(p).empty());
    }

    // Compressed pseudo-points are rejected until decompressed.
    checkThrows([] { enclosureChildren(parsePosition("[0,4]")); },
                "pseudo-point move generation rejected");

    // Paper worked example (Move Notation Order of Operations): from
    // [0,4,22,12AB3|0,0,0,0,AB] connect the scab and the DisaPoint on boundary 12AB3,
    // keeping the spot with the appendage side. This is an ENCLOSURE (both endpoints on
    // one boundary; the region splits). With recompression and canonization in place we
    // assert the exact canonical child string: the paper's result [0,1A|4,22,ABC|0,0,0,0,BC]
    // is itself canonical and appears exactly once among the (canonical) children.
    // Exercises: DisaPoint endpoint decompress->membrane->consume with its interior scab
    // region dying, a hollow riding along untouched and recompressed, and boundary
    // distribution.
    {
        const std::string paper = "[0,1A|4,22,ABC|0,0,0,0,BC]";
        checkEq(ser(canonicalize(parsePosition(paper))), paper,
                "paper result is already canonical");
        const auto kids = allChildSet("[0,4,22,12AB3|0,0,0,0,AB]");
        CHECK(kids.count(paper) == 1);
    }
}

void testJoins() {
    using namespace stalks;

    // Two spots joined: the drawn line's midpoint is a joint wrapping one appendage.
    checkEq(applyJoinSer("[0,0]", {0, 0, 1, 0, 0}), "[1718]", "join two spots -> 1718");

    // Paper oracle: [0,0,0] join two spots leaves the third spot and the 1718 boundary.
    checkEq(applyJoinSer("[0,0,0]", {0, 0, 1, 0, 0}), "[0,1718]",
            "join two of three spots -> [0,1718]");

    // The only distinct join child of [0,0] is [1718]; of [0,0,0] is [0,1718].
    {
        const auto kids = joinChildSet("[0,0]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0,0] one join child");
        CHECK(kids.count("[1718]") == 1);
    }
    {
        const auto kids = joinChildSet("[0,0,0]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0,0,0] one join child");
        CHECK(kids.count("[0,1718]") == 1);
    }

    // Join distinct boundaries where a boundary is required (a self-join is rejected).
    checkThrows([] { applyJoin(parsePosition("[0,0]").components[0], Join{0, 0, 0, 0, 0}); },
                "join onto the same boundary rejected");

    // Two lone scabs joined: both endpoints die and the bridge collapses to one scab,
    // which is then isolated alone in its region and dies -> the whole position is dead.
    checkEq(applyJoinSer("[2,2]", {0, 0, 1, 0, 0}), PHI, "scab+scab join -> phi");

    // The same fusion with a spot for company: the single scab survives.
    checkEq(applyJoinSer("[0,2,2]", {0, 1, 2, 0, 0}), "[0,2]", "scab+scab join keeps [0,2]");

    // A scab joined to a spot: the scab dies, the bridge decays, the spot survives as an
    // appendage carrying a scab (boundary 12).
    checkEq(applyJoinSer("[0,2]", {0, 0, 1, 0, 0}), "[12]", "spot+scab join -> [12]");

    // Every join child of a joints+membranes position validates (runs inside joinChildren).
    {
        const auto p = parsePosition("[17237A828|0,12BC|BC|0,A|177187288]").decompressed();
        CHECK(!joinChildren(p).empty());
    }

    // Compressed pseudo-points are rejected until decompressed.
    checkThrows([] { joinChildren(parsePosition("[0,4]")); },
                "join generation rejects compressed pseudo-points");
}

// M1: provenance threading. applyEnclosureTracked / applyJoinTracked stamp each input token
// with a caller id and carry it through the whole move surgery, so a child token can be traced
// back to the parent vertex it descends from (or to GEN_SRC for the generated vertex). The token
// forms must stay byte-identical to the untracked move; provenance must be self-consistent (a
// membrane's two occurrences agree) and account for every surviving vertex.
void testProvenance() {
    using namespace stalks;

    // Stamp token k of boundary b of region r with a distinct id (100, 101, ...).
    auto stampDistinct = [](const Component& c) {
        CompSrc src(c.regions.size());
        int id = 100;
        for (std::size_t r = 0; r < c.regions.size(); ++r) {
            src[r].resize(c.regions[r].size());
            for (std::size_t b = 0; b < c.regions[r].size(); ++b)
                for (std::size_t k = 0; k < c.regions[r][b].size(); ++k)
                    src[r][b].push_back(id++);
        }
        return src;
    };

    // Flatten (token, srcId) in region/boundary/token order (parallel by construction).
    auto flat = [](const Component& c, const CompSrc& s) {
        std::vector<std::pair<Token, int>> out;
        for (std::size_t r = 0; r < c.regions.size(); ++r)
            for (std::size_t b = 0; b < c.regions[r].size(); ++b)
                for (std::size_t k = 0; k < c.regions[r][b].size(); ++k)
                    out.emplace_back(c.regions[r][b][k], s[r][b][k]);
        return out;
    };

    // A membrane pairing's two occurrences must carry the same srcId (a vertex's two sides agree).
    auto pairingConsistent = [](const Component& c, const CompSrc& s) {
        const auto idx = c.pairIndex();
        std::map<int, std::vector<int>> byPair;
        for (std::size_t r = 0; r < c.regions.size(); ++r)
            for (std::size_t b = 0; b < c.regions[r].size(); ++b) {
                std::size_t mo = 0;
                for (std::size_t k = 0; k < c.regions[r][b].size(); ++k)
                    if (c.regions[r][b][k] == MEMB)
                        byPair[idx[r][b][mo++]].push_back(s[r][b][k]);
            }
        for (const auto& [pi, ids] : byPair)
            if (ids.size() == 2 && ids[0] != ids[1])
                return false;
        return true;
    };

    // Find the tracked piece whose serialization equals `want` (pieces come out in the same
    // order as the untracked move, but we match by content to avoid depending on it).
    auto pieceBySer = [](const std::vector<std::pair<Component, CompSrc>>& pieces,
                         const std::string& want) -> const std::pair<Component, CompSrc>* {
        for (const auto& pc : pieces)
            if (ser(pc.first) == want)
                return &pc;
        return nullptr;
    };

    auto srcMultiset = [&](const Component& c, const CompSrc& s) {
        std::multiset<int> ids;
        for (const auto& [t, id] : flat(c, s)) {
            (void)t;
            ids.insert(id);
        }
        return ids;
    };

    // --- Case 1: spot self-connect. The spot survives as a membrane pair (keeps its id); the
    //     loop midpoint is generated. Result [AB|AB] with srcIds {100,100, GEN,GEN}.
    {
        const Component c = parsePosition("[0]").components[0];
        const CompSrc src = stampDistinct(c);  // {{{100}}}
        const Enclosure m{0, 0, 0, 0, 0};
        const auto pieces = applyEnclosureTracked(c, src, m);
        // Token form identical to the untracked move.
        checkEqInt(static_cast<long long>(pieces.size()),
                   static_cast<long long>(applyEnclosure(c, m).size()),
                   "selfconnect: piece count matches untracked");
        checkEqInt(static_cast<long long>(pieces.size()), 1, "selfconnect: one piece");
        checkEq(ser(pieces[0].first), "[AB|AB]", "selfconnect: token form");
        CHECK(pairingConsistent(pieces[0].first, pieces[0].second));
        const auto ids = srcMultiset(pieces[0].first, pieces[0].second);
        CHECK(ids.size() == 4 && ids.count(100) == 2 && ids.count(GEN_SRC) == 2);
    }

    // --- Case 2: join two spots. Both spots survive as appendages (keep their ids); the join's
    //     midpoint is a generated joint. Result [1718]: the two '1' carry {100,101}, 7/8 = GEN.
    {
        const Component c = parsePosition("[0,0]").components[0];
        const CompSrc src = stampDistinct(c);  // boundary0 -> 100, boundary1 -> 101
        const Join m{0, 0, 1, 0, 0};
        const auto pieces = applyJoinTracked(c, src, m);
        checkEqInt(static_cast<long long>(pieces.size()), 1, "join2: one piece");
        checkEq(ser(pieces[0].first), "[1718]", "join2: token form");
        std::multiset<int> appe, joints;
        for (const auto& [t, id] : flat(pieces[0].first, pieces[0].second)) {
            if (t == APPE) appe.insert(id);
            else if (isJoint(t)) joints.insert(id);
        }
        CHECK(appe.size() == 2 && appe.count(100) == 1 && appe.count(101) == 1);
        CHECK(joints.size() == 2 && joints.count(GEN_SRC) == 2);
    }

    // --- Case 3: membrane-consumption enclosure that splits off a spot. [0,A|1A] connect the
    //     appendage(102) to membrane A(103) on region 1. The appendage survives as a membrane
    //     (keeps 102); membrane A(103) is consumed and takes its partner (101) with it; the lone
    //     spot(100) splits off untouched. Result [0] (+) [AB|AB]. Verifies survivor-as-membrane,
    //     cross-region consumption vanishing, and per-piece provenance across a split.
    {
        const Component c = parsePosition("[0,A|1A]").components[0];
        const CompSrc src = stampDistinct(c);  // 0->100, A->101 | 1->102, A->103
        const Enclosure m{1, 0, 0, 1, 0};
        const auto pieces = applyEnclosureTracked(c, src, m);
        checkEqInt(static_cast<long long>(pieces.size()), 2, "consume: two pieces");
        const auto* spotPc = pieceBySer(pieces, "[0]");
        const auto* abPc = pieceBySer(pieces, "[AB|AB]");
        CHECK(spotPc != nullptr && abPc != nullptr);
        if (spotPc) {
            const auto ids = srcMultiset(spotPc->first, spotPc->second);
            CHECK(ids.size() == 1 && ids.count(100) == 1);  // lone spot survives with its id
        }
        if (abPc) {
            CHECK(pairingConsistent(abPc->first, abPc->second));
            const auto ids = srcMultiset(abPc->first, abPc->second);
            // Surviving appendage (102) doubled; generated doubled; consumed 101/103 are gone.
            CHECK(ids.size() == 4 && ids.count(102) == 2 && ids.count(GEN_SRC) == 2 &&
                  ids.count(101) == 0 && ids.count(103) == 0);
        }
    }

    // --- Canon threading (M1b). Stamp one id per vertex (a membrane's two occurrences share it),
    //     canonicalize with provenance, and require: token form byte-identical to the untracked
    //     canonicalizeDecompressed, provenance self-consistent, every vertex accounted for.
    auto stampByVertex = [](const Component& c) {
        const auto idx = c.pairIndex();
        CompSrc src(c.regions.size());
        std::vector<int> pairId(c.pairings.size(), -1);
        int next = 100;
        for (std::size_t r = 0; r < c.regions.size(); ++r) {
            src[r].resize(c.regions[r].size());
            for (std::size_t b = 0; b < c.regions[r].size(); ++b) {
                std::size_t mo = 0;
                for (std::size_t k = 0; k < c.regions[r][b].size(); ++k) {
                    if (c.regions[r][b][k] == MEMB) {
                        const int pi = idx[r][b][mo++];
                        if (pi >= 0) {
                            if (pairId[static_cast<std::size_t>(pi)] < 0)
                                pairId[static_cast<std::size_t>(pi)] = next++;
                            src[r][b].push_back(pairId[static_cast<std::size_t>(pi)]);
                        } else {
                            src[r][b].push_back(next++);
                        }
                    } else {
                        src[r][b].push_back(next++);
                    }
                }
            }
        }
        return src;
    };
    auto posMultiset = [](const TrackedCanon& tc) {
        std::multiset<int> ids;
        for (const auto& cs : tc.src)
            for (const auto& reg : cs)
                for (const auto& bnd : reg)
                    for (int id : bnd)
                        ids.insert(id);
        return ids;
    };

    // Case 4: boundary-permutation. [0,0,0] is one region with three tied spot boundaries; canon
    // enumerates their orders and the winner-capture must carry each spot's id. All three survive.
    {
        const Component c = parsePosition("[0,0,0]").components[0];
        const Position pin{{c}};
        const TrackedCanon tc = canonicalizeDecompressedTracked(pin, {stampByVertex(c)});
        checkEq(ser(tc.pos), ser(canonicalizeDecompressed(pin)), "canon [0,0,0]: token form tracked==untracked");
        const auto ids = posMultiset(tc);
        CHECK(ids.size() == 3 && ids.count(100) == 1 && ids.count(101) == 1 && ids.count(102) == 1);
    }

    // Case 5: membrane relabel + region symmetry. [AB|AB]: A and B are each one vertex (two occ);
    // canon reletters by first occurrence, but srcId rides the pairing label, not the letter.
    {
        const Component c = parsePosition("[AB|AB]").components[0];
        const Position pin{{c}};
        const TrackedCanon tc = canonicalizeDecompressedTracked(pin, {stampByVertex(c)});
        checkEq(ser(tc.pos), ser(canonicalizeDecompressed(pin)), "canon [AB|AB]: token form tracked==untracked");
        CHECK(pairingConsistent(tc.pos.components[0], tc.src[0]));
        const auto ids = posMultiset(tc);
        CHECK(ids.size() == 4 && ids.count(100) == 2 && ids.count(101) == 2);
    }

    // Case 6: full path move -> canon. Spot self-connect [0], then canonicalize the tracked child.
    // The spot survives (id 100, doubled); the generated midpoint is GEN_SRC (doubled).
    {
        const Component parent = parsePosition("[0]").components[0];
        const CompSrc psrc{{{100}}};
        Position child;
        std::vector<CompSrc> childSrc;
        for (auto& [pc, ps] : applyEnclosureTracked(parent, psrc, Enclosure{0, 0, 0, 0, 0})) {
            child.components.push_back(pc);
            childSrc.push_back(ps);
        }
        const TrackedCanon tc = canonicalizeDecompressedTracked(child, childSrc);
        checkEq(ser(tc.pos), ser(canonicalizeDecompressed(child)), "move->canon: token form tracked==untracked");
        CHECK(pairingConsistent(tc.pos.components[0], tc.src[0]));
        const auto ids = posMultiset(tc);
        CHECK(ids.size() == 4 && ids.count(100) == 2 && ids.count(GEN_SRC) == 2);
    }

    // Case 7: whole-position move with carry-over. [0]+[0,0]: join the two spots of component 1;
    // component 0's lone spot must ride through unchanged with its id. Result [0]+[1718]: the
    // carried spot (200) plus the two joined spots as appendages (201,202) and a generated joint.
    {
        const Position p = parsePosition("[0]+[0,0]");
        const std::vector<CompSrc> psrc = {{{{200}}}, {{{201}, {202}}}};
        const TrackedCanon tc = joinChildTracked(p, psrc, 1, Join{0, 0, 1, 0, 0});
        checkEq(ser(tc.pos), ser(canonicalizeDecompressed(applyJoin(p, 1, Join{0, 0, 1, 0, 0}))),
                "whole-position join: token form tracked==untracked");
        const auto ids = posMultiset(tc);
        CHECK(ids.size() == 5 && ids.count(200) == 1 && ids.count(201) == 1 &&
              ids.count(202) == 1 && ids.count(GEN_SRC) == 2);
    }
}

void testInteriorPseudo() {
    using namespace stalks;

    // The four paper interior rewrites, each as the sole interior child.
    // (3q*)=(q*): the DisaPoint disappears.
    {
        const auto kids = interiorSet("[0,3]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0,3] one interior child");
        CHECK(kids.count("[0]") == 1);
    }
    // (4q*)=(q*): the hollow point disappears.
    {
        const auto kids = interiorSet("[0,4]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0,4] one interior child");
        CHECK(kids.count("[0]") == 1);
    }
    // (5q*)=(2q*): the split point becomes a scab.
    {
        const auto kids = interiorSet("[0,5]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0,5] one interior child");
        CHECK(kids.count("[0,2]") == 1);
    }
    // (6q*)=(3q*): the triplet becomes a DisaPoint, which the base canon leaves expanded
    // (DisaPoints are not structurally compressed) as a scab+membrane cell.
    {
        const auto kids = interiorSet("[0,6]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0,6] one interior child");
        CHECK(kids.count("[2A|0,A]") == 1);
    }

    // Positions with no pseudo-points have no interior children.
    CHECK(interiorSet("[0,0]").empty());
}

std::string recompressSer(const std::string& enc) {
    return ser(stalks::recompress(stalks::parsePosition(enc)));
}

// recompress must invert decompress on canonical organ shapes.
std::string roundTrip(const std::string& enc) {
    return ser(stalks::recompress(stalks::parsePosition(enc).decompressed()));
}

void testRecompress() {
    using namespace stalks;

    // The four pseudo-points round-trip through decompress -> recompress.
    checkEq(roundTrip("[0,3]"), "[0,3]", "DisaPoint round-trips");
    checkEq(roundTrip("[0,4]"), "[0,4]", "hollow round-trips");
    checkEq(roundTrip("[0,5]"), "[0,5]", "split round-trips");
    checkEq(roundTrip("[0,6]"), "[0,6]", "triplet round-trips");
    checkEq(roundTrip("[13,24]"), "[13,24]", "DisaPoint+hollow round-trip");

    // Recompress works on the raw decompressed encodings from testDecompression.
    checkEq(recompressSer("[1A,2BC|2A|BC]"), "[13,24]", "recompress [1A,2BC|2A|BC]");
    checkEq(recompressSer("[0,AB|AC|BC]"), "[0,5]", "recompress split shape");
    checkEq(recompressSer("[0,ABC|ABC]"), "[0,6]", "recompress triplet shape");
    checkEq(recompressSer("[0,A|2A]"), "[0,3]", "recompress lone-DisaPoint");
    checkEq(recompressSer("[0,AB|AB]"), "[0,4]", "recompress lone-hollow");

    // The symmetric bigon compresses to a lone hollow point.
    checkEq(recompressSer("[AB|AB]"), "[4]", "bigon -> [4]");

    // DisaPoint host-choice determinism: both [2A|2A] and the mixed [2A|2,A] canonicalize
    // to [23], never [2,3] (canonAlgo step 1 tie-break).
    checkEq(recompressSer("[2A|2A]"), "[23]", "[29|29] -> [23]");
    checkEq(recompressSer("[2A|2,A]"), "[23]", "[29|2,9] -> [23]");

    // A DisaPoint riding on a live boundary.
    checkEq(recompressSer("[2A|1A]"), "[13]", "DisaPoint on an appendage boundary");

    // Nothing to compress: no-ops.
    checkEq(recompressSer("[0,0,0]"), "[0,0,0]", "spots do not compress");
    checkEq(recompressSer("[1718]"), "[1718]", "a joint boundary does not compress");
    checkEq(recompressSer("[0,3]"), "[0,3]", "already-compressed is a no-op");
}

std::string canonSer(const std::string& enc, bool slack = false) {
    return ser(stalks::canonicalize(stalks::parsePosition(enc), slack));
}

void testCanon() {
    using namespace stalks;

    // Canon is idempotent and label-invariant: relabelings of one position canonicalize
    // to a single representative.
    checkEq(canonSer("[0,0,0]"), "[0,0,0]", "canon spots idempotent");
    checkEq(canonSer("[17237A828|0,12BC|BC|0,A|177187288]"),
            canonSer("[177187288|0,A|BC|0,12BC|17237A828]"),
            "canon invariant under region reordering");

    // Membrane relabeling does not matter.
    checkEq(canonSer("[AB|AB]"), canonSer("[BA|BA]"), "canon invariant under letter swap");

    // Recompression happens inside canon: the decompressed and compressed forms of one
    // position share a canonical form.
    checkEq(canonSer("[13,24]"), canonSer("[1A,2BC|2A|BC]"),
            "canon unifies compressed and decompressed");
    checkEq(canonSer("[0,AB|AB]"), canonSer("[0,4]"), "canon recompresses hollow");

    // Minimal subpositions are split out and ordered (region count, then value).
    checkEq(canonSer("[0]" + OPLUS + "[0,0]"), "[0]" + OPLUS + "[0,0]",
            "canon orders subpositions by region count");
    checkEq(canonSer("[0,0]" + OPLUS + "[0]"), "[0]" + OPLUS + "[0,0]",
            "canon reorders subpositions");

    // Chirality: a chiral position and its mirror share a canonical form, and canon is
    // stable under it.
    checkEq(canonSer("[00112]"), canonSer("[00211]"), "canon folds mirror image");

    // The worked canonAlgo example (Figure exampleCanon) is the paper's FULL canonical form
    // (its boundary 1772388 carries a compressed DisaPoint 3), so it is its own fixed point
    // only under canonicalizeFull; the base/structural canon leaves that DisaPoint expanded.
    const std::string canonExample =
        "[AB|CDE|CFG|HIJK|ADFL,HIJK|4,1EBLG,1772388]";
    checkEq(ser(canonicalizeFull(parsePosition(canonExample))), canonExample,
            "canonAlgo example is its own full-canon form");

    // --- Automorphism-dedup torture set ------------------------------------------------------
    // Highly symmetric subpositions give the region-ordering search large tied automorphism
    // orbits (the source of the historical slow 6-spot positions). The orbit pruning must return
    // exactly the un-pruned brute oracle's form, and stay invariant under relabeling / region
    // reordering. We compare the decompressed search form against the decompressed brute form so
    // the only variable is the pruning itself (no recompression on either side). Positions that
    // are not planar-valid are skipped (reported), never counted as failures.
    {
        auto probe = [](const std::string& enc, const std::string& what) {
            try {
                const std::string pruned = ser(canonicalizeDecompressed(parsePosition(enc)));
                const std::string brute = ser(canonicalizeBrute(parsePosition(enc)));
                checkEq(pruned, brute, "orbit==brute: " + what);
            } catch (const std::exception& e) {
                std::cout << "  (skip torture " << enc << ": " << e.what() << ")\n";
            }
        };
        auto invariant = [](const std::vector<std::string>& forms, const std::string& what) {
            try {
                const std::string base = ser(canonicalizeDecompressed(parsePosition(forms.front())));
                for (std::size_t i = 1; i < forms.size(); ++i)
                    checkEq(ser(canonicalizeDecompressed(parsePosition(forms[i]))), base,
                            "orbit invariant: " + what);
            } catch (const std::exception& e) {
                std::cout << "  (skip torture-inv " << what << ": " << e.what() << ")\n";
            }
        };
        // [0,AB|0,AB]: two identical regions (a real game-tree position, see testDriver) --
        // symmetric under swapping the regions and under A<->B.
        probe("[0,AB|0,AB]", "twin regions");
        invariant({"[0,AB|0,AB]", "[0,BA|0,BA]", "[0,AB|0,BA]"}, "twin region relabel");
        // Extra symmetric candidates (kept only if planar-valid).
        probe("[0,ABC|0,ABC]", "3-membrane twins");
        probe("[AB|AB|0,0]", "theta plus spots");
        probe("[0,ABC|0,A|0,B|0,C]", "center + 3 satellites");
        probe("[ABCD|AB|CD|0,0]", "paired membrane fan");
    }
}

// Advanced Collections / quick-canon, step 1: the left-side authoring parser and the
// marked-graph canonicalizer (leftSideKey). Exercised standalone -- no crit-finder yet.
void testCollections() {
    using namespace stalks;

    // --- geometric invariances of the marked-graph canonicalizer ---------------------------
    // Rotation of a single boundary: [2a/ == [a2/.
    checkEq(leftSideKey("2a"), leftSideKey("a2"), "left-side rotation invariance");
    // Boundary order within the region is irrelevant.
    checkEq(leftSideKey("0,a"), leftSideKey("a,0"), "left-side boundary-order invariance");
    checkEq(leftSideKey("23,2a"), leftSideKey("2a,23"), "left-side multi-boundary order invariance");
    // Chirality: a boundary and its mirror share a key ([12a/ mirror is [a21/).
    checkEq(leftSideKey("12a"), leftSideKey("a21"), "left-side mirror invariance");
    // A joint-wrapped crit ([17a8/) parses and canonicalizes to a non-empty key.
    CHECK(!leftSideKey("17a8").empty());

    // --- distinct left sides get distinct keys (boundary partition is significant) ----------
    CHECK(leftSideKey("2a") != leftSideKey("1a"));    // S1 rep vs an S2 element
    CHECK(leftSideKey("2a") != leftSideKey("0,a"));   // two distinct S1 elements
    // Partition matters: a left side matches a collection only if EXACTLY equal, so these stay
    // distinct (author: [2,2,A,B/ != [2,2,AB/ -- adjacent crits change the nimber).
    CHECK(leftSideKey("2,2a") != leftSideKey("22a"));
    CHECK(leftSideKey("0,a") != leftSideKey("0a"));

    // --- malformed / out-of-scope left sides are rejected ----------------------------------
    checkThrows([] { leftSideKey("2"); }, "left side with no crit port rejected");
    checkThrows([] { leftSideKey("2A"); }, "ordinary membrane letter rejected");
    checkThrows([] { leftSideKey("29"); }, "agnostic membrane rejected");
    checkThrows([] { leftSideKey("2|a"); }, "region separator rejected");

    // --- S1 / S2 rosters: the two collections must have DISJOINT key sets. A shared key would
    // map to conflicting offsets (0 vs 1) -- an unsound registry. Within a collection, universal
    // congruity may legitimately merge boundary-partition variants, so intra-collection
    // collisions are expected and fine; only a cross-collection clash is a bug. --------------
    const std::vector<std::string> s1 = {
        "2a", "2,a", "0,a", "2,2,2,a", "12,a", "5,2a", "23,2a", "2,2,3,a",
        "13a", "23,3a", "22,2a", "2,3,3,a", "1,3a", "3,23,a", "22,3a", "17a8"};
    const std::vector<std::string> s2 = {
        "1a", "1,a", "5a", "5,a", "2,2a", "22a", "2,2,a", "27a8",
        "2,3a", "23a", "2,3,a", "37a8", "3,2a", "0,2a", "0,3a"};
    std::set<std::string> s1keys, s2keys;
    for (const auto& e : s1)
        s1keys.insert(leftSideKey(e));
    for (const auto& e : s2)
        s2keys.insert(leftSideKey(e));
    bool disjoint = true;
    for (const auto& k : s1keys)
        if (s2keys.count(k)) {
            disjoint = false;
            std::cout << "  S1/S2 key clash on '" << k << "'\n";
        }
    report(disjoint, "S1 and S2 collection key sets are disjoint");

    // --- step 2: crit-finder + left-side extraction (leaf regions) --------------------------
    auto keySet = [](const std::string& enc) {
        const auto v = detachableLeftSideKeys(parsePosition(enc));
        return std::multiset<std::string>(v.begin(), v.end());
    };
    // The worked example: two leaf regions ("0,C" and "124D"); the middle region "C,2D" has two
    // membranes, so it is not a crit.
    {
        const auto ks = keySet("[0,C|C,2D|124D]");
        checkEqInt(static_cast<long long>(ks.size()), 2, "worked example: 2 crit candidates");
        CHECK(ks.count(leftSideKey("0,a")) == 1);
        CHECK(ks.count(leftSideKey("124a")) == 1);
    }
    // Both regions of a bare DisaPoint host are leaves -> two candidates, both key [2a/.
    {
        const auto ks = keySet("[2A|2A]");
        checkEqInt(static_cast<long long>(ks.size()), 2, "[2A|2A]: 2 crit candidates");
        CHECK(ks.count(leftSideKey("2a")) == 2);
    }
    // DisaPoint on an appendage boundary: leaves "2A" and "1A".
    {
        const auto ks = keySet("[2A|1A]");
        CHECK(ks.count(leftSideKey("2a")) == 1);
        CHECK(ks.count(leftSideKey("1a")) == 1);
    }
    // No crits: a spot-only region and a theta (both regions have two membranes).
    checkEqInt(static_cast<long long>(keySet("[0,0,0]").size()), 0, "spots: no crits");
    checkEqInt(static_cast<long long>(keySet("[AB|AB]").size()), 0, "theta: no single-crit");

    // --- steps 3-4: recursive quickCanon fixpoint (registry swaps + offset) -----------------
    auto qc = [](const std::string& enc) {
        const auto r = quickCanon(parsePosition(enc));
        return std::make_pair(ser(r.rep), r.offset);
    };
    // The worked example, end to end: [0,C|C,2D|124D] -> [3,2D|124D] (S1, +0) -> [1243] (S2, +1).
    {
        const auto [rep, off] = qc("[0,C|C,2D|124D]");
        checkEq(rep, "[1243]", "worked example rep");
        checkEqInt(off, 1, "worked example offset (S2 pairing)");
    }
    // A single S2 swap: [1A|1A24] -> [1324] oplus 1 (the flip example from design discussion).
    {
        const auto [rep, off] = qc("[1A|1A24]");
        checkEq(rep, "[1324]", "single S2 swap rep");
        checkEqInt(off, 1, "single S2 swap offset");
    }
    // A single S1 swap keeps the offset at 0: [0,A|1A2] -> [132] (the "0,A" leaf is S1 [0,a/).
    checkEqInt(qc("[0,A|1A2]").second, 0, "S1 swap keeps offset 0");
    // No collection applies: a plain spot position is unchanged with offset 0.
    checkEqInt(qc("[0,0,0]").second, 0, "no-collection offset 0");
    // Two independent S2 swaps compose their offsets to 0 (1 xor 1).
    {
        const auto off = qc("[1A|1A24]" + OPLUS + "[1B|1B24]").second;
        checkEqInt(off, 0, "two S2 swaps xor to 0");
    }

    // --- crit-cell congruity: every partition of a k-crit cell shares one rep (offset 0) -------
    // A cell that is EXACTLY k crits canonicalizes all its boundary partitions to the single-
    // boundary form. The crits go to SEPARATE regions (1A|1B|..) so the split forms are drawable
    // (crits on distinct body parts of the cell -- a shared body part like [A,B|1A1B] is NOT
    // planar). Merging only collapses body parts, so it is always valid.
    //
    // Both partitions must share ONE rep AND a consistent offset. (The offset need not be 0 here:
    // the 1A/1B/1C arms are themselves S2 elements, so quickCanon swaps them and picks up their
    // offsets -- but that is identical across the partitions, so they still agree.)
    //
    // k=2 (hollow cell C_[ab/, proven closed): [ab/y] == [a,b/y].
    {
        const auto merged = quickCanon(parsePosition("[AB|1A|1B]"));
        const auto split = quickCanon(parsePosition("[A,B|1A|1B]"));
        checkEq(ser(split.rep), ser(merged.rep), "2-crit cell: partitions share one rep");
        checkEqInt(split.offset, merged.offset, "2-crit cell: partitions share one offset");
    }
    // k=3 (C_[abc/, closure UNPROVEN -- adopted empirically; sound through 5-spot per
    // testQuickNimber): all three partition types collapse to one rep. [abc/y] == [a,bc/y] ==
    // [a,b,c/y]. (Ordering within the merged boundary is a non-issue: canon unifies every cyclic
    // order of the crits -- verified for asymmetric y.)
    {
        const auto full = quickCanon(parsePosition("[ABC|1A|1B|1C]"));
        const auto mixed = quickCanon(parsePosition("[A,BC|1A|1B|1C]"));
        const auto split = quickCanon(parsePosition("[A,B,C|1A|1B|1C]"));
        checkEq(ser(full.rep), ser(split.rep), "3-crit cell: [abc] and [a,b,c] share one rep");
        checkEq(ser(mixed.rep), ser(split.rep), "3-crit cell: [a,bc] and [a,b,c] share one rep");
        checkEqInt(full.offset, split.offset, "3-crit cell: partitions share one offset");
        checkEqInt(mixed.offset, split.offset, "3-crit cell: partitions share one offset");
    }
    // Guard: the congruity requires the cell to be EXACTLY the crits. The paper's counterexample
    // family -- [2,2,A,B|2A|2B] = G1 vs [2,2,AB|2A|2B] = G2 -- has extra scabs in the cell, so the
    // crit partition is value-significant and the two forms must NOT collapse to one rep.
    {
        const auto a = quickCanon(parsePosition("[2,2,A,B|2A|2B]"));
        const auto b = quickCanon(parsePosition("[2,2,AB|2A|2B]"));
        CHECK(ser(a.rep) != ser(b.rep));
    }

    // --- double-crit (S3/S4) content swaps -------------------------------------------------
    // Port symmetry (k=2): the two crits are an unordered set, so a left side and its port-swap
    // share a key. (k=1 keys are unaffected -- identity permutation -- as every S1/S2 test above
    // still passing confirms.)
    checkEq(leftSideKey("2ba"), leftSideKey("2ab"), "double-crit port-swap invariance (1 boundary)");
    checkEq(leftSideKey("b,2a"), leftSideKey("a,2b"), "double-crit port-swap invariance (2 boundaries)");
    // Partition still significant: [2,βα/ (two boundaries) != [2βα/ (one boundary).
    CHECK(leftSideKey("2,ba") != leftSideKey("2ba"));

    // A single-region 2-crit chunk is found and, for an S3 element, reduced to the shared rep
    // [2βα/. [2,βα/ (two boundaries) and [2βα/ (one boundary) are both S3, so both collapse to one
    // rep with equal offset. The hosts are the leaf [12α/ (explicitly NOT in any collection), so
    // the only reduction is the double-crit swap itself and the offset is exactly S3's 0.
    {
        const auto a = quickCanon(parsePosition("[2,AB|12A|12B]"));
        const auto b = quickCanon(parsePosition("[2AB|12A|12B]"));
        checkEq(ser(a.rep), ser(b.rep), "S3 double-crit: [2,βα/ and [2βα/ share one rep");
        checkEqInt(a.offset, b.offset, "S3 double-crit: partitions share one offset");
        checkEqInt(a.offset, 0, "S3 double-crit swap keeps offset 0");
    }
}

// The core soundness check for the whole collections layer: quick-canon must preserve the Grundy
// value of every position (offset included). Rather than re-deriving nimbers by hand (the original
// version re-ran the expensive quickCanon tens of thousands of times), we read everything off the
// two GameGraphs the engine already builds efficiently: the exact structural graph gives every
// minimal position and its true nimber; the quick-canon graph gives the quick node set and values.
//
// Soundness only needs the MINIMAL (single-subposition) positions: quick-canon acts component-wise,
// so a sum's value is the XOR of its parts on both the exact and quick sides -- if every minimal
// position's quick value matches its exact nimber, every position (sum included) does too. For each
// exact minimal node we quick-canon its position (one call each) and compare gQuick's value.
//
// A 5-spot pass builds two full 5-spot graphs (~30s each) plus a quickCanon per minimal node, so it
// is gated: by default the check runs to 4 spots (sub-second). Set STALKS_QUICKNIMBER_MAX=5 (or 6,
// with patience) for the deep pass.
void testQuickNimber() {
    using namespace stalks;

    int maxN = 4;
    if (const char* e = std::getenv("STALKS_QUICKNIMBER_MAX"); e && std::atoi(e) >= 2)
        maxN = std::atoi(e);

    // Soundness is checked off the two GameGraphs the engine already builds efficiently: the exact
    // structural graph gives every minimal position + its true nimber; the quick-canon graph gives
    // the quick value. Quick-canon acts component-wise, so a sum's value is the XOR of its parts on
    // both sides -- if every minimal position's quick value matches its exact nimber, every position
    // does. So we only iterate the exact graph's minimal (non-sum) nodes.
    //
    // The count-reduction line reports the FULL-reachable position/rep counts (matching the tracked
    // historical counts -- distinct from the solver-pruned graph node counts), so it is computed from
    // treeSet + quickCanon over every position. quickCanon (the collections fixpoint) is the one
    // expensive op, so it is memoized here: the original test re-ran it ~5x per position, which was
    // the entire cost of this check.
    std::map<std::string, QuickCanonResult> qcMemo;
    auto qc = [&](const Position& p) -> const QuickCanonResult& {
        const std::string k = ser(p);
        auto it = qcMemo.find(k);
        if (it == qcMemo.end())
            it = qcMemo.emplace(k, quickCanon(p)).first;
        return it->second;
    };

    // The quick-canon 2-spot count is 19 (author 2026-07-06: the historical 18 folded in an
    // unjustified ad-hoc merge of distinct equal-nimber subpositions -- nimbers already handle
    // those). S3/S4 double-crit (2026-07-07) drops 3/4/5-spot to 139/1262/13816. The Lemoine-Viennot
    // old baseline is reported for cross-checking.
    static const std::map<int, long long> lvBaseline = {
        {2, 18}, {3, 157}, {4, 1796}, {5, 24784}, {6, 393103}};

    for (int n = 2; n <= maxN; ++n) {
        // --- soundness: exact nimber == quick value for every minimal structural position ---
        const GameGraph gExact(n, GameGraph::Mode::Exact);
        GameGraph gQuick(n, GameGraph::Mode::Quick);
        int checked = 0;
        bool ok = true;
        for (const auto& nd : gExact.nodes()) {
            if (nd.isSum())
                continue;
            int off = 0;
            const Node* qn = gQuick.ensure(parsePosition(nd.enc), &off);
            const int q = qn->nimber ^ off;
            if (q != nd.nimber) {
                ok = false;
                std::cout << "  quick-nimber mismatch @" << nd.enc << ": exact=" << nd.nimber
                          << " quick=" << q << "\n";
            }
            ++checked;
        }
        report(ok, std::to_string(n) + "-spot: quick-canon preserves every nimber (" +
                       std::to_string(checked) + " minimal positions)");

        // --- count reduction: full-reachable structural positions -> distinct quick-canon reps ---
        const auto ts = treeSet(n);
        long long structSingle = 0;
        for (const auto& enc : ts)
            if (parsePosition(enc).components.size() == 1)
                ++structSingle;

        std::set<std::string> qset;
        long long quickSingle = 0;
        for (const auto& enc : ts) {
            const auto& rep = qc(parsePosition(enc)).rep;
            if (qset.insert(ser(rep)).second && rep.components.size() == 1)
                ++quickSingle;
        }

        std::cout << "  " << n << "-spot positions: structural " << ts.size() << " (1-sub "
                  << structSingle << ") -> quick " << qset.size() << " (1-sub " << quickSingle
                  << ")";
        if (const auto lv = lvBaseline.find(n); lv != lvBaseline.end())
            std::cout << "; LV baseline " << lv->second;
        std::cout << "\n";
        if (n == 2)
            checkEqInt(static_cast<long long>(qset.size()), 19, "2-spot quick-canon count");
    }
}

void testRegression() {
    using namespace stalks;
    // Full game-tree position counts in the base ("full-encoding") form, deduped by the
    // structural graph-canonical form (childrenAll). 2-spot = 20 (exact historical value);
    // 3-spot = 175 (the historical 176 double-counts one region-reversal-equivalent pair,
    // e.g. [2AB|2BA] and [2AB|2AB], confirmed with the author). The structural count matches
    // the slow fully-decompressed count (H/S/T compression is bijective) -- see the
    // STALKS_COUNT/STALKS_DECOMP harnesses -- but is ~18x faster. Higher spot counts run via
    // the harness.
    checkEqInt(treeCount(2), 20, "2-spot base position count");
    checkEqInt(treeCount(3), 175, "3-spot base position count");
}

void testDriver() {
    using namespace stalks;

    // childrenAll unions enclosure + join (+ interior) children with dedup. For [0,0]
    // that is the spot self-enclosure (keeping the other spot), which recompresses to
    // [0,4], plus the join child [1718].
    {
        const auto kids = allChildSet("[0,0]");
        checkEqInt(static_cast<long long>(kids.size()), 2, "[0,0] two children overall");
        CHECK(kids.count("[1718]") == 1);          // join
        CHECK(kids.count("[0,4]") == 1);           // spot self-enclosure -> hollow
    }

    // [0] has no join (needs two boundaries) and no interior move; only the self-enclosure,
    // whose bigon recompresses to a lone hollow point.
    {
        const auto kids = allChildSet("[0]");
        checkEqInt(static_cast<long long>(kids.size()), 1, "[0] single child overall");
        CHECK(kids.count("[4]") == 1);
    }
}

} // namespace

int main() {
    if (const char* env = std::getenv("STALKS_NIMBER"); env) {
        const int n = std::atoi(env) > 0 ? std::atoi(env) : 3;
        std::map<std::string, int> memo;
        std::vector<std::pair<std::string, int>> rows;
        for (const auto& s : treeSet(n, /*decompressed=*/true))
            rows.emplace_back(s, decompNimber(stalks::parsePosition(s), memo));
        for (const auto& [s, g] : rows)
            std::cout << "G=" << g << "\t" << s << "\n";
        std::cout << "(" << rows.size() << " positions)\n";
        return 0;
    }
    // Batch canonizer: read a file of positions (one per line, optional "G=<n> " prefix),
    // map each through canonicalizeDecompressed, and reconcile against the engine. Reports
    // parse/validate failures, user-vs-engine nimber mismatches, and collision groups
    // (distinct inputs sharing a canonical form). With STALKS_CANON_DUMP set, also emits the
    // deduped canonical set with engine nimbers for external diffing against the grown tree.
    if (const char* path = std::getenv("STALKS_CANON"); path) {
        std::ifstream in(path);
        if (!in) {
            std::cout << "cannot open " << path << "\n";
            return 2;
        }
        std::map<std::string, int> memo;
        std::map<std::string, std::vector<std::string>> byCanon;  // canon -> input encodings
        std::map<std::string, int> userG;                          // canon -> user G (last seen)
        std::map<std::string, int> engG;                           // canon -> engine G
        std::vector<std::string> parseErrors;
        int nLines = 0;
        std::string line;
        while (std::getline(in, line)) {
            while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
                line.pop_back();
            if (line.empty())
                continue;
            int ug = -1;
            std::string enc = line;
            if (line.rfind("G=", 0) == 0) {
                const std::size_t sp = line.find(' ');
                if (sp != std::string::npos) {
                    ug = std::atoi(line.substr(2, sp - 2).c_str());
                    enc = line.substr(sp + 1);
                }
            }
            ++nLines;
            try {
                const stalks::Position parsed = stalks::parsePosition(enc);
                // Structural canonical form (H/S/T compressed, DisaPoints expanded): the fast,
                // count-faithful key that matches the engine's childrenAll tree.
                stalks::Position p = stalks::canonicalize(parsed);
                p.validate();
                const std::string canon = ser(p);
                byCanon[canon].push_back(enc);
                userG[canon] = ug;
                // Game value is encoding-independent; compute it on the decompressed graph,
                // which is what the move generator consumes.
                engG[canon] = decompNimber(stalks::canonicalizeDecompressed(parsed), memo);
            } catch (const std::exception& e) {
                parseErrors.push_back(enc + "\t<<" + e.what() + ">>");
            }
        }
        std::cout << "== " << nLines << " input lines | " << byCanon.size()
                  << " distinct canonical | " << parseErrors.size() << " parse/validate errors ==\n";

        std::cout << "\n== PARSE/VALIDATE ERRORS (" << parseErrors.size() << ") ==\n";
        for (const auto& e : parseErrors)
            std::cout << e << "\n";

        int mism = 0;
        std::cout << "\n== NIMBER MISMATCHES (user G vs engine G) ==\n";
        for (const auto& [canon, origs] : byCanon) {
            const int ug = userG.at(canon), g = engG.at(canon);
            if (ug >= 0 && ug != g) {
                ++mism;
                std::cout << "userG=" << ug << " engG=" << g << "\t" << canon << "\t(" << origs[0]
                          << ")\n";
            }
        }
        std::cout << "(" << mism << " mismatches)\n";

        int colls = 0;
        std::cout << "\n== COLLISIONS (multiple inputs -> one canonical) ==\n";
        for (const auto& [canon, origs] : byCanon) {
            if (origs.size() > 1) {
                ++colls;
                std::cout << canon << "\t<=";
                for (const auto& o : origs)
                    std::cout << " {" << o << "}";
                std::cout << "\n";
            }
        }
        std::cout << "(" << colls << " collision groups)\n";

        if (std::getenv("STALKS_CANON_DUMP")) {
            std::cout << "\n== CANON DUMP ==\n";
            for (const auto& [canon, origs] : byCanon)
                std::cout << "G=" << engG.at(canon) << "\t" << canon << "\n";
        }
        return 0;
    }
    // GameGraph: one-pass build with fused nimber + minMoves/maxMoves and parent/child links,
    // over the subposition-pruned node set. Prints timing, size, root stats, and the nimber
    // histogram (the pruned distribution -- should reproduce the historical master list).
    if (const char* env = std::getenv("STALKS_GRAPH"); env) {
        const int n = std::atoi(env) > 0 ? std::atoi(env) : 4;
        // STALKS_GRAPH_QUICK builds the quick-canon graph (collections-collapsed node set with
        // per-edge nimber offsets) instead of the exact structural graph. Same reporting; the
        // node count should be far smaller and the root's true value is rootNimber().
        const bool quick = std::getenv("STALKS_GRAPH_QUICK") != nullptr;
        const auto mode = quick ? stalks::GameGraph::Mode::Quick
                                : stalks::GameGraph::Mode::Exact;
        const auto t0 = std::chrono::steady_clock::now();
        const stalks::GameGraph g(n, mode);
        const auto t1 = std::chrono::steady_clock::now();
        const stalks::Node* root = g.root();
        std::map<int, int> dist;
        long long edges = 0, sums = 0;
        for (const auto& nd : g.nodes()) {
            ++dist[nd.nimber];
            edges += static_cast<long long>(nd.children.size());
            if (nd.isSum())
                ++sums;
        }
        std::cout << n << "-spot GameGraph [" << (quick ? "quick" : "exact") << "]: " << g.size()
                  << " nodes (" << sums << " sums), " << edges << " child-edges in "
                  << std::chrono::duration<double>(t1 - t0).count() << "s\n";
        std::cout << "  root " << root->enc << "  G=" << g.rootNimber()
                  << " (rep G=" << root->nimber << " ^ off=" << g.rootOffset() << ")"
                  << "  minMoves=" << root->minMoves << "  maxMoves=" << root->maxMoves << "\n";
        std::cout << "  dist=";
        for (const auto& [gv, c] : dist)
            std::cout << " G" << gv << ":" << c;
        std::cout << "\n";
        // Invariant: every child edge wired one parent back-link, so the totals must match.
        long long totalParents = 0;
        for (const auto& nd : g.nodes())
            totalParents += static_cast<long long>(nd.parents.size());
        std::cout << "  parent-link check: total parent-links=" << totalParents
                  << " (== child-edges? " << (totalParents == edges ? "yes" : "NO") << ")"
                  << ", root parents=" << root->parents.size() << "\n";
        return 0;
    }
    // Save file: build the n-spot graph (exact and quick), write the compact minimal-node .sprout,
    // reload it, and verify the reloaded value oracle reproduces every built node's value exactly.
    // Proves the save/load round-trip: topology-only on disk, all values recomputed on load.
    if (const char* env = std::getenv("STALKS_SAVE"); env) {
        const int n = std::atoi(env) > 0 ? std::atoi(env) : 4;
        auto roundTrip = [&](stalks::GameGraph::Mode mode, const char* label,
                             const std::string& path) {
            const auto t0 = std::chrono::steady_clock::now();
            const stalks::GameGraph g(n, mode);
            const auto t1 = std::chrono::steady_clock::now();

            const std::size_t written = stalks::saveGraphToFile(g, path);
            const auto bytes = std::ifstream(path, std::ios::binary | std::ios::ate).tellg();
            const stalks::SolvedDB db = stalks::loadGraphFromFile(path);

            std::size_t minimal = 0;
            long long mismatches = 0;
            for (const auto& nd : g.nodes()) {
                if (nd.isSum())
                    continue;
                ++minimal;
                const stalks::SolvedDB::Value* v = db.findMinimal(nd.enc);
                if (!v || v->nimber != nd.nimber || v->minMoves != nd.minMoves ||
                    v->maxMoves != nd.maxMoves) {
                    if (++mismatches <= 5)
                        std::cout << "  MISMATCH " << nd.enc << ": built G" << nd.nimber << "/"
                                  << nd.minMoves << "/" << nd.maxMoves << " vs "
                                  << (v ? "loaded G" + std::to_string(v->nimber) : "MISSING")
                                  << "\n";
                }
            }
            // Whole-start value via the oracle (splits into subpositions, XORs) must equal rootNimber.
            stalks::SolvedDB::Value rv;
            int off = 0;
            const bool ok = db.value(stalks::parsePosition(g.root()->enc), rv, &off);
            const int trueRoot = rv.nimber ^ off;

            checkEqInt(static_cast<long long>(db.size()), static_cast<long long>(minimal),
                       std::string(label) + " loaded node count == minimal node count");
            checkEqInt(mismatches, 0, std::string(label) + " all node values round-trip");
            checkEqInt(ok ? trueRoot : -1, g.rootNimber(),
                       std::string(label) + " root value via oracle");

            std::cout << label << ": " << written << " minimal nodes, " << bytes << " bytes ("
                      << (minimal ? double(bytes) / double(minimal) : 0.0) << " B/node), build "
                      << std::chrono::duration<double>(t1 - t0).count() << "s\n";
        };
        roundTrip(stalks::GameGraph::Mode::Exact, "exact", "stalks_exact.sprout");
        roundTrip(stalks::GameGraph::Mode::Quick, "quick", "stalks_quick.sprout");
        std::cout << (failures ? "SAVE FAIL\n" : "SAVE OK\n");
        return failures ? 1 : 0;
    }
    // Write the canonical n-spot master save files (2..6) into a directory, once. Each mode's graph
    // is built for ALL spot counts in ONE persistent graph via ensure(), so subpositions shared
    // between spot counts are computed a single time (the 5->6 overlap shaves a little off 6). Each
    // master is scoped to its own root's subtree (saveSubgraph), so the files stay strictly per-n
    // even though the live graph holds all of 2..6. STALKS_SAVE_MASTERS=<dir> (=1 => stalks/saves).
    if (const char* env = std::getenv("STALKS_SAVE_MASTERS"); env) {
        const std::string dir =
            (env[0] && std::string(env) != "1") ? std::string(env) : std::string("stalks/saves");
        std::filesystem::create_directories(dir);
        auto startPos = [](int n) { return stalks::parsePosition(startEncoding(n)); };
        bool allGood = true;
        auto masters = [&](stalks::GameGraph::Mode mode, const char* tag) {
            stalks::GameGraph g(mode);
            for (int n = 2; n <= 7; ++n) {
                const auto t0 = std::chrono::steady_clock::now();
                int off = 0;
                stalks::Node* root = g.ensure(startPos(n), &off);  // reuses everything already built
                const int trueVal = root->nimber ^ off;
                const std::string path =
                    dir + "/" + std::to_string(n) + "_spot_master_" + tag + ".sprout";
                const std::size_t cnt = stalks::saveSubgraphToFile(g, root, path);
                const auto bytes = std::ifstream(path, std::ios::binary | std::ios::ate).tellg();
                // Reload and confirm the start position's value round-trips off disk.
                const stalks::SolvedDB db = stalks::loadGraphFromFile(path);
                stalks::SolvedDB::Value v;
                int loadOff = 0;
                const bool ok = db.value(startPos(n), v, &loadOff);
                const bool good = ok && (v.nimber ^ loadOff) == trueVal && db.size() == cnt;
                allGood = allGood && good;
                std::cout << "  " << path << ": " << cnt << " nodes, " << bytes << " bytes ("
                          << std::chrono::duration<double>(std::chrono::steady_clock::now() - t0)
                                 .count()
                          << "s incremental, graph now " << g.size() << " nodes) "
                          << (good ? "[verified G" + std::to_string(trueVal) + "]" : "[VERIFY FAIL]")
                          << "\n"
                          << std::flush;
            }
        };
        std::cout << "exact masters ->\n";
        masters(stalks::GameGraph::Mode::Exact, "exact");
        std::cout << "quick masters ->\n";
        masters(stalks::GameGraph::Mode::Quick, "quick");
        std::cout << (allGood ? "masters written + verified to " : "MASTERS VERIFY FAILED in ") << dir
                  << "\n";
        return allGood ? 0 : 1;
    }
    // Reverse search: given a target position, report every position in the n-spot structural
    // game tree whose real-move children include it (its parents), with the child count.
    if (const char* tgt = std::getenv("STALKS_PARENTS"); tgt) {
        const int n = std::getenv("STALKS_SPOTS") && std::atoi(std::getenv("STALKS_SPOTS")) > 0
                          ? std::atoi(std::getenv("STALKS_SPOTS"))
                          : 4;
        const std::string target =
            ser(stalks::canonicalize(stalks::parsePosition(tgt)));
        std::cout << "target: " << target << "   (" << n << "-spot)\n" << std::flush;
        auto moveDesc = [](const stalks::EdgeTag& t) {
            auto tok = [](stalks::Token x) -> std::string {
                switch (x) {
                    case 0: return "spot";
                    case 1: return "appendage";
                    case 2: return "scab";
                    case 4: return "hollow";
                    default: return "tok" + std::to_string(static_cast<int>(x));
                }
            };
            std::string s = t.kind == stalks::MoveKind::Enclosure  ? "enclosure"
                            : t.kind == stalks::MoveKind::Join      ? "join"
                                                                    : "interior";
            s += " " + tok(t.endpoint1) + (t.selfConnect ? "->self" : "-") + tok(t.endpoint2);
            return s;
        };
        const std::string start = startEncoding(n);
        // Enumerate the whole structural tree.
        const stalks::Position root = stalks::canonicalize(stalks::parsePosition(start));
        std::set<std::string> visited{ser(root)};
        std::vector<stalks::Position> stack{root}, all{root};
        while (!stack.empty()) {
            const stalks::Position p = std::move(stack.back());
            stack.pop_back();
            for (auto& c : structChildren(p))
                if (visited.insert(ser(c)).second) {
                    stack.push_back(c);
                    all.push_back(std::move(c));
                }
        }
        std::cout << "tree " << all.size() << " positions\n" << std::flush;
        int parents = 0;
        for (const auto& p : all) {
            const std::string ps = ser(p);
            if (ps == target)
                continue;
            for (const auto& [c, tag] : stalks::childrenAllTagged(p)) {
                if (ser(c) == target) {
                    ++parents;
                    std::cout << "  PARENT: " << ps << "   via " << moveDesc(tag) << "\n";
                    break;
                }
            }
        }
        std::cout << "(" << parents << " parents)\n";
        return 0;
    }
    if (const char* env = std::getenv("STALKS_TREE"); env) {
        const int n = std::atoi(env) > 0 ? std::atoi(env) : 2;
        for (const auto& s : treeSet(n, std::getenv("STALKS_DECOMP") != nullptr))
            std::cout << s << "\n";
        return 0;
    }
    if (const char* env = std::getenv("STALKS_COUNT"); env) {
        const int maxSpots = std::atoi(env) > 0 ? std::atoi(env) : 5;
        const bool decomp = std::getenv("STALKS_DECOMP") != nullptr;
        for (int n = 2; n <= maxSpots; ++n) {
            const auto t0 = std::chrono::steady_clock::now();
            const long long c = treeCount(n, decomp);
            const auto t1 = std::chrono::steady_clock::now();
            const double secs = std::chrono::duration<double>(t1 - t0).count();
            std::cout << n << "-spot: " << c << " positions  (" << secs << "s)\n";
        }
        return 0;
    }
    try {
        testBoundaryOps();
        testParseSerialize();
        testPlanarityRule();
        testDecompression();
        testLives();
        testEnclosures();
        testJoins();
        testProvenance();
        testInteriorPseudo();
        testRecompress();
        testCanon();
        testCollections();
        testQuickNimber();
        testDriver();
        testRegression();
    } catch (const std::exception& e) {
        std::cout << "UNCAUGHT: " << e.what() << std::endl;
        return 2;
    }

    std::cout << (failures ? "FAILED" : "ok") << " (" << (checks - failures) << "/"
              << checks << " checks passed)\n";
    return failures ? 1 : 0;
}
