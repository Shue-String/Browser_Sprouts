// Offline audit tool: of every single-subposition (minimal), single-alpha left side reachable
// from the given .spec file(s) -- the same population collect_alpha_genetics.cpp scans -- report
// which QUICK-CANON left sides, grouped by LEFT-SIDE lives count (leftSideLives2()/2, see
// tokens.hpp, computed on the quick-canon rep itself), are NOT recognized by any registered
// Advanced Collection (collections.cpp's singleCritFamilies/doubleCritFamilies/multiCritFamilies,
// exposed via allCollectionRosters()).
//
// Identity is the quick-canon rep, NOT the raw structural encoding: every candidate is run through
// quickCanon (crit-cell/scab-cell congruity, the registry swaps, DisaPoint compression, to a
// fixpoint -- see collections.cpp) and DEDUPED/DISPLAYED by quickCanon(p).rep's own serialization.
// This is deliberate, not just a display choice: many distinct raw structural encodings -- in
// particular multi-region ones -- are already crit-cell/scab-cell-congruent to a SIMPLER shape (or
// to each other) even when that simpler shape isn't itself a NAMED collection; showing the raw
// structural form would print each of those as its own seemingly-independent "unregistered"
// left side, when they are in fact the exact same quick-canon left side spelled differently (or a
// redundant unmerged/decompressed variant of something else already in the list). Deduping by the
// quick-canon rep collapses all of that down to the one shape that's ACTUALLY missing from the
// registry.
//
// "Recognized" is decided the same way the real engine decides it: a left side counts as "in a
// collection" if quickCanon(p)'s result serializes to the SAME string as one of the registered
// families' own rep (substituting the rep's single crit port for ALPHA, then running it through
// quickCanon too -- exactly how a real single-alpha position is built and compared elsewhere in
// this codebase). This also correctly credits a left side that already unconditionally serializes
// to a rep's own shape (the family's head element itself, deliberately excluded from its own
// registry per collections.cpp's doc comment) as "in" that collection, without needing a second
// special case: quickCanon on an already-rep-shaped position simply doesn't change it, so its
// result still matches the rep set.
//
// Double-crit reps (S_3/S_4's "2ba") are skipped when building the rep set: they require two
// distinct crit ports, which no single-alpha position (exactly one special-point token) can ever
// supply, so they can never match here.
//
// The genome column is still classified on one of the RAW structural variants that reduces to this
// quick-canon shape (whichever the scan happens to encounter, since a quick-canon rep's own move
// graph generally isn't reachable in `db` -- see collect_alpha_genetics.cpp's own doc comment: a
// quick-canon rep is only proven nimber-equivalent to the real position, not proven to share its
// genome under movetype classification).
//
// Usage: unregistered_left_sides <out_dir> <spec1.spec> [spec2.spec ...]
// Writes <out_dir>/unregistered_1_life.txt .. unregistered_4_life.txt.

#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

using namespace stalks;

namespace {

// Same filter as collect_alpha_genetics.cpp: exactly one special-point character, and it's alpha.
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

// Index of the character matching the bracket/paren opened at `open` (one of '(','['), tracking
// combined depth across both delimiter kinds (well-nested by construction, so simple aggregate
// depth is sufficient -- see fullGenomeText's own doc comment on the "(R,D,{L},{T'},[T])" shape).
std::size_t matchingClose(const std::string& s, std::size_t open) {
    int depth = 0;
    for (std::size_t i = open; i < s.size(); ++i) {
        const char c = s[i];
        if (c == '(' || c == '[') {
            ++depth;
        } else if (c == ')' || c == ']') {
            --depth;
            if (depth == 0) return i;
        }
    }
    return std::string::npos;
}

// A genome text's own top-level [T] entries -- e.g. "(0,3,{0},{},[C_3,C_4,S_1\xe2\x8a\x951])" ->
// {"C_3","C_4","S_1\xe2\x8a\x951"} -- each either a folded name (alpha_genome.cpp's namedGenomes())
// or, when unrecognized, a full nested "(...)" tuple in its own right. The outer '[' is always the
// FIRST '[' in the text (fullGenomeText's shape puts {L}/{T'} -- digits and commas only, no brackets
// -- before it), so locating it doesn't need to worry about a deeper child's own "[T]" bracket
// appearing earlier. Splits the bracket's inner text on top-level commas only (tracking combined
// paren/bracket/brace depth), so a comma INSIDE a child tuple's own {L}/{T'}/[T] never splits it.
// Returns {} for "(unclassified)" or any text with no bracket at all.
std::vector<std::string> topLevelTChildren(const std::string& genomeText) {
    const auto open = genomeText.find('[');
    if (open == std::string::npos) return {};
    const std::size_t close = matchingClose(genomeText, open);
    if (close == std::string::npos || close <= open + 1) return {};
    const std::string inner = genomeText.substr(open + 1, close - open - 1);

    std::vector<std::string> out;
    int depth = 0;
    std::size_t start = 0;
    for (std::size_t i = 0; i < inner.size(); ++i) {
        const char c = inner[i];
        if (c == '(' || c == '[' || c == '{') {
            ++depth;
        } else if (c == ')' || c == ']' || c == '}') {
            --depth;
        } else if (c == ',' && depth == 0) {
            out.push_back(inner.substr(start, i - start));
            start = i + 1;
        }
    }
    out.push_back(inner.substr(start));
    return out;
}

// Distinct lowercase crit-port letters ('a'-'z') appearing in a roster's authored left-side text.
int distinctPortLetters(const std::string& s) {
    std::set<char> letters;
    for (char ch : s)
        if (ch >= 'a' && ch <= 'z')
            letters.insert(ch);
    return static_cast<int>(letters.size());
}

// The canonical serialized form of every single-crit family's own rep, built by substituting the
// rep's one crit port with the real ALPHA token and running it through quickCanon -- i.e. exactly
// the form a genuine member of that family reduces to under quickCanon.
//
// MUST be quickCanon, not plain canonicalize(): canonicalize() unconditionally DEcompresses any
// DisaPoint/Hollow/Split/Triplet token already present in its input before recompressing
// structural-only (see collections.cpp's own doc comment on this), so a rep that is ITSELF written
// with a compressed token -- "3a" (C_3), "4a" (C_4), "34a" (S_9) -- would canonicalize() back to
// its decompressed multi-region expansion instead of staying "3a"/"4a"/"34a". quickCanon's own
// final step DOES recompress (applyDisaPoints), and a position already in rep form is a fixpoint
// for it (verified: quickCanon("[3a]") == "3a"), so this matches what qc.rep actually equals for a
// genuine member.
std::set<std::string> buildRepCanonSet() {
    std::set<std::string> out;
    for (const CollectionRoster& r : allCollectionRosters()) {
        if (r.rep.empty()) continue;               // shares a sibling's rep; already covered by it
        if (distinctPortLetters(r.rep) != 1) continue;  // double-crit rep; can't match a single-alpha
        const QuickCanonResult qc = quickCanon(parsePosition("[" + r.rep + "]"));
        out.insert(serialize(qc.rep));
    }
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: unregistered_left_sides <out_dir> <spec1.spec> [spec2.spec ...]\n";
        return 1;
    }
    const std::string outDir = argv[1];
    const std::set<std::string> repCanon = buildRepCanonSet();
    std::cerr << "rep set: " << repCanon.size() << " distinct canonical forms\n";

    std::set<std::string> seenQuickEnc;  // dedup by quick-canon identity, across files/spec-nodes
    // lives -> (quickEnc, genome key) rows; sorted by genome just before writing.
    std::map<int, std::vector<std::pair<std::string, std::string>>> unregistered;
    std::map<int, long long> totalByLives;

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
            if (scanned % 500000 == 0) { std::cerr << "  ..." << scanned << "/" << db.size() << "\n"; std::cerr.flush(); }
            if (!isSingleAlpha(node.enc)) continue;

            Position pBase;
            try {
                // pBase mirrors collect_alpha_genetics.cpp exactly (base structural canon --
                // DisaPoints stay decompressed): the movetype classification below
                // (classifyAlphaGenome/childrenAllWithMoveTag) is only known-correct on that form,
                // since it's the only form the engine's own genome tool ever runs it on.
                pBase = canonicalize(parsePosition(node.enc));
            } catch (const EncodingError&) {
                continue;
            }
            if (!hasSpecialPoint(pBase)) continue;  // defensive, mirrors collect_alpha_genetics.cpp

            // Identity is the quick-canon rep (see this file's top-of-file doc comment) -- quickCanon's
            // own final step is DisaPoint compression, applied until a fixpoint, so qc.rep is
            // already maximally reduced/compressed; no separate canonicalizeFull() call is needed.
            const QuickCanonResult qc = quickCanon(pBase);
            const std::string quickEnc = serialize(qc.rep);
            if (!seenQuickEnc.insert(quickEnc).second) continue;  // already handled (via an earlier node)
            ++qualifying;

            const int lives = qc.rep.leftSideLives2() / 2;
            if (lives < 1 || lives > 4) continue;
            ++totalByLives[lives];

            const bool inCollection = repCanon.count(quickEnc) > 0;
            if (inCollection) continue;

            unregistered[lives].push_back({quickEnc, stalks_tools::fullGenomeText(pBase, db)});
        }
        std::cerr << "  scanned " << scanned << ", qualifying single-alpha " << qualifying << "\n";
    }

    std::filesystem::create_directories(outDir);
    // Tally of every top-level T-subgenome entry (topLevelTChildren) seen across ALL unregistered
    // rows, all lives buckets combined -- which genomes recur most often as T-children of an
    // otherwise-unregistered shape is a direct signal for which family to register next (a T-child
    // that's already a folded name like "C_3" means the PARENT shape is new but built from familiar
    // pieces; a raw unfolded tuple means even the T-child itself isn't recognized yet).
    std::map<std::string, long long> tSubgenomeCounts;
    for (int lives = 1; lives <= 4; ++lives) {
        const std::string path = outDir + "/unregistered_" + std::to_string(lives) +
                                  (lives == 1 ? "_life" : "_lives") + ".txt";
        std::ofstream f(path, std::ios::binary);
        if (!f) {
            std::cerr << "cannot open output file: " << path << "\n";
            return 1;
        }
        auto& bucket = unregistered[lives];
        std::sort(bucket.begin(), bucket.end(),
                  [](const auto& a, const auto& b) {
                      return a.second != b.second ? a.second < b.second : a.first < b.first;
                  });
        f << "enc\tgenome\n";
        for (const auto& [enc, genome] : bucket) {
            f << enc << "\t" << genome << "\n";
            for (const std::string& t : topLevelTChildren(genome))
                ++tSubgenomeCounts[t];
        }
        std::cerr << lives << " life: " << bucket.size() << " unregistered / "
                  << totalByLives[lives] << " total single-alpha left sides -- wrote " << path << "\n";
    }

    const std::string countsPath = outDir + "/t_subgenome_counts.csv";
    std::ofstream cf(countsPath, std::ios::binary);
    if (!cf) {
        std::cerr << "cannot open output file: " << countsPath << "\n";
        return 1;
    }
    std::vector<std::pair<std::string, long long>> counted(tSubgenomeCounts.begin(),
                                                             tSubgenomeCounts.end());
    std::sort(counted.begin(), counted.end(), [](const auto& a, const auto& b) {
        return a.second != b.second ? a.second > b.second : a.first < b.first;
    });
    cf << "count,genome\n";
    for (const auto& [genome, count] : counted)
        cf << count << ",\"" << genome << "\"\n";
    std::cerr << "wrote " << counted.size() << " distinct T-subgenomes (" << countsPath << ")\n";

    return 0;
}
