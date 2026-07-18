#pragma once
#include "boundary.hpp"

#include <compare>
#include <cstdint>
#include <utility>
#include <vector>

namespace stalks {

// --- Provenance (M1: live vertex <-> encoding-token correspondence) --------------------------
//
// A CompSrc is parallel to Component::regions: src[r][b][k] tags the k-th token of boundary b of
// region r with the caller's id for the live vertex that token descends from. The frontend uses
// live VertexIds; two sentinels have fixed meaning:
//   GEN_SRC (-2): a token the move GENERATED (the new midpoint vertex) -- no parent vertex.
//   -1          : untracked / unknown (the default when provenance isn't being maintained).
// Provenance rides every transformation (rotation, reversal, region/boundary reorder, chop,
// decay, transmute, endpoint consumption, canonical relabel) but is invisible to every
// canonical-value/key/emit path, so a tracked result's token form is byte-identical to the
// untracked one.
using CompSrc = std::vector<std::vector<std::vector<int>>>;
constexpr int GEN_SRC = -2;

// One membrane occurrence: the occ-th MEMB token of regions[region][boundary].
struct MRef {
    std::uint32_t region;
    std::uint32_t boundary;
    std::uint32_t occ;
    auto operator<=>(const MRef&) const = default;
};

// One subposition group (the pieces separated by ⊕ in an encoding; not necessarily a
// minimal subposition).
struct Component {
    std::vector<std::vector<Bnd>> regions;
    // Each paired membrane occurrence appears in exactly one entry. Unpaired MEMB tokens
    // are permitted (membrane-agnostic encodings) and serialize as '9'.
    std::vector<std::pair<MRef, MRef>> pairings;
    bool dead = false;  // the φ subposition (no living points)

    int lives2() const;

    // pairIndex()[r][b][occ] = index into pairings for that membrane occurrence, or -1
    // if unpaired. Throws EncodingError on inconsistent pairings.
    std::vector<std::vector<std::vector<int>>> pairIndex() const;

    // Structural checks beyond parsing: joint validity per boundary, pairing sanity
    // (in-range, no reuse, no region linking to itself), and the body-part reachability
    // rule (two distinct membrane-connected body parts may never share a region).
    // Throws EncodingError.
    void validate() const;

    // Expand every compressed pseudo-point (3/4/5/6) into membranes plus interior
    // regions. DisaPoints decompress as (29). Interior regions are appended after the
    // existing regions, in encounter order.
    Component decompressed() const;
};

struct Position {
    std::vector<Component> components;

    int lives2() const;
    void validate() const;
    Position decompressed() const;
};

} // namespace stalks
