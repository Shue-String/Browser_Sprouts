#include "alpha_genome.hpp"

#include "canon.hpp"
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

// Registers every family at every shift 0..kMaxShift, base forms before shifted forms (in
// genome_defs.generated.hpp's own declaration order) -- same collision-resolution priority as
// collectAlpha.ts's buildRegistry, and for the same reason: several (family, shift) pairs compute
// to the same (R,D,{L},{T'}) core with different [T] lists, and a genuinely NEW collision (two
// DIFFERENT names computing the identical full genome) should throw, not silently pick one.
std::map<std::string, std::string> buildNamedGenomes() {
    std::map<std::string, std::string> named;

    auto registerOne = [&](const std::string& family, int shift) {
        const std::string name = foldedNameOf(family, shift);
        const ResolvedGenome& g = resolveGenome(family, shift);
        const std::string key = foldedKeyOf(g);
        const auto existing = named.find(key);
        if (existing != named.end() && existing->second != name) {
            throw std::runtime_error(
                "genome_defs collision: \"" + name + "\" and \"" + existing->second +
                "\" compute to the identical genome " + key +
                " -- pick one name and remove the other's own genome_defs entry, keeping it "
                "only as a T-child reference.");
        }
        named[key] = name;
    };

    const auto& defs = genome_defs_generated::familyDefs();
    for (const auto& entry : defs) registerOne(entry.first, 0);
    for (const auto& entry : defs) {
        for (int shift = 1; shift <= genome_defs_generated::kMaxShift; shift++) registerOne(entry.first, shift);
    }
    for (const auto& legacy : genome_defs_generated::legacyFoldKeys()) named[legacy.key] = legacy.name;

    return named;
}

const std::map<std::string, std::string>& namedGenomes() {
    static const std::map<std::string, std::string> kFull = buildNamedGenomes();
    static const std::map<std::string, std::string> kWithCompact = [] {
        std::map<std::string, std::string> m = kFull;
        for (const auto& [key, name] : kFull) {
            const auto bracket = key.find(",[");
            if (bracket == std::string::npos) continue;
            m.emplace(key.substr(0, bracket) + ")", name);  // compact form; never overwrites
        }
        return m;
    }();
    return kWithCompact;
}

std::string foldToName(const std::string& plainText) {
    const auto it = namedGenomes().find(plainText);
    return it != namedGenomes().end() ? it->second : plainText;
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

}  // namespace stalks_tools
