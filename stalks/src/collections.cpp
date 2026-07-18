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
// with exactly one membrane occurrence. Cutting that membrane detaches just that region (any
// second membrane would keep it attached, so the membrane would not be a bridge; any internal
// membrane would need a second region). This mirrors the DisaPoint case in canon.cpp's
// allCompressions (a {scab+membrane} leaf), generalized to any leaf whose marked form is a
// registered collection element. Multi-region detached chunks are left for a later increment;
// they simply produce no candidate here (and get handled after inner swaps collapse them).
// ---------------------------------------------------------------------------

// Token index of the occ-th MEMB in a boundary, or -1.
int membPos(const Bnd& b, std::uint32_t occ) {
    std::uint32_t seen = 0;
    for (int i = 0; i < static_cast<int>(b.size()); ++i)
        if (b[static_cast<std::size_t>(i)] == MEMB) {
            if (seen == occ)
                return i;
            ++seen;
        }
    return -1;
}

// Total membrane occurrences in a region.
int regionMembraneCount(const std::vector<Bnd>& region) {
    int n = 0;
    for (const auto& b : region)
        for (Token t : b)
            if (t == MEMB)
                ++n;
    return n;
}

// Marked-chunk boundaries for a leaf region: its single membrane occurrence (at boundary pb,
// occurrence po) becomes the crit port; every other token rides along. (Any stray membrane --
// impossible for a true leaf -- would render as '9' and never match a roster element.)
std::vector<Bnd> markedLeaf(const std::vector<Bnd>& region, std::uint32_t pb, std::uint32_t po) {
    std::vector<Bnd> out;
    out.reserve(region.size());
    for (std::uint32_t b = 0; b < region.size(); ++b) {
        Bnd nb;
        nb.reserve(region[b].size());
        std::uint32_t occ = 0;
        for (Token t : region[b]) {
            if (t == MEMB) {
                nb.push_back(b == pb && occ == po ? PORT0 : MEMB);
                ++occ;
            } else {
                nb.push_back(t);
            }
        }
        out.push_back(std::move(nb));
    }
    return out;
}

// One candidate collections swap: replace the crit membrane in the host region with a DisaPoint
// and delete the detached leaf region. Carries the left side's canonical key for registry
// lookup. `hostPos` is the token index of the crit in the host boundary (ready for the
// applyCompress-style surgery in the swap step).
struct CritCandidate {
    std::uint32_t hostRegion = 0;
    std::uint32_t hostBnd = 0;
    int hostPos = -1;
    std::uint32_t leftRegion = 0;
    int pairing = -1;  // index into Component::pairings of the crit membrane
    std::string leftKey;
};

std::vector<CritCandidate> enumerateCrits(const Component& c) {
    std::vector<CritCandidate> out;
    if (c.dead)
        return out;
    const auto idx = c.pairIndex();
    for (std::uint32_t I = 0; I < c.regions.size(); ++I) {
        if (regionMembraneCount(c.regions[I]) != 1)
            continue;  // leaf regions only

        // Locate the single membrane occurrence in region I and its pairing.
        std::uint32_t lb = 0, lo = 0;
        int pi = -1;
        for (std::uint32_t b = 0; b < c.regions[I].size() && pi < 0; ++b) {
            std::uint32_t occ = 0;
            for (Token t : c.regions[I][b]) {
                if (t == MEMB) {
                    if (const int p = idx[I][b][occ]; p >= 0) {
                        pi = p;
                        lb = b;
                        lo = occ;
                    }
                    break;  // exactly one membrane in a leaf
                }
            }
        }
        if (pi < 0)
            continue;  // unpaired (agnostic) membrane: not a crit

        const auto& [ra, rb] = c.pairings[static_cast<std::size_t>(pi)];
        const MRef host = (ra.region == I) ? rb : ra;

        CritCandidate cand;
        cand.hostRegion = host.region;
        cand.hostBnd = host.boundary;
        cand.hostPos = membPos(c.regions[host.region][host.boundary], host.occ);
        cand.leftRegion = I;
        cand.pairing = pi;
        cand.leftKey = regionKey(markedLeaf(c.regions[I], lb, lo));
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

// Mark every membrane in a region as a distinct ordered port (port i for the i-th membrane in
// region-traversal order); other tokens ride along. Used for the k>=2 case where the whole set of
// membranes are the crits (contrast markedLeaf, which marks only the one crit of a leaf).
std::vector<Bnd> markedRegion(const std::vector<Bnd>& region) {
    std::vector<Bnd> out;
    out.reserve(region.size());
    int port = 0;
    for (const Bnd& b : region) {
        Bnd nb;
        nb.reserve(b.size());
        for (Token t : b)
            nb.push_back(t == MEMB ? static_cast<Token>(PORT0 + port++) : t);
        out.push_back(std::move(nb));
    }
    return out;
}

struct DoubleCritCandidate {
    std::uint32_t region = 0;
    int pi1 = -1;  // index into Component::pairings of the first crit
    int pi2 = -1;  // ... and the second
    std::string leftKey;
};

std::vector<DoubleCritCandidate> enumerateDoubleCrits(const Component& c) {
    std::vector<DoubleCritCandidate> out;
    if (c.dead)
        return out;
    const auto idx = c.pairIndex();
    for (std::uint32_t R = 0; R < c.regions.size(); ++R) {
        if (regionMembraneCount(c.regions[R]) != 2)
            continue;  // exactly two membranes -> a two-edge cut
        std::vector<int> pis;
        for (std::uint32_t b = 0; b < c.regions[R].size(); ++b) {
            std::uint32_t occ = 0;
            for (Token t : c.regions[R][b])
                if (t == MEMB)
                    pis.push_back(idx[R][b][occ++]);
        }
        // Both membranes must be crits (paired) with distinct pairings. Equal indices would mean
        // the two occurrences are the same pairing (region linked to itself) -- invalid, skip.
        if (pis.size() != 2 || pis[0] < 0 || pis[1] < 0 || pis[0] == pis[1])
            continue;

        DoubleCritCandidate cand;
        cand.region = R;
        cand.pi1 = pis[0];
        cand.pi2 = pis[1];
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

// A matched left side maps to a canonical representative (a pseudo-point token to swap in) and
// the offset within its Pairing-Theorem pair. For the whole S1/S2 family the rep is the
// DisaPoint '3' and the surgery is identical; only the offset differs (S1 -> 0, S2 -> 1). The
// `rep` field carries the future extension point (S3/S4 will use a different representative).
struct CollectionMatch {
    int offset = 0;
    Token rep = DISA;
};

// leftSideKey -> match. Built once from the authored rosters (canonicalized through the same
// leftSideKey path as extraction, so the keys line up by construction). Extend by adding rows.
const std::map<std::string, CollectionMatch>& registry() {
    static const std::map<std::string, CollectionMatch> reg = [] {
        std::map<std::string, CollectionMatch> m;
        auto add = [&](std::initializer_list<const char*> elems, int off) {
            for (const char* e : elems)
                m[leftSideKey(e)] = CollectionMatch{off, DISA};
        };
        // S1 (offset 0). Lowest-order element [2a/ is the DisaPoint itself; it is already
        // handled by canonicalizeFull's DisaPoint compression, and listing it here is a
        // harmless no-op (the leaf is gone before the collections pass sees it).
        add({"2a", "2,a", "0,a", "2,2,2,a", "1,2a", "5,2a", "23,2a", "2,2,3,a",
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
// shared representative [2βα/ = [SCAB, MEMB, MEMB] (see applyDoubleCritSwap). The rep's own element
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

// Apply a matched swap to a component: replace the crit membrane in the host boundary with the
// representative pseudo-point, drop the detached leaf region, and repair the remaining pairings
// (region indices shift past the deleted leaf; membrane occurrences after the crit in the host
// boundary shift down by one). The leaf's only membrane was the crit, so no surviving pairing
// references it.
Component applySwap(const Component& c, const CritCandidate& cand, Token rep) {
    const std::uint32_t L = cand.leftRegion, hr = cand.hostRegion, hb = cand.hostBnd;
    const int sp = cand.hostPos;

    std::uint32_t critOcc = 0;
    for (int i = 0; i < sp; ++i)
        if (c.regions[hr][hb][static_cast<std::size_t>(i)] == MEMB)
            ++critOcc;

    std::vector<int> rmap(c.regions.size(), -1);
    for (std::uint32_t r = 0, nr = 0; r < c.regions.size(); ++r)
        if (r != L)
            rmap[r] = static_cast<int>(nr++);

    Component out;
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        if (r == L)
            continue;
        std::vector<Bnd> region = c.regions[r];
        if (r == hr)
            region[hb][static_cast<std::size_t>(sp)] = rep;
        out.regions.push_back(std::move(region));
    }

    auto remap = [&](MRef m) {
        MRef n = m;
        n.region = static_cast<std::uint32_t>(rmap[m.region]);
        if (m.region == hr && m.boundary == hb && m.occ > critOcc)
            n.occ = m.occ - 1;
        return n;
    };
    for (std::size_t pi = 0; pi < c.pairings.size(); ++pi) {
        if (static_cast<int>(pi) == cand.pairing)
            continue;
        out.pairings.push_back({remap(c.pairings[pi].first), remap(c.pairings[pi].second)});
    }
    return out;
}

// Apply a double-crit (S3/S4) content swap: replace the chunk region's whole content with the
// shared representative [2βα/ -- a single boundary [SCAB, MEMB, MEMB] -- and re-point the two crit
// pairings at their original hosts. The rep is port-symmetric (its own mirror swaps the two
// membranes), so which host takes the new occurrence 0 vs 1 is immaterial; canonicalizeFull
// normalizes it. The region keeps its index and none is deleted, so only region R's own boundary/
// occurrence coordinates move; host boundaries (and their occurrence indices) are untouched.
Component applyDoubleCritSwap(const Component& c, const DoubleCritCandidate& cand) {
    const std::uint32_t R = cand.region;

    Component out;
    out.dead = c.dead;
    out.regions.reserve(c.regions.size());
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        if (r == R)
            out.regions.push_back(std::vector<Bnd>{Bnd{SCAB, MEMB, MEMB}});
        else
            out.regions.push_back(c.regions[r]);
    }

    // Re-point a pairing's R-side occurrence (the chunk had exactly two membranes, so exactly one
    // side of each of pi1/pi2 lies in R) onto the new single boundary.
    auto repoint = [&](std::pair<MRef, MRef> pr, std::uint32_t newOcc) {
        if (pr.first.region == R)
            pr.first = MRef{R, 0u, newOcc};
        else
            pr.second = MRef{R, 0u, newOcc};
        return pr;
    };
    out.pairings.reserve(c.pairings.size());
    for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
        if (pi == cand.pi1)
            out.pairings.push_back(repoint(c.pairings[static_cast<std::size_t>(pi)], 0u));
        else if (pi == cand.pi2)
            out.pairings.push_back(repoint(c.pairings[static_cast<std::size_t>(pi)], 1u));
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
            // Content swaps (S1/S2): host membrane -> DisaPoint, delete the leaf.
            for (const auto& cand : enumerateCrits(comp)) {
                if (cand.hostPos < 0)
                    continue;
                const auto it = registry().find(cand.leftKey);
                if (it == registry().end())
                    continue;
                Position np = cur;
                np.components[ci] = applySwap(comp, cand, it->second.rep);
                consider(std::move(np), it->second.offset);
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
                np.components[ci] = applyDoubleCritSwap(comp, cand);
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
