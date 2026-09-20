#include "alpha_genome.hpp"

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "genome_defs.generated.hpp"
#include "moves.hpp"
#include "registry_audit_common.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <vector>

using namespace stalks;

namespace stalks_tools {

namespace {

std::string setStrBare(const std::set<int>& s) {
    std::string out;
    bool first = true;
    for (int v : s) {
        if (!first) out += ",";
        first = false;
        out += std::to_string(v);
    }
    return out;
}

// Named-genome shorthand table. The DATA (per-family R/D/{L}/{T'}/[T] shape) is single-sourced in
// src/data/genomeDefs.json and reaches this file as genome_defs.generated.hpp -- a mechanical
// transcription, not a hand-typed copy (see that header's own comment). This function ports
// collectAlpha.ts's resolveGenome/buildRegistry ALGORITHM (fold `shift` into every gene via XOR,
// union T-children across the shift range, detect same-genome-different-name collisions) natively
// to C++, so the only thing duplicated across languages is the ~40-line algorithm itself, not the
// ~20-family, ever-growing data table it used to be (that table drifted at least once already --
// see the generated header's own S_10/S_11 note, now impossible to reintroduce since both
// languages compute from the same JSON).
std::string foldedNameOf(const std::string& family, int shift) {
    if (shift == 0) return family;
    return family + "⊕" + std::to_string(shift);
}

struct ResolvedGenome {
    int R;
    int D;
    std::vector<int> L;
    std::vector<int> Tprime;
    std::set<std::string> T;  // child names; std::set keeps them sorted, matching every
                               // downstream use (TS always sorts before using its own T list too)
};

std::vector<int> sortedDedup(std::vector<int> v) {
    std::sort(v.begin(), v.end());
    v.erase(std::unique(v.begin(), v.end()), v.end());
    return v;
}

const std::map<std::string, genome_defs_generated::GenomeDef>& genomeDefsByName() {
    static const std::map<std::string, genome_defs_generated::GenomeDef> kByName = [] {
        std::map<std::string, genome_defs_generated::GenomeDef> m;
        for (const auto& [name, def] : genome_defs_generated::familyDefs()) m.emplace(name, def);
        return m;
    }();
    return kByName;
}

// Fold `shift` into `family`'s own genome_defs entry -- mirrors collectAlpha.ts's resolveGenome
// exactly (see that function's own doc comment for the rule). Memoized for the same reason: the
// full-registry build below resolves the same (family, shift) pair repeatedly.
const ResolvedGenome& resolveGenome(const std::string& family, int shift) {
    static std::map<std::string, ResolvedGenome> cache;
    const std::string cacheKey = foldedNameOf(family, shift);
    const auto cached = cache.find(cacheKey);
    if (cached != cache.end()) return cached->second;

    const auto& defs = genomeDefsByName();
    const auto defIt = defs.find(family);
    if (defIt == defs.end())
        throw std::runtime_error("genome_defs has no entry named \"" + family + "\"");
    const genome_defs_generated::GenomeDef& def = defIt->second;

    ResolvedGenome resolved;
    resolved.R = def.R ^ shift;
    resolved.D = def.D ^ shift;
    std::vector<int> L, Tprime;
    for (int v : def.L) L.push_back(v ^ shift);
    for (int v : def.Tprime) Tprime.push_back(v ^ shift);
    resolved.L = sortedDedup(L);
    resolved.Tprime = sortedDedup(Tprime);
    for (const auto& child : def.T) resolved.T.insert(foldedNameOf(child.name, child.shift ^ shift));
    for (int k = 0; k < shift; k++) resolved.T.insert(foldedNameOf(family, k));

    return cache.emplace(cacheKey, std::move(resolved)).first->second;
}

std::string fourGeneKeyOf(const ResolvedGenome& g) {
    std::string L, Tprime;
    for (size_t i = 0; i < g.L.size(); i++) { if (i) L += ","; L += std::to_string(g.L[i]); }
    for (size_t i = 0; i < g.Tprime.size(); i++) { if (i) Tprime += ","; Tprime += std::to_string(g.Tprime[i]); }
    return "(" + std::to_string(g.R) + "," + std::to_string(g.D) + ",{" + L + "},{" + Tprime + "})";
}

std::string foldedKeyOf(const ResolvedGenome& g) {
    std::string head = fourGeneKeyOf(g);
    head.pop_back();  // drop the trailing ')'
    std::string joined;
    bool first = true;
    for (const auto& t : g.T) {
        if (!first) joined += ",";
        first = false;
        joined += t;
    }
    return head + ",[" + joined + "])";
}

struct NamedGenomeEntry {
    std::string key;
    std::string name;
};

// Registers every family at every shift 0..kMaxShift, base forms before shifted forms (in
// genome_defs.generated.hpp's own declaration order) -- same collision-resolution priority as
// collectAlpha.ts's buildRegistry, and for the same reason: several (family, shift) pairs compute
// to the same (R,D,{L},{T'}) core with different [T] lists, and a genuinely NEW collision (two
// DIFFERENT names computing the identical full genome) should throw, not silently pick one.
//
// Returns entries in REGISTRATION order (not sorted) -- this order is itself load-bearing, not
// just a collision-detection convenience: namedGenomes()'s compact-key fallback (used at
// kMaxFoldDepth, where a T-grandchild is folded on its bare (R,D,{L},{T'}) core alone, no [T]
// available to disambiguate) needs "first family/shift registered in THIS priority order wins the
// bare core" -- exactly mirroring collectAlpha.ts's withCompactKeys, which gets this for free from
// JS's insertion-order-preserving Record. A std::map of these entries would silently reorder by
// KEY STRING instead (verified: this was a real bug here -- since a shifted family's [T] list is
// non-empty and a base family's own can be empty, and ']' sorts AFTER any letter, an empty-T base
// form like S_1 would almost always LOSE its own bare core to an unrelated shifted family sharing
// it, e.g. S_15⊕2, which is exactly backwards from the intended "base beats shifted" priority).
std::vector<NamedGenomeEntry> buildNamedGenomes() {
    std::vector<NamedGenomeEntry> ordered;
    std::map<std::string, std::string> seen;  // key -> name, collision lookups only

    auto registerOne = [&](const std::string& family, int shift) {
        const std::string name = foldedNameOf(family, shift);
        const ResolvedGenome& g = resolveGenome(family, shift);
        const std::string key = foldedKeyOf(g);
        const auto existing = seen.find(key);
        if (existing != seen.end()) {
            if (existing->second != name) {
                throw std::runtime_error(
                    "genome_defs collision: \"" + name + "\" and \"" + existing->second +
                    "\" compute to the identical genome " + key +
                    " -- pick one name and remove the other's own genome_defs entry, keeping it "
                    "only as a T-child reference.");
            }
            return;
        }
        seen.emplace(key, name);
        ordered.push_back({key, name});
    };

    const auto& defs = genome_defs_generated::familyDefs();
    for (const auto& entry : defs) registerOne(entry.first, 0);
    for (const auto& entry : defs) {
        for (int shift = 1; shift <= genome_defs_generated::kMaxShift; shift++) registerOne(entry.first, shift);
    }

    return ordered;
}

const std::map<std::string, std::string>& namedGenomes() {
    static const std::vector<NamedGenomeEntry> kOrdered = buildNamedGenomes();
    static const std::map<std::string, std::string> kWithCompact = [] {
        std::map<std::string, std::string> m;
        for (const auto& e : kOrdered) m[e.key] = e.name;  // exact keys
        for (const auto& e : kOrdered) {
            const auto bracket = e.key.find(",[");
            if (bracket == std::string::npos) continue;
            m.emplace(e.key.substr(0, bracket) + ")", e.name);  // compact form; first in
                                                                  // REGISTRATION order wins
        }
        return m;
    }();
    return kWithCompact;
}

// Advanced-Collection membership data, in the SAME resolution-priority order as collectAlpha.ts's
// NAMED_FAMILIES: every family's own shift-0 form first (in genome_defs.generated.hpp's
// declaration order), then each family's shift 1..kMaxShift forms -- required because
// familyForCoreKey below picks the FIRST match, and several distinct (family, shift) pairs
// collide on their bare (R,D,{L},{T'}) core with different [T] lists (base forms must win those
// collisions). A pair of hardcoded "legacy fold key" entries (S_1's own core with a spurious
// non-empty T-list) used to be appended here too, predating GENOME_DEFS/genome_defs.json and of
// unclear origin; removed 2026-09-20 once confirmed (both empirically and by this same
// first-match-wins compact-key fallback) that any genome sharing S_1's bare core already folds to
// "S_1" regardless of its own T-list, making those two entries provably redundant, not just
// unused -- see collectAlpha.ts's own (now similarly trimmed) GENOME_DEFS doc comment.
struct NamedFamily {
    std::string name;
    std::string coreKey;
    std::vector<std::string> tChildPlains;  // sorted, matches collectAlpha.ts's [...g.T].sort()
};

const std::vector<NamedFamily>& namedFamilies() {
    static const std::vector<NamedFamily> kFamilies = [] {
        std::vector<NamedFamily> families;

        auto pushFamily = [&](const std::string& familyName, int shift) {
            const ResolvedGenome& g = resolveGenome(familyName, shift);
            families.push_back({foldedNameOf(familyName, shift), fourGeneKeyOf(g),
                                 std::vector<std::string>(g.T.begin(), g.T.end())});
        };
        const auto& defs = genome_defs_generated::familyDefs();
        for (const auto& entry : defs) pushFamily(entry.first, 0);
        for (const auto& entry : defs) {
            for (int shift = 1; shift <= genome_defs_generated::kMaxShift; shift++)
                pushFamily(entry.first, shift);
        }
        return families;
    }();
    return kFamilies;
}

const NamedFamily* familyForCoreKey(const std::string& coreKey) {
    for (const auto& f : namedFamilies())
        if (f.coreKey == coreKey) return &f;
    return nullptr;
}

// EVERY family whose bare core equals coreKey, not just the first (priority-order) match --
// several distinct (family, shift) pairs legitimately share the same bare (R,D,{L},{T'}) core and
// differ only in their required T-gene list (see namedFamilies()'s own doc comment: S_1/S_15,
// S_6/S_8/S_17/S_20, S_7/S_10, S_12/S_25, S_14/S_26, S_21/S_24, at every shift). familyForCoreKey's
// first-match-wins is correct for DISPLAY purposes (folding a genome to its one canonical name), but
// a discovery scan that only ever tests a core-matching candidate against the single highest-priority
// name can NEVER find a new member of any lower-priority sibling in a collision group -- confirmed
// empirically 2026-09-03: a real scan found core-matching candidates for 47 families, zero went
// yellow anywhere except the two collision-immune bypass-only families (S_1/S_1⊕1, whose empty
// tChildPlains means core alone is a complete definition, no collision possible), and several
// documented collision-losers (S_10/S_16/S_17/S_18/S_20/S_24/S_25/S_26) never appeared in the
// checked list AT ALL -- every one of their candidates was silently being tested against a
// higher-priority sibling instead and rejected there.
//
// DEDUPED BY NAME (fixed 2026-09-16, against a since-removed source of duplicates -- the two
// "legacy fold key" NamedFamily entries that used to be appended here, both literally named "S_1"
// with coreKey "(0,1,{0},{})"; see namedFamilies()'s own doc comment): a caller iterating this
// vector's raw entries got "S_1" back once per such duplicate (3 times, for S_1) even though
// isYellowCandidate(candidate, db, "S_1") always re-resolves the name via familyForName (first
// match wins) and so gives the SAME verdict every time -- a real bug found via
// find_yellow_candidates.exe's output: 1,119 distinct S_1 candidates were each written 3x (3,357 rows
// for 1,119 real hits) in a from-scratch registry-rebuild scan, caught because the raw output looked
// suspiciously tripled, not because any wrong verdict was produced. Kept as a defensive general rule
// (not re-derived from the now-removed cause): two different NamedFamily objects with the same name
// are, as far as every caller of this function is concerned, indistinguishable (isYellowCandidate
// only ever takes the name, never the specific object), so they should never be reported as two
// "different" families to test.
std::vector<const NamedFamily*> allFamiliesForCoreKey(const std::string& coreKey) {
    std::vector<const NamedFamily*> out;
    std::set<std::string> seenNames;
    for (const auto& f : namedFamilies()) {
        if (f.coreKey != coreKey) continue;
        if (!seenNames.insert(f.name).second) continue;
        out.push_back(&f);
    }
    return out;
}

const NamedFamily* familyForName(const std::string& name) {
    for (const auto& f : namedFamilies())
        if (f.name == name) return &f;
    return nullptr;
}

bool tChildPlainsContain(const NamedFamily& family, const std::string& plain) {
    return std::find(family.tChildPlains.begin(), family.tChildPlains.end(), plain) != family.tChildPlains.end();
}

// A genome's name via the bypass-only fallback rule -- mirrors collect.ts's bypassOnlyFoldName
// exactly (see that function's own doc comment): a family whose OWN tChildPlains is empty (S_1/S_2
// today) asserts no T-gene requirement at all, so core match alone is its complete definition, no
// matter what real T-list a particular member happens to have. Not the old, broader "any extra
// T-child excused by any named genome" Advanced-Collection fallback (removed from collect.ts
// 2026-08-30 as unsound) -- this never excuses anything via an unrelated genome, it only fires when
// the family itself has nothing to require.
std::string bypassOnlyFoldName(const std::string& coreKey) {
    const NamedFamily* family = familyForCoreKey(coreKey);
    return family && family->tChildPlains.empty() ? family->name : std::string();
}

// Every registered element's own reduction target + offset, keyed by the reduced position's own
// serialized form -- lets genome-naming (foldToName/foldToNameChecked below) recognize a T-child as
// a member of ANY registered Advanced Collection (currently up to S_221), not just the 32 families
// hand-authored in src/data/genomeDefs.json (see [[project_genome_naming_registry_fix]]). Built from
// EVERY ELEMENT of EVERY roster entry (not from CollectionRoster's own .rep/.offset fields): a
// paired-sibling group's .rep is deliberately left empty (allCollectionRosters()'s own doc comment --
// "shares its pair-partner's rep instead of having its own"), and reconstructing which physical rep
// an empty-rep group's elements reduce to from the flattened roster list alone isn't reliable (a
// multi-region family's paired sibling can be pushed at a completely unrelated point in iteration
// order -- see allCollectionRosters()'s own S_8⊕1 comment). Running quickCanon on the group's OWN
// elements sidesteps this entirely: each element is, by registration, exactly a left side quickCanon
// reduces to that group's target at that group's own offset, so quickCanon's return value gives both
// facts directly with no bookkeeping needed. Collection names already carry their own "⊕1" suffix
// directly in the roster (see the 2026-08-29 rename noted in collections.cpp), so the name found here
// needs no further foldedNameOf()-style wrapping.
//
// Double-crit (k=2) elements are skipped for the same reason buildRepCanonSet skips double-crit
// reps (see that function's own doc comment): a genuine T-child position carries exactly one live
// special point (alpha), so a two-port left side can never structurally match it. Multi-region (k=1,
// one port spread across >=2 regions) elements ARE included -- they carry exactly one port too.
const std::map<std::string, std::map<int, std::string>>& registryNameIndex() {
    static const std::map<std::string, std::map<int, std::string>> kIndex = [] {
        std::map<std::string, std::map<int, std::string>> out;
        for (const CollectionRoster& r : allCollectionRosters()) {
            for (const std::string& elem : r.elements) {
                if (distinctPortLetters(elem) != 1) continue;
                Position parsed;
                QuickCanonResult qc;
                std::string err;
                if (!tryQuickCanonElement(elem, parsed, qc, err)) continue;
                std::map<int, std::string>& byOffset = out[serialize(qc.rep)];
                const auto existing = byOffset.find(qc.offset);
                if (existing == byOffset.end()) {
                    byOffset.emplace(qc.offset, r.name);
                } else if (existing->second != r.name) {
                    std::cerr << "warning: registryNameIndex collision at offset " << qc.offset
                              << ": \"" << existing->second << "\" vs \"" << r.name
                              << "\" (element \"" << elem << "\")\n";
                }
            }
        }
        return out;
    }();
    return kIndex;
}

// Does `p` itself (as a whole position, at whatever depth genomeTextAt is currently folding) reduce,
// via quickCanon, to a registered collection's own target? Returns that collection's name (already
// carrying its own offset suffix if non-zero, see registryNameIndex's own doc comment) or empty if
// no match. Unlike namedGenomes()'s exact full-tuple-TEXT match, this works directly off `p`'s own
// STRUCTURE via the same quickCanon() engine the Collect pane's Advanced Collections toggle itself
// uses, so it never needs a hand-authored genomeDefs.json entry to recognize a family. Purely
// structural (quickCanon needs neither `db` nor `target`), and unconditional regardless of the
// STALKS_COLLECTIONS toggle -- exactly like namedGenomes() itself, this is a display-fold concern,
// independent of whether quick-canon structural swapping is active for the position's own identity.
std::string registryFoldName(const Position& p) {
    const QuickCanonResult qc = quickCanon(p);
    const auto& index = registryNameIndex();
    const auto byRep = index.find(serialize(qc.rep));
    if (byRep == index.end()) return std::string();
    const auto byOffset = byRep->second.find(qc.offset);
    return byOffset != byRep->second.end() ? byOffset->second : std::string();
}

// Exact-fold match first (namedGenomes(), the finite hand-authored/derived set of full "(R,D,{L},
// {T'},[T])" strings); failing that, the registry-based structural match above; failing that, the
// bypass-only core fallback below -- a finite string table can never enumerate every real T-list a
// bypass-only family's members can have, which is exactly what broke on [1212a/ (core (0,1,{0},{}),
// matching S_1) before that fix. Tries namedGenomes() FIRST (not the registry) so a genomeDefs.json
// entry's hand-verified text always wins over a same-shape registry match -- see
// [[project_genome_naming_registry_fix]]'s own note on this ordering choice.
std::string foldToName(const std::string& plainText, const Position& p) {
    const auto it = namedGenomes().find(plainText);
    if (it != namedGenomes().end()) return it->second;
    const std::string registryName = registryFoldName(p);
    if (!registryName.empty()) return registryName;
    const auto bracket = plainText.find(",[");
    const std::string coreKey = bracket != std::string::npos ? plainText.substr(0, bracket) + ")" : plainText;
    const std::string fallback = bypassOnlyFoldName(coreKey);
    return fallback.empty() ? plainText : fallback;
}

// Forward-declared: genomeTextAt is defined further down (it's the function that calls
// foldToNameChecked below), but bypassOnlyFoldNameChecked needs to call it too (to fold a
// grandchild for the bypass check) -- no hoisting in C++, so a prototype is required here.
std::string genomeTextAt(const Position& p, const SpecDB& db, int depth, Token target);

// `bypassOnlyFoldName`, but ALSO verifying that every one of `p`'s own T-children is accounted for
// -- a bypass back to this same family, since a bypass-only family has nothing to require. Mirrors
// collectAlpha.ts's `bypassOnlyFoldNameChecked` (see that function's own doc comment for the full
// rationale: root-caused 2026-09-16 via `[1,12,2a/` folding to "S_1" despite its own T-child
// `[12,27a8/` having no bypass back to S_1 -- the swap REGISTRY, collections.cpp/isYellowCandidate,
// already rejected this position correctly; only this DISPLAY-fold path was still using the looser,
// core-only rule).
//
// Deliberately does NOT reuse `isYellowCandidate` directly: that function (and
// `resolvedGenomeName`, which it calls) is hardcoded to ALPHA, while `genomeTextAt`/`foldToName`
// here are genuinely generic over `target` (double_crit_genome.cpp calls this same pipeline with a
// different crit token) -- reusing the ALPHA-only helper would silently check the WRONG token's
// T-children whenever `target != ALPHA`. This re-derives the identical per-child rule
// (isYellowCandidate's own `hasBypass` loop, with `family.tChildPlains` empty so
// `satisfiesRequired` is always false) using the already-`target`-parametrized `tChildrenOf`/
// `genomeTextAt` this file already has, so the two implementations can't drift on WHAT the rule is,
// only (necessarily) on being target-generic where isYellowCandidate is ALPHA-only by design.
std::string bypassOnlyFoldNameChecked(const Position& p, const SpecDB& db, Token target,
                                       const std::string& coreKey) {
    const NamedFamily* family = familyForCoreKey(coreKey);
    if (!family || !family->tChildPlains.empty()) return std::string();
    for (const Position& t : tChildrenOf(p, target)) {
        bool hasBypass = false;
        for (const Position& gc : tChildrenOf(t, target)) {
            if (genomeTextAt(gc, db, 0, target) == family->name) {
                hasBypass = true;
                break;
            }
        }
        if (!hasBypass) return std::string();
    }
    return family->name;
}

std::string foldToNameChecked(const std::string& plainText, const Position& p, const SpecDB& db,
                               Token target) {
    const auto it = namedGenomes().find(plainText);
    if (it != namedGenomes().end()) return it->second;
    const std::string registryName = registryFoldName(p);
    if (!registryName.empty()) return registryName;
    const auto bracket = plainText.find(",[");
    const std::string coreKey = bracket != std::string::npos ? plainText.substr(0, bracket) + ")" : plainText;
    const std::string fallback = bypassOnlyFoldNameChecked(p, db, target, coreKey);
    return fallback.empty() ? plainText : fallback;
}

// depth 0 = the position itself, 1 = its T-children (full, with their own [T]), 2 = T-of-T
// (truncated to the bare 4-gene tuple, no further [T]) -- matches collectAlpha.ts's
// MAX_GENOME_DEPTH; none of the named genomes above need deeper nesting to be recognized.
constexpr int kMaxFoldDepth = 2;

// classifyAlphaGenome/tChildrenOf/genomeTextAt are pure functions of (p, target[, depth]):
// classifyAlphaGenome's own doc comment guarantees any valid `db` "containing p" gives the same
// answer (every move's child is necessarily already in it), and tChildrenOf doesn't touch `db` at
// all (childrenAllWithMoveTag is purely structural) -- so genomeTextAt built from them is pure too.
// All three get called repeatedly on the SAME position: once directly, once again one level up
// inside a T-child's own genomeTextAt recursion (see isYellowCandidate: it calls tChildrenOf(t)
// directly, but resolvedGenomeName(t,db) just above it already walked
// genomeTextAt(t,db,0,target) -> tChildrenOf(t,target), an identical call on the same t) -- and
// across many different top-level candidates sharing overlapping move-graph substructure (siblings/
// cousins in the same corpus), which is the dominant cost of a discovery scan over a large .spec
// file. Memoized globally, keyed only by (target[, depth], serialize(p)) -- safe across different
// `db` instances/files per the precondition above, so callers never need to clear this.
std::string cacheKey(const Position& p, Token target) {
    return std::string(1, tokenChar(target)) + "|" + serialize(p);
}
std::map<std::string, std::vector<Position>> gTChildrenCache;
std::map<std::string, std::optional<AlphaGenome>> gClassifyCache;
std::map<std::string, std::string> gGenomeTextCache;

std::string genomeTextAt(const Position& p, const SpecDB& db, int depth, Token target) {
    const std::string key = std::to_string(depth) + "|" + cacheKey(p, target);
    const auto cached = gGenomeTextCache.find(key);
    if (cached != gGenomeTextCache.end()) return cached->second;

    const auto g = classifyAlphaGenome(p, db, target);
    if (!g) return gGenomeTextCache.emplace(key, "(unclassified)").first->second;
    const std::string head =
        "(" + std::to_string(g->R) + "," + std::to_string(g->D) + ",{" + setStrBare(g->L) + "},{" +
        setStrBare(g->Tprime) + "}";

    if (depth >= kMaxFoldDepth) return gGenomeTextCache.emplace(key, foldToName(head + ")", p)).first->second;

    std::set<std::string> tTexts;  // dedup + lexicographic sort, same convention as collect.ts
    for (const Position& child : tChildrenOf(p, target))
        tTexts.insert(genomeTextAt(child, db, depth + 1, target));

    std::string joined;
    bool first = true;
    for (const auto& t : tTexts) {
        if (!first) joined += ",";
        first = false;
        joined += t;
    }
    return gGenomeTextCache.emplace(key, foldToNameChecked(head + ",[" + joined + "])", p, db, target))
        .first->second;
}

}  // namespace

std::vector<Position> tChildrenOf(const Position& p, Token target) {
    const std::string key = cacheKey(p, target);
    const auto cached = gTChildrenCache.find(key);
    if (cached != gTChildrenCache.end()) return cached->second;

    const Position d = p.decompressed();
    std::vector<Position> out;
    for (const auto& [child, tag] : childrenAllWithMoveTag(p)) {
        const EdgeTag et = edgeTagFromMoveTag(d, tag);
        const auto sparse = specialPointMovetypes(p, et, child);
        int movetype = -1;
        for (const auto& [tok, mt] : sparse) {
            if (tok == target) { movetype = mt; break; }
        }
        if (movetype == 5) out.push_back(canonicalize(child));
    }
    return gTChildrenCache.emplace(key, std::move(out)).first->second;
}

std::optional<AlphaGenome> classifyAlphaGenome(const Position& p, const SpecDB& db, Token target) {
    const std::string key = cacheKey(p, target);
    const auto cached = gClassifyCache.find(key);
    if (cached != gClassifyCache.end()) return cached->second;

    const Position d = p.decompressed();
    AlphaGenome g;
    std::optional<int> R, D;
    bool warned = false;

    for (const auto& [child, tag] : childrenAllWithMoveTag(p)) {
        const EdgeTag et = edgeTagFromMoveTag(d, tag);
        const auto sparse = specialPointMovetypes(p, et, child);
        int movetype = -1;
        for (const auto& [tok, mt] : sparse) {
            if (tok == target) { movetype = mt; break; }
        }
        if (movetype <= 0) continue;  // alpha not classified on this edge -- shouldn't happen

        SpecValue val;
        if (!db.value(child, val)) {
            if (!warned) {
                std::cerr << "  warning: child of " << serialize(p)
                          << " not found in graph, skipping edge(s)\n";
                warned = true;
            }
            continue;
        }

        switch (movetype) {
            case 1:
                if (R.has_value() && *R != val.nimber)
                    std::cerr << "  warning: multiple distinct R values for " << serialize(p) << "\n";
                R = val.nimber;
                break;
            case 2:
                if (D.has_value() && *D != val.nimber)
                    std::cerr << "  warning: multiple distinct D values for " << serialize(p) << "\n";
                D = val.nimber;
                break;
            case 3:
                g.L.insert(val.nimber);
                break;
            case 4:
                g.Tprime.insert(val.nimber);
                break;
            default:
                break;  // case 5 (T) is not part of the genome; callers needing it re-enumerate
        }
    }

    if (!R.has_value() || !D.has_value()) return gClassifyCache.emplace(key, std::nullopt).first->second;
    g.R = *R;
    g.D = *D;
    return gClassifyCache.emplace(key, std::move(g)).first->second;
}

std::string genomeKey(const AlphaGenome& g) {
    return "(" + std::to_string(g.R) + "," + std::to_string(g.D) + ",{" + setStrBare(g.L) + "},{" +
           setStrBare(g.Tprime) + "})";
}

std::string fullGenomeText(const Position& p, const SpecDB& db, Token target) {
    return genomeTextAt(p, db, 0, target);
}

bool isNamedGenome(const Position& p, const SpecDB& db) {
    const std::string folded = fullGenomeText(p, db);
    return !folded.empty() && folded[0] != '(';
}

std::optional<std::string> resolvedGenomeName(const Position& p, const SpecDB& db) {
    const std::string folded = fullGenomeText(p, db);
    if (!folded.empty() && folded[0] != '(') return folded;
    return std::nullopt;
}

std::optional<std::string> familyNameForCoreKey(const std::string& coreKey) {
    const NamedFamily* family = familyForCoreKey(coreKey);
    return family ? std::optional<std::string>(family->name) : std::nullopt;
}

std::vector<std::string> allFamilyNamesForCoreKey(const std::string& coreKey) {
    std::vector<std::string> out;
    for (const NamedFamily* f : allFamiliesForCoreKey(coreKey)) out.push_back(f->name);
    return out;
}

bool isYellowCandidate(const Position& candidate, const SpecDB& db, const std::string& searchedFamilyName) {
    const NamedFamily* family = familyForName(searchedFamilyName);
    if (!family) throw std::runtime_error("isYellowCandidate: no NAMED_FAMILIES entry named \"" + searchedFamilyName + "\"");

    bool noExtras = true;
    std::set<std::string> presentNames;
    for (const Position& t : tChildrenOf(candidate)) {
        const std::optional<std::string> resolvedName = resolvedGenomeName(t, db);

        bool hasBypass = false;
        for (const Position& gc : tChildrenOf(t)) {
            if (fullGenomeText(gc, db) == searchedFamilyName) { hasBypass = true; break; }
        }

        const bool satisfiesRequired = resolvedName.has_value() && tChildPlainsContain(*family, *resolvedName);
        const bool isExtra = !satisfiesRequired && !hasBypass;
        if (isExtra) noExtras = false;
        if (resolvedName) presentNames.insert(*resolvedName);
    }

    for (const std::string& want : family->tChildPlains) {
        if (presentNames.find(want) == presentNames.end()) return false;
    }
    return noExtras;
}

std::string alphaGreekToAscii(const std::string& s) {
    std::string out;
    for (std::size_t i = 0; i < s.size(); ) {
        if (i + 1 < s.size() && static_cast<unsigned char>(s[i]) == 0xCE && static_cast<unsigned char>(s[i + 1]) == 0xB1) {
            out.push_back('a');
            i += 2;
        } else {
            out.push_back(s[i]);
            ++i;
        }
    }
    return out;
}

std::string toEmbeddable(const std::string& raw) {
    std::string out;
    for (char ch : alphaGreekToAscii(raw)) {
        if (ch == '[' || ch == ']' || ch == '/' || ch == ' ' || ch == '\t') continue;
        out.push_back(ch);
    }
    return out;
}

bool isSingleAlpha(const std::string& enc) {
    int count = 0;
    bool sawAlpha = false;
    for (char ch : enc) {
        if (ch >= 'a' && ch <= 'j') {
            ++count;
            if (ch == 'a') sawAlpha = true;
        }
    }
    return count == 1 && sawAlpha;
}

int distinctPortLetters(const std::string& s) {
    std::set<char> letters;
    for (char ch : s)
        if (ch >= 'a' && ch <= 'z') letters.insert(ch);
    return static_cast<int>(letters.size());
}

std::set<std::string> buildRepCanonSet() {
    std::set<std::string> out;
    for (const CollectionRoster& r : allCollectionRosters()) {
        if (r.rep.empty()) continue;
        if (distinctPortLetters(r.rep) != 1) continue;
        const QuickCanonResult qc = quickCanon(parsePosition("[" + r.rep + "]"));
        out.insert(serialize(qc.rep));
    }
    return out;
}

}  // namespace stalks_tools
