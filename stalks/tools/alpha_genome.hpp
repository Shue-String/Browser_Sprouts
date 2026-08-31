#pragma once
// Shared genome classification for a single-alpha position, factored out of
// collect_alpha_genetics.cpp so tools/unregistered_left_sides.cpp can report the same genome
// without re-deriving the movetype-classification loop.
#include "position.hpp"
#include "specfile.hpp"

#include <optional>
#include <set>
#include <string>

namespace stalks_tools {

// The (R, D, {L}, {T'}) genome of a single-alpha position, per the engine's own movetype
// classification (moves.hpp's specialPointMovetypes; movetype 1->R, 2->D, 3->L, 4->T', 5->T --
// see collect_alpha_genetics.cpp's top-of-file doc comment for the full mapping). T itself is not
// part of the genome bucket key and is not computed here.
struct AlphaGenome {
    int R = 0;
    int D = 0;
    std::set<int> L;
    std::set<int> Tprime;
};

// Classifies `p` (a canonicalized single-alpha position) using `db` to resolve each move's child
// value. `db` must be a SpecDB that solved a supergraph containing `p` -- every move's child is
// then necessarily already in it (see collect_alpha_genetics.cpp's own doc comment on this).
// Returns nullopt if R or D was never classified (movetype 1/2 not found on any edge) -- shouldn't
// happen for a genuine single-alpha position reachable in `db`. Prints a warning to stderr (at
// most once per call) if some child is missing from `db`.
std::optional<AlphaGenome> classifyAlphaGenome(const stalks::Position& p, const stalks::SpecDB& db);

// "(R,D,{L},{T'})" -- the human-facing genome-bucket key text.
std::string genomeKey(const AlphaGenome& g);

// The FULL "(R,D,{L},{T'},[T])" genome text, T-children folded to their shorthand name when
// recognized (see the named-genome table in alpha_genome.cpp, derived from the same
// src/data/genomeDefs.json that src/model/collectAlpha.ts's GENOME_DEFS reads) -- mirrors collect.ts's
// genomeParts/foldToName convention: a T-child recurses one level with its OWN full [T] computed,
// and bottoms out at a bare 4-gene tuple two levels down (matching collectAlpha.ts's
// MAX_GENOME_DEPTH), since none of the currently-named genomes need deeper nesting to be
// recognized. T-children are deduped and sorted by their own plain text, same as collect.ts.
//
// Unlike collectAlpha.ts's TS pipeline, this classifies directly on `p`'s own real (structural)
// child positions via SpecDB::value() -- which already folds any sum/split child's components
// together -- rather than computing genomes on a quick-canon representative with an explicit
// "oplus" split tag. For the tiny left sides this is meant to audit, that distinction is not
// expected to matter in practice; a mismatch against the live Collect pane's own genome text would
// only be possible for a T-child that itself happens to be a disconnected sum.
std::string fullGenomeText(const stalks::Position& p, const stalks::SpecDB& db);

// True iff `p`'s own full recursive fold (fullGenomeText at depth 0) is itself a name, not a bare
// "(...)" tuple -- i.e. `p` IS a named genome outright, not just containing one as a T-child.
// Mirrors collect.ts's isNamedGenome (checked "as if Quick-Genome were on", which fullGenomeText
// always is -- see foldToName's own use in genomeTextAt).
bool isNamedGenome(const stalks::Position& p, const stalks::SpecDB& db);

// `p`'s own display name: its exact fold (isNamedGenome) if it has one -- every T-child accounted
// for, recursively -- else nullopt. Mirrors collect.ts's resolvedGenomeName exactly (synchronous
// here -- no fire-once-and-settle needed, since this always has a live SpecDB to resolve against
// immediately). The old Advanced-Collection fallback (matching on bare core + "every extra T-child
// is itself in SOME Advanced Collection", via the now-removed isInAdvancedCollection) let unrelated
// named genomes excuse an extra T-child regardless of relevance to the family actually being
// searched -- exactly the gap that let a false positive (Aa|6,2A, claimed S_2⊕3) through undetected
// in 2026-08-30's earlier session. Removed to match collect.ts's own fix -- this is now purely the
// exact-fold check, no engine-side fallback at all.
std::optional<std::string> resolvedGenomeName(const stalks::Position& p, const stalks::SpecDB& db);

// True iff `candidate` "goes yellow" when searched for the named family `searchedFamilyName` (e.g.
// "S_1", "S_1⊕1") -- mirrors collect.ts's renderRequiredLine/computeRowInfos exactly: every one of
// the family's own lowest-order T-children (family.tChildPlains) must appear among `candidate`'s own
// top-level T-children (by resolvedGenomeName), AND every top-level T-child must be accounted for --
// either itself satisfying that requirement, or carrying a direct one-level "bypass" (one of ITS OWN
// T-children, i.e. a grandchild of `candidate`, whose exact fold equals `searchedFamilyName` itself,
// not any AC-recursion -- see collect.ts's findBypassMatches). Throws if `searchedFamilyName` isn't
// a NAMED_FAMILIES entry.
bool isYellowCandidate(const stalks::Position& candidate, const stalks::SpecDB& db,
                        const std::string& searchedFamilyName);

// The NAMED_FAMILIES entry (by name) whose bare (R,D,{L},{T'}) core equals `coreKey` exactly (e.g.
// `genomeKey(*classifyAlphaGenome(p, db))`), or nullopt if no family has that core. Same
// first-match-wins resolution order as the rest of this file's NAMED_FAMILIES lookups (legacy fold
// keys, then each family's shift-0 form, then shift 1..kMaxShift) -- exposed so callers outside this file
// (e.g. tools/find_yellow_candidates.cpp) can discover which family a position's own core belongs to
// without re-deriving the NAMED_FAMILIES table.
std::optional<std::string> familyNameForCoreKey(const std::string& coreKey);

// Exactly one special-point character present in `enc`, and it's specifically alpha ('a') -- see
// tokens.hpp's tokenChar/charToken convention (special points are the only lowercase letters this
// format's decoded text ever contains; membranes use uppercase A-V). Shared by collect_alpha_genetics,
// find_yellow_candidates, and unregistered_left_sides -- all three scan the same single-alpha
// population.
bool isSingleAlpha(const std::string& enc);

// Distinct lowercase crit-port letters ('a'-'z') appearing in a roster's authored left-side text.
int distinctPortLetters(const std::string& s);

// The canonical serialized form of every single-crit family's own rep, built by substituting the
// rep's one crit port with the real ALPHA token and running it through quickCanon -- i.e. exactly
// the form a genuine member of that family reduces to under quickCanon. Double-crit reps are
// skipped (distinctPortLetters != 1): they require two distinct crit ports, which no single-alpha
// position (exactly one special-point token) can ever supply, so they can never match here.
//
// MUST be quickCanon, not plain canonicalize(): canonicalize() unconditionally DEcompresses any
// DisaPoint/Hollow/Split/Triplet token already present in its input before recompressing
// structural-only (see collections.cpp's own doc comment on this), so a rep that is ITSELF written
// with a compressed token -- "3a" (C_3), "4a" (C_4), "34a" (S_9) -- would canonicalize() back to
// its decompressed multi-region expansion instead of staying "3a"/"4a"/"34a". quickCanon's own
// final step DOES recompress (applyDisaPoints), and a position already in rep form is a fixpoint
// for it (verified: quickCanon("[3a]") == "3a"), so this matches what qc.rep actually equals for a
// genuine member. Shared by find_yellow_candidates and unregistered_left_sides (both need the same
// "is this left side already registered" rep-set membership check).
std::set<std::string> buildRepCanonSet();

}  // namespace stalks_tools
