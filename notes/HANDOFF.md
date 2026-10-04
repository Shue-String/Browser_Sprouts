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
- 2D `pointInPolygon` containment call site not yet migrated to the sphere-native pattern:
  `src/model/moveCode.ts`'s `computeEnclosureCoverage` (~line 456, a debug helper).
  `src/model/moves.ts`'s `probeLeftInside` was replaced 2026-10-03 by an exact pole test (see the
  move router section). `src/render/renderer.ts`'s three containment sites were migrated
  2026-09-27 — see `feedback_sphere_native_containment.md`.
- `edgePtsForEntry` / `boundarySphereLoop` can't tell a raw self-loop edge's (v1 === v2, from
  dead-region collapse) two darts apart — both come back in forward order, so containment for the
  face on the reverse side reads the complement near that loop. `recomputeRegions` now builds its
  own loops with `loopFromDarts`; other callers (renderer, `regionContainsPointNearest`) don't.
- Quick-canon re-canonicalization efficiency: re-verify from scratch, focused on the move-menu-cache
  question. See `project_quickcanon_recanonicalization_perf.md`.
- Optimal-play game trees: fetch unrestricted `maxMoves` for 12/16-spot starts. Not urgent. See
  `project_optimal_play_game_trees.md`.

## Move router (stroke synthesis) — `src/model/moveRouter.ts`

Since 2026-10-03 `candidateStrokes` puts the topological router first for anything that must
enclose something: a side-aware Voronoi bisector over seeds offset into the face from every dart
(see the FUNCTIONS.md entry). Test it headlessly with `scripts/route/routeHarness.ts` (coverage of
engine children) and `scripts/route/routeDebug.ts` (PNG of one case). Measured on 25 random games
up to 7 spots, exact oracle: per-child candidates reach 87.8–93.8% of engine children depending on
the game set (79.2% before); the router can draw ~96% of distinct children when every reading is
enumerated, which the Position Browser's background pass (`precomputeChildrenMoves` →
`allRoutedMoves`) now does, so hover coverage is ~96–97%. Remaining misses: positions whose drawing
has crossed edges (layout physics bug), and Recreate token issues (see auto-memory
`project_move_router.md`).

2026-10-04 follow-ups (all measured with `failureSaves.ts 25 7 4,5`, undrawable children 4.0% -> 0.9%):
- `moveRouter.ts` `wallsAt`: corner-vs-own-wall match tolerance 1e-6 (joint endpoints differ in the last bit; acos made that 2e-8 and a joint's own edges looked foreign, leaving the corner with no seeds).
- `smooth.ts`: interior edge-point moves and resampling are crossing-guarded (see FUNCTIONS.md `pointMoveCrosses`, `resampleAllEdges`) — the layout physics was the source of the "crossing edges" failure group.
- `moveCode.ts`/`recreate.ts`: self-loop brackets. At a BARE SPOT (degree 0) the loop's two faces are interchangeable, so Recreate accepts either face's bracket (`selfLoopOtherSide`) and "everything enclosed" normalizes to `[]`. At an APPENDAGE TIP (degree 1) they are not — the tail lands in one face — so the bracket always lists the face bounded by the loop alone (`[W, v, W]` vs `[W, v, tail]`), with no other-side matching or `[]` normalization. Before 2026-10-04 appendage loops recorded whichever face came first, so old sequences with them can replay to a different (canon-unequal) position.
- `main.ts` `promptCandidates`: Recreate's no-pause fallbacks never commit a crossing stroke (they used to retry "skipping the crossing check"); with no legal candidate the move goes to manual drawing.
- `main.ts` `liveAnalysisText`: the Position Browser analyses the DECOMPRESSED live encoding, so a compressed DisaPoint can't expand to the wrong twin (the DisaPoint-twin failure group).

Fixed alongside, because the router exposed them:
- `main.ts` hover verification compared the lossy COMPRESSED encoding (DisaPoint `3` canonicalizes
  back one way: `2,A|0,0,A` vs `2A|0,0,A`), and the encoder's `""` for a dead position vs the
  engine's `N` — now `trialCanonOf` (decompressed, `""`→`N`).
- `resolveMoveVertices` ordered components unlike the engine (wrong vertices in most multi-
  subposition games) — now exact via provenance, with canon-matched components as fallback.
- `recomputeRegions`: a self-loop's two new darts were ordered by raw bearing, which flips across
  the ±π cut (loop faces inside out); and cycle handedness came from a 2D probe vote.

The older vertex-seeded Voronoi system (`voronoiGraph.ts`, `voronoiJunctionPath.ts`, junction
naming, `voronoiTest.html`, the paused-Recreate Voronoi overlay) is still in place as a fallback and
debug view; history in auto-memory `reference_junction_naming.md`.

## Gotchas
- The in-app preview (`requestAnimationFrame`) is throttled to ~0 in a backgrounded page.
  The actual browser tab renders fine; don't trust pixel reads from the preview eval context.
- Toggle stack (top-right, every 32px from top): proj, enc, rgn, mid, id, arr.
