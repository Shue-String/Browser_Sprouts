#pragma once
// Double-crit genome assembly, built on top of alpha_genome.hpp's (now target-parametrized)
// single-crit machinery. See double_crit_probe.cpp's own doc comment for the (mt1,mt2) bucket
// mapping this implements and how it was validated against real engine output before being
// hard-coded here.
#include "position.hpp"
#include "specfile.hpp"
#include "tokens.hpp"

#include <optional>
#include <set>
#include <string>
#include <vector>

namespace stalks_tools {

// One child move of a two-crit position, classified for BOTH crits (moves.hpp's
// specialPointMovetypes always returns an entry per special-point token present in the parent, so
// mt1/mt2 are populated for every child of a genuine two-crit position -- see that function's own
// doc comment). Shared by double_crit_probe.cpp's raw dump and classifyDoubleCritGenome's bucketing
// so the classification loop itself is written once, not duplicated between the two.
struct DoubleCritChild {
    stalks::Position child;
    int mt1 = -1;
    int mt2 = -1;
    bool hasValue = false;
    stalks::SpecValue value;
};

std::vector<DoubleCritChild> classifyDoubleCritChildren(const stalks::Position& p, const stalks::SpecDB& db,
                                                          stalks::Token tok1, stalks::Token tok2);

// The double-crit genome's 16 direct/recursive slots for `p` (a position with exactly `tok1` and
// `tok2` as its two live crits), per the (mt1,mt2) bucket mapping:
//   (1,1)->RR (2,2)->DD (3,3)->LL (4,4)->T'T' (1,2)->RaDb (2,1)->RbDa (3,4)->LaT'b (4,3)->LbT'a
//     -- direct SpecValue nimbers (scalars warn on conflicting values, matching classifyAlphaGenome's
//        own R/D-conflict warning; LL/T'T'/LaT'b/LbT'a collect as sets).
//   (1,5)->Ra (5,1)->Rb (2,5)->Da (5,2)->Db (3,5)->La (5,3)->Lb (4,5)->T'a (5,4)->T'b
//     -- recursive SINGLE-crit genome text (fullGenomeText with `target` = whichever of tok1/tok2
//        stayed at movetype 5/untouched), since exactly one crit was resolved away and the other
//        remains live; Ra/Rb/Da/Db are single values, La/Lb/T'a/T'b sets (mirrors the direct-value
//        genes' own scalar-vs-set split one level up).
//   (5,5)->T(p) member -- recursive FULL double-crit genome text (both crits still live), depth-
//        capped like alpha_genome.cpp's own kMaxFoldDepth: `depth` 0 computes members fully (their
//        own [T(p)] included), `depth` 1 truncates a member's OWN T(p) fold to the bare 16-slot core.
// Any (mt1,mt2) pair not listed above is dropped silently by THIS struct (no field to hold it) --
// doubleCritGenomeText's caller-facing text instead reports such a case explicitly via
// classifyDoubleCritChildren, so an unmapped combination is visible, not silently lost.
struct DoubleCritGenome {
    std::optional<int> RR, DD, RaDb, RbDa;
    std::set<int> LL, TprimeTprime, LaTprimeB, LbTprimeA;
    std::optional<std::string> gRa, gRb, gDa, gDb;
    std::set<std::string> gLa, gLb, gTprimeA, gTprimeB;
    std::set<std::string> Tp;
};

DoubleCritGenome classifyDoubleCritGenome(const stalks::Position& p, const stalks::SpecDB& db,
                                           stalks::Token tok1, stalks::Token tok2, int depth = 0);

// "(RR,DD,{LL},{T'T'},RaDb,RbDa,{LaT'b},{LbT'a},gRa,gRb,gDa,gDb,{gLa},{gLb},{gT'a},{gT'b},[T(p)])" --
// a missing scalar slot (no child ever hit that bucket) prints as "?", matching no existing
// convention exactly since single-crit R/D are never actually absent in practice; kept explicit
// here rather than defaulting to 0, which would be indistinguishable from a genuine nimber-0.
std::string doubleCritGenomeText(const stalks::Position& p, const stalks::SpecDB& db,
                                  stalks::Token tok1, stalks::Token tok2, int depth = 0);

}  // namespace stalks_tools
