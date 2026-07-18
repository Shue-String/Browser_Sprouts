#include "encoding.hpp"

#include <cctype>
#include <map>
#include <set>

namespace stalks {

namespace {

constexpr const char* OPLUS = "\xE2\x8A\x95";  // ⊕ in UTF-8
constexpr const char* PHI = "\xCF\x86";        // φ in UTF-8

// Strip whitespace and group brackets; brackets carry no information in full-position
// encodings (they may wrap the whole string or individual components).
std::string cleaned(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    for (char ch : text) {
        if (std::isspace(static_cast<unsigned char>(ch)) || ch == '[' || ch == ']')
            continue;
        out.push_back(ch);
    }
    return out;
}

std::vector<std::string> splitComponents(const std::string& text) {
    std::vector<std::string> parts;
    std::string cur;
    for (size_t i = 0; i < text.size();) {
        if (text[i] == '+') {
            parts.push_back(cur);
            cur.clear();
            ++i;
        } else if (text.compare(i, 3, OPLUS) == 0) {
            parts.push_back(cur);
            cur.clear();
            i += 3;
        } else {
            cur.push_back(text[i]);
            ++i;
        }
    }
    parts.push_back(cur);
    return parts;
}

std::vector<std::string> split(const std::string& text, char delim) {
    std::vector<std::string> parts;
    std::string cur;
    for (char ch : text) {
        if (ch == delim) {
            parts.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(ch);
        }
    }
    parts.push_back(cur);
    return parts;
}

Component parseComponent(const std::string& text) {
    Component c;
    if (text == PHI || text == "N") {
        c.dead = true;
        return c;
    }

    std::map<char, MRef> open;    // letters awaiting their second occurrence
    std::set<char> closed;        // letters already paired

    const auto regionStrings = split(text, '|');
    for (std::uint32_t r = 0; r < regionStrings.size(); ++r) {
        std::vector<Bnd> region;
        const auto chunks = split(regionStrings[r], ',');
        for (const auto& chunk : chunks) {
            if (chunk.empty())
                throw EncodingError("empty boundary in encoding: '" + text + "'");

            Bnd b;
            std::vector<std::pair<char, std::uint32_t>> letters;  // letter, occ in b
            std::uint32_t membCount = 0;
            long repeat = 1;
            for (size_t i = 0; i < chunk.size(); ++i) {
                const char ch = chunk[i];
                if (ch >= '0' && ch <= '9') {
                    b.push_back(static_cast<Token>(ch - '0'));
                    if (ch == '9')
                        ++membCount;
                } else if (ch >= 'A' && ch <= 'Z') {
                    letters.emplace_back(ch, membCount);
                    b.push_back(MEMB);
                    ++membCount;
                } else if (ch == '*') {
                    repeat = std::strtol(chunk.c_str() + i + 1, nullptr, 10);
                    if (repeat < 1 ||
                        chunk.find_first_not_of("0123456789", i + 1) != std::string::npos)
                        throw EncodingError("bad boundary duplication: '" + chunk + "'");
                    if (membCount > 0)
                        throw EncodingError(
                            "boundary duplication is only allowed on membrane-free "
                            "boundaries: '" + chunk + "'");
                    break;
                } else {
                    throw EncodingError(std::string("unexpected character '") + ch +
                                        "' in encoding");
                }
            }

            const auto boundaryIdx = static_cast<std::uint32_t>(region.size());
            for (long k = 0; k < repeat; ++k)
                region.push_back(b);

            for (const auto& [letter, occ] : letters) {
                const MRef here{r, boundaryIdx, occ};
                if (closed.count(letter))
                    throw EncodingError(std::string("membrane letter '") + letter +
                                        "' appears more than twice");
                auto it = open.find(letter);
                if (it == open.end()) {
                    open.emplace(letter, here);
                } else {
                    c.pairings.push_back({it->second, here});
                    open.erase(it);
                    closed.insert(letter);
                }
            }
        }
        c.regions.push_back(std::move(region));
    }

    if (!open.empty())
        throw EncodingError(std::string("membrane letter '") + open.begin()->first +
                            "' appears only once");
    return c;
}

} // namespace

Position parsePosition(std::string_view text) {
    const std::string body = cleaned(text);
    if (body.empty())
        throw EncodingError("empty encoding");

    Position p;
    for (const auto& part : splitComponents(body))
        p.components.push_back(parseComponent(part));
    p.validate();
    return p;
}

std::string serialize(const Component& c, bool agnostic) {
    if (c.dead)
        return "N";

    const auto pairIdx = c.pairIndex();
    std::vector<char> letterOfPair(c.pairings.size(), 0);
    char next = 'A';

    std::string out;
    for (std::uint32_t r = 0; r < c.regions.size(); ++r) {
        if (r > 0)
            out.push_back('|');
        for (std::uint32_t b = 0; b < c.regions[r].size(); ++b) {
            if (b > 0)
                out.push_back(',');
            std::uint32_t occ = 0;
            for (Token t : c.regions[r][b]) {
                if (t == MEMB) {
                    const int pi = pairIdx[r][b][occ++];
                    if (agnostic || pi < 0) {
                        out.push_back('9');
                    } else {
                        if (letterOfPair[static_cast<size_t>(pi)] == 0) {
                            if (next > 'Z')
                                throw EncodingError(
                                    "more than 26 membranes in one component; extended "
                                    "lettering is not implemented yet");
                            letterOfPair[static_cast<size_t>(pi)] = next++;
                        }
                        out.push_back(letterOfPair[static_cast<size_t>(pi)]);
                    }
                } else {
                    out.push_back(static_cast<char>('0' + t));
                }
            }
        }
    }
    return out;
}

std::string serialize(const Position& p, bool agnostic) {
    if (p.components.empty())
        return "N";
    std::string out;
    for (size_t i = 0; i < p.components.size(); ++i) {
        if (i > 0)
            out += '+';
        out += serialize(p.components[i], agnostic);
    }
    return out;
}

} // namespace stalks
