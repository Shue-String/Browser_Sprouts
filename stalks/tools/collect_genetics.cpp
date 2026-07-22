// Offline tool: scan every minimal node stored in the given master save files, find positions
// whose "life" (compressed token count, counting each DisaPoint as one life -- see
// src/model/collectGenetics.ts's countLives for the TS-side definition of the same concept) is 7
// or fewer, and for every DisaPoint in such a position compute its genetic code (L, R, D nimber
// set/values). Groups every DisaPoint by its exact genome (a string key "({l1,l2,...},R,D)", L
// sorted ascending and deduped) and writes one JSON object mapping genome -> array of
// {enc, dp, nimber} entries, where `enc` is the position's decompressed canonical encoding (the
// same text collect.ts's analyze().canon produces), `dp` is the 0-based index of the matching
// DisaPoint within findDisaPoints(enc)'s deterministic order, and `nimber` is the WHOLE position's
// own value (shared by every DisaPoint of that enc).
//
// T/T' move listings and the Grandparent Bypass Theorem are intentionally NOT computed here --
// collect.ts computes those lazily, on demand, the moment a genome-loaded entry is actually opened
// (see collect.ts's fillDetail) -- so this scan only needs to cover every DisaPoint of every
// <=7-life position, not every position's full move tree.
//
// This operates purely on the text form of the decompressed canonical encoding (the same
// '2'+letter "detached pair" convention collectGenetics.ts's parseEncoding/findDisaPoints use),
// converting to/from stalks::Position only at the engine boundary (nimber lookup) -- see
// collectGenetics.ts's header comment for why this convention exists.
//
// Usage: collect_genetics <out.json> <save1.sprout> [save2.sprout ...]

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

// Mirrors collectGenetics.ts's buildRemoveEncoding exactly, including the 7/DisaPoint/8 ->
// single-scab collapse: a DisaPoint that's the sole content between one joint's two visits can't
// just be deleted, or the joint is left with zero-length content between its visits, which the
// engine can't parse as text.
std::string buildRemoveEncoding(ParsedPosition p, const DisaRef& t) {
    auto& boundary = p[t.component][t.region][t.boundary];
    const bool straddlesJoint = t.token > 0 && t.token + 1 < boundary.size() &&
                                 boundary[t.token - 1] == '7' && boundary[t.token + 1] == '8';
    if (straddlesJoint) {
        boundary.replace(t.token - 1, 3, "2");
    } else {
        boundary.erase(t.token, 1);
    }
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

struct GeneticCode {
    std::set<int> L;
    int R = -1, D = -1;
};

GeneticCode computeCode(const Position& pos, const ParsedPosition& parsed, const DisaRef& dp,
                         const Lookup& lookup, bool& hasR, bool& hasD) {
    GeneticCode code;
    code.L = computeL(pos, dp.component, dp, lookup);
    hasR = lookup.valueForEnc(buildRemoveEncoding(parsed, dp), code.R);
    hasD = lookup.valueForEnc(buildReplaceEncoding(parsed, dp), code.D);
    return code;
}

// "({l1,l2,...},R,D)" -- L sorted ascending (std::set already iterates that way) and deduped.
// collect.ts's genomeKey must produce byte-identical strings for the same (L,R,D).
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
    out += ')';
    return out;
}

struct Entry {
    std::string enc;
    std::size_t dp;
    int nimber;
};

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: collect_genetics <out.json> <save1.sprout> [save2.sprout ...]\n";
        return 1;
    }
    const std::string outPath = argv[1];

    Lookup lookup;
    std::vector<std::string> allEncs;
    std::set<std::string> seen;
    for (int i = 2; i < argc; ++i) {
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

    std::map<std::string, std::vector<Entry>> byGenome;
    std::size_t scanned = 0, withDisa = 0, life7 = 0, genomeHits = 0;

    for (const std::string& enc : allEncs) {
        ++scanned;
        if (scanned % 20000 == 0) { std::cerr << "  ..." << scanned << "/" << allEncs.size() << "\n"; std::cerr.flush(); }

        // Master files store the compressed canonical form -- decompress first, then do every bit
        // of text analysis against the decompressed serialization, exactly matching what
        // collect.ts's analyze().canon actually is (see that file's header for why).
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
        if (life > 7) continue;
        ++life7;

        int rootNimber = 0;
        if (!lookup.valueForEnc(decText, rootNimber)) continue;

        for (std::size_t i = 0; i < disaPoints.size(); ++i) {
            const auto& dp = disaPoints[i];
            bool hasR = false, hasD = false;
            GeneticCode code = computeCode(pos, parsed, dp, lookup, hasR, hasD);
            if (!hasR || !hasD) continue;
            ++genomeHits;
            byGenome[genomeKey(code)].push_back({decText, i, rootNimber});
        }
    }

    std::cerr << "scanned " << scanned << ", with DisaPoints " << withDisa << ", life<=7 " << life7
              << ", genome hits " << genomeHits << ", distinct genomes " << byGenome.size() << "\n";

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
              << ",\"nimber\":" << entries[i].nimber << "}";
        }
        f << "]";
    }
    f << "}";

    return 0;
}
