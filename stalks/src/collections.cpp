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
// detachable from the rest of the position by cutting exactly ONE crit -- either a real membrane
// bridging out to a host elsewhere, or (added 2026-08-25, see enumerateMultiCrits' own doc
// comment) a special point (ALPHA, ...) sitting inside one of the chunk's own regions, with
// nothing further to cut at all. Unlike the single-region path above (which has no internal
// membranes to canonicalize -- a lone region's every membrane is necessarily a crit, since a
// membrane can't pair a region to itself), a multi-region chunk's canonical key genuinely needs
// region/boundary ordering+rotation+chirality search THAT ALSO respects internal pairing identity
// across regions -- exactly the problem canon.cpp's canonMinimal/canonicalizeFull already solve
// for whole positions. Rather than duplicate that search here, a chunk is built as an ordinary
// stand-alone Component (internal membranes as real Component::pairings; the one crit -- a real
// membrane left OUT of pairings, or a special point swapped for an equally-unpaired MEMB stand-in,
// see withSpecialAsAgnostic -- renders as agnostic '9' via the existing serialize()/pairIndex()
// path either way, so both crit kinds produce directly comparable keys) and run through the real
// canonicalizeFull/serialize pipeline. This is additive and independent of the single-/
// double-crit machinery above: a separate registry (multiRegistry), separate finder
// (enumerateMultiCrits, a bridge search over the region-adjacency graph for the real-membrane
// case, plus a closure search for the special-point case -- see its own doc comment), and a
// separate swap (applyMultiCritSwap, which -- unlike applyCritSwap -- must delete the chunk's
// extra regions and reindex every reference to them, since a multi-region chunk collapses to a
// SINGLE new region at its family's rep).
// ---------------------------------------------------------------------------

// Cap on chunk size worth attempting: every authored multi-region roster element is tiny (<=4
// regions, a handful of tokens), and a bridge's "other" side is typically most of the position
// -- this cheap pre-filter (checked before the expensive canonicalizeFull call) skips it
// immediately rather than canonicalizing something that could never match a registry entry.
// Bumped 3->4 2026-08-29: S_11's second element "AB|AC|BD|CDa" is a genuine 4-region special-
// point chunk (a closed 4-cycle of crossing membranes, not a simple bridge chain) -- confirmed via
// query_position --quick-canon-only that it silently failed to reduce at all under the old cap
// (extractChunk's size guard rejected it before any key was even computed, so it could never have
// matched regardless of the registry entry being correct). No other code depends on this constant
// staying at 3 -- it's a pure perf pre-filter, not an algorithmic limit (parseRepTemplate/
// applyMultiCritSwap/extractChunk itself are already N-region general).
constexpr std::size_t MAX_MULTI_REGIONS = 4;
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

// One candidate multi-region swap: the chunk's original region indices (>=2, sorted), its sole
// crit occurrence -- either a real bridge membrane (CritSlot::pairing) or a special point sitting
// inside one of the chunk's own regions (CritSlot::special/tok), mirroring critSlots' uniform
// treatment of the two for the single-region case -- and its canonical key.
struct MultiCritCandidate {
    std::vector<std::uint32_t> regions;
    CritSlot slot;
    std::string leftKey;
};

// Shared validation + region/pairing extraction for a candidate multi-region side, used by both
// the real-bridge search and the special-point search below (see enumerateMultiCrits' own doc
// comment for why there are two). `excl`, when >= 0, is the crossing bridge's pairing index to
// leave OUT of `newPairings` so it renders as agnostic '9' (the real-membrane crit case); -1 means
// every internal pairing is kept (the special-point case, where nothing crosses out of the side at
// all). `wantSpecials` is the EXACT special-point count the side must contain (0 for a bridge
// crit, 1 for a special-point crit) -- any other count means the side's true crit count isn't
// exactly 1 (k=1 scope), so it's rejected.
struct ChunkExtraction {
    std::vector<std::uint32_t> sorted;
    std::vector<std::vector<Bnd>> newRegions;
    std::vector<std::pair<MRef, MRef>> newPairings;
};
std::optional<ChunkExtraction> extractChunk(const Component& c,
                                             const std::vector<std::vector<std::vector<int>>>& idx,
                                             const std::vector<std::uint32_t>& side, int excl,
                                             std::size_t wantSpecials) {
    if (side.size() < 2 || side.size() > MAX_MULTI_REGIONS)
        return std::nullopt;
    std::size_t tokenCount = 0, specials = 0;
    for (std::uint32_t r : side)
        for (const auto& b : c.regions[r]) {
            tokenCount += b.size();
            for (Token t : b)
                if (isSpecialPoint(t))
                    ++specials;
        }
    if (tokenCount > MAX_MULTI_TOKENS || specials != wantSpecials)
        return std::nullopt;
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
                        return std::nullopt;
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
    return ChunkExtraction{std::move(sorted), std::move(newRegions), std::move(newPairings)};
}

// The special-point case's extracted chunk still has the LITERAL special-point token sitting in
// place -- replace it with a bare (unpaired) MEMB so its key renders the SAME agnostic '9' way
// every multi-region registry element is authored in (parseChunkEncoding's lowercase ports become
// unpaired MEMB tokens, never special points -- see its own doc comment), so a real-membrane crit
// and a special-point crit produce comparable keys. Exactly one such token exists, per
// extractChunk's wantSpecials=1 guard.
//
// MUST also fix up `pairings`' stored occurrence numbers, not just the token itself: an MRef's
// `.occ` is "how many MEMB tokens precede this one in its boundary" (Component::pairIndex()'s own
// convention -- a special point was NEVER counted towards that, since it isn't MEMB), computed
// back when the special point held its spot without being a membrane at all. The moment it becomes
// a real MEMB token, every occurrence AFTER it in the SAME boundary needs its stored `.occ`
// incremented by one to stay correct -- exactly the "occurrence index computed before a token-type
// change goes stale" class of bug extractChunk's own agnostic-guard comment warns about. Skipping
// this reproduced it: a real membrane occurring after the special point in the same boundary kept
// its pre-conversion `.occ`, so multiChunkKey silently built the WRONG canonical key (observed as
// "2CD|C2Da" -- an existing, already-verified S_6 element -- computing the same key as S_5's
// "2CD|2CDa" once alpha replaced its real-membrane crit; caught via verify_left_side, not by eye).
void convertSpecialToAgnostic(std::vector<std::vector<Bnd>>& regions,
                               std::vector<std::pair<MRef, MRef>>& pairings) {
    for (std::uint32_t r = 0; r < regions.size(); ++r)
        for (std::uint32_t b = 0; b < regions[r].size(); ++b)
            for (std::uint32_t o = 0; o < regions[r][b].size(); ++o) {
                if (!isSpecialPoint(regions[r][b][o]))
                    continue;
                std::uint32_t membBefore = 0;
                for (std::uint32_t k = 0; k < o; ++k)
                    if (regions[r][b][k] == MEMB)
                        ++membBefore;
                regions[r][b][o] = MEMB;
                for (auto& [a, bb] : pairings) {
                    if (a.region == r && a.boundary == b && a.occ >= membBefore)
                        ++a.occ;
                    if (bb.region == r && bb.boundary == b && bb.occ >= membBefore)
                        ++bb.occ;
                }
                return;  // exactly one special point, per extractChunk's wantSpecials=1 guard
            }
}

// Bridge search over a Component's region-adjacency graph (nodes = regions, edges = real
// membrane pairings -- every pairing connects two DIFFERENT regions, Component::validate()'s "no
// region linking to itself" rule). A bridge membrane's removal splits the graph; each side is a
// candidate multi-region left side (its ONLY connection to the rest is that one membrane) PROVIDED
// it has zero special points (else its true crit count exceeds 1) and stays within the size cap.
// Graphs here are tiny (a handful of regions at n<=6), so the naive O(P*(R+P)) trial-removal scan
// is simplest and fast enough; no need for a linear-time bridge algorithm.
//
// ALSO searches for the special-point analogue (author 2026-08-25): a lone special point (ALPHA,
// ...) sitting inside one of a connected cluster's own regions plays the IDENTICAL structural role
// a crit membrane plays once its far side is known (tokens.hpp) -- it already stands for "connects
// to somewhere outside this position" -- so a cluster whose only real-membrane connectivity is
// INTERNAL to itself, with exactly one special point inside it, is just as valid a multi-region
// left side as the real-bridge case, with the special point itself as the sole crit instead of a
// bridge membrane. Since a special point isn't a pairing, there's no bridge to cut: the candidate
// side is simply the FULL connected component (via real membranes) containing the special point's
// region -- by definition of "connected component", nothing crosses out of it. This closes the gap
// behind every currently-registered multi-region element (S_1/C_4/S_5/S_6/S_7/S_9's own multi-
// region rosters) never matching a genuine single-alpha analysis position: the bridge search alone
// can only ever find a REAL membrane as the crit, so a chunk whose sole external connection is
// alpha itself was never even considered a candidate (see [[project_advanced_collections]]).
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
        auto extracted = extractChunk(c, idx, side, excl, /*wantSpecials=*/0);
        if (!extracted)
            return;
        MultiCritCandidate cand;
        cand.regions = extracted->sorted;
        cand.slot = CritSlot{false, 0, excl};
        cand.leftKey = multiChunkKey(extracted->newRegions, extracted->newPairings);
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

    // Special-point analogue: one candidate per region containing a special point, closure via
    // ALL real membranes (excl = -1, an index that never matches a real pairing -- pairingIdx is
    // always >= 0). Two special-point-bearing regions ending up in the SAME connected cluster is
    // impossible under the wantSpecials=1 guard (that cluster would have 2 specials, failing the
    // check), so no dedup is needed here the way the bridge loop needs its two-sided tryAdd calls.
    for (std::uint32_t r0 = 0; r0 < R; ++r0) {
        const bool hasSpecial =
            std::any_of(c.regions[r0].begin(), c.regions[r0].end(), [](const Bnd& b) {
                return std::any_of(b.begin(), b.end(), [](Token t) { return isSpecialPoint(t); });
            });
        if (!hasSpecial)
            continue;
        auto extracted = extractChunk(c, idx, reachableExcluding(r0, -1), /*excl=*/-1,
                                       /*wantSpecials=*/1);
        if (!extracted)
            continue;
        Token specialTok = 0;
        for (const auto& region : extracted->newRegions)
            for (const auto& b : region)
                for (Token t : b)
                    if (isSpecialPoint(t))
                        specialTok = t;
        convertSpecialToAgnostic(extracted->newRegions, extracted->newPairings);
        MultiCritCandidate cand;
        cand.regions = extracted->sorted;
        cand.slot = CritSlot{true, specialTok, -1};
        cand.leftKey = multiChunkKey(extracted->newRegions, extracted->newPairings);
        out.push_back(std::move(cand));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Rep-template representation, shared by applyCritSwap (single-/double-crit, below) and
// applyMultiCritSwap (just below this section): a family's shared reduction target, as a boundary
// TEMPLATE. Originally a flat `vector<Bnd>` (single region) on the assumption every rep was one
// region -- true for S1/S2's "2a", C_3's "3a", C_4's "4a", S_5's "12a", generalized 2026-08-21 for
// S_6's rep "1,2,a" (the crit alone in its own THIRD boundary) and S_7's "2,1a" (two boundaries,
// crit sharing the second with ordinary content). Generalized again 2026-08-27 to a genuinely
// MULTI-region template (`regions.size() > 1`, e.g. S_11's "4A|Aa" or S_16's "3CD|CDa") for reps
// that are themselves multi-region -- unlike every prior multiCritFamilies() entry, which always
// reused an EXISTING single-region family's rep (see multiCritFamilies()' own doc comment),
// S_11/S_16 have no single-region sibling to reuse. Port tokens are left in place as sentinels
// marking where each crit slot's real occurrence goes; `internalPairings` records the rep's OWN
// internal membranes (e.g. S_11's single membrane A, crossing between its two regions) by
// LETTER-RANK occurrence (how many internal-letter tokens precede it in its own boundary) rather
// than a final pairIndex()-style occurrence -- whether a port sharing that boundary ends up a real
// membrane (shifting a later letter's true occurrence) or stays a literal special token (no shift)
// isn't known until application time, so only applyMultiCritSwap can compute the final occurrence
// (see its own doc comment). Both `applyCritSwap` (single-/double-crit, always single-region:
// k=1/k=2 finders never produce multi-region candidates, so their families' reps never use '|' or
// uppercase letters) and `applyMultiCritSwap` (multi-region, possibly N>1 regions) substitute
// ports from this same shape.
struct MultiRepTemplate {
    std::vector<std::vector<Bnd>> regions;
    std::vector<std::pair<MRef, MRef>> internalPairings;
};

// Parse a rep-template encoding. Like `parseLeftSide` (single region, ports only) generalized in
// the same direction `parseChunkEncoding` generalizes it for left-side MATCHING: '|' separates
// regions, uppercase A-Z is an internal membrane label that must occur exactly twice, in two
// different regions. Two differences from `parseChunkEncoding` (which serves the LEFT side, not
// the rep): (1) multiple DISTINCT port letters are allowed (k=2 templates like doubleCritFamilies'
// "2ba" need two, ranked by letter for applyCritSwap's slot assignment -- see its own doc
// comment), so ports are kept as distinct PORT0+n tokens exactly like parseLeftSide, never
// collapsed to a bare MEMB; (2) a single region (no '|' at all) is valid -- every existing rep
// before S_11/S_16 parses identically to the old parseLeftSide-based repTemplate(): regions of
// size 1, internalPairings empty.
MultiRepTemplate parseRepTemplate(const std::string& enc) {
    std::vector<std::vector<Bnd>> regions;
    std::vector<Bnd> curRegion;
    Bnd curBnd;
    std::uint32_t letterOcc = 0;  // internal-letter MEMB tokens seen so far in curBnd (ports don't
                                   // count -- see the struct doc comment on why not)
    std::map<char, std::vector<MRef>> letterLocs;
    bool sawPort = false;
    auto flushBnd = [&]() {
        if (curBnd.empty())
            throw EncodingError("empty boundary in rep template: '" + enc + "'");
        curRegion.push_back(curBnd);
        curBnd.clear();
        letterOcc = 0;
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
            curBnd.push_back(static_cast<Token>(PORT0 + (ch - 'a')));
            sawPort = true;
        } else if (ch >= 'A' && ch <= 'Z') {
            letterLocs[ch].push_back(MRef{static_cast<std::uint32_t>(regions.size()),
                                          static_cast<std::uint32_t>(curRegion.size()), letterOcc});
            curBnd.push_back(MEMB);
            ++letterOcc;
        } else if (ch == '[' || ch == ']' || ch == '/' || ch == ' ' || ch == '\t') {
            continue;
        } else if (ch == '9') {
            throw EncodingError("agnostic membrane '9' has no meaning in a rep template: '" + enc +
                                "'");
        } else {
            throw EncodingError(std::string("unexpected character '") + ch + "' in rep template");
        }
    }
    flushRegion();
    if (!sawPort)
        throw EncodingError("rep template has no crit port: '" + enc + "'");

    std::vector<std::pair<MRef, MRef>> internalPairings;
    for (const auto& [letter, locs] : letterLocs) {
        if (locs.size() != 2)
            throw EncodingError(std::string("internal membrane '") + letter +
                                "' must appear exactly twice in rep template: '" + enc + "'");
        if (locs[0].region == locs[1].region)
            throw EncodingError(std::string("internal membrane '") + letter +
                                "' must connect two different regions in rep template: '" + enc +
                                "'");
        internalPairings.push_back({locs[0], locs[1]});
    }
    if (regions.size() > 1 && internalPairings.empty())
        throw EncodingError("multi-region rep template has no internal membrane connecting its "
                            "regions: '" + enc + "'");
    return {std::move(regions), std::move(internalPairings)};
}

MultiRepTemplate repTemplate(const char* repEncoding) { return parseRepTemplate(repEncoding); }
// ---------------------------------------------------------------------------

// Apply a matched multi-region swap: replace EVERY region in `sideRegions` with the rep's OWN
// region(s) (`rep.regions.size()`, not always 1 -- generalized 2026-08-27: a rep like S_11's
// "4A|Aa" or S_16's "3CD|CDa" is itself multi-region, so the matched chunk no longer always
// collapses to a single region, see MultiRepTemplate's own doc comment), inserted at the lowest of
// the side regions' original indices; the rest of the side is deleted and every pairing's region
// reference is reindexed accordingly. The chunk's internal pairings (both ends in sideRegions) are
// simply dropped -- their content is gone, replaced wholesale by the rep -- and the REP's own
// internal pairings (e.g. S_11's single membrane A, crossing between its two new regions) are
// wired fresh from `rep.internalPairings`. For a real-membrane slot, the crossing pairing (the
// chunk's one connection to the rest of the position) is repointed: its side-end becomes wherever
// the rep template's port landed, its host-end just gets its region index remapped, preserving the
// host's link. For a special-point slot (added 2026-08-25) there is no crossing pairing at all --
// the token is simply carried over into whichever new region the template puts it in.
Component applyMultiCritSwap(const Component& c, const std::vector<std::uint32_t>& sideRegions,
                             const CritSlot& slot, const MultiRepTemplate& rep) {
    auto inSide = [&](std::uint32_t r) {
        return std::find(sideRegions.begin(), sideRegions.end(), r) != sideRegions.end();
    };
    const std::uint32_t keepRegion = *std::min_element(sideRegions.begin(), sideRegions.end());

    // Build the rep's own new region(s) from the template (k=1 scope: exactly one port total,
    // wherever it sits), recording its final region+boundary+occurrence for the crossing
    // pairing's repoint below, and -- for every internal-letter MEMB token -- its final occurrence
    // too (`letterFinalOcc`, keyed by the template-side MRef `parseRepTemplate` recorded it under),
    // since a letter's TRUE occurrence can only be known here: a port sharing its boundary shifts
    // a later letter's occurrence only when that port itself becomes a real membrane (the
    // special-token case leaves it un-shifted) -- see MultiRepTemplate's own doc comment. A
    // special-point slot keeps its own token in place instead of becoming a membrane -- it has no
    // separate host to repoint, since it already stands for "connects to somewhere outside this
    // position" (same convention applyCritSwap uses for the single-/double-crit case).
    std::vector<std::vector<Bnd>> newRegions(rep.regions.size());
    std::map<MRef, std::uint32_t> letterFinalOcc;
    std::uint32_t portRegionT = 0, portBoundary = 0, portOcc = 0;
    for (std::size_t ri = 0; ri < rep.regions.size(); ++ri) {
        std::vector<Bnd> region;
        region.reserve(rep.regions[ri].size());
        for (std::size_t bi = 0; bi < rep.regions[ri].size(); ++bi) {
            Bnd nb;
            nb.reserve(rep.regions[ri][bi].size());
            std::uint32_t membOcc = 0, letterOcc = 0;
            for (Token t : rep.regions[ri][bi]) {
                if (isPort(t)) {
                    if (slot.special) {
                        nb.push_back(slot.tok);
                    } else {
                        portRegionT = static_cast<std::uint32_t>(ri);
                        portBoundary = static_cast<std::uint32_t>(bi);
                        portOcc = membOcc++;
                        nb.push_back(MEMB);
                    }
                } else if (t == MEMB) {
                    letterFinalOcc[MRef{static_cast<std::uint32_t>(ri), static_cast<std::uint32_t>(bi),
                                        letterOcc}] = membOcc;
                    ++letterOcc;
                    ++membOcc;
                    nb.push_back(MEMB);
                } else {
                    nb.push_back(t);
                }
            }
            region.push_back(std::move(nb));
        }
        newRegions[ri] = std::move(region);
    }

    // Sentinel (not 0) for deleted-region slots: if the "exactly one crossing edge" invariant
    // were ever violated, a stray read of an unset entry surfaces immediately as an out-of-range
    // EncodingError from pairIndex() instead of silently aliasing onto real region 0.
    std::vector<std::uint32_t> oldToNew(c.regions.size(), static_cast<std::uint32_t>(-1));
    std::vector<std::uint32_t> templateToNew(rep.regions.size(), static_cast<std::uint32_t>(-1));
    Component out;
    out.dead = c.dead;
    std::uint32_t next = 0;
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        if (inSide(r) && r != keepRegion)
            continue;  // deleted -- absorbed into the rep's own regions
        if (r == keepRegion) {
            for (std::size_t ri = 0; ri < newRegions.size(); ++ri) {
                templateToNew[ri] = next++;
                out.regions.push_back(std::move(newRegions[ri]));
            }
            continue;
        }
        oldToNew[r] = next++;
        out.regions.push_back(c.regions[r]);
    }

    out.pairings.reserve(c.pairings.size() + rep.internalPairings.size());
    for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
        auto pr = c.pairings[static_cast<std::size_t>(pi)];
        if (!slot.special && pi == slot.pairing) {
            MRef& sideEnd = inSide(pr.first.region) ? pr.first : pr.second;
            MRef& hostEnd = inSide(pr.first.region) ? pr.second : pr.first;
            hostEnd.region = oldToNew[hostEnd.region];
            sideEnd = MRef{templateToNew[portRegionT], portBoundary, portOcc};
            out.pairings.push_back(pr);
            continue;
        }
        if (inSide(pr.first.region) && inSide(pr.second.region))
            continue;  // internal to the collapsed chunk
        pr.first.region = oldToNew[pr.first.region];
        pr.second.region = oldToNew[pr.second.region];
        out.pairings.push_back(pr);
    }

    // The rep's OWN internal pairings (empty for every single-region rep; S_11/S_16 cross the
    // rep's own new regions), remapped from template-side (region-index-within-template,
    // letter-rank) to final (real new region index via templateToNew, real pairIndex()-style
    // occurrence via letterFinalOcc).
    for (const auto& [a, b] : rep.internalPairings) {
        auto remap = [&](const MRef& m) {
            return MRef{templateToNew[m.region], m.boundary, letterFinalOcc.at(m)};
        };
        out.pairings.push_back({remap(a), remap(b)});
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

// A family of collections sharing one swap target ("rep"): a boundary template (e.g. a single
// [SCAB, crit] boundary for S1/S2's "2a"; three separate boundaries [1],[2],[crit] for S_6's
// "1,2,a") that applyCritSwap below rebuilds directly, substituting each port for its actual
// slot -- so introducing a new family is just adding an entry here with its own repEncoding, no
// code change to the swap machinery itself. `repEncoding` is authored in the SAME left-side
// convention as `elements` (parsed once via repTemplate, below) -- so the rep can never drift
// from what applyCritSwap actually produces, and it's also what allCollectionRosters() reports
// for the Collect pane's Collections panel.
struct CritFamily {
    const char* repEncoding;
    std::vector<RosterGroup> groups;
};

// This family's own shared reduction target, as a boundary TEMPLATE, built by `repTemplate()`
// (see the MultiRepTemplate/parseRepTemplate section above, near applyMultiCritSwap -- moved
// ahead of this struct since applyMultiCritSwap needs the type too). Port tokens are left in place
// as sentinels marking where each crit slot's real occurrence goes; `internalPairings` records the
// rep's OWN internal membranes for a genuinely multi-region rep like S_11's "4A|Aa" (empty for
// every single-region rep, which is still most of them).

// NAMING NOTE (2026-08-29): every group name below (here, in doubleCritFamilies(), and in
// multiCritFamilies()) was renamed in one pass to match src/data/genomeDefs.json's current scheme
// (single-crit families all "S_n", the two double-crit ones "Z_1"/"Z_2") -- this file previously
// used a DIFFERENT, older naming scheme (this is the one file the TS-side genome-name consolidation
// deliberately left untouched, bridged instead via collectAlpha.ts's ROSTER_TO_FOLDER_NAME, which
// is now largely obsolete and can be pruned since names match directly). The historical comments
// throughout this section still reference the OLD names (as they existed when written) and were
// NOT rewritten -- treat any bare "S_n"/"C_n" name in prose below as describing what that shape was
// called AT THE TIME, not its current label. Full old->new mapping applied: S_2->S_1⊕1, C_3->S_2,
// C_4->S_3, S_5->S_20, S_6->S_9, S_7->S_12, S_8->S_22, S_9->S_25, S_10->S_8, S_11->S_5,
// S_11⊕1->S_5⊕1, S_12->S_9⊕1, S_13->S_4, S_14->S_10, S_15->S_18, S_16->S_23, S_17->S_26,
// S_18->S_14, S_19->S_17, S_20->S_21 (single-crit), plus S_3->Z_1/S_4->Z_2 (double-crit). Verified
// after the rename: regenerated collectionsRoster.json and cross-checked every roster name against
// genomeDefs.json's own GENOME_DEFS entry for the same name -- same genome, same members, nothing
// mismatched (see [[project_collect_feature]] for the full verification).
//
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
// S_6 ("1,2,a" = [APPE] boundary, [SCAB] boundary, [crit] boundary -- the first rep whose crit
// sits alone in its OWN boundary rather than sharing one with head content) and S_7 ("2,1a" =
// [SCAB] boundary, [APPE,crit] boundary) added 2026-08-21 (user-provided reps; elements sourced
// from Sprouts_ShuePairings_20260814.csv, cross-checked against the existing registry -- see
// [[project_advanced_collections]] for the specific rows skipped as transcription artifacts).
// Both standalone (offset 0 only, no Pairing-Theorem sibling identified) like C_3/C_4/S_5.
//
// NOT registered, 2026-08-30: 3 genuine S_1/S_1⊕1 members found by the same automated-discovery
// scan as this session's big S_1/S_1⊕1 batches below (see those batches' own comments), each
// individually passed tools/verify_left_side.cpp -- i.e. confirmed real, not rejected. Held back
// solely because each has 5 real regions and the user asked to keep multi-region (5+) elements out
// of the registry for now over performance concerns (more regions -> more registry-match work per
// lookup), not because of any correctness doubt. Add these once that concern is revisited:
//   S_1,   offset 0: "AB|AC|BD|CE|DEa"           (5 lives)
//   S_1⊕1, offset 1: "AB|AC|BDE|DEF|CFa"         (6 lives)
//   S_1⊕1, offset 1: "AB|AC|DE|BDF|CEFa"         (6 lives)
const std::vector<CritFamily>& singleCritFamilies() {
    static const std::vector<CritFamily> families = {
        {"2a",
         {{"S_1", 0,
           {"2,a", "0,a", "2,2,2,a", "1,2a", "5,2a", "23,2a", "2,2,3,a",
            "13a", "23,3a", "2,3,3,a", "3,23,a", "17a8", "377a88",
            "57a8", "33,2a",
            // "1,3a" removed 2026-08-29 -- NOT dead like the removals above: it's a legitimate
            // S_1 member (confirmed firing, 20 hits at n=6) that is permanently shadowed by a
            // double-crit registry match landing on the exact same region first, every time,
            // before stepSingleCrit ever gets a look (see [[project_advanced_collections]]'s
            // double-crit-masking diagnostic, 2026-08-29). Dropped from the registry text since a
            // shadowed entry can never actually apply the swap, but the membership itself stays
            // true and documented here for the record.
            // "22,2a"/"22,3a" removed 2026-08-29 (user-confirmed): each is a boundary-doubled
            // ("22" = a repeated boundary token) shape the 22==1 rewrite (rewrite22, applied as
            // part of normalizeQuick's base structural canon, upstream of this registry) already
            // collapses before a registry lookup ever runs -- confirmed 0-count via
            // quick_reduction_counts.exe.
            // 10 elements added 2026-08-23 (user-provided). Each verified via
            // tools/verify_left_side.cpp: direct exact-nimber comparison against rep "2a" across
            // 8 plain hosts + 4 joint-bearing hosts (incl. "0,0,17Z8", the exact shape that
            // caught the 277a88/S_7 bug) -- offset 0 held on every host tried for all ten,
            // including the partition-sensitive ones ("13,a" vs the already-registered "13a";
            // "3,5a" vs "35a" -- distinct boundary partitions of the same tokens, per the
            // 2026-07-06 "12,a"-vs-"1,2a" lesson that partition is significant and must not be
            // assumed from a similar-looking sibling).
            "3,1a", "1,3,a", "13,a", "3,37a8", "3,3,2a", "3,5a", "3738a", "337a8", "35a",
            "1,12,2a",
            // 3 elements added 2026-08-25 (user-provided), each a distinct boundary partition of
            // an already-registered sibling's tokens (same "partition is significant" caution as
            // the 2026-08-23 batch above): "3,5,a" vs "3,5a"/"35a"; "35,a" vs "3,5a"/"35a"; "3738,a"
            // vs "3738a".
            "3,5,a", "35,a", "3738,a",
            // 31 elements added 2026-08-30 (user-provided). "CDE|CDF|EFa" from this same batch was
            // already registered below in multiCritFamilies() and dropped as an exact duplicate.
            "1,1728a", "1,2,17a8", "1,1,2,2a", "1212a", "1217a8", "16,2a", "2,11,2a", "2,122,2a",
            "2,1728,2a", "1,122a", "1,14a", "1222,2a", "124,2a", "12728,2a", "17228,2a", "1748,2a",
            "177288,2a", "2224,2a", "222728,2a", "226,2a", "227228,2a", "22748,2a", "2277288,2a",
            "244,2a", "24728,2a", "2727288,2a", "2768,2a", "277488,2a", "27772888,2a", "46,2a",
            "4748,2a",
            // 41 single-region elements added 2026-08-30, automated discovery (Part 2 of this
            // session): native port of collect.ts's own isYellowCandidate/isInAdvancedCollection/
            // resolvedGenomeName/findBypassMatches logic (stalks/tools/alpha_genome.cpp/.hpp), run
            // over every unregistered single-alpha S_1-core left side up to 6 lives found in a
            // 960k-node .spec scan (stalks/tools/find_yellow_candidates.cpp). Cross-checked against
            // the live app's own T-gene table (.collect-t-required-complete) on 7 real cases before
            // trusting it at scale; all 201 total new S_1/S_1⊕1 elements from that scan (41 here +
            // the rest split between multiCritFamilies() below and singleCritFamilies()'s own
            // S_1⊕1 group) individually passed tools/verify_left_side.cpp's independent exact-
            // nimber check (offset 0 vs rep "2a", 8 hosts). 3 further genuine members found by the
            // same scan (2 S_1⊕1, 1 S_1) were deliberately NOT registered -- each has 5 real
            // regions and the user asked to hold multi-region (5+) elements back for now over
            // performance concerns, not correctness; see the comment block just above
            // singleCritFamilies() for the exact 3 left sides, kept for the record.
            "1,2,23,2a", "1,2,5,2a", "2,15,2a", "2,2a,123", "2,2a,1738", "2a,1223", "2a,134",
            "2a,13728", "2a,22222", "2a,2225", "2a,222738", "2a,2234", "2a,223728",
            "2a,227238", "2a,22758", "2a,2277388", "2a,2324", "2a,232728", "2a,236",
            "2a,23748", "2a,2377288", "2a,245", "2a,24738", "2a,25728", "2a,2727388",
            "2a,27348", "2a,2737288", "2a,277588", "2a,27773888", "2a,344", "2a,3768",
            "2a,377488", "2a,4758", "2a,56", "3,26,2a", "3,2a,224", "3,2a,22728", "3,2a,2748",
            "3,2a,277288", "3,2a,44", "3a,27772888"}},
          {"S_1⊕1", 1,
           {"1a", "1,a", "5a", "5,a", "2,2a", "22a", "2,2,a", "27a8",
            "23a", "0,2a",
            // "37a8"/"0,3a" removed 2026-08-29 -- NOT dead like the crit-cell/22==1 removals
            // elsewhere in this file: both are legitimate S_2 members (confirmed firing without
            // double-crit: "37a8" 164 hits at n=5 / 3066 at n=6, "0,3a" 10 at n=5 / 443 at n=6),
            // permanently shadowed by a double-crit registry match on the same region firing
            // first, every time (see [[project_advanced_collections]]'s double-crit-masking
            // diagnostic, 2026-08-29). Dropped from the registry text since a shadowed entry can
            // never actually apply, membership stays true and documented here.
            // 6 elements added 2026-08-25 (user-provided). Verified via tools/verify_left_side.cpp
            // (offset 1 vs rep "2a") on both the cheap 8-host set and the joint-bearing "0,0,17Z8"-
            // pattern hosts, same method as every other batch this session.
            "13,2a", "2a,35", "2a,3738", "13,3a", "0,3,a", "2,2,2,2,a",
            // "2,3a"/"2,3,a"/"3,2a"/"22,a"/"23,a" removed 2026-08-29 (user-confirmed): each is a
            // 2-or-3-membrane/scab-only region, so crit-cell/scab-cell/special-cell congruity
            // (enumerateCritCells/enumerateScabCells/enumerateSpecialCells, upstream of this
            // registry) already merges it before a registry lookup ever runs -- confirmed
            // unreachable via quick_reduction_counts.exe's 0-count report (n=5/n=6, see
            // [[project_quick_reduction_counters]]), same rationale as S_13's empty group above.
            // 10 elements added 2026-08-29 (user-provided), same batch as multiCritFamilies()'s own
            // S_1⊕1 addition below. Verified via tools/verify_left_side.cpp (offset 1 vs rep "2a")
            // on the cheap 8-host set; also cross-checked pairwise via query_position --canon-only
            // (every one of these plus the whole batch's multi-region siblings below canonicalizes
            // to a distinct structural encoding, and none collides with an already-registered
            // element) to rule out a relabeled/rotated duplicate slipping in.
            "234,2a", "23728,2a", "36,2a", "26,2a", "2222,2a", "224,2a", "22728,2a", "2748,2a",
            "277288,2a", "44,2a",
            // 2 single-region elements added 2026-08-30, same automated-discovery batch as S_1's
            // own addition above (see that comment for the method/validation).
            "2a,2223", "4,4,2a",
           }}}},
        // "3,a" removed 2026-08-29 for the same reason as the S_2 removals just above (already
        // caught by crit-cell congruity, confirmed 0-count) -- C_3 keeps its rep with no listed
        // elements, same empty-group convention as S_10/S_12/S_13/S_17.
        {"3a", {{"S_2", 0, {}}}},
        {"4a", {{"S_3", 0, {"4,a"}}}},
        // "2,3,2a" removed 2026-08-21 at user request pending re-verification, despite direct
        // engine test (exact nimber vs rep "12a" across 8 varied right-side hosts, same method
        // that caught the 277a88 bug) finding zero discrepancies -- evidence pointed to it being
        // sound, but user wanted it out of the registry anyway; see
        // [[project_advanced_collections]] if this needs revisiting.
        // "233a"/"3,23a" added 2026-08-25 (user-provided).
        {"12a", {{"S_20", 0, {"3,27a8", "25a", "2738a", "3,22a", "233a", "3,23a"}}}},
        // "2,5,a"/"323a"/"222,a" added 2026-08-25 (user-provided).
        {"1,2,a", {{"S_9", 0, {"2,23,a", "2,5,a", "323a", "222,a"}}}},
        // "277a88" (CSV row 48) was first registered under S_7 and PROVEN UNSOUND there
        // 2026-08-21 by direct engine test (non-constant offset across right sides -- see
        // [[project_advanced_collections]]). User then identified the real cause: several
        // elements share a similar-but-not-identical genome to S_7 and actually belong to a
        // separate collection, S_9 (rep "34a"), which "34a" itself was mistakenly listed as an
        // ELEMENT of (rather than S_9's own rep) before this split. Re-verified "277a88" directly
        // against "34a" across the SAME three hosts used to disprove it under S_7: all three now
        // agree exactly (offset 0), confirming the fix.
        // "2,33a" added 2026-08-25 (user-provided).
        // "S_12⊕1" added 2026-08-30 (user-provided; Pairing-Theorem sibling, offset 1, single-region
        // element "5,37a8" -- verified via verify_left_side.exe against rep "2,1a"). Its multi-
        // region sibling element "2CD|5,CDa" is appended onto this same roster entry from
        // multiCritFamilies() below.
        {"2,1a", {{"S_12", 0, {"227a8", "2,5a", "2,37a8", "223a", "2,33a"}},
                   {"S_12⊕1", 1, {"5,37a8"}}}},
        // S_8 added 2026-08-23 (user-provided; genome (0,3,{0},{},[S_2,C_3,C_4])). Rep "12,a" is
        // the EXACT shape proven 2026-07-06 NOT to be an S_1 member (crit alone in its own
        // boundary, distinct from valid S_1 element "1,2a") and again explicitly skipped
        // 2026-08-21 when it resurfaced in the CSV under S_1 -- both calls were correct: "12,a"
        // was never an S_1 element, it just turns out to be its OWN family's rep instead, not
        // invalid shape. Standalone, no Pairing-Theorem sibling identified (like C_3/C_4/S_5).
        // "233,a" added 2026-08-25 (user-provided). "223,a" added 2026-08-26 (user-provided) --
        // same family, an additional single-region partition.
        {"12,a", {{"S_22", 0, {"25,a", "2728,a", "2738,a", "233,a", "223,a"}}}},
        // "3,4,a"/"34,a" added 2026-08-25 (user-provided) -- distinct boundary partitions of the
        // already-registered "3,4a".
        {"34a", {{"S_25", 0, {"277a88", "3,4a", "4,3a", "273a8", "237a8", "3,4,a", "34,a"}}}},
        // S_10 added 2026-08-25 (user-provided; genome (2,0,{1},{1},[C_3,S_1])). No single-region
        // elements yet -- the empty group exists purely so allCollectionRosters() still emits an
        // entry for its rep (see addFamily's per-group loop below); its only known member so far is
        // multi-region ("3A|2Aa", see multiCritFamilies()). Verified via verify_left_side.cpp
        // (offset 0) on both host sets.
        {"4,2a", {{"S_8", 0, {}}}},
        // S_12 added 2026-08-25 (user-provided; genome (1,3,{1},{},[S_1,C_3⊕1,S_6])) -- a single
        // known example, "obviously its own rep" (user's own words): no elements to reduce yet, same
        // empty-group rationale as S_10 above.
        {"5,5,a", {{"S_9⊕1", 0, {}}}},
        // S_14 through S_20 added 2026-08-25 (user-provided). S_13 (genome (2,0,{1},{},[C_3,S_1]),
        // rep "33a") and S_16 (genome (0,3,{2},{1},[C_3,C_4,S_1⊕1]), rep "3CD|CDa", multi-region)
        // were ORIGINALLY left unregistered here on the theory that every member is already caught
        // by the pre-existing crit-cell congruity rule (enumerateCritCells/mergeCritCell, upstream
        // of this registry entirely), making a roster entry redundant. That theory silently assumed
        // no single-alpha member would ever land its special point in the SAME region as the crits
        // crit-cell is trying to merge -- but a genuine single-alpha S_13 member does exactly that
        // (its rep "33a" decompresses to "A,B,a|2A|2B": 2 real membranes + the alpha marker sharing
        // one region), and crit-cell's ALL-membrane requirement excludes any region containing the
        // alpha token. Fixed 2026-08-26 by special-cell congruity (see its own section doc comment,
        // above enumerateSpecialCells/mergeSpecialCell) generalized to cover k=2 real membranes +1
        // special point, which now reduces every such member down to "33a" same as crit-cell always
        // did for the pure-membrane members -- so S_13 is registered below like S_10/S_12/S_17/S_20
        // (empty group; no single-region elements need listing here, the merge does the work).
        // S_16 was left unregistered here through 2026-08-26 -- not for the same reason as S_13
        // above, but a distinct architectural gap: its rep "3CD|CDa" is itself multi-region
        // (contains '|'), and applyMultiCritSwap only ever collapsed a matched chunk down into ONE
        // new region built from repTemplate()'s single-region parse, so there was no swap machinery
        // that could target a multi-region rep at all. Fixed 2026-08-27 by generalizing
        // repTemplate/applyMultiCritSwap to emit N regions (see MultiRepTemplate's own doc
        // comment); S_16 (with its two known members) is now registered in multiCritFamilies()
        // instead of here, alongside the new S_11⊕1 sibling group which needed the same machinery.
        // S_13's fix does NOT apply here -- that was about crit-cell missing a special point
        // sharing the region, a single-region concern; this was single-vs-multi-region swap-target
        // support, unrelated.
        {"33a", {{"S_4", 0, {}}}},
        {"222a", {{"S_10", 0, {"2,22a"}}}},
        // "13,4a" added 2026-08-30 (user-provided, originally submitted as an "S_18+1" candidate --
        // verify_left_side.exe showed it matches rep "24a" at offset 0, not 1, so it's a plain S_18
        // member, same family as "2,4a", not a Pairing-Theorem sibling).
        {"24a", {{"S_18", 0, {"2,4a", "13,4a"}}}},
        // S_17 (genome (0,3,{0,1,2},{},[C_3,C_4,S_1⊕1])) -- unique, single known example, same
        // empty-group rationale as S_10/S_12.
        {"2728a", {{"S_26", 0, {}}}},
        {"2,23a", {{"S_14", 0, {"2,27a8"}}}},
        {"24,a", {{"S_17", 0, {"2,4,a"}}}},
        // S_20 (genome (0,3,{0,1},{},[C_4,S_1⊕1])) -- unique so far ("another one-off"), same
        // empty-group rationale.
        {"232a", {{"S_21", 0, {}}}},
        // S_13, S_15, S_6, S_7, S_11 (single-region rep only -- its multi-region element is in
        // multiCritFamilies() below) added 2026-08-29, sourced from re-running
        // tools/unregistered_left_sides.cpp after fixing a real bug in alpha_genome.cpp's
        // T-grandchild-depth genome-name folding (a std::map iterated its compact-key fallback in
        // alphabetical order instead of registration-priority order -- see
        // [[project_advanced_collections]]/chat history for the full diagnosis). S_13/S_15 are
        // each a single known example, same empty-group rationale as S_10/S_12/S_17/S_20/S_21
        // above. S_6/S_7 each have two known same-offset elements; the simpler-looking of the pair
        // is used as the rep, the other listed as its element (not independently verified which
        // of the pair is more "canonical" -- both are equally valid quick-canon fixpoints for
        // applyCritSwap's rebuild target, per the same reasoning as any other multi-element
        // family here). S_11's SECOND element ("AB|AC|BD|CDa", 4-region) is in multiCritFamilies()
        // below, keyed off this same rep "6,a".
        {"6a", {{"S_13", 0, {}}}},
        {"47a8", {{"S_15", 0, {}}}},
        {"2,3,2a", {{"S_6", 0, {"2,3,3a"}}}},
        {"2,2,2a", {{"S_7", 0, {"2,2,3a"}}}},
        {"6,a", {{"S_11", 0, {}}}},
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
         {{"Z_1", 0, {"0,ba", "b7a8", "2,ba", "b,2a", "2,b,a"}},
          // "22,ba" removed 2026-08-29 (user-confirmed, same reason as "22,2a"/"22,3a" above):
          // the 22==1 rewrite already collapses this boundary shape before this registry runs.
          {"Z_2", 1, {"1,ba", "5,ba", "23,ba", "3b,2a"}}}},
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
        {"2a", {{"S_1", 0,
                 {"2CD|2a,CD", "4C|2Ca", "2CD|7CD8a", "22C|2Ca", "11C|2Ca",
                  // 6 elements added 2026-08-23 (user-provided), same verification method and
                  // date as the single-region batch above. "CD|CEF|DEFa" and "CD|CEF|EDFa" are
                  // genuinely distinct (region2's boundary is a different cyclic order, not a
                  // rotation/mirror of the other -- different adjacency, not a relabeling); "CD|
                  // CEF|DEF,a" is the same three regions as "CD|CEF|DEFa" but with the crit split
                  // into its OWN boundary in region2 (partition-sensitive, same caution as the
                  // single-region batch's "13,a").
                  "CDE|CDF|EFa", "CD|CEF|DEFa", "CD|CEF|EDFa", "CD|CEF|DEF,a", "CD|3CE|DEa",
                  "CD|CE|3DaE",
                  // 3 elements added 2026-08-25 (user-provided). "4C|7C8a" and "CD|CE|D2Ea" (in
                  // S_6 below) were originally submitted with a mismatched/extra membrane letter
                  // ("4C|7D8a", "CD|DE|D2Ea") -- corrected with the user to reuse the letter that
                  // actually pairs, per each letter needing exactly 2 occurrences. A fourth
                  // proposed element, "CD|3DE|CEa", turned out to canonicalize to the exact same
                  // key as the already-registered "CD|3CE|DEa" above (a pure C<->D relabeling) and
                  // is skipped as a duplicate.
                  "3C|CD|2Da", "3C|CD|7D8a",
                  // "4C|7C8a" removed 2026-08-29 -- same shadowed-not-dead situation as
                  // "1,3a"/"37a8"/"0,3a" above: a legitimate S_1 multi-region member (confirmed
                  // firing without double-crit: 66 hits at n=5 / 972 at n=6), permanently
                  // shadowed by a double-crit registry match on the same region firing first
                  // (see [[project_advanced_collections]]'s double-crit-masking diagnostic,
                  // 2026-08-29). Membership stays true; just can't ever actually apply.
                  //
                  // 88 elements added 2026-08-30 (user-provided), same batch as the 31-element
                  // single-region S_1 addition above -- verified via verify_left_side.exe (offset 0
                  // vs rep "2a") on the cheap 8-host set. "CDE|CDF|EFa" from the same submitted list
                  // was already registered above and dropped as an exact duplicate.
                  "1,1C|2Ca", "1,CDE|CDE,2a", "12,CD|CD,2a", "127C8|2Ca", "12CD|CD,2a",
                  "12CD|7CD8a", "12C|1Ca", "12C|2C,2a", "12C|77C88a", "1738C|2Ca", "17C83|2Ca",
                  "173C8|2Ca", "17CD8|CD,2a", "17CD8|7CD8a", "13CD|CD,2a", "1C3D|CD,2a",
                  "1CDE|CDE,2a", "1CDE|7CDE8a", "1CDE|7CED8a", "1CD|3CD,2a",
                  // "1CD|2,E|CD,7E8a" dropped 2026-08-30 -- canonicalizes to the exact same
                  // multiRegistry key as "1CD|CD,738a" below (caught by the registry's own
                  // duplicate-key throw at static init): a differently-partitioned/pre-compression
                  // notation for the identical shape, not a distinct element.
                  "1CD|CD,738a", "1CD|3,2a,CD", "2,1C|2C,2a", "0,2,C|2Ca", "C,1728|2Ca",
                  "13,CD|CD,2a", "1,3CD|CD,2a", "3,4,CD|2a,CD", "34,CD|2a,CD", "3,1,CD|2a,CD",
                  "CD,2738|2a,CD", "4,3CD|CD,2a", "4,CD|3CD,2a", "4,CD|3,CD,2a", "4D|738D,2a",
                  "3,1CD|CD,2a", "3CD|CD,EF|EF,2a", "22,738C|2Ca", "3,17C8|2Ca", "C,1738|2Ca",
                  "2,1C|77C88a", "227CD8|CD,2a", "22CDE|CDE,2a", "22CDE|7CDE8a", "22CDE|7CED8a",
                  "25,CD|CD,2a", "34C|2C,2a", "34C|77C88a", "277CD88|CD,2a", "27CDE8|CDE,2a",
                  "27CDE8|7CDE8a", "27CDE8|7CED8a", "1,2,C|2C,2a", "2CDEF|CDEF,2a",
                  "377CD88|CD,2a", "37CDE8|CDE,2a", "CD,222|CD,2a", "CD,2728|CD,2a",
                  "4,CDE|CDE,2a", "4C|1C,2a", "4CDE|CDE,2a", "5,1C|2Ca", "5,CDE|CDE,2a",
                  "6,CD|CD,2a", "6,C|2C,2a", "1,2,C|77C88a", "C,12|77C88a", "1,1,C|2Ca",
                  "1,5,C|2Ca", "C,122|2Ca", "12,CD|7CD8a", "227CD8|7CD8a", "277CD88|7CD8a",
                  "CD,2728|7CD8a", "1,CDE|7CDE8a", "C,11|2Ca", "C,12|2C,2a", "C,15|2Ca",
                  "1,5C|2Ca", "CDEFG|CDEFG,2a", "CDEF|2CDEF,2a", "CDE|2C2DE,2a",
                  "CDE|CDFG|EFG,2a", "CD|1C2D,2a", "CD|22C2D,2a", "CD|27C2D8,2a", "CD|2C4D,2a",
                  // 103 elements added 2026-08-30, same automated-discovery batch as
                  // singleCritFamilies()'s own S_1 addition above (see that comment for the
                  // method/validation) -- multi-region (2-4 regions) elements from the same scan.
                  "1,2,A|3,A,2a", "1,ABC|3a,ABC", "12A|1,A,a", "12A|3,7A8a", "12A|3,A,2a",
                  "12A|37A8a", "12A|A,1a", "12A|a,1A", "13AB|7AB8a", "15A|2Aa", "1A3B|7AB8a",
                  "1ABC|3a,ABC", "1AB|1a,AB", "2,1A|1,A,a", "2,1A|3,7A8a", "2,1A|3,A,2a",
                  "2,1A|A,1a", "2,ABCD|2a,ABCD", "22AB|1a,AB", "22AB|2a,3AB", "22AB|3,2a,AB",
                  "23,ABC|2a,ABC", "237AB8|2a,AB", "23ABC|2a,ABC", "23ABC|7ABC8a",
                  "27AB8|3,2a,AB", "27ABC8|3a,ABC", "2Aa|1,3,2A", "2Aa|1,37A8", "2Aa|1,A,23",
                  "2Aa|123A", "2Aa|12A3", "2Aa|3,12A", "2Aa|577A88", "2Aa|A,123",
                  "2a,AB|35,AB", "2a,AB|AB,223", "3,7A8a|1,2,A", "3,7A8a|A,12",
                  "3,ABCD|2a,ABCD", "3,ABC|2a,2ABC", "34A|1,A,a", "34A|3,7A8a", "34A|3,A,2a",
                  "34A|37A8a", "34A|A,1a", "37A8a|1,2,A", "37A8a|2,1A", "37A8a|A,12",
                  "37ABC8|7ABC8a", "3AB|2a,22AB", "3AB|2a,27AB8", "3AB|2a,2A2B", "3AB|2a,4AB",
                  "3AB|ABCD|2a,CD", "3AB|ABC|2C,2a", "3A|2a,227A8", "3A|2a,24A", "3A|2a,2728A",
                  "3A|2a,277A88", "3A|2a,47A8", "3A|2a,6A", "3A|A,BCD|2a,BCD", "3A|BC|2a,2BAC",
                  "4AB|2a,3AB", "4AB|3,2a,AB", "4A|13,Aa", "4A|1A,3a", "4A|2a,5A",
                  "57AB8|2a,AB", "57AB8|7AB8a", "5ABC|2a,ABC", "5ABC|7ABC8a", "7AB8a|1,3,AB",
                  "7AB8a|1,3AB", "7AB8a|13,AB", "7AB8a|237AB8", "7AB8a|25,AB", "7AB8a|3,1AB",
                  "7AB8a|3,4,AB", "7AB8a|34,AB", "7AB8a|377AB88", "7AB8a|4,3AB",
                  "7AB8a|AB,222", "7ABC8a|23,ABC", "7ABC8a|5,ABC", "A,12|1,A,a", "A,12|3,A,2a",
                  "A,12|A,1a", "A,1a|1,2,A", "ABCD|2a,3ABCD", "ABC|2a,2A3BC",
                  "ABC|ABDE|3a,CDE", "ABC|ABD|2a,3CD", "AB|2a,22A3B", "AB|2a,23A2B",
                  "AB|2a,27A3B8", "AB|2a,2A5B", "AB|2a,2A738B", "AB|2a,3A4B", "AB|3,2a,2A2B",
                  "AB|3,ACD|2a,BCD", "AB|3ACD|2a,BCD",
                  }},
                {"S_1⊕1", 1,
                 {"12C|2Ca", "1CD|CD,2a",
                  // 21 elements added 2026-08-29 (user-provided), same batch as
                  // singleCritFamilies()'s own S_1⊕1 addition above. Verified via
                  // tools/verify_left_side.cpp (offset 1 vs rep "2a") on the cheap 8-host set, plus
                  // a query_position --canon-only pairwise cross-check (all 31 of this batch's
                  // elements canonicalize to distinct structural encodings, and none collides with
                  // an already-registered element) -- ruling out both an accidental duplicate
                  // within the batch and a relabeled/rotated repeat of an existing entry (the same
                  // caution as the "CD|3DE|CEa" duplicate caught above). Partition-sensitive pairs
                  // kept deliberately distinct per that same caution: "2,CDEF|CDEF,a" (region0 =
                  // two boundaries "2"/"CDEF") vs "2CDEF|CDEF,a" (region0 = one boundary "2CDEF"),
                  // and likewise "2,CDE|CDE,2a"/"2CDE|CDE,2a" and "2,CDE|7CDE8a"/"2CDE|7CDE8a".
                  "2,1C|2Ca", "2,CDEF|CDEF,a", "2,CDE|CDE,2a", "1,2,C|2Ca", "6,C|2Ca", "12,C|2Ca",
                  "2CDEF|CDEFa", "2CDEF|CFEDa", "2CDEF|DCFEa", "2CDEF|CDEF,a", "2CDE|CDE,2a",
                  "2CDE|7CDE8a", "2CDE|7CED8a", "3CDE|7CDE8a", "3CDE|7CED8a", "3,CDEF|CDEFa",
                  "CD|2C3D,2a", "2,CDE|7CDE8a", "CDE|CDFG|EFG,a", "CD|CEF|DEF,2a",
                  "2CD|2EF|CD,EFa",
                  // 55 elements added 2026-08-30, same automated-discovery batch as
                  // singleCritFamilies()'s own S_1 addition above (see that comment for the
                  // method/validation) -- multi-region (2-4 regions) elements from the same scan.
                  "1AB|7AB8a", "2,3AB|2a,AB", "2,ABC|3a,ABC", "22AB|2a,AB", "22AB|7AB8a",
                  "2A3B|2a,AB", "2A3B|7AB8a", "2ABC|3ABCa", "2AB|1a,AB", "2AB|2a,3AB",
                  "2AB|3,2a,AB", "2a,AB|3,3,AB", "3,ABCD|a,ABCD", "37AB8|2a,AB", "3ABCD|ABCDa",
                  "3ABCD|a,ABCD", "3A|ABC|7BC8a", "4AB|7AB8a", "4A|1,A,a", "4A|1Aa",
                  "4A|3,A,2a", "4A|37A8a", "4A|a,1A", "7AB8a|2,3AB", "7ABC8a|3,ABC",
                  "ABCD|2a,ABCD", "ABC|ABD|3,CDa", "ABC|ABD|3CDa", "ABC|ABD|3a,CD",
                  "ABC|ABD|7CD8a", "AB|2a,2A2B", "AB|3ACD|BCDa", "AB|3ACD|CBDa",
                  "AB|3AC|7BC8a", "AB|3CAD|BCDa", "AB|3CAD|CBDa", "AB|CADa|3,BCD",
                  "2AB|2CD|a,AB,CD", "2AB|7CD8a|AB,CD", "2Aa|BCDE|A,BCDE", "4A|2BC|A,BCa",
                  "4A|2BC|A,a,BC", "4A|2BC|ABCa", "4A|2BC|BC,Aa", "4A|2BC|a,ABC",
                  "AB|ACD|BEF|CEFDa", "AB|ACD|CDE|7BE8a", "AB|AC|2BDE|CDEa", "AB|AC|2BDE|DCEa",
                  "AB|AC|2DBE|CDEa", "AB|AC|2DBE|DCEa", "AB|AC|2a,2B2C", "AB|AC|BDEF|CDEFa",
                  "AB|AC|BDEa|2,CDE", "AB|AC|DBEa|2,CDE"}}}},
        // "3C|C,a"/"3,C|Ca"/"3,C|C,a" removed 2026-08-29 (user-confirmed, same reason as the
        // singleCritFamilies removals above): each is a 2-or-3-membrane/scab-only region, already
        // caught by crit-cell/scab-cell/special-cell congruity before this registry runs --
        // confirmed 0-count via quick_reduction_counts.exe. "3C|Ca" stays; it fires (nonzero).
        {"4a", {{"S_3", 0, {"3C|Ca"}}}},
        {"12a", {{"S_20", 0, {"2CD|2CDa"}}}},
        // Two of the user's proposed S_6 additions turned out to be duplicates once corrected/
        // checked against the engine (2026-08-25): "2CD|2,CDa" is an EXACT duplicate of the
        // already-registered S_7 element of the same text (a left-side's canonical key doesn't
        // depend on which family list it's authored under); "CD|CE|D2Ea" (corrected from
        // "CD|DE|D2Ea") canonicalizes to the exact same key as the already-registered
        // "CD|CE|2DaE" just above (a boundary-rotation/relabeling equivalent, not a new shape).
        // Net result: no new S_6 multi-region elements from this batch.
        // "2CD|2,CD,a" added 2026-08-26 (user-provided).
        {"1,2,a", {{"S_9", 0, {"2CD|C2Da", "CD|CE|2DaE", "2CD|2,CD,a"}}}},
        // "S_12⊕1" multi-region element "2CD|5,CDa" added 2026-08-30 (user-provided), same batch as
        // singleCritFamilies()'s own S_12⊕1 addition above -- appends onto that same roster entry.
        {"2,1a", {{"S_12", 0, {"2CD|2,CDa"}}, {"S_12⊕1", 1, {"2CD|5,CDa"}}}},
        // "S_7⊕1" added 2026-08-30 (user-provided; Pairing-Theorem sibling of S_7, offset 1, its
        // only known element is multi-region -- verified via verify_left_side.exe against rep
        // "2,2,2a"). S_7 itself gets an empty group here (no new multi-region elements of its own)
        // purely so this entry's "anyExisting" check in allCollectionRosters() finds S_7 already
        // registered and appends S_7⊕1 as a fresh sibling roster entry, same pattern as S_8/S_8⊕1.
        {"2,2,2a", {{"S_7", 0, {}}, {"S_7⊕1", 1, {"4C|2,2,Ca"}}}},
        // "2CD|2CD,a" added 2026-08-25 (user-provided) -- S_8's first multi-region element.
        {"12,a", {{"S_22", 0, {"2CD|2CD,a"}}}},
        // "3C|3Ca" added 2026-08-25 (user-provided).
        {"34a", {{"S_25", 0, {"CD|2CE|DEa", "3C|3Ca"}}}},
        // S_10's first (and so far only) known element, added 2026-08-25 (user-provided) alongside
        // S_10's own new single-region rep entry in singleCritFamilies() above. "S_8⊕1" (Pairing-
        // Theorem sibling, offset 1) added 2026-08-29, same "unregistered_left_sides re-run after
        // the T-grandchild-fold fix" batch as the singleCritFamilies additions above -- shares
        // S_8's rep "4,2a" as its own structural swap target, per the same reasoning as S_5/S_5⊕1.
        // 3 new S_8 elements + 4 new S_8⊕1 elements added 2026-08-30 (user-provided), verified via
        // verify_left_side.exe against rep "4,2a" at offset 0 / offset 1 respectively. "3C|2C,2a"
        // dropped -- canonicalizes to the exact same multiRegistry key as the already-registered
        // "3A|2A,2a" (a pure A<->C relabeling, caught by the registry's duplicate-key throw).
        {"4,2a", {{"S_8", 0, {"3A|2Aa", "3C|1C,2a", "1,2CD|CD,2a", "12C2|7C8a"}},
                   {"S_8⊕1", 1, {"3A|2A,2a", "2,22C|2Ca", "2,2CD|CD,2a",
                                  "CD|3CED|E,2a", "CD|2CE|DE,2a"}}}},
        // S_11 (2nd element) / S_11⊕1 added 2026-08-27, the first family here whose OWN rep is
        // genuinely multi-region (unlike every entry above, which reuses an EXISTING single-region
        // family's rep -- see this function's own doc comment) -- built on the multi-region-target
        // swap machinery (MultiRepTemplate/parseRepTemplate/applyMultiCritSwap) added the same
        // session. S_11 itself was previously appended directly in allCollectionRosters() as
        // display-only, bypassing registry()/multiRegistry() entirely (no swap machinery existed
        // yet); it is now a genuine registry entry like every other family. Both elements confirmed
        // via query_position --graph-ensure-only (exact nimber/minMoves/maxMoves) prior to this
        // machinery landing: "2AB|ABa" matches rep "4A|Aa" at offset 0 (3/2/3); the Pairing-Theorem
        // sibling (offset 1) matches at offset 1, both "5AB|ABa" and "ABa|37AB8" landing nimber
        // 2 = 3^1 (minMoves 3/maxMoves 4) -- neither reduces to the other or to S_11's rep through
        // any existing structural rule, so both are stable quick-canon fixpoints in their own
        // right. Named plain "S_11⊕1" (the group name below), NOT a standalone "S_22" -- an
        // in-session correction 2026-08-27: an earlier session's genome text for a distinct "S_22"
        // family (given before this swap machinery existed to check it against) didn't match what
        // computeAlphaGenome actually reports for either element (identical R/D/L/T'/T to S_11's
        // own genome, differing only in the accumulated quick-canon offset), and the user confirmed
        // directly that this was always meant as the S_1/S_1⊕1-style oplus-suffix sibling, not a
        // separate named collection -- so it needs no genome-table entry of its own either (its
        // genome bucket IS S_11's).
        // 5 new S_5 elements added 2026-08-30 (user-provided), verified via verify_left_side.exe
        // against rep "4A|Aa" at offset 0. Both submitted "S5+1" candidates turned out to be
        // relabeled duplicates of S_5⊕1's existing elements, caught by the registry's duplicate-key
        // throw: "738CD|CDa" == already-registered "ABa|37AB8"; "5CD|CDa" == already-registered
        // "5AB|ABa". No new S_5⊕1 elements from this batch.
        {"4A|Aa", {{"S_5", 0, {"2AB|ABa", "13,CD|CDa", "4C|2C,DE|DEa", "CDE|CDF|EF,GH|GHa",
                                "7C8DE|4C|DEa", "CD|CEF|GH,DEF|GHa"}},
                    {"S_5⊕1", 1, {"5AB|ABa", "ABa|37AB8"}}}},
        // S_16 added 2026-08-27, alongside S_11/S_11⊕1 above -- previously left unregistered (see
        // singleCritFamilies()'s own "33a"/S_13 comment block) specifically because its rep
        // "3CD|CDa" is itself multi-region and no swap machinery could target one; both elements
        // confirmed nimber-equal (4/2/4, matching the rep) via query_position --graph-ensure-only
        // before the machinery landed.
        {"3CD|CDa", {{"S_23", 0, {"4C|CD|Da", "2CD|CDE|Ea"}}}},
        // S_11's second element (4-region, "AB|AC|BD|CDa") -- same batch as the singleCritFamilies
        // additions above; keyed off S_11's own single-region rep "6,a" (registered there), so this
        // just appends onto that same roster entry (see allCollectionRosters()'s "anyExisting"
        // branch) rather than introducing a second collection.
        {"6,a", {{"S_11", 0, {"AB|AC|BD|CDa"}}}},
        // S_16, S_19, S_24 added 2026-08-29, same batch -- each a single known example with no
        // existing single-region sibling to reuse, so (like S_5/S_11⊕1 above) its OWN left-side
        // text IS the family's rep, same "obviously its own rep" rationale as the empty-group
        // singleCritFamilies entries.
        // Relettered 2026-08-30 (user-provided) to the conventional C/D naming used everywhere
        // else in this file, replacing the original A/B letters -- same position, verified
        // equivalent via verify_left_side.exe (old text as candidate against new text as rep,
        // offset 0). S_19's two regions are also swapped to lead with the boundary-heavy one,
        // matching the user's preferred ordering.
        {"CD|2CaD", {{"S_16", 0, {}}}},
        {"33C|Ca", {{"S_19", 0, {}}}},
        {"CD|3CaD", {{"S_24", 0, {}}}},
    };
    return families;
}

// leftSideKey -> {offset, head}, built from singleCritFamilies() (canonicalized through the same
// leftSideKey path as extraction, so the keys line up by construction). Fails loudly (rather than
// silently overwriting) if two families' rosters ever produce the same canonical key -- every
// element must belong to exactly one family.
struct CritMatch {
    int offset;
    // Single-/double-crit families' reps are always single-region (their k=1/k=2 finders never
    // produce multi-region candidates -- see enumerateCrits/enumerateDoubleCrits), enforced at
    // construction below; multi-region families' reps may be N>1 regions (see MultiRepTemplate's
    // own doc comment).
    MultiRepTemplate head;
    // The roster's own authored left-side text (pre-canonicalization), e.g. "1a", "0,a", "2CD|2a,CD"
    // -- used to label which collection member fired a reduction, see quickReductionCounts.
    std::string display;
};

const std::map<std::string, CritMatch>& registry() {
    static const std::map<std::string, CritMatch> reg = [] {
        std::map<std::string, CritMatch> m;
        for (const auto& fam : singleCritFamilies()) {
            const MultiRepTemplate head = repTemplate(fam.repEncoding);
            if (head.regions.size() != 1)
                throw std::logic_error("collections registry: family rep must be single-region: '" +
                                        std::string(fam.repEncoding) + "'");
            for (const auto& g : fam.groups)
                for (const char* e : g.elements) {
                    const std::string key = leftSideKey(e);
                    if (!m.emplace(key, CritMatch{g.offset, head, e}).second)
                        throw std::logic_error("collections registry: duplicate left-side key '" +
                                                key + "' (from element '" + e + "', first was '" +
                                                m.at(key).display + "')");
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
            const MultiRepTemplate head = repTemplate(fam.repEncoding);
            for (const auto& g : fam.groups)
                for (const char* e : g.elements) {
                    const std::string key = multiLeftSideKey(e);
                    if (!m.emplace(key, CritMatch{g.offset, head, e}).second)
                        throw std::logic_error(
                            "collections multiRegistry: duplicate left-side key '" + key +
                            "' (from element '" + e + "', first was '" + m.at(key).display + "')");
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
            const MultiRepTemplate head = repTemplate(fam.repEncoding);
            if (head.regions.size() != 1)
                throw std::logic_error(
                    "collections doubleCritRegistry: family rep must be single-region: '" +
                    std::string(fam.repEncoding) + "'");
            for (const auto& g : fam.groups)
                for (const char* e : g.elements) {
                    const std::string key = leftSideKey(e);
                    if (!m.emplace(key, CritMatch{g.offset, head, e}).second)
                        throw std::logic_error("collections doubleCritRegistry: duplicate left-side key '" +
                                                key + "' (from element '" + e + "')");
                }
        }
        return m;
    }();
    return reg;
}

// Apply a matched crit swap (k=1 or k=2): replace region R's ENTIRE content with the matched
// family's rep TEMPLATE (see CritFamily doc comment), substituting each port for its slot's real
// occurrence. Originally always built exactly one new boundary [head..., slot0, (slot1)] on the
// assumption every rep was single-boundary -- generalized 2026-08-21 for S_6's rep "1,2,a" (crit
// alone in its own third boundary) and S_7's "2,1a" (crit sharing its boundary with ordinary
// content), so the template can now span multiple boundaries. A special-point slot keeps its own
// token in place -- it has no separate host, since it already stands for "connects to somewhere
// outside this position". A real-membrane slot becomes a fresh membrane occurrence, with its
// ORIGINAL pairing re-pointed onto its new occurrence here so its host elsewhere is preserved.
// The region keeps its own index; nothing is ever deleted or reindexed, so there is no separate
// host-region bookkeeping to repair.
//
// Which slot fills which port is decided by the port's RANK among the template's own distinct
// port letters (sorted ascending, mirroring regionKey's own ports-sorted-by-rank convention) --
// NOT the slot's raw index in `slots` (arrival order from the crit-finder) and NOT the port's
// absolute letter value, so this is correct regardless of which letters a repEncoding happens to
// use. The two slots of a k=2 template are provably interchangeable (regionKey already minimizes
// over both port permutations when MATCHING), so which physical slot lands on which template
// letter cannot change the final canonical result -- only the pre-canonicalization intermediate,
// which normalizeQuick immediately re-derives in consider().
//
// The new occurrence recorded for `repoint` is the slot's rank among ONLY the non-special
// (real-membrane) occurrences WITHIN ITS OWN BOUNDARY -- i.e. Component::pairIndex()'s per-
// boundary occurrence numbering (see position.cpp), which counts actual MEMB tokens alone, never
// special points, and resets per boundary now that a rep can have more than one.
Component applyCritSwap(const Component& c, std::uint32_t R, const std::vector<Bnd>& repTemplate,
                         const std::vector<CritSlot>& slots) {
    std::set<Token> portSet;
    for (const Bnd& b : repTemplate)
        for (Token t : b)
            if (isPort(t))
                portSet.insert(t);
    const std::vector<Token> sortedPorts(portSet.begin(), portSet.end());

    std::vector<MRef> slotLoc(slots.size());
    std::vector<Bnd> newRegion;
    newRegion.reserve(repTemplate.size());
    for (std::size_t bi = 0; bi < repTemplate.size(); ++bi) {
        Bnd nb;
        nb.reserve(repTemplate[bi].size());
        std::uint32_t membOcc = 0;
        for (Token t : repTemplate[bi]) {
            if (!isPort(t)) {
                nb.push_back(t);
                continue;
            }
            const auto rankIt = std::lower_bound(sortedPorts.begin(), sortedPorts.end(), t);
            const std::size_t si = static_cast<std::size_t>(rankIt - sortedPorts.begin());
            const CritSlot& slot = slots.at(si);
            if (slot.special) {
                nb.push_back(slot.tok);
            } else {
                slotLoc[si] = MRef{R, static_cast<std::uint32_t>(bi), membOcc++};
                nb.push_back(MEMB);
            }
        }
        newRegion.push_back(std::move(nb));
    }

    Component out;
    out.dead = c.dead;
    out.regions.reserve(c.regions.size());
    for (std::uint32_t r = 0; r < c.regions.size(); ++r)
        out.regions.push_back(r == R ? newRegion : c.regions[r]);

    out.pairings.reserve(c.pairings.size());
    for (int pi = 0; pi < static_cast<int>(c.pairings.size()); ++pi) {
        int matchedSlot = -1;
        for (std::size_t i = 0; i < slots.size(); ++i) {
            if (!slots[i].special && slots[i].pairing == pi) {
                matchedSlot = static_cast<int>(i);
                break;
            }
        }
        if (matchedSlot < 0) {
            out.pairings.push_back(c.pairings[static_cast<std::size_t>(pi)]);
            continue;
        }
        auto pr = c.pairings[static_cast<std::size_t>(pi)];
        const MRef& newRef = slotLoc[static_cast<std::size_t>(matchedSlot)];
        if (pr.first.region == R)
            pr.first = newRef;
        else
            pr.second = newRef;
        out.pairings.push_back(pr);
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

// ---------------------------------------------------------------------------
// Special-cell congruity: a region whose tokens are EXACTLY k in {1,2} real crit membranes (each
// paired to a DISTINCT host elsewhere), plus exactly one special point (ALPHA, ...; see
// tokens.hpp), and nothing else, plays identically regardless of how that content is split across
// the region's boundaries. A special point stands for "connects to somewhere outside this
// position" with no independent structure of its own (isSpecialPoint tokens contribute 0 to
// lives2() and can never self-connect -- see tokens.hpp), so unlike a real scab (DisaPoint's
// {membrane+scab} case) it carries no value the crit partition could be sensitive to; its
// placement relative to the membranes within the region is therefore not value-significant. This
// is the special-point analogue of crit-cell congruity above (which requires the region be PURELY
// membranes, k in {2,3}) -- here one of the crit slots is allowed to be the special point instead,
// capping total crit-slot count at 3 the same way (k membranes + 1 special = 2 or 3 total).
//
// k=1 (2 total crit slots) prompted by a user report that "[4A|A,a/" wasn't being recognized as
// S_11's "[4A|Aa/" -- confirmed via query_position --graph-ensure-only: exact nimber (and
// minMoves/maxMoves) matches between the split and merged forms across 5 varied hosts (4A, 2A, 1A,
// 0A, 22A), author 2026-08-26.
//
// k=2 (3 total crit slots) prompted by a followup: S_13's rep "33a" decompresses to
// "A,B,a|2A|2B" -- two real membranes plus the alpha marker, split across 3 boundaries -- which
// crit-cell's ALL-membrane requirement excludes and the original k=1-only special-cell rule didn't
// cover either, so S_13 (deliberately left unregistered on the now-disproven assumption that
// crit-cell alone would always reduce every member first, see multiCritFamilies()' own comment)
// kept leaking through as 4 duplicate "unregistered" rows. Confirmed sound via
// query_position --graph-ensure-only across 4 host pairs, including an ASYMMETRIC one
// ("[A,B,a|2A|1B]" vs "[ABa|2A|1B]", different hosts on each membrane) -- a stronger check than
// k=1's symmetric hosts -- and confirmed "[ABa|2A|2B]" quick-canons to "33a" (S_13's rep) via the
// existing crit-cell+DisaPoint pipeline once merged, author 2026-08-26.
//
// Distinct from DisaPoint compression: DisaPoint's {membrane+scab} pattern collapses to an OPAQUE
// pseudo-token (the scab has no separate identity worth keeping visible). A special point DOES
// need to stay visible in the rep -- it IS the point genome/left-side analysis is tracking, so
// erasing it would corrupt the very shape being classified -- so this merges the boundaries into
// one WITHOUT compressing any token, mirroring mergeCritCell's mechanics (a literal boundary
// merge) rather than DisaPoint's (a token substitution).
// ---------------------------------------------------------------------------

// Regions that are k in {1,2} crit membranes plus a lone special point, split across >=2
// boundaries (so merging changes them).
std::vector<std::uint32_t> enumerateSpecialCells(const Component& c) {
    std::vector<std::uint32_t> out;
    if (c.dead)
        return out;
    const auto idx = c.pairIndex();
    for (std::uint32_t R = 0; R < c.regions.size(); ++R) {
        const auto& reg = c.regions[R];
        if (reg.size() < 2)
            continue;  // already a single boundary: canonical, nothing to merge

        int membs = 0, specials = 0;
        bool ok = true;
        for (const auto& b : reg) {
            for (Token t : b) {
                if (t == MEMB) {
                    ++membs;
                } else if (isSpecialPoint(t)) {
                    ++specials;
                } else {
                    ok = false;
                    break;
                }
            }
            if (!ok)
                break;
        }
        if (!ok || specials != 1 || membs < 1 || membs > 2)
            continue;  // only {1,2} real crits + exactly 1 special point is verified

        // Every membrane must be validly paired to a DISTINCT host elsewhere (mirrors crit-cell's
        // own distinct-pairing guard, generalized to k>1: an agnostic membrane, or two membranes
        // paired to EACH OTHER within this region, disqualifies it). idx[R][b] holds one entry per
        // MEMB in boundary b (Component::pairIndex()'s own numbering), so a boundary made only of
        // the special point contributes no entries here and is skipped automatically.
        std::set<int> pis;
        bool pairOk = true;
        for (std::uint32_t b = 0; b < reg.size() && pairOk; ++b)
            for (int pi : idx[R][b]) {
                if (pi < 0 || !pis.insert(pi).second) {
                    pairOk = false;
                    break;
                }
            }
        if (!pairOk)
            continue;

        out.push_back(R);
    }
    return out;
}

// Merge a special cell's boundaries into one: all its crit membranes plus the one special point,
// in any order -- mergeCritCell's own "ordering is a non-issue" argument applies identically here
// (merging only ever collapses body parts, so the result is always drawable; canonicalizeFull's
// existing rotation/reordering search resolves the residual freedom). Membrane pairings are
// repointed to the new boundary exactly as mergeCritCell does; the special point stays a literal
// token appended at the end, never converted to MEMB, so its identity is never lost.
Component mergeSpecialCell(const Component& c, std::uint32_t R) {
    std::map<std::pair<std::uint32_t, std::uint32_t>, std::uint32_t> newOcc;
    std::uint32_t k = 0;
    Token specialTok = 0;
    for (std::uint32_t b = 0; b < c.regions[R].size(); ++b) {
        std::uint32_t occ = 0;
        for (Token t : c.regions[R][b]) {
            if (t == MEMB)
                newOcc[{b, occ++}] = k++;
            else if (isSpecialPoint(t))
                specialTok = t;
        }
    }

    Bnd merged(k, MEMB);
    merged.push_back(specialTok);

    Component out;
    out.dead = c.dead;
    out.regions.reserve(c.regions.size());
    for (std::uint32_t r = 0; r < c.regions.size(); ++r)
        out.regions.push_back(r == R ? std::vector<Bnd>{merged} : c.regions[r]);

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

// ---------------------------------------------------------------------------
// Scab-cell congruity: the same "merge boundaries, offset 0" idea as the crit-cell family above,
// but for a region whose tokens are EXACTLY k lone scabs and nothing else (author 2026-08-16).
// Empirically verified via testQuickNimber (--graph-ensure-only vs --graph-ensure-quick on
// query_position): k=2 ([2,2] vs [22], exact nimber 1 both) and k=3 ([2,2,2] vs [222], exact
// nimber 0 both) merge soundly. k=4 does NOT: [2,2,2,2] has exact nimber 1 but merged [2222] has
// exact nimber 2 -- so, exactly like the crit-cell family, this is capped at k in {2,3} rather
// than "any k"; scabs having no pairing/identity rules out an ordering-residue objection, but
// does not by itself make the merge k-invariant.
// ---------------------------------------------------------------------------

// Regions that are pure scab cells (k=2 or k=3 lone scabs, nothing else) not already merged to a
// single boundary.
std::vector<std::uint32_t> enumerateScabCells(const Component& c) {
    std::vector<std::uint32_t> out;
    if (c.dead)
        return out;
    for (std::uint32_t R = 0; R < c.regions.size(); ++R) {
        const auto& reg = c.regions[R];
        if (reg.size() < 2)
            continue;  // already a single boundary (or empty): canonical, nothing to merge
        std::size_t scabs = 0;
        bool allScab = true;
        for (const auto& b : reg)
            for (Token t : b) {
                if (t != SCAB) {
                    allScab = false;
                    break;
                }
                ++scabs;
            }
        if (allScab && scabs >= 2 && scabs <= 3)
            out.push_back(R);
    }
    return out;
}

// Merge a scab cell's boundaries into one boundary of k consecutive scabs. Scabs never appear in
// pairings, so unlike mergeCritCell there is nothing to repoint.
Component mergeScabCell(const Component& c, std::uint32_t R) {
    std::size_t k = 0;
    for (const auto& b : c.regions[R])
        k += b.size();
    Component out = c;
    out.regions[R] = {Bnd(k, SCAB)};
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

// The quickCanon base canonicalization: STRUCTURAL canon only (Hollow/Split/Triplet; DisaPoints
// stay decompressed here -- see quickCanon's tiering below for why) plus the 22==1 rewrite,
// iterated to a fixpoint (a rewrite can shift the canonical form, which is re-normalized).
Position normalizeQuick(const Position& p) {
    Position c = canonicalize(p);
    while (rewrite22(c))
        c = canonicalize(c);
    return c;
}

// DisaPoint compression (author 2026-08-16), applied only once quickCanon's crit-cell/scab-cell/
// swap fixpoint below is exhausted. Compressing a DisaPoint eats a lone membrane (or scab), which
// can mask an all-membrane crit-cell (or all-scab scab-cell) region that token would otherwise
// complete: e.g. [11A|12B|2C|A,B,C] -- compressing C to '3' first leaves region3 mixed ('3,A,B'),
// which blocks the crit-cell merge that region3's own membranes A/B would otherwise qualify for
// (a crit/scab cell must be EXACTLY membranes, or EXACTLY scabs -- nothing else). Doing DisaPoint
// compression last instead lands on the merged 'AB3' -- the crit-cell rule sees the pure 'A,B,C'
// region while it is still pure, merges it to 'ABC', and only then does the DisaPoint swallow C in
// place inside that single boundary.
Position applyDisaPoints(const Position& p) {
    // This is exactly the old (pre-tiering) normalizeQuick body. canonicalizeFull, NOT
    // normalizeQuick, must close this out: normalizeQuick's canonicalize() unconditionally
    // decompresses its input before recompressing structural-only (see canonicalizeImpl's
    // reduceDecompressed call), which would silently undo the DisaPoint compression this
    // function exists to apply.
    Position c = canonicalizeFull(p);
    while (rewrite22(c))
        c = canonicalizeFull(c);
    return c;
}

// Mileage counter for quickReductionCounts (see collections.hpp): keyed by the reduced left
// side's own bracket/slash text, incremented once per fixpoint round that actually applies a
// reduction (not once per candidate merely considered -- see quickCanon's tier-1 loop, which
// applies only the lexicographically-least candidate each round).
std::map<std::string, long long>& quickReductionCountsMutable() {
    static std::map<std::string, long long> counts;
    return counts;
}

void recordQuickReduction(const std::string& key) {
    ++quickReductionCountsMutable()[key];
}

// ---------------------------------------------------------------------------
// quickCanon's fixpoint, restructured 2026-08-21 (user-specified priority order) from a single
// global lex-least race across all reduction types into six PRIORITY-ORDERED steps, run in strict
// sequence every pass:
//   1. Crit-cell congruity      4. Double-crit registry (S_3/S_4)
//   2. Scab-cell congruity      5. Multi-region registry (S_1/C_4/S_5/S_6/S_7 extra elements)
//   3. Single-crit registry     6. DisaPoint compression
// Special-cell congruity (added 2026-08-26, see its own section doc comment) runs as step 1b,
// immediately after crit-cell -- it is the same kind of region-local pure-token-pattern merge as
// steps 1-2, just not renumbered into the list above to avoid rewriting every "step N" reference
// below.
// Each of steps 1-4 (plus 1b) is REGION-LOCAL: a merge/swap only ever rewrites its OWN region's
// content plus its OWN side of any pairing referencing that region (never another region's
// content, never a pairing's OTHER side) -- see mergeCritCell/mergeSpecialCell/mergeScabCell/
// applyCritSwap's own doc comments.
// Regions are therefore independent within a step: every eligible candidate is found ONCE against
// a snapshot of the position at the step's start, then ALL of them are applied in one batch
// (chained sequentially so pairing updates compose correctly -- see stepSingleCrit's doc comment
// for why this remains sound even when two regions are each other's sole crit). This is the
// "assess all; don't go back to start" batching the user asked for: no step re-scans from
// scratch after adjusting just one region.
//
// Step 5 (multi-region) is the one exception: applyMultiCritSwap DELETES consumed regions and
// REINDEXES every later region reference in the whole component, so a second candidate's region
// indices -- computed from the pre-step snapshot -- would silently point at the wrong regions
// once reindexing has happened. It therefore runs as its own small local loop: enumerate, apply
// the lex-least candidate (preserving the existing deterministic-choice property), re-enumerate
// against the now-reindexed position, repeat until step 5 itself is exhausted.
//
// A single position-wide `changed` flag (not per-step) governs the OUTER loop: only once all six
// steps have run through in full does quickCanon check whether ANYTHING changed anywhere; if so,
// the whole six-step sequence runs again from step 1 (a step earlier in the order can easily be
// exposed by a later one -- e.g. DisaPoint compression revealing a fresh crit-cell). This is
// exactly tier 1/tier 2's existing DisaPoint-last rationale (see applyDisaPoints' doc comment),
// generalized to a fully-ordered six-step pass instead of a two-tier one.
//
// Re-canonicalization (2026-08-22 fix): steps 1-4 do NOT need `cur` in canonical form to find or
// apply their own candidates (see each step's own doc comment -- their enumerate*/apply* helpers
// already re-minimize internally via regionKey/leftSideKey). The previous code called
// normalizeQuick() after EVERY one of steps 1-4 individually; quickCanon's outer loop below
// instead runs all four together to their OWN local fixpoint against one un-canonicalized `cur`,
// canonicalizing exactly ONCE at the end of that batch. Measured at n=5 (instrumented call
// counters, since removed): this cuts steps-1-4's own normalizeQuick calls from 20,114 to 18,269
// per 66,756 quickCanon() invocations -- real, but only ~1% of the ~176k total canonicalize-
// family calls, so it does NOT produce a measurable wall-clock change on its own. The dominant
// cost is elsewhere and is NOT this kind of redundancy: the per-invocation initial normalizeQuick
// (66,756 calls, one per invocation, unavoidable -- a base form is needed before any step can
// match) and applyDisaPoints' canonicalizeFull (87,892 calls, ~1.32 per invocation -- one
// mandatory check per OUTER pass to see whether DisaPoint compression exposes anything new,
// already near the theoretical floor of 1). Together those two are ~88% of all canonicalize-
// family calls and are not redundant in the "after every move" sense this fix targeted. Step 5
// (multi-region) still canonicalizes internally per application -- it genuinely needs a
// comparable, reindexed position to pick the lex-least candidate and to re-enumerate against (see
// step 5's own doc comment) -- but at n=5 this fires only ~1,125 times total, a minor share.
// Bottom line: a real further speedup here would have to cut the NUMBER of outer passes per
// invocation (why do ~32% of invocations need a 2nd pass?) or make canonicalize()/canonicalizeFull
// themselves cheaper -- not restructure when they're called. See
// [[project_quickcanon_recanonicalization_perf]] in memory for the corrected writeup; the prior
// session's "~2.65x, 85-90%, expect ~2x speedup" framing conflated canonicalize+canonicalizeFull
// call counts as if equally redundant, which this measurement disproves.
// ---------------------------------------------------------------------------

// Step 1: crit-cell congruity. Batch-applies every eligible merge found against a per-component
// snapshot (see the section doc comment above for why this is safe). Returns whether anything
// changed; `cur` is mutated in place, NOT yet re-normalized (callers normalizeQuick once after).
bool stepCritCell(Position& cur) {
    bool changed = false;
    for (std::size_t ci = 0; ci < cur.components.size(); ++ci) {
        const Component snapshot = cur.components[ci];
        for (std::uint32_t R : enumerateCritCells(snapshot)) {
            recordQuickReduction("[" + regionKey(markedRegion(snapshot.regions[R])) + "/");
            cur.components[ci] = mergeCritCell(cur.components[ci], R);
            changed = true;
        }
    }
    return changed;
}

// Step 1b: special-cell congruity (see its own section doc comment above). Same batching pattern
// as step 1 -- region-local, mergeSpecialCell only ever touches its own region's content plus the
// one pairing referencing it.
bool stepSpecialCell(Position& cur) {
    bool changed = false;
    for (std::size_t ci = 0; ci < cur.components.size(); ++ci) {
        const Component snapshot = cur.components[ci];
        for (std::uint32_t R : enumerateSpecialCells(snapshot)) {
            recordQuickReduction("[" + regionKey(snapshot.regions[R]) + "/");
            cur.components[ci] = mergeSpecialCell(cur.components[ci], R);
            changed = true;
        }
    }
    return changed;
}

// Step 2: scab-cell congruity. Same batching pattern as step 1.
bool stepScabCell(Position& cur) {
    bool changed = false;
    for (std::size_t ci = 0; ci < cur.components.size(); ++ci) {
        const Component snapshot = cur.components[ci];
        for (std::uint32_t R : enumerateScabCells(snapshot)) {
            recordQuickReduction("[" + regionKey(snapshot.regions[R]) + "/");
            cur.components[ci] = mergeScabCell(cur.components[ci], R);
            changed = true;
        }
    }
    return changed;
}

// Step 3: single-crit registry (S_1/S_2, C_3, C_4, S_5, S_6, S_7). Batch-applies every matching
// region found against a per-component snapshot. Safe even in the "dumbbell" case (two regions
// that are each other's sole crit): applyCritSwap only ever repoints the pairing SIDE belonging
// to the region it's rewriting, leaving the other side exactly as the input had it -- so applying
// region A's swap first, then region B's swap against the now-A-updated pairings list, correctly
// composes into both sides being repointed (pairing INDICES never shift between applyCritSwap
// calls, only some entries' MRef content does, so a later candidate's `.pairing` index -- computed
// from the pre-step snapshot -- always still refers to the right pairing).
bool stepSingleCrit(Position& cur, int& offset) {
    bool changed = false;
    for (std::size_t ci = 0; ci < cur.components.size(); ++ci) {
        const Component snapshot = cur.components[ci];
        for (const auto& cand : enumerateCrits(snapshot)) {
            const auto it = registry().find(cand.leftKey);
            if (it == registry().end())
                continue;
            cur.components[ci] = applyCritSwap(cur.components[ci], cand.leftRegion,
                                                it->second.head.regions[0], {cand.slot});
            offset ^= it->second.offset;
            recordQuickReduction("[" + it->second.display + "/");
            changed = true;
        }
    }
    return changed;
}

// Step 4: double-crit registry (S_3/S_4). Same batching pattern and safety argument as step 3.
bool stepDoubleCrit(Position& cur, int& offset) {
    bool changed = false;
    for (std::size_t ci = 0; ci < cur.components.size(); ++ci) {
        const Component snapshot = cur.components[ci];
        for (const auto& cand : enumerateDoubleCrits(snapshot)) {
            const auto it = doubleCritRegistry().find(cand.leftKey);
            if (it == doubleCritRegistry().end())
                continue;
            cur.components[ci] = applyCritSwap(cur.components[ci], cand.region,
                                                it->second.head.regions[0],
                                                {cand.slot1, cand.slot2});
            offset ^= it->second.offset;
            recordQuickReduction("[" + it->second.display + "/");
            changed = true;
        }
    }
    return changed;
}

// Step 5: multi-region registry (S_1/C_4/S_5/S_6/S_7's extra elements). NOT batched like steps
// 1-4 -- see the section doc comment above for why (region deletion + reindexing). A local
// fixpoint: apply the lex-least candidate, re-enumerate, repeat until step 5 itself finds nothing
// more. `cur` is kept normalizeQuick'd between applications (unlike steps 1-4) since each
// application needs a stable, already-reindexed position for the next enumeration.
bool stepMultiRegion(Position& cur, int& offset) {
    bool changed = false;
    while (true) {
        bool found = false;
        std::string bestSer, bestKey;
        Position bestPos;
        int bestOff = 0;
        for (std::size_t ci = 0; ci < cur.components.size(); ++ci) {
            const Component& comp = cur.components[ci];
            for (const auto& cand : enumerateMultiCrits(comp)) {
                const auto it = multiRegistry().find(cand.leftKey);
                if (it == multiRegistry().end())
                    continue;
                Position np = cur;
                np.components[ci] =
                    applyMultiCritSwap(comp, cand.regions, cand.slot, it->second.head);
                Position canon = normalizeQuick(np);
                std::string s = serialize(canon);
                if (!found || s < bestSer) {
                    found = true;
                    bestSer = std::move(s);
                    bestPos = std::move(canon);
                    bestOff = it->second.offset;
                    bestKey = "[" + it->second.display + "/";
                }
            }
        }
        if (!found)
            break;
        recordQuickReduction(bestKey);
        cur = std::move(bestPos);
        offset ^= bestOff;
        changed = true;
    }
    return changed;
}

}  // namespace

void resetQuickReductionCounts() {
    quickReductionCountsMutable().clear();
}

const std::map<std::string, long long>& quickReductionCounts() {
    return quickReductionCountsMutable();
}

QuickCanonResult quickCanon(const Position& p) {
    // Base form is structural (Hollow/Split/Triplet; DisaPoints stay decompressed -- step 6 below
    // compresses them once no crit-cell/scab-cell/registry opportunity remains) plus the 22==1
    // rewrite. quickCanon always performs the reduction; the STALKS_COLLECTIONS toggle is applied
    // by the caller (it chooses quickCanon vs the exact canonicalize pipeline).
    Position cur = normalizeQuick(p);
    int offset = 0;

    while (true) {
        bool changed = false;

        // Steps 1-4 are region-local (see the section doc comment above): none of their
        // enumerate*/apply* functions require `cur` to already be in canonical form to find or
        // apply their candidates correctly (regionKey/leftSideKey already re-minimize internally).
        // So run all four to their own local fixpoint against the SAME un-canonicalized `cur`,
        // and canonicalize once at the end of that batch -- not after each individual step. A
        // change introduced by a later step (e.g. double-crit) can expose a fresh opportunity for
        // an earlier one (e.g. crit-cell), so this inner loop keeps re-running steps 1-4 until
        // none of them find anything more, exactly mirroring what the single shared canonicalize
        // call used to do as a side effect of re-normalizing between every step.
        bool batchChanged = false;
        while (true) {
            bool stepChanged = false;
            if (stepCritCell(cur))
                stepChanged = true;
            if (stepSpecialCell(cur))
                stepChanged = true;
            if (stepScabCell(cur))
                stepChanged = true;
            if (stepSingleCrit(cur, offset))
                stepChanged = true;
            if (stepDoubleCrit(cur, offset))
                stepChanged = true;
            if (!stepChanged)
                break;
            batchChanged = true;
        }
        if (batchChanged) {
            cur = normalizeQuick(cur);
            changed = true;
        }

        if (stepMultiRegion(cur, offset))
            changed = true;  // already normalizeQuick'd internally, once per application

        // Step 6: no more crit-cell/scab-cell/registry opportunities this pass. Only now compress
        // DisaPoints (recompress's disapoints=true), so a lone membrane/scab isn't eaten before
        // the pure all-membrane/all-scab region it would otherwise complete gets a chance to merge
        // -- see applyDisaPoints's own doc comment.
        Position withDisa = applyDisaPoints(cur);
        if (serialize(withDisa) != serialize(cur)) {
            cur = std::move(withDisa);
            changed = true;
        }

        if (!changed)
            break;
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
    // Most multi-region families reuse an existing single-/double-crit family's name (they're
    // additional elements of the SAME collection, not new ones) -- append their elements onto the
    // already-emitted roster entry of that name rather than emitting a second entry, so the
    // Collect pane's JSON dump still has exactly one object per collection name. A family whose
    // name doesn't match anything already emitted (added 2026-08-27: S_11/S_11⊕1/S_16, the first
    // multiCritFamilies() entries with a genuinely multi-region rep of their own rather than a
    // borrowed single-region one -- see multiCritFamilies()' own doc comment) has no existing
    // entry to append onto, so it's emitted fresh via addFamily instead, same as any single-/
    // double-crit family.
    for (const auto& fam : multiCritFamilies()) {
        bool anyExisting = false;
        for (const auto& g : fam.groups)
            for (const auto& r : out)
                if (r.name == g.name) {
                    anyExisting = true;
                    break;
                }
        if (!anyExisting) {
            addFamily(fam);
            continue;
        }
        // A group here can still be brand new even though anyExisting is true for the family as a
        // whole -- e.g. S_8⊕1's ONLY elements live here, co-listed with S_8 (already emitted via
        // singleCritFamilies) purely so this branch fires. Bug fixed 2026-08-30: the per-group
        // lookup below used to do nothing when a group's name had no existing `out` entry to append
        // onto, silently dropping that group (and its whole roster.json entry, incl. "S_8⊕1" itself
        // -- caught while adding "S_7⊕1"/"S_12⊕1" the same way). Now falls back to creating a fresh
        // entry with an empty rep (the paired-sibling convention -- see addFamily's own repShown
        // comment), same as if it had been the family's own non-first group all along.
        for (const auto& g : fam.groups) {
            bool found = false;
            for (auto& r : out)
                if (r.name == g.name) {
                    r.elements.insert(r.elements.end(), g.elements.begin(), g.elements.end());
                    found = true;
                    break;
                }
            if (!found)
                out.push_back({g.name, g.offset, {g.elements.begin(), g.elements.end()}, std::string()});
        }
    }
    return out;
}

}  // namespace stalks
