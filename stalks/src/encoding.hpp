#pragma once
#include "position.hpp"

#include <string>
#include <string_view>

namespace stalks {

// Parse a position encoding. Accepts:
//   - digits 0-9 (both base and compression tokens; the parser is mode-agnostic),
//   - A-Z membrane letters (each exactly twice per ⊕-component, in different regions),
//   - bare '9' for membrane-agnostic (unpaired) membranes,
//   - delimiters: '|' between regions, ',' between boundaries, '[' ']' group markers,
//     '⊕' (or ASCII '+') between components,
//   - 'φ' (or ASCII 'N') for a dead component,
//   - boundary duplication '*n' on membrane-free boundaries,
//   - whitespace anywhere (ignored).
// The result is validated. Throws EncodingError.
Position parsePosition(std::string_view text);

// Serialize the internal canonical form. Letters are assigned A, B, C, ... in first-occurrence
// order per component; with agnostic=true, every membrane is written as '9' instead. Components
// are joined with '+' (unambiguous: a component body never contains '+'); a dead component is 'N'.
// No group brackets are emitted -- they carry no information and the parser strips them anyway.
// Display brackets, if wanted, are re-added by the caller when printing to a screen.
std::string serialize(const Component& c, bool agnostic = false);
std::string serialize(const Position& p, bool agnostic = false);

} // namespace stalks
