#pragma once
#include "tokens.hpp"
#include <utility>
#include <vector>

namespace stalks {

// Positions of each matched joint pair, in first-visit order: result[k] = {open, close}.
// Throws EncodingError on unbalanced joints.
std::vector<std::pair<int, int>> jointPairs(const Bnd& b);

// Validate joint structure: balanced, prefix-valid, and no joint circularly adjacent to
// its own other half (that configuration is a distal and must be encoded as SCAB).
void validateJoints(const Bnd& b);

// Rotate the closed walk to start at `shift`, re-emitting joints in first-seen Dyck form
// (the equivalent of the old code's shift + adjustSplits).
Bnd rotated(const Bnd& b, int shift);

// The mirror image of the walk (reversed direction), re-emitted in Dyck form.
Bnd mirrored(const Bnd& b);

// Lexicographically least rotation. If outShift is given, receives the smallest shift
// that produces it.
Bnd canonicalRotation(const Bnd& b, int* outShift = nullptr);

// All shifts whose rotation equals the canonical rotation (rotational automorphisms).
std::vector<int> canonicalShifts(const Bnd& b);

// Body-part id per token position (the stacked Dyck path algorithm). Non-joint tokens on
// the same row of the same parenthesis group share an id; JOINTSTART/JOINTEND carry the
// id of the part they open/close. Ids are dense in order of first appearance; the root
// row is part 0.
std::vector<int> bodyParts(const Bnd& b);

// Doubled lives of the whole boundary.
int lives2(const Bnd& b);

} // namespace stalks
