#pragma once
#include "position.hpp"

namespace stalks {

// General pseudo-point recompression (cleanup pipeline step 4). Detects DisaPoint /
// Hollow / Split / Triplet organs anywhere in a component (organ analysis, not the old
// own-component-only special cases) and rewrites them to the compressed tokens 3/4/5/6.
// This is the inverse of Component::decompressed on canonical organ shapes, and it also
// recognizes the isomorphic alternative interior shapes (e.g. the DisaPoint interior may
// be one boundary "2A" or two boundaries "2","A"; both compress to 3). Ambiguous choices
// (which region hosts the pseudo-point) are resolved to the canonical, lower-valued form
// ([29|2,9] -> [23], never [2,3]). Fully paired input; pseudo-points already present ride
// along. Iterates to a fixpoint.
// `disapoints` false leaves DisaPoints decompressed: they are the only pseudo-point whose
// compression is lossy (it identifies graph-distinct positions -- a Collections-layer
// operation), whereas Hollow/Split/Triplet are bijective re-encodings. Base/structural
// canonization compresses only the latter, both for correctness and because it is exactly
// those organs' decompressed all-membrane regions that blow up the canonicalizer.
Component recompress(const Component& c, bool disapoints = true);
Position recompress(const Position& p, bool disapoints = true);

// Full canonization per canonAlgo. Recompresses, splits into minimal subpositions,
// canonicalizes each, and orders them. With slackOff = true the per-subposition
// canonicalization stops after the deterministic labeling phase (canonAlgo step 9):
// a consistent, reproducible encoding that is not proven to be the lexicographic minimum
// (the residue brute force of steps 10-12 is skipped). slackOff = false runs the full
// algorithm and returns the true canonical form.
// Base/structural canonical form: compresses Hollow/Split/Triplet only (DisaPoints stay
// decompressed). This is the canonical form of the game graph -- distinct positions stay
// distinct -- and it is fast because the exploded all-membrane organ regions are gone.
Position canonicalize(const Position& p, bool slackOff = false);

// The paper's canonAlgo canonical form: also compresses DisaPoints. This identifies
// DisaPoint-equivalent (graph-distinct) positions, so it is a count-reducing, Collections-
// layer canonical form -- not the base game graph. Reproduces the canonAlgo worked example.
Position canonicalizeFull(const Position& p, bool slackOff = false);

// As canonicalize, but the canonical form is the fully decompressed (base) graph rather
// than the recompressed encoding: pseudo-points are expanded and their organs canonicalized
// as ordinary regions. Two positions that share a decompressed graph (but differ only in how
// pseudo-points are encoded) map to the same form. This is the "full-encoding" view used for
// regression against the historical position counts.
Position canonicalizeDecompressed(const Position& p, bool slackOff = false);

// Decompressed canonical form (as canonicalizeDecompressed) with provenance carried through.
// `src[i]` is a CompSrc parallel to p.components[i].regions tagging each token with the caller's
// vertex id (GEN_SRC for a generated token; -1 untracked). The result pairs the canonical Position
// with per-component CompSrc parallel to it, so a caller can trace each canonical token back to the
// parent vertex it descends from. Input must be decompressed (no pseudo-points). The token form of
// `pos` is byte-identical to canonicalizeDecompressed(p) -- srcId never affects the canonical value.
struct TrackedCanon {
    Position pos;
    std::vector<CompSrc> src;  // parallel to pos.components; src[i] parallel to pos.components[i]
};
TrackedCanon canonicalizeDecompressedTracked(const Position& p, const std::vector<CompSrc>& src);

// Reference (slow) decompressed canonicalization with no agnostic pruning: every rotation,
// every region/boundary ordering, and both chiralities are enumerated and the numerically
// least labeling chosen. Used only to verify canonicalizeDecompressed.
Position canonicalizeBrute(const Position& p);

} // namespace stalks
