# Sprouts — Active Notes

## Architecture summary
- Region layer is RECOMPUTED from the planar embedding each move (`recomputeRegions` in
  `src/model/moves.ts`). No incremental split/merge logic. See memory `project_rotation_system_model.md`.
- Dead-region elimination (shrink+pop) is in `src/model/deadRegions.ts`.  See memory
  `project_dead_region_elimination.md` for current status and open bugs.
- Canonical position encoding: `src/model/encoding.ts`. All dead-region surgery is gated
  by a before/after encoding check.

## Terminology
- **Loop move**: the player draws a stroke from a vertex back to itself (v1===v2 in `MoveInput`).
  Creates a new midpoint vertex and two parallel edges — no self-loop edge is produced.
- **Self-loop edge**: an `Edge` where `v1 === v2`, arising from `scabAloneCollapse` after
  dead-region elimination. Rendered specially; has 1/3 and 2/3 repellers to keep it open.

## Open TODOs
- **TOP PRIORITY**: Dead regions embedded inside a living component can only be shrunk, not
  popped — they jam against the living structure instead of collapsing through it. Containment
  check + separate shrink pass not yet implemented. See memory `project_dead_region_elimination.md`.
- Edges should prefer taut geometry (geodesics) where they can reach without crossing.
  Vertices affect edges but not vice-versa; allowing both directions needs care to avoid
  edge-midpoints repelling their own edge's endpoints.
- **Stalks cleanup-fixpoint duplication** (flagged in the 2026-07-15 audit, next session):
  `moves.cpp`'s `chopWalk`/`cleanup` and `canon.cpp`'s `chopLB`/`cleanupLC` are the same
  "collapse cyclically-adjacent joint visits to a scab, then drop-empty/decay/isolate to a
  fixpoint" algorithm, duplicated across two parallel labeled-working-form hierarchies
  (`Item/IWalk/IComp` vs `Slot/LBnd/LComp`). Worth a shared `labeled-form.hpp` (tag/emit/cleanup)
  to remove the duplication, but it's a real refactor — not done in this pass.
- **`savefile.cpp` error paths are untested** (bad magic/version/oversized alphabet all throw
  `std::runtime_error`, but no test exercises them — `test_main.cpp`'s `checkThrows` only
  catches `EncodingError`). Not being fixed now — the save format itself is getting redone in
  a future version, so tests wait for that rewrite.

## Voronoi junction naming/pathfinding

Full detail (current architecture, naming rules, live path algorithm) is in Claude auto-memory
`project_junction_naming.md` — this file no longer keeps its own copy since the details there
move faster than this doc gets updated. `src/voronoiTest.ts` / `voronoiTest.html` is the standalone
graph viewer for it (open via `npm run dev` → `http://localhost:5173/voronoiTest.html`, NOT by
double-clicking the file — `file://` blocks ES modules).

## Gotchas
- The in-app preview (`requestAnimationFrame`) is throttled to ~0 in a backgrounded page.
  The actual browser tab renders fine; don't trust pixel reads from the preview eval context.
- Toggle stack (top-right, every 32px from top): proj, enc, rgn, mid, id, arr.
