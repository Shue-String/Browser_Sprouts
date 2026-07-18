#include "moves.hpp"

#include "boundary.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "unionfind.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <utility>

namespace stalks {

namespace {

// Working representation during a move: tokens tagged with index-free identities so
// that walk surgery never has to remap occ indices or Dyck positions. Membrane
// identity lives in membLabel (shared by the two occurrences of one membrane); joint
// identity in jointId (shared by the two visits). 7/8 are re-derived at emission.
struct Item {
    Token tok;
    int membLabel = -1;
    int jointId = -1;
    // Provenance tag: an opaque caller-supplied id (a live VertexId, in the frontend) that
    // rides every transformation so a token in the child can be traced back to the parent
    // vertex it descends from, or to GEN_SRC for the vertex the move generates. Invisible to
    // every canonical-value/key/emit path (they read only tok/membLabel/jointId), so it can
    // never perturb canonicalization; struct-copy transforms (rotate/reverse/reorder) carry it
    // for free, and only type-changing transforms (transmute/chop/decay/consume) set it
    // explicitly. Default -1 (unset) in the untracked path.
    int srcId = -1;
};

Item memb(int label, int srcId = -1) { return Item{MEMB, label, -1, srcId}; }

using IWalk = std::vector<Item>;
using IRegion = std::vector<IWalk>;

struct IComp {
    std::vector<IRegion> regions;
    int nextLabel = 0;
    int nextJoint = 0;
};

// Build the labeled working form. Pseudo-points (3/4/5/6) are only legal here for the
// interior-move path (allowPseudo); they ride along as opaque Items. The exterior move
// generators reject them earlier.
IComp labeled(const Component& c, bool allowPseudo = false, const CompSrc* src = nullptr) {
    if (c.dead)
        throw EncodingError("cannot move in a dead component");
    const auto pairIdx = c.pairIndex();
    IComp out;
    out.nextLabel = static_cast<int>(c.pairings.size());
    out.regions.resize(c.regions.size());
    for (std::size_t r = 0; r < c.regions.size(); ++r) {
        for (std::size_t b = 0; b < c.regions[r].size(); ++b) {
            const Bnd& w = c.regions[r][b];
            std::vector<int> jointAt(w.size(), -1);
            for (const auto& [open, close] : jointPairs(w)) {
                jointAt[static_cast<std::size_t>(open)] = out.nextJoint;
                jointAt[static_cast<std::size_t>(close)] = out.nextJoint;
                ++out.nextJoint;
            }
            IWalk iw;
            iw.reserve(w.size());
            std::uint32_t occ = 0;
            for (std::size_t k = 0; k < w.size(); ++k) {
                Item it{w[k], -1, -1};
                if (src)
                    it.srcId = (*src)[r][b][k];
                if (w[k] == MEMB) {
                    const int pi = pairIdx[r][b][occ++];
                    if (pi < 0)
                        throw EncodingError(
                            "move engine requires fully paired membranes (no bare 9s)");
                    it.membLabel = pi;
                } else if (isJoint(w[k])) {
                    it.jointId = jointAt[k];
                } else if (isPseudo(w[k]) && !allowPseudo) {
                    throw EncodingError("decompress pseudo-points before generating moves");
                }
                iw.push_back(it);
            }
            out.regions[r].push_back(std::move(iw));
        }
    }
    return out;
}

// Emit a walk as tokens, re-deriving 7/8 in first-seen order.
Bnd emitBnd(const IWalk& w) {
    Bnd out;
    out.reserve(w.size());
    std::set<int> seen;
    for (const auto& it : w) {
        if (it.jointId >= 0)
            out.push_back(seen.insert(it.jointId).second ? JOINTSTART : JOINTEND);
        else
            out.push_back(it.tok);
    }
    return out;
}

// The paper's "chop": a joint whose two visits are cyclically adjacent is a distal and
// collapses to a single scab. Repeats until stable (chops can cascade).
bool chopWalk(IWalk& w) {
    bool changed = false;
    bool again = true;
    while (again) {
        again = false;
        const int n = static_cast<int>(w.size());
        std::map<int, std::pair<int, int>> visits;
        for (int k = 0; k < n; ++k)
            if (w[static_cast<std::size_t>(k)].jointId >= 0) {
                auto [it, ins] = visits.try_emplace(w[static_cast<std::size_t>(k)].jointId,
                                                    std::make_pair(k, -1));
                if (!ins)
                    it->second.second = k;
            }
        for (const auto& [id, pq] : visits) {
            const auto [p, q] = pq;
            if (q < 0)
                continue;
            if (q == p + 1 || (p == 0 && q == n - 1)) {
                // The distal's two visits are one vertex; the surviving scab keeps its srcId.
                const int keepSrc = w[static_cast<std::size_t>(p)].srcId;
                w.erase(w.begin() + q);
                w[static_cast<std::size_t>(p)] = Item{SCAB, -1, -1, keepSrc};
                again = changed = true;
                break;
            }
        }
    }
    return changed;
}

// Chop, drop empties, decay (membrane alone in a region: the region dies, the other
// occurrence becomes a scab in place), isolation (scab alone in a region is dead).
// Iterated to fixpoint.
void cleanup(IComp& c) {
    bool changed = true;
    while (changed) {
        changed = false;
        for (auto& reg : c.regions)
            for (auto& w : reg)
                if (chopWalk(w))
                    changed = true;
        for (auto& reg : c.regions) {
            const auto before = reg.size();
            std::erase_if(reg, [](const IWalk& w) { return w.empty(); });
            if (reg.size() != before)
                changed = true;
        }
        {
            const auto before = c.regions.size();
            std::erase_if(c.regions, [](const IRegion& r) { return r.empty(); });
            if (c.regions.size() != before)
                changed = true;
        }
        for (std::size_t r = 0; r < c.regions.size(); ++r) {
            auto& reg = c.regions[r];
            if (reg.size() != 1 || reg[0].size() != 1)
                continue;
            const Item it = reg[0][0];
            if (it.tok == SCAB) {  // isolated: dead
                c.regions.erase(c.regions.begin() + static_cast<long long>(r));
                changed = true;
                break;
            }
            if (it.tok == MEMB) {  // decay
                const int lbl = it.membLabel;
                c.regions.erase(c.regions.begin() + static_cast<long long>(r));
                for (auto& reg2 : c.regions)
                    for (auto& w2 : reg2)
                        for (auto& it2 : w2)
                            if (it2.membLabel == lbl) {
                                it2.tok = SCAB;
                                it2.membLabel = -1;
                            }
                changed = true;
                break;
            }
        }
    }
}

// Slacked pre-canon rotation: lexicographically least emitted form; first minimal
// shift on ties (deterministic, not proven minimal across membrane labelings).
void normalizeWalk(IWalk& w) {
    const int n = static_cast<int>(w.size());
    if (n < 2)
        return;
    IWalk cur = w;
    IWalk best = w;
    Bnd bestKey = emitBnd(w);
    for (int s = 1; s < n; ++s) {
        std::rotate(cur.begin(), cur.begin() + 1, cur.end());
        Bnd key = emitBnd(cur);
        if (key < bestKey) {
            bestKey = std::move(key);
            best = cur;
        }
    }
    w = std::move(best);
}

std::vector<Bnd> regionKey(const IRegion& reg) {
    std::vector<Bnd> key;
    key.reserve(reg.size());
    for (const auto& w : reg)
        key.push_back(emitBnd(w));
    return key;
}

IRegion normalizedCopy(IRegion reg) {
    for (auto& w : reg)
        normalizeWalk(w);
    std::sort(reg.begin(), reg.end(),
              [](const IWalk& a, const IWalk& b) { return emitBnd(a) < emitBnd(b); });
    return reg;
}

// Rotate boundaries canonically, sort them, and mirror the whole region if the
// mirrored form sorts strictly lower (old lesserOrder / flipReversedRegions).
void normalizeRegion(IRegion& reg) {
    IRegion fwd = normalizedCopy(reg);
    IRegion rev = reg;
    for (auto& w : rev)
        std::reverse(w.begin(), w.end());
    rev = normalizedCopy(std::move(rev));
    reg = (regionKey(rev) < regionKey(fwd)) ? std::move(rev) : std::move(fwd);
}

// Emit the token Component and, in lockstep, the parallel provenance (srcOut[r][b][k] is the
// srcId of the k-th emitted token). emitBnd emits exactly one token per Item, so the walk of
// srcIds is 1:1 with the emitted boundary.
Component emitComponent(const std::vector<IRegion>& regs, CompSrc& srcOut) {
    Component out;
    srcOut.assign(regs.size(), {});
    std::map<int, std::vector<MRef>> byLabel;
    for (std::uint32_t r = 0; r < regs.size(); ++r) {
        std::vector<Bnd> region;
        srcOut[r].resize(regs[r].size());
        for (std::uint32_t b = 0; b < regs[r].size(); ++b) {
            std::uint32_t occ = 0;
            std::vector<int> bsrc;
            bsrc.reserve(regs[r][b].size());
            for (const auto& it : regs[r][b]) {
                if (it.tok == MEMB)
                    byLabel[it.membLabel].push_back({r, b, occ++});
                bsrc.push_back(it.srcId);
            }
            region.push_back(emitBnd(regs[r][b]));
            srcOut[r][b] = std::move(bsrc);
        }
        out.regions.push_back(std::move(region));
    }
    for (const auto& [label, refs] : byLabel) {
        if (refs.size() != 2)
            throw EncodingError("internal: membrane label without exactly two occurrences");
        out.pairings.push_back({refs[0], refs[1]});
    }
    return out;
}

// Split into pairing-connected components (the oplus decomposition), sort regions
// within each per the pre-canon rules, and emit. Components come out ordered by the
// smallest region index they contain. Each emitted component is paired with its provenance.
std::vector<std::pair<Component, CompSrc>> splitAndEmit(const IComp& ic) {
    const std::size_t n = ic.regions.size();
    if (n == 0) {
        Component dead;
        dead.dead = true;
        return {{std::move(dead), CompSrc{}}};
    }
    UnionFind uf(n);
    std::map<int, int> firstRegionOfLabel;
    for (std::size_t r = 0; r < n; ++r)
        for (const auto& w : ic.regions[r])
            for (const auto& it : w)
                if (it.membLabel >= 0) {
                    auto [pos, ins] =
                        firstRegionOfLabel.try_emplace(it.membLabel, static_cast<int>(r));
                    if (!ins)
                        uf.unite(pos->second, static_cast<int>(r));
                }

    std::map<int, std::size_t> rootOrder;
    std::vector<std::vector<IRegion>> groups;
    for (std::size_t r = 0; r < n; ++r) {
        const int root = uf.find(static_cast<int>(r));
        auto [it, ins] = rootOrder.try_emplace(root, groups.size());
        if (ins)
            groups.emplace_back();
        groups[it->second].push_back(ic.regions[r]);
    }

    std::vector<std::pair<Component, CompSrc>> out;
    out.reserve(groups.size());
    for (auto& regs : groups) {
        std::sort(regs.begin(), regs.end(), [](const IRegion& a, const IRegion& b) {
            if (a.size() != b.size())
                return a.size() < b.size();
            return regionKey(a) < regionKey(b);
        });
        CompSrc src;
        Component c = emitComponent(regs, src);
        out.emplace_back(std::move(c), std::move(src));
    }
    return out;
}

// Common move tail: cleanup to fixpoint, normalize every region, split into pairing-
// connected components. Each emitted piece carries its provenance (parallel to its regions).
std::vector<std::pair<Component, CompSrc>> finishComponent(IComp& ic) {
    cleanup(ic);
    for (auto& reg : ic.regions)
        normalizeRegion(reg);
    return splitAndEmit(ic);
}

// Drop provenance from a finishComponent result (for the untracked public API).
std::vector<Component> stripSrc(std::vector<std::pair<Component, CompSrc>>&& v) {
    std::vector<Component> out;
    out.reserve(v.size());
    for (auto& [c, s] : v) {
        (void)s;
        out.push_back(std::move(c));
    }
    return out;
}

// Splice the pieces produced by a move on component `comp` back into a full position,
// dropping dead pieces unless the whole child is dead (then a single phi remains).
Position spliceChild(const Position& p, std::size_t comp,
                     const std::vector<Component>& pieces) {
    Position child;
    for (std::size_t q = 0; q < p.components.size(); ++q) {
        if (q == comp) {
            for (const auto& pc : pieces)
                if (!pc.dead)
                    child.components.push_back(pc);
        } else if (!p.components[q].dead) {
            child.components.push_back(p.components[q]);
        }
    }
    if (child.components.empty()) {
        Component dead;
        dead.dead = true;
        child.components.push_back(dead);
    }
    return child;
}

// spliceChild carrying provenance: the moved component's tracked pieces bring their own CompSrc;
// every other (live) component carries its parent provenance psrc[q] through unchanged. Fills
// `child` and the parallel `childSrc` (one CompSrc per surviving component).
void spliceChildTracked(const Position& p, const std::vector<CompSrc>& psrc, std::size_t comp,
                        const std::vector<std::pair<Component, CompSrc>>& pieces, Position& child,
                        std::vector<CompSrc>& childSrc) {
    for (std::size_t q = 0; q < p.components.size(); ++q) {
        if (q == comp) {
            for (const auto& [pc, ps] : pieces)
                if (!pc.dead) {
                    child.components.push_back(pc);
                    childSrc.push_back(ps);
                }
        } else if (!p.components[q].dead) {
            child.components.push_back(p.components[q]);
            childSrc.push_back(psrc[q]);
        }
    }
    if (child.components.empty()) {
        Component dead;
        dead.dead = true;
        child.components.push_back(dead);
        childSrc.push_back(CompSrc{});
    }
}

} // namespace

// Shared enclosure surgery. `src` (null in the untracked path) stamps input token provenance;
// the returned pieces carry provenance parallel to their regions.
static std::vector<std::pair<Component, CompSrc>>
applyEnclosureImpl(const Component& c, const Enclosure& m, const CompSrc* src) {
    IComp ic = labeled(c, /*allowPseudo=*/false, src);
    if (m.region >= ic.regions.size())
        throw EncodingError("enclosure region index out of range");
    IRegion& reg = ic.regions[m.region];
    if (m.boundary >= reg.size())
        throw EncodingError("enclosure boundary index out of range");
    const IWalk w = reg[m.boundary];
    const int n = static_cast<int>(w.size());
    int i = m.i;
    int j = m.j;
    if (i > j)
        std::swap(i, j);
    if (i < 0 || j >= n)
        throw EncodingError("enclosure endpoint out of range");
    const std::size_t others = reg.size() - 1;
    if (others >= 32 || m.mask >= (1u << others))
        throw EncodingError("enclosure mask out of range");

    std::set<int> deadLabels;
    IWalk L, R;

    if (i == j) {
        // Self-connection. The two arcs are the endpoint's two sides of the new loop.
        const Item p = w[static_cast<std::size_t>(i)];
        if (p.tok == SPOT) {
            if (n != 1)
                throw EncodingError("spot on a multi-token boundary");
            // Spot and the generated vertex both become membrane pairs: [AB / AB]. The spot
            // survives (its membrane keeps its srcId); the loop's midpoint is generated.
            const int pl = ic.nextLabel++;
            const int g = ic.nextLabel++;
            L = {memb(pl, p.srcId), memb(g, GEN_SRC)};
            R = {memb(pl, p.srcId), memb(g, GEN_SRC)};
        } else if (p.tok == APPE) {
            // The appendage is full (dead); the loop's inside holds only the generated
            // membrane, the outside keeps the walk with gen at the appendage's slot.
            const int g = ic.nextLabel++;
            L = {memb(g, GEN_SRC)};
            R = w;
            R[static_cast<std::size_t>(i)] = memb(g, GEN_SRC);
        } else {
            throw EncodingError("only spots and appendages can self-connect");
        }
    } else {
        const Item p1 = w[static_cast<std::size_t>(i)];
        const Item p2 = w[static_cast<std::size_t>(j)];
        if (p1.jointId >= 0 && p1.jointId == p2.jointId)
            throw EncodingError("cannot connect a joint to its own other side");

        IWalk arc1(w.begin() + i + 1, w.begin() + j);
        IWalk arc2(w.begin() + j + 1, w.end());
        arc2.insert(arc2.end(), w.begin(), w.begin() + i);

        // Endpoint consumption, derived from corner geometry: the cut splits the
        // endpoint's corner between the two new regions. An appendage (deg 1 -> 2)
        // keeps one corner on each side and becomes a membrane pair; scabs, membranes
        // and joint halves reach full degree and die. A consumed membrane also kills
        // its partner occurrence cross-region; a consumed joint half kills the other
        // visit on this walk.
        std::set<int> deadJoints;
        auto consume = [&](const Item& p) -> int {
            switch (p.tok) {
                case SPOT:
                    throw EncodingError("spot on a multi-token boundary");
                case APPE:
                    return ic.nextLabel++;
                case SCAB:
                    return -1;
                case MEMB:
                    deadLabels.insert(p.membLabel);
                    return -1;
                default:  // joint half
                    deadJoints.insert(p.jointId);
                    return -1;
            }
        };
        const int rem1 = consume(p1);
        const int rem2 = consume(p2);
        auto scrub = [&](IWalk& a) {
            std::erase_if(a, [&](const Item& it) {
                return it.jointId >= 0 && deadJoints.count(it.jointId) > 0;
            });
        };
        scrub(arc1);
        scrub(arc2);

        // Transmute: a joint with one visit on each arc now separates the two new
        // regions and becomes a membrane pair.
        std::set<int> inArc1;
        for (const auto& it : arc1)
            if (it.jointId >= 0)
                inArc1.insert(it.jointId);
        std::map<int, int> splitLabel;
        for (auto& it : arc2)
            if (it.jointId >= 0 && inArc1.count(it.jointId) > 0)
                splitLabel.try_emplace(it.jointId, 0);
        for (auto& [id, lbl] : splitLabel)
            lbl = ic.nextLabel++;
        auto transmute = [&](IWalk& a) {
            for (auto& it : a) {
                if (it.jointId >= 0) {
                    const auto found = splitLabel.find(it.jointId);
                    if (found != splitLabel.end())
                        it = memb(found->second, it.srcId);  // joint half survives -> keep srcId
                }
            }
        };
        transmute(arc1);
        transmute(arc2);

        // L: p1's remnant, arc1, p2's remnant, gen; R: p2's remnant, arc2, p1's
        // remnant, gen (consistent walk direction per region).
        const int g = ic.nextLabel++;
        if (rem1 >= 0)
            L.push_back(memb(rem1, p1.srcId));  // appendage endpoint survives -> keep srcId
        L.insert(L.end(), arc1.begin(), arc1.end());
        if (rem2 >= 0)
            L.push_back(memb(rem2, p2.srcId));
        L.push_back(memb(g, GEN_SRC));
        if (rem2 >= 0)
            R.push_back(memb(rem2, p2.srcId));
        R.insert(R.end(), arc2.begin(), arc2.end());
        if (rem1 >= 0)
            R.push_back(memb(rem1, p1.srcId));
        R.push_back(memb(g, GEN_SRC));
    }

    // Distribute the region's other boundaries per the mask; L replaces the old
    // region in place, R is appended (so other regions keep their indices).
    IRegion Lreg, Rreg;
    Rreg.push_back(std::move(R));
    std::uint32_t bit = 0;
    for (std::size_t b2 = 0; b2 < reg.size(); ++b2) {
        if (b2 == m.boundary) {
            Lreg.push_back(std::move(L));
            continue;
        }
        if ((m.mask >> bit) & 1u)
            Rreg.push_back(reg[b2]);
        else
            Lreg.push_back(reg[b2]);
        ++bit;
    }
    ic.regions[m.region] = std::move(Lreg);
    ic.regions.push_back(std::move(Rreg));

    // Consumed membranes take their partner occurrences with them.
    for (auto& reg2 : ic.regions)
        for (auto& w2 : reg2)
            std::erase_if(w2, [&](const Item& it) {
                return it.membLabel >= 0 && deadLabels.count(it.membLabel) > 0;
            });

    return finishComponent(ic);
}

std::vector<Component> applyEnclosure(const Component& c, const Enclosure& m) {
    return stripSrc(applyEnclosureImpl(c, m, nullptr));
}

std::vector<std::pair<Component, CompSrc>>
applyEnclosureTracked(const Component& c, const CompSrc& src, const Enclosure& m) {
    return applyEnclosureImpl(c, m, &src);
}

Position applyEnclosure(const Position& p, std::size_t comp, const Enclosure& m) {
    if (comp >= p.components.size())
        throw EncodingError("component index out of range");
    return spliceChild(p, comp, applyEnclosure(p.components[comp], m));
}

TrackedCanon enclosureChildTracked(const Position& p, const std::vector<CompSrc>& psrc,
                                   std::size_t comp, const Enclosure& m) {
    if (comp >= p.components.size())
        throw EncodingError("component index out of range");
    Position child;
    std::vector<CompSrc> childSrc;
    spliceChildTracked(p, psrc, comp, applyEnclosureTracked(p.components[comp], psrc[comp], m),
                       child, childSrc);
    return canonicalizeDecompressedTracked(child, childSrc);
}

// Whether `w` has no membrane and no joint tokens -- i.e. every token is plain, unpaired content
// (a bare SPOT/SCAB/appendage-as-passive-occupant/compressed pseudo-point). Such a boundary has no
// identity beyond its own content: nothing elsewhere references it (unlike a membrane, whose
// partner occurrence cares which physical boundary it is, or a joint, whose two visits must stay
// matched). Mirrors canon.cpp's isTrivialBnd at the pre-move raw-token level.
bool swapSafeBnd(const Bnd& w) {
    for (Token t : w)
        if (t == MEMB || isJoint(t))
            return false;
    return true;
}

// Mask values to try when distributing a region's "other" boundaries (every boundary except
// `boundary`, in ascending index order -- matching applyEnclosureImpl's bit assignment) between an
// enclosure move's two new regions. Naively every value in [0, 2^others) is a candidate -- but when
// several "other" boundaries are byte-identical AND swap-safe (see swapSafeBnd), which specific
// ones land on which side is unobservable in the result: only the COUNT assigned to each side can
// distinguish it (canonicalize() already treats a region's boundaries as an unordered multiset, so
// two masks differing only by which identical boundary got which bit produce the same canonical
// child). So a run of k identical swap-safe "others" collapses from 2^k sub-assignments to k+1 (one
// representative per count) instead of every subset; the full mask list is the cartesian product of
// that per-run reduction, covering every result up to relabeling the identical group -- exact, not
// an approximation. Non-swap-safe boundaries (and singleton runs) keep both bit values, exactly as
// before. This is what keeps e.g. an isolated-spot position's enclosure enumeration (every spot can
// self-enclose, distributing the OTHER n-1 identical spots) from blowing up as 2^(n-1) per spot.
std::vector<std::uint32_t> enclosureMasks(const std::vector<Bnd>& reg, std::size_t boundary) {
    std::vector<std::size_t> otherBit;  // otherBit[bit] = region boundary index for that bit
    otherBit.reserve(reg.size() > 0 ? reg.size() - 1 : 0);
    for (std::size_t b2 = 0; b2 < reg.size(); ++b2)
        if (b2 != boundary)
            otherBit.push_back(b2);

    // Runs: identical-content swap-safe "others" share a run (their bits are interchangeable);
    // everything else is its own singleton run (both bit values matter).
    std::vector<std::vector<std::size_t>> runs;  // bit indices (into otherBit), per run
    std::map<Bnd, std::size_t> runOf;
    for (std::size_t bit = 0; bit < otherBit.size(); ++bit) {
        const Bnd& w = reg[otherBit[bit]];
        if (!swapSafeBnd(w)) {
            runs.push_back({bit});
            continue;
        }
        const auto [it, inserted] = runOf.try_emplace(w, runs.size());
        if (inserted)
            runs.push_back({});
        runs[it->second].push_back(bit);
    }

    // Cartesian product across runs: a singleton contributes both bit values; a run of size k > 1
    // contributes k+1 choices, one per count, using its first `count` bit-indices as the fixed
    // representative subset (any choice within the run is equivalent).
    std::vector<std::uint32_t> masks{0u};
    for (const auto& run : runs) {
        std::vector<std::uint32_t> choices;
        if (run.size() == 1) {
            choices = {0u, 1u << run[0]};
        } else {
            choices.reserve(run.size() + 1);
            std::uint32_t bits = 0;
            choices.push_back(bits);
            for (std::size_t i = 0; i < run.size(); ++i) {
                bits |= (1u << run[i]);
                choices.push_back(bits);
            }
        }
        std::vector<std::uint32_t> next;
        next.reserve(masks.size() * choices.size());
        for (std::uint32_t m : masks)
            for (std::uint32_t ch : choices)
                next.push_back(m | ch);
        masks = std::move(next);
    }
    return masks;
}

std::vector<Enclosure> enclosureMoves(const Component& c) {
    std::vector<Enclosure> out;
    if (c.dead)
        return out;
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        const std::size_t others = c.regions[r].size() - 1;
        if (others >= 32)
            throw EncodingError("too many boundaries in one region");
        for (std::uint32_t b = 0; b < c.regions[r].size(); ++b) {
            const Bnd& w = c.regions[r][b];
            const int n = static_cast<int>(w.size());
            for (Token t : w)
                if (isPseudo(t))
                    throw EncodingError("decompress pseudo-points before generating moves");
            const std::vector<std::uint32_t> masks = enclosureMasks(c.regions[r], b);
            std::vector<int> jid(w.size(), -1);
            const auto pairs = jointPairs(w);
            for (int k = 0; k < static_cast<int>(pairs.size()); ++k) {
                jid[static_cast<std::size_t>(pairs[k].first)] = k;
                jid[static_cast<std::size_t>(pairs[k].second)] = k;
            }
            for (int i = 0; i < n; ++i) {
                const Token ti = w[static_cast<std::size_t>(i)];
                if ((ti == SPOT && n == 1) || ti == APPE)
                    for (std::uint32_t mask : masks)
                        out.push_back({r, b, i, i, mask});
                if (ti == SPOT)
                    continue;
                for (int j = i + 1; j < n; ++j) {
                    if (w[static_cast<std::size_t>(j)] == SPOT)
                        continue;
                    if (jid[static_cast<std::size_t>(i)] >= 0 &&
                        jid[static_cast<std::size_t>(i)] == jid[static_cast<std::size_t>(j)])
                        continue;
                    for (std::uint32_t mask : masks)
                        out.push_back({r, b, i, j, mask});
                }
            }
        }
    }
    return out;
}

// Every distinct child of `p` reachable by a single enclosure move. A thin wrapper over
// enclosureMoves + applyEnclosure: it runs each generated move, canonicalizes and validates the
// result, and dedups by serialization (first occurrence kept, so the order is deterministic).
// This is the enclosure-only counterpart of childrenAll, which unions all move classes. The live
// solver never calls this -- graph.cpp expands moves directly and the analysis path goes through
// childrenAll -- so it exists mainly to let the tests exercise the enclosure path on its own.
std::vector<Position> enclosureChildren(const Position& p) {
    std::set<std::string> seen;
    std::vector<Position> out;
    for (std::size_t k = 0; k < p.components.size(); ++k) {
        if (p.components[k].dead)
            continue;
        for (const auto& mv : enclosureMoves(p.components[k])) {
            Position child = canonicalize(applyEnclosure(p, k, mv));
            child.validate();
            if (seen.insert(serialize(child)).second)
                out.push_back(std::move(child));
        }
    }
    return out;
}

// Shared join surgery (see applyEnclosureImpl for the src/provenance convention).
static std::vector<std::pair<Component, CompSrc>>
applyJoinImpl(const Component& c, const Join& m, const CompSrc* src) {
    IComp ic = labeled(c, /*allowPseudo=*/false, src);
    if (m.region >= ic.regions.size())
        throw EncodingError("join region index out of range");
    IRegion& reg = ic.regions[m.region];
    if (m.b1 >= reg.size() || m.b2 >= reg.size())
        throw EncodingError("join boundary index out of range");
    if (m.b1 == m.b2)
        throw EncodingError("join requires two distinct boundaries (use enclosure)");
    const IWalk w1 = reg[m.b1];
    const IWalk w2 = reg[m.b2];
    const int n1 = static_cast<int>(w1.size());
    const int n2 = static_cast<int>(w2.size());
    if (m.i < 0 || m.i >= n1 || m.j < 0 || m.j >= n2)
        throw EncodingError("join endpoint out of range");

    const Item p1 = w1[static_cast<std::size_t>(m.i)];
    const Item p2 = w2[static_cast<std::size_t>(m.j)];
    if (p1.tok == SPOT && n1 != 1)
        throw EncodingError("spot on a multi-token boundary");
    if (p2.tok == SPOT && n2 != 1)
        throw EncodingError("spot on a multi-token boundary");

    std::set<int> deadLabels;
    std::set<int> deadJoints;

    // The endpoint gains one edge. Its remaining corners dictate its fate (see the join
    // notes): a spot becomes a single appendage in place; a connected appendage becomes a
    // joint wrapping the rest of its own boundary (a distal -> scab when nothing is left,
    // handled by chop); scabs/membranes/joint-halves reach full degree and vanish. `open`
    // and `close` bracket the endpoint's own boundary remnant.
    auto consume = [&](const Item& p, IWalk& open, IWalk& close) {
        switch (p.tok) {
            case SPOT:
                open = {Item{APPE, -1, -1, p.srcId}};  // spot survives as an appendage
                close = {};
                break;
            case APPE: {
                const int jj = ic.nextJoint++;
                // Appendage survives as a joint wrapping its own remnant; both visits are it.
                open = {Item{JOINTSTART, -1, jj, p.srcId}};
                close = {Item{JOINTSTART, -1, jj, p.srcId}};
                break;
            }
            case SCAB:
                open = {};
                close = {};
                break;
            case MEMB:
                deadLabels.insert(p.membLabel);
                open = {};
                close = {};
                break;
            default:  // joint half: the whole joint (both visits) is consumed
                deadJoints.insert(p.jointId);
                open = {};
                close = {};
                break;
        }
    };

    IWalk e1open, e1close, e2open, e2close;
    consume(p1, e1open, e1close);
    consume(p2, e2open, e2close);

    // b1 is the connector: rotate it to just after p1 (p1 removed), wrap with p1's
    // brackets. The generated joint g wraps this connector.
    IWalk brest1;
    brest1.reserve(static_cast<std::size_t>(n1 - 1));
    for (int k = 1; k < n1; ++k)
        brest1.push_back(w1[static_cast<std::size_t>((m.i + k) % n1)]);

    IWalk connector = e1open;
    connector.insert(connector.end(), brest1.begin(), brest1.end());
    connector.insert(connector.end(), e1close.begin(), e1close.end());

    // b2 is the host: keep its own remnant split around p2 (in place, so a joint of b2
    // wrapping p2 correctly wraps the whole splice).
    IWalk before2(w2.begin(), w2.begin() + m.j);
    IWalk after2(w2.begin() + m.j + 1, w2.end());

    const int gJ = ic.nextJoint++;
    IWalk merged;
    merged.insert(merged.end(), before2.begin(), before2.end());
    merged.insert(merged.end(), e2open.begin(), e2open.end());
    merged.push_back(Item{JOINTSTART, -1, gJ, GEN_SRC});  // g first visit (generated joint)
    merged.insert(merged.end(), connector.begin(), connector.end());
    merged.push_back(Item{JOINTSTART, -1, gJ, GEN_SRC});  // g second visit
    merged.insert(merged.end(), e2close.begin(), e2close.end());
    merged.insert(merged.end(), after2.begin(), after2.end());

    // A consumed joint-half takes its partner visit (which now lives in `merged`) along.
    std::erase_if(merged, [&](const Item& it) {
        return it.jointId >= 0 && deadJoints.count(it.jointId) > 0;
    });

    // Replace b1 and b2 with the fused boundary; other boundaries of the region stay.
    IRegion newReg;
    newReg.push_back(std::move(merged));
    for (int b = 0; b < static_cast<int>(reg.size()); ++b)
        if (b != static_cast<int>(m.b1) && b != static_cast<int>(m.b2))
            newReg.push_back(reg[static_cast<std::size_t>(b)]);
    ic.regions[m.region] = std::move(newReg);

    // Consumed membranes take their partner occurrences (cross-region) with them.
    for (auto& reg2 : ic.regions)
        for (auto& w : reg2)
            std::erase_if(w, [&](const Item& it) {
                return it.membLabel >= 0 && deadLabels.count(it.membLabel) > 0;
            });

    return finishComponent(ic);
}

std::vector<Component> applyJoin(const Component& c, const Join& m) {
    return stripSrc(applyJoinImpl(c, m, nullptr));
}

std::vector<std::pair<Component, CompSrc>>
applyJoinTracked(const Component& c, const CompSrc& src, const Join& m) {
    return applyJoinImpl(c, m, &src);
}

Position applyJoin(const Position& p, std::size_t comp, const Join& m) {
    if (comp >= p.components.size())
        throw EncodingError("component index out of range");
    return spliceChild(p, comp, applyJoin(p.components[comp], m));
}

TrackedCanon joinChildTracked(const Position& p, const std::vector<CompSrc>& psrc,
                              std::size_t comp, const Join& m) {
    if (comp >= p.components.size())
        throw EncodingError("component index out of range");
    Position child;
    std::vector<CompSrc> childSrc;
    spliceChildTracked(p, psrc, comp, applyJoinTracked(p.components[comp], psrc[comp], m), child,
                       childSrc);
    return canonicalizeDecompressedTracked(child, childSrc);
}

std::vector<Join> joinMoves(const Component& c) {
    std::vector<Join> out;
    if (c.dead)
        return out;
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        const auto& reg = c.regions[r];
        for (std::uint32_t b1 = 0; b1 < reg.size(); ++b1) {
            for (Token t : reg[b1])
                if (isPseudo(t))
                    throw EncodingError("decompress pseudo-points before generating moves");
            for (std::uint32_t b2 = b1 + 1; b2 < reg.size(); ++b2) {
                const int n1 = static_cast<int>(reg[b1].size());
                const int n2 = static_cast<int>(reg[b2].size());
                for (int i = 0; i < n1; ++i)
                    for (int j = 0; j < n2; ++j)
                        out.push_back({r, b1, b2, i, j});
            }
        }
    }
    return out;
}

// Every distinct child of `p` reachable by a single join move -- the join-only counterpart of
// enclosureChildren (see there for the full rationale). Same wrap-canonicalize-validate-dedup over
// joinMoves + applyJoin; likewise off the solver's hot path and used chiefly by the tests to check
// the join move class in isolation from childrenAll's union.
std::vector<Position> joinChildren(const Position& p) {
    std::set<std::string> seen;
    std::vector<Position> out;
    for (std::size_t k = 0; k < p.components.size(); ++k) {
        if (p.components[k].dead)
            continue;
        for (const auto& mv : joinMoves(p.components[k])) {
            Position child = canonicalize(applyJoin(p, k, mv));
            child.validate();
            if (seen.insert(serialize(child)).second)
                out.push_back(std::move(child));
        }
    }
    return out;
}

std::vector<Position> interiorPseudoChildren(const Position& p) {
    std::set<std::string> seen;
    std::vector<Position> out;
    for (std::size_t k = 0; k < p.components.size(); ++k) {
        if (p.components[k].dead)
            continue;
        const Component& c = p.components[k];
        for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
            for (std::uint32_t b = 0; b < c.regions[r].size(); ++b) {
                const Bnd& w = c.regions[r][b];
                for (int pos = 0; pos < static_cast<int>(w.size()); ++pos) {
                    if (!isPseudo(w[static_cast<std::size_t>(pos)]))
                        continue;
                    IComp ic = labeled(c, /*allowPseudo=*/true);
                    IWalk& tw = ic.regions[r][b];
                    switch (w[static_cast<std::size_t>(pos)]) {
                        case DISA:
                        case HOLL:  // (3q*)=(q*), (4q*)=(q*): the pseudo-point is removed
                            tw.erase(tw.begin() + pos);
                            break;
                        case SPLIT:  // (5q*)=(2q*)
                            tw[static_cast<std::size_t>(pos)] = Item{SCAB, -1, -1};
                            break;
                        default:  // TRIP: (6q*)=(3q*)
                            tw[static_cast<std::size_t>(pos)] = Item{DISA, -1, -1};
                            break;
                    }
                    Position child = canonicalize(spliceChild(p, k, stripSrc(finishComponent(ic))));
                    child.validate();
                    if (seen.insert(serialize(child)).second)
                        out.push_back(std::move(child));
                }
            }
        }
    }
    return out;
}

// `EdgeTag` carries only the endpoint token types + selfConnect (no structural indices),
// while `MoveTag` carries the full structural indices used to apply the move. The two
// enumerate the exact same child set in the exact same order (interior pseudo, then
// enclosure/join on the decompressed form), so `childrenAllTagged` is just `EdgeTag`s
// re-derived from `childrenAllWithMoveTag`'s indices rather than re-walking the move space.
std::vector<std::pair<Position, EdgeTag>> childrenAllTagged(const Position& p) {
    const Position d = p.decompressed();
    std::vector<std::pair<Position, EdgeTag>> out;
    for (auto& [child, mt] : childrenAllWithMoveTag(p)) {
        EdgeTag tag;
        tag.kind = mt.kind;
        if (mt.kind == MoveKind::InteriorPseudo) {
            // Uniform tag: the pseudo token itself isn't surfaced here (matches prior behavior).
            tag.endpoint1 = 0;
            tag.endpoint2 = 0;
            tag.selfConnect = false;
        } else {
            const Component& c = d.components[mt.component];
            const std::uint32_t b1 = mt.kind == MoveKind::Enclosure ? mt.boundary : mt.b1;
            const std::uint32_t b2 = mt.kind == MoveKind::Enclosure ? mt.boundary : mt.b2;
            tag.endpoint1 = c.regions[mt.region][b1][static_cast<std::size_t>(mt.i)];
            tag.endpoint2 = c.regions[mt.region][b2][static_cast<std::size_t>(mt.j)];
            tag.selfConnect = mt.kind == MoveKind::Enclosure && mt.i == mt.j;
        }
        out.emplace_back(std::move(child), tag);
    }
    return out;
}

std::vector<std::pair<Position, MoveTag>> childrenAllWithMoveTag(const Position& p) {
    std::set<std::string> seen;
    std::vector<std::pair<Position, MoveTag>> out;
    auto add = [&](Position&& raw, const MoveTag& tag) {
        Position child = canonicalize(raw);
        child.validate();
        if (seen.insert(serialize(child)).second)
            out.emplace_back(std::move(child), tag);
    };

    for (std::size_t k = 0; k < p.components.size(); ++k) {
        if (p.components[k].dead)
            continue;
        const Component& c = p.components[k];
        for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
            for (std::uint32_t b = 0; b < c.regions[r].size(); ++b) {
                const Bnd& w = c.regions[r][b];
                for (int pos = 0; pos < static_cast<int>(w.size()); ++pos) {
                    if (!isPseudo(w[static_cast<std::size_t>(pos)]))
                        continue;
                    IComp ic = labeled(c, /*allowPseudo=*/true);
                    IWalk& tw = ic.regions[r][b];
                    switch (w[static_cast<std::size_t>(pos)]) {
                        case DISA:
                        case HOLL:
                            tw.erase(tw.begin() + pos);
                            break;
                        case SPLIT:
                            tw[static_cast<std::size_t>(pos)] = Item{SCAB, -1, -1};
                            break;
                        default:
                            tw[static_cast<std::size_t>(pos)] = Item{DISA, -1, -1};
                            break;
                    }
                    MoveTag tag{MoveKind::InteriorPseudo, k, r, b, 0, 0, 0, pos, 0};
                    add(spliceChild(p, k, stripSrc(finishComponent(ic))), tag);
                }
            }
        }
    }

    const Position d = p.decompressed();
    for (std::size_t k = 0; k < d.components.size(); ++k) {
        if (d.components[k].dead)
            continue;
        const Component& c = d.components[k];
        for (const auto& mv : enclosureMoves(c))
            add(applyEnclosure(d, k, mv),
                MoveTag{MoveKind::Enclosure, k, mv.region, mv.boundary, mv.mask, 0, 0, mv.i, mv.j});
        for (const auto& mv : joinMoves(c))
            add(applyJoin(d, k, mv),
                MoveTag{MoveKind::Join, k, mv.region, 0, 0, mv.b1, mv.b2, mv.i, mv.j});
    }
    return out;
}

std::vector<Position> childrenAll(const Position& p) {
    std::vector<Position> out;
    for (auto& [child, tag] : childrenAllTagged(p)) {
        (void)tag;
        out.push_back(std::move(child));
    }
    return out;
}

} // namespace stalks
