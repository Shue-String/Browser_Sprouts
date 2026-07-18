#pragma once
#include "position.hpp"

#include <string>
#include <vector>

// Advanced Collections / quick-canon. See notes/advanced_collections_plan.md for the full
// design. In short: a toggleable canonicalization that swaps a region-chunk (a single-crit
// "left side") for its collection's canonical representative when the two are known to share a
// nimber for every compatible right side. A swap can flip the Grundy value by one, so the
// result carries a nimber offset a in {0,1} (the oplus-a tag). With the toggle off the exact
// structural canon is untouched.

namespace stalks {

// Result of quick-canonicalizing a position: an oplus-0 canonical representative plus the
// nimber offset. nimber(input) == nimber(rep) ^ offset. offset is always 0 or 1 (Pairing
// Theorem); it accumulates by XOR across a chain of recursive swaps.
struct QuickCanonResult {
    Position rep;
    int offset = 0;
};

// A "left side": the detached chunk left when its k crit membranes are cut, with each crit
// marked as a distinct, ordered port. Canonicalized to a string key for registry lookup; the
// crit ports render as reserved sentinels so they never collide with ordinary membranes. The
// representation is crit-count-generic (k=1 single-crit S1/S2 now; k=2 double-crit S3/S4 is
// additive later -- only the crit-finder and the "crits on different organs" matcher are
// crit-count-specific, see notes/advanced_collections_plan.md).
//
// Membership is decided by the collection registry (S1, S2, ... ; see collections.cpp). Each
// collection names a canonical representative and an offset within its Pairing-Theorem pair
// (S1 -> 0, S2 -> 1; later S3 -> 0, S4 -> 1). Matching a left side to a collection yields the
// rep to swap in and the offset to accumulate.

// Whether Advanced Collections is enabled. Honors the STALKS_COLLECTIONS environment variable
// (any non-empty, non-"0" value enables); an explicit argument overrides where a caller passes
// one. Exact structural canon remains the default.
bool collectionsEnabled();

// Quick-canonicalize a position: run the collections pass to a fixpoint (each swap may expose
// a further reducible crit -- recursive collections), accumulating the offset by XOR. The
// returned rep is a fully canonical (serialize-ready) position in Advanced form (DisaPoints as
// '3'). quickCanon ALWAYS reduces; the STALKS_COLLECTIONS toggle is applied by the caller,
// which selects between quickCanon and the exact canonicalize pipeline (see collectionsEnabled).
QuickCanonResult quickCanon(const Position& p);

// Canonical registry key for a left side authored as an encoding string (e.g. "2a", "0,a",
// "12,a", or the double-crit "0,ba" -- the text between '[' and '/', crit membranes written as
// the ordered markers 'a','b',...). Exposed for tests and for seeding the registry. Throws
// EncodingError on malformed input.
std::string leftSideKey(const std::string& leftSideEncoding);

// Exposed for tests/inspection: the canonical left-side key of every single-crit detachable
// chunk (leaf region) across all components of `p`, in unspecified order. Operates on the
// position as given (no canonicalization). Each key is registry-lookup ready.
std::vector<std::string> detachableLeftSideKeys(const Position& p);

} // namespace stalks
