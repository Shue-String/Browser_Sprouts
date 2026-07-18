#define _CRT_SECURE_NO_WARNINGS  // getenv for the STALKS_CANON_CAP override

#include "canon.hpp"

#include "boundary.hpp"
#include "encoding.hpp"
#include "unionfind.hpp"

#include <algorithm>
#include <cstdlib>
#include <functional>
#include <map>
#include <numeric>
#include <string>
#include <unordered_map>
#include <vector>

namespace stalks {

namespace {

// ---------------------------------------------------------------------------
// Labeled working form: each membrane carries the shared identity of its pairing
// (`label`), each joint visit carries its pair identity (`jointId`); 7/8 are re-derived
// on emit so the boundary can be freely rotated. Non-membrane, non-joint tokens (spots,
// appendages, scabs, and compressed pseudo-points) are stored as their token. Pairings
// are re-derived from labels on emit, so surgery never has to remap occ indices.
// ---------------------------------------------------------------------------
struct Slot {
    Token tok = 0;
    int label = -1;    // membrane pairing id (>= 0); -1 otherwise
    int jointId = -1;  // joint pair id (>= 0); -1 otherwise
    // Provenance tag (see Item::srcId in moves.cpp): opaque caller id carried through the whole
    // canonicalization (rotation/reversal/region-boundary reorder/relabel) so the winning layout
    // can report which parent vertex each canonical token descends from. Invisible to every key/
    // emit/signature path here (structKey, emitChunk, sigOf, agnosticBnd all read only
    // tok/label/jointId), so it cannot change the canonical form. Default -1 (untracked path).
    int srcId = -1;
};
using LBnd = std::vector<Slot>;
using LRegion = std::vector<LBnd>;
struct LComp {
    std::vector<LRegion> regions;
};

// `src` (null in the untracked path) stamps each Slot's provenance from a CompSrc parallel to
// c.regions; see moves.hpp CompSrc / Slot::srcId. srcId is invisible to every key/emit path, so
// the untracked canonical output is unaffected.
LComp toLabeled(const Component& c, const CompSrc* src = nullptr) {
    const auto idx = c.pairIndex();
    int nextFree = static_cast<int>(c.pairings.size());
    int nextJoint = 0;
    LComp lc;
    lc.regions.resize(c.regions.size());
    for (std::size_t r = 0; r < c.regions.size(); ++r) {
        lc.regions[r].resize(c.regions[r].size());
        for (std::size_t b = 0; b < c.regions[r].size(); ++b) {
            const Bnd& w = c.regions[r][b];
            std::vector<int> jointAt(w.size(), -1);
            for (const auto& [open, close] : jointPairs(w)) {
                jointAt[static_cast<std::size_t>(open)] = nextJoint;
                jointAt[static_cast<std::size_t>(close)] = nextJoint;
                ++nextJoint;
            }
            LBnd lb;
            lb.reserve(w.size());
            std::uint32_t occ = 0;
            for (std::size_t k = 0; k < w.size(); ++k) {
                Slot s;
                s.tok = w[k];
                if (src)
                    s.srcId = (*src)[r][b][k];
                if (w[k] == MEMB) {
                    const int pi = idx[r][b][occ++];
                    s.label = (pi >= 0) ? pi : nextFree++;
                } else if (isJoint(w[k])) {
                    s.jointId = jointAt[k];
                }
                lb.push_back(s);
            }
            lc.regions[r][b] = std::move(lb);
        }
    }
    return lc;
}

// `srcOut` (null in the untracked path) receives the provenance parallel to the emitted tokens
// (fromLabeled emits exactly one token per Slot, so the walk is 1:1 with out.regions).
Component fromLabeled(const LComp& lc, CompSrc* srcOut = nullptr) {
    Component out;
    std::map<int, std::vector<MRef>> byLabel;
    out.regions.resize(lc.regions.size());
    if (srcOut)
        srcOut->assign(lc.regions.size(), {});
    for (std::uint32_t r = 0; r < lc.regions.size(); ++r) {
        out.regions[r].resize(lc.regions[r].size());
        if (srcOut)
            (*srcOut)[r].resize(lc.regions[r].size());
        for (std::uint32_t b = 0; b < lc.regions[r].size(); ++b) {
            Bnd w;
            std::map<int, bool> seenJoint;
            std::uint32_t occ = 0;
            std::vector<int> bsrc;
            for (const Slot& s : lc.regions[r][b]) {
                if (s.label >= 0) {
                    w.push_back(MEMB);
                    byLabel[s.label].push_back({r, b, occ++});
                } else if (s.jointId >= 0) {
                    const bool first = seenJoint.emplace(s.jointId, true).second;
                    w.push_back(first ? JOINTSTART : JOINTEND);
                } else {
                    w.push_back(s.tok);
                }
                if (srcOut)
                    bsrc.push_back(s.srcId);
            }
            out.regions[r][b] = std::move(w);
            if (srcOut)
                (*srcOut)[r][b] = std::move(bsrc);
        }
    }
    for (const auto& [label, refs] : byLabel) {
        if (refs.size() == 2)
            out.pairings.push_back({refs[0], refs[1]});
        else if (refs.size() != 1)
            throw EncodingError("recompress: membrane label with wrong occurrence count");
    }
    return out;
}

// ---------------------------------------------------------------------------
// Cleanup on the decompressed working form (the same rules as the move engine's
// finishComponent, applied here so that decompressing a compressed position reduces any
// degeneracies it hid -- most importantly a lone DisaPoint region ["3"], which decompresses
// to a lone membrane and must decay to two scabs). Chop adjacent joints, drop empties,
// decay a lone-membrane region (region dies, partner occurrence becomes a scab in place),
// and kill an isolated lone scab. Iterated to a fixpoint.
// ---------------------------------------------------------------------------
bool chopLB(LBnd& b) {
    bool changed = false;
    bool again = true;
    while (again) {
        again = false;
        const int n = static_cast<int>(b.size());
        std::map<int, std::pair<int, int>> visits;
        for (int k = 0; k < n; ++k)
            if (b[static_cast<std::size_t>(k)].jointId >= 0) {
                auto [it, ins] = visits.try_emplace(b[static_cast<std::size_t>(k)].jointId,
                                                    std::make_pair(k, -1));
                if (!ins)
                    it->second.second = k;
            }
        for (const auto& [id, pq] : visits) {
            const auto [p, q] = pq;
            if (q < 0)
                continue;
            if (q == p + 1 || (p == 0 && q == n - 1)) {
                // Distal's two visits are one vertex; the surviving scab keeps its srcId.
                const int keepSrc = b[static_cast<std::size_t>(p)].srcId;
                b.erase(b.begin() + q);
                b[static_cast<std::size_t>(p)] = Slot{SCAB, -1, -1, keepSrc};
                again = changed = true;
                break;
            }
        }
    }
    return changed;
}

void cleanupLC(LComp& c) {
    bool changed = true;
    while (changed) {
        changed = false;
        for (auto& reg : c.regions)
            for (auto& b : reg)
                if (chopLB(b))
                    changed = true;
        for (auto& reg : c.regions) {
            const auto before = reg.size();
            std::erase_if(reg, [](const LBnd& b) { return b.empty(); });
            if (reg.size() != before)
                changed = true;
        }
        {
            const auto before = c.regions.size();
            std::erase_if(c.regions, [](const LRegion& r) { return r.empty(); });
            if (c.regions.size() != before)
                changed = true;
        }
        for (std::size_t r = 0; r < c.regions.size(); ++r) {
            if (c.regions[r].size() != 1 || c.regions[r][0].size() != 1)
                continue;
            const Slot s = c.regions[r][0][0];
            if (s.tok == SCAB && s.label < 0) {  // isolated: dead
                c.regions.erase(c.regions.begin() + static_cast<long long>(r));
                changed = true;
                break;
            }
            if (s.label >= 0) {  // lone membrane: decay
                const int lbl = s.label;
                c.regions.erase(c.regions.begin() + static_cast<long long>(r));
                for (auto& reg2 : c.regions)
                    for (auto& b2 : reg2)
                        for (auto& s2 : b2)
                            if (s2.label == lbl) {
                                s2.tok = SCAB;
                                s2.label = -1;
                            }
                changed = true;
                break;
            }
        }
    }
}

// Decompress a component and clean it up to a stable decompressed form.
Component reduceDecompressed(const Component& c) {
    if (c.dead)
        return c;
    LComp lc = toLabeled(c.decompressed());
    cleanupLC(lc);
    return fromLabeled(lc);
}

// Tracked reduce: as reduceDecompressed but carrying provenance. Requires already-decompressed
// input (the move pipeline's output has no pseudo-points), so it skips the decompress step --
// token-order-identity for pseudo-free input -- and threads srcId through cleanup.
Component reduceDecompressedTracked(const Component& c, const CompSrc& src, CompSrc& srcOut) {
    if (c.dead) {
        srcOut = src;
        return c;
    }
    LComp lc = toLabeled(c, &src);
    cleanupLC(lc);
    return fromLabeled(lc, &srcOut);
}

// ---------------------------------------------------------------------------
// Structured key for choosing between candidate compressions: regions ordered by
// (#boundaries, membrane-agnostic canonical boundary values), so that "fewer boundaries"
// dominates. This picks [23] over [2,3] and the like.
// ---------------------------------------------------------------------------
std::string bndString(const Bnd& b) {
    const Bnd rot = canonicalRotation(b);
    std::string s;
    s.reserve(rot.size());
    for (Token t : rot)
        s.push_back(static_cast<char>('0' + t));
    return s;
}

using RegionKey = std::pair<std::size_t, std::vector<std::string>>;
using CompKey = std::vector<RegionKey>;

CompKey compKey(const Component& c) {
    CompKey key;
    key.reserve(c.regions.size());
    for (const auto& reg : c.regions) {
        std::vector<std::string> bs;
        bs.reserve(reg.size());
        for (const auto& b : reg)
            bs.push_back(bndString(b));
        std::sort(bs.begin(), bs.end());
        key.emplace_back(reg.size(), std::move(bs));
    }
    std::sort(key.begin(), key.end());
    return key;
}

// ---------------------------------------------------------------------------
// Organ detection on the labeled form.
// ---------------------------------------------------------------------------
struct RegionInfo {
    int total = 0;               // living slots across all boundaries
    int membranes = 0;
    int scabs = 0;
    std::vector<int> membLabels;
};

RegionInfo regionInfo(const LComp& lc, int r) {
    RegionInfo ri;
    for (const auto& b : lc.regions[static_cast<std::size_t>(r)]) {
        for (const Slot& s : b) {
            ++ri.total;
            if (s.label >= 0) {
                ++ri.membranes;
                ri.membLabels.push_back(s.label);
            } else if (s.tok == SCAB) {
                ++ri.scabs;
            }
        }
    }
    return ri;
}

// The region index of the other occurrence of `label` (validate guarantees it is a
// different region). Returns -1 if not found.
int partnerRegion(const LComp& lc, int label, int hostRegion) {
    for (int r = 0; r < static_cast<int>(lc.regions.size()); ++r) {
        if (r == hostRegion)
            continue;
        for (const auto& b : lc.regions[static_cast<std::size_t>(r)])
            for (const Slot& s : b)
                if (s.label == label)
                    return r;
    }
    return -1;
}

// Labels of the run of `len` cyclically consecutive slots starting at `sp`, if they are
// all membranes and the positions are distinct; empty otherwise.
std::vector<int> runLabels(const LBnd& b, int sp, int len) {
    const int n = static_cast<int>(b.size());
    if (len > n)
        return {};
    std::vector<int> out;
    for (int t = 0; t < len; ++t) {
        const Slot& s = b[static_cast<std::size_t>((sp + t) % n)];
        if (s.label < 0)
            return {};
        out.push_back(s.label);
    }
    return out;
}

// Apply one compression: replace the run of `len` membranes at `sp` with a single pseudo
// token (in place when the run does not wrap; otherwise rotate it to the front first, so
// the surrounding tokens keep their positions in the common case), and delete the interior
// regions.
Component applyCompress(LComp lc, int hr, int hb, int sp, int len, Token pseudo,
                        std::vector<int> interiors) {
    LBnd& b = lc.regions[static_cast<std::size_t>(hr)][static_cast<std::size_t>(hb)];
    const int n = static_cast<int>(b.size());
    if (sp + len > n) {
        std::rotate(b.begin(), b.begin() + sp, b.end());
        sp = 0;
    }
    b.erase(b.begin() + sp, b.begin() + sp + len);
    b.insert(b.begin() + sp, Slot{pseudo, -1, -1});
    std::sort(interiors.begin(), interiors.end(), std::greater<int>());
    for (int r : interiors)
        lc.regions.erase(lc.regions.begin() + r);
    return fromLabeled(lc);
}

// The single membrane label in region `r` other than `except` (region has exactly two).
int otherMembraneLabel(const RegionInfo& ri, int except) {
    for (int l : ri.membLabels)
        if (l != except)
            return l;
    return -1;
}

// Every one-organ compression of `c`, as resulting components. With `disapoints` false,
// DisaPoints are left decompressed (they are the only pseudo-point whose compression is
// lossy -- it identifies graph-distinct positions -- so base/structural canonization skips
// them; Hollow/Split/Triplet are bijective re-encodings and always safe).
std::vector<Component> allCompressions(const Component& c, bool disapoints) {
    std::vector<Component> out;
    const LComp lc = toLabeled(c);
    for (int hr = 0; hr < static_cast<int>(lc.regions.size()); ++hr) {
        for (int hb = 0; hb < static_cast<int>(lc.regions[static_cast<std::size_t>(hr)].size());
             ++hb) {
            const LBnd& b = lc.regions[static_cast<std::size_t>(hr)][static_cast<std::size_t>(hb)];
            const int n = static_cast<int>(b.size());
            for (int sp = 0; sp < n; ++sp) {
                if (b[static_cast<std::size_t>(sp)].label < 0)
                    continue;

                // Triplet: three consecutive membranes -> one region of exactly three.
                if (const auto r3 = runLabels(b, sp, 3); !r3.empty()) {
                    const int I = partnerRegion(lc, r3[0], hr);
                    if (I >= 0 && partnerRegion(lc, r3[1], hr) == I &&
                        partnerRegion(lc, r3[2], hr) == I) {
                        const RegionInfo ri = regionInfo(lc, I);
                        if (ri.total == 3 && ri.membranes == 3)
                            out.push_back(applyCompress(lc, hr, hb, sp, 3, TRIP, {I}));
                    }
                }

                // Two consecutive membranes: hollow (shared interior) or split.
                if (const auto r2 = runLabels(b, sp, 2); !r2.empty()) {
                    const int I1 = partnerRegion(lc, r2[0], hr);
                    const int I2 = partnerRegion(lc, r2[1], hr);
                    if (I1 >= 0 && I1 == I2) {
                        const RegionInfo ri = regionInfo(lc, I1);
                        if (ri.total == 2 && ri.membranes == 2)
                            out.push_back(applyCompress(lc, hr, hb, sp, 2, HOLL, {I1}));
                    } else if (I1 >= 0 && I2 >= 0) {
                        const RegionInfo ri1 = regionInfo(lc, I1);
                        const RegionInfo ri2 = regionInfo(lc, I2);
                        if (ri1.total == 2 && ri1.membranes == 2 && ri2.total == 2 &&
                            ri2.membranes == 2) {
                            const int lx1 = otherMembraneLabel(ri1, r2[0]);
                            const int lx2 = otherMembraneLabel(ri2, r2[1]);
                            if (lx1 >= 0 && lx1 == lx2)
                                out.push_back(applyCompress(lc, hr, hb, sp, 2, SPLIT, {I1, I2}));
                        }
                    }
                }

                // DisaPoint: a single membrane whose other side is exactly one scab plus
                // that membrane (the interior may be "2A" or "2","A").
                if (disapoints) {
                    const int L = b[static_cast<std::size_t>(sp)].label;
                    const int I = partnerRegion(lc, L, hr);
                    if (I >= 0) {
                        const RegionInfo ri = regionInfo(lc, I);
                        if (ri.total == 2 && ri.membranes == 1 && ri.scabs == 1)
                            out.push_back(applyCompress(lc, hr, hb, sp, 1, DISA, {I}));
                    }
                }
            }
        }
    }
    return out;
}

} // namespace

Component recompress(const Component& c, bool disapoints) {
    if (c.dead)
        return c;
    Component cur = c;
    while (true) {
        std::vector<Component> cands = allCompressions(cur, disapoints);
        if (cands.empty())
            break;
        std::size_t best = 0;
        CompKey bestKey = compKey(cands[0]);
        for (std::size_t i = 1; i < cands.size(); ++i) {
            CompKey k = compKey(cands[i]);
            if (k < bestKey) {
                bestKey = std::move(k);
                best = i;
            }
        }
        cur = std::move(cands[best]);
    }
    return cur;
}

Position recompress(const Position& p, bool disapoints) {
    Position out;
    out.components.reserve(p.components.size());
    for (const auto& c : p.components)
        out.components.push_back(recompress(c, disapoints));
    return out;
}

namespace {

// ---------------------------------------------------------------------------
// Canonization of a single minimal subposition.
//
// A minimal subposition's valid encodings differ only by: choice of walk start per
// boundary (rotation), ordering of boundaries within a region, ordering of regions,
// membrane lettering, and the global chirality (the mirror image is a distinct drawing,
// so canon takes the lesser of the two). There is no independent per-region direction
// freedom for a fixed drawing. canonAlgo's steps 2-4 pin the coarse order using the
// membrane-agnostic (9) skeleton; steps 5-11 resolve the residual symmetry and assign
// letters by first occurrence. We reproduce the same canonical representative by
// enumerating the residue the agnostic skeleton leaves open -- rotations that tie for the
// minimal agnostic value, orderings of equal-agnostic boundaries/regions, and the mirror
// -- and taking the lexicographically least first-occurrence-lettered serialization.
// Because every candidate shares the same (#boundaries-first) region/boundary skeleton,
// raw string order coincides with the structured order the definition calls for.
// ---------------------------------------------------------------------------

// Length-prefixed key so that plain lexicographic comparison reproduces numeric order
// (a boundary/region "value" is an integer, so a shorter string is the smaller number:
// "4" < "19999" < "1772388"). Membranes as letters act as high-base digits, which the
// ASCII order ('A' > '9' > '0') already respects.
std::string pad4(std::size_t n) {
    std::string s = std::to_string(n);
    return std::string(s.size() < 4 ? 4 - s.size() : 0, '0') + s;
}
std::string numKey(const std::string& s) { return pad4(s.size()) + ":" + s; }

// A boundary's token form with every membrane made agnostic (9); joints are re-emitted in
// first-seen order, matching how boundary.cpp reasons about rotations.
Bnd agnosticBnd(const LBnd& lb) {
    Bnd out;
    out.reserve(lb.size());
    std::map<int, bool> seenJoint;
    for (const Slot& s : lb) {
        if (s.label >= 0)
            out.push_back(MEMB);
        else if (s.jointId >= 0)
            out.push_back(seenJoint.emplace(s.jointId, true).second ? JOINTSTART : JOINTEND);
        else
            out.push_back(s.tok);
    }
    return out;
}

// A boundary with no membrane pairing and no joint (label < 0 and jointId < 0 on every slot) --
// e.g. a bare SPOT/SCAB/HOLL/DISA/SPLIT/TRIP token, or any other memb/joint-free content -- carries
// no identity beyond its own token stream: nothing elsewhere in the position refers back to it
// (unlike a membrane, whose pairing partner cares which physical boundary it is, or a joint, whose
// two visits must stay matched). So two such boundaries sharing the same agnostic key are not just
// tied for canonical purposes, they are BYTE-IDENTICAL -- physically swapping them can never be
// observed in any emitted candidate. groupedPermutations uses this to skip permuting them.
bool isTrivialBnd(const LBnd& lb) {
    for (const Slot& s : lb)
        if (s.label >= 0 || s.jointId >= 0)
            return false;
    return true;
}

// All orderings of `ids` (sorted by `keys`) that permute only within equal-key runs. `trivial`,
// when given, marks (by id) boundaries with no membrane/joint identity (see isTrivialBnd): a
// same-key run made entirely of such ids collapses to ONE representative order instead of
// enumerating up to n! permutations, since every physical assignment within the run emits an
// identical result. This is what keeps e.g. an n-isolated-spot start position's per-region
// boundary-order search from blowing up factorially (n spots = n identical trivial boundaries in
// one region) while leaving membrane/joint-bearing runs -- where physical identity genuinely
// matters -- fully enumerated exactly as before.
std::vector<std::vector<int>> groupedPermutations(std::vector<std::pair<std::string, int>> keyed,
                                                   const std::vector<bool>* trivial = nullptr) {
    std::sort(keyed.begin(), keyed.end());
    std::vector<std::vector<int>> result{{}};
    std::size_t i = 0;
    while (i < keyed.size()) {
        std::size_t j = i + 1;
        while (j < keyed.size() && keyed[j].first == keyed[i].first)
            ++j;
        std::vector<int> run;
        for (std::size_t k = i; k < j; ++k)
            run.push_back(keyed[k].second);
        std::sort(run.begin(), run.end());
        std::vector<std::vector<int>> perms;
        const bool allTrivial =
            trivial && std::all_of(run.begin(), run.end(), [&](int id) {
                return (*trivial)[static_cast<std::size_t>(id)];
            });
        if (allTrivial) {
            perms.push_back(run);  // interchangeable -- any one order stands in for all n!
        } else {
            do {
                perms.push_back(run);
            } while (std::next_permutation(run.begin(), run.end()));
        }
        std::vector<std::vector<int>> next;
        next.reserve(result.size() * perms.size());
        for (const auto& base : result)
            for (const auto& p : perms) {
                std::vector<int> v = base;
                v.insert(v.end(), p.begin(), p.end());
                next.push_back(std::move(v));
            }
        result = std::move(next);
        i = j;
    }
    return result;
}

// Emit one candidate layout (region order, per-region boundary order, per-boundary shift).
Component buildCandidate(const LComp& lc, const std::vector<int>& regionOrder,
                         const std::vector<std::vector<int>>& bndOrder,
                         const std::vector<std::vector<int>>& shift,
                         CompSrc* srcOut = nullptr) {
    LComp out;
    out.regions.reserve(regionOrder.size());
    for (int ri : regionOrder) {
        LRegion reg;
        reg.reserve(bndOrder[static_cast<std::size_t>(ri)].size());
        for (int bi : bndOrder[static_cast<std::size_t>(ri)]) {
            LBnd lb = lc.regions[static_cast<std::size_t>(ri)][static_cast<std::size_t>(bi)];
            const int sh = shift[static_cast<std::size_t>(ri)][static_cast<std::size_t>(bi)];
            std::rotate(lb.begin(), lb.begin() + sh, lb.end());
            reg.push_back(std::move(lb));
        }
        out.regions.push_back(std::move(reg));
    }
    return fromLabeled(out, srcOut);
}

// Candidate-space cap: above this many agnostic-tie layouts, canonMinimal uses the exact
// prefix-pruned search instead of the full odometer (same lexicographic minimum, without
// enumerating the whole product). The search proved both exact (byte-identical to the
// odometer on every test position and all n<=5 graph counts) AND far faster (it never
// materializes the region-permutation product and prunes early: 5-spot graph 467s -> 16s), so
// the default cap is 0 -- the search is the primary path and the odometer survives only for
// brute-force verification (canonicalizeBrute) and A/B testing. Override via STALKS_CANON_CAP:
// a huge value forces the odometer everywhere, 0 forces the search everywhere.
double candidateCap() {
    static const double cap = [] {
        const char* e = std::getenv("STALKS_CANON_CAP");
        return e ? std::atof(e) : 0.0;
    }();
    return cap;
}

// Candidate-space threshold above which the exact prefix-pruned search engages automorphism
// (orbit) pruning. Small searches are fast un-pruned, and the pruning's bookkeeping would only
// add overhead there; the factorial blow-up on symmetric positions has a large space, so gating
// on it confines the machinery to where it pays. STALKS_CANON_ORBIT overrides: "0" disables
// pruning entirely (A/B against the un-pruned search / odometer / brute); a positive value sets
// the threshold ("1" forces pruning on for essentially any branching search, used by tests).
// Pruning only ever skips a branch provably automorphic to one already explored, so the canonical
// form is identical whatever the threshold.
double orbitThreshold() {
    static const double t = [] {
        const char* e = std::getenv("STALKS_CANON_ORBIT");
        if (!e)
            return 1024.0;
        const double v = std::atof(e);
        return v > 0.0 ? v : 1e18;  // "0" (or non-numeric) => effectively never
    }();
    return t;
}

// Factorial as a double (group sizes are small; used only to size the candidate space
// without materializing all the region permutations).
double factorialD(std::size_t n) {
    double f = 1.0;
    for (std::size_t i = 2; i <= n; ++i)
        f *= static_cast<double>(i);
    return f;
}

// Canonicalize one component that is assumed to already be a single minimal subposition
// (pairing-connected). Returns the canonical labeled component. With slackOff, only the
// deterministic agnostic-sorted layout is emitted (canonAlgo through step 9): reproducible,
// but not proven to be the lexicographic minimum. Otherwise the true lexicographic minimum is
// returned -- via the full odometer for a small candidate space, or an exact prefix-pruned
// search once that space exceeds candidateCap() (the search replaces the old non-minimal slack
// truncation, so a huge symmetric position is now canonicalized exactly rather than truncated).
std::string structKey(const Component& c);

// `srcIn` (null in the untracked path) tags input tokens with provenance; `srcOut` receives the
// winning layout's provenance, parallel to the returned component. srcIn REQUIRES
// recompressFirst=false (recompress reorders/compresses, breaking the parallel with c0); the
// tracked path only ever canonicalizes the decompressed form, which passes recompressFirst=false.
Component canonMinimal(const Component& c0, bool slackOff, bool recompressFirst = true,
                       bool brute = false, bool structural = true,
                       const CompSrc* srcIn = nullptr, CompSrc* srcOut = nullptr) {
    if (srcIn && recompressFirst)
        throw EncodingError("tracked canonMinimal requires recompressFirst=false");
    // `structural` compresses only Hollow/Split/Triplet (bijective, and it removes the
    // symmetric all-membrane regions that otherwise explode the enumeration below); the full
    // form also compresses DisaPoints, matching the paper's canonAlgo (a Collections-layer,
    // count-reducing canonical form).
    Component c = recompressFirst ? recompress(c0, /*disapoints=*/!structural) : c0;
    if (c.dead) {
        if (srcOut)
            srcOut->clear();
        return c;
    }

    std::string bestKey;  // structured numeric key (valid across differing skeletons)
    Component bestComp;
    CompSrc bestSrc;  // provenance of bestComp (captured in lockstep with bestKey improvements)

    // Chirality freedom is per region: each region's boundary walks may be read in reverse
    // (canonAlgo step 3). Rather than enumerate all 2^R reversal subsets, we force each
    // region to its agnostic-minimal orientation (a reversal that lowers the region's
    // membrane-agnostic value can only lower the labeled value too) and enumerate only the
    // regions whose two orientations tie (symmetric regions), whose orientation the labeling
    // must resolve. The membrane pairings lock any cross-region consequences implicitly: an
    // inconsistent orientation just yields a higher-valued, non-winning candidate.
    const LComp base = toLabeled(c, srcIn);
    const std::size_t R = base.regions.size();

    // Membrane occurrence counts by label (2 = paired -> emitted as a letter, 1 = unpaired ->
    // '9'), for the exact-search emitter below; reversal does not touch labels, so compute once.
    int maxLabel = -1;
    for (const auto& reg : base.regions)
        for (const auto& b : reg)
            for (const Slot& s : b)
                maxLabel = std::max(maxLabel, s.label);
    std::vector<int> labelCount(static_cast<std::size_t>(maxLabel + 1), 0);
    for (const auto& reg : base.regions)
        for (const auto& b : reg)
            for (const Slot& s : b)
                if (s.label >= 0)
                    ++labelCount[static_cast<std::size_t>(s.label)];

    auto regionAgKey = [&](std::size_t r, bool reversed) {
        std::vector<std::string> vals;
        for (const auto& b : base.regions[r]) {
            LBnd lb = b;
            if (reversed)
                std::reverse(lb.begin(), lb.end());
            const Bnd ab = agnosticBnd(lb);
            std::string s;
            for (Token t : canonicalRotation(ab))
                s.push_back(static_cast<char>('0' + t));
            vals.push_back(numKey(s));
        }
        std::sort(vals.begin(), vals.end());
        return vals;
    };

    std::uint32_t forcedMask = 0;
    std::vector<std::size_t> freeRegions;
    for (std::size_t r = 0; r < R; ++r) {
        const auto fwd = regionAgKey(r, false);
        const auto rev = regionAgKey(r, true);
        if (rev < fwd)
            forcedMask |= (1u << r);
        else if (fwd == rev)
            freeRegions.push_back(r);
    }
    std::vector<std::uint32_t> revMasks;
    if (freeRegions.size() <= 16) {
        for (std::uint32_t sub = 0; sub < (1u << freeRegions.size()); ++sub) {
            std::uint32_t m = forcedMask;
            for (std::size_t i = 0; i < freeRegions.size(); ++i)
                if ((sub >> i) & 1u)
                    m |= (1u << freeRegions[i]);
            revMasks.push_back(m);
        }
    } else {
        revMasks = {forcedMask};
    }

    for (std::uint32_t revMask : revMasks) {
        LComp lc = base;
        for (std::size_t r = 0; r < R; ++r)
            if ((revMask >> r) & 1u)
                for (auto& b : lc.regions[r])
                    std::reverse(b.begin(), b.end());

        // Per-boundary: agnostic canonical value string and the shifts achieving it. In
        // brute mode every rotation is a candidate (reference implementation, no pruning).
        std::vector<std::vector<std::string>> agVal(R);
        std::vector<std::vector<std::vector<int>>> shifts(R);
        for (std::size_t r = 0; r < R; ++r) {
            agVal[r].resize(lc.regions[r].size());
            shifts[r].resize(lc.regions[r].size());
            for (std::size_t b = 0; b < lc.regions[r].size(); ++b) {
                const Bnd ab = agnosticBnd(lc.regions[r][b]);
                Bnd canon = canonicalRotation(ab);
                std::string s;
                for (Token t : canon)
                    s.push_back(static_cast<char>('0' + t));
                agVal[r][b] = std::move(s);
                if (brute) {
                    std::vector<int> all(lc.regions[r][b].size());
                    std::iota(all.begin(), all.end(), 0);
                    shifts[r][b] = std::move(all);
                } else {
                    shifts[r][b] = canonicalShifts(ab);
                }
            }
        }

        // Per-region: boundary-order candidates (permute equal-agnostic boundaries; in brute
        // mode permute all) and a region sort key (#boundaries, then sorted agnostic values).
        std::vector<std::vector<std::vector<int>>> bndPerms(R);
        std::vector<std::pair<std::string, int>> regionKeyed;
        regionKeyed.reserve(R);
        for (std::size_t r = 0; r < R; ++r) {
            std::vector<std::pair<std::string, int>> keyed;
            std::vector<bool> trivialBnd(lc.regions[r].size(), false);
            for (std::size_t b = 0; b < lc.regions[r].size(); ++b) {
                keyed.emplace_back(brute ? std::string() : numKey(agVal[r][b]),
                                   static_cast<int>(b));
                if (!brute)
                    trivialBnd[b] = isTrivialBnd(lc.regions[r][static_cast<std::size_t>(b)]);
            }
            bndPerms[r] = groupedPermutations(keyed, brute ? nullptr : &trivialBnd);

            std::vector<std::string> sortedVals;
            for (auto& [v, _] : keyed)
                sortedVals.push_back(v);
            std::sort(sortedVals.begin(), sortedVals.end());
            std::string key = pad4(lc.regions[r].size());
            for (auto& v : sortedVals)
                key += v;
            regionKeyed.emplace_back(brute ? std::string() : std::move(key),
                                     static_cast<int>(r));
        }
        // Region groups (equal region key), ascending: the region-order freedom is a
        // permutation within each group. Compute the groups (cheap) rather than materializing
        // every region permutation, so the exact search can run even when that product is huge.
        std::vector<std::pair<std::string, int>> regionKeyedSorted = regionKeyed;
        std::sort(regionKeyedSorted.begin(), regionKeyedSorted.end());
        std::vector<std::vector<int>> regionGroups;
        for (std::size_t i = 0; i < regionKeyedSorted.size();) {
            std::size_t j = i + 1;
            while (j < regionKeyedSorted.size() &&
                   regionKeyedSorted[j].first == regionKeyedSorted[i].first)
                ++j;
            std::vector<int> grp;
            for (std::size_t k = i; k < j; ++k)
                grp.push_back(regionKeyedSorted[k].second);
            std::sort(grp.begin(), grp.end());
            regionGroups.push_back(std::move(grp));
            i = j;
        }

        // Odometer dimensions: region order (product of per-group factorials), each region's
        // boundary order, each shift.
        double space = 1.0;
        for (const auto& grp : regionGroups)
            space *= factorialD(grp.size());
        for (std::size_t r = 0; r < R; ++r) {
            space *= static_cast<double>(bndPerms[r].size());
            for (std::size_t b = 0; b < lc.regions[r].size(); ++b)
                space *= static_cast<double>(shifts[r][b].size());
        }
        // Explicit slack (caller asked for a fast, reproducible-but-unminimized labeling):
        // group-sorted region order, first boundary order, first shift -- canonAlgo through
        // step 9, one candidate.
        if (!brute && slackOff) {
            std::vector<int> regionOrder;
            for (const auto& grp : regionGroups)
                for (int m : grp)
                    regionOrder.push_back(m);
            std::vector<std::vector<int>> bndOrder(R), shiftVal(R);
            for (std::size_t r = 0; r < R; ++r) {
                bndOrder[r] = bndPerms[r].front();
                shiftVal[r].resize(lc.regions[r].size());
                for (std::size_t b = 0; b < lc.regions[r].size(); ++b)
                    shiftVal[r][b] = shifts[r][b].front();
            }
            CompSrc candSrc;
            Component cand =
                buildCandidate(lc, regionOrder, bndOrder, shiftVal, srcOut ? &candSrc : nullptr);
            std::string k = structKey(cand);
            if (bestKey.empty() || k < bestKey) {
                bestKey = std::move(k);
                bestComp = std::move(cand);
                if (srcOut)
                    bestSrc = std::move(candSrc);
            }
            continue;
        }

        // Exact prefix-pruned search over the SAME candidate space as the odometer below
        // (region orders within equal-key groups, boundary orders within equal-key groups,
        // agnostic-min rotations), used once that space is too large to enumerate outright.
        // Every layout of a fixed position emits every token exactly once and numKey adds a
        // fixed per-boundary overhead, so all keys share one length -- hence a partial key
        // that already exceeds the best full key (compared over its own length) can never be
        // completed to something smaller, and pruning on that prefix is sound. Returns the true
        // lexicographic minimum, so it replaces (not approximates) the removed slack truncation.
        if (!brute && space > candidateCap()) {
            // Slot -> region group, walking the groups in ascending key order.
            std::vector<int> slotGroup(R);
            for (std::size_t g = 0, s = 0; g < regionGroups.size(); ++g)
                for (std::size_t t = 0; t < regionGroups[g].size(); ++t)
                    slotGroup[s++] = static_cast<int>(g);

            // Per-region internal layouts: every (boundary order) x (shift per boundary). A
            // region has few boundaries, so this stays small.
            struct Layout {
                std::vector<int> bndOrder;
                std::vector<int> shiftVal;  // indexed by original boundary index
            };

            // Signature of a laid-out region capturing exactly what emitChunk consumes, but with
            // paired membranes rendered as their raw pairing-label id (not the context-dependent
            // letter). Two layouts of one region with equal signatures therefore emit an identical
            // chunk AND mutate letterOf identically in every lettering context, so one stands in
            // for the other (Layer 1 dedup). It is also the key that maps an automorphism's image
            // layout back to the retained representative (Layer 2). Unpaired membranes collapse to
            // '9' (their identity affects neither the key nor the built Component).
            auto sigOf = [&](int r, const std::vector<int>& bndOrder,
                             const std::vector<int>& shiftVal) {
                std::string sig;
                for (int bi : bndOrder) {
                    LBnd lb = lc.regions[static_cast<std::size_t>(r)][static_cast<std::size_t>(bi)];
                    std::rotate(lb.begin(),
                                lb.begin() + shiftVal[static_cast<std::size_t>(bi)], lb.end());
                    std::map<int, bool> seenJoint;
                    for (const Slot& s : lb) {
                        if (s.label >= 0) {
                            if (labelCount[static_cast<std::size_t>(s.label)] == 2) {
                                sig.push_back('M');
                                sig += std::to_string(s.label);
                                sig.push_back('.');
                            } else {
                                sig.push_back('9');
                            }
                        } else if (s.jointId >= 0) {
                            sig.push_back(seenJoint.emplace(s.jointId, true).second ? '7' : '8');
                        } else {
                            sig.push_back(static_cast<char>('0' + s.tok));
                        }
                    }
                    sig.push_back('|');
                }
                return sig;
            };

            // Deduped layout set per region (Layer 1), remembering each kept layout's signature
            // and a signature->index map (Layer 2 uses it to match an automorphism's image layout
            // back to the retained atom). Dropping duplicate-signature layouts leaves the search
            // result unchanged -- they emit the same key and build the same Component -- and shrinks
            // the atom set the orbit pruning below reasons over.
            std::vector<std::vector<Layout>> layouts(R);
            std::vector<std::map<std::string, int>> sigToLayout(R);
            for (std::size_t r = 0; r < R; ++r) {
                const std::size_t nb = lc.regions[r].size();
                for (const auto& bo : bndPerms[r]) {
                    std::vector<int> idx(nb, 0);
                    while (true) {
                        Layout L;
                        L.bndOrder = bo;
                        L.shiftVal.resize(nb);
                        for (std::size_t b = 0; b < nb; ++b)
                            L.shiftVal[b] = shifts[r][b][static_cast<std::size_t>(idx[b])];
                        const std::string sig = sigOf(static_cast<int>(r), L.bndOrder, L.shiftVal);
                        if (sigToLayout[r]
                                .emplace(sig, static_cast<int>(layouts[r].size()))
                                .second)
                            layouts[r].push_back(std::move(L));
                        std::size_t b = 0;
                        for (; b < nb; ++b) {
                            if (++idx[b] < static_cast<int>(shifts[r][b].size()))
                                break;
                            idx[b] = 0;
                        }
                        if (b == nb)
                            break;
                    }
                }
            }

            // Emit one region's key chunk given the current lettering (mirrors structKey +
            // fromLabeled exactly, so the accumulated prefix equals structKey's prefix of the
            // completed candidate). Updates letterOf/next for membranes seen first here.
            auto emitChunk = [&](int r, const Layout& L, std::vector<char>& letterOf,
                                 char& next) -> std::string {
                std::string chunk = pad4(lc.regions[r].size());
                for (int bi : L.bndOrder) {
                    LBnd lb = lc.regions[r][static_cast<std::size_t>(bi)];
                    std::rotate(lb.begin(),
                                lb.begin() + L.shiftVal[static_cast<std::size_t>(bi)], lb.end());
                    std::string bs;
                    std::map<int, bool> seenJoint;
                    for (const Slot& s : lb) {
                        if (s.label >= 0) {
                            if (labelCount[static_cast<std::size_t>(s.label)] == 2) {
                                char& ch = letterOf[static_cast<std::size_t>(s.label)];
                                if (ch == 0)
                                    ch = next++;
                                bs.push_back(ch);
                            } else {
                                bs.push_back('9');
                            }
                        } else if (s.jointId >= 0) {
                            bs.push_back(seenJoint.emplace(s.jointId, true).second ? '7' : '8');
                        } else {
                            bs.push_back(static_cast<char>('0' + s.tok));
                        }
                    }
                    chunk += numKey(bs);
                }
                return chunk;
            };

            // --- Automorphism (orbit) pruning (Layer 2) ---------------------------------------
            // Atoms are (region, deduped-layout) pairs; the DFS branches over exactly these. When
            // two complete leaves emit the same key, their slot-wise correspondence is a structural
            // automorphism of the subposition; we extract it as a permutation of atoms. At each
            // node we then skip any candidate that a prefix-fixing automorphism maps an
            // already-explored sibling onto -- its subtree yields an identical set of completion
            // keys. Sound because only genuine automorphisms prune, and only relative to the fixed
            // prefix; the worst case (a wrong image) only ever prunes less. Generators are
            // discovered incrementally within this search (per reversal mask), which is enough to
            // collapse the factorial blow-up on highly symmetric positions.
            // Engage orbit pruning only on searches large enough for the automorphism blow-up to
            // matter (`space` is the un-pruned candidate-space upper bound computed above). Small
            // searches -- rigid positions and low-symmetry ones -- run the plain prefix-pruned DFS
            // with none of the bookkeeping below, which is where the pruning would otherwise be a
            // net loss.
            const bool orbit = space > orbitThreshold();
            std::vector<int> atomBase(R + 1, 0);
            for (std::size_t r = 0; r < R; ++r)
                atomBase[r + 1] = atomBase[r] + static_cast<int>(layouts[r].size());
            const int nAtoms = atomBase[R];
            std::vector<int> atomRegion(static_cast<std::size_t>(nAtoms), 0);
            for (std::size_t r = 0; r < R; ++r)
                for (int a = atomBase[r]; a < atomBase[r + 1]; ++a)
                    atomRegion[static_cast<std::size_t>(a)] = static_cast<int>(r);
            auto atomId = [&](int r, int li) {
                return atomBase[static_cast<std::size_t>(r)] + li;
            };

            std::vector<std::vector<int>> gens;  // automorphisms as atom permutations (+ inverses)
            std::unordered_map<std::string, std::vector<int>>
                leafByKey;  // key -> first leaf's atom sequence

            // Compose the automorphism witnessed by two equal-key leaves into a full atom
            // permutation. At each slot region rA (layout la) corresponds to region rB (layout lb);
            // the k-th boundary of la's order maps to the k-th of lb's, with a rotation offset that
            // carries la onto lb. Applying that boundary map + offset to every layout of rA yields
            // its image layout in rB, matched back to the retained atom by signature. Returns an
            // empty vector (skip this generator -- always sound) if any image is unexpectedly
            // absent from the retained set.
            auto makeGen = [&](const std::vector<int>& leafA,
                               const std::vector<int>& leafB) -> std::vector<int> {
                std::vector<int> sigma(static_cast<std::size_t>(nAtoms), -1);
                for (std::size_t i = 0; i < leafA.size(); ++i) {
                    const int aA = leafA[i], aB = leafB[i];
                    const int rA = atomRegion[static_cast<std::size_t>(aA)];
                    const int rB = atomRegion[static_cast<std::size_t>(aB)];
                    const Layout& la = layouts[static_cast<std::size_t>(rA)]
                                              [static_cast<std::size_t>(aA - atomBase[rA])];
                    const Layout& lb = layouts[static_cast<std::size_t>(rB)]
                                              [static_cast<std::size_t>(aB - atomBase[rB])];
                    const std::size_t nb = lc.regions[static_cast<std::size_t>(rA)].size();
                    std::vector<int> bmap(nb, -1);  // rA boundary index -> rB boundary index
                    for (std::size_t k = 0; k < nb; ++k)
                        bmap[static_cast<std::size_t>(la.bndOrder[k])] = lb.bndOrder[k];
                    std::vector<int> off(nb, 0);  // rotation carrying la's boundary onto lb's
                    for (std::size_t j = 0; j < nb; ++j) {
                        const int Lj = static_cast<int>(
                            lc.regions[static_cast<std::size_t>(rA)][j].size());
                        off[j] = ((lb.shiftVal[static_cast<std::size_t>(bmap[j])] - la.shiftVal[j])
                                      % Lj + Lj) % Lj;
                    }
                    const std::size_t nL = layouts[static_cast<std::size_t>(rA)].size();
                    for (int li2 = 0; li2 < static_cast<int>(nL); ++li2) {
                        const Layout& L2 = layouts[static_cast<std::size_t>(rA)]
                                                  [static_cast<std::size_t>(li2)];
                        std::vector<int> bo2(nb), sh2(nb, 0);
                        for (std::size_t k = 0; k < nb; ++k)
                            bo2[k] = bmap[static_cast<std::size_t>(L2.bndOrder[k])];
                        for (std::size_t j = 0; j < nb; ++j) {
                            const int Lj = static_cast<int>(
                                lc.regions[static_cast<std::size_t>(rA)][j].size());
                            sh2[static_cast<std::size_t>(bmap[j])] =
                                (L2.shiftVal[j] + off[j]) % Lj;
                        }
                        const auto it = sigToLayout[static_cast<std::size_t>(rB)].find(
                            sigOf(rB, bo2, sh2));
                        if (it == sigToLayout[static_cast<std::size_t>(rB)].end())
                            return {};
                        sigma[static_cast<std::size_t>(atomId(rA, li2))] = atomId(rB, it->second);
                    }
                }
                return sigma;
            };
            auto addGen = [&](std::vector<int> sigma) {
                std::vector<int> inv(static_cast<std::size_t>(nAtoms));
                for (int a = 0; a < nAtoms; ++a)
                    inv[static_cast<std::size_t>(sigma[static_cast<std::size_t>(a)])] = a;
                gens.push_back(std::move(sigma));
                gens.push_back(std::move(inv));
            };

            std::vector<char> used(R, 0);
            std::vector<int> chosenReg;
            std::vector<Layout> chosenLay;
            std::vector<int> chosenAtom;  // placed prefix as atom ids (for orbit fixing/extraction)
            chosenReg.reserve(R);
            chosenLay.reserve(R);
            chosenAtom.reserve(R);

            // Mark the orbit of `start` under the generators that fix every placed atom, by BFS.
            auto markOrbit = [&](int start, std::vector<char>& covered) {
                std::vector<int> stack{start};
                covered[static_cast<std::size_t>(start)] = 1;
                while (!stack.empty()) {
                    const int x = stack.back();
                    stack.pop_back();
                    for (const auto& sigma : gens) {
                        bool fixes = true;
                        for (int p : chosenAtom)
                            if (sigma[static_cast<std::size_t>(p)] != p) {
                                fixes = false;
                                break;
                            }
                        if (!fixes)
                            continue;
                        const int y = sigma[static_cast<std::size_t>(x)];
                        if (!covered[static_cast<std::size_t>(y)]) {
                            covered[static_cast<std::size_t>(y)] = 1;
                            stack.push_back(y);
                        }
                    }
                }
            };

            std::function<void(std::size_t, std::vector<char>, char, const std::string&)> dfs =
                [&](std::size_t slot, std::vector<char> letterOf, char next,
                    const std::string& prefix) {
                    if (slot == R) {
                        if (bestKey.empty() || prefix < bestKey) {
                            std::vector<std::vector<int>> bndOrder(R), shiftVal(R);
                            for (std::size_t s = 0; s < R; ++s) {
                                const std::size_t m = static_cast<std::size_t>(chosenReg[s]);
                                bndOrder[m] = chosenLay[s].bndOrder;
                                shiftVal[m] = chosenLay[s].shiftVal;
                            }
                            CompSrc candSrc;
                            bestComp = buildCandidate(lc, chosenReg, bndOrder, shiftVal,
                                                      srcOut ? &candSrc : nullptr);
                            bestKey = prefix;
                            if (srcOut)
                                bestSrc = std::move(candSrc);
                        }
                        if (orbit) {
                            // A second leaf with the same key witnesses an automorphism; turn the
                            // first-vs-this correspondence into a generator for future pruning.
                            if (auto it = leafByKey.find(prefix); it != leafByKey.end()) {
                                std::vector<int> sigma = makeGen(it->second, chosenAtom);
                                if (!sigma.empty())
                                    addGen(std::move(sigma));
                            } else {
                                leafByKey.emplace(prefix, chosenAtom);
                            }
                        }
                        return;
                    }
                    const int g = slotGroup[slot];
                    std::vector<int> explored;  // representatives already taken at this node
                    for (int m : regionGroups[static_cast<std::size_t>(g)]) {
                        if (used[static_cast<std::size_t>(m)])
                            continue;
                        for (int li = 0;
                             li < static_cast<int>(layouts[static_cast<std::size_t>(m)].size());
                             ++li) {
                            const int aid = orbit ? atomId(m, li) : 0;
                            if (orbit && !gens.empty() && !explored.empty()) {
                                // Skip if a prefix-fixing automorphism maps an already-taken
                                // representative onto this atom (identical subtree). Recompute the
                                // covered set each time so generators discovered mid-loop apply.
                                std::vector<char> covered(static_cast<std::size_t>(nAtoms), 0);
                                for (int e : explored)
                                    markOrbit(e, covered);
                                if (covered[static_cast<std::size_t>(aid)])
                                    continue;
                            }
                            const Layout& L =
                                layouts[static_cast<std::size_t>(m)][static_cast<std::size_t>(li)];
                            std::vector<char> lo = letterOf;
                            char nx = next;
                            const std::string np = prefix + emitChunk(m, L, lo, nx);
                            if (orbit)
                                explored.push_back(aid);  // representative (a loser prunes its
                                                          // automorphic siblings too -- same chunk)
                            // Prune: this prefix already loses to the best full key.
                            if (!bestKey.empty() && bestKey.compare(0, np.size(), np) < 0)
                                continue;
                            used[static_cast<std::size_t>(m)] = 1;
                            chosenReg.push_back(m);
                            chosenLay.push_back(L);
                            if (orbit)
                                chosenAtom.push_back(aid);
                            dfs(slot + 1, std::move(lo), nx, np);
                            if (orbit)
                                chosenAtom.pop_back();
                            chosenReg.pop_back();
                            chosenLay.pop_back();
                            used[static_cast<std::size_t>(m)] = 0;
                        }
                    }
                };

            dfs(0, std::vector<char>(static_cast<std::size_t>(maxLabel + 1), 0), 'A', pad4(R));
            continue;
        }

        // Full residue enumeration (odometer): exact, for brute mode or a small candidate space.
        const std::vector<std::vector<int>> regionPerms = groupedPermutations(regionKeyed);

        auto emit = [&](int regionPermIdx, const std::vector<int>& bndPermIdx,
                        const std::vector<std::vector<int>>& shiftIdx) {
            std::vector<std::vector<int>> bndOrder(R);
            std::vector<std::vector<int>> shiftVal(R);
            for (std::size_t r = 0; r < R; ++r) {
                bndOrder[r] = bndPerms[r][static_cast<std::size_t>(bndPermIdx[r])];
                shiftVal[r].resize(lc.regions[r].size());
                for (std::size_t b = 0; b < lc.regions[r].size(); ++b)
                    shiftVal[r][b] = shifts[r][b][static_cast<std::size_t>(shiftIdx[r][b])];
            }
            CompSrc candSrc;
            Component cand =
                buildCandidate(lc, regionPerms[static_cast<std::size_t>(regionPermIdx)], bndOrder,
                               shiftVal, srcOut ? &candSrc : nullptr);
            std::string k = structKey(cand);
            if (bestKey.empty() || k < bestKey) {
                bestKey = std::move(k);
                bestComp = std::move(cand);
                if (srcOut)
                    bestSrc = std::move(candSrc);
            }
        };

        std::vector<int> bndPermIdx(R, 0);
        std::vector<std::vector<int>> shiftIdx(R);
        for (std::size_t r = 0; r < R; ++r)
            shiftIdx[r].assign(lc.regions[r].size(), 0);

        for (std::size_t rp = 0; rp < regionPerms.size(); ++rp) {
            // Reset inner odometers.
            std::fill(bndPermIdx.begin(), bndPermIdx.end(), 0);
            for (auto& v : shiftIdx)
                std::fill(v.begin(), v.end(), 0);
            while (true) {
                emit(static_cast<int>(rp), bndPermIdx, shiftIdx);
                // Advance the combined (boundary-order, shift) odometer.
                bool carry = true;
                for (std::size_t r = 0; r < R && carry; ++r) {
                    for (std::size_t b = 0; b < lc.regions[r].size() && carry; ++b) {
                        if (++shiftIdx[r][b] < static_cast<int>(shifts[r][b].size()))
                            carry = false;
                        else
                            shiftIdx[r][b] = 0;
                    }
                    if (carry) {
                        if (++bndPermIdx[r] < static_cast<int>(bndPerms[r].size()))
                            carry = false;
                        else
                            bndPermIdx[r] = 0;
                    }
                }
                if (carry)
                    break;
            }
        }
    }
    if (srcOut)
        *srcOut = std::move(bestSrc);
    return bestComp;
}

// Structured numeric key of an already-canonical component, for ordering minimal
// subpositions: region count, then per region the boundary count and its length-prefixed
// lettered boundary values. Plain lexicographic comparison of the key reproduces the
// paper's ordering (subpositions by region count; regions by boundary count then value).
std::string structKey(const Component& c) {
    if (c.dead)
        return "\xff";
    const auto pairIdx = c.pairIndex();
    std::vector<char> letterOfPair(c.pairings.size(), 0);
    char next = 'A';
    std::string k = pad4(c.regions.size());
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        k += pad4(c.regions[r].size());
        for (std::uint32_t b = 0; b < c.regions[r].size(); ++b) {
            std::string bs;
            std::uint32_t occ = 0;
            for (Token t : c.regions[r][b]) {
                if (t == MEMB) {
                    const int pi = pairIdx[r][b][occ++];
                    if (pi < 0) {
                        bs.push_back('9');
                    } else {
                        if (letterOfPair[static_cast<std::size_t>(pi)] == 0)
                            letterOfPair[static_cast<std::size_t>(pi)] = next++;
                        bs.push_back(letterOfPair[static_cast<std::size_t>(pi)]);
                    }
                } else {
                    bs.push_back(static_cast<char>('0' + t));
                }
            }
            k += numKey(bs);
        }
    }
    return k;
}

// Split a component into its pairing-connected pieces (the minimal subpositions). The
// piece containing the lowest original region index comes first (order is re-derived by
// canonicalize's final sort anyway).
std::vector<Component> splitMinimal(const Component& c) {
    if (c.dead)
        return {c};
    const std::size_t n = c.regions.size();
    UnionFind uf(n);
    for (const auto& [a, b] : c.pairings)
        uf.unite(static_cast<int>(a.region), static_cast<int>(b.region));

    std::map<int, std::vector<std::uint32_t>> groups;
    for (std::uint32_t r = 0; r < n; ++r)
        groups[uf.find(static_cast<int>(r))].push_back(r);

    std::vector<Component> out;
    for (auto& [_, regs] : groups) {
        Component piece;
        std::map<std::uint32_t, std::uint32_t> remap;
        for (std::uint32_t nr = 0; nr < regs.size(); ++nr) {
            remap[regs[nr]] = nr;
            piece.regions.push_back(c.regions[regs[nr]]);
        }
        for (const auto& [a, b] : c.pairings)
            if (remap.count(a.region))
                piece.pairings.push_back({{remap[a.region], a.boundary, a.occ},
                                          {remap[b.region], b.boundary, b.occ}});
        out.push_back(std::move(piece));
    }
    return out;
}

// Tracked split: as splitMinimal but the parallel CompSrc `src` is regrouped in lockstep, so each
// piece comes with its own provenance parallel to that piece's regions.
std::vector<std::pair<Component, CompSrc>>
splitMinimalTracked(const Component& c, const CompSrc& src) {
    if (c.dead)
        return {{c, src}};
    const std::size_t n = c.regions.size();
    UnionFind uf(n);
    for (const auto& [a, b] : c.pairings)
        uf.unite(static_cast<int>(a.region), static_cast<int>(b.region));

    std::map<int, std::vector<std::uint32_t>> groups;
    for (std::uint32_t r = 0; r < n; ++r)
        groups[uf.find(static_cast<int>(r))].push_back(r);

    std::vector<std::pair<Component, CompSrc>> out;
    for (auto& [_, regs] : groups) {
        Component piece;
        CompSrc psrc;
        std::map<std::uint32_t, std::uint32_t> remap;
        for (std::uint32_t nr = 0; nr < regs.size(); ++nr) {
            remap[regs[nr]] = nr;
            piece.regions.push_back(c.regions[regs[nr]]);
            psrc.push_back(src[regs[nr]]);
        }
        for (const auto& [a, b] : c.pairings)
            if (remap.count(a.region))
                piece.pairings.push_back({{remap[a.region], a.boundary, a.occ},
                                          {remap[b.region], b.boundary, b.occ}});
        out.emplace_back(std::move(piece), std::move(psrc));
    }
    return out;
}

} // namespace

namespace {

Position canonicalizeImpl(const Position& p, bool slackOff, bool compressed, bool brute = false,
                          bool structural = true) {
    std::vector<Component> minimals;
    bool anyLive = false;
    for (const auto& comp : p.components) {
        if (comp.dead)
            continue;
        // Reduce to a stable form first (decompress + cleanup): this collapses degenerate
        // compressed cells such as a lone DisaPoint. canonMinimal then recompresses to the
        // requested level (structural Hollow/Split/Triplet, or full incl. DisaPoints), or not
        // at all for the decompressed graph.
        const Component reduced = reduceDecompressed(comp);
        for (auto& piece : splitMinimal(reduced)) {
            minimals.push_back(
                canonMinimal(piece, slackOff, /*recompressFirst=*/compressed, brute, structural));
            anyLive = true;
        }
    }
    Position out;
    if (!anyLive) {
        Component dead;
        dead.dead = true;
        out.components.push_back(std::move(dead));
        return out;
    }
    std::sort(minimals.begin(), minimals.end(),
              [](const Component& a, const Component& b) {
                  return structKey(a) < structKey(b);
              });
    out.components = std::move(minimals);
    return out;
}

} // namespace

Position canonicalize(const Position& p, bool slackOff) {
    return canonicalizeImpl(p, slackOff, /*compressed=*/true, /*brute=*/false, /*structural=*/true);
}

Position canonicalizeFull(const Position& p, bool slackOff) {
    return canonicalizeImpl(p, slackOff, /*compressed=*/true, /*brute=*/false, /*structural=*/false);
}

Position canonicalizeDecompressed(const Position& p, bool slackOff) {
    return canonicalizeImpl(p, slackOff, /*compressed=*/false);
}

TrackedCanon canonicalizeDecompressedTracked(const Position& p, const std::vector<CompSrc>& src) {
    // Mirrors canonicalizeImpl(compressed=false) but threads provenance: reduce (skipping the
    // pseudo-free-identity decompress), split, and canonMinimal all carry a parallel CompSrc, and
    // the final subposition sort moves each component's provenance with it. Token form is
    // identical to canonicalizeDecompressed(p) (srcId never affects a key/emit path).
    struct M {
        Component comp;
        CompSrc src;
    };
    std::vector<M> minimals;
    for (std::size_t i = 0; i < p.components.size(); ++i) {
        const Component& comp = p.components[i];
        if (comp.dead)
            continue;
        CompSrc reducedSrc;
        const Component reduced = reduceDecompressedTracked(comp, src[i], reducedSrc);
        for (auto& [piece, pieceSrc] : splitMinimalTracked(reduced, reducedSrc)) {
            CompSrc canonSrc;
            Component canon =
                canonMinimal(piece, /*slackOff=*/false, /*recompressFirst=*/false, /*brute=*/false,
                             /*structural=*/true, &pieceSrc, &canonSrc);
            minimals.push_back({std::move(canon), std::move(canonSrc)});
        }
    }
    TrackedCanon out;
    if (minimals.empty()) {
        Component dead;
        dead.dead = true;
        out.pos.components.push_back(std::move(dead));
        out.src.push_back(CompSrc{});
        return out;
    }
    std::sort(minimals.begin(), minimals.end(),
              [](const M& a, const M& b) { return structKey(a.comp) < structKey(b.comp); });
    for (auto& m : minimals) {
        out.pos.components.push_back(std::move(m.comp));
        out.src.push_back(std::move(m.src));
    }
    return out;
}

Position canonicalizeBrute(const Position& p) {
    return canonicalizeImpl(p, /*slackOff=*/false, /*compressed=*/false, /*brute=*/true);
}

} // namespace stalks
