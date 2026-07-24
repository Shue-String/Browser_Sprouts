// Ad-hoc debug tool: apply ONE tracked move to an already-decompressed position and report
// whether a specific parent token (identified by its (region,boundary,token) index, e.g. the
// critical-membrane occurrence of a DisaPoint) survives into the child -- using the engine's own
// provenance tracking (enclosureChildTracked/joinChildTracked), not hand-derived token surgery.
//
// Usage:
//   explain_move <decompressed-enc> <kind:0=Enclosure|1=Join> <region> <a> <b> <i> <j> <mask> \
//       [--watch region,boundary,token]
//
// For Enclosure: a=boundary, b is ignored, mask is used.
// For Join: a=b1, b=b2, i/j as usual, mask is ignored.
//
// Prints the child's decompressed encoding and, if --watch is given, whether the watched parent
// token's srcId (seeded as its 0-based walk-order index, same convention wasm_api.cpp's
// canonicalizeTrackedProvenance uses) still appears anywhere in the child's provenance.
#include "canon.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "tokens.hpp"

#include <array>
#include <cstdio>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

using namespace stalks;

namespace {

// Seed src[r][b][k] = its 0-based walk-order index (component/region/boundary/token order,
// matching serialize()'s emission order) -- same convention as wasm_api.cpp's
// canonicalizeTrackedProvenance. Also returns the seeded id of the (region,boundary,token) the
// caller asked to watch, if it's in range.
std::vector<CompSrc> seedProvenance(const Position& p, std::optional<std::array<int, 3>> watch,
                                     int* watchIdOut) {
    std::vector<CompSrc> psrc;
    psrc.reserve(p.components.size());
    int seq = 0;
    for (std::size_t ci = 0; ci < p.components.size(); ++ci) {
        const Component& comp = p.components[ci];
        CompSrc src(comp.regions.size());
        for (std::size_t r = 0; r < comp.regions.size(); ++r) {
            src[r].resize(comp.regions[r].size());
            for (std::size_t b = 0; b < comp.regions[r].size(); ++b) {
                const auto& bnd = comp.regions[r][b];
                src[r][b].resize(bnd.size());
                for (std::size_t k = 0; k < bnd.size(); ++k) {
                    if (watch && watchIdOut && static_cast<int>(r) == (*watch)[0] &&
                        static_cast<int>(b) == (*watch)[1] && static_cast<int>(k) == (*watch)[2])
                        *watchIdOut = seq;
                    src[r][b][k] = seq++;
                }
            }
        }
        psrc.push_back(std::move(src));
    }
    return psrc;
}

bool idSurvives(const std::vector<CompSrc>& src, int id) {
    for (const auto& comp : src)
        for (const auto& reg : comp)
            for (const auto& bnd : reg)
                for (int v : bnd)
                    if (v == id) return true;
    return false;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 9) {
        std::cerr << "usage: explain_move <decompressed-enc> <kind> <region> <a> <b> <i> <j> <mask> "
                     "[--watch r,b,t]\n";
        return 1;
    }
    const std::string enc = argv[1];
    const int kind = std::atoi(argv[2]);
    const int region = std::atoi(argv[3]);
    const int a = std::atoi(argv[4]);
    const int b = std::atoi(argv[5]);
    const int i = std::atoi(argv[6]);
    const int j = std::atoi(argv[7]);
    const int mask = std::atoi(argv[8]);

    std::optional<std::array<int, 3>> watch;
    if (argc >= 11 && std::string(argv[9]) == "--watch") {
        std::array<int, 3> w{};
        std::sscanf(argv[10], "%d,%d,%d", &w[0], &w[1], &w[2]);
        watch = w;
    }

    try {
        const Position parent = parsePosition(enc);
        int watchId = -1;
        const std::vector<CompSrc> psrc = seedProvenance(parent, watch, &watchId);

        // Single-component moves only (matches wasm_api.cpp's applyMoveTracked, comp=0 assumed
        // here since that's all we need for this investigation).
        TrackedCanon tc;
        if (kind == static_cast<int>(MoveKind::Enclosure)) {
            Enclosure m;
            m.region = static_cast<std::uint32_t>(region);
            m.boundary = static_cast<std::uint32_t>(a);
            m.i = i;
            m.j = j;
            m.mask = static_cast<std::uint32_t>(mask);
            tc = enclosureChildTracked(parent, psrc, 0, m);
        } else {
            Join m;
            m.region = static_cast<std::uint32_t>(region);
            m.b1 = static_cast<std::uint32_t>(a);
            m.b2 = static_cast<std::uint32_t>(b);
            m.i = i;
            m.j = j;
            tc = joinChildTracked(parent, psrc, 0, m);
        }

        std::cout << "child (decompressed): " << serialize(tc.pos) << "\n";
        if (watch) {
            std::cout << "watched token (region=" << (*watch)[0] << ",boundary=" << (*watch)[1]
                      << ",token=" << (*watch)[2] << ") seeded srcId=" << watchId << "\n";
            std::cout << "survives in child: " << (idSurvives(tc.src, watchId) ? "YES" : "NO") << "\n";
        }
        return 0;
    } catch (const EncodingError& e) {
        std::cerr << "engine error: " << e.what() << "\n";
        return 1;
    }
}
