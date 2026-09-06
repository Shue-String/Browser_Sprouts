#pragma once
#include "position.hpp"

#include <map>
#include <set>
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

// A "left side": the detached chunk left when its k crits are cut, with each crit marked as a
// distinct, ordered port. A crit is either a real membrane paired to a host elsewhere, or a
// special-point token (ALPHA, ...; see tokens.hpp) -- a special point already stands for
// "connects to somewhere outside this position," so it plays the identical structural role with
// no host to repoint. Canonicalized to a string key for registry lookup; the crit ports render
// as reserved sentinels so they never collide with ordinary content. The representation is
// crit-count-generic (k=1 single-crit S1/S2, k=2 double-crit S3/S4; the "crits on different
// organs" multi-region matcher is still deferred, see notes/advanced_collections_plan.md).
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

// Instrumentation: tallies how many times quickCanon's fixpoint loop actually APPLIED each
// distinct reduction (not merely considered it -- only the lexicographically-least candidate
// each round is applied, see quickCanon's tier-1 loop). Keyed by the reduced left side's own
// bracket/slash text, e.g. "[1a/" (S_2's own element, folds to S_1/S_2's shared rep "[2a/") or
// "[0,a/" (also S_2, a different element sharing the same rep); the crit-cell/scab-cell boundary-
// merge congruity (e.g. "[a,b/" -> "[ab/", and the k=3 variants "[a,bc/"/"[a,b,c/") is tracked the
// same way, keyed by its own (registry-free) canonical left-side text. Global and cumulative
// across calls -- callers doing a fresh count (e.g. one CSV per n) must resetQuickReductionCounts()
// first.
void resetQuickReductionCounts();
const std::map<std::string, long long>& quickReductionCounts();

// Canonical registry key for a left side authored as an encoding string (e.g. "2a", "0,a",
// "12,a", or the double-crit "0,ba" -- the text between '[' and '/', crit membranes written as
// the ordered markers 'a','b',...). Exposed for tests and for seeding the registry. Throws
// EncodingError on malformed input.
std::string leftSideKey(const std::string& leftSideEncoding);

// Exposed for tests/inspection: the canonical left-side key of every single-crit detachable
// chunk (leaf region) across all components of `p`, in unspecified order. Operates on the
// position as given (no canonicalization). Each key is registry-lookup ready.
std::vector<std::string> detachableLeftSideKeys(const Position& p);

// As detachableLeftSideKeys, but for double-crit candidate regions (enumerateDoubleCrits: a region
// with exactly two membrane occurrences, both paired outward with distinct pairings -- see that
// function's own doc comment in collections.cpp). Exposed for the same reason: an offline audit
// tool needs to find candidate double-crit region shapes across real positions without pulling in
// collections.cpp's internals (Component, enumerateDoubleCrits itself) directly.
std::vector<std::string> detachableDoubleCritLeftSideKeys(const Position& p);

// As detachableLeftSideKeys, but for multi-region candidate chunks (enumerateMultiCrits: >=2
// regions joined by their own internal real membranes, detachable by cutting exactly one crit --
// see that function's own doc comment in collections.cpp). Exposed for the same reason as
// detachableDoubleCritLeftSideKeys: lets an offline discovery tool enumerate multi-region
// candidates straight from the real structural game tree, without a pre-built single-alpha .spec
// corpus -- the single-region-only detachableLeftSideKeys above misses this whole shape class.
std::vector<std::string> detachableMultiCritLeftSideKeys(const Position& p);

// Exposed for tests/inspection: every leftSideKey currently registered as a double-crit Advanced
// Collection member (doubleCritRegistry()'s own key set) -- lets an offline audit tool check
// candidate membership (from detachableDoubleCritLeftSideKeys) without depending on collections.cpp's
// internal CritMatch type.
std::set<std::string> registeredDoubleCritKeys();

// One authored Advanced-Collection roster, exposed for UI/tooling sync -- see
// tools/dump_collections_roster.cpp, which writes this out for the Collect pane's Collections
// panel (src/data/collectionsRoster.json) so a change here is reflected there automatically,
// with no hand-copied duplicate list to drift out of sync.
struct CollectionRoster {
    std::string name;                  // e.g. "S_1", "S_2", "S_3", "S_4" -- extend as more are registered
    int offset = 0;                    // 0 or 1 (Pairing Theorem)
    std::vector<std::string> elements; // authored left-side encodings, exactly as written in the registry (pre-canonicalization), e.g. "2,a"
    std::string rep;                   // this collection's own shared reduction target (same left-side encoding convention, e.g. "2a"); empty when it shares its pair-partner's rep instead of having its own (S_1's offset-1 sibling shares S_1's; S_4 shares S_3's)
};

// Every currently-registered Advanced Collection, in the SAME authored (pre-canonicalization)
// form used to build the internal matching registries in collections.cpp -- single source of
// truth, so this can never drift from what quickCanon() actually matches.
std::vector<CollectionRoster> allCollectionRosters();

} // namespace stalks
