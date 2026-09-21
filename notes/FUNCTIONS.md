# Sprouts — Function Index

One-stop reference for every exported function and class by file.
Internal helpers are listed only when they're large enough to be worth knowing.

---

## `src/math/sphere.ts` — Sphere geometry and projections

| Function | Description |
|---|---|
| `identityRotation()` | Returns the 3×3 identity rotation matrix |
| `rotateSpherePoint(p, m)` | Apply rotation matrix m to sphere point p |
| `unrotateSpherePoint(p, m)` | Apply inverse rotation (transpose of m) to p |
| `composeRotations(m1, m2)` | Matrix multiply m1 × m2 |
| `rotationX(angle)` | Rotation matrix around the X axis |
| `rotationY(angle)` | Rotation matrix around the Y axis |
| `axisAngleRotation(axis, angle)` | Rotation matrix via Rodrigues' formula |
| `project(p, diskRadius, cx, cy)` | Lambert azimuthal equal-area projection: sphere → disk |
| `unproject(px, py, diskRadius, cx, cy)` | Inverse Lambert: disk → sphere |
| `projectRect(p, width, height)` | Squircle-rect (Lambert + Shirley-Chiu disk↔square): sphere → rectangle |
| `unprojectRect(px, py, width, height)` | Inverse squircle-rect: rectangle → sphere |
| `normalize(p)` | Normalize p back onto the unit sphere |
| `sphereCentroid(points)` | Average + renormalize a set of sphere points |
| `slerp(a, b, t)` | Spherical linear interpolation between a and b |
| `arcsCross(a0, a1, b0, b1)` | True if two spherical arc segments intersect (antipode-safe) |
| `segCrossesPolylineSphere(...)` | Test a single arc segment against a sphere polyline |

---

## `src/math/intersect.ts` — 2D intersection helpers (canvas coordinates)

| Function | Description |
|---|---|
| `signedArea(pts)` | Shoelace signed area of a canvas polygon (positive ⇒ clockwise, y-down) |
| `dist(a, b)` | Euclidean distance between two canvas points |
| `pointInPolygon(poly, p)` | Ray-casting point-in-polygon test (canvas coordinates) |

Note: `segmentIntersection` / `strokeVsPolyline` documented in the previous version of this
file are no longer exported here — stroke-vs-polyline crossing checks now go through
`strokeCrossesEdges` in `src/model/strokeSynthesis.ts` and `arcsCross`/`segCrossesPolylineSphere`
in `sphere.ts`.

---

## `src/math/chaikin.ts` — Curve smoothing

| Function | Description |
|---|---|
| `chaikin(pts, iterations?)` | Corner-cutting Chaikin smoothing on a canvas-point polyline |

---

## `src/model/types.ts` — Core type definitions (no functions)

Key types: `VertexId`, `EdgeId`, `RegionId`, `SpotLabel`, `SpotGroupInfo`, `Vertex`, `Edge`,
`BoundaryEntry`, `Boundary`, `Region`, `Subposition`, `GameState`.

Notable field: `Edge.leftRegion` / `Edge.rightRegion` — set by `recomputeRegions`; used by
the renderer to look up the correct region per boundary step without guessing between parallel edges.

Pseudo-vertex fields (parallel-edge orientation fix; see memory `reference_pseudo_vertices.md`):
- `Vertex.isPseudo` / `Vertex.pseudoEdgeId` — a synthetic vertex pinned to an edge's arc
  midpoint. Inserted by `recomputeRegions` only when two real endpoints are exclusively
  connected to each other. Excluded from classification, encoding, smoothing, input, and
  aliveness counts; repositioned to the live arc midpoint each frame by `smoothStep`.
- `BoundaryEntry.pseudoHalf` — `'first-fwd' | 'first-rev' | 'second-fwd' | 'second-rev'`;
  marks that a pseudo-vertex split this edge into two boundary half-steps. CRITICAL:
  `pseudoHalf` (a boundary-step role) is distinct from `isPseudo` (a vertex flag).

`SpotLabel` — a spot's display label; either a plain number or a compact `{ lo, hi }` range
(see `src/model/vertexLabels.ts`).

---

## `src/model/gameState.ts` — State construction and utilities

| Function | Description |
|---|---|
| `createInitialState(n)` | Build a fresh n-spot game: no edges, one outer region, spots on latitude rings |
| `allocVertexId(state)` | Increment and return next vertex ID (positive integers; originals are negative) |
| `allocEdgeId(state)` | Increment and return next edge ID |
| `cloneState(s)` | Deep-clone the entire GameState for undo snapshots or rollback guards |

---

## `src/model/moves.ts` — Move application and rotation-system face recomputation

| Function | Description |
|---|---|
| `edgePtsForEntry(entry, edge)` | Slice of `edge.points` a boundary entry traverses — full edge for ordinary entries, or just the relevant half when `pseudoHalf` is set |
| `applyMove(state, move)` | Apply a committed move: add midpoint vertex + two edges, then recompute regions |
| `bearingFrom(from, to)` | Compass bearing from one sphere point to another |
| `pointAtBearing(from, bearing, dist)` | Sphere point reached by walking a bearing/distance from `from` |
| `stablePt(pts, startIdx, dir)` | Pick a numerically stable reference point along a polyline for tangent/bearing math |
| `recomputeRegions(state)` | Rebuild all regions/boundaries/subpositions from the planar embedding via rotation system; classify vertices; assign edge left/right regions; inserts pseudo-vertices (see `types.ts` notes) |
| `polyFromEntries(...)` | Build a sphere-point polygon from a boundary's entries |
| `makeSafeProjection(state)` | Pick a camera-free projection safe from antipodal singularities |

Key internal helpers: `entriesFromDarts` (dart cycle → boundary), `assignSides` (mark
`only`/`firstVisit`/`secondVisit`), `probeLeftInside` (point-in-polygon left-of-edge test),
`outerCycleFace` / `globalOuterId` (find the outer face), `buildSubpositions`
(group regions into subpositions by connected component via edge `leftRegion`/`rightRegion`
adjacency), `classifyVertexByDegree` (degree-only cache update; authoritative classification
is `classifyVertexFull` in encoding.ts).

---

## `src/model/encoding.ts` — Position encoding (canonical invariant string)

| Function | Description |
|---|---|
| `canonicalEncoding(state)` | The canonical position string — topological invariant; used as gate for dead-region surgery |
| `encodePosition(state)` | Full encoding: returns `EncodingResult { text, vertexSymbols, charInfo, ... }` |
| `encodePositionDecompressed(state)` | Encoding variant without the compact bracket/⊕ compression passes, for display/debugging |
| `classifyVertexFull(vid, state)` | Authoritative region-aware vertex classification (Spot/Appendage/Scab/Membrane/Joint/Dead) |
| `resolveMoveVertices(state, move)` | Resolve a `MoveInfo` move descriptor to concrete `ResolvedMoveVertices` against a given state |

Internal pipeline: `assignMembraneLetters` → `buildVertexSymbols` → `buildRegionReprs` →
`applyAllCompressions` (DisaPoint, HollowPoint, Triplet, SplitPoint passes) →
`serialize` → `renameMembranesInOrder` → `canonicalize`.

---

## `src/model/moveCode.ts` — Move-sequence encoding

| Function | Description |
|---|---|
| `computeMoveCode(before, v1, v2, after)` | Encode a single move as a string (loXhi format; parallel-lens move uses the `[]` suffix, with optional split/enclosure brackets) |
| `findNewVertex(before, after)` | Locate the midpoint vertex a move created, by diffing two states |
| `findMoveRegion(...)` | Locate the region a move's stroke passed through |
| `findEnclosedSideRegion(...)` | Locate the region enclosed on one side of an enclosure-style move |
| `computeEnclosureSideColoring(...)` | Build the two-side region coloring used for enclosure move-code brackets |
| `computeEnclosureCoverage(...)` | Determine which vertices/regions an enclosure move's bracket covers |
| `compWithBoth(r, lo, hi)` | Find the boundary of region `r` that touches both `lo` and `hi` |
| `isJoint(vid, state)` | True if vertex `vid` classifies as a Joint |
| `jointSub(vid, w, after)` | Resolve which post-move subposition a joint's neighbor `w` ends up in |
| `selfLoopJointSubs(vid, w, after)` | Same as `jointSub` but for the two subpositions on either side of a self-loop joint |

---

## `src/model/moveCodeParse.ts` — Move-sequence parsing

| Function | Description |
|---|---|
| `parseMoveSequence(input)` | Parse a full move-sequence string into a `ParsedSequence` of `ParsedMove` tokens |
| `parseToken(token, index)` | Parse one move token (loXhi format, with optional brackets/parens) into a `ParsedMove` |

Key types: `BracketEntry`, `ParsedMove`, `ResolvedMove` (a `ParsedMove` with brackets/parens
resolved to concrete vertex IDs), `ParsedSequence`.

---

## `src/model/smooth.ts` — Geometry smoothing and repulsion

| Function | Description |
|---|---|
| `resetActivityTimer(holdMs?)` | Reset the force-winddown idle timer (keeps physics running for `holdMs` after activity) |
| `getForceScale()` | Current force multiplier, ramped down by the winddown timer once idle |
| `smoothStep(state, shrinkDead?, extraSkip?)` | One frame of smoothing+repulsion. Returns true if still animating, false if settled |
| `edgeRepellers(state)` | Returns invisible repeller points for parallel edges (one midpoint each) and self-loop edges (1/3 and 2/3 points). Used by both the repulsion step and the renderer's debug overlay |
| `smoothStepDrag(state, drag)` | Smoothing step during vertex drag; rolls back if the drag would create a crossing |
| `resampleEdge(e)` | Resample edge to a point count proportional to arc length |

Tuning constants live in `src/model/tunables.ts` (see below), not inline in this file anymore.

---

## `src/model/tunables.ts` — Live-adjustable physics/UI constants

| Export | Description |
|---|---|
| `Tunables` (interface) | Shape of the tunable constant set (repulsion radii, step sizes, thresholds, etc.) |
| `DEFAULT_TUNABLES` | Factory defaults |
| `tunables` | The live, mutable tunable object smoothing/rendering code reads from |
| `TunableSpec` / `TUNABLE_SPECS` | Metadata (label, min/max/step) driving the in-app tuning panel |
| `loadTunables()` | Load saved overrides from localStorage into `tunables` |
| `saveTunables()` | Persist current `tunables` to localStorage |
| `resetTunables()` | Reset `tunables` back to `DEFAULT_TUNABLES` |

---

## `src/model/deadRegions.ts` — Dead-region elimination (shrink + pop)

### Detection / step functions (called each frame from `main.ts`)

| Function | Description |
|---|---|
| `fullyDeadVertexIds(state)` | Set of all vertices in fully-dead connected components (used by smooth.ts to skip them) |
| `deadRegionStep(state, skip?)` | One frame: shrink fully-dead components toward centroid; pop when small enough. Returns `{ moving, popped, popCentroids }` |
| `eliminateIsolatedVertex(state, skip?)` | Splice out one degree-2 dead vertex between two non-bigon neighbors; returns pop position or null |
| `scabAloneCollapse(state, skipVertices?)` | To fixpoint: for each dead boundary with exactly one live vertex (a scab), delete the dead neighbors and create a self-loop edge on the scab |

### Collapse animators (each is a detect + step pair)

| Detector | Step | Topology |
|---|---|---|
| `detectLouse(state)` | `louseCollapseStep(state, collapse)` | Theta-graph: 2 degree-3 vertices + 1 degree-2, 4 edges, 3 dead regions |
| `detectParallelDead(state)` | `parallelDeadStep(state, collapse)` | Bigon: 2 degree-3 vertices connected by exactly 2 parallel edges, each with one degree-2 pendant |
| `detectTripleParallelDead(state)` | `tripleParallelDeadStep(state, collapse)` | N-parallel-edge generalization of the bigon case (3+ parallel edges between the two degree-3 vertices) |
| `detectTriangleDead(state)` | `triangleDeadStep(state, collapse)` | Triangle: 3-vertex dead boundary, each vertex with one external edge |
| `detectQuadDead(state)` | `quadDeadStep(state, collapse)` | Quadrilateral: 4-vertex dead boundary; collapses to 2 new vertices + 5 edges |
| `detectBigonTip(state)` | `bigonTipStep(state, collapse)` | Degree-2 vertex hanging off a degree-3 vertex where both edges go to the same neighbor |
| `detectEnclosedTriangle(state)` | `enclosedTriangleStep(state, collapse)` | Triangle with one vertex also connected to external graph |
| `detectSelfConnectedDead(state)` | `selfConnectedDeadStep(state, collapse)` | Dead S–T pair where S is degree-3 with a self-loop plus one edge to dead vertex T (case A: T has two external edges; case B: T is also self-connected) |

Each `Collapse` type above (`LouseCollapse`, `ParallelDeadCollapse`, `TripleParallelDeadCollapse`,
`TriangleDeadCollapse`, `QuadDeadCollapse`, `BigonTipCollapse`, `EnclosedTriangleCollapse`,
`SelfConnectedDeadCollapse`) is also exported as an interface describing the detected shape
passed from `detectX` into `xStep`.

Key internal helpers: `occupiedCentroidAntipode` (steering waypoint away from the occupied side
of the sphere, used by both `quadDeadStep` and `enclosedTriangleStep`), and a shared path-
deformation group used by `quadDeadStep`/`enclosedTriangleStep` to retrace real (frozen-at-
detection) edges instead of slerping toward a fresh target each frame: `pointAlongPath` (point at
a fractional position along a frozen path), `pathPrefix`/`pathSlice` (sub-ranges of a frozen path,
for the still-unreeled portion), `deformPreservingOffset` (re-anchor a frozen path's shape to a
live, possibly-waypoint-bent chord — see memory `project_dead_region_elimination.md`).

---

## `src/model/strokeSynthesis.ts` — Synthesizing a drawable stroke for a move

| Function | Description |
|---|---|
| `candidateStrokes(state, parsed)` | Generate candidate sphere-point strokes reproducing a parsed move (for Recreate/preview) |
| `smallCircleSelfLoop(v, hint, radius, sampleCount?)` | Synthesize a small-circle self-loop stroke at vertex `v`, biased toward `hint` |
| `enclosureCandidates(state, parsed)` | Candidate strokes specifically for enclosure-style moves |
| `strokeCrossesEdges(...)` | Test whether a candidate stroke crosses any existing edge (validity check) |
| `candidateSelfLoopArcsWithSeeds(...)` | Self-loop stroke candidates seeded from specific directions, used when the plain small-circle synthesis doesn't reproduce the target move |

---

## `src/model/recreate.ts` — Move-sequence replay verification

| Function | Description |
|---|---|
| `synthesizeMove(...)` | Produce a stroke for a parsed move, trying candidates until one reproduces the target move |
| `strokeReproduces(state, parsed, stroke, useLabels?)` | Check whether a given stroke, if committed, reproduces the parsed move |
| `computeRecreateHints(state, parsed)` | Build `RecreateHints` (highlight targets) shown while the user manually recreates a move |
| `appliedMoveMatches(...)` | Check whether a just-applied move matches what Recreate expected |

---

## `src/model/saveState.ts` — Save/load file format

| Function | Description |
|---|---|
| `serializeGameState(...)` | Serialize a `GameState` (+ history) to a `SaveFileV1` JSON-able object |
| `deserializeGameState(save)` | Rebuild a `GameState` (+ `DeserializedSave` extras) from a `SaveFileV1` |

---

## `src/model/vertexLabels.ts` — Spot label / bracket notation

| Function | Description |
|---|---|
| `isSpotLabelRange(l)` | Type guard: is this `SpotLabel` a `{ lo, hi }` range rather than a plain number |
| `formatSpotLabel(l)` | Render a `SpotLabel` as display text (`"3"` or `"3-7"`) |
| `initialSpotLabels(state)` | Assign the starting 1..n labels to a fresh game's spots |
| `recomputeSpotLabels(...)` | Recompute/compact labels after a move (range merges for compressed groups) |
| `resolveLabelToVertexId(label, spotLabels)` | Map a displayed label number back to its vertex ID |
| `resolveMoveEndpoints(...)` | Resolve a parsed move's endpoint labels to vertex IDs against current labels |
| `resolveBracketEntry(...)` | Resolve one `BracketEntry` (single label or range) to vertex ID(s) |
| `resolveParensEntry(...)` | Resolve a parenthesized move-code group to vertex ID(s) |
| `labelForFromMap(spotLabels)` | Returns a `(vid) => label` lookup closure bound to a given label map |
| `spotGroupInfo(vid, spotLabels)` | `SpotGroupInfo` (key/sortKey/text) for the compressed label group containing `vid` |
| `spotGroupForFromMap(spotLabels)` | Returns a `(vid) => SpotGroupInfo` lookup closure bound to a given label map |

---

## `src/model/subregionHighlight.ts` — Move-preview subregion highlighting

| Function | Description |
|---|---|
| `toSafeHue(rawHue)` | Normalize/clamp a raw hue value into a display-safe range |
| `buildSubregionHighlight(...)` | Build a `SubregionHighlight` describing which subregion(s) to color for a previewed move |

---

## `src/model/voronoiGraph.ts` — Voronoi cell graph over a position

| Function | Description |
|---|---|
| `buildVoronoiGraph(...)` | Build the `VoronoiGraph`/`VoronoiData` (nodes, edges, cell types R/G/C) from a `GameState` |

Key types: `CellType`, `VoronoiNodeData`, `VoronoiEdgeData`, `VoronoiGraph`, `VoronoiFullEdge`,
`VoronoiEdgeName`, `VoronoiData`.

---

## `src/model/voronoiJunctionPath.ts` — Junction naming / Voronoi path tracing

| Function | Description |
|---|---|
| `computeV1Sequence(data)` | Trace the path segment starting from V1 |
| `computeV2Sequence(data, v1)` | Trace the path segment starting from V2, given the V1 result |
| `computeLastSegment(data, cgr1Node)` | Trace the final segment back from the last CGR node |
| `computeLastToExitSegment(...)` | Trace from the last node to the exit point |
| `computeFullPath(...)` | Assemble the full V1→Enter→CGR1→Last→Exit→V2 path from the sub-segments |
| `expandPathWithCycles(data, base, reversed?)` | Expand a base path to include any unused cycles found along the way |
| `computeJunctionVoronoiPath(...)` | Top-level entry: compute the complete named junction path for a position |

Key types: `JunctionPathStep`, `JunctionPathResult`, `V1SequenceResult`, `V2SequenceResult`,
`LastSegmentResult`, `LastToExitResult`, `FullPathResult`, `UnusedCycle`,
`JunctionVoronoiPathResult`.

---

## `src/model/collectAlpha.ts` — Collect/T-Tree feature: ALPHA-genome pipeline

Retired the old DisaPoint provenance-tracking approach (`src/model/collectGenetics.ts`, deleted
2026-07-29 — see git commit e29f5d7 "Rework Collect pane onto ALPHA/movetype pipeline; retire
DisaPoint genome path") in favor of reading the engine's own per-token movetype classification
directly (`moves.hpp`'s `specialPointMovetypes`: movetype 1→R, 2→D, 3→L, 4→T′, 5→T). This file is
the single TS-side source of truth for genome shapes, family names, and fold/bypass resolution;
shared by both Collect (`src/ui/collect.ts`) and T-Tree (`src/model/ttree.ts` / `src/ui/ttree.ts`).
The native mirror of this file's registry is `stalks/tools/alpha_genome.cpp` — the two are kept in
sync via `src/data/genomeDefs.json` (hand-authored) → `scripts/genGenomeDefsHeader.cjs` →
`stalks/tools/genome_defs.generated.hpp` (do not hand-edit the generated header).

| Export | Description |
|---|---|
| `isSingleAlpha(enc)` | True if a canonical encoding contains exactly one ALPHA special-point token |
| `shiftMembraneLetters(enc)` | Re-letter membranes so an embedded left-side text doesn't collide with a host's own letters |
| `genomeKey(R, D, L, Tprime)` | Canonical dedup key for a 4-gene `(R,D,{L},{T'})` genome bucket |
| `expandGenomeShorthand(input)` / `nameForShorthand(input)` | Parse/resolve a typed shorthand (e.g. a family name or `⊕n` offset form) in the Collect search box |
| `registryIndexReady` (promise) | Resolves once `buildRegistryIndex()` has finished folding `genomeDefs.json` into the in-memory `REGISTRY` |
| `registryFoldName(g)` | Resolve a `{quickEnc, quickOffset}` pair to its registered family name, if any |
| `KNOWN_COLLECTION_MEMBERS` / `KNOWN_COLLECTION_REP` / `KNOWN_COLLECTION_REP_RAW` | Per-family member lists / representative encodings, derived from `COLLECTION_ROSTERS` |
| `GENOME_NAMES` / `NAMED_FAMILY_GENOME_TEXT` / `NAMED_FAMILIES` / `NAMED_FAMILY_GROUPS` | The resolved family registry (name → genome text, full family records, and families grouped by base name for the `⊕n` offset siblings) |
| `familyForCore(g)` | Look up a family by its `(R,D,{L},{T'})` core key alone (ignores `[T]`) — see `reference_family_core_collision_bug.md` for a 2026-09-03 bug in an earlier version of this lookup |
| `bypassOnlyFoldName(g, resolveChild, depth)` / `resolvedFoldName(...)` | Resolve a genome's display name allowing one level of "bypass" (fold through an unnamed intermediate T-child to a named grandchild) |
| `findBypassMatches(...)` | Full bypass-match search used by the T-gene table / T-Tree "extra" edge classification |
| `classifyTChildren(...)` / `familyRequiresTChildPlain(family, plain)` | Classify each T-child as required / bypass / extra for a given family |
| `parseGenomeQuery(input)` | Parse a typed `"({R,D,{L},{T'}})"` genome-shorthand query in the Collect search box |
| `coreKeyOf(g)` / `fmtNimber(n)` / `isFullGenome(g)` | Small formatting/type-guard helpers |

Key types: `PositionRef`, `MoveChildRef`, `FourGeneGenome`, `TChild`, `AlphaGenome`, `NamedFamily`,
`NamedFamilyGroup`, `ParsedGenomeQuery`, `ResolveChild`, `BypassMatch`, `TChildClassification`.

---

## `src/model/ttree.ts` — T-Tree feature: genome tree data model

Builds the full T-gene descendant tree for a position (root + every required/bypass/extra child,
recursively) as a plain graph structure the UI layer (`src/ui/ttree.ts`) lays out and renders.
Shares its genome/fold logic with Collect via `collectAlpha.ts` — this is what surfaced the
Advanced Collections registry bug fixed in `project_genome_naming_registry_fix.md` (T-Tree's dedup
pass exposed S_33+ folds that Collect's own per-row path hadn't been exercising).

| Export | Description |
|---|---|
| `adjustedLivesOf(fullEnc)` | Life count of a full encoding, adjusted the way the T-Tree pane displays it |
| `buildTTreeNeighbors(graph)` | Adjacency map (`nodeId → neighbor nodeIds`) over a built `TTreeGraph` |
| `layoutTTree(graph)` | Compute 2D layout positions (`TTreeLayout`) for every node in the graph |
| `toLatexMath(text)` | Render an encoding/genome string as LaTeX math for the paper-export path |

Key types: `TTreeEdgeKind` (`'required' \| 'bypass' \| 'extra'`), `TTreeNode`, `TTreeEdge`,
`TTreeGraph`, `TTreeResult`, `TTreeLayoutPos`, `TTreeLayout`. `TOKEN_LIFE` (plain-token → life
lookup) is generated from `stalks/tools/dump_token_life.cpp`'s output — see that tool's own doc
comment and `project_parallel_structure_refactor_backlog.md` item 6; treat it as derived data, not
hand-maintained.

---

## `src/ui/ttree.ts` — T-Tree side panel

| Function | Description |
|---|---|
| `initTTree()` | Wire up the T-Tree panel (search input, canvas layout, node click/hover) once; safe to call multiple times |

Everything else is internal: builds a `TTreeGraph` via `ttree.ts`/`collectAlpha.ts` from a typed
encoding, lays it out (`layoutTTree`), and renders it as a clickable node graph with edges styled
by `TTreeEdgeKind` (solid = required, dashed = bypass, dashed grey = extra — an "extra" edge is the
signal a candidate does NOT cleanly fold to the searched family). Includes the paper/LaTeX export
path (`toLatexMath`) and the dotted-line move-preview demo referenced in
`project_move_preview_hover.md`.

---

## `src/ui/collect.ts` — Collect window: genetic-code browser + Advanced Collections panel

| Function | Description |
|---|---|
| `markAlpha(enc)` | Substitute the display ALPHA glyph for the internal alpha token in an encoding string |
| `bracketDisplaySlash(enc)` / `paperDisplay(enc)` | Display-formatting helpers for bracketed left-side text (UI form vs. paper/LaTeX form) |
| `initCollect()` | Wire the search input + Collections panel once; safe to call multiple times (each open just re-renders) |

Everything else is internal (this file has grown substantially since the DisaPoint→ALPHA rework —
1500+ lines as of 2026-09-21). Two main flows:
- **Search**: `runSearch(raw)` analyzes a typed position encoding, classifies it via
  `collectAlpha.ts` (ALPHA-genome pipeline, not the old DisaPoint one), and builds the T-gene
  table (`renderRequiredLine`/`computeRowInfos`/`findBypassMatches`) — the same logic
  `stalks/tools/yellow_check.cpp` ports natively for offline cross-checking.
- **Advanced Collections panel**: browses the registered-family roster from
  `src/data/collectionsRoster.json` (generated by `stalks/tools/dump_collections_roster.cpp` from
  the native `collections.cpp` registry — regenerate after any native registry edit) and
  `collectAlphaGenomes.json`. For registry-only (S_33+) folder families with no bundled member
  list, the full genome is computed live on scroll-into-view (`IntersectionObserver` + a targeted
  single-header DOM patch, not a full re-render) — see `project_collect_collections_panel.md`'s six
  dated sections before touching this path; the member-size cap and tiny-folder filter documented
  there have twice been "confirmed removable" by scripted tests and twice been wrong per real user
  scrolling — don't remove either without live confirmation.

`history` (persisted to `localStorage` under `sprouts-collect-variations-v3`, seeded by
`seedDefaultHistory` on first load) backs the persistent variation list rendered by
`render()`/`renderDetail()`.

---

## `src/model/positionCache.ts` — In-memory position analysis cache

| Function | Description |
|---|---|
| `record(result)` | Cache a full `AnalysisOk` result keyed by canonical encoding |
| `recordEdge(parentCanon, childCanon)` | Record a parent→child edge in the cache's graph |
| `loadMasterSeed(url?)` | Fetch and seed the cache from a precomputed `master_meta.json` |
| `getFull(canon)` | Look up a cached full `AnalysisOk` by canonical encoding |
| `getMeta(canon)` | Look up cached `LightMeta` (cheaper partial info) by canonical encoding |
| `getParents(canon)` | Look up cached parent canonical encodings for a position |

Bump `FULL_KEY` (this file) whenever the `AnalysisOk`/`ChildInfo` shape changes — see memory
`feedback_cache_versioning.md`.

---

## `src/render/renderer.ts` — Canvas rendering

| Method | Description |
|---|---|
| `new Renderer(canvas)` | Initialize renderer; set up canvas context defaults |
| `.resize()` | Recalculate disk radius and center after window resize |
| `.toCanvas(p, camera)` | Project a sphere point to canvas coordinates using the active projection |
| `.render(state, camera, opts)` | Full render pass: region fills, edges, vertices, debug overlays (arrows, midpoints, IDs), pop burst animations, recreate hints, subregion highlight |
| `.resetRegionColors()` | Clear region hue map for a new game |
| `.renderEdgeSideHighlight(...)` | Highlight one side of an edge (used for enclosure move-code coloring) |

`RenderOptions` flags: `showProjection`, `showEncoding`, `showRegions`, `showMidpoints`,
`showVertexIds`, `showBoundaryArrows`, `showDualGraph`.

Notable private helpers: `drawHoverWedge`/`computeScabArc`/`drawHoverCircle` (scab wedge
rendering — see memory `project_scab_rendering.md`), `renderRecreateHints`,
`renderRegionNetwork`, `renderPop`, `computeRegionHues`, `renderRegionFills`,
`screenOuterRegion`, `boundarySphereLoop`/`boundaryPolygon`, `renderBoundaryArrows`,
`projectAdaptive` (adaptive edge subdivision near projection singularities),
`renderSubregionHighlight`.

---

## `src/input/inputHandler.ts` — Pointer input and stroke drawing

| Method | Description |
|---|---|
| `new InputHandler(opts)` | Set up input state machine with game-state reference and callbacks |
| `.pointerDown(px, py)` | Start rotation (empty canvas) or start drawing (near a vertex) |
| `.pointerDownRight(px, py)` | Right-click: begin dragging a vertex |
| `.pointerMove(px, py)` | Update rotation / extend stroke / move drag target |
| `.pointerUp(px, py)` | Commit move or end rotation |
| `.pointerCancel()` | Abort stroke, rotation, or drag |
| `.cancelDrag()` | Abort an in-progress vertex drag specifically |
| `.tick(dt)` | Update reject-animation timer |
| `.isDrawing()` / `.isRotating()` / `.isDragging()` / `.isRejecting()` | State query booleans |
| `.getRenderExtras()` | Return `{ grayedVertexIds, activeStroke, poisonPoint }` for the renderer |
| `.getDragTarget()` | Return the currently-dragged vertex and its target position, or null |
| `.toSpherePoint(px, py)` | Convert a canvas point to a sphere point under the active camera/projection |

Notable private helpers: `computeSpliceAngleDebug` (debug dump of dart splice angles),
`vertexAt`, `canStartFrom`/`canEndAt` (stroke endpoint legality), `computeGrayed`
(which vertices to gray out mid-stroke), `checkCrossing` (live crossing-guard test used
by both drawing and dragging), `startReject`, `clearDrawState`.

---

## `src/engine/stalks.ts` — WASM Stalks engine bridge

| Function | Description |
|---|---|
| `preloadModule()` | Kick off loading the WASM module ahead of first use |
| `canonSync(enc)` | Synchronous canonicalization (module must already be loaded) |
| `canonicalizeTrackedProvenanceSync(enc)` | Sync canonicalize that also returns per-token provenance (`TrackedProvenanceResult`) |
| `analyze(enc)` | Full async position analysis → `AnalysisResult` (`AnalysisOk` or `AnalysisErr`) |
| `analyzeFull(enc)` | Same as `analyze` but forces the full (non-quick) analysis path |
| `analyzeNimber(enc)` | Cheaper async analysis returning only the quick nimber → `QuickAnalysisResult` |
| `canon(enc)` | Async canonicalization, returns the canonical string |
| `applyMoveTracked(...)` | Apply a `MoveDescriptor` with token provenance tracked through to a `TrackedResult` |

Key types: `MoveInfo`, `ChildInfo`, `QuickCanon`, `QuickChildInfo`, `GraphNodeMeta`,
`AnalysisOk`/`AnalysisErr`/`AnalysisResult`, `QuickAnalysisOk`/`QuickAnalysisResult`,
`TrackedProvenanceResult`, `PosSrc`, `TrackedChild`, `MoveDescriptor`, `TrackedResult`.
Sentinels: `UNKNOWN_VALUE`, `GEN_SRC` (token generated by the move, no parent), `UNTRACKED`
(provenance not maintained for this token).

---

## `src/engine/occurrenceMap.ts` — Per-token provenance map

| Function / Class | Description |
|---|---|
| `OccIdAllocator` (class) | Allocates fresh, stable occurrence IDs (`OccId`) for tokens across moves |
| `seedFreshGame(spotVertexIds, alloc)` | Build an initial `OccurrenceMap` for a brand-new game |
| `seedFromGeometry(state, alloc)` | Build (or rebuild) an `OccurrenceMap` from the current geometric `GameState`, or null if it can't be matched |
| `carryForward(...)` | Carry occurrence IDs forward across a move, tagging the newly generated token |
| `tokenLocsForVertex(map, vid)` | Look up the `TokenLoc`s for a given vertex in the map |
| `regionBoundaryCount(map, component, region)` | Count boundary occurrences of a region within a component |
| `charInfoForMap(map)` | Build the `CharBinding[]` used to bind display characters to occurrence tokens |

Key types: `OccId`, `OccurrenceMap`, `TokenLoc`, `CharBinding`.

---

## `src/engine/faceCheck.ts` — Engine vs. geometry face-set soundness check

| Function | Description |
|---|---|
| `faceSetKey(faces)` | Canonical string key for a set of `Face`s, for equality comparison |
| `engineFaces(map)` | Extract the WASM engine's notion of faces from an `OccurrenceMap` |
| `geometryFaces(state)` | Extract faces from the geometric `GameState` (rotation-system regions) |
| `checkTopology(map, state)` | Compare `engineFaces` vs `geometryFaces`, return a `FaceCheckResult` (match/mismatch) |

Key types: `FaceCycle`, `Face`, `FaceCheckResult`.

---

## `src/engine/moveTranslation.ts` — Geometric move ↔ engine move translation

| Function | Description |
|---|---|
| `buildEnclosureMask(...)` | Build the occurrence-id mask describing which tokens an enclosure move covers |
| `translateMove(...)` | Translate a geometric move (vertex IDs + stroke) into a `LiveMoveResolved` engine-side descriptor |

Key types: `TokenLoc`, `LiveMoveResolved`.

---

## `src/engine/trackedGame.ts` — Tracked (engine-verified) game session

| Method | Description |
|---|---|
| `new TrackedGame(...)` | Set up a tracked session pairing geometric state with engine provenance |
| `.charInfo()` | Current `CharBinding[]` for display |
| `.reset(spotVertexIds)` | Reset tracking state for a new game |
| `.onMoveSettled(...)` | Called after a move settles; runs the engine check and updates status |
| `.markDesynced()` | Force status to `'desynced'` (engine/geometry can no longer be compared) |
| `.seedFromState(state)` | (Re-)seed the occurrence map from a geometric state; returns success |

Notable private helper: `enumerateDescriptors` (candidate move descriptors to try against
the engine when resolving a geometric move).

Key type: `TrackedStatus` (`'match' | 'mismatch' | 'indeterminate' | 'desynced' | 'disabled'`),
`TrackedResult`.

---

## `src/ui/positionBrowser.ts` — Position Browser side panel

| Function | Description |
|---|---|
| `setMoveCallbacks(cbs)` | Wire up callbacks for move-preview interactions (hover/lock/dblclick) |
| `setSyncCallbacks(cbs)` | Wire up callbacks for Sync-mode (follow live game position) interactions |
| `onSyncModeChange(cb)` | Register a listener fired when Sync mode is toggled |
| `isSyncMode()` | Whether the Sync toggle is currently on |
| `setSyncMode(on)` | Programmatically set Sync mode |
| `setSyncToggleEnabled(enabled)` | Enable/disable the Sync toggle control (e.g. gated until Play) |
| `display(enc)` | Render a canonical encoding string for display (compact-vs-decompressed, bracket/⊕ wrapping) |
| `onNavigated(cb)` | Register a listener fired when the browser navigates to a new position |
| `updateNavButtons()` | Refresh enabled/disabled state of the prev/next nav buttons |
| `ensureWired()` | Idempotently wire up all DOM event listeners for the panel |
| `openPositionBrowser(initialInput)` | Open the panel, seeded at a given encoding/position input |
| `notifyLivePosition(inputText)` | Push the current live game position into the panel (for Sync mode) |
| `isShowingLive()` | Whether the panel is currently showing the live game position |

Key type: `MovePreviewTarget`, `SyncCallbacks`.

---

## `src/ui/guide.ts` — In-game Guide window

| Function | Description |
|---|---|
| `initGuide()` | Wire up the Guide window (topic list + content pane) into the existing modal shell |

Topic content lives inline in this file (6 first-draft topics as of 2026-07-15).

---

## `src/ui/collect.ts` — Collect window: DisaPoint "genetic code" browser

| Function | Description |
|---|---|
| `initCollect()` | Wire the search input once; safe to call multiple times (each open just re-renders) |

Everything else is internal. Search flow: `runSearch(raw)` analyzes a typed position encoding
and builds one `Entry` per DisaPoint (via `computeEntry` → `lMoveNimbersRobust`/`computeTAndTPrime`
from `collectGenetics.ts`); `loadGenome(raw)` instead parses a `"({...},R,D)"` genome query and
bulk-loads every matching hit from `GENOME_DB` (`src/data/collectGenomes.json`, generated offline
by `stalks/tools/collect_genetics.cpp` — regenerate that JSON by re-running the tool against the
master `.sprout` saves) via `buildGenomeEntry`, deferring T/T' computation to `fillDetail` the
first time an entry is actually opened. `history` (persisted to `localStorage` under
`sprouts-collect-variations-v3`, seeded by `seedDefaultHistory` on first load) backs the
persistent variation list rendered by `render()`/`renderDetail()`.

---

## `src/debug/moveLog.ts` — Debug move logging

| Export | Description |
|---|---|
| `moveLog` (array) | Recorded move entries (each has snapshot of regions before/after + move details) |
| `beginTrace()` | Reset the active trace buffer for a new move |
| `trace(msg)` | Append a line to the active trace |
| `snapshotRegions(state)` | Serialize all living regions to a plain object for the log |
| `snapshotGraph(state, encoding)` | Serialize the full graph (vertices/edges + encoding) for the log |
| `recordMove(state, move, path, before)` | Append a completed move entry to `moveLog` |

Key types: `RegionSnapshot`, `GraphSnapshot`, `MoveLogEntry`.

---

## `src/debug/flags.ts` — Debug flags

| Export | Description |
|---|---|
| `DEBUG` | Central debug-flag object (toggled via the debug-unlock sequence in `main.ts`) |

---

## `src/dev/soundnessSweep.ts` — Engine/geometry soundness sweep

| Function | Description |
|---|---|
| `runSoundnessSweep(opts)` | Play out random games and diff engine vs. geometry face sets at every step, collecting `SweepMismatch`es into a `SweepResult` |

Key types: `SweepMismatch`, `SweepResult`.

---

## `src/main.ts` — Application entry point and game loop

Top-level setup: canvas, `Renderer`, `InputHandler`, `TrackedGame`, camera, undo/redo stack,
pop animations, pending collapse state, Move Sequence bar, Recreate/manual-move flow, tuning
panel, debug-unlock sequence, toggle checkboxes. No exports — everything below is internal.

Key internal functions (selected):
- `frameBody(now)` — one `requestAnimationFrame` tick: smooth → dead-region step → collapse step → iso-vertex elim → render
- `frame(now)` / `wake()` — animation-loop driver / reschedule (called after a move, resize, or undo)
- `checkForCollapses()` — scan for the next applicable collapse and set `pendingCollapse`
- `collapseVertices(c)` — run the step function for a detected `SpecialCollapse`
- `afterMoveCommitted(v1, v2)` — post-move pipeline: encode, label, log, update Move Sequence bar, schedule tracked check
- `scheduleTrackedCheck()` / `runPendingTrackedCheck()` — debounce and run the engine-vs-geometry check after a move
- `resyncTrackedFromHistory()` — rebuild engine tracking state by replaying move history (after undo/load)
- `precomputeChildrenMoves(targets)` / `synthesizeVerifiedMove(target)` — Position Browser move-preview stroke synthesis
- `runRecreate(seq)` — replay a parsed Move Sequence into the current position
- `promptManual(parsed, moveNum)` / `promptCandidates(parsed, moveNum)` / `verifyManualMove(v1, v2)` — manual (user-drawn) Recreate flow
- `undoLast(recordRedo?)` / `redoLast()` / `pushHistorySnapshot()` — undo/redo stack
- `updateMoveSeq()` / `moveSeqTokens()` / `moveSeqCopyText()` — Move Sequence bar (see memory `project_pb_panel_move_seq_bar.md`)
- `loadGameState(save)` / `resetGame(spots)` — load a save / start a fresh game
- `unlockDebugMode()` — debug-unlock keystroke sequence handler
- `renderTuningPanel()` — build the live tunables UI from `TUNABLE_SPECS`
- `wrapCanonDisplay(...)` / `buildExpandedEncoding(state)` — canon-display formatting helpers
- `showPlayGate()` / `hidePlayGate()` / `updatePlayGateWarningText()` — narrow-window / pre-Play gating
- `setPaused(paused)` / `waitForUnpause()` / `waitForFullSettle()` / `waitForCollapseDone()` — animation pause/settle coordination used by Recreate

---

## `src/voronoiTest.ts` — Standalone Voronoi test harness

No exports; a self-contained script for `voronoiTest.html` exercising `voronoiGraph.ts` /
`voronoiJunctionPath.ts` outside the main game UI (see memory `project_save_load_voronoitest.md`).

---

# Native debug/offline tools — `stalks/tools/*`

One-off and recurring CLI tools built on top of the Stalks C++ engine (`stalks/src/`), mostly for
the Advanced Collections / genome registry work. Each is a small `main()` linked against the real
engine headers — no WASM, no browser. Build via the native build (see
`reference_stalks_wasm_build_gotcha.md` for the emsdk-vs-native distinction; **never run a native
build while the Vite dev server is running** — see `reference_dev_server_vs_native_build_collision.md`).
Most have a detailed usage comment at the top of the file — read that before re-deriving a tool
that already does what you need (`feedback_streamline_not_duplicate.md`).

Shared headers (not standalone tools): `alpha_genome.hpp`/`.cpp` (single-alpha `(R,D,{L},{T'})`
genome classification, shared by the discovery/audit tools below), `double_crit_genome.hpp`/`.cpp`
(two-crit genome assembly, built on `alpha_genome.hpp`), `registry_audit_common.hpp`/`.cpp` (shared
TSV parse/write plumbing for the three `audit_registry_*`/`verify_registry_shrink` tools),
`genome_defs.generated.hpp` (generated — see Build scripts below, do not hand-edit).

## Advanced Collections registry: discovery (find new candidate families)

| Tool | Purpose |
|---|---|
| `find_yellow_candidates.cpp` | Scan `.spec` corpus files for single-alpha left sides whose genome matches a named family and aren't yet registered ("go yellow") |
| `find_yellow_candidates_structural.cpp` | Same, but enumerates candidates directly from the real structural game tree's own crit-finder instead of a pre-built `.spec` corpus (supersedes the corpus approach for reaching beyond ~4 real spots) |
| `unregistered_left_sides.cpp` | Report every quick-canon single-alpha left side (grouped by life count) not recognized by any registered collection |
| `unregistered_double_crit_regions.cpp` | Double-crit analogue of the above: candidate two-membrane regions not in `doubleCritRegistry()` |
| `double_crit_candidates_report.cpp` | For unregistered double-crit candidates, compute + group by genome text to spot shared families |
| `check_candidates.cpp` | Vet a manually-supplied candidate list (e.g. rows pulled from the Shue-pairings paper CSV) that never passed through the automated corpus scan |

## Advanced Collections registry: audit (is the registry itself minimal/correct?)

| Tool | Purpose |
|---|---|
| `audit_registry.cpp` | Re-check a roster of `family\tencoding` rows against CURRENT classification logic — which previously-registered elements would still be accepted |
| `audit_registry_redundancy.cpp` | For every registered element, check whether its OWN registry entry ever actually fires during `quickCanon()`, or if some other rule already reduces it first (redundant) |
| `audit_registry_necessity.cpp` | True leave-one-out audit: exclude one entry at a time and re-run `quickCanon()` — the correct successor to `audit_registry_redundancy.cpp`'s heuristic, which had a race-condition blind spot |
| `verify_registry_shrink.cpp` | Regression check after editing the registry: every original element (removed or not) must still reduce to the same (rep, offset) it did pre-edit |
| `check_ttree_extras.cpp` | Whole-T-Tree cross-check of `isYellowCandidate` — verifies every required/bypass-witness descendant is clean, not just the root |
| `find_child_parents.cpp` | Given a target T-child, report which candidate parents actually reach it as a real T-child (traces a specific data-integrity issue back to its source) |
| `probe_dupe_nodes.cpp` | Check a `.spec` file for duplicate-encoding nodes (should be zero after `merge_specs.cpp`) |
| `verify_left_side.cpp` | Vet a candidate against a family rep by direct exact-nimber comparison across several hosts — necessary but not sufficient; a T-gene check is the authoritative test |
| `nimber_vector.cpp` | Compute exact nimbers for a batch of left sides across several fixed hosts (e.g. to test for an offset-sibling relationship without knowing the offset in advance) |

## Genome computation

| Tool | Purpose |
|---|---|
| `collect_alpha_genetics.cpp` | Offline scan of `.spec` files for single-alpha positions; computes each one's genome via the engine's own movetype classification (feeds `collectAlphaGenomes.json`) |
| `genome_for_reps.cpp` | Full `(R,D,{L},{T'},[T])` genome text for an arbitrary list of reps (registered or not) — direct GameGraph solve per target, ~2s for a few hundred targets (replaced a corpus-scan version 2026-09-21, see `project_genome_renaming_tool.md`) |
| `double_crit_probe.cpp` | Dump raw per-child `(movetype1, movetype2)` classification pairs for a two-crit position — ground truth for the double-crit genome bucket mapping |
| `yellow_check.cpp` | Native port of `collect.ts`'s T-gene-table logic (`renderRequiredLine`/`findBypassMatches`), for cross-checking the browser app against native output before trusting it at scale |
| `explain_move.cpp` | Apply one tracked move and report whether a specific parent token survives into the child, via real provenance tracking |
| `query_movetype.cpp` | Dump every child of a position with its special-point movetype classification (Alpha movetype Phase 5 debug tool) |

## Data export (feeds committed JSON the TS side reads)

| Tool | Purpose |
|---|---|
| `dump_collections_roster.cpp` | Export the native registry (`collections.cpp`) to `src/data/collectionsRoster.json` — rerun after any registry edit |
| `dump_master_meta.cpp` | Merge exact + quick-mode `.sprout` master saves into the two JSON files that seed `positionCache`'s meta store at startup |
| `dump_token_life.cpp` | Emit `token_life.generated.json` (plain-token → life value) — single source of truth for `ttree.ts`'s `TOKEN_LIFE` table |
| `dump_child_nimbers.cpp` | CSV of every minimal node's nimber + per-nimber child counts, for a given spot count |
| `filter_collect_alpha_lives.js` | (Node, not C++) Filter the full `collect_alpha_genetics` output down to the life-count cap that actually ships in `collectAlphaGenomes.json` |

## Corpus / `.spec` file management

| Tool | Purpose |
|---|---|
| `save_spec.cpp` | Build an Exact GameGraph rooted at given encodings and save the combined reachable tree to a `.spec` file |
| `merge_specs.cpp` | Union several `.spec` corpora into one, by encoding, with no recomputation |
| `verify_spec_count.cpp` | Ground-truth BFS recount of a `.spec` file's reachable nodes, independent of `specfile.cpp` |
| `debug_spec_order.cpp` | Dump every minimal node + edges for inspecting `.spec` ordering bugs (found the `lives2()` can-increase-on-movetype-2 bug) |

## Misc research / one-off

| Tool | Purpose |
|---|---|
| `region_frequency.cpp` | Tally how often each distinct region shape occurs across the single-subposition quick-canon game tree |
| `quick_reduction_counts.cpp` | Count how many times each registered collection member actually fires as the applied `quickCanon` reduction ("mileage" per family) |
| `winning_tree.cpp` | Build the winning-game-tree view (N-positions keep only winning-move edges) over the exact or quick-canon graph |
| `query_position.cpp` | Ad-hoc: analyze one position encoding and dump its children |

---

# Build scripts — `scripts/*.cjs`

Node scripts (no native build needed) that keep the hand-authored JSON sources and their generated
derivatives in sync. Per `feedback_numeric_source_over_string_tables.md`: each JSON file below is
the ONE hand-edited source; everything else listed as "generated" is a mechanical derivation —
never hand-edit a `.generated.hpp` or JSON marked generated.

| Script | Purpose |
|---|---|
| `genGenomeDefsHeader.cjs` | `src/data/genomeDefs.json` → `stalks/tools/genome_defs.generated.hpp` |
| `genCollectionElementsHeader.cjs` | `src/data/collectionElements.json` → `stalks/src/collection_elements.generated.hpp` |
| `checkGeneratedHeaders.cjs` | CI-style check: fails if either generated header above is stale relative to its JSON source; wired into `npm run build` |
| `renameGenomes.cjs` | Rename Advanced Collections/genome families across both JSON sources and regenerate everything derived from them in one pass (`node scripts/renameGenomes.cjs <mapping.json> [--dry-run] [--skip-native]`) — built as a standing tool since family renames have happened multiple times (see `project_advanced_collections.md`, `project_genome_renaming_tool.md`) |
| `filterLives.cjs` | Quick filter pass over `master_meta.json` for encodings with life count 5-7 containing a DisaPoint — pure-JS port, no WASM needed |
