#pragma once
#include <string>

namespace stalks {

// Canonicalize an encoding and return its bracketless canonical serialization. Throws
// EncodingError on a malformed encoding. Used by the app's lightweight gameplay-parent recorder.
std::string canonOnly(const std::string& enc);

// Analyze a position for the Position Browser. Parses + canonicalizes `enc`, and if every
// minimal subposition has lives2() <= 24 (i.e. <= 12 lives), builds the exact game graph rooted
// there and returns a JSON blob with: canon, nimber, min/maxMoves, subposCount, the per-subposition
// nimber breakdown, the play-children (each with its values), and graphMeta for every node in the
// built graph (so the caller can cache tree metadata and build a reverse parent index).
//
// Never throws. A malformed encoding returns {"ok":false,"reason":"parse-error",...}. A position
// whose largest subposition has 13-16 lives (24 < lives2 <= 32) is not analyzed automatically:
// it returns {"ok":false,"reason":"needs-calculation","canon":...,"maxLives2":...,"quickCanon":...}
// so the caller can offer the on-demand Calculate buttons. Anything larger (lives2 > 32) returns
// {"ok":false,"reason":"too-large","canon":...,"maxLives2":...}.
std::string analyzeJson(const std::string& enc);

// On-demand full (exact) game-tree analysis, invoked by the "Calculate Game Tree" button. Same
// JSON shape as analyzeJson's ok result, but the size gate is raised to 16 lives (lives2 <= 32);
// beyond that it still returns "too-large". Reuses the persistent exact graph, so subtrees already
// built for earlier positions are not recomputed.
std::string analyzeFullJson(const std::string& enc);

// On-demand quick-canon nimber, invoked by the "Calculate Nimber" button. Builds the (far smaller)
// quick-canon graph up to 16 lives and returns {"ok":true,"reason":"quick","canon":...,"nimber":...,
// "quickCanon":{enc,offset},"quickChildren":[...]}. Only the nimber is exact -- move bounds are not
// meaningful in quick-canon, so they are omitted. Over 16 lives returns "too-large".
std::string analyzeNimberJson(const std::string& enc);

} // namespace stalks
