// Offline tool: read a list of already-canonical positions (one decompressed encoding per line --
// the Exact-mode structural canonical form, as produced by dump_low_life_quick's
// canonicalizeDecompressed() step from a life-filtered quick-canon scan) and, for every DisaPoint
// in each, compute its genetic code (L, R, D nimber set/values). Groups every DisaPoint by its
// exact genome (a string key "({l1,l2,...},R,D)", L sorted ascending and deduped) and writes one
// JSON object mapping genome -> array of {enc, dp, lives, allBypass} entries (sorted ascending by
// `lives` within each genome bucket), where `enc` is the position's decompressed canonical encoding
// (the same text collect.ts's analyze().canon produces), `dp` is the 0-based index of the matching
// DisaPoint within findDisaPoints(enc)'s deterministic order, `lives` is the WHOLE position's life
// count (Position::lives2()/2 -- shared by every DisaPoint of that enc; the parent position's
// nimber itself isn't meaningful for collection purposes, unlike its life count), and `allBypass`
// is true iff this DisaPoint has at least one T move and every one of them satisfies the
// Grandparent Bypass Theorem (see computeAllBypass below -- the same condition that puts a '?' next
// to a position in the T section of collect.ts's detail chart, just aggregated: ALL of them, not
// any one).
//
// The life filter itself is NOT applied here -- the input list is already filtered (by
// Position::lives2(), not the old ad-hoc token-counting "life" heuristic) before this tool ever
// sees it. This tool trusts its input list completely and just computes genomes for every
// DisaPoint of every position in it.
//
// T/T' move LISTINGS (the actual position-by-position chart rows) are intentionally NOT computed
// here -- collect.ts computes those lazily, on demand, the moment a genome-loaded entry is actually
// opened (see collect.ts's fillDetail) -- so this scan only needs to cover every DisaPoint of every
// input position, not every position's full move tree. The Grandparent Bypass Theorem's aggregate
// (allBypass) is the one exception: it's cheap enough per-DisaPoint to precompute here, and doing so
// lets the left-hand variation list show its '?' immediately instead of only after a lazy fetch.
//
// This operates purely on the text form of the decompressed canonical encoding (the same
// '2'+letter "detached pair" convention collectGenetics.ts's parseEncoding/findDisaPoints use),
// converting to/from stalks::Position only at the engine boundary (nimber lookup) -- see
// collectGenetics.ts's header comment for why this convention exists.
//
// Usage: collect_genetics <out.json> <positions.txt> <exactSave1.sprout> [exactSave2.sprout ...]

#include "canon.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "savefile.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

using namespace stalks;

namespace {

// ---- string-level parsed structure, mirroring collectGenetics.ts's ParsedComponent ----------

using ParsedBoundary = std::string;
using ParsedRegion = std::vector<ParsedBoundary>;
using ParsedComponent = std::vector<ParsedRegion>;
using ParsedPosition = std::vector<ParsedComponent>;

std::vector<std::string> splitOn(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::string cur;
    for (char ch : s) {
        if (ch == sep) {
            out.push_back(cur);
            cur.clear();
        } else {
            cur += ch;
        }
    }
    out.push_back(cur);
    return out;
}

ParsedPosition parseText(const std::string& text) {
    ParsedPosition out;
    for (const std::string& compStr : splitOn(text, '+')) {
        ParsedComponent comp;
        for (const std::string& regionStr : splitOn(compStr, '|')) {
            ParsedRegion region;
            for (const std::string& b : splitOn(regionStr, ',')) region.push_back(b);
            comp.push_back(region);
        }
        out.push_back(comp);
    }
    return out;
}

std::string serializeParsed(const ParsedPosition& p) {
    std::string out;
    for (std::size_t c = 0; c < p.size(); ++c) {
        if (c) out += '+';
        for (std::size_t r = 0; r < p[c].size(); ++r) {
            if (r) out += '|';
            for (std::size_t b = 0; b < p[c][r].size(); ++b) {
                if (b) out += ',';
                out += p[c][r][b];
            }
        }
    }
    return out;
}

struct DisaRef {
    std::size_t component;
    std::size_t region;
    std::size_t boundary;
    std::size_t token;
    char letter;
    std::size_t detRegion;  // the detached "2<letter>" region, same component
};

// Mirrors collectGenetics.ts's findDisaPoints exactly, including the "mutual pairing" guard
// (two lone detached-pair regions paired only to each other form a trivial isolated dumbbell,
// not a DisaPoint) which the original TS never needed to handle explicitly because it always
// operated on the LAST-write-wins Map -- ported here as an explicit exclusion for correctness.
std::vector<DisaRef> findDisaPoints(const ParsedPosition& p) {
    std::map<std::pair<std::size_t, char>, std::size_t> detachedByLetter;
    for (std::size_t c = 0; c < p.size(); ++c) {
        for (std::size_t r = 0; r < p[c].size(); ++r) {
            const auto& region = p[c][r];
            if (region.size() == 1 && region[0].size() == 2) {
                char a = region[0][0], b = region[0][1];
                char letter = 0;
                if (a == '2' && std::isupper(static_cast<unsigned char>(b))) letter = b;
                else if (b == '2' && std::isupper(static_cast<unsigned char>(a))) letter = a;
                if (letter) detachedByLetter[{c, letter}] = r;
            }
        }
    }

    std::vector<DisaRef> refs;
    for (std::size_t c = 0; c < p.size(); ++c) {
        for (std::size_t r = 0; r < p[c].size(); ++r) {
            for (std::size_t b = 0; b < p[c][r].size(); ++b) {
                const auto& bd = p[c][r][b];
                for (std::size_t t = 0; t < bd.size(); ++t) {
                    char letter = bd[t];
                    if (!std::isupper(static_cast<unsigned char>(letter))) continue;
                    auto it = detachedByLetter.find({c, letter});
                    if (it == detachedByLetter.end()) continue;
                    std::size_t detRegion = it->second;
                    if (detRegion == r) continue;  // the detached region's own token
                    refs.push_back({c, r, b, t, letter, detRegion});
                }
            }
        }
    }
    return refs;
}

void pruneEmpty(ParsedPosition& p) {
    for (auto& comp : p) {
        for (auto& region : comp) {
            region.erase(std::remove_if(region.begin(), region.end(),
                                         [](const std::string& s) { return s.empty(); }),
                         region.end());
        }
        comp.erase(std::remove_if(comp.begin(), comp.end(),
                                   [](const ParsedRegion& r) { return r.empty(); }),
                   comp.end());
    }
    p.erase(std::remove_if(p.begin(), p.end(), [](const ParsedComponent& c) { return c.empty(); }),
            p.end());
}

std::string buildReplaceEncoding(ParsedPosition p, const DisaRef& t) {
    p[t.component][t.region][t.boundary][t.token] = '2';
    p[t.component].erase(p[t.component].begin() + static_cast<long>(t.detRegion));
    pruneEmpty(p);
    return serializeParsed(p);
}

// Mirrors collectGenetics.ts's isTrivialDeadPair: a whole component that's collapsed down to a
// single region/boundary of two plain (letterless) '2' tokens -- what a DisaPoint + its detached
// partner decay into once split off into their own inert summand (the "T'" shape).
bool isTrivialDeadPair(const ParsedComponent& comp) {
    if (comp.size() != 1 || comp[0].size() != 1) return false;
    const auto& boundary = comp[0][0];
    return boundary.size() == 2 && boundary[0] == '2' && boundary[1] == '2';
}

// ---- nimber lookup across every loaded save --------------------------------------------------

struct Lookup {
    std::vector<SolvedDB> dbs;

    bool value(const Position& pos, SolvedDB::Value& out) const {
        for (const auto& db : dbs) {
            if (db.value(pos, out)) return true;
        }
        return false;
    }
    bool valueForEnc(const std::string& enc, int& nimberOut) const {
        try {
            Position pos = parsePosition(enc);
            SolvedDB::Value v;
            if (!value(pos, v)) return false;
            nimberOut = v.nimber;
            return true;
        } catch (const EncodingError&) {
            return false;
        }
    }
};

// L: enumerate every valid enclosure/join move of the DisaPoint's own region, keep only those
// touching the target token, apply it (untracked -- we only need the resulting encoding), and
// look up the real nimber via the master data (never trust an unvalued/placeholder nimber).
std::set<int> computeL(const Position& pos, std::size_t comp, const DisaRef& target,
                        const Lookup& lookup) {
    std::set<int> out;
    const Component& c = pos.components[comp];

    for (const Enclosure& mv : enclosureMoves(c)) {
        if (mv.region != target.region) continue;
        if (mv.boundary != target.boundary) continue;
        if (mv.i != static_cast<int>(target.token) && mv.j != static_cast<int>(target.token)) continue;
        try {
            Position child = applyEnclosure(pos, comp, mv);
            SolvedDB::Value v;
            if (lookup.value(child, v)) out.insert(v.nimber);
        } catch (const EncodingError&) {
            // Invalid combination (e.g. mask doesn't apply here) -- skip.
        }
    }
    for (const Join& mv : joinMoves(c)) {
        if (mv.region != target.region) continue;
        bool touches = (mv.b1 == target.boundary && mv.i == static_cast<int>(target.token)) ||
                       (mv.b2 == target.boundary && mv.j == static_cast<int>(target.token));
        if (!touches) continue;
        try {
            Position child = applyJoin(pos, comp, mv);
            SolvedDB::Value v;
            if (lookup.value(child, v)) out.insert(v.nimber);
        } catch (const EncodingError&) {
        }
    }
    return out;
}

struct GeneticCode {
    std::set<int> L;
    std::set<int> Tprime;
    int R = -1, D = -1;
};

// T': every whole-position move (childrenAll, not just `dp`'s own region) whose result contains a
// NEW isolated dead-pair component (isTrivialDeadPair) not already present in the root -- the
// same untracked structural fallback collectGenetics.ts's analyzeTEntry uses when tracked
// provenance is unavailable (an L or R move of any DisaPoint never itself produces this shape: L
// reconnects the token within its own region, R deletes/collapses it outright -- see those
// functions' doc comments -- so "a fresh [22] pair appeared" is specific to a T'-shaped move).
//
// KNOWN IMPRECISION vs. the TS live-computation path: this tool does not track per-DisaPoint
// provenance through the move (the TS side's applyMoveTracked retrace, see analyzeTEntry). When a
// position has more than one DisaPoint, this is computed ONCE per position (not per DisaPoint) and
// shared across all of that position's DisaPoints -- there's no way, without tracking, to tell
// which DisaPoint's own branch decayed into a given fresh isolated pair when several are present.
// Positions with exactly one DisaPoint (the common case) are unaffected by this caveat.
std::set<int> computeTPrime(const Position& pos, const ParsedPosition& parsed, const Lookup& lookup) {
    std::set<int> out;
    int rootTrivial = 0;
    for (const auto& comp : parsed) {
        if (isTrivialDeadPair(comp)) ++rootTrivial;
    }

    for (const auto& kid : childrenAll(pos)) {
        ParsedPosition childParsed = parseText(serialize(kid));
        std::vector<std::size_t> trivialIdx;
        for (std::size_t i = 0; i < childParsed.size(); ++i) {
            if (isTrivialDeadPair(childParsed[i])) trivialIdx.push_back(i);
        }
        if (static_cast<int>(trivialIdx.size()) <= rootTrivial) continue;

        // The [22] summand IS the whole child (e.g. [a,3]/[3,a]/[a3]/[3a] -- a bare DisaPoint pair,
        // nothing else in the position): deleting it leaves no subposition at all, the terminal
        // (no-moves-left) position, whose nimber is 0 by definition (mex of the empty option set) --
        // not a lookup miss to silently drop (serializeParsed of an empty ParsedPosition wouldn't
        // parse back at all).
        if (childParsed.size() == 1) {
            out.insert(0);
            continue;
        }

        ParsedPosition remainder = childParsed;
        remainder.erase(remainder.begin() + static_cast<long>(trivialIdx.back()));
        pruneEmpty(remainder);
        int nimber = 0;
        if (lookup.valueForEnc(serializeParsed(remainder), nimber)) out.insert(nimber);
    }
    return out;
}

// Ground-truth R: stalks::disaPointRMove (moves.hpp) runs the paper's InteriorPseudo rewrite
// (3q*)=(q*) through the real engine instead of a hand-spliced text edit -- see its doc comment for
// why (buildRemoveEncoding's text splice silently diverges whenever removing the membrane merges
// two regions together; verify_r_move.cpp is the standalone check that caught this). `compressedPos`
// must be parsePosition(enc) itself (DisaPoints still decompressed as membrane pairs, exactly like
// every other DisaPoint reference in this file), and `dp` must be located via findDisaPoints against
// THAT text's own coordinates (compressedPos's regions), not the fully decompressed ones L/D use.
std::optional<int> computeRGroundTruth(const Position& compressedPos, const DisaRef& dp,
                                        const Lookup& lookup) {
    try {
        Position child = disaPointRMove(compressedPos, dp.component,
                                         static_cast<std::uint32_t>(dp.region),
                                         static_cast<std::uint32_t>(dp.boundary), dp.token);
        SolvedDB::Value v;
        if (lookup.value(child, v)) return v.nimber;
    } catch (const EncodingError&) {
    }
    return std::nullopt;
}

GeneticCode computeCode(const Position& pos, const ParsedPosition& parsed, const DisaRef& dp,
                         const Lookup& lookup, bool& hasD) {
    GeneticCode code;
    code.L = computeL(pos, dp.component, dp, lookup);
    hasD = lookup.valueForEnc(buildReplaceEncoding(parsed, dp), code.D);
    return code;
}

// Full (L,R,D,T') genome of an arbitrary (position, DisaPoint) pair -- the same four computations
// computeCode/computeRGroundTruth/computeTPrime do for a root position, reused here for grandchild
// positions reached while checking the Grandparent Bypass Theorem below. Null if L's D or R lookup
// misses the master data.
std::optional<GeneticCode> fullGenomeAt(const Position& pos, const DisaRef& dp, const Lookup& lookup) {
    const ParsedPosition parsed = parseText(serialize(pos));
    bool hasD = false;
    GeneticCode code = computeCode(pos, parsed, dp, lookup, hasD);
    if (!hasD) return std::nullopt;
    const std::optional<int> r = computeRGroundTruth(pos, dp, lookup);
    if (!r.has_value()) return std::nullopt;
    code.R = *r;
    code.Tprime = computeTPrime(pos, parsed, lookup);
    return code;
}

bool genomeEquals(const GeneticCode& a, const GeneticCode& b) {
    return a.L == b.L && a.R == b.R && a.D == b.D && a.Tprime == b.Tprime;
}

// ---- Grandparent Bypass Theorem ---------------------------------------------------------------
//
// Does `target`, tracked through one T move and then one more move from there, reach some
// grandchild-level descendant whose own (L,R,D,T') genome exactly matches rootCode? Mirrors
// collectGenetics.ts's analyzeTEntry, but native: rather than retracing a move through the WASM
// JSON boundary by canon-matching, this tags target's own two membrane occurrences (its live token
// plus its detached-region partner) with TRACK_ID in a CompSrc and threads that straight through
// two real tracked-apply steps (enclosureChildTracked/joinChildTracked, canon.hpp's TrackedCanon --
// the same native core the WASM applyMoveTracked wraps), then asks at the end whether TRACK_ID
// still marks a genuine DisaPoint's own live token. Simplifications vs. the TS version (both only
// ever narrow -- i.e. can undercount a true bypass, never overcount): no "isolated dumbbell"
// partner-copy fallback (the target only counts as surviving if findDisaPoints resolves it as the
// SAME copy TRACK_ID landed on), and no decay-to-dead-scab structural fallback (a T'-style decay of
// target's own branch is simply not a bypass witness here, matching how R/L already can't produce
// that shape -- see computeTPrime's doc comment).
constexpr int TRACK_ID = 1;  // distinct from GEN_SRC (-2) and untracked (-1); position.hpp

std::vector<CompSrc> buildTrackedSrc(const Position& pos, const DisaRef& dp) {
    std::vector<CompSrc> src(pos.components.size());
    for (std::size_t c = 0; c < pos.components.size(); ++c) {
        const auto& comp = pos.components[c];
        src[c].resize(comp.regions.size());
        for (std::size_t r = 0; r < comp.regions.size(); ++r) {
            src[c][r].resize(comp.regions[r].size());
            for (std::size_t b = 0; b < comp.regions[r].size(); ++b)
                src[c][r][b].assign(comp.regions[r][b].size(), -1);
        }
    }
    src[dp.component][dp.region][dp.boundary][dp.token] = TRACK_ID;
    src[dp.component][dp.detRegion][0][1] = TRACK_ID;  // detached region's lone boundary is [SCAB, MEMB]
    return src;
}

// Whichever findDisaPoints hit (in `pos`'s own text) carries TRACK_ID at its own live-token
// coordinate -- i.e. target's live occurrence specifically, not its detached scab-side partner
// (findDisaPoints never returns the detached region's own token as a hit in the first place).
std::optional<DisaRef> findTrackedDisaPoint(const Position& pos, const std::vector<CompSrc>& src) {
    for (const auto& d : findDisaPoints(parseText(serialize(pos)))) {
        if (d.component < src.size() && d.region < src[d.component].size() &&
            d.boundary < src[d.component][d.region].size() &&
            d.token < src[d.component][d.region][d.boundary].size() &&
            src[d.component][d.region][d.boundary][d.token] == TRACK_ID)
            return d;
    }
    return std::nullopt;
}

bool checkStep2Matches(const TrackedCanon& step2, const Lookup& lookup, const GeneticCode& rootCode) {
    const auto dp2 = findTrackedDisaPoint(step2.pos, step2.src);
    if (!dp2) return false;
    const auto code2 = fullGenomeAt(step2.pos, *dp2, lookup);
    return code2.has_value() && genomeEquals(*code2, rootCode);
}

// One T move (root -> step1), tracked; then every move of step1 (root -> step1 -> step2), tracked
// again from step1's own provenance -- true iff any step2 witnesses the bypass.
bool tMoveBypasses(const TrackedCanon& step1, const Lookup& lookup, const GeneticCode& rootCode) {
    for (std::size_t c2 = 0; c2 < step1.pos.components.size(); ++c2) {
        const Component& comp2 = step1.pos.components[c2];
        if (comp2.dead) continue;
        for (const Enclosure& em : enclosureMoves(comp2)) {
            try {
                if (checkStep2Matches(enclosureChildTracked(step1.pos, step1.src, c2, em), lookup, rootCode))
                    return true;
            } catch (const EncodingError&) {
            }
        }
        for (const Join& jm : joinMoves(comp2)) {
            try {
                if (checkStep2Matches(joinChildTracked(step1.pos, step1.src, c2, jm), lookup, rootCode))
                    return true;
            } catch (const EncodingError&) {
            }
        }
    }
    return false;
}

// True iff `dp` has at least one T move -- DISTINCT canonical children reachable by any
// enclosure/join move of the whole position -- AND every single one of them passes the Grandparent
// Bypass check above. Matches collect.ts's classifyChildrenByDisaPoint's exact three-way exclusion
// so the move set lines up with what the T section of the chart actually lists:
//   1. L moves -- touching dp's own live token (mirrored via the move tag's own coordinates).
//   2. The R move's coincidental re-appearance -- R is really an InteriorPseudo rewrite on a
//      recompressed DISA token (see disaPointRMove) and structurally can't be an ordinary
//      enclosure/join child, EXCEPT the rare coincidence where some unrelated move's result lands
//      on the exact same canonical text; classifyChildrenByDisaPoint excludes only the FIRST such
//      coincidental match (by canonical-text equality against R's own result), same as here.
//   3. T'-shaped children -- the count of trivial [22] dead-pair components goes up relative to the
//      root (the same structural signal computeTPrime already uses; see its doc comment for why
//      this is exact for the common single-DisaPoint case) -- these are the T' row's own children,
//      shown in a different section of the chart, not "T".
// childrenAllWithMoveTag dedupes by resulting canonical position; raw undeduped moves would
// double-count children reachable several ways.
bool computeAllBypass(const Position& pos, const DisaRef& dp, const GeneticCode& rootCode,
                       const Lookup& lookup) {
    const auto psrc = buildTrackedSrc(pos, dp);

    std::optional<std::string> rCanonText;
    try {
        rCanonText = serialize(disaPointRMove(pos, dp.component, static_cast<std::uint32_t>(dp.region),
                                               static_cast<std::uint32_t>(dp.boundary), dp.token));
    } catch (const EncodingError&) {
    }
    bool rExcluded = false;

    int rootTrivial = 0;
    for (const auto& comp : parseText(serialize(pos)))
        if (isTrivialDeadPair(comp)) ++rootTrivial;

    int tCount = 0;
    bool allPass = true;

    for (const auto& [child, tag] : childrenAllWithMoveTag(pos)) {
        if (tag.kind == MoveKind::InteriorPseudo) continue;  // never occurs on fully-decompressed input
        const bool isL = tag.kind == MoveKind::Enclosure
            ? (tag.component == dp.component && tag.region == dp.region && tag.boundary == dp.boundary &&
               (tag.i == static_cast<int>(dp.token) || tag.j == static_cast<int>(dp.token)))
            : (tag.component == dp.component && tag.region == dp.region &&
               ((tag.b1 == dp.boundary && tag.i == static_cast<int>(dp.token)) ||
                (tag.b2 == dp.boundary && tag.j == static_cast<int>(dp.token))));
        if (isL) continue;

        const std::string childText = serialize(child);
        if (!rExcluded && rCanonText.has_value() && childText == *rCanonText) {
            rExcluded = true;
            continue;
        }

        int childTrivial = 0;
        for (const auto& comp : parseText(childText))
            if (isTrivialDeadPair(comp)) ++childTrivial;
        if (childTrivial > rootTrivial) continue;  // T'-shaped, not a "T" entry

        ++tCount;
        if (!allPass) continue;
        try {
            const TrackedCanon step1 = tag.kind == MoveKind::Enclosure
                ? enclosureChildTracked(pos, psrc, tag.component, Enclosure{tag.region, tag.boundary, tag.i, tag.j, tag.mask})
                : joinChildTracked(pos, psrc, tag.component, Join{tag.region, tag.b1, tag.b2, tag.i, tag.j});
            if (!tMoveBypasses(step1, lookup, rootCode)) allPass = false;
        } catch (const EncodingError&) {
            allPass = false;
        }
    }
    return tCount > 0 && allPass;
}

// "({l1,...},R,D,{t1,...})" -- L and T' each sorted ascending (std::set already iterates that
// way) and deduped. collect.ts's genomeKey must produce byte-identical strings for the same
// (L,R,D,T').
std::string genomeKey(const GeneticCode& code) {
    std::string out = "({";
    bool first = true;
    for (int v : code.L) {
        if (!first) out += ',';
        first = false;
        out += std::to_string(v);
    }
    out += "},";
    out += std::to_string(code.R);
    out += ',';
    out += std::to_string(code.D);
    out += ",{";
    first = true;
    for (int v : code.Tprime) {
        if (!first) out += ',';
        first = false;
        out += std::to_string(v);
    }
    out += "})";
    return out;
}

struct Entry {
    std::string enc;
    std::size_t dp;
    int lives;
    bool allBypass;
};

}  // namespace

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: collect_genetics <out.json> <positions.txt> <exactSave1.sprout> "
                     "[exactSave2.sprout ...]\n";
        return 1;
    }
    const std::string outPath = argv[1];
    const std::string positionsPath = argv[2];

    Lookup lookup;
    for (int i = 3; i < argc; ++i) {
        const std::string path = argv[i];
        SolvedDB db = loadGraphFromFile(path);
        if (db.mode() != GameGraph::Mode::Exact) {
            std::cerr << "skipping non-exact save: " << path << "\n";
            continue;
        }
        std::cerr << path << ": " << db.size() << " nodes\n";
        lookup.dbs.push_back(std::move(db));
    }

    std::vector<std::string> allEncs;
    {
        std::ifstream posFile(positionsPath);
        if (!posFile) {
            std::cerr << "cannot open positions file: " << positionsPath << "\n";
            return 1;
        }
        std::set<std::string> seen;
        std::string line;
        while (std::getline(posFile, line)) {
            if (!line.empty() && seen.insert(line).second) allEncs.push_back(line);
        }
    }
    std::cerr << allEncs.size() << " distinct input positions\n";

    std::map<std::string, std::vector<Entry>> byGenome;
    std::size_t scanned = 0, withDisa = 0, genomeHits = 0;

    for (const std::string& enc : allEncs) {
        ++scanned;
        if (scanned % 20000 == 0) { std::cerr << "  ..." << scanned << "/" << allEncs.size() << "\n"; std::cerr.flush(); }

        // Master files store the compressed canonical form -- decompress first, then do every bit
        // of text analysis against the decompressed serialization, exactly matching what
        // collect.ts's analyze().canon actually is (see that file's header for why).
        Position pos;
        Position compressedPos;
        try {
            compressedPos = parsePosition(enc);
            pos = compressedPos.decompressed();
        } catch (const EncodingError&) {
            continue;
        }
        const std::string decText = serialize(pos);

        ParsedPosition parsed = parseText(decText);
        auto disaPoints = findDisaPoints(parsed);
        if (disaPoints.empty()) continue;
        ++withDisa;

        // Same DisaPoints, located in compressedPos's OWN (not fully-decompressed) coordinates --
        // enc already has every DisaPoint decompressed (see canon.hpp), so this finds the identical
        // set in the same relative order (decompressing Hollow/Split/Triplet elsewhere only APPENDS
        // regions after existing ones -- see Component::decompressed -- so it never reorders a
        // DisaPoint's own region/boundary/token ahead of where it sits in compressedPos). Needed by
        // computeRGroundTruth, which must operate on compressedPos's own indices.
        auto disaPointsCompressed = findDisaPoints(parseText(serialize(compressedPos)));

        // Existence gate only -- confirms this position is covered by the master data at all
        // (every individual L/R/D lookup below fails safely on its own otherwise); the value itself
        // is no longer stored (see the module header comment: the parent position's nimber isn't
        // meaningful for collection purposes, unlike its life count).
        int unusedRootNimber = 0;
        if (!lookup.valueForEnc(decText, unusedRootNimber)) continue;
        const int lives = pos.lives2() / 2;

        // Shared across every DisaPoint of this position -- see computeTPrime's doc comment for why
        // (no per-DisaPoint provenance tracking here; positions with >1 DisaPoint all share the
        // same T' set, a documented imprecision).
        const std::set<int> sharedTprime = computeTPrime(pos, parsed, lookup);

        if (disaPointsCompressed.size() != disaPoints.size()) continue;  // shouldn't happen; skip defensively

        for (std::size_t i = 0; i < disaPoints.size(); ++i) {
            const auto& dp = disaPoints[i];
            bool hasD = false;
            GeneticCode code = computeCode(pos, parsed, dp, lookup, hasD);
            std::optional<int> rNimber = computeRGroundTruth(compressedPos, disaPointsCompressed[i], lookup);
            code.Tprime = sharedTprime;
            if (!rNimber.has_value() || !hasD) continue;
            code.R = *rNimber;
            ++genomeHits;
            const bool allBypass = computeAllBypass(pos, dp, code, lookup);
            byGenome[genomeKey(code)].push_back({decText, i, lives, allBypass});
        }
    }

    for (auto& [key, entries] : byGenome) {
        std::stable_sort(entries.begin(), entries.end(),
                          [](const Entry& a, const Entry& b) { return a.lives < b.lives; });
    }

    std::cerr << "scanned " << scanned << ", with DisaPoints " << withDisa << ", genome hits "
              << genomeHits << ", distinct genomes " << byGenome.size() << "\n";

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    // The Stalks encoding alphabet (letters/digits/'|'/','/'+' ) never contains a quote or
    // backslash, so the enc strings need no JSON escaping.
    f << "{";
    bool firstGenome = true;
    for (const auto& [key, entries] : byGenome) {
        if (!firstGenome) f << ",";
        firstGenome = false;
        f << "\"" << key << "\":[";
        for (std::size_t i = 0; i < entries.size(); ++i) {
            if (i) f << ",";
            f << "{\"enc\":\"" << entries[i].enc << "\",\"dp\":" << entries[i].dp
              << ",\"lives\":" << entries[i].lives
              << ",\"allBypass\":" << (entries[i].allBypass ? "true" : "false") << "}";
        }
        f << "]";
    }
    f << "}";

    return 0;
}
