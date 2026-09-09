#pragma once
#include <string>

namespace stalks {

// JSON object-key literals shared by every hand-rolled writer that emits these particular fields
// (analyze.cpp, dump_master_meta.cpp, collect_alpha_genetics.cpp). Centralized so a typo in one
// occurrence can't silently diverge from the frontend's parsing of these exact key names
// (positionCache.ts's AnalysisOk/LightMeta shapes) -- json_util.hpp's jsonStr() only escapes
// *values*, nothing protected key names before this.
constexpr const char* kNimberKey = "\"nimber\":";
constexpr const char* kMinMovesKey = "\"minMoves\":";
constexpr const char* kMaxMovesKey = "\"maxMoves\":";
constexpr const char* kSubposCountKey = "\"subposCount\":";

// Appends `,"key":` to `out`, or just `"key":` when `firstField` (this is the object's opening
// field, so no separator comma is needed).
inline void appendKey(std::string& out, const char* key, bool firstField = false) {
    if (!firstField) out += ',';
    out += key;
}

}  // namespace stalks
