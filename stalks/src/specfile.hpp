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

// Compact on-disk form of a solved GameGraph subtree that may contain SPECIAL-POINT tokens (ALPHA,
// BETA, ...) -- a wholly separate format from savefile.hpp's .sprout, per explicit user directive:
// the standard .sprout save/load path stays completely untouched, and special-point-bearing
// positions get their own format with their own write AND read functions, no shared code path with
// savefile.cpp. See project_alpha_movetype_feature.md's "Save-format directive".
//
// Same big idea as .sprout (nodes emitted in an order where every edge is a back-reference to an
// already-written node -- no fixup pass, values recomputed on load) but THREE things widen:
//   1. Encodings are 6-BIT packed (not .sprout's 5-bit), by explicit user decision: this format will
//      never need more than 22 membrane letters (A-V) or more than 4 distinct special-point symbols
//      in one component, so digits(10) + '|' + ',' (2) + A-V (22) + 4 dedicated special-point codes
//      (conceptually "W,X,Y,Z", the alphabet's last 4 letters) = 38 codes fit comfortably in the 64
//      a 6th bit provides. A 5th+ special-point symbol or 23rd+ membrane in one component is rejected
//      (specfile.cpp::codeOf/kMaxMembranes/kMaxSpecialPacked) -- a save-format-specific cap, tighter
//      than tokens.hpp's general MAX_SPECIAL_POINTS=10.
//   2. Every edge additionally carries its PACKED MOVETYPE (moves.hpp::packMovetypes) -- the whole
//      reason this format exists. Two edges to the same child are NOT collapsed if their movetype
//      differs (mirrors GameGraph::Node::childMoveTypes; mex/value computation still ignores
//      movetype and dedups by child value alone, same as the real solver).
//   3. The topological order is a priority-driven KAHN'S ALGORITHM, not plain ascending-lives2().
//      .sprout's "a child always has strictly fewer lives than its parent" invariant genuinely
//      breaks once special points are involved: lives2() deliberately returns 0 for a special-point
//      token in place (Phase 1's locked semantics), but the movetype-2 transformation ("becomes a
//      scab") replaces it with a token that DOES carry lives2 -- a scab occupying its own standalone
//      one-token boundary was empirically found (debug_spec_order.exe on "[0,a]") to carry MORE
//      remaining capacity than the special point it replaced, so lives2() can flat-out INCREASE
//      across that one edge, and no numeric proxy derived from the encoding alone is safe to sort by.
//      specfile.cpp::topoOrderMulti instead emits nodes one at a time, always choosing -- among
//      nodes whose every dependency has ALREADY been written -- the one with the smallest
//      (lives2, specialPointCount, enc). Correctness comes from honoring real dependencies (true by
//      construction, since the graph is acyclic -- built by graph.cpp's memoized recursion, which
//      only terminates because no position is ever its own ancestor); "fewest lives first" is then
//      just the tie-break used to choose among whatever is currently eligible, giving the same
//      practical ordering .sprout has whenever the topology allows it, without relying on lives2()
//      monotonicity for correctness.
// Also supports MULTIPLE roots in one file (e.g. two related starting positions saved together as
// one combined tree, sharing a persistent GameGraph so common subpositions are stored once): a node
// reachable from ANY of the given roots is written exactly once.
//
// Binary layout (little-endian; integers are LEB128 unsigned varints):
//   magic "SPEC", u8 version(=1), u8 mode(0=Exact,1=Quick), varint N (minimal-node count)
//   N node records; record i defines node index i (0-based):
//     varint encLen, then encLen chars packed 6 bits each (ceil(6*encLen/8) bytes) -- the
//       bracketless canonical encoding.
//     varint childCount
//     childCount edges, each:
//       parity-tagged descriptor varint (same scheme as .sprout: even -> ordinary child, desc>>1 is
//         the back-delta; odd -> sum child, desc>>1 is the component count >= 2, then that many
//         back-delta varints)
//       [Quick mode only] u8 offset (0/1)
//       varint packedMovetype (0 when this edge has no special-point classification at all)

std::size_t saveSpecGraph(const GameGraph& g, const std::vector<const Node*>& roots, std::ostream& out);
std::size_t saveSpecGraphToFile(const GameGraph& g, const std::vector<const Node*>& roots,
                                 const std::string& path);

struct SpecValue {
    int nimber = 0;
    int minMoves = 0;
    int maxMoves = 0;
};

// One outgoing edge of a loaded node: the child's resolved value (XOR/summed over its components
// if the child is a disconnected sum) plus the packed movetype for this specific edge.
struct SpecEdge {
    SpecValue child;
    int movetype = 0;
};

// A loaded minimal node: its encoding, recomputed value, and its outgoing edges in on-disk order.
// Unlike SolvedDB (savefile.hpp), edges are kept -- not collapsed into just a final value -- because
// movetype TOPOLOGY, not only the resulting nimber, is the point of this format.
struct SpecNode {
    std::string enc;
    SpecValue value;
    std::vector<SpecEdge> edges;
};

// A loaded solved database: minimal nodes with recomputed values and edges, plus an encoding index.
// Like SolvedDB, values are never trusted from disk -- recomputed bottom-up (mex over child
// nimbers, 1+min/1+max) while reading, since ascending-lives order guarantees every edge target has
// already been read.
class SpecDB {
public:
    GameGraph::Mode mode() const { return mode_; }
    std::size_t size() const { return nodes_.size(); }

    const SpecNode* findMinimal(const std::string& enc) const;

    // Value of an arbitrary position: reduced to this DB's identity form (structural canon in
    // Exact, quick-canon in Quick), split into minimal subpositions, each looked up and combined.
    // Same convenience SolvedDB::value provides. Returns false if any part is missing from the DB.
    bool value(const Position& p, SpecValue& out, int* offsetOut = nullptr) const;

    // Read-only access to the raw stored rows, in on-disk (ascending-lives) order.
    const std::vector<SpecNode>& nodes() const { return nodes_; }

private:
    friend SpecDB loadSpecGraph(std::istream& in);
    GameGraph::Mode mode_ = GameGraph::Mode::Exact;
    std::vector<SpecNode> nodes_;
    std::unordered_map<std::string, std::size_t> index_;
};

SpecDB loadSpecGraph(std::istream& in);
SpecDB loadSpecGraphFromFile(const std::string& path);

} // namespace stalks
