// TRUE leave-one-out necessity audit -- the correct successor to audit_registry_redundancy.cpp's
// "does this element's own key fire when present" heuristic, which turned out to have a real blind
// spot: when an element's own registry entry AND an equally-valid alternate reduction (via some
// other, smaller already-registered shape) both exist, quickCanon()'s step-priority ordering means
// whichever is found first wins -- so "own key fires" only proves the own entry WON that race, not
// that it was NEEDED to win it. Confirmed empirically 2026-09-18: S_2's "Aa|1,3,A" fired its own
// multi-region entry every time with that entry present, yet reduced to the IDENTICAL (rep, offset)
// via S_1's much simpler "1,3,a" the moment its own entry was excluded.
//
// For each row of an audit_registry_redundancy-shaped baseline TSV (family, offset, element,
// finalRep, finalOffset, status, firedKeysInstead -- only element/finalRep/finalOffset are used),
// this tool sets that element's own key EXCLUDED (collections.hpp's setExcludedRegistryKey -- a
// testing-only hook that makes quickCanon()'s registry steps skip a match against that one specific
// entry, falling through to whatever else would apply, with NO rebuild needed per candidate) and
// re-runs quickCanon(). If the result is UNCHANGED, the element's own registry entry is provably
// unnecessary -- some other already-registered rule reduces it identically whether or not this
// entry exists. If the result changes (or the position no longer fully reduces to a registered
// form), the entry is genuinely load-bearing.
//
// Usage: audit_registry_necessity <baseline.tsv> [out.tsv]
// Default output path: "registry_necessity_audit.tsv". Prints a running summary to stderr.
#include "collections.hpp"
#include "position.hpp"
#include "registry_audit_common.hpp"

#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using namespace stalks;
using stalks_tools::splitTsv;
using stalks_tools::tryQuickCanonElement;
using stalks_tools::tsvEscape;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: audit_registry_necessity <baseline.tsv> [out.tsv]\n";
        return 1;
    }
    const std::string outPath = argc >= 3 ? argv[2] : "registry_necessity_audit.tsv";

    std::ifstream in(argv[1], std::ios::binary);
    if (!in) {
        std::cerr << "cannot open " << argv[1] << "\n";
        return 1;
    }
    std::ofstream out(outPath, std::ios::binary);
    if (!out) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    out << "family\toffset\telement\texpectedRep\texpectedOffset\tstillNecessary\twithoutOwnEntryRep\twithoutOwnEntryOffset\n";

    std::string header;
    std::getline(in, header);

    long long total = 0, stillNecessary = 0, alsoRedundant = 0, errors = 0;
    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        const auto cols = splitTsv(line);
        if (cols.size() < 5) continue;
        const std::string& family = cols[0];
        const std::string& offsetCol = cols[1];
        const std::string& element = cols[2];
        const std::string& expectedRep = cols[3];
        const int expectedOffset = std::atoi(cols[4].c_str());

        ++total;
        const std::string ownKey = "[" + element + "/";
        setExcludedRegistryKey(ownKey);
        Position p;
        QuickCanonResult qc;
        std::string errMsg;
        const bool parseOk = tryQuickCanonElement(element, p, qc, errMsg);
        setExcludedRegistryKey("");  // always clear before the next iteration

        if (!parseOk) {
            ++errors;
            std::cerr << "PARSE ERROR  " << family << "  " << element << "  (" << errMsg << ")\n";
            continue;
        }

        const std::string actualRep = serialize(qc.rep);
        const bool matches = (actualRep == expectedRep && qc.offset == expectedOffset);

        out << family << "\t" << offsetCol << "\t" << tsvEscape(element) << "\t" << tsvEscape(expectedRep)
            << "\t" << expectedOffset << "\t" << (matches ? "NO -- also redundant" : "YES") << "\t"
            << tsvEscape(actualRep) << "\t" << qc.offset << "\n";

        if (matches) {
            ++alsoRedundant;
            std::cerr << "ALSO REDUNDANT  " << family << "  " << element << "  (still reduces to ["
                      << expectedRep << "/ offset=" << expectedOffset << " without its own entry)\n";
        } else {
            ++stillNecessary;
        }
    }

    std::cerr << "\n" << total << " elements leave-one-out tested: " << stillNecessary
              << " genuinely necessary, " << alsoRedundant << " ALSO redundant (own-key-fires was a"
              << " false negative), " << errors << " parse errors.\nwrote " << outPath << "\n";
    return 0;
}
