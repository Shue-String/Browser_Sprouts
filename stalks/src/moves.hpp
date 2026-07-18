#pragma once
#include "canon.hpp"  // TrackedCanon (Position-level tracked move result)
#include "position.hpp"

#include <cstddef>
#include <vector>

namespace stalks {

// CompSrc / GEN_SRC (provenance carrier) live in position.hpp, next to Component.

// How a child edge was reached (per the paper's movetype language, sans crit context).
enum class MoveKind { Enclosure, Join, InteriorPseudo };

// An enclosure: both endpoints on one boundary of one region (i == j: self-connection,
// legal for spots and appendages only). `mask` distributes the region's other
// boundaries: bit k set => the k-th other boundary (in index order, skipping
// `boundary`) goes with the arc2 side (the new region appended at the end); clear =>
// it stays with the arc1 side (which replaces the old region in place).
struct Enclosure {
    std::uint32_t region = 0;
    std::uint32_t boundary = 0;
    int i = 0;
    int j = 0;
    std::uint32_t mask = 0;
};

// Tracked enclosure: as applyEnclosure(const Component&, const Enclosure&), but every input
// token is tagged by `src` (parallel to c.regions) and each returned component is paired with its
// own CompSrc (parallel to that component's regions). Surviving vertices keep their tag; the
// generated vertex's tokens carry GEN_SRC. The token forms are byte-identical to the untracked
// overload -- provenance never affects the result. Throws EncodingError on invalid moves.
std::vector<std::pair<Component, CompSrc>>
applyEnclosureTracked(const Component& c, const CompSrc& src, const Enclosure& m);

// Apply one enclosure to a fully paired, decompressed component. The result is cleaned
// up (dead tokens removed, joints chopped, decay and isolation applied, split into
// pairing-connected components) and normalized per the slacked pre-canon rules
// (canonical boundary rotation, boundaries sorted within regions, region mirror if
// lesser, regions sorted). If everything died, the single returned component is dead
// (phi). Throws EncodingError on invalid moves.
std::vector<Component> applyEnclosure(const Component& c, const Enclosure& m);

// Apply one enclosure to component `comp` of `p`. Other components are carried over;
// dead pieces are dropped unless the whole child is dead (then a single phi remains).
Position applyEnclosure(const Position& p, std::size_t comp, const Enclosure& m);

// Tracked whole-position enclosure: apply to component `comp`, carry every other component's
// provenance through unchanged, and return the DECOMPRESSED CANONICAL child paired with
// per-component provenance. `psrc[i]` is parallel to p.components[i].regions; input must be
// decompressed (no pseudo-points). This is the C++ core the WASM applyMoveTracked (M2) wraps.
TrackedCanon enclosureChildTracked(const Position& p, const std::vector<CompSrc>& psrc,
                                   std::size_t comp, const Enclosure& m);

// Enumerate the valid enclosures of one component (all masks included). Requires a
// decompressed component.
std::vector<Enclosure> enclosureMoves(const Component& c);

// All children of `p` reachable by one enclosure move, deduped by serialization.
// Every child is validated. Deterministic order (component, region, boundary, i, j,
// mask; first occurrence kept). Single-move-class helper (cf. childrenAll, which unions
// every class); off the solver's hot path, used mainly by the tests. See moves.cpp.
std::vector<Position> enclosureChildren(const Position& p);

// A join (old "merge"): the two endpoints lie on two *different* boundaries `b1`, `b2`
// of one region. Endpoint `i` is on `b1`, endpoint `j` on `b2`. The two boundaries fuse
// into one; the generated vertex becomes a joint pair wrapping `b1`'s connector, spliced
// into `b2` at `p2`. The region is not split (unlike an enclosure), so there is no mask.
struct Join {
    std::uint32_t region = 0;
    std::uint32_t b1 = 0;
    std::uint32_t b2 = 0;
    int i = 0;
    int j = 0;
};

// Apply one join to a fully paired, decompressed component; result cleaned up and
// normalized exactly as applyEnclosure. Throws EncodingError on invalid moves.
std::vector<Component> applyJoin(const Component& c, const Join& m);

// Tracked join: the join-move counterpart of applyEnclosureTracked (see there).
std::vector<std::pair<Component, CompSrc>>
applyJoinTracked(const Component& c, const CompSrc& src, const Join& m);

// Apply one join to component `comp` of `p`; other components carried over.
Position applyJoin(const Position& p, std::size_t comp, const Join& m);

// Tracked whole-position join: the join counterpart of enclosureChildTracked (see there).
TrackedCanon joinChildTracked(const Position& p, const std::vector<CompSrc>& psrc,
                              std::size_t comp, const Join& m);

// Enumerate the valid joins of one component (every endpoint pair across every ordered
// pair of distinct boundaries in a region). Requires a decompressed component.
std::vector<Join> joinMoves(const Component& c);

// All children of `p` reachable by one join move, deduped by serialization. Join-only
// counterpart of enclosureChildren; likewise a test-oriented single-class helper. See moves.cpp.
std::vector<Position> joinChildren(const Position& p);

// Identity of a graph-build move, for callers (GameGraph, analysis JSON) that need to report
// which move reached a child edge rather than just the child itself. `component` is the index
// into the decompressed Position's components that the move was applied to. Enclosure fields
// (boundary, mask) are unused/zero for a Join move, and vice versa (b1, b2).
struct MoveTag {
    MoveKind kind = MoveKind::Enclosure;
    std::size_t component = 0;
    std::uint32_t region = 0;
    std::uint32_t boundary = 0;  // enclosure only
    std::uint32_t mask = 0;      // enclosure only
    std::uint32_t b1 = 0;        // join only
    std::uint32_t b2 = 0;        // join only
    int i = 0;
    int j = 0;
};

// All children reachable by an interior move on a compressed pseudo-point (paper
// rewrites: (3q*)=(q*), (4q*)=(q*), (5q*)=(2q*), (6q*)=(3q*)). Operates on the
// compressed form directly; no decompression. Deduped and validated.
std::vector<Position> interiorPseudoChildren(const Position& p);

struct EdgeTag {
    MoveKind kind = MoveKind::Enclosure;
    // Endpoint token types before consumption (endpoint2 == MEMB-sentinel unused for
    // interior moves; endpoint1 holds the pseudo token there).
    Token endpoint1 = 0;
    Token endpoint2 = 0;
    bool selfConnect = false;  // enclosure endpoint-to-self
};

// Every distinct child of `p` by any move class (interior pseudo on the compressed form,
// then enclosure and join on the decompressed form), deduped by serialization.
std::vector<Position> childrenAll(const Position& p);

// As childrenAll, but each child is paired with the tag of the first move that reached
// it (dedup keeps the first occurrence, move-class order: interior, enclosure, join).
std::vector<std::pair<Position, EdgeTag>> childrenAllTagged(const Position& p);

// As childrenAllTagged, but paired with the full MoveTag (region/boundary/b1/b2/i/j/mask)
// instead of the coarser EdgeTag, so a caller can reconstruct which move to draw/play, not
// just which move class reached the edge. Interior-pseudo moves carry a MoveTag with only
// `component`/`region`/`boundary`/`i` populated (the pseudo token's position); they have no
// two-endpoint identity to draw.
std::vector<std::pair<Position, MoveTag>> childrenAllWithMoveTag(const Position& p);

} // namespace stalks
