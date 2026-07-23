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

// Enumerate `enc`'s children directly against its LITERAL parsed structure -- unlike analyzeJson,
// there is no canonicalize() pre-step, so move (region/boundary/i/j) indices are relative to `enc`
// exactly as parsed, not to whatever Hollow/Split/Triplet-recompressed form canonicalize() might
// produce first. `enc` must already be decompressed (no pseudo-points) -- the same convention
// applyMoveTracked's parentEnc uses. Children ARE valued (real nimber/minMoves/maxMoves, via the
// same exactGraph().ensure() + valueOf() fullAnalysis uses) -- unlike unvaluedChildren's -1
// sentinel, callers here (the Collect feature's tracked L-move recomputation) need real nimbers.
// Guarded by the same kMaxLives2 cap as analyzeJson/analyzeFullJson (returns
// {"ok":false,"reason":"too-large"}); nothing calling this is expected to exceed it in practice
// (the Collect feature caps at 8 lives), it is just the same safety net analyzeJson has. This
// exists so a caller retracing moves against a decompressed parent + parallel provenance array (as
// the tracked-apply bridge does) can enumerate children whose move indices are guaranteed to match
// that same parent's literal layout -- analyzeJson's children cannot make that guarantee once a
// compressible organ is present. Returns {"ok":true,"children":[...]} (same per-child shape as
// analyzeJson) or {"ok":false,"reason":"parse-error"|"too-large","message"?:...}.
std::string childrenTrackedJson(const std::string& enc);

// Every legal move of `enc`'s component `component` that touches the token at
// (region, boundary, token) -- e.g. a DisaPoint's own occurrence -- valued the same way
// childrenTrackedJson's children are. `enc` must already be decompressed, same convention as
// childrenTrackedJson/applyMoveTracked. This is the ground-truth replacement for guessing an
// "L-move" by transplanting a MoveTag the engine's own children-list dedup happened to keep onto
// the target's region and hoping the boundary indices line up (unsound: a real L-move can be
// dedup-shadowed behind a differently-shaped-but-isomorphic move elsewhere in the position, e.g.
// joining a DisaPoint straight to a scab in its own region can coincide with self-enclosing its
// detached-pair region -- only one MoveTag survives analyzeJson's dedup either way). Enumerating
// enclosureMoves/joinMoves directly and filtering to ones touching the given token sidesteps that
// entirely -- see collectGenetics.ts's computeLReachable, the caller this exists for. Returns
// {"ok":true,"children":[...]} (children's own `move` field is the ORIGINAL Enclosure/Join move
// that reached them, not re-rooted onto any other position) or {"ok":false,"reason":"bad-move"|
// "too-large"|"engine-error","message"?:...}.
std::string regionMovesTrackedJson(const std::string& enc, int component, int region, int boundary, int token);

// Every legal move (Enclosure or Join) of `enc`'s ENTIRE position, across every component, valued
// the same way childrenTrackedJson's children are -- but, unlike childrenTrackedJson, NOT deduped by
// canonical result. childrenAllWithMoveTag's `seen.insert(serialize(child))` keeps only the first
// MoveTag reaching any given canonical child, which is correct for "list the children of this
// position" but wrong for retracing a SPECIFIC tracked token's provenance through a grandchild move:
// when two moves are canonically identical because of a genuine structural symmetry (e.g. two
// isomorphic detached-pair regions, each self-enclosable to the same canonical result), only one of
// the two survives dedup, and if that one doesn't happen to be the move that preserves the caller's
// tracked token, provenance-based bypass detection sees "target not found" and wrongly reports no
// match -- even though the OTHER (deduped-away) move would have preserved it and, by the same
// symmetry, matches just as well. `enc` must already be decompressed, same convention as
// childrenTrackedJson/regionMovesTrackedJson. Guarded by the same kMaxLives2 cap. Returns
// {"ok":true,"children":[...]} or {"ok":false,"reason":"too-large"|"engine-error","message"?:...}.
std::string allMovesTrackedJson(const std::string& enc);

} // namespace stalks
