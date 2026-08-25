#include "alpha_genome.hpp"

#include "canon.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "tokens.hpp"

#include <iostream>
#include <map>
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

// Named-genome shorthand table, hand-mirrored from src/model/collectAlpha.ts's
// NAMED_GENOME_DEFS + GENOME_NAMES (withCompactKeys) -- update both places together if a new
// family is registered there. Matches collectAlpha.ts's "S_1⊕1" naming convention exactly (no
// space around ⊕ -- see that file's own doc comment on why the spacing must match precisely).
const std::map<std::string, std::string>& namedGenomes() {
    static const std::map<std::string, std::string> kFull = {
        {"(0,1,{0},{},[])", "S_1"},
        {"(1,0,{1},{},[S_1])", "S_1⊕1"},
        {"(1,1,{0},{0},[])", "C_3"},
        {"(1,2,{1},{0},[S_1])", "C_4"},
        {"(0,1,{0,2},{},[C_4,S_1⊕1])", "S_5"},
        {"(0,2,{0},{},[C_3,S_1⊕1])", "S_6"},
        {"(0,3,{0,2},{},[C_3,S_1⊕1])", "S_7"},
        {"(0,3,{0},{},[C_3,C_4,S_1⊕1])", "S_8"},
        {"(0,3,{0,2},{},[C_3,C_4,S_1⊕1])", "S_9"},
    };
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
