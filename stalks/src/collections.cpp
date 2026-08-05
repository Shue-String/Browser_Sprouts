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
#include <stdexcept>
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

// ---------------------------------------------------------------------------
// Multi-region ("crits on different organs") left sides -- k=1 scope. A multi-region left
// side is >=2 regions joined by their OWN internal real membranes (never crits themselves),
// detachable from the rest of the position by cutting exactly ONE crit membrane. Unlike the
// single-region path above (which has no internal membranes to canonicalize -- a lone
// region's every membrane is necessarily a crit, since a membrane can't pair a region to
// itself), a multi-region chunk's canonical key genuinely needs region/boundary
// ordering+rotation+chirality search THAT ALSO respects internal pairing identity across
// regions -- exactly the problem canon.cpp's canonMinimal/canonicalizeFull already solve for
// whole positions. Rather than duplicate that search here, a chunk is built as an ordinary
// stand-alone Component (internal membranes as real Component::pairings; the one crit
// membrane simply left OUT of pairings, so it renders as agnostic '9' via the existing
// serialize()/pairIndex() path -- no new sentinel token needed) and run through the real
// canonicalizeFull/serialize pipeline. This is additive and independent of the single-/
// double-crit machinery above: a separate registry (multiRegistry), separate finder
// (enumerateMultiCrits, a bridge search over the region-adjacency graph -- cutting a BRIDGE
// membrane is exactly "detach a connected region-set with no other outside connection"), and
// a separate swap (applyMultiCritSwap, which -- unlike applyCritSwap -- must delete the
// chunk's extra regions and reindex every reference to them, since a multi-region chunk
// collapses to a SINGLE new region at its family's rep).
// ---------------------------------------------------------------------------

// Cap on chunk size worth attempting: every authored multi-region roster element is tiny (<=3
// regions, a handful of tokens), and a bridge's "other" side is typically most of the position
// -- this cheap pre-filter (checked before the expensive canonicalizeFull call) skips it
// immediately rather than canonicalizing something that could never match a registry entry.
constexpr std::size_t MAX_MULTI_REGIONS = 3;
constexpr std::size_t MAX_MULTI_TOKENS = 12;

// A chunk's canonical registry key: wrap it as a stand-alone one-component Position and run it
// through the real structural canon + serializer (see the section doc comment above). Prefixed
// "M" so a multi-region key can never collide with a single-/double-crit regionKey (which never
// contains '|' and so never round-trips through serialize() the same way) purely by convention;
// belt-and-suspenders, not load-bearing, since the two are looked up in separate registries.
std::string multiChunkKey(const std::vector<std::vector<Bnd>>& regions,
                           const std::vector<std::pair<MRef, MRef>>& internalPairings) {
    Component chunk;
    chunk.regions = regions;
    chunk.pairings = internalPairings;
    chunk.dead = false;
    Position p;
    p.components.push_back(std::move(chunk));
    return "M" + serialize(canonicalizeFull(p));
}

// Parse a multi-region left-side encoding, e.g. "2CD|2a,CD": '|' separates regions, ',' still
// separates boundaries within a region, digits/ports as in parseLeftSide, and 'A'-'Z' are
// INTERNAL membrane labels -- each must occur exactly twice, in two different regions (the
// pairing partner is found by scanning, not authored positionally). Exactly one port ('a'-'z')
// total is required (k=1 scope; no multi-region roster needs k>=2 yet).
std::pair<std::vector<std::vector<Bnd>>, std::vector<std::pair<MRef, MRef>>>
parseChunkEncoding(const std::string& enc) {
    std::vector<std::vector<Bnd>> regions;
    std::vector<Bnd> curRegion;
    Bnd curBnd;
    std::uint32_t membOcc = 0;  // count of MEMB tokens seen so far in curBnd (pairIndex's
                                 // occurrence numbering counts membranes only, not all tokens)
    std::map<char, std::vector<MRef>> letterLocs;
    int portCount = 0;
    auto flushBnd = [&]() {
        if (curBnd.empty())
            throw EncodingError("empty boundary in chunk left side: '" + enc + "'");
        curRegion.push_back(curBnd);
        curBnd.clear();
        membOcc = 0;
    };
    auto flushRegion = [&]() {
        flushBnd();
        regions.push_back(curRegion);
        curRegion.clear();
    };
    for (char ch : enc) {
        if (ch == '|') {
            flushRegion();
        } else if (ch == ',') {
            flushBnd();
        } else if (ch >= '0' && ch <= '8') {
            curBnd.push_back(static_cast<Token>(ch - '0'));
        } else if (ch >= 'a' && ch <= 'z') {
            curBnd.push_back(MEMB);
            ++membOcc;
            ++portCount;
        } else if (ch >= 'A' && ch <= 'Z') {
            letterLocs[ch].push_back(MRef{static_cast<std::uint32_t>(regions.size()),
                                          static_cast<std::uint32_t>(curRegion.size()), membOcc});
            curBnd.push_back(MEMB);
            ++membOcc;
        } else if (ch == '[' || ch == ']' || ch == '/' || ch == ' ' || ch == '\t') {
            continue;
        } else if (ch == '9') {
            throw EncodingError("agnostic membrane '9' has no meaning in a chunk left side: '" +
                                enc + "'");
        } else {
            throw EncodingError(std::string("unexpected character '") + ch +
                                "' in chunk left side");
        }
    }
    flushRegion();
    if (portCount != 1)
        throw EncodingError("multi-region left side must have exactly one crit port: '" + enc + "'");
    if (regions.size() < 2)
        throw EncodingError("multi-region left side must have at least two regions: '" + enc + "'");

    std::vector<std::pair<MRef, MRef>> pairings;
    for (const auto& [letter, locs] : letterLocs) {
        if (locs.size() != 2)
            throw EncodingError(std::string("internal membrane '") + letter +
                                "' must appear exactly twice: '" + enc + "'");
        if (locs[0].region == locs[1].region)
            throw EncodingError(std::string("internal membrane '") + letter +
                                "' must connect two different regions: '" + enc + "'");
        pairings.push_back({locs[0], locs[1]});
    }
    return {std::move(regions), std::move(pairings)};
}

std::string multiLeftSideKey(const std::string& enc) {
    const auto [regions, pairings] = parseChunkEncoding(enc);
    return multiChunkKey(regions, pairings);
}

// One candidate multi-region swap: the chunk's original region indices (>=2, sorted), the
// original pairing index of its single crossing (crit) membrane, and its canonical key.
struct MultiCritCandidate {
    std::vector<std::uint32_t> regions;
    int crossPairing = -1;
    std::string leftKey;
};

// Bridge search over a Component's region-adjacency graph (nodes = regions, edges = real
// membrane pairings -- every pairing connects two DIFFERENT regions, Component::validate()'s "no
// region linking to itself" rule). A bridge membrane's removal splits the graph; each side is a
// candidate multi-region left side (its ONLY connection to the rest is that one membrane) PROVIDED
// it has zero special points (else its true crit count exceeds 1) and stays within the size cap.
// Graphs here are tiny (a handful of regions at n<=6), so the naive O(P*(R+P)) trial-removal scan
// is simplest and fast enough; no need for a linear-time bridge algorithm.
std::vector<MultiCritCandidate> enumerateMultiCrits(const Component& c) {
    std::vector<MultiCritCandidate> out;
    if (c.dead)
        return out;
    const std::size_t R = c.regions.size();
    struct Edge {
        std::uint32_t other;
        int pairingIdx;
    };
    std::vector<std::vector<Edge>> adj(R);
    for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
        const auto& [a, b] = c.pairings[static_cast<std::size_t>(pi)];
        adj[a.region].push_back({b.region, pi});
        adj[b.region].push_back({a.region, pi});
    }
    auto reachableExcluding = [&](std::uint32_t start, int excl) {
        std::vector<char> seen(R, 0);
        std::vector<std::uint32_t> stack{start}, order;
        seen[start] = 1;
        while (!stack.empty()) {
            const std::uint32_t u = stack.back();
            stack.pop_back();
            order.push_back(u);
            for (const auto& e : adj[u]) {
                if (e.pairingIdx == excl)
                    continue;
                if (!seen[e.other]) {
                    seen[e.other] = 1;
                    stack.push_back(e.other);
                }
            }
        }
        return order;
    };
    const auto idx = c.pairIndex();
    auto tryAdd = [&](const std::vector<std::uint32_t>& side, int excl) {
        if (side.size() < 2 || side.size() > MAX_MULTI_REGIONS)
            return;
        std::size_t tokenCount = 0, specials = 0;
        for (std::uint32_t r : side)
            for (const auto& b : c.regions[r]) {
                tokenCount += b.size();
                for (Token t : b)
                    if (isSpecialPoint(t))
                        ++specials;
            }
        if (tokenCount > MAX_MULTI_TOKENS || specials != 0)
            return;
        // Guard: a pre-existing agnostic (truly unpaired) membrane inside the side would be
        // indistinguishable from the crit port and corrupt the count -- bail (mirrors critSlots'
        // single-region agnostic guard). Never fires on real game-tree positions.
        // idx[r][b] is sized to the MEMBRANE COUNT of boundary b (Component::pairIndex()), not its
        // total token count -- must index by membrane-occurrence-so-far, not raw token position
        // (an earlier version of this loop used the token position directly and read past the end
        // of idx[r][b] whenever a boundary mixed a membrane with non-membrane tokens, e.g. "2C" --
        // undefined behavior, observed as the quickCanon fixpoint flip-flopping between two
        // different results across repeated runs of the same input).
        for (std::uint32_t r : side)
            for (std::uint32_t b = 0; b < c.regions[r].size(); ++b) {
                std::uint32_t membOcc = 0;
                for (std::uint32_t o = 0; o < c.regions[r][b].size(); ++o)
                    if (c.regions[r][b][o] == MEMB) {
                        if (idx[r][b][membOcc] < 0)
                            return;
                        ++membOcc;
                    }
            }

        std::vector<std::uint32_t> sorted = side;
        std::sort(sorted.begin(), sorted.end());
        std::map<std::uint32_t, std::uint32_t> remap;
        for (std::size_t i = 0; i < sorted.size(); ++i)
            remap[sorted[i]] = static_cast<std::uint32_t>(i);

        std::vector<std::vector<Bnd>> newRegions;
        newRegions.reserve(sorted.size());
        for (std::uint32_t r : sorted)
            newRegions.push_back(c.regions[r]);

        std::vector<std::pair<MRef, MRef>> newPairings;
        for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
            if (pi == excl)
                continue;
            const auto& [a, b] = c.pairings[static_cast<std::size_t>(pi)];
            const auto ia = remap.find(a.region), ib = remap.find(b.region);
            if (ia != remap.end() && ib != remap.end())
                newPairings.push_back({{ia->second, a.boundary, a.occ},
                                       {ib->second, b.boundary, b.occ}});
        }

        MultiCritCandidate cand;
        cand.regions = std::move(sorted);
        cand.crossPairing = excl;
        cand.leftKey = multiChunkKey(newRegions, newPairings);
        out.push_back(std::move(cand));
    };
    for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
        const auto& [a, b] = c.pairings[static_cast<std::size_t>(pi)];
        const auto sideA = reachableExcluding(a.region, pi);
        if (std::find(sideA.begin(), sideA.end(), b.region) != sideA.end())
            continue;  // not a bridge
        tryAdd(sideA, pi);
        tryAdd(reachableExcluding(b.region, pi), pi);
    }
    return out;
}

// Apply a matched multi-region swap: collapse EVERY region in `sideRegions` into ONE new region
// at the lowest of their original indices, containing exactly [head..., crit] (single-crit
// scope, matching applyCritSwap's k=1 shape); the other side regions are deleted and every
// pairing's region reference is reindexed accordingly. The chunk's internal pairings (both ends
// in sideRegions) are simply dropped -- their content is gone, replaced wholesale by the rep.
// The crossing pairing is repointed: its side-end becomes the new merged region's sole
// occurrence, its host-end just gets its region index remapped, preserving the host's link.
Component applyMultiCritSwap(const Component& c, const std::vector<std::uint32_t>& sideRegions,
                             int crossPairing, const std::vector<Token>& head) {
    auto inSide = [&](std::uint32_t r) {
        return std::find(sideRegions.begin(), sideRegions.end(), r) != sideRegions.end();
    };
    const std::uint32_t keepRegion = *std::min_element(sideRegions.begin(), sideRegions.end());

    Bnd newBnd;
    for (Token t : head)
        newBnd.push_back(t);
    newBnd.push_back(MEMB);

    // Sentinel (not 0) for deleted-region slots: if the "exactly one crossing edge" invariant
    // were ever violated, a stray read of an unset entry surfaces immediately as an out-of-range
    // EncodingError from pairIndex() instead of silently aliasing onto real region 0.
    std::vector<std::uint32_t> oldToNew(c.regions.size(), static_cast<std::uint32_t>(-1));
    Component out;
    out.dead = c.dead;
    std::uint32_t next = 0;
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        if (inSide(r) && r != keepRegion)
            continue;  // deleted -- absorbed into keepRegion's rep
        oldToNew[r] = next++;
        out.regions.push_back(r == keepRegion ? std::vector<Bnd>{newBnd} : c.regions[r]);
    }

    out.pairings.reserve(c.pairings.size());
    for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
        auto pr = c.pairings[static_cast<std::size_t>(pi)];
        if (pi == crossPairing) {
            MRef& sideEnd = inSide(pr.first.region) ? pr.first : pr.second;
            MRef& hostEnd = inSide(pr.first.region) ? pr.second : pr.first;
            hostEnd.region = oldToNew[hostEnd.region];
            sideEnd = MRef{oldToNew[keepRegion], 0u, 0u};
            out.pairings.push_back(pr);
            continue;
        }
        if (inSide(pr.first.region) && inSide(pr.second.region))
            continue;  // internal to the collapsed chunk
        pr.first.region = oldToNew[pr.first.region];
        pr.second.region = oldToNew[pr.second.region];
        out.pairings.push_back(pr);
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

// One authored roster group: a collection's name, its Pairing-Theorem offset, and its member
// left-side encodings exactly as written (pre-canonicalization). Single source of truth for BOTH
// the internal matching maps below (registry()/doubleCritRegistry()) AND the public
// allCollectionRosters() introspection API (see collections.hpp) -- so a roster edited here can
// never drift from what the Collect pane's Collections panel displays (regenerated via
// tools/dump_collections_roster.cpp).
struct RosterGroup {
    const char* name;
    int offset;
    // A std::initializer_list's OWN backing array is a temporary whose lifetime is NOT extended
    // when it's nested inside another object stored long-term (a static const std::vector<
    // RosterGroup>, here) -- only binding it directly to a variable/reference does that. A
    // std::vector, unlike initializer_list, copies its elements into owned storage, so it's safe
    // to keep around. (The const char* pointees themselves are fine either way -- string literals
    // have static storage duration; it was only the initializer_list's pointer+size VIEW that
    // would have gone dangling.)
    std::vector<const char*> elements;
};

// A family of collections sharing one swap target ("rep"): a fixed head of ordinary tokens
// (e.g. just SCAB for S1/S2's "2a"; DISA for C_3's "3a"; APPE+SCAB for S_5's "12a") followed by
// the k crit port(s). Every element across every group in a family swaps to THIS SAME rep --
// applyCritSwap below builds [head..., crit...] directly, so introducing a new family is just
// adding an entry here with its own repEncoding, no code change to the swap machinery itself.
// `repEncoding` is authored in the SAME left-side convention as `elements` (parsed once via
// headOfRep, below, to derive the actual Token head) -- so the rep can never drift from what
// applyCritSwap actually produces, and it's also what allCollectionRosters() reports for the
// Collect pane's Collections panel.
struct CritFamily {
    const char* repEncoding;
    std::vector<RosterGroup> groups;
};

// This family's own shared reduction target, as Tokens (everything in `repEncoding` except the
// trailing crit port(s) -- reps here are always exactly one boundary). Parsed via the same
// parseLeftSide path used to extract/match left sides, so the head can never disagree with what
// `repEncoding` actually denotes.
std::vector<Token> headOfRep(const char* repEncoding) {
    const std::vector<Bnd> parsed = parseLeftSide(repEncoding);
    std::vector<Token> head;
    for (Token t : parsed.at(0))
        if (!isPort(t))
            head.push_back(t);
    return head;
}

// Single-crit (k=1) families. S1/S2 share rep "2a" ([SCAB, crit]); when the crit is a real
// membrane this is the DECOMPRESSED form of a DisaPoint, which the very next canonicalizeFull
// pass's existing DisaPoint recompression folds back into a bare DISA token automatically (see
// canon.cpp::allCompressions). Each family's lowest-order/rep element itself is deliberately
// OMITTED from its own offset-0 group: it is exactly the shape applyCritSwap builds for that
// family's head, so a region already in rep form must never re-match itself (it would loop with
// no progress). For a REAL-membrane crit this is usually unreachable anyway (already folded away
// by ordinary structural compression before the collections pass ever sees it), but a
// special-point crit's [head, alpha] does NOT auto-compress (compression only applies to real
// membrane pairs), so it stays reachable and must be excluded explicitly.
//
// C_3 ("3a" = [DISA, crit]), C_4 ("4a" = [HOLL, crit]), and S_5 ("12a" = [APPE, SCAB, crit]) are
// newly authored (2026-08-03) and, unlike S1/S2, currently have only a single (offset-0) group
// each -- no Pairing-Theorem "+1" sibling has been identified for them yet. Verified sound via
// testQuickNimber up to n=5 (STALKS_QUICKNIMBER_MAX=5): every minimal position's quick-canon
// value still matches its true nimber with these three families active, exercised naturally
// through real-membrane crits arising in ordinary n<=5-spot play (special-point crits use the
// identical swap code path -- see testSpecialPointCollections for a couple of worked alpha
// examples -- so this sweep is sound evidence for the alpha case too, not just real membranes).
const std::vector<CritFamily>& singleCritFamilies() {
    static const std::vector<CritFamily> families = {
        {"2a",
         {{"S_1", 0,
           {"2,a", "0,a", "2,2,2,a", "1,2a", "5,2a", "23,2a", "2,2,3,a",
            "13a", "23,3a", "22,2a", "2,3,3,a", "1,3a", "3,23,a", "22,3a", "17a8", "377a88"}},
          {"S_2", 1,
           {"1a", "1,a", "5a", "5,a", "2,2a", "22a", "2,2,a", "27a8",
            "2,3a", "23a", "2,3,a", "37a8", "3,2a", "0,2a", "0,3a"}}}},
        {"3a", {{"C_3", 0, {"3,a"}}}},
        {"4a", {{"C_4", 0, {"4,a"}}}},
        {"12a", {{"S_5", 0, {"2,3,2a", "3,27a8", "25a", "2738a"}}}},
    };
    return families;
}

// Double-crit (k=2) families. S3/S4 share rep "2ba" ([SCAB, crit, crit]) -- see the k=1 doc
// comment above for the shared-rep/omitted-lowest-order-element rationale, which applies
// identically here. Every listed element has boundary count >= 2 or token count >= 4, so each
// swap strictly reduces (tokens, boundaries) and the quickCanon fixpoint still terminates.
const std::vector<CritFamily>& doubleCritFamilies() {
    static const std::vector<CritFamily> families = {
        {"2ba",
         {{"S_3", 0, {"0,ba", "b7a8", "2,ba", "b,2a", "2,b,a"}},
          {"S_4", 1, {"1,ba", "22,ba", "5,ba", "23,ba", "3b,2a"}}}},
    };
    return families;
}

// Multi-region ("crits on different organs") families -- k=1 scope, see the multi-region section
// doc comment above (parseChunkEncoding/multiChunkKey/enumerateMultiCrits/applyMultiCritSwap).
// Deliberately kept SEPARATE from singleCritFamilies() (own registry, own finder, own swap)
// rather than merged into it: the single-region path is proven sound to 6-spot and untouched by
// this addition, so a bug in the new multi-region machinery can't regress it. Each family here
// reuses an EXISTING single-region family's repEncoding verbatim (via headOfRep), so a
// multi-region element swaps to the exact same rep its single-region siblings do -- these are
// additional elements of S_1/C_4, not new collections. Elements authored 2026-08-03 (user-
// provided). S_5's given multi-region example `[2C|2CDα/` had membrane D appearing only once
// (region0 written as just "2C"); confirmed with the user that D belongs in region0 too, i.e. the
// element is `[2CD|2CDα/` (both C and D connect the same two regions, mirroring S_1's element).
const std::vector<CritFamily>& multiCritFamilies() {
    static const std::vector<CritFamily> families = {
        {"2a", {{"S_1", 0, {"2CD|2a,CD"}}}},
        {"4a", {{"C_4", 0, {"3C|Ca", "3C|C,a", "3,C|Ca", "3,C|C,a"}}}},
        {"12a", {{"S_5", 0, {"2CD|2CDa"}}}},
    };
    return families;
}

// leftSideKey -> {offset, head}, built from singleCritFamilies() (canonicalized through the same
// leftSideKey path as extraction, so the keys line up by construction). Fails loudly (rather than
// silently overwriting) if two families' rosters ever produce the same canonical key -- every
// element must belong to exactly one family.
struct CritMatch {
    int offset;
    std::vector<Token> head;
};

const std::map<std::string, CritMatch>& registry() {
    static const std::map<std::string, CritMatch> reg = [] {
        std::map<std::string, CritMatch> m;
        for (const auto& fam : singleCritFamilies()) {
            const std::vector<Token> head = headOfRep(fam.repEncoding);
            for (const auto& g : fam.groups)
                for (const char* e : g.elements) {
                    const std::string key = leftSideKey(e);
                    if (!m.emplace(key, CritMatch{g.offset, head}).second)
                        throw std::logic_error("collections registry: duplicate left-side key '" +
                                                key + "' (from element '" + e + "')");
                }
        }
        return m;
    }();
    return reg;
}

// multiLeftSideKey -> {offset, head}, built from multiCritFamilies() -- same construction as
// registry(), see its own doc comment; a separate map since multi-region keys are computed by a
// different canonicalizer (multiChunkKey, not leftSideKey) and matched against a different
// finder (enumerateMultiCrits, not enumerateCrits).
const std::map<std::string, CritMatch>& multiRegistry() {
    static const std::map<std::string, CritMatch> reg = [] {
        std::map<std::string, CritMatch> m;
        for (const auto& fam : multiCritFamilies()) {
            const std::vector<Token> head = headOfRep(fam.repEncoding);
            for (const auto& g : fam.groups)
                for (const char* e : g.elements) {
                    const std::string key = multiLeftSideKey(e);
                    if (!m.emplace(key, CritMatch{g.offset, head}).second)
                        throw std::logic_error(
                            "collections multiRegistry: duplicate left-side key '" + key +
                            "' (from element '" + e + "')");
                }
        }
        return m;
    }();
    return reg;
}

// leftSideKey -> {offset, head}, built from doubleCritFamilies() -- same construction as
// registry(), see its own doc comment.
const std::map<std::string, CritMatch>& doubleCritRegistry() {
    static const std::map<std::string, CritMatch> reg = [] {
        std::map<std::string, CritMatch> m;
        for (const auto& fam : doubleCritFamilies()) {
            const std::vector<Token> head = headOfRep(fam.repEncoding);
            for (const auto& g : fam.groups)
                for (const char* e : g.elements) {
                    const std::string key = leftSideKey(e);
                    if (!m.emplace(key, CritMatch{g.offset, head}).second)
                        throw std::logic_error("collections doubleCritRegistry: duplicate left-side key '" +
                                                key + "' (from element '" + e + "')");
                }
        }
        return m;
    }();
    return reg;
}

// Apply a matched crit swap (k=1 or k=2): replace region R's ENTIRE content with one new
// boundary [head..., slot0, (slot1)] -- `head` is the matched family's own fixed prefix (see
// CritFamily/registry()/doubleCritRegistry() -- SCAB for S1/S2/S3/S4, but DISA/HOLL/APPE+SCAB for
// the newer single-crit families). A special-point slot keeps its own token in place -- it has
// no separate host, since it already stands for "connects to somewhere outside this position".
// A real-membrane slot becomes a fresh membrane occurrence, with its ORIGINAL pairing re-pointed
// onto its new occurrence here so its host elsewhere is preserved -- exactly the old
// applyDoubleCritSwap's repoint step, generalized from exactly 2 slots to 1 or 2. The region
// keeps its own index; nothing is ever deleted or reindexed, so there is no separate host-region
// bookkeeping to repair (unlike the old, now-removed, k=1-only applySwap, which wrote a bare DISA
// directly into a separate host and deleted the leaf: that direct-compressed result and this
// decompressed-then-auto-recompressed one are the same final canonical position whenever the sole
// crit is real, see the registry's doc comment above).
//
// The new occurrence index passed to `repoint` must be the slot's rank among ONLY the
// non-special (real-membrane) slots -- i.e. its occurrence position within `newBnd` counting real
// MEMB tokens alone -- NOT its raw index within `slots`, since `slots` can mix special-point and
// real-membrane entries and Component::pairIndex()'s occurrence numbering (see position.cpp) only
// ever counts actual MEMB tokens in a boundary, never special points. Using the raw slots-index
// happened to be correct whenever the real membrane came first (occurrence 0 either way) or when
// there was only ever one real membrane at slots[0], which is why this went unnoticed for plain
// double-membrane (S3/S4) swaps -- it broke the moment a special-point slot preceded a
// real-membrane slot (e.g. region "a,2A": alpha then a membrane), producing an out-of-range
// membrane-occurrence reference that crashed downstream in serialize()/pairIndex() consumers.
Component applyCritSwap(const Component& c, std::uint32_t R, const std::vector<Token>& head,
                         const std::vector<CritSlot>& slots) {
    Bnd newBnd;
    for (Token t : head)
        newBnd.push_back(t);
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
        int membOcc = 0;  // rank among non-special (real-membrane) slots only
        for (std::size_t i = 0; i < slots.size(); ++i) {
            if (slots[i].special)
                continue;
            if (slots[i].pairing == pi)
                matchedSlot = membOcc;
            ++membOcc;
        }
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
            // Content swaps (single-crit families -- S1/S2, C_3, C_4, S_5, ...): reduce a
            // single-crit region to its family's own [head..., crit] rep.
            for (const auto& cand : enumerateCrits(comp)) {
                const auto it = registry().find(cand.leftKey);
                if (it == registry().end())
                    continue;
                Position np = cur;
                np.components[ci] = applyCritSwap(comp, cand.leftRegion, it->second.head, {cand.slot});
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
                np.components[ci] = applyCritSwap(comp, cand.region, it->second.head, {cand.slot1, cand.slot2});
                consider(std::move(np), it->second.offset);
            }
            // Multi-region content swaps ("crits on different organs" -- S_1, C_4, ... additional
            // elements): collapse a >=2-region chunk, detached by a single bridge crit membrane,
            // to its family's single-region rep. Strictly reduces region count (>=2 regions merge
            // into 1), so the fixpoint still terminates.
            for (const auto& cand : enumerateMultiCrits(comp)) {
                const auto it = multiRegistry().find(cand.leftKey);
                if (it == multiRegistry().end())
                    continue;
                Position np = cur;
                np.components[ci] =
                    applyMultiCritSwap(comp, cand.regions, cand.crossPairing, it->second.head);
                consider(std::move(np), it->second.offset);
            }
        }
        if (!found)
            break;
        cur = std::move(bestPos);
        offset ^= bestOff;
    }
    return {cur, offset};
}

std::vector<CollectionRoster> allCollectionRosters() {
    std::vector<CollectionRoster> out;
    auto addFamily = [&](const CritFamily& fam) {
        bool repShown = false;
        for (const auto& g : fam.groups) {
            out.push_back({g.name, g.offset, {g.elements.begin(), g.elements.end()},
                            repShown ? std::string() : fam.repEncoding});
            repShown = true;  // only the family's first-listed group carries the rep; a paired
                               // sibling (S_2 sharing S_1's; S_4 sharing S_3's) shares it instead
        }
    };
    for (const auto& fam : singleCritFamilies())
        addFamily(fam);
    for (const auto& fam : doubleCritFamilies())
        addFamily(fam);
    // Multi-region families reuse an existing single-/double-crit family's name (they're
    // additional elements of the SAME collection, not new ones) -- append their elements onto
    // the already-emitted roster entry of that name rather than emitting a second entry, so the
    // Collect pane's JSON dump still has exactly one object per collection name.
    for (const auto& fam : multiCritFamilies())
        for (const auto& g : fam.groups)
            for (auto& r : out)
                if (r.name == g.name) {
                    r.elements.insert(r.elements.end(), g.elements.begin(), g.elements.end());
                    break;
                }
    return out;
}

}  // namespace stalks
