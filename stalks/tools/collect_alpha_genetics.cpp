// Offline tool: scan one or more .spec save files (see specfile.hpp) for minimal nodes containing
// exactly one special-point symbol, requiring it to be ALPHA specifically (not some other future
// symbol) -- i.e. "single-crit" positions in the user's terms. For each such position, compute its
// genome directly from the engine's own movetype classification (moves.hpp's
// specialPointMovetypes/packMovetypes -- Phases 2a/2b/3/5): unlike the old DisaPoint-based Collect
// pipeline (collect_genetics.cpp), no provenance tracking or heuristic move-classification is
// needed here -- the engine already tags every child with a movetype 1-5 for this exact symbol,
// and per the user's mapping: movetype 1 -> R, 2 -> D, 3 -> L, 4 -> T', 5 -> T.
//
// The .spec files are used purely as a cheap SOURCE of already-reachable single-alpha encodings
// (skipping the minutes-long GameGraph build a from-scratch scan would need) -- genome computation
// itself is fresh, direct engine calls per position, not read from the .spec edges' own stored
// movetype/value (SpecEdge intentionally doesn't retain child indices/encodings, only the resolved
// value used to recompute ITS OWN node's value -- see specfile.hpp). Each move's child position is
// valued via SpecDB::value, since it's necessarily reachable in the same graph the source .spec
// file already solved (graph.cpp::build()'s own move enumeration is a superset of
// childrenAllWithMoveTag's, so nothing enumerated here can be missing from the file).
//
// Genome bucket key, per the user: "(R,D,{L},{T'})" -- R/D are single nimbers (at most one vanish
// move and at most one become-scab move for a lone special point), {L}/{T'} are deduped nimber
// sets. [T] (the list of untouched-alpha children) is NOT part of the bucket key, same as the old
// T column -- exact semantics of its own brackets are still TBD, so this only records the raw
// (enc, nimber) witnesses for now.
//
// Every stored position (the entry's own enc and each T witness) ALSO carries its quick-canon
// (Advanced Collections) display form -- quickEnc/quickOffset, true-nimber(x) = nimber(quickEnc) ^
// quickOffset -- alongside the real exact `enc`. Per the user's request to surface the more compact
// quick-canon form rather than the raw structural encoding. The exact `enc` is kept as the
// authoritative identity/re-analysis key (never replaced by the quick-canon rep): a quick-canon rep
// is only proven nimber-equivalent (up to the offset) to the real position, not proven to have the
// SAME genome under further movetype classification, so re-deriving a witness's own genome (e.g.
// clicking a T row) must still analyze the real position, not its quick-canon stand-in -- quickEnc
// is display-only. T witnesses are deduped by (quickEnc, quickOffset), mirroring
// stalks.ts's QuickChildInfo convention -- two witnesses sharing that pair are, by construction,
// the exact same position (their true nimbers must therefore also agree; not re-checked here).
//
// Usage: collect_alpha_genetics <out.json> <spec1.spec> [spec2.spec ...]

#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

using namespace stalks;

namespace {

struct QuickDisp {
    std::string enc;
    int offset = 0;
};

QuickDisp quickDisp(const Position& p) {
    const QuickCanonResult qc = quickCanon(p);
    return {serialize(qc.rep), qc.offset};
}

struct TWitness {
    std::string enc;
    QuickDisp quick;
    int nimber = 0;
};

struct Entry {
    std::string enc;
    QuickDisp quick;
    int lives = 0;
    int R = 0, D = 0;
    std::set<int> L;
    std::set<int> Tprime;
    std::vector<TWitness> T;
};

std::string setStr(const std::set<int>& s) {
    std::string out = "{";
    bool first = true;
    for (int v : s) {
        if (!first) out += ",";
        first = false;
        out += std::to_string(v);
    }
    out += "}";
    return out;
}

std::string genomeKey(int R, int D, const std::set<int>& L, const std::set<int>& Tprime) {
    return "(" + std::to_string(R) + "," + std::to_string(D) + "," + setStr(L) + "," + setStr(Tprime) + ")";
}

// Exactly one special-point character present in `enc`, and it's specifically alpha ('a') -- see
// tokens.hpp's tokenChar/charToken convention (special points are the only lowercase letters this
// format's decoded text ever contains; membranes use uppercase A-V).
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

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: collect_alpha_genetics <out.json> <spec1.spec> [spec2.spec ...]\n";
        return 1;
    }
    const std::string outPath = argv[1];

    std::map<std::string, Entry> byEnc;  // dedup across files, keyed by enc

    for (int i = 2; i < argc; ++i) {
        const std::string path = argv[i];
        SpecDB db;
        try {
            db = loadSpecGraphFromFile(path);
        } catch (const std::exception& e) {
            std::cerr << "skipping " << path << ": " << e.what() << "\n";
            continue;
        }
        std::cerr << path << ": " << db.size() << " nodes\n";

        std::size_t scanned = 0, qualifying = 0;
        for (const SpecNode& node : db.nodes()) {
            ++scanned;
            if (scanned % 200000 == 0) { std::cerr << "  ..." << scanned << "/" << db.size() << "\n"; std::cerr.flush(); }
            if (!isSingleAlpha(node.enc)) continue;
            if (byEnc.count(node.enc)) continue;  // already found via an earlier file

            Position p;
            try {
                p = canonicalize(parsePosition(node.enc));
            } catch (const EncodingError&) {
                continue;
            }
            if (!hasSpecialPoint(p)) continue;  // shouldn't happen given isSingleAlpha; defensive
            const Position d = p.decompressed();

            Entry e;
            e.enc = node.enc;
            e.quick = quickDisp(p);
            e.lives = p.lives2() / 2;
            std::optional<int> R, D;
            bool warned = false;
            std::set<std::pair<std::string, int>> seenTWitness;

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
                        std::cerr << "  warning: child of " << node.enc << " not found in graph, skipping edge(s)\n";
                        warned = true;
                    }
                    continue;
                }
                const Position childCanon = canonicalize(child);
                const std::string childEnc = serialize(childCanon);

                switch (movetype) {
                    case 1:
                        if (R.has_value() && *R != val.nimber)
                            std::cerr << "  warning: multiple distinct R values for " << node.enc << "\n";
                        R = val.nimber;
                        break;
                    case 2:
                        if (D.has_value() && *D != val.nimber)
                            std::cerr << "  warning: multiple distinct D values for " << node.enc << "\n";
                        D = val.nimber;
                        break;
                    case 3:
                        e.L.insert(val.nimber);
                        break;
                    case 4:
                        e.Tprime.insert(val.nimber);
                        break;
                    case 5: {
                        const QuickDisp qd = quickDisp(childCanon);
                        if (seenTWitness.insert({qd.enc, qd.offset}).second)
                            e.T.push_back({childEnc, qd, val.nimber});
                        break;
                    }
                    default:
                        break;
                }
            }

            if (!R.has_value() || !D.has_value()) continue;  // shouldn't happen; skip defensively
            e.R = *R;
            e.D = *D;
            ++qualifying;
            byEnc.emplace(node.enc, std::move(e));
        }
        std::cerr << "  scanned " << scanned << ", qualifying " << qualifying << "\n";
    }

    std::map<std::string, std::vector<Entry*>> byGenome;
    for (auto& [enc, e] : byEnc) byGenome[genomeKey(e.R, e.D, e.L, e.Tprime)].push_back(&e);
    for (auto& [key, entries] : byGenome) {
        std::stable_sort(entries.begin(), entries.end(),
                          [](const Entry* a, const Entry* b) { return a->lives < b->lives; });
    }

    std::cerr << "distinct single-alpha positions " << byEnc.size() << ", distinct genomes "
              << byGenome.size() << "\n";

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    // The Stalks encoding alphabet (letters/digits/'|'/','/'+') never contains a quote or
    // backslash, so enc strings need no JSON escaping.
    f << "{";
    bool firstGenome = true;
    for (const auto& [key, entries] : byGenome) {
        if (!firstGenome) f << ",";
        firstGenome = false;
        f << "\"" << key << "\":[";
        for (std::size_t i = 0; i < entries.size(); ++i) {
            if (i) f << ",";
            const Entry& e = *entries[i];
            f << "{\"enc\":\"" << e.enc << "\",\"quickEnc\":\"" << e.quick.enc
              << "\",\"quickOffset\":" << e.quick.offset << ",\"lives\":" << e.lives << ",\"T\":[";
            for (std::size_t j = 0; j < e.T.size(); ++j) {
                if (j) f << ",";
                const TWitness& t = e.T[j];
                f << "{\"enc\":\"" << t.enc << "\",\"quickEnc\":\"" << t.quick.enc
                  << "\",\"quickOffset\":" << t.quick.offset << ",\"nimber\":" << t.nimber << "}";
            }
            f << "]}";
        }
        f << "]";
    }
    f << "}";

    return 0;
}
