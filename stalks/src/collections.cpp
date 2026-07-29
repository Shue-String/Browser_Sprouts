#define _CRT_SECURE_NO_WARNINGS  // std::getenv for the STALKS_COLLECTIONS toggle

#include "collections.hpp"

#include "boundary.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <cstdlib>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace stalks {

namespace {

// ---------------------------------------------------------------------------
// Left-side representation. A left side is (for now) a single region -- a set of boundaries --
// in which some tokens are crit ports. Crit ports are sentinel tokens beyond the normal 0-9
// range; port i is PORT0 + i and renders as 'a' + i. The seed S1/S2 rosters are all
// single-region and single-crit; the representation carries k ports so double-crit (S3/S4) is
// additive (see notes/advanced_collections_plan.md). Multi-region left sides ('|') are not yet
// needed by any roster and are rejected.
// ---------------------------------------------------------------------------
constexpr Token PORT0 = 10;
constexpr int MAX_PORTS = 26;

bool isPort(Token t) { return t >= PORT0 && t < PORT0 + MAX_PORTS; }

// Parse the inner text of a left-side encoding (the part between '[' and '/') into a single
// region: digits 0-9 -> point/pseudo tokens, 'a'..'z' -> ordered crit ports, ',' -> boundary
// separator. Brackets, the '/' divider, and whitespace are tolerated and ignored. Uppercase
// membrane letters and '9'/'|' are rejected: a single-region left side has no ordinary paired
// membranes (a membrane cannot pair a region to itself) and no interior region separators.
std::vector<Bnd> parseLeftSide(const std::string& enc) {
    std::vector<Bnd> region;
    Bnd cur;
    bool sawPort = false;
    auto flush = [&]() {
        if (cur.empty())
            throw EncodingError("empty boundary in left side: '" + enc + "'");
        region.push_back(cur);
        cur.clear();
    };
    for (char ch : enc) {
        if (ch == ',') {
            flush();
        } else if (ch >= '0' && ch <= '8') {
            cur.push_back(static_cast<Token>(ch - '0'));
        } else if (ch >= 'a' && ch <= 'z') {
            cur.push_back(static_cast<Token>(PORT0 + (ch - 'a')));
            sawPort = true;
        } else if (ch == '[' || ch == ']' || ch == '/' || ch == ' ' || ch == '\t') {
            continue;  // tolerate the framing punctuation
        } else if (ch == '9') {
            throw EncodingError("agnostic membrane '9' has no meaning in a left side: '" + enc + "'");
        } else if (ch >= 'A' && ch <= 'Z') {
            throw EncodingError("ordinary membrane letters are not valid in a single-region "
                                "left side: '" + enc + "'");
        } else {
            throw EncodingError(std::string("unexpected character '") + ch + "' in left side");
        }
    }
    flush();  // final boundary
    if (!sawPort)
        throw EncodingError("left side has no crit port: '" + enc + "'");
    return region;
}

// Render a canonical boundary to key characters (digits as-is, ports as 'a','b',...).
std::string bndKey(const Bnd& b) {
    std::string s;
    s.reserve(b.size());
    for (Token t : b)
        s.push_back(isPort(t) ? static_cast<char>('a' + (t - PORT0))
                              : static_cast<char>('0' + t));
    return s;
}

// Geometric canonical key of a marked region with ports treated as fixed colors: each boundary
// to its least rotation, boundaries sorted within the region (a region's boundary components are
// an unordered set), minimized over the two chiralities. Crit ports ride along as ordinary tokens.
std::string geometricKey(const std::vector<Bnd>& region) {
    std::optional<std::string> best;
    for (int mir = 0; mir < 2; ++mir) {
        std::vector<std::string> keys;
        keys.reserve(region.size());
        for (const Bnd& b0 : region)
            keys.push_back(bndKey(canonicalRotation(mir ? mirrored(b0) : b0)));
        std::sort(keys.begin(), keys.end());
        std::string joined;
        for (std::size_t i = 0; i < keys.size(); ++i) {
            if (i)
                joined.push_back(',');
            joined += keys[i];
        }
        if (!best || joined < *best)
            best = std::move(joined);
    }
    return *best;
}

// Canonical key of a left side. Boundary PARTITION is significant -- a left side matches a
// collection element only if it is EXACTLY that element, and (author 2026-07-06) the crit
// partition in particular changes the nimber (e.g. [2,2,A,B/ != [2,2,AB/: adjacent crits let an
// enclosure separate the scabs). So we do NOT merge boundaries.
//
// The k crit ports are an UNORDERED set of distinct colors: which physical membrane we call 'a'
// vs 'b' is an arbitrary extraction choice, so we minimize over all k! port relabelings in
// addition to the geometric symmetries. For k=1 (S1/S2) there is one port, so this is the
// identity and every existing single-crit key is unchanged; for k=2 (S3/S4) it collapses a left
// side and its port-swap ([.,βα/ and [.,αβ/) to one key -- they are the same left side under crit
// renaming. Treating the two crits as interchangeable is sound for the left-side match (the swap
// re-wires the same physical hosts); it is gated end to end by testQuickNimber.
std::string regionKey(const std::vector<Bnd>& region) {
    std::set<Token> portSet;
    for (const Bnd& b : region)
        for (Token t : b)
            if (isPort(t))
                portSet.insert(t);
    const std::vector<Token> ports(portSet.begin(), portSet.end());  // sorted ascending

    std::vector<Token> perm = ports;
    std::optional<std::string> best;
    do {
        std::vector<Bnd> relabeled;
        relabeled.reserve(region.size());
        for (const Bnd& b : region) {
            Bnd nb;
            nb.reserve(b.size());
            for (Token t : b) {
                if (isPort(t)) {
                    const auto it = std::lower_bound(ports.begin(), ports.end(), t);
                    nb.push_back(perm[static_cast<std::size_t>(it - ports.begin())]);
                } else {
                    nb.push_back(t);
                }
            }
            relabeled.push_back(std::move(nb));
        }
        std::string k = geometricKey(relabeled);
        if (!best || k < *best)
            best = std::move(k);
    } while (std::next_permutation(perm.begin(), perm.end()));
    return *best;
}

// ---------------------------------------------------------------------------
// Crit-finder + left-side extraction (single-crit / single-region scope).
//
// A single-crit bridge whose detached chunk is one region is exactly a LEAF region: a region
// with exactly one crit occurrence. Cutting that crit detaches just that region (any second crit
// would keep it attached, so it would not be a bridge; any internal membrane would need a second
// region). This mirrors the DisaPoint case in canon.cpp's allCompressions (a {scab+membrane}
// leaf), generalized to any leaf whose marked form is a registered collection element. Multi-
// region detached chunks are left for a later increment; they simply produce no candidate here
// (and get handled after inner swaps collapse them).
//
// A "crit occurrence" is either a real membrane paired to a host elsewhere (repointable in
// surgery), OR a special-point token (ALPHA, ...; see tokens.hpp) -- a special point already
// stands for "connects to somewhere outside this position," playing the identical structural
// role a crit membrane plays once its far side is known, so it is treated uniformly as a crit
// with no host to repoint. This is shared by both the single-crit (S1/S2, below) and double-crit
// (S3/S4, further down) finders.
// ---------------------------------------------------------------------------

// Total membrane occurrences in a region (used only by the separate crit-cell congruity finder
// further down, which is not special-point-aware -- see its own doc comment).
int regionMembraneCount(const std::vector<Bnd>& region) {
    int n = 0;
    for (const auto& b : region)
        for (Token t : b)
            if (t == MEMB)
                ++n;
    return n;
}

struct CritSlot {
    bool special = false;
    Token tok = 0;     // valid iff special
    int pairing = -1;  // index into Component::pairings; valid iff !special
};

// The crit-eligible occurrences of region `I`, in boundary/occurrence order (this is also the
// port-assignment order markedRegion below uses, so slot i here corresponds to port i there).
// Eligible only when there are EXACTLY `k` such occurrences, every counted membrane is validly
// paired (an agnostic membrane is never a crit, and its mere presence disqualifies the region --
// markedRegion marks every membrane unconditionally, so an unmarked stray one would corrupt the
// key), and no two real-membrane slots share a pairing (both sides of one pairing sitting in the
// same region -- a self-pairing, not a valid two-region cut). Nullopt when ineligible.
std::optional<std::vector<CritSlot>> critSlots(const Component& c,
                                                const std::vector<std::vector<std::vector<int>>>& idx,
                                                std::uint32_t I, int k) {
    std::vector<CritSlot> out;
    for (std::uint32_t b = 0; b < c.regions[I].size(); ++b) {
        std::uint32_t occ = 0;
        for (Token t : c.regions[I][b]) {
            if (isSpecialPoint(t)) {
                out.push_back(CritSlot{true, t, -1});
            } else if (t == MEMB) {
                const int pi = idx[I][b][occ++];
                if (pi < 0)
                    return std::nullopt;  // agnostic membrane: region ineligible
                out.push_back(CritSlot{false, 0, pi});
            }
        }
    }
    if (static_cast<int>(out.size()) != k)
        return std::nullopt;
    for (std::size_t i = 0; i < out.size(); ++i)
        for (std::size_t j = i + 1; j < out.size(); ++j)
            if (!out[i].special && !out[j].special && out[i].pairing == out[j].pairing)
                return std::nullopt;
    return out;
}

// Mark every crit occurrence in a region (real membranes AND special points, uniformly) as an
// ordered port; every other token rides along unchanged. Used to build a region's registry key
// for both the single- and double-crit finders. The assignment order here is arbitrary --
// regionKey (above) already minimizes over every port permutation to find the canonical key --
// only the SET of which occurrences are marked matters, and that set is exactly what critSlots
// (above) independently validated as this region's crit occurrences.
std::vector<Bnd> markedRegion(const std::vector<Bnd>& region) {
    std::vector<Bnd> out;
    out.reserve(region.size());
    int port = 0;
    for (const Bnd& b : region) {
        Bnd nb;
        nb.reserve(b.size());
        for (Token t : b)
            nb.push_back((t == MEMB || isSpecialPoint(t)) ? static_cast<Token>(PORT0 + port++) : t);
        out.push_back(std::move(nb));
    }
    return out;
}

// One candidate single-crit collections swap: region `leftRegion`'s one crit occurrence, plus
// the left side's canonical key for registry lookup.
struct CritCandidate {
    std::uint32_t leftRegion = 0;
    CritSlot slot;
    std::string leftKey;
};

std::vector<CritCandidate> enumerateCrits(const Component& c) {
    std::vector<CritCandidate> out;
    if (c.dead)
        return out;
    const auto idx = c.pairIndex();
    for (std::uint32_t I = 0; I < c.regions.size(); ++I) {
        const auto slots = critSlots(c, idx, I, 1);
        if (!slots)
            continue;
        CritCandidate cand;
        cand.leftRegion = I;
        cand.slot = (*slots)[0];
        cand.leftKey = regionKey(markedRegion(c.regions[I]));
        out.push_back(std::move(cand));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Double-crit (S3/S4) finder + left-side extraction (single-region, k=2 scope).
//
// A single-region double-crit left side is a region with EXACTLY two membrane occurrences, both
// paired outward (crits) with distinct pairings. A region's only links to the rest of the position
// are its membrane pairings, so cutting both membranes fully detaches the region -- it is a valid
// 2-crit left side for any right side. This is the k=2 analogue of the single-crit leaf; the
// crit-count-generic key machinery (regionKey + ports) already handles two ports. The genuinely
// hard multi-region 2-edge-cut finder ("crits on different organs") is still deferred; the S3/S4
// rosters are all single-region, so this covers them. Bare 2-membrane cells ([ab/ hollow cell)
// surface here too, but are absent from the S3/S4 registry (the crit-cell merge owns them), and
// the shared rep [2βα/ is likewise absent so a region already in rep form never re-swaps.
// ---------------------------------------------------------------------------

// One candidate double-crit collections swap: region `region`'s two crit occurrences (each
// independently real or special, per critSlots above), plus the left side's canonical key.
struct DoubleCritCandidate {
    std::uint32_t region = 0;
    CritSlot slot1;
    CritSlot slot2;
    std::string leftKey;
};

std::vector<DoubleCritCandidate> enumerateDoubleCrits(const Component& c) {
    std::vector<DoubleCritCandidate> out;
    if (c.dead)
        return out;
    const auto idx = c.pairIndex();
    for (std::uint32_t R = 0; R < c.regions.size(); ++R) {
        const auto slots = critSlots(c, idx, R, 2);
        if (!slots)
            continue;
        DoubleCritCandidate cand;
        cand.region = R;
        cand.slot1 = (*slots)[0];
        cand.slot2 = (*slots)[1];
        cand.leftKey = regionKey(markedRegion(c.regions[R]));
        out.push_back(std::move(cand));
    }
    return out;
}

}  // namespace

std::string leftSideKey(const std::string& leftSideEncoding) {
    return regionKey(parseLeftSide(leftSideEncoding));
}

std::vector<std::string> detachableLeftSideKeys(const Position& p) {
    std::vector<std::string> out;
    for (const auto& c : p.components)
        for (const auto& cand : enumerateCrits(c))
            out.push_back(cand.leftKey);
    return out;
}

bool collectionsEnabled() {
    const char* v = std::getenv("STALKS_COLLECTIONS");
    return v && v[0] != '\0' && !(v[0] == '0' && v[1] == '\0');
}

namespace {

// ---------------------------------------------------------------------------
// Collection registry + the swap that applies a match.
// ---------------------------------------------------------------------------

// leftSideKey -> offset. Built once from the authored rosters (canonicalized through the same
// leftSideKey path as extraction, so the keys line up by construction). Extend by adding rows.
// Every S1/S2 element swaps to the same shape applyCritSwap below always builds for a k=1 match
// ([SCAB, crit]); when the crit is a real membrane this is the DECOMPRESSED form of a DisaPoint,
// which the very next canonicalizeFull pass's existing DisaPoint recompression folds back into a
// bare DISA token automatically (see canon.cpp::allCompressions) -- so there is no separate `rep`
// to carry here, unlike an earlier version of this registry.
const std::map<std::string, int>& registry() {
    static const std::map<std::string, int> reg = [] {
        std::map<std::string, int> m;
        auto add = [&](std::initializer_list<const char*> elems, int off) {
            for (const char* e : elems)
                m[leftSideKey(e)] = off;
        };
        // S1 (offset 0). Lowest-order element [2a/ is deliberately OMITTED: it is exactly the
        // shape applyCritSwap itself builds for any k=1 match ([SCAB, crit]), so a region already
        // in this rep form must never re-match itself (it would loop with no progress) -- mirrors
        // why the double-crit registry omits its own rep "2ba" (see doubleCritRegistry below).
        // For a REAL-membrane crit this was always unreachable anyway (already folded away by
        // ordinary DisaPoint compression before the collections pass ever sees it), but a
        // special-point crit's [SCAB, α] does NOT auto-compress (compression only applies to
        // real membrane pairs), so it stays reachable here and must be excluded explicitly.
        add({"2,a", "0,a", "2,2,2,a", "1,2a", "5,2a", "23,2a", "2,2,3,a",
             "13a", "23,3a", "22,2a", "2,3,3,a", "1,3a", "3,23,a", "22,3a", "17a8"},
            0);
        // S2 (offset 1).
        add({"1a", "1,a", "5a", "5,a", "2,2a", "22a", "2,2,a", "27a8",
             "2,3a", "23a", "2,3,a", "37a8", "3,2a", "0,2a", "0,3a"},
            1);
        return m;
    }();
    return reg;
}

// Double-crit S3/S4 rosters (Theorem 1 tables; author 2026-07-05, "..." elements open via the
// extension theorems). Keyed by the port-permutation-canonical left-side key; value = offset (S3
// -> 0, S4 -> 1, from the Pairing Theorem G(s3) = G(s4) ^ 1). Every element swaps to the SINGLE
// shared representative [2βα/ = [SCAB, MEMB, MEMB] (see applyCritSwap). The rep's own element
// [2βα/ ("2ba") is deliberately OMITTED: a region already in rep form must never re-swap (it would
// loop with no progress), and leaving it out makes the finder skip it. Every listed element has
// boundary count >= 2 or token count >= 4, so each swap strictly reduces (tokens, boundaries) and
// the quickCanon fixpoint still terminates.
const std::map<std::string, int>& doubleCritRegistry() {
    static const std::map<std::string, int> reg = [] {
        std::map<std::string, int> m;
        auto add = [&](std::initializer_list<const char*> elems, int off) {
            for (const char* e : elems)
                m[leftSideKey(e)] = off;
        };
        // S3 (offset 0): [0,βα/, [β7α8/, [2,βα/, [β,2α/, [2,β,α/. ([2βα/ omitted -- it is the rep.)
        add({"0,ba", "b7a8", "2,ba", "b,2a", "2,b,a"}, 0);
        // S4 (offset 1): [1,βα/, [22,βα/, [5,βα/, [23,βα/, [3β,2α/.
        add({"1,ba", "22,ba", "5,ba", "23,ba", "3b,2a"}, 1);
        return m;
    }();
    return reg;
}

// Apply a matched crit swap (k=1 or k=2): replace region R's ENTIRE content with one new
// boundary [SCAB, slot0, (slot1)]. A special-point slot keeps its own token in place -- it has
// no separate host, since it already stands for "connects to somewhere outside this position".
// A real-membrane slot becomes a fresh membrane occurrence, with its ORIGINAL pairing re-pointed
// onto its new occurrence here (0 for slots[0], 1 for slots[1]) so its host elsewhere is
// preserved -- exactly the old applyDoubleCritSwap's repoint step, generalized from exactly 2
// slots to 1 or 2. The region keeps its own index; nothing is ever deleted or reindexed, so
// there is no separate host-region bookkeeping to repair (unlike the old, now-removed, k=1-only
// applySwap, which wrote a bare DISA directly into a separate host and deleted the leaf: that
// direct-compressed result and this decompressed-then-auto-recompressed one are the same final
// canonical position whenever the sole crit is real, see the registry's doc comment above).
Component applyCritSwap(const Component& c, std::uint32_t R, const std::vector<CritSlot>& slots) {
    Bnd newBnd;
    newBnd.push_back(SCAB);
    for (const auto& slot : slots)
        newBnd.push_back(slot.special ? slot.tok : MEMB);

    Component out;
    out.dead = c.dead;
    out.regions.reserve(c.regions.size());
    for (std::uint32_t r = 0; r < c.regions.size(); ++r)
        out.regions.push_back(r == R ? std::vector<Bnd>{newBnd} : c.regions[r]);

    auto repoint = [&](std::pair<MRef, MRef> pr, std::uint32_t newOcc) {
        if (pr.first.region == R)
            pr.first = MRef{R, 0u, newOcc};
        else
            pr.second = MRef{R, 0u, newOcc};
        return pr;
    };
    out.pairings.reserve(c.pairings.size());
    for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
        int matchedSlot = -1;
        for (std::size_t i = 0; i < slots.size(); ++i)
            if (!slots[i].special && slots[i].pairing == pi)
                matchedSlot = static_cast<int>(i);
        if (matchedSlot >= 0)
            out.pairings.push_back(repoint(c.pairings[static_cast<std::size_t>(pi)],
                                            static_cast<std::uint32_t>(matchedSlot)));
        else
            out.pairings.push_back(c.pairings[static_cast<std::size_t>(pi)]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Crit-cell congruity (the hollow-cell family of simple collections). A region whose tokens are
// EXACTLY k>=2 membranes, all crits (paired to the OUTSIDE, distinct pairings -- not to each
// other), and nothing else, plays identically for ANY right side y regardless of how the k crits
// are partitioned into boundaries. k=2 is the hollow cell C_[ab/ = {[ab/y],[a,b/y]} (Shue, PROVEN
// closed). k=3 is C_[abc/ = {[abc/],[a,bc/],[a,b,c/]} (closure UNPROVEN; adopted empirically per
// author 2026-07-07, gated by testQuickNimber -- a false merge would surface there as a nimber
// mismatch). All offset 0 (simple collections).
//
// We canonicalize toward the SINGLE-BOUNDARY form ([9..9], all k crits on one boundary). Two
// reasons this is the correct direction:
//   1. Planarity. Merging boundaries only ever COLLAPSES body parts, so it can never create a
//      body-part-connectivity violation -- the merged form is always a valid position. Splitting
//      does the opposite: [AB|1A1B] is valid but its split [A,B|1A1B] is NOT drawable (region 0's
//      two body parts get membrane-connected through region 1), so a split direction can emit
//      invalid positions.
//   2. Ordering is a non-issue. Once the cell is one boundary, canonicalizeFull already unifies
//      every cyclic order of the k crits (rotation gives 3 of 6 for k=3; global mirror + region
//      reorder + first-occurrence relettering gives the rest -- verified: [ABC|y] and [ACB|y]
//      canon-equal AND nimber-equal even for asymmetric y). So merging in any boundary/occurrence
//      order lands on the same canonical form; no per-k ordering layer is needed.
//
// CRITICAL (author 2026-07-06): the cell must be EXACTLY the crits. This is the EXACT-match redo of
// the "universal congruity" flatten REMOVED that day, which fired whenever a region merely
// CONTAINED >=2 crit-only boundaries and ignored other tokens -- unsound, because any extra token
// makes the crit partition value-significant ([2,2,A,B|2A|2B]=G1 vs [2,2,AB|2A|2B]=G2). Hence the
// all-membrane requirement. Being dormant on 2/3-spot hid the old bug; testQuickNimber now covers
// 4/5-spot.
// ---------------------------------------------------------------------------

// Regions that are crit cells not already merged to a single boundary (so merging changes them).
std::vector<std::uint32_t> enumerateCritCells(const Component& c) {
    std::vector<std::uint32_t> out;
    if (c.dead)
        return out;
    const auto idx = c.pairIndex();
    for (std::uint32_t R = 0; R < c.regions.size(); ++R) {
        const auto& reg = c.regions[R];
        if (reg.size() < 2)
            continue;  // already a single boundary (or empty): canonical, nothing to merge

        // Exactly the crits: every token in the region is a membrane, at least two of them.
        std::size_t membs = 0;
        bool allMemb = true;
        for (const auto& b : reg) {
            for (Token t : b) {
                if (t != MEMB) {
                    allMemb = false;
                    break;
                }
                ++membs;
            }
            if (!allMemb)
                break;
        }
        if (!allMemb || membs < 2 || membs > 3)
            continue;  // only k=2 (C_[ab/) and k=3 (C_[abc/) are claimed collections

        // All membranes paired (crits) with DISTINCT pairings -- none paired to each other or to
        // this region itself (either would collapse two occurrences onto one pairing index).
        std::set<int> pis;
        bool ok = true;
        for (std::uint32_t b = 0; b < reg.size() && ok; ++b)
            for (std::uint32_t o = 0; o < reg[b].size(); ++o) {
                const int pi = idx[R][b][o];
                if (pi < 0 || !pis.insert(pi).second) {
                    ok = false;
                    break;
                }
            }
        if (!ok || pis.size() != membs)
            continue;

        out.push_back(R);
    }
    return out;
}

// Merge a crit cell's boundaries into one [9..9] boundary, repairing pairings: each membrane
// occurrence (in region-traversal order) becomes an occurrence of the single new boundary. No
// region is deleted, so only region R's own boundary indices/occurrences move. Merging only
// reduces R's body-part count, so the result is always a valid position.
Component mergeCritCell(const Component& c, std::uint32_t R) {
    std::map<std::pair<std::uint32_t, std::uint32_t>, std::uint32_t> newOcc;
    std::uint32_t k = 0;
    for (std::uint32_t b = 0; b < c.regions[R].size(); ++b)
        for (std::uint32_t o = 0; o < c.regions[R][b].size(); ++o)
            newOcc[{b, o}] = k++;  // every token in a crit cell is a membrane

    Component out;
    out.dead = c.dead;
    out.regions.reserve(c.regions.size());
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        if (r != R) {
            out.regions.push_back(c.regions[r]);
            continue;
        }
        Bnd merged(k, MEMB);
        out.regions.push_back({std::move(merged)});
    }

    auto remap = [&](MRef m) -> MRef {
        if (m.region != R)
            return m;
        return MRef{R, 0u, newOcc.at({m.boundary, m.occ})};
    };
    out.pairings.reserve(c.pairings.size());
    for (const auto& pr : c.pairings)
        out.pairings.push_back({remap(pr.first), remap(pr.second)});
    return out;
}

// Boundary rewrite 22 == 1 (author-provided): a whole boundary of two scabs plays identically
// to a lone appendage. Same nimber (offset 0), quickCanon layer only. Returns whether it changed
// anything. No membranes are involved, so pairings are untouched.
bool rewrite22(Position& p) {
    bool changed = false;
    for (auto& c : p.components)
        for (auto& region : c.regions)
            for (auto& b : region)
                if (b.size() == 2 && b[0] == SCAB && b[1] == SCAB) {
                    b.assign(1, APPE);
                    changed = true;
                }
    return changed;
}

// The quickCanon base canonicalization: full canon (DisaPoints as '3') plus the 22==1 rewrite,
// iterated to a fixpoint (a rewrite can shift the canonical form, which is re-normalized).
Position normalizeQuick(const Position& p) {
    Position c = canonicalizeFull(p);
    while (rewrite22(c))
        c = canonicalizeFull(c);
    return c;
}

}  // namespace

QuickCanonResult quickCanon(const Position& p) {
    // Base form uses '3' for DisaPoints (Advanced mode) and applies the 22==1 rewrite.
    // quickCanon always performs the reduction; the STALKS_COLLECTIONS toggle is applied by the
    // caller (it chooses quickCanon vs the exact canonicalize pipeline).
    Position cur = normalizeQuick(p);
    int offset = 0;

    // Fixpoint: each round, gather every registry-matching single-crit swap (each carries its
    // offset) and apply the one whose canonical result is lexicographically least (a
    // deterministic, reproducible choice). Each swap deletes a region, so this terminates. A swap
    // can expose a further crit, so we loop until none apply -- the recursive-collections
    // requirement. (The 22==1 rewrite is folded into normalizeQuick, applied to every candidate.)
    while (true) {
        bool found = false;
        std::string bestSer;
        Position bestPos;
        int bestOff = 0;
        auto consider = [&](Position&& np, int offDelta) {
            Position canon = normalizeQuick(np);
            std::string s = serialize(canon);
            if (!found || s < bestSer) {
                found = true;
                bestSer = std::move(s);
                bestPos = std::move(canon);
                bestOff = offDelta;
            }
        };
        for (std::size_t ci = 0; ci < cur.components.size(); ++ci) {
            const Component& comp = cur.components[ci];
            // Content swaps (S1/S2): reduce a single-crit region to [SCAB, crit].
            for (const auto& cand : enumerateCrits(comp)) {
                const auto it = registry().find(cand.leftKey);
                if (it == registry().end())
                    continue;
                Position np = cur;
                np.components[ci] = applyCritSwap(comp, cand.leftRegion, {cand.slot});
                consider(std::move(np), it->second);
            }
            // Crit-cell congruity (hollow-cell family, offset 0): merge a k>=2 crit cell to a
            // single boundary. Strictly reduces the boundary count, so the fixpoint still
            // terminates (region-deleting swaps + boundary-reducing merges, both bounded below).
            for (std::uint32_t R : enumerateCritCells(comp)) {
                Position np = cur;
                np.components[ci] = mergeCritCell(comp, R);
                consider(std::move(np), 0);
            }
            // Double-crit content swaps (S3/S4): replace a two-crit chunk with the shared rep
            // [2βα/, accumulating its offset. Strictly reduces (tokens, boundaries), so the
            // fixpoint still terminates.
            for (const auto& cand : enumerateDoubleCrits(comp)) {
                const auto it = doubleCritRegistry().find(cand.leftKey);
                if (it == doubleCritRegistry().end())
                    continue;
                Position np = cur;
                np.components[ci] = applyCritSwap(comp, cand.region, {cand.slot1, cand.slot2});
                consider(std::move(np), it->second);
            }
        }
        if (!found)
            break;
        cur = std::move(bestPos);
        offset ^= bestOff;
    }
    return {cur, offset};
}

}  // namespace stalks
