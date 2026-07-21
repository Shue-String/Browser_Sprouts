// Offline tool: scan every minimal node stored in the given master save files, find positions
// whose "life" (compressed token count, counting each DisaPoint as one life -- see
// src/model/collectGenetics.ts's countLives for the TS-side definition of the same concept) is
// 5, 6, or 7, and for every DisaPoint in such a position compute its genetic code (L, R, D nimber
// sets/values). Positions whose only DisaPoint has code ({0},1,1) go to one output file;
// ({1},0,0) to another.
//
// This operates purely on the text form of the decompressed canonical encoding (the same
// '2'+letter "detached pair" convention collectGenetics.ts's parseEncoding/findDisaPoints use),
// converting to/from stalks::Position only at the engine boundary (move enumeration/application
// and nimber lookup) -- see collectGenetics.ts's header comment for why this convention exists.
//
// Usage: collect_genetics <out011.txt> <out100.txt> <save1.sprout> [save2.sprout ...]

#include "canon.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "savefile.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
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

int countTokens(const ParsedPosition& p) {
    int n = 0;
    for (const auto& comp : p)
        for (const auto& region : comp)
            for (const auto& b : region) n += static_cast<int>(b.size());
    return n;
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
    // (component, letter) -> region, but detect the mutual/dumbbell case (two lone 2X regions
    // whose single letter is exactly the pairing partner) which we must NOT treat as a DisaPoint.
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

std::string buildRemoveEncoding(ParsedPosition p, const DisaRef& t) {
    p[t.component][t.region][t.boundary].erase(t.token, 1);
    p[t.component].erase(p[t.component].begin() + static_cast<long>(t.detRegion));
    pruneEmpty(p);
    return serializeParsed(p);
}

std::string buildReplaceEncoding(ParsedPosition p, const DisaRef& t) {
    p[t.component][t.region][t.boundary][t.token] = '2';
    p[t.component].erase(p[t.component].begin() + static_cast<long>(t.detRegion));
    pruneEmpty(p);
    return serializeParsed(p);
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

// Same enumeration as computeL, but collecting the reachable positions' BASE canonical
// serializations (matching childrenAllWithMoveTag's own canonicalize()) instead of nimbers --
// used to exclude L-reachable children from the T candidate list by string identity, sidestepping
// childrenAllWithMoveTag's own dedup-of-isomorphic-outcomes ambiguity (see collectGenetics.ts's
// lMoveNimbers doc for why raw MoveTag matching alone is unsound here).
std::set<std::string> computeLCanonSet(const Position& pos, std::size_t comp, const DisaRef& target) {
    std::set<std::string> out;
    const Component& c = pos.components[comp];
    for (const Enclosure& mv : enclosureMoves(c)) {
        if (mv.region != target.region || mv.boundary != target.boundary) continue;
        if (mv.i != static_cast<int>(target.token) && mv.j != static_cast<int>(target.token)) continue;
        try {
            out.insert(serialize(canonicalize(applyEnclosure(pos, comp, mv))));
        } catch (const EncodingError&) {
        }
    }
    for (const Join& mv : joinMoves(c)) {
        if (mv.region != target.region) continue;
        bool touches = (mv.b1 == target.boundary && mv.i == static_cast<int>(target.token)) ||
                       (mv.b2 == target.boundary && mv.j == static_cast<int>(target.token));
        if (!touches) continue;
        try {
            out.insert(serialize(canonicalize(applyJoin(pos, comp, mv))));
        } catch (const EncodingError&) {
        }
    }
    return out;
}

struct GeneticCode {
    std::set<int> L;
    int R = -1, D = -1;
    bool hasR = false, hasD = false;
};

bool codesEqual(const GeneticCode& a, const GeneticCode& b) {
    if (a.hasR != b.hasR || (a.hasR && a.R != b.R)) return false;
    if (a.hasD != b.hasD || (a.hasD && a.D != b.D)) return false;
    return a.L == b.L;
}

GeneticCode computeCode(const Position& pos, const ParsedPosition& parsed, const DisaRef& dp,
                         const Lookup& lookup) {
    GeneticCode code;
    code.L = computeL(pos, dp.component, dp, lookup);
    code.hasR = lookup.valueForEnc(buildRemoveEncoding(parsed, dp), code.R);
    code.hasD = lookup.valueForEnc(buildReplaceEncoding(parsed, dp), code.D);
    return code;
}

// ---- T moves + Grandparent Bypass Theorem (native mirror of collectGenetics.ts's
// classifyChildrenByDisaPoint / checkGrandparentBypass -- see that file's doc comments for the
// full rationale) -----------------------------------------------------------------------------

// Caller-assigned provenance id used only to trace one specific DisaPoint's token through a chain
// of tracked move applications. Distinct from GEN_SRC (-2) / untracked (-1).
constexpr int kTrackId = 1;

std::vector<CompSrc> untrackedPosSrc(const Position& pos) {
    std::vector<CompSrc> src(pos.components.size());
    for (std::size_t c = 0; c < pos.components.size(); ++c) {
        const auto& regions = pos.components[c].regions;
        src[c].resize(regions.size());
        for (std::size_t r = 0; r < regions.size(); ++r) {
            src[c][r].resize(regions[r].size());
            for (std::size_t b = 0; b < regions[r].size(); ++b) {
                src[c][r][b].assign(regions[r][b].size(), -1);
            }
        }
    }
    return src;
}

struct SrcLoc {
    std::size_t component, region, boundary, token;
};

std::optional<SrcLoc> locateTrackId(const std::vector<CompSrc>& src, int trackId) {
    for (std::size_t c = 0; c < src.size(); ++c)
        for (std::size_t r = 0; r < src[c].size(); ++r)
            for (std::size_t b = 0; b < src[c][r].size(); ++b)
                for (std::size_t t = 0; t < src[c][r][b].size(); ++t)
                    if (src[c][r][b][t] == trackId) return SrcLoc{c, r, b, t};
    return std::nullopt;
}

std::optional<TrackedCanon> applyTracked(const Position& p, const std::vector<CompSrc>& psrc,
                                          const MoveTag& tag) {
    try {
        if (tag.kind == MoveKind::Enclosure) {
            Enclosure m;
            m.region = tag.region;
            m.boundary = tag.boundary;
            m.i = tag.i;
            m.j = tag.j;
            m.mask = tag.mask;
            return enclosureChildTracked(p, psrc, tag.component, m);
        }
        if (tag.kind == MoveKind::Join) {
            Join m;
            m.region = tag.region;
            m.b1 = tag.b1;
            m.b2 = tag.b2;
            m.i = tag.i;
            m.j = tag.j;
            return joinChildTracked(p, psrc, tag.component, m);
        }
    } catch (const EncodingError&) {
    }
    return std::nullopt;  // InteriorPseudo, or an engine-rejected move.
}

// Does `target` survive one T move and have some grandchild-level descendant (tracked by
// provenance, not just any DisaPoint the descendant happens to contain) whose own (L,R,D) genetic
// code exactly matches `rootCode`?
bool traceBypass(const Position& pos, const DisaRef& target, const MoveTag& tMoveTag,
                  const GeneticCode& rootCode, const Lookup& lookup) {
    std::vector<CompSrc> rootSrc = untrackedPosSrc(pos);
    rootSrc[target.component][target.region][target.boundary][target.token] = kTrackId;

    const auto step1 = applyTracked(pos, rootSrc, tMoveTag);
    if (!step1 || !locateTrackId(step1->src, kTrackId)) return false;

    for (const auto& [gcPos, gcTag] : childrenAllWithMoveTag(step1->pos)) {
        (void)gcPos;
        const auto step2 = applyTracked(step1->pos, step1->src, gcTag);
        if (!step2) continue;
        const auto loc2 = locateTrackId(step2->src, kTrackId);
        if (!loc2) continue;

        ParsedPosition parsed2 = parseText(serialize(step2->pos));
        auto disaPoints2 = findDisaPoints(parsed2);
        auto it = std::find_if(disaPoints2.begin(), disaPoints2.end(), [&](const DisaRef& d) {
            return d.component == loc2->component && d.region == loc2->region &&
                   d.boundary == loc2->boundary && d.token == loc2->token;
        });
        if (it == disaPoints2.end()) continue;  // survived, but isn't (currently) a DisaPoint here.

        if (codesEqual(computeCode(step2->pos, parsed2, *it, lookup), rootCode)) return true;
    }
    return false;
}

// True iff any T move (a real child of `pos` that isn't L- or R-reachable for `target`) triggers
// the Grandparent Bypass Theorem.
bool anyTMoveBypasses(const Position& pos, const ParsedPosition& parsed, const DisaRef& target,
                       const GeneticCode& rootCode, const Lookup& lookup) {
    const std::set<std::string> lCanon = computeLCanonSet(pos, target.component, target);
    std::string rCanon;
    try {
        rCanon = serialize(canonicalize(parsePosition(buildRemoveEncoding(parsed, target))));
    } catch (const EncodingError&) {
    }

    for (const auto& [kid, tag] : childrenAllWithMoveTag(pos)) {
        const std::string kidEnc = serialize(kid);
        if (lCanon.count(kidEnc)) continue;
        if (!rCanon.empty() && kidEnc == rCanon) continue;
        if (traceBypass(pos, target, tag, rootCode, lookup)) return true;
    }
    return false;
}

struct Entry {
    std::string enc;
    std::string display;
    std::set<int> L;
    int R = -1, D = -1;
    bool hasR = false, hasD = false;
    bool bypass = false;  // true iff some T move satisfies the Grandparent Bypass Theorem.
};

std::string fmtSet(const std::set<int>& s) {
    if (s.empty()) return "{}";
    std::string out = "{";
    bool first = true;
    for (int v : s) {
        if (!first) out += ", ";
        first = false;
        out += std::to_string(v);
    }
    out += "}";
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: collect_genetics <out011.txt> <out100.txt> <save1.sprout> [save2.sprout ...]\n";
        return 1;
    }
    const std::string out011Path = argv[1];
    const std::string out100Path = argv[2];

    Lookup lookup;
    std::vector<std::string> allEncs;
    std::set<std::string> seen;
    for (int i = 3; i < argc; ++i) {
        const std::string path = argv[i];
        SolvedDB db = loadGraphFromFile(path);
        if (db.mode() != GameGraph::Mode::Exact) {
            std::cerr << "skipping non-exact save: " << path << "\n";
            continue;
        }
        std::cerr << path << ": " << db.size() << " nodes\n";
        for (const auto& enc : db.encs()) {
            if (seen.insert(enc).second) allEncs.push_back(enc);
        }
        lookup.dbs.push_back(std::move(db));
    }
    std::cerr << allEncs.size() << " distinct encodings total\n";

    std::vector<Entry> matches011, matches100;
    std::size_t scanned = 0, withDisa = 0, life567 = 0;

    const bool trace = std::getenv("COLLECT_GENETICS_TRACE") != nullptr;
    for (const std::string& enc : allEncs) {
        ++scanned;
        if (trace) { std::cerr << "SCAN " << scanned << ": " << enc << "\n"; std::cerr.flush(); }
        if (scanned % 20000 == 0) { std::cerr << "  ..." << scanned << "/" << allEncs.size() << "\n"; std::cerr.flush(); }

        // Master files store the compressed canonical form (HOLL/SPLIT/TRIP pseudo-points
        // collapsed) -- DisaPoints alone are deliberately left decompressed by canonicalize()
        // (see canon.cpp's "DisaPoints are left decompressed" comment), but enclosureMoves/
        // joinMoves require a FULLY decompressed component (calling them on a still-compressed
        // one is undefined behavior -- crashes on positions with a lone HOLL/SPLIT/TRIP token).
        // So: decompress first, then do every bit of text analysis against the decompressed
        // serialization, exactly matching what collect.ts's analyze().canon actually is.
        Position pos;
        try {
            pos = parsePosition(enc).decompressed();
        } catch (const EncodingError&) {
            continue;
        }
        const std::string decText = serialize(pos);

        ParsedPosition parsed = parseText(decText);
        auto disaPoints = findDisaPoints(parsed);
        if (disaPoints.empty()) continue;
        ++withDisa;

        int life = countTokens(parsed) - 2 * static_cast<int>(disaPoints.size());
        if (life != 5 && life != 6 && life != 7) continue;
        ++life567;

        for (const auto& dp : disaPoints) {
            std::set<int> L = computeL(pos, dp.component, dp, lookup);

            int R = 0, D = 0;
            bool hasR = lookup.valueForEnc(buildRemoveEncoding(parsed, dp), R);
            bool hasD = lookup.valueForEnc(buildReplaceEncoding(parsed, dp), D);

            Entry e;
            e.enc = decText;
            e.L = L;
            e.R = R;
            e.D = D;
            e.hasR = hasR;
            e.hasD = hasD;

            if (hasR && hasD) {
                const bool matchLow = L.size() == 1 && *L.begin() == 0 && R == 1 && D == 1;
                const bool matchHigh = L.size() == 1 && *L.begin() == 1 && R == 0 && D == 0;
                if (matchLow || matchHigh) {
                    const GeneticCode rootCode{L, R, D, hasR, hasD};
                    e.bypass = anyTMoveBypasses(pos, parsed, dp, rootCode, lookup);
                    if (matchLow) matches011.push_back(e);
                    if (matchHigh) matches100.push_back(e);
                }
            }
        }
    }

    std::cerr << "scanned " << scanned << ", with DisaPoints " << withDisa << ", life 5/6/7 "
              << life567 << "\n";
    std::cerr << "matches ({0},1,1): " << matches011.size() << "\n";
    std::cerr << "matches ({1},0,0): " << matches100.size() << "\n";

    auto write = [](const std::string& path, const std::vector<Entry>& entries) {
        std::ofstream f(path, std::ios::binary);
        if (!f) {
            std::cerr << "cannot open output file: " << path << "\n";
            return;
        }
        for (const auto& e : entries) {
            f << e.enc << "  L=" << fmtSet(e.L) << " R=" << e.R << " D=" << e.D
              << (e.bypass ? "  ?" : "") << "\n";
        }
    };
    write(out011Path, matches011);
    write(out100Path, matches100);

    return 0;
}
