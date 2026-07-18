#pragma once
#include <string>

namespace stalks {

// Escape and append a JSON string literal (encodings are plain ASCII, but escape
// defensively). Shared by every hand-rolled JSON writer in this codebase.
inline void jsonStr(std::string& out, const std::string& s) {
    out += '"';
    for (char c : s) {
        if (c == '"' || c == '\\')
            out += '\\';
        out += c;
    }
    out += '"';
}

}  // namespace stalks
