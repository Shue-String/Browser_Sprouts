// Ad-hoc debug tool for Alpha movetype Phase 5: dump every child of a position alongside its
// special-point movetype classification, using the engine's real functions
// (childrenAllWithMoveTag/edgeTagFromMoveTag/specialPointMovetypes/packMovetypes -- see
// moves.hpp) directly, with no JSON layer involved. Meant for eyeballing real output before any
// JSON-exposure code is written or any new test is locked in, per
// feedback_leverage_the_program_not_hand_simulation.
//
// Usage: query_movetype "<encoding>"
#include "canon.hpp"
#include "encoding.hpp"
#include "moves.hpp"
#include "position.hpp"
#include "tokens.hpp"

#include <iostream>
#include <string>

using namespace stalks;

namespace {

const char* kindName(MoveKind k) {
    switch (k) {
        case MoveKind::Enclosure: return "Enclosure";
        case MoveKind::Join: return "Join";
        case MoveKind::InteriorPseudo: return "InteriorPseudo";
        case MoveKind::External: return "External";
    }
    return "?";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: query_movetype <encoding>\n";
        return 1;
    }
    try {
        const Position p = canonicalize(parsePosition(argv[1]));
        std::cout << "canon: " << serialize(p) << "\n";

        if (!hasSpecialPoint(p)) {
            std::cout << "(no special point present -- movetype fast path, every edge is 0)\n";
            return 0;
        }

        const Position d = p.decompressed();
        int idx = 0;
        for (const auto& [child, tag] : childrenAllWithMoveTag(p)) {
            const EdgeTag et = edgeTagFromMoveTag(d, tag);
            const auto sparse = specialPointMovetypes(p, et, child);
            const int packed = packMovetypes(sparse);

            std::cout << "[" << idx++ << "] " << kindName(tag.kind) << " -> " << serialize(child)
                      << "  packed=" << packed;
            if (sparse.empty()) {
                std::cout << "  (no special point in parent -- unreachable here)";
            } else {
                std::cout << "  {";
                for (std::size_t k = 0; k < sparse.size(); ++k) {
                    if (k) std::cout << ", ";
                    std::cout << tokenChar(sparse[k].first) << ":" << sparse[k].second;
                }
                std::cout << "}";
            }
            std::cout << "\n";
        }
        return 0;
    } catch (const EncodingError& e) {
        std::cerr << "engine error: " << e.what() << "\n";
        return 1;
    }
}
