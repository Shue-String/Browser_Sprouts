#pragma once
#include <cstddef>
#include <numeric>
#include <vector>

namespace stalks {

// Disjoint-set union (union-find) over the index range [0, n). The engine reaches for this
// wherever it has to group items by a "connected" relation that is discovered incrementally
// rather than known up front: the pairing-connected regions of a component (the oplus
// decomposition in moves.cpp and the minimal-subposition split in canon.cpp), and the
// body-part reachability graph in Component::validate.
//
// Design choices, since they are not the textbook defaults:
//   * find() uses path *halving* -- each step re-points a node at its grandparent as it climbs
//     -- instead of recursive full path compression. Halving flattens the tree lazily across
//     repeated queries in a single loop, with no second pass and no recursion, and gives the
//     same near-constant amortized cost in practice.
//   * There is NO union-by-rank/size. The sets here are tiny (a handful of regions or body
//     parts per component), so the rank bookkeeping would cost more than the marginally
//     shallower trees it would buy.
//   * unite() is directional on purpose: a's root is hung under b's root, and no caller cares
//     which representative survives -- they only ever ask "are these two in the same set?".
struct UnionFind {
    std::vector<int> parent;
    explicit UnionFind(std::size_t n) : parent(n) {
        std::iota(parent.begin(), parent.end(), 0);
    }
    int find(int x) {
        while (parent[static_cast<std::size_t>(x)] != x) {
            parent[static_cast<std::size_t>(x)] =
                parent[static_cast<std::size_t>(parent[static_cast<std::size_t>(x)])];
            x = parent[static_cast<std::size_t>(x)];
        }
        return x;
    }
    void unite(int a, int b) { parent[static_cast<std::size_t>(find(a))] = find(b); }
};

} // namespace stalks
