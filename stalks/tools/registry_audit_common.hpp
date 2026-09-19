#pragma once
// Shared plumbing for the Advanced Collections registry audit tools (audit_registry_necessity.cpp,
// audit_registry_redundancy.cpp, verify_registry_shrink.cpp), which all read/write the same
// tab-separated baseline format and all parse+quickCanon a raw registry element's literal text the
// same way. Factored out so a future change to that TSV shape or parse step is made once, not in
// each tool separately.
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

}  // namespace stalks_tools
