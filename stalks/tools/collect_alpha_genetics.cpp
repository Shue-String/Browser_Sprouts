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
// (enc, nimber) T-children for now.
//
// Every stored position (the entry's own enc and each T-child) ALSO carries its quick-canon
// (Advanced Collections) display form -- quickEnc/quickOffset, true-nimber(x) = nimber(quickEnc) ^
// quickOffset -- alongside the real exact `enc`. Per the user's request to surface the more compact
// quick-canon form rather than the raw structural encoding. The exact `enc` is kept as the
// authoritative identity/re-analysis key (never replaced by the quick-canon rep): a quick-canon rep
// is only proven nimber-equivalent (up to the offset) to the real position, not proven to have the
// SAME genome under further movetype classification, so re-deriving a T-child's own genome (e.g.
// clicking a T row) must still analyze the real position, not its quick-canon stand-in -- quickEnc
// is display-only. T-children are deduped by (quickEnc, quickOffset), mirroring
// stalks.ts's QuickChildInfo convention -- two T-children sharing that pair are, by construction,
// the exact same position (their true nimbers must therefore also agree; not re-checked here).
//
// Usage: collect_alpha_genetics <out.json> <spec1.spec> [spec2.spec ...]

#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "json_keys.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
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

// quickCanon() itself has no memoization (it's a from-scratch crit-cell/scab-cell/registry/
// DisaPoint fixpoint search every call, see collections.cpp). This tool calls it once per
// qualifying position plus once per T-child found, and T-children repeat heavily across
// sibling/cousin positions in a large corpus -- confirmed empirically (90% cache hit rate on
// the 3-spot corpus: 193791 hits / 20624 misses). Local to this tool -- quickCanon's registry
// is fixed for the process lifetime, so this is a pure function of serialize(p), safe to cache
// unconditionally.
std::map<std::string, QuickDisp> gQuickDispCache;

QuickDisp quickDisp(const Position& p) {
    const std::string key = serialize(p);
    const auto cached = gQuickDispCache.find(key);
    if (cached != gQuickDispCache.end()) return cached->second;
    const QuickCanonResult qc = quickCanon(p);
    return gQuickDispCache.emplace(key, QuickDisp{serialize(qc.rep), qc.offset}).first->second;
}

struct TChild {
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
    std::vector<TChild> T;
};

// Comma-joined values, no wrapping braces/brackets -- for embedding directly inside a JSON array
// literal (alpha_genome.cpp's genomeKey wraps the equivalent in "{...}" for the human-facing
// genome-bucket key text).
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

}  // namespace

int main(int argc, char** argv) {
    // Optional --max-lives=N, may appear anywhere among the spec-file args (mirrors
    // filter_collect_alpha_lives.js's own flag). Kept unfiltered (INT_MAX) by default, matching
    // the tool's original "always emit the full scanned set" contract for ad-hoc analysis --
    // filtering happens here (skipping entries entirely, before they're ever serialized) rather
    // than only in the downstream JS step because the full unfiltered corpus scan now produces a
    // JSON text file (3.7GB on the current merged_alpha_corpus.spec, 1M+ qualifying positions)
    // past Node's readFileSync string-length ceiling (~512MB) -- the JS step can no longer even
    // load it to filter. Filtering in-process, before ever building the giant output string,
    // sidesteps that entirely rather than working around Node's limit.
    int maxLives = std::numeric_limits<int>::max();
    std::vector<std::string> positional;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg.rfind("--max-lives=", 0) == 0) {
            maxLives = std::atoi(arg.c_str() + 12);
        } else {
            positional.push_back(arg);
        }
    }
    if (positional.size() < 2) {
        std::cerr << "usage: collect_alpha_genetics [--max-lives=N] <out.json> <spec1.spec> [spec2.spec ...]\n";
        return 1;
    }
    const std::string outPath = positional[0];

    std::map<std::string, Entry> byEnc;  // dedup across files, keyed by enc

    for (std::size_t i = 1; i < positional.size(); ++i) {
        const std::string path = positional[i];
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
            if (!stalks_tools::isSingleAlpha(node.enc)) continue;
            if (byEnc.count(node.enc)) continue;  // already found via an earlier file

            Position p;
            try {
                p = canonicalize(parsePosition(node.enc));
            } catch (const EncodingError&) {
                continue;
            }
            if (!hasSpecialPoint(p)) continue;  // shouldn't happen given isSingleAlpha; defensive

            // canonicalizeFull, not p itself: p deliberately stays DisaPoint-decompressed (see
            // canon.hpp -- canonicalize() compresses Hollow/Split/Triplet but not DisaPoints) so
            // the movetype classification below sees the base structural form it always has.
            // leftSideLives2()'s whole point is counting a literal DISA token as 1 life instead of
            // 2 (see tokens.hpp); computing it on the decompressed form would never see a DISA
            // token to apply that rule to. Isolated to just this field via a throwaway copy, so it
            // doesn't disturb the movetype pipeline's own canonical form.
            const int lives = canonicalizeFull(p).leftSideLives2() / 2;
            // Checked before any of the expensive per-position work below (quickCanon, the R/D/
            // L/T' + T-children enumeration): this position's own lives value alone decides
            // whether IT is kept, independent of any other position -- its T-children (which have
            // strictly lower lives, being one move away) still get their own independent turn as
            // db.nodes() reaches them directly, so skipping this entry's own expensive work here
            // loses nothing. Same overall result as the old two-step full-scan-then-JS-filter
            // pipeline, just filtering before the expensive work instead of after it.
            if (lives > maxLives) continue;

            const Position d = p.decompressed();
            Entry e;
            e.enc = node.enc;
            e.lives = lives;
            e.quick = quickDisp(p);

            // R/D/L/T' (movetypes 1-4) AND T-children (movetype 5) in ONE pass over this
            // position's children -- classifyAlphaGenome and tChildrenOf (alpha_genome.cpp) each
            // do their own separate childrenAllWithMoveTag+specialPointMovetypes walk, memoized
            // by exact position; that memoization only pays off for POSITIONS REVISITED from
            // multiple places (the recursive tools like find_yellow_candidates), but every
            // top-level position here is visited exactly once (db.nodes() is already deduped),
            // so calling both would mean walking every child TWICE for zero cache benefit -- the
            // actual dominant, unavoidable cost of this scan (confirmed: the quickDisp memo above
            // alone only cut ~15% off total time despite a 90% hit rate, because the two full
            // enumeration passes this replaces were never being deduped at all). Inlined here
            // rather than added as a new shared alpha_genome.cpp function to keep this fix scoped
            // to this tool -- other callers' existing cache semantics are untouched.
            std::optional<int> R, D;
            std::set<int> L, Tprime;
            std::set<std::pair<std::string, int>> seenTChild;
            bool warnedMissing = false;
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
                    if (!warnedMissing) {
                        std::cerr << "  warning: child of " << serialize(p)
                                  << " not found in graph, skipping edge(s)\n";
                        warnedMissing = true;
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
                        L.insert(val.nimber);
                        break;
                    case 4:
                        Tprime.insert(val.nimber);
                        break;
                    case 5: {
                        const Position childCanon = canonicalize(child);
                        const QuickDisp qd = quickDisp(childCanon);
                        if (seenTChild.insert({qd.enc, qd.offset}).second)
                            e.T.push_back({serialize(childCanon), qd, val.nimber});
                        break;
                    }
                    default:
                        break;
                }
            }
            if (!R.has_value() || !D.has_value()) continue;  // shouldn't happen; skip defensively
            e.R = *R;
            e.D = *D;
            e.L = L;
            e.Tprime = Tprime;

            ++qualifying;
            byEnc.emplace(node.enc, std::move(e));
        }
        std::cerr << "  scanned " << scanned << ", qualifying " << qualifying << "\n";
    }

    std::map<std::string, std::vector<Entry*>> byGenome;
    for (auto& [enc, e] : byEnc)
        byGenome[stalks_tools::genomeKey({e.R, e.D, e.L, e.Tprime})].push_back(&e);
    for (auto& [key, entries] : byGenome) {
        std::stable_sort(entries.begin(), entries.end(),
                          [](const Entry* a, const Entry* b) { return a->lives < b->lives; });
    }

    std::cerr << "distinct single-alpha positions " << byEnc.size() << ", distinct genomes "
              << byGenome.size() << "\n";

    // Lives distribution -- no filtering happens here (this tool always emits the FULL scanned
    // set); a separate downstream step decides what subset actually ships to the Collect pane
    // (see tools/filter_collect_alpha_lives.js). Printed so the full backend data's shape is
    // visible without having to load the (potentially tens-of-MB) JSON just to check it.
    std::map<int, int> livesHist;
    for (const auto& [enc, e] : byEnc) ++livesHist[e.lives];
    std::cerr << "lives distribution:";
    for (const auto& [lives, count] : livesHist) std::cerr << " " << lives << ":" << count;
    std::cerr << "\n";

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    // The Stalks encoding alphabet (letters/digits/'|'/','/'+') never contains a quote or
    // backslash, so enc strings need no JSON escaping.
    //
    // Top-level shape: {"genomes": <same bucket-grouped structure as before, keyed by "(R,D,{L},
    // {T'})">, "byEnc": <every qualifying position ONCE, keyed by its real enc, with its own R/D/L/
    // T'/T -- no T-child ever repeats another position's data inline>}. `byEnc` exists purely so the
    // Collect pane's Advanced-Collection ("!!") check can look up ANY T-child/T-grandchild's own
    // genome by a single map lookup instead of a fresh engine call OR (the first attempt at this)
    // embedding each T-child's data redundantly inline every place it's referenced -- with heavy
    // fan-in among common low-order T-children, that inline approach blew the file up ~1000x (500MB+
    // for what should be a couple MB), so `byEnc` trades a SECOND full-size pass of the same byEnc
    // map (this file's OWN internal structure) for a flat, non-duplicated JSON section instead.
    f << "{\"genomes\":{";
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
                const TChild& t = e.T[j];
                f << "{\"enc\":\"" << t.enc << "\",\"quickEnc\":\"" << t.quick.enc
                  << "\",\"quickOffset\":" << t.quick.offset << "," << kNimberKey << t.nimber << "}";
            }
            f << "]}";
        }
        f << "]";
    }
    f << "},\"byEnc\":{";
    bool firstEnc = true;
    for (const auto& [enc, e] : byEnc) {
        if (!firstEnc) f << ",";
        firstEnc = false;
        f << "\"" << enc << "\":{\"R\":" << e.R << ",\"D\":" << e.D << ",\"L\":[" << setStrBare(e.L)
          << "],\"Tprime\":[" << setStrBare(e.Tprime) << "],\"lives\":" << e.lives << ",\"T\":[";
        for (std::size_t j = 0; j < e.T.size(); ++j) {
            if (j) f << ",";
            const TChild& t = e.T[j];
            f << "{\"enc\":\"" << t.enc << "\",\"quickEnc\":\"" << t.quick.enc
              << "\",\"quickOffset\":" << t.quick.offset << "," << kNimberKey << t.nimber << "}";
        }
        f << "]}";
    }
    f << "}}";

    return 0;
}
