#include "alpha_genome.hpp"

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "genome_defs.generated.hpp"
#include "moves.hpp"
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

// The movetype-5 ("T", untouched-alpha) children of `p`, canonicalized -- the same children
// classifyAlphaGenome's own loop would see, re-enumerated here since case 5 isn't part of that
// function's own (R,D,{L},{T'}) result.
std::vector<Position> tChildrenOf(const Position& p) {
    const Position d = p.decompressed();
    std::vector<Position> out;
    for (const auto& [child, tag] : childrenAllWithMoveTag(p)) {
        const EdgeTag et = edgeTagFromMoveTag(d, tag);
        const auto sparse = specialPointMovetypes(p, et, child);
        int movetype = -1;
        for (const auto& [tok, mt] : sparse) {
            if (tok == ALPHA) { movetype = mt; break; }
        }
        if (movetype == 5) out.push_back(canonicalize(child));
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
    // Legacy keys are appended last and win their own exact key unconditionally (mirrors the old
    // `named[legacy.key] = legacy.name` unconditional overwrite -- the final assignment into `m`
    // below, done in this same order, reproduces that).
    for (const auto& legacy : genome_defs_generated::legacyFoldKeys())
        ordered.push_back({legacy.key, legacy.name});

    return ordered;
}

const std::map<std::string, std::string>& namedGenomes() {
    static const std::vector<NamedGenomeEntry> kOrdered = buildNamedGenomes();
    static const std::map<std::string, std::string> kWithCompact = [] {
        std::map<std::string, std::string> m;
        for (const auto& e : kOrdered) m[e.key] = e.name;  // exact keys; legacy overwrites last
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
// NAMED_FAMILIES (post-2026-08-31 fix): every family's own shift-0 form first (in genome_defs.
// generated.hpp's declaration order), then each family's shift 1..kMaxShift forms, THEN the legacy
// fold keys last -- required because familyForCoreKey below picks the FIRST match, and several
// distinct (family, shift) pairs collide on their bare (R,D,{L},{T'}) core with different [T]
// lists (base forms must win those collisions). Legacy entries used to be pushed FIRST (mirroring
// collectAlpha.ts's own now-fixed `unshift`), which silently shadowed the real S_1 entry (whose
// tChildPlains is genuinely empty -- S_1/S_2 are the Pairing Theorem's base pair, bypass-only, no
// T-gene requirement at all) with a legacy one claiming "S_1⊕1" is required. That's what made
// isYellowCandidate below say "no" for a genuine S_1 element like [1212a/ whose own T-list doesn't
// happen to be one of the two legacy forms -- same root cause as the bug fixed in collect.ts/
// collectAlpha.ts this session, just independently reimplemented here in C++ and independently
// broken. Legacy coreKey is hardcoded to S_1's own bare core, exactly mirroring collectAlpha.ts's
// own hardcoded '(0,1,{0},{})' (both legacy entries are S_1 fold targets -- see genome_defs.
// generated.hpp's legacyFoldKeys doc comment).
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
        for (const auto& legacy : genome_defs_generated::legacyFoldKeys())
            families.push_back({legacy.name, "(0,1,{0},{})", legacy.tChildPlains});
        return families;
    }();
    return kFamilies;
}

const NamedFamily* familyForCoreKey(const std::string& coreKey) {
    for (const auto& f : namedFamilies())
        if (f.coreKey == coreKey) return &f;
    return nullptr;
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

// Exact-fold match first (namedGenomes(), the finite hand-authored/derived set of full "(R,D,{L},
// {T'},[T])" strings); failing that, the bypass-only core fallback above -- a finite string table
// can never enumerate every real T-list a bypass-only family's members can have, which is exactly
// what broke on [1212a/ (core (0,1,{0},{}), matching S_1) before this fix.
std::string foldToName(const std::string& plainText) {
    const auto it = namedGenomes().find(plainText);
    if (it != namedGenomes().end()) return it->second;
    const auto bracket = plainText.find(",[");
    const std::string coreKey = bracket != std::string::npos ? plainText.substr(0, bracket) + ")" : plainText;
    const std::string fallback = bypassOnlyFoldName(coreKey);
    return fallback.empty() ? plainText : fallback;
}

// depth 0 = the position itself, 1 = its T-children (full, with their own [T]), 2 = T-of-T
// (truncated to the bare 4-gene tuple, no further [T]) -- matches collectAlpha.ts's
// MAX_GENOME_DEPTH; none of the named genomes above need deeper nesting to be recognized.
constexpr int kMaxFoldDepth = 2;

std::string genomeTextAt(const Position& p, const SpecDB& db, int depth) {
    const auto g = classifyAlphaGenome(p, db);
    if (!g) return "(unclassified)";
    const std::string head =
        "(" + std::to_string(g->R) + "," + std::to_string(g->D) + ",{" + setStrBare(g->L) + "},{" +
        setStrBare(g->Tprime) + "}";

    if (depth >= kMaxFoldDepth) return foldToName(head + ")");

    std::set<std::string> tTexts;  // dedup + lexicographic sort, same convention as collect.ts
    for (const Position& child : tChildrenOf(p))
        tTexts.insert(genomeTextAt(child, db, depth + 1));

    std::string joined;
    bool first = true;
    for (const auto& t : tTexts) {
        if (!first) joined += ",";
        first = false;
        joined += t;
    }
    return foldToName(head + ",[" + joined + "])");
}

}  // namespace

std::optional<AlphaGenome> classifyAlphaGenome(const Position& p, const SpecDB& db) {
    const Position d = p.decompressed();
    AlphaGenome g;
    std::optional<int> R, D;
    bool warned = false;

    for (const auto& [child, tag] : childrenAllWithMoveTag(p)) {
        const EdgeTag et = edgeTagFromMoveTag(d, tag);
        const auto sparse = specialPointMovetypes(p, et, child);
        int movetype = -1;
        for (const auto& [tok, mt] : sparse) {
            if (tok == ALPHA) { movetype = mt; break; }
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

    if (!R.has_value() || !D.has_value()) return std::nullopt;
    g.R = *R;
    g.D = *D;
    return g;
}

std::string genomeKey(const AlphaGenome& g) {
    return "(" + std::to_string(g.R) + "," + std::to_string(g.D) + ",{" + setStrBare(g.L) + "},{" +
           setStrBare(g.Tprime) + "})";
}

std::string fullGenomeText(const Position& p, const SpecDB& db) {
    return genomeTextAt(p, db, 0);
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
