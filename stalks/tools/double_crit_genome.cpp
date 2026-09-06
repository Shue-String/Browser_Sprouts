#include "double_crit_genome.hpp"

#include "alpha_genome.hpp"
#include "canon.hpp"
#include "encoding.hpp"
#include "moves.hpp"

#include <iostream>

using namespace stalks;

namespace stalks_tools {

namespace {

std::string intSetText(const std::set<int>& s) {
    std::string out;
    bool first = true;
    for (int v : s) {
        if (!first) out += ",";
        first = false;
        out += std::to_string(v);
    }
    return out;
}

std::string strSetText(const std::set<std::string>& s) {
    std::string out;
    bool first = true;
    for (const auto& v : s) {
        if (!first) out += ",";
        first = false;
        out += v;
    }
    return out;
}

// Accumulates a scalar bucket (RR/DD/RaDb/RbDa), warning on conflicting values across multiple
// children in the same bucket -- mirrors classifyAlphaGenome's own R/D-conflict warning exactly.
void accumulateScalar(std::optional<int>& slot, int nimber, const char* label, const std::string& posText) {
    if (slot.has_value() && *slot != nimber)
        std::cerr << "  warning: multiple distinct " << label << " values for " << posText << "\n";
    slot = nimber;
}

void accumulateGenomeScalar(std::optional<std::string>& slot, const std::string& text, const char* label,
                             const std::string& posText) {
    if (slot.has_value() && *slot != text)
        std::cerr << "  warning: multiple distinct " << label << " genomes for " << posText << "\n";
    slot = text;
}

}  // namespace

std::vector<DoubleCritChild> classifyDoubleCritChildren(const Position& p, const SpecDB& db, Token tok1,
                                                          Token tok2) {
    const Position d = p.decompressed();
    std::vector<DoubleCritChild> out;
    for (const auto& [child, tag] : childrenAllWithMoveTag(p)) {
        const EdgeTag et = edgeTagFromMoveTag(d, tag);
        const auto sparse = specialPointMovetypes(p, et, child);
        DoubleCritChild dc;
        dc.child = child;
        for (const auto& [tok, mt] : sparse) {
            if (tok == tok1) dc.mt1 = mt;
            if (tok == tok2) dc.mt2 = mt;
        }
        SpecValue val;
        dc.hasValue = db.value(child, val);
        dc.value = val;
        out.push_back(std::move(dc));
    }
    return out;
}

DoubleCritGenome classifyDoubleCritGenome(const Position& p, const SpecDB& db, Token tok1, Token tok2,
                                           int depth) {
    constexpr int kMaxFoldDepth = 2;  // matches alpha_genome.cpp's own single-crit constant
    const std::string posText = serialize(p);
    DoubleCritGenome g;

    for (const DoubleCritChild& c : classifyDoubleCritChildren(p, db, tok1, tok2)) {
        const auto pair = [&](int a, int b) { return c.mt1 == a && c.mt2 == b; };

        if (pair(1, 1) || pair(2, 2) || pair(1, 2) || pair(2, 1)) {
            if (!c.hasValue) {
                std::cerr << "  warning: child of " << posText << " not found in graph, skipping\n";
                continue;
            }
            if (pair(1, 1)) accumulateScalar(g.RR, c.value.nimber, "RR", posText);
            else if (pair(2, 2)) accumulateScalar(g.DD, c.value.nimber, "DD", posText);
            else if (pair(1, 2)) accumulateScalar(g.RaDb, c.value.nimber, "RaDb", posText);
            else accumulateScalar(g.RbDa, c.value.nimber, "RbDa", posText);
        } else if (pair(3, 3) || pair(4, 4) || pair(3, 4) || pair(4, 3)) {
            if (!c.hasValue) {
                std::cerr << "  warning: child of " << posText << " not found in graph, skipping\n";
                continue;
            }
            if (pair(3, 3)) g.LL.insert(c.value.nimber);
            else if (pair(4, 4)) g.TprimeTprime.insert(c.value.nimber);
            else if (pair(3, 4)) g.LaTprimeB.insert(c.value.nimber);
            else g.LbTprimeA.insert(c.value.nimber);
        } else if (pair(1, 5)) {
            accumulateGenomeScalar(g.gRa, fullGenomeText(c.child, db, tok2), "Ra", posText);
        } else if (pair(5, 1)) {
            accumulateGenomeScalar(g.gRb, fullGenomeText(c.child, db, tok1), "Rb", posText);
        } else if (pair(2, 5)) {
            accumulateGenomeScalar(g.gDa, fullGenomeText(c.child, db, tok2), "Da", posText);
        } else if (pair(5, 2)) {
            accumulateGenomeScalar(g.gDb, fullGenomeText(c.child, db, tok1), "Db", posText);
        } else if (pair(3, 5)) {
            g.gLa.insert(fullGenomeText(c.child, db, tok2));
        } else if (pair(5, 3)) {
            g.gLb.insert(fullGenomeText(c.child, db, tok1));
        } else if (pair(4, 5)) {
            g.gTprimeA.insert(fullGenomeText(c.child, db, tok2));
        } else if (pair(5, 4)) {
            g.gTprimeB.insert(fullGenomeText(c.child, db, tok1));
        } else if (pair(5, 5)) {
            // Only recurse while still below the fold cap -- at/past it, doubleCritGenomeText
            // won't print a [T(p)] list at this depth anyway (see its own depth check below), so
            // computing entries for it would be pure waste, exactly mirroring alpha_genome.cpp's
            // genomeTextAt early-return (which never even calls tChildrenOf at max depth).
            if (depth < kMaxFoldDepth)
                g.Tp.insert(doubleCritGenomeText(canonicalize(c.child), db, tok1, tok2, depth + 1));
        } else {
            std::cerr << "  warning: UNMAPPED (mt1=" << c.mt1 << ",mt2=" << c.mt2 << ") child of "
                      << posText << " -- not folded into any genome slot\n";
        }
    }

    return g;
}

std::string doubleCritGenomeText(const Position& p, const SpecDB& db, Token tok1, Token tok2, int depth) {
    constexpr int kMaxFoldDepth = 2;
    const DoubleCritGenome g = classifyDoubleCritGenome(p, db, tok1, tok2, depth);

    auto scalarText = [](const std::optional<int>& v) { return v.has_value() ? std::to_string(*v) : "?"; };
    auto genomeScalarText = [](const std::optional<std::string>& v) { return v.has_value() ? *v : "?"; };

    std::string head = "(" + scalarText(g.RR) + "," + scalarText(g.DD) + ",{" + intSetText(g.LL) + "},{" +
                        intSetText(g.TprimeTprime) + "}," + scalarText(g.RaDb) + "," + scalarText(g.RbDa) +
                        ",{" + intSetText(g.LaTprimeB) + "},{" + intSetText(g.LbTprimeA) + "}," +
                        genomeScalarText(g.gRa) + "," + genomeScalarText(g.gRb) + "," +
                        genomeScalarText(g.gDa) + "," + genomeScalarText(g.gDb) + ",{" +
                        strSetText(g.gLa) + "},{" + strSetText(g.gLb) + "},{" + strSetText(g.gTprimeA) +
                        "},{" + strSetText(g.gTprimeB) + "}";

    if (depth >= kMaxFoldDepth) return head + ")";
    return head + ",[" + strSetText(g.Tp) + "])";
}

}  // namespace stalks_tools
