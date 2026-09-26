// Regression check for an Collections registry edit (e.g. removing provably-redundant
// elements per audit_registry_redundancy.cpp's report): for EVERY row of a baseline TSV -- produced
// by running audit_registry_redundancy against the PRE-EDIT build -- re-run quickCanon() on that
// row's own literal element text against the CURRENTLY COMPILED (post-edit) registry, and confirm
// the result is IDENTICAL (same finalRep, same finalOffset) to what the baseline recorded.
//
// This must be run against every ORIGINAL element, not just the ones that survived the edit: a
// removed element's own registry entry is gone, but it must still reduce to the same family+offset
// via whatever OTHER rule the pre-edit audit found firing "instead" -- and that fallback rule might
// itself have been removed in the same edit (two elements can be mutually redundant, each covering
// for the other), which would only show up as a MISMATCH here, not as a crash or an empty result.
// Any mismatch means the edit was not safe as a single monolithic batch -- the mismatched element(s)
// need to be restored (or a still-needed dependency un-removed) and this check re-run, iterating to
// a fixpoint where zero mismatches remain.
//
// Usage: verify_registry_shrink <baseline.tsv>
// Reads the exact TSV shape audit_registry_redundancy.cpp writes (header:
// family\toffset\telement\tfinalRep\tfinalOffset\tstatus\tfiredKeysInstead) -- only the element/
// finalRep/finalOffset columns are used, the rest are carried through for context in mismatch
// output. Exits nonzero if any mismatch is found.
#include "collections.hpp"
#include "position.hpp"
#include "registry_audit_common.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using stalks_tools::splitTsv;
using stalks_tools::tryQuickCanonElement;

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: verify_registry_shrink <baseline.tsv>\n";
        return 1;
    }

    std::ifstream f(argv[1], std::ios::binary);
    if (!f) {
        std::cerr << "cannot open " << argv[1] << "\n";
        return 1;
    }

    std::string header;
    std::getline(f, header);

    long long total = 0, mismatches = 0, errors = 0;
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        const auto cols = splitTsv(line);
        if (cols.size() < 5) continue;
        const std::string& family = cols[0];
        const std::string& element = cols[2];
        const std::string& expectedRep = cols[3];
        const int expectedOffset = std::atoi(cols[4].c_str());

        ++total;
        Position p;
        QuickCanonResult qc;
        std::string errMsg;
        if (!tryQuickCanonElement(element, p, qc, errMsg)) {
            ++errors;
            std::cerr << "PARSE ERROR  " << family << "  " << element << "  (" << errMsg << ")\n";
            continue;
        }
        const std::string actualRep = serialize(qc.rep);
        if (actualRep != expectedRep || qc.offset != expectedOffset) {
            ++mismatches;
            std::cerr << "MISMATCH  " << family << "  " << element << "  expected=[" << expectedRep
                      << "/ offset=" << expectedOffset << "  actual=[" << actualRep
                      << "/ offset=" << qc.offset << "\n";
        }
    }

    std::cerr << "\n" << total << " baseline elements re-checked, " << mismatches << " mismatches, "
              << errors << " parse errors.\n";
    if (mismatches > 0 || errors > 0) {
        std::cerr << "NOT SAFE -- restore the mismatched element(s)' dependency and re-run.\n";
        return 1;
    }
    std::cerr << "SAFE -- every original element still reduces identically.\n";
    return 0;
}
