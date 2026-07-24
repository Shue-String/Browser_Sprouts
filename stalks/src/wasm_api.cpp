// Emscripten/embind entry points for the browser build. Compiled only by build_wasm.bat
// (never by the native CMake target, which does not have <emscripten/bind.h>).
#include "analyze.hpp"
#include "canon.hpp"      // canonicalizeDecompressedTracked
#include "encoding.hpp"   // parsePosition, serialize
#include "moves.hpp"      // enclosureChildTracked / joinChildTracked, Enclosure/Join
#include "tokens.hpp"     // EncodingError
#include "position.hpp"   // Position, CompSrc

#include <emscripten/bind.h>

#include <cctype>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

// analyzeJson never throws (it reports parse/size errors as JSON). canonOnly does throw on a
// malformed encoding; swallow it here so no C++ exception ever crosses into JS.
std::string canonSafe(const std::string& enc) {
    try {
        return stalks::canonOnly(enc);
    } catch (...) {
        return std::string();
    }
}

// --- Minimal nested-integer-array JSON reader ----------------------------------------------
//
// The only structured input applyMoveTracked takes is the parent provenance: a 4-level nested
// array of ints, [component][region][boundary][token], parallel to the parent Position's
// components/regions/boundaries/tokens (i.e. std::vector<stalks::CompSrc>). The engine emits JSON
// by hand and has no parser, so this hand-rolled reader (ints, arrays, whitespace only) covers
// exactly what we need without pulling in a JSON dependency.

struct Cur {
    const std::string& s;
    std::size_t i = 0;
};

void skipWs(Cur& c) {
    while (c.i < c.s.size()) {
        const char ch = c.s[c.i];
        if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r')
            ++c.i;
        else
            break;
    }
}

int readInt(Cur& c) {
    skipWs(c);
    const std::size_t start = c.i;
    if (c.i < c.s.size() && (c.s[c.i] == '-' || c.s[c.i] == '+'))
        ++c.i;
    while (c.i < c.s.size() && std::isdigit(static_cast<unsigned char>(c.s[c.i])))
        ++c.i;
    if (c.i == start || (c.i == start + 1 && !std::isdigit(static_cast<unsigned char>(c.s[start]))))
        throw std::runtime_error("provenance JSON: expected integer");
    return std::stoi(c.s.substr(start, c.i - start));
}

// Read a bracketed array whose elements are produced by `elem`. Handles the empty array.
template <class F>
auto readArray(Cur& c, F elem) -> std::vector<decltype(elem(c))> {
    skipWs(c);
    if (c.i >= c.s.size() || c.s[c.i] != '[')
        throw std::runtime_error("provenance JSON: expected '['");
    ++c.i;
    std::vector<decltype(elem(c))> out;
    skipWs(c);
    if (c.i < c.s.size() && c.s[c.i] == ']') {
        ++c.i;
        return out;
    }
    while (true) {
        out.push_back(elem(c));
        skipWs(c);
        if (c.i >= c.s.size())
            throw std::runtime_error("provenance JSON: unterminated array");
        if (c.s[c.i] == ',') {
            ++c.i;
            continue;
        }
        if (c.s[c.i] == ']') {
            ++c.i;
            break;
        }
        throw std::runtime_error("provenance JSON: expected ',' or ']'");
    }
    return out;
}

std::vector<int> readBnd(Cur& c) { return readArray(c, readInt); }              // [k]
std::vector<std::vector<int>> readReg(Cur& c) { return readArray(c, readBnd); } // [b][k]
stalks::CompSrc readComp(Cur& c) { return readArray(c, readReg); }             // [r][b][k]

std::vector<stalks::CompSrc> parsePosSrc(const std::string& json) {
    Cur c{json};
    auto v = readArray(c, readComp); // [i][r][b][k]
    skipWs(c);
    if (c.i != c.s.size())
        throw std::runtime_error("provenance JSON: trailing characters");
    return v;
}

// --- Nested-integer-array JSON writer (mirror of the reader) -------------------------------
void writeInt(std::string& o, int v) { o += std::to_string(v); }

template <class T, class F>
void writeArray(std::string& o, const std::vector<T>& v, F elem) {
    o += '[';
    for (std::size_t k = 0; k < v.size(); ++k) {
        if (k)
            o += ',';
        elem(o, v[k]);
    }
    o += ']';
}

void writeBnd(std::string& o, const std::vector<int>& v) { writeArray(o, v, writeInt); }
void writeReg(std::string& o, const std::vector<std::vector<int>>& v) { writeArray(o, v, writeBnd); }
void writeComp(std::string& o, const stalks::CompSrc& v) { writeArray(o, v, writeReg); }
void writePosSrc(std::string& o, const std::vector<stalks::CompSrc>& v) { writeArray(o, v, writeComp); }

std::string jsonError(const std::string& reason, const std::string& message) {
    std::string o = "{\"ok\":false,\"reason\":\"";
    o += reason;
    o += "\",\"message\":\"";
    for (char ch : message) {
        if (ch == '"' || ch == '\\')
            o += '\\';
        o += ch;
    }
    o += "\"}";
    return o;
}

// Apply one tracked move to a decompressed parent and return the decompressed-canonical child
// encoding plus provenance, as JSON. `parentEnc` MUST be the decompressed encoding whose token
// walk `psrcJson` is parallel to (no pseudo-points); the frontend maintains that decompressed
// form. `kind` is stalks::MoveKind (0 = Enclosure, 1 = Join). Enclosure reads (region, a=boundary,
// i, j, mask); Join reads (region, a=b1, b=b2, i, j) and ignores mask.
//
// Success shape:  {"ok":true,"enc":"<child>","src":[[[[int...]]]]}
//   `src` is parallel to vector<CompSrc> of the *child*: src[i][r][b][k] is the srcId of the k-th
//   token of boundary b of region r of child component i. Because serialize() emits exactly one
//   character per token (a letter/'9' for a membrane, a digit otherwise) and skips only the
//   ','/'|'/'+' separators, the frontend can zip `src` against `enc` by walking both in the same
//   component/region/boundary/token order. srcId GEN_SRC (-2) marks a generated (new midpoint)
//   token; -1 is untracked; anything else is the caller's parent VertexId.
// Failure shape:  {"ok":false,"reason":"...","message":"..."}.
std::string applyMoveTracked(std::string parentEnc, std::string psrcJson, int kind, int comp,
                             int region, int a, int b, int i, int j, int mask) {
    try {
        const stalks::Position parent = stalks::parsePosition(parentEnc);
        const std::vector<stalks::CompSrc> psrc = parsePosSrc(psrcJson);
        if (comp < 0 || static_cast<std::size_t>(comp) >= parent.components.size())
            return jsonError("bad-move", "component index out of range");
        if (psrc.size() != parent.components.size())
            return jsonError("bad-provenance", "provenance length != component count");

        stalks::TrackedCanon tc;
        if (kind == static_cast<int>(stalks::MoveKind::Enclosure)) {
            stalks::Enclosure m;
            m.region = static_cast<std::uint32_t>(region);
            m.boundary = static_cast<std::uint32_t>(a);
            m.i = i;
            m.j = j;
            m.mask = static_cast<std::uint32_t>(mask);
            tc = stalks::enclosureChildTracked(parent, psrc, static_cast<std::size_t>(comp), m);
        } else if (kind == static_cast<int>(stalks::MoveKind::Join)) {
            stalks::Join m;
            m.region = static_cast<std::uint32_t>(region);
            m.b1 = static_cast<std::uint32_t>(a);
            m.b2 = static_cast<std::uint32_t>(b);
            m.i = i;
            m.j = j;
            tc = stalks::joinChildTracked(parent, psrc, static_cast<std::size_t>(comp), m);
        } else {
            return jsonError("bad-move", "unsupported move kind (expected 0=Enclosure, 1=Join)");
        }

        std::string out = "{\"ok\":true,\"enc\":\"";
        out += stalks::serialize(tc.pos);
        out += "\",\"src\":";
        writePosSrc(out, tc.src);
        out += "}";
        return out;
    } catch (const stalks::EncodingError& e) {
        return jsonError("engine-error", e.what());
    } catch (const std::exception& e) {
        return jsonError("engine-error", e.what());
    } catch (...) {
        return jsonError("engine-error", "unknown");
    }
}

// Canonicalize an already-decompressed encoding (no pseudo-points; see encodePositionDecompressed
// in encoding.ts) and return the canonical form together with provenance tracing each canonical
// token back to its position in the INPUT string. Unlike applyMoveTracked, provenance is seeded
// here rather than supplied by the caller: token k of the input (in component/region/boundary/
// walk order, i.e. the same order serialize() emits characters) is seeded with srcId = k. Pure
// canonicalization never generates or consumes tokens, so every output token traces back to
// exactly one input token -- `src` is always the same length as the number of emitted characters,
// with no GEN_SRC/-1 entries.
//
// Success shape: {"ok":true,"enc":"<canonical>","src":[int,...]} where src[m] is the input-token
// index (0-based, in input walk/char order) that the m-th character of `enc` descends from. The
// frontend zips this against its own per-input-char provenance (e.g. EncodingResult.charInfo) to
// get a canonical-string -> live-vertex binding, without the engine ever seeing a live VertexId.
// Failure shape: {"ok":false,"reason":"...","message":"..."}.
std::string canonicalizeTrackedProvenance(std::string enc) {
    try {
        const stalks::Position p = stalks::parsePosition(enc);

        std::vector<stalks::CompSrc> psrc;
        psrc.reserve(p.components.size());
        int seq = 0;
        for (const auto& comp : p.components) {
            stalks::CompSrc src;
            src.resize(comp.regions.size());
            for (std::size_t r = 0; r < comp.regions.size(); ++r) {
                src[r].resize(comp.regions[r].size());
                for (std::size_t b = 0; b < comp.regions[r].size(); ++b) {
                    const auto& bnd = comp.regions[r][b];
                    src[r][b].resize(bnd.size());
                    for (std::size_t k = 0; k < bnd.size(); ++k)
                        src[r][b][k] = seq++;
                }
            }
            psrc.push_back(std::move(src));
        }

        const stalks::TrackedCanon tc = stalks::canonicalizeDecompressedTracked(p, psrc);

        std::string out = "{\"ok\":true,\"enc\":\"";
        out += stalks::serialize(tc.pos);
        out += "\",\"src\":[";
        bool first = true;
        for (const auto& src : tc.src) {
            for (const auto& reg : src) {
                for (const auto& bnd : reg) {
                    for (int v : bnd) {
                        if (!first)
                            out += ',';
                        first = false;
                        out += std::to_string(v);
                    }
                }
            }
        }
        out += "]}";
        return out;
    } catch (const stalks::EncodingError& e) {
        return jsonError("engine-error", e.what());
    } catch (const std::exception& e) {
        return jsonError("engine-error", e.what());
    } catch (...) {
        return jsonError("engine-error", "unknown");
    }
}

}  // namespace

EMSCRIPTEN_BINDINGS(stalks_module) {
    emscripten::function("analyze", &stalks::analyzeJson);
    emscripten::function("analyzeFull", &stalks::analyzeFullJson);
    emscripten::function("analyzeNimber", &stalks::analyzeNimberJson);
    emscripten::function("childrenTracked", &stalks::childrenTrackedJson);
    emscripten::function("regionMovesTracked", &stalks::regionMovesTrackedJson);
    emscripten::function("allMovesTracked", &stalks::allMovesTrackedJson);
    emscripten::function("canon", &canonSafe);
    emscripten::function("applyMoveTracked", &applyMoveTracked);
    emscripten::function("canonicalizeTrackedProvenance", &canonicalizeTrackedProvenance);
    emscripten::function("decompressed", &stalks::decompressedJson);
}
