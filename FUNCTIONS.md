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
| `slerp(a, b, t)` | Spherical linear interpolation between a and b |
| `arcsCross(a0, a1, b0, b1)` | True if two spherical arc segments intersect |

---

## `src/math/intersect.ts` — 2D intersection helpers (canvas coordinates)

| Function | Description |
|---|---|
| `segmentIntersection(a, b, c, d)` | Parametric 2D segment intersection; returns crossing point or null |
| `strokeVsPolyline(strokeTip, polyline, skipLast?, skipFirst?)` | Test active stroke segment against a polyline; returns first hit or null |
| `signedArea(pts)` | Shoelace signed area of a canvas polygon (positive ⇒ clockwise, y-down) |
| `dist(a, b)` | Euclidean distance between two canvas points |
| `pointInPolygon(poly, p)` | Ray-casting point-in-polygon test (canvas coordinates) |

---

## `src/math/chaikin.ts` — Curve smoothing

| Function | Description |
|---|---|
| `chaikin(pts, iterations?)` | Corner-cutting Chaikin smoothing on a canvas-point polyline |

---

## `src/model/types.ts` — Core type definitions (no functions)

Key types: `VertexType` (enum), `VertexVisualState` (enum), `Vertex`, `Edge`, `BoundaryEntry`,
`Boundary`, `Region`, `GameState`.

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
| `applyMove(state, move)` | Apply a committed move: add midpoint vertex + two edges, then recompute regions |
| `recomputeRegions(state)` | Rebuild all regions/boundaries/subpositions from the planar embedding via rotation system; classify vertices; assign edge left/right regions |

`recomputeRegions` also inserts pseudo-vertices at parallel-edge arc midpoints (`pseudoHalf`
darts) so the rotation system orients exclusively-paired endpoints correctly. Exported helper
`edgePtsForEntry(entry, edge)` returns the slice of `edge.points` a boundary entry traverses —
the full edge for ordinary entries, or just the relevant half when `pseudoHalf` is set.

Key internal helpers: `entriesFromDarts` (dart cycle → boundary), `assignSides` (mark
`only`/`firstVisit`/`secondVisit`), `makeSafeProjection` (pick a camera-free projection
safe from singularities), `probeLeftInside` (point-in-polygon left-of-edge test),
`outerCycleFace` / `globalOuterId` (find the outer face), `buildSubpositions`
(group regions into subpositions by connected component), `classifyVertexByDegree`
(degree-only cache update; authoritative classification is `classifyVertexFull` in encoding.ts).

---

## `src/model/encoding.ts` — Position encoding (canonical invariant string)

| Function | Description |
|---|---|
| `canonicalEncoding(state)` | The canonical position string — topological invariant; used as gate for dead-region surgery |
| `encodePosition(state)` | Full encoding: returns `{ text, vertexSymbols }` where `vertexSymbols` maps vertex IDs to display characters |
| `classifyVertexFull(vid, state)` | Authoritative region-aware vertex classification (Spot/Appendage/Scab/Membrane/Joint/Dead) |

Internal pipeline: `assignMembraneLetters` → `buildVertexSymbols` → `buildRegionReprs` →
`applyAllCompressions` (DisaPoint, HollowPoint, Triplet, SplitPoint passes) →
`serialize` → `renameMembranesInOrder` → `canonicalize`.

---

## `src/model/moveCode.ts` — Move-sequence encoding

| Function | Description |
|---|---|
| `computeMoveCode(before, v1, v2, after)` | Encode a single move as a string (loXhi format; parallel-lens move uses the `[]` suffix, with optional split/enclosure brackets) |

---

## `src/model/smooth.ts` — Geometry smoothing and repulsion

| Function | Description |
|---|---|
| `smoothStep(state, shrinkDead?, extraSkip?)` | One frame of smoothing+repulsion. Returns true if still animating, false if settled |
| `smoothStepDrag(state, drag)` | Smoothing step during vertex drag; rolls back if the drag would create a crossing |
| `resampleEdge(e)` | Resample edge to a point count proportional to arc length |
| `resampleEdgeToCount(e, targetCount)` | Force edge to an exact point count |
| `edgeRepellers(state)` | Returns invisible repeller points for parallel edges (one midpoint each) and self-loop edges (1/3 and 2/3 points). Used by both `repulsionStep` and the renderer's debug overlay |

Tuning constants (all in the const block at top of file):
`LAPLACIAN_STRENGTH`, `REPULSION_RADIUS`, `VERTEX_REPULSION_STEP`, `SAMPLE_REPULSION_STEP`,
`TIGHTENING_STEP`, `DRAG_ATTRACTION_STEP`, `TIGHT_ANGLE_THRESHOLD`, `TIGHT_ANGLE_STEP`,
`CO_REGION_BOOST` (4× repulsion for co-boundary vertex pairs), `CO_REGION_RADIUS`
(wider ~40° reach for those pairs), `SETTLE_EPSILON`.

---

## `src/model/deadRegions.ts` — Dead-region elimination (shrink + pop)

### Detection / step functions (called each frame from `main.ts`)

| Function | Description |
|---|---|
| `fullyDeadVertexIds(state)` | Set of all vertices in fully-dead connected components (used by smooth.ts to skip them) |
| `deadRegionStep(state, skip?)` | One frame: shrink fully-dead components toward centroid; pop when small enough. Returns `{ moving, popped, popCentroids }` |
| `eliminateIsolatedVertex(state, skip?)` | Splice out one degree-2 dead vertex between two non-bigon neighbors; returns pop position or null |
| `scabAloneCollapse(state)` | To fixpoint: for each dead boundary with exactly one live vertex (a scab), delete the dead neighbors and create a self-loop edge on the scab |

### Collapse animators (each is a detect + step pair)

| Detector | Step | Topology |
|---|---|---|
| `detectLouse(state)` | `louseCollapseStep(state, collapse)` | Theta-graph: 2 degree-3 vertices + 1 degree-2, 4 edges, 3 dead regions |
| `detectParallelDead(state)` | `parallelDeadStep(state, collapse)` | Bigon: 2 degree-3 vertices connected by exactly 2 parallel edges, each with one degree-2 pendant |
| `detectTriangleDead(state)` | `triangleDeadStep(state, collapse)` | Triangle: 3-vertex dead boundary, each vertex with one external edge |
| `detectQuadDead(state)` | `quadDeadStep(state, collapse)` | Quadrilateral: 4-vertex dead boundary; collapses to 2 new vertices + 5 edges |
| `detectBigonTip(state)` | `bigonTipStep(state, collapse)` | Degree-2 vertex hanging off a degree-3 vertex where both edges go to the same neighbor |
| `detectEnclosedTriangle(state)` | `enclosedTriangleStep(state, collapse)` | Triangle with one vertex also connected to external graph |
| `detectSelfConnectedDead(state)` | `selfConnectedDeadStep(state, collapse)` | Dead S–T pair where S is degree-3 with a self-loop plus one edge to dead vertex T (case A: T has two external edges; case B: T is also self-connected) |

---

## `src/render/renderer.ts` — Canvas rendering

| Method | Description |
|---|---|
| `new Renderer(canvas)` | Initialize renderer; set up canvas context defaults |
| `.resize()` | Recalculate disk radius and center after window resize |
| `.toCanvas(p, camera)` | Project a sphere point to canvas coordinates using the active projection |
| `.render(state, camera, opts)` | Full render pass: region fills, edges, vertices, debug overlays (arrows, midpoints, IDs), pop burst animations |
| `.resetRegionColors()` | Clear region hue map for a new game |

`RenderOptions` flags: `showProjection`, `showEncoding`, `showRegions`, `showMidpoints`,
`showVertexIds`, `showBoundaryArrows`, `showDualGraph`.

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
| `.tick(dt)` | Update reject-animation timer |
| `.isDrawing()` / `.isRotating()` / `.isDragging()` / `.isRejecting()` | State query booleans |
| `.getRenderExtras()` | Return `{ grayedVertexIds, activeStroke, poisonPoint }` for the renderer |
| `.getDragTarget()` | Return the currently-dragged vertex and its target position, or null |

---

## `src/debug/moveLog.ts` — Debug move logging

| Export | Description |
|---|---|
| `moveLog` (array) | Recorded move entries (each has snapshot of regions before/after + move details) |
| `beginTrace()` | Reset the active trace buffer for a new move |
| `trace(msg)` | Append a line to the active trace |
| `snapshotRegions(state)` | Serialize all living regions to a plain object for the log |
| `recordMove(state, move, path, before)` | Append a completed move entry to `moveLog` |

---

## `src/main.ts` — Application entry point and game loop

Top-level setup: canvas, `Renderer`, `InputHandler`, camera, undo stack, pop animations,
pending collapse state, toggle checkboxes.

Key functions (all internal):
- `frameBody(now)` — one `requestAnimationFrame` tick: smooth → dead-region step → collapse step → iso-vertex elim → render
- `checkForCollapses()` — scan for the next applicable collapse and set `pendingCollapse`
- `wake()` — reschedule the animation loop (called after a move, resize, or undo)
- `newGame(n)` — reset state for an n-spot game
