// Debug tool: dump every minimal node reachable from a position, with lives2/special-point count
// and every outgoing edge's target (+ movetype), for inspecting .spec-format ordering questions.
// Found the real bug behind specfile.cpp's DFS-post-order design: lives2() can INCREASE across a
// movetype-2 ("becomes a scab") edge, breaking any lives2-based topological ordering scheme.
#include "graph.hpp"
#include "position.hpp"
#include "encoding.hpp"

#include <iostream>
#include <string>
#include <unordered_set>
#include <vector>

using namespace stalks;

namespace {
int specialCountOf(const std::string& enc) {
    int n = 0;
    for (char ch : enc) if (ch >= 'a' && ch <= 'j') ++n;
    return n;
}
std::vector<const Node*> reachableMin(const Node* root) {
    std::vector<const Node*> out;
    std::unordered_set<const Node*> seen{root};
    std::vector<const Node*> stack{root};
    while (!stack.empty()) {
        const Node* n = stack.back(); stack.pop_back();
        if (!n->isSum()) out.push_back(n);
        for (const Node* c : n->children) if (seen.insert(c).second) stack.push_back(c);
        for (const Node* s : n->subpositions) if (seen.insert(s).second) stack.push_back(s);
    }
    return out;
}
}

int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "usage: debug_spec_order <enc>\n"; return 1; }
    GameGraph g;
    Node* root = g.ensure(parsePosition(argv[1]));
    for (const Node* n : reachableMin(root)) {
        std::cout << "NODE enc=" << n->enc << " lives2=" << parsePosition(n->enc).lives2()
                  << " special=" << specialCountOf(n->enc) << " isSum=" << n->isSum() << "\n";
        for (std::size_t c = 0; c < n->children.size(); ++c) {
            const Node* ch = n->children[c];
            std::cout << "  edge -> " << (ch->isSum() ? "[SUM]" : ch->enc)
                      << " movetype=" << n->childMoveType(c);
            if (ch->isSum()) {
                std::cout << " parts={";
                for (std::size_t k = 0; k < ch->subpositions.size(); ++k) {
                    if (k) std::cout << ",";
                    std::cout << ch->subpositions[k]->enc;
                }
                std::cout << "}";
            } else {
                std::cout << " childLives2=" << parsePosition(ch->enc).lives2()
                          << " childSpecial=" << specialCountOf(ch->enc);
            }
            std::cout << "\n";
        }
    }
    return 0;
}
