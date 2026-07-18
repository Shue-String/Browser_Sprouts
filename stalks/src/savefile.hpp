#pragma once
#include "graph.hpp"
#include "position.hpp"

#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <string>
#include <unordered_map>
#include <vector>

namespace stalks {

// Compact, self-contained on-disk form of a solved GameGraph -- the "save file".
//
// Only the MINIMAL (single-subposition) nodes and the raw game-graph TOPOLOGY are stored. Every
// node value (nimber / minMoves / maxMoves) and all parent links are RECOMPUTED bottom-up when the
// file is loaded, so they are never written. A disconnected (sum) child is not stored as its own
// node either: it is written inline as the list of minimal-node indices it decomposes into, and its
// value is the XOR (nimber) / sum (move bounds) of those parts -- exactly how the engine already
// treats sums.
//
// The one idea that makes loading trivial: nodes are emitted in ASCENDING-LIVES order. Every move
// strictly reduces total lives, so every child -- and every component of a sum child -- has strictly
// fewer lives than its parent and therefore appears EARLIER in the file. A node's index is its
// position in the stream; every edge is a back-reference to an already-read node. No fixup pass.
//
// Binary layout (little-endian; integers are LEB128 unsigned varints):
//   magic "SPRT", u8 version(=1), u8 mode(0=Exact,1=Quick), varint N (minimal-node count)
//   N node records; record i defines node index i (0-based):
//     varint encLen, then encLen chars packed 5 bits each (ceil(5*encLen/8) bytes) -- the
//       bracketless canonical encoding. The alphabet is 0-9, '|', ',', A..T (32 symbols); a
//       component with a 21st membrane letter cannot be packed and the save is rejected.
//     varint childCount
//     childCount edges, each a parity-tagged descriptor varint:
//       even -> ordinary child; (desc >> 1) is the single back-delta (thisIndex - childIndex)
//       odd  -> disconnected (sum) child; (desc >> 1) is the component count (>= 2), followed by
//               that many back-delta varints. (A sum has >= 2 parts, so odd never collides.)
//       [Quick mode only] u8 offset (0/1) trails each edge -- omitted entirely in Exact

// Write the minimal-node topology of `g` (either mode) to `out`. Returns the node count written.
std::size_t saveGraph(const GameGraph& g, std::ostream& out);
std::size_t saveGraphToFile(const GameGraph& g, const std::string& path);

// Write only the minimal nodes reachable from `root` (via child + subposition links) -- the same
// self-contained format, scoped to one root. Lets several roots (e.g. the 2..6-spot starts) share a
// single incrementally-built graph so common small subpositions are computed once, while each root's
// master file still contains exactly its own subtree.
std::size_t saveSubgraph(const GameGraph& g, const Node* root, std::ostream& out);
std::size_t saveSubgraphToFile(const GameGraph& g, const Node* root, const std::string& path);

// A loaded solved database: minimal nodes with their recomputed values, plus an encoding index.
// This is a value ORACLE, not a rebuilt GameGraph -- sum nodes are never materialized; a
// disconnected position is valued on the fly by combining its component nodes.
class SolvedDB {
public:
    struct Value {
        int nimber = 0;
        int minMoves = 0;
        int maxMoves = 0;
    };

    GameGraph::Mode mode() const { return mode_; }
    std::size_t size() const { return encs_.size(); }

    // Value of a stored MINIMAL node by its exact (as-written) encoding. Null if absent.
    const Value* findMinimal(const std::string& enc) const;

    // Value of an arbitrary position: reduced to this DB's identity form (structural canon in Exact,
    // quick-canon in Quick), split into minimal subpositions, each looked up and combined (XOR the
    // nimbers, sum the move bounds). In Quick mode `offsetOut` receives the quick-canon offset, so
    // the true nimber is `out.nimber ^ *offsetOut`. Returns false if any part is missing from the DB.
    bool value(const Position& p, Value& out, int* offsetOut = nullptr) const;

    // Read-only access to the raw stored rows (ascending-lives order), for verification/analysis.
    const std::vector<std::string>& encs() const { return encs_; }
    const std::vector<Value>& values() const { return vals_; }

private:
    friend SolvedDB loadGraph(std::istream& in);
    GameGraph::Mode mode_ = GameGraph::Mode::Exact;
    std::vector<std::string> encs_;
    std::vector<Value> vals_;
    std::unordered_map<std::string, std::size_t> index_;
};

SolvedDB loadGraph(std::istream& in);
SolvedDB loadGraphFromFile(const std::string& path);

} // namespace stalks
