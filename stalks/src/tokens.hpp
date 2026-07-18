#pragma once
#include <compare>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <iosfwd>
#include <stdexcept>
#include <string>

namespace stalks {

// Token values match their encoding digits exactly.
using Token = std::uint8_t;

// A Bnd is a std::basic_string of Tokens so boundary code can use the full string API (rotation
// by concatenation, substr, ordered comparison). std::basic_string requires a char_traits, and
// the standard only guarantees char_traits for the character types (char, wchar_t, char8_t, ...);
// std::char_traits<std::uint8_t> is an MSVC-only extension and is absent under Clang/libc++ (the
// Emscripten/WASM build). This program-defined traits makes Bnd portable across both compilers
// while preserving identical semantics (ordinary byte comparison).
struct TokenTraits {
    using char_type = Token;
    using int_type = int;
    using off_type = std::streamoff;
    using pos_type = std::streampos;
    using state_type = std::mbstate_t;
    using comparison_category = std::strong_ordering;

    static constexpr void assign(char_type& a, const char_type& b) noexcept { a = b; }
    static constexpr bool eq(char_type a, char_type b) noexcept { return a == b; }
    static constexpr bool lt(char_type a, char_type b) noexcept { return a < b; }

    static constexpr int compare(const char_type* a, const char_type* b, std::size_t n) {
        for (std::size_t i = 0; i < n; ++i) {
            if (lt(a[i], b[i])) return -1;
            if (lt(b[i], a[i])) return 1;
        }
        return 0;
    }
    static constexpr std::size_t length(const char_type* s) {
        std::size_t n = 0;
        while (!eq(s[n], char_type())) ++n;
        return n;
    }
    static constexpr const char_type* find(const char_type* s, std::size_t n, const char_type& a) {
        for (std::size_t i = 0; i < n; ++i)
            if (eq(s[i], a)) return s + i;
        return nullptr;
    }
    static char_type* move(char_type* dst, const char_type* src, std::size_t n) {
        return n == 0 ? dst : static_cast<char_type*>(std::memmove(dst, src, n));
    }
    static char_type* copy(char_type* dst, const char_type* src, std::size_t n) {
        return n == 0 ? dst : static_cast<char_type*>(std::memcpy(dst, src, n));
    }
    static char_type* assign(char_type* s, std::size_t n, char_type a) {
        for (std::size_t i = 0; i < n; ++i) s[i] = a;
        return s;
    }
    static constexpr int_type not_eof(int_type c) noexcept { return c == eof() ? 0 : c; }
    static constexpr char_type to_char_type(int_type c) noexcept { return static_cast<char_type>(c); }
    static constexpr int_type to_int_type(char_type c) noexcept { return static_cast<int_type>(c); }
    static constexpr bool eq_int_type(int_type a, int_type b) noexcept { return a == b; }
    static constexpr int_type eof() noexcept { return -1; }
};

constexpr Token SPOT       = 0;  // spot (degree 0)
constexpr Token APPE       = 1;  // appendage (degree 1)
constexpr Token SCAB       = 2;  // scab (decayed point or distal)
constexpr Token DISA       = 3;  // DisaPoint      (compressed pseudo-point)
constexpr Token HOLL       = 4;  // hollow point   (compressed pseudo-point)
constexpr Token SPLIT      = 5;  // split point    (compressed pseudo-point)
constexpr Token TRIP       = 6;  // triplet        (compressed pseudo-point)
constexpr Token JOINTSTART = 7;  // joint, first visit on the walk
constexpr Token JOINTEND   = 8;  // joint, second visit
constexpr Token MEMB       = 9;  // membrane; cross-region identity lives in Component::pairings

// A boundary: the walk around one side of a connected edge set. Joints are stored
// positionally in Dyck form (JOINTSTART on first visit, JOINTEND on second).
using Bnd = std::basic_string<Token, TokenTraits>;

constexpr bool isPseudo(Token t) { return t >= DISA && t <= TRIP; }
constexpr bool isJoint(Token t)  { return t == JOINTSTART || t == JOINTEND; }

// Doubled lives (2L) contributed by one token. Membranes are half-lives, hence the
// doubling. Pseudo-points count their full organ (interior included), matching the old
// program's totalConnections accounting.
constexpr int lives2(Token t) {
    switch (t) {
        case SPOT:       return 6;
        case APPE:       return 4;
        case SCAB:       return 2;
        case DISA:       return 4;  // membrane (2) + interior scab (2)
        case HOLL:       return 4;  // two membranes
        case SPLIT:      return 6;  // three membranes
        case TRIP:       return 6;  // three membranes
        case JOINTSTART: return 2;  // the joint is counted once, on its first visit
        case JOINTEND:   return 0;
        case MEMB:       return 1;  // half here, half on the other side
        default:         return 0;
    }
}

class EncodingError : public std::runtime_error {
public:
    explicit EncodingError(const std::string& msg) : std::runtime_error(msg) {}
};

} // namespace stalks
