#pragma once
// Shared plumbing for the Advanced Collections registry audit tools. audit_registry_necessity.cpp,
// audit_registry_redundancy.cpp, and verify_registry_shrink.cpp all read/write the same
// tab-separated baseline format and all parse+quickCanon a raw registry element's literal text the
// same way; find_yellow_candidates.cpp, dump_registry_for_ttree_check.cpp, and check_ttree_extras.cpp
// all agree on the separate "lives\tfamily\tquickEnc\tgenome" yellow-candidate row shape. Factored
// out so a future change to either TSV shape or parse step is made once, not in each tool separately.
#include "collections.hpp"
#include "encoding.hpp"
#include "position.hpp"

#include <string>
#include <vector>

namespace stalks_tools {

// Splits a TSV line into fields, keeping empty trailing fields. Intentionally simple (no quoting) --
// none of these tools' fields can contain a literal tab, since tsvEscape() strips those on write.
std::vector<std::string> splitTsv(const std::string& line);

// Replaces tab/newline/carriage-return with a space so a field can never break the TSV structure.
std::string tsvEscape(const std::string& s);

// Parses a registry element's raw left-side text (as authored in collectionElements.json, no
// enclosing brackets), canonicalizes it, and runs quickCanon() on it. Returns false with errMsg set
// (to the EncodingError's message) on a parse failure, leaving outP/outQc untouched; the caller
// decides how to report/count that failure, since each tool does so differently.
bool tryQuickCanonElement(const std::string& element, stalks::Position& outP,
                           stalks::QuickCanonResult& outQc, std::string& errMsg);

// The TSV header row for the "yellow candidate" shape written by find_yellow_candidates.cpp and
// dump_registry_for_ttree_check.cpp, and read by check_ttree_extras.cpp -- single-sourced here so a
// future column change can't drift between writers and reader (found duplicated three times
// verbatim via code review).
extern const std::string kYellowRowTsvHeader;

// One data row in that same "lives\tfamily\tquickEnc\tgenome\n" shape.
std::string yellowRowTsvLine(int lives, const std::string& family, const std::string& quickEnc,
                              const std::string& genome);

}  // namespace stalks_tools
