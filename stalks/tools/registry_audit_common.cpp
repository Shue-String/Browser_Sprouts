#include "registry_audit_common.hpp"

#include "canon.hpp"
#include "encoding.hpp"
#include "tokens.hpp"

namespace stalks_tools {

std::vector<std::string> splitTsv(const std::string& line) {
    std::vector<std::string> out;
    std::size_t start = 0;
    for (std::size_t i = 0; i <= line.size(); ++i) {
        if (i == line.size() || line[i] == '\t') {
            out.push_back(line.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

std::string tsvEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) out += (c == '\t' || c == '\n' || c == '\r') ? ' ' : c;
    return out;
}

bool tryQuickCanonElement(const std::string& element, stalks::Position& outP,
                           stalks::QuickCanonResult& outQc, std::string& errMsg) {
    try {
        outP = stalks::canonicalize(stalks::parsePosition("[" + element + "]"));
        outQc = stalks::quickCanon(outP);
        return true;
    } catch (const stalks::EncodingError& ex) {
        errMsg = ex.what();
        return false;
    }
}

}  // namespace stalks_tools
