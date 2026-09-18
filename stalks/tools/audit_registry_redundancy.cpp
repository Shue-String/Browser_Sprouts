// Offline audit: for every currently-registered Advanced Collection element (single/double/multi),
// reduce its OWN literal authored text via quickCanon()'s traced fixpoint and check whether its OWN
// registry entry ever actually fires. quickReductionCounts() (collections.hpp) records exactly
// which key fired each reduction round, keyed by "[" + <registered element's raw text> + "/" for a
// registry swap, or by a structural region key for crit-cell/scab-cell congruity (not tied to any
// roster entry at all) -- see collections.cpp's recordQuickReduction call sites.
//
// If an element's own key never appears among the fired keys, some OTHER rule -- crit-cell/scab-cell
// congruity, or a DIFFERENT (typically smaller/more fundamental) family's own registered shape --
// already reduces this element's literal text to the correct final rep+offset before this element's
// own entry ever gets the chance to match. That makes the entry provably redundant: quickCanon()
// would produce the identical result with this entry deleted from the registry, for this literal
// input (the only input that could ever exercise it, since matching requires exact structural
// equality to the authored text up to canon). This is the automated analogue of the Shue-pairings
// paper's own "^{\dagger}" convention (a position marked as a collapsed form of a simpler one, not a
// distinct identity) -- see project_shue_pairings_extraction memory.
//
// Usage: audit_registry_redundancy [out.tsv]
// Default output path: "registry_redundancy_audit.tsv" in the current directory. Also prints a
// summary to stderr. Purely a report -- never modifies collectionElements.json or collections.cpp;
// per [[feedback_audit_then_execute]], removal of any flagged element is a separate, human-reviewed
// step.
//
// Writes ONE ROW PER REGISTERED ELEMENT (not just flagged ones) -- status column is REDUNDANT or
// OK. This makes the output usable both as a redundancy report AND as a before/after baseline for
// tools/verify_registry_shrink.cpp: run this once against the CURRENT (pre-edit) build to capture
// finalRep/finalOffset for every element, edit the registry, rebuild, then feed the same TSV to
// verify_registry_shrink to confirm every ORIGINAL element -- including ones whose own entry was
// deleted -- still reduces to the identical (finalRep, finalOffset) it did before the edit.
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "position.hpp"

#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using namespace stalks;

namespace {
std::string tsvEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) out += (c == '\t' || c == '\n' || c == '\r') ? ' ' : c;
    return out;
}
}  // namespace

int main(int argc, char** argv) {
    const std::string outPath = argc >= 2 ? argv[1] : "registry_redundancy_audit.tsv";

    const std::vector<CollectionRoster> rosters = allCollectionRosters();

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << "family\toffset\telement\tfinalRep\tfinalOffset\tstatus\tfiredKeysInstead\n";

    long long total = 0, redundant = 0, errors = 0;
    for (const CollectionRoster& r : rosters) {
        for (const std::string& e : r.elements) {
            ++total;
            const std::string ownKey = "[" + e + "/";
            resetQuickReductionCounts();
            Position p;
            QuickCanonResult qc;
            try {
                p = canonicalize(parsePosition("[" + e + "]"));
                qc = quickCanon(p);
            } catch (const EncodingError& ex) {
                ++errors;
                std::cerr << "PARSE ERROR  " << r.name << "  " << e << "  (" << ex.what() << ")\n";
                continue;
            }
            const auto& counts = quickReductionCounts();
            const bool ownFired = counts.count(ownKey) > 0;

            std::string fired;
            for (const auto& [key, cnt] : counts) {
                if (!fired.empty()) fired += "; ";
                fired += key + " x" + std::to_string(cnt);
            }
            if (fired.empty()) fired = "(nothing -- position was already reduced before any step ran)";

            f << r.name << "\t" << r.offset << "\t" << tsvEscape(e) << "\t"
              << tsvEscape(serialize(qc.rep)) << "\t" << qc.offset << "\t"
              << (ownFired ? "OK" : "REDUNDANT") << "\t" << tsvEscape(fired) << "\n";

            if (!ownFired) {
                ++redundant;
                std::cerr << "REDUNDANT  " << r.name << "  " << e << "  ->  fired instead: " << fired << "\n";
            }
        }
    }

    std::cerr << "\n" << total << " registered elements checked, " << redundant
              << " flagged as redundant (own entry never fires), " << errors << " parse errors.\n"
              << "wrote " << outPath << "\n";
    return 0;
}
