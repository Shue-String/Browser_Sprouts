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

// `p`'s own display name for Advanced-Collection purposes: its exact fold (isNamedGenome) if it has
// one, else the matching NAMED_FAMILIES entry's name if `p` qualifies via isInAdvancedCollection
// below, else nullopt. Mirrors collect.ts's resolvedGenomeName (synchronous here -- no fire-once-
// and-settle needed, since this always has a live SpecDB to resolve against immediately).
std::optional<std::string> resolvedGenomeName(const stalks::Position& p, const stalks::SpecDB& db);

// Is `p` (a single-alpha position) either itself a named genome, or a bigger position that still
// qualifies for the SAME family per the Advanced-Collection rule: its own (R,D,{L},{T'}) core
// matches a named family's exactly; its own T-children are a superset of that family's lowest-order
// T-children (by resolved/folded name); and every OTHER (extra) T-child itself qualifies
// recursively. Mirrors collect.ts's isInAdvancedCollection exactly (see that function's own doc
// comment for the full rule and termination argument). Memoized internally by `p`'s own
// serialization, shared across calls within one process.
bool isInAdvancedCollection(const stalks::Position& p, const stalks::SpecDB& db);

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
// first-match-wins resolution order as resolvedGenomeName/isInAdvancedCollection (legacy fold keys,
// then each family's shift-0 form, then shift 1..kMaxShift) -- exposed so callers outside this file
// (e.g. tools/find_yellow_candidates.cpp) can discover which family a position's own core belongs to
// without re-deriving the NAMED_FAMILIES table.
std::optional<std::string> familyNameForCoreKey(const std::string& coreKey);

}  // namespace stalks_tools
