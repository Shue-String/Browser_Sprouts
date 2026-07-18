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

Pseudo-vertex fields (parallel-edge orientation fix; see memory `project_pseudo_vertices.md`):
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
| `resampleEdgeToCount(e, targetCount)` | Force edge to an exact point count |

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
