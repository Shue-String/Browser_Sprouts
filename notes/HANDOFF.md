# Sprouts — Active Notes

Last swept for staleness 2026-09-21 (previous sweep: 2026-07-23 — nearly two months of drift; see
`FUNCTIONS.md`'s new native-tools/build-scripts catalogs and the ALPHA-genome section rewrite for
what had gone stale). **Keep this pair current**: when a feature lands, update the relevant
`FUNCTIONS.md` section and this file's architecture/TODO bullets in the same session, not later —
the two live in the repo specifically so a human and Claude read the same up-to-date picture
instead of Claude re-deriving it from memory files or grep each time.

## Architecture summary
- Region layer is RECOMPUTED from the planar embedding each move (`recomputeRegions` in
  `src/model/moves.ts`). No incremental split/merge logic. See memory `reference_rotation_system_model.md`.
- **Finding "which region/side is this" (containment queries)**: use `regionContainsPointNearest`/
  `regionNearestFeature` (`src/model/moves.ts`, 2026-10-01: side of the nearest boundary feature —
  no antipodal blind spot, no outer-region elimination). Used by `computeScabArc`,
  `renderRegionDiagnostic`, `screenOuterRegion` (renderer.ts), `computeSpliceSlots` and `recomputeRegions`' component/spot nesting (`containingFace`/`outerCycleFace`, via `loopsNearestFeature`; moves.ts).
  Replaced the old winding-number pattern, which read a false 0 for big regions. Full history:
  memory `feedback_sphere_native_containment.md`.
- Dead-region elimination (shrink+pop) is in `src/model/deadRegions.ts`. Main containment fix
  (regions embedded inside a living component) shipped 2026-09-12. See memory
  `project_dead_region_elimination.md` for current status and open bugs.
- Dead-face collapse ANIMATIONS for `triangleDeadStep`/`parallelDeadStep` use deflate-in-place
  (`src/model/faceDeflate.ts`, a Floater mean-value mesh embedding — injective, so no crossings for any
  face shape or size, including a dead face that covers most of the sphere). Other collapse animators
  (louse, quad, enclosed-triangle, bigon-tip, self-connected, triple-parallel) are unaudited and could be
  ported onto the same `startDeflate`/`deflateTo` helpers. See memory `project_collapse_animation_crossings.md`.
- Canonical position encoding: `src/model/encoding.ts`. All dead-region surgery is gated
  by a before/after encoding check.
- Advanced Collections / genome registry: hand-authored data lives in ONE file, `src/data/collectionElements.json` (one object per
  collection: name, rep, genome, and per-offset `single`/`double`/`multi` element lists; S_33+ genomes are engine-derived snapshots flagged `derived`,
  regenerate via `stalks/tools/genome_for_reps`); everything else (both `.generated.hpp` native headers, `collectionGenomes.generated.json`,
  `collectionsRoster.json`, `collectAlpha.ts`'s in-memory registry) is a mechanical derivation —
  see `FUNCTIONS.md`'s "Build scripts" section and `reference_encoding_system.md`. The native
  registry (`stalks/collections.cpp`) and its ~20 audit/discovery tools under `stalks/tools/` are
  the ground truth for family membership; the TS side never re-derives that logic independently.
- Collect (`src/ui/collect.ts`) and T-Tree (`src/model/ttree.ts` / `src/ui/ttree.ts`) both classify
  genomes through the shared `src/model/collectAlpha.ts` pipeline (engine movetype tags, not the
  old retired DisaPoint-provenance approach). See `FUNCTIONS.md` for the current export list.

## Terminology
- **Loop move**: the player draws a stroke from a vertex back to itself (v1===v2 in `MoveInput`).
  Creates a new midpoint vertex and two parallel edges — no self-loop edge is produced.
- **Self-loop edge**: an `Edge` where `v1 === v2`, arising from `scabAloneCollapse` after
  dead-region elimination. Rendered specially; has 1/3 and 2/3 repellers to keep it open.

## Open TODOs
- `eliminateIsolatedVertex` (`src/model/deadRegions.ts`) has a known self-crossing edge case still
  open. See `project_dead_region_elimination.md` for specifics.
- 2D `pointInPolygon` containment call sites not yet migrated to the spherical winding-number
  pattern: `src/model/moveCode.ts`'s `computeEnclosureCoverage` (~line 456, a debug helper) and
  `src/model/moves.ts`'s `probeLeftInside` (~line 1001, decides a cycle's interior-left handedness
  during `recomputeRegions` face classification — majority vote over projected per-dart probes).
  `src/render/renderer.ts`'s three containment sites (`computeScabArc`, `renderRegionDiagnostic`,
  `screenOuterRegion`) were the last ones there and got migrated 2026-09-27 — see
  `feedback_sphere_native_containment.md`.
- Quick-canon re-canonicalization efficiency: re-verify from scratch, focused on the move-menu-cache
  question. See `project_quickcanon_recanonicalization_perf.md`.
- Optimal-play game trees: fetch unrestricted `maxMoves` for 12/16-spot starts. Not urgent. See
  `project_optimal_play_game_trees.md`.

## Voronoi junction naming/pathfinding

Full detail (current architecture, naming rules, live path algorithm) is in Claude auto-memory
`reference_junction_naming.md` — this file no longer keeps its own copy since the details there
move faster than this doc gets updated. `src/voronoiTest.ts` / `voronoiTest.html` is the standalone
graph viewer for it (open via `npm run dev` → `http://localhost:5173/voronoiTest.html`, NOT by
double-clicking the file — `file://` blocks ES modules).

## Gotchas
- The in-app preview (`requestAnimationFrame`) is throttled to ~0 in a backgrounded page.
  The actual browser tab renders fine; don't trust pixel reads from the preview eval context.
- Toggle stack (top-right, every 32px from top): proj, enc, rgn, mid, id, arr.
