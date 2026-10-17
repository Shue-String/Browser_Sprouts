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
| `sphereAngle(a, b)` | Great-circle angular distance (radians, [0, π]) |
| `dot` / `cross` / `add` / `scale` / `chord2` | Vector helpers; `chord2` = squared chord distance (cheap "same point?" / broad-phase test) |
| `tangentFrame(n)` | Orthonormal tangent basis (e1, e2 = n × e1) at a unit point — every bearing / small-circle / stereographic construction uses it |
| `fibonacciSphere(count)` | Near-uniform points on the sphere (golden-angle lattice) |
| `polylineLength(pts)` / `resamplePolyline(pts, count)` | Geodesic length of a polyline / resample to `count` points evenly by arc length (endpoints exact). Moved here from smooth.ts/smoothGeometry.ts 2026-10-12 |
| `arcsCross(a0, a1, b0, b1)` | True if two spherical arc segments intersect. Never reports the antipodal "ghost" intersection (checked on 2M random pairs, 2026-10-12), so callers need no hemisphere/midpoint guard — the old per-caller guards were removed |
| `arcsProperlyCross(a0, a1, b0, b1)` / `polylinesProperlyCross(a, b)` | THE "does this polyline cross that one" test: segments meeting at a shared end point (`SAME_POINT2`) are skipped as a PAIR, never by skipping whole end segments (which hid real crossings near a vertex). Used by `strokeCrossesEdges`, smooth.ts's crossing guards, `routeHarness.ts`'s `edgeCrossings` |
| `segCrossesPolylineSphere(...)` | Test a single arc segment against a sphere polyline |

---

## `src/math/unionFind.ts` — Disjoint sets

| Export | Description |
|---|---|
| `UnionFind<K>` | Disjoint-set forest over arbitrary keys (path compression; keys added on first use): `find`, `union`. Shared by moves.ts, moveRouter.ts and deadRegions.ts (each used to have its own) |

---

## `src/math/sphereDelaunay.ts` — Spherical Delaunay triangulation

| Function | Description |
|---|---|
| `sphericalDelaunay(pts)` | Delaunay triangles (+ circumcenters) of points on the unit sphere, as their 3D convex hull: incremental, Morton-ordered insertion with a walking locator (~O(n log n); 20k points ≈ 0.2 s). Visible region grown connected from the located face; a point whose horizon isn't one simple cycle is skipped, so near-cocircular input can't fold the surface. Callers jitter exactly cocircular sets (see moveRouter's `jittered`) |

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
| `addEdge(state, v1, v2, points)` / `deleteVertices(state, ids)` | Graph-surgery helpers shared by the collapses and the physics: add an edge (regions left for `recomputeRegions`) / delete vertices plus every edge touching them |
| `anchorEdge(state, e)` / `pointsFrom(e, from)` | Snap an edge's end points onto its vertices / an edge's points oriented to start at an endpoint (not for a self-loop) |
| `syncPseudoVertices(state, edgeIds?)` | Put pseudo-vertices back on their edge's index-midpoint |

---

## `src/model/moves.ts` — Move application and rotation-system face recomputation

| Function | Description |
|---|---|
| `entryIsForward(entry, edge)` | Does this (non-pseudo-half) boundary entry walk its edge v1→v2? Reads `BoundaryEntry.selfLoopRev` — a raw self-loop's two faces can't be told apart by endpoints. Use it instead of `edge.v1 === entry.vertexId` |
| `edgePtsForEntry(entry, edge)` | Slice of `edge.points` a boundary entry traverses — full edge for ordinary entries (direction from `entryIsForward`), or just the relevant half when `pseudoHalf` is set |
| `applyMove(state, move)` | Apply a committed move: add midpoint vertex + two edges, then recompute regions |
| `strokeMidIndex(stroke)` | Index of the stroke sample nearest its arc-length midpoint, where `applyMove` puts the new spot |
| `bearingFrom(from, to)` | Compass bearing from one sphere point to another |
| `pointAtBearing(from, bearing, dist)` | Sphere point reached by walking a bearing/distance from `from` |
| `stablePt(pts, startIdx, dir)` | Pick a numerically stable reference point along a polyline for tangent/bearing math |
| `recomputeRegions(state)` | Rebuild all regions/boundaries/subpositions from the planar embedding via rotation system; classify vertices; assign edge left/right regions; inserts pseudo-vertices (see `types.ts` notes) |
| `polyFromEntries(...)` | Build a sphere-point polygon from a boundary's entries |
| `makeSafeProjection(state, pole?)` | Camera-free stereographic projection from `safeProjectionPole` (2D area tie-breaks only) |
| `safeProjectionPole(state)` | The direction farthest from every vertex — the projection's point at infinity; `recomputeRegions` also uses it to decide which side of each face cycle is bounded |

Key internal helpers: `entriesFromDarts` (dart cycle → boundary), `assignSides` (mark
`only`/`firstVisit`/`secondVisit`), `loopFromDarts` (a face cycle's 3D loop in walk direction —
unlike `boundarySphereLoop`/`edgePtsForEntry`, gets a raw self-loop edge's reverse dart right),
cycle handedness = `!loopsNearestFeature([loop3], pole).inside` (exact; replaced the 2D
`probeLeftInside` vote 2026-10-03, which misread loops projecting to a few pixels),
`containingFace` / `faceOfCycle` (each outer cycle resolved once to the smallest bounded face of another
component that contains it, else the global outer face; `outerCycleFace` was removed 2026-10-12),
`Dart.forward` (walks along `edge.points` — THE dart direction convention; never derive it from
origin/head, which can't tell a self-loop's two darts apart), `SpliceSlot.after = {edgeId, forward}`
(`computeSpliceSlots`: the old dart a new dart is inserted after, named by edge AND direction since a
self-loop's two darts share one edge; null at a degree-0 vertex), `buildSubpositions`
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
| `trackedLayout(state)` | "Which board vertex is each canonical token": the engine's canonical spelling of the DECOMPRESSED live encoding with every token traced to its live vertex/edge — `comps` ([component][region][boundary][token] → `TokenInfo`) and per-character `charInfo` (separators and `N` carry none). THE one walk of `canonicalizeTrackedProvenanceSync`'s output (used by `resolveViaProvenance`, occurrenceMap.ts, main.ts's encoding-bar hover); null until the engine loads. Its per-component walk also fixed the `wrapCanonDisplay` hover misalignment after a `⊕` |
| `classifyVertexFull(vid, state)` | Authoritative region-aware vertex classification (Spot/Appendage/Scab/Membrane/Joint/Dead). A degree-2 vertex visited twice in one walk: Joint if both arcs of that walk hold a live vertex, Scab if one does — or, when neither does, if the face's OTHER boundaries do (a distal scab; until 2026-10-16 this case read Dead, so e.g. a join next to a lone spot encoded `0+0+0,0` instead of `0+0,0+0,2`) |
| `resolveMoveVertices(state, move)` | Resolve a `MoveInfo` move descriptor to concrete `ResolvedMoveVertices` against a given state. First tries `resolveViaProvenance` (exact: the engine's own `canonicalizeTrackedProvenance` of the decompressed encoding, used for any component canon spells identically decompressed); otherwise the TS re-derivation, with engine component → live subposition matched by each subposition's own canon (`liveComponentIndex`) |

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
| `findEnclosedSideRegion(...)` | Locate the region enclosed on one side of an enclosure-style move. Self-loop at an appendage tip: always the face bounded by the loop alone (the tail's face is a different position); at a bare spot: the face holding sub-boundaries; when BOTH faces hold nameable ones (2026-10-16), `bareSpotSideByName` — fewer of them first, then bracket names closer to -1 (it used to be "first in region order", a drawing artifact that also decided which interchangeable spots took the best labels, so a replay of the same loop could record a different labelled token). Two-endpoint split (2026-10-13): `bracketSideByName` — the new face whose endpoint-to-endpoint arc, read from the smaller-key endpoint, is lexicographically smaller by `key` (label when labelled, raw id otherwise); mirror-invariant. Falls back to the orientation-based lo→hi arc (joint-subscript patterns, then `forwardArc`) only when both arcs read identically. Callers pass the token's own key: `buildBrackets`, and vertexLabels' `findEnclosedSpots` (so labels' enclosed side = bracket side) |
| `computeEnclosureSideColoring(...)` | Build the two-side region coloring used for enclosure move-code brackets |
| `computeEnclosureCoverage(...)` | Determine which vertices/regions an enclosure move's bracket covers |
| `bracketRepOf(boundary, state)` / `inBrackets(boundary, state, brackets)` | THE bracket rule: a `[s,…]` bracket names a sub-boundary by its lowest VISIBLE vertex (never a pseudo-vertex or a Dead-classified one the encoder doesn't emit); `inBrackets` asks whether a boundary is one a raw-id bracket list names. Every reader of a bracket list (moveCode, recreate, strokeSynthesis, subregionHighlight) goes through these |
| `findOccurrence(entries, vid, sub)` | Index of `vid` in a boundary walk, the joint subscript `sub` (the vertex after the wanted occurrence) picking which visit |
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
| `rawResolvedMove(move)` | A raw-ID (unlabelled) `ParsedMove` as a `ResolvedMove` (labelled ones go through `resolveLabelledMove`) |

Key types: `BracketEntry`, `ParsedMove`, `ResolvedMove` (a `ParsedMove` with brackets/parens
resolved to concrete vertex IDs), `ParsedSequence`.

---

## `src/model/smooth.ts` — Geometry smoothing and repulsion

| Function | Description |
|---|---|
| `resetActivityTimer(holdMs?)` | Reset the force-winddown idle timer (keeps physics running for `holdMs` after activity, then a 3 s fade to zero). Armed on move commit, drag, and save load — an un-armed timer means full forces forever |
| `getForceScale()` | Current force multiplier, ramped down by the winddown timer once idle |
| `smoothStep(state, shrinkDead?, extraSkip?)` | One frame of smoothing+repulsion. Returns true if still animating, false if settled |
| `edgeRepellers(state)` | Returns invisible repeller points for parallel edges (one midpoint each) and self-loop edges (1/3 and 2/3 points). Used by both the repulsion step and the renderer's debug overlay |
| `smoothStepDrag(state, drag)` | Smoothing step during vertex drag; rolls back if the drag would create a crossing |
| `resampleEdge(e, index)` (internal) | Resample edge to a point count proportional to arc length. A result that newly crosses another edge is retried at 2x/4x points, else the old points are kept (chords across a tight bend used to slice neighbouring edges) |
| `resampleAllEdges(state)` | Guarded resample of every edge — use instead of looping `resampleEdge` |
| `pointMoveCrosses(index, e, i, next)` (internal) | Crossing guard for interior edge-point moves (redistribute, Laplacian, sample repulsion/tightening); rejects a move only if it creates a crossing the current position doesn't already have |
| `redistributePoints(pts, accept?)` (internal) | Even arc-length respacing. In smoothStep it is ALL OR NOTHING: if any point fails `pointMoveCrosses` (or the new polyline newly crosses another edge) the edge keeps its spacing that frame. Per-point refusal left points out of order and folded the edge into zig-zags, worst on external edges a deflating collapse grows each frame |
| `SegmentIndex` (internal class) | Uniform 3D grid of edge segments (padded by arc sagitta) behind the crossing guards, so a query tests only nearby segments; built per phase, `refresh(e)` after an edge's points move, the edge being moved is scanned directly. Without it the guard made smoothStep ~6x slower (quadratic in points) |
| `enforceClearance(state, skip, dragId)` (internal) | Hard minimum spacing after the forces: vertex >= `tunables.edgeClearance` from every non-incident segment, vertices >= 2x that apart; shared between the parties, dragged vertex never moved, dead (`skip`) and pseudo vertices exempt, every move behind the crossing guards |
| `SegmentIndex.sweepsSpot` / `pointMoveCrosses` | Edge-point moves also rejected when they would sweep over an isolated spot (a lone spot has no edges to fence it in) |
| `interiorTargets(e, vertices)` / `edgeNeedsResample` (internal) | Point count an edge should have: arc-length ideal, raised by `refinementSpacing` (smoothGeometry.ts) near non-attached vertices. The net-bend trigger (`curveRefineAngle`) is OFF by default: on, Recreate replays 14/40 sweep games faithfully vs 37/40 |
| `src/model/smoothGeometry.ts` | `nearestOnArc(p,a,b)` nearest point on an arc + distance; `distanceToArc(p,a,b)` its distance-only fast path for hot clearance queries (the router's wall index — with `nearestOnArc` there the router is ~47% slower); `refinementSpacing`. `polylineLength` now lives in `math/sphere.ts` |

Tuning constants live in `src/model/tunables.ts` (see below), not inline in this file anymore.

---

## `src/model/tunables.ts` — Live-adjustable physics/UI constants

| Export | Description |
|---|---|
| `Tunables` (interface) | Shape of the tunable constant set (repulsion radii, step sizes, thresholds, etc.) |
| `DEFAULT_TUNABLES` | Factory defaults |
| `tunables` | The live, mutable tunable object smoothing/rendering code reads from |
| `TunableSpec` / `TUNABLE_SPECS` | Metadata (label, min/max/step, optional panel `column`) driving the in-app tuning panel |
| `*Speed` keys (`deadShrinkSpeed`, `louseSpeed`, `parallelDeadSpeed`, `tripleParallelDeadSpeed`, `triangleDeadSpeed`, `quadDeadSpeed`, `enclosedTriangleSpeed`, `bigonTipSpeed`, `selfConnectedDeadSpeed`) | Per-collapse animation speed multiplier (1 = the original hard-coded pace, default 0.5), one per step function; panel column 2. Slerp steps go through `scaledStep` (`1-(1-s)^speed`), deflations advance `nextDeflateDepth`'s frame by `speed`, quad/enclosed-triangle scale their `t` delta |
| `loadTunables()` | Load saved overrides from localStorage into `tunables` |
| `saveTunables()` | Persist current `tunables` to localStorage |
| `resetTunables()` | Reset `tunables` back to `DEFAULT_TUNABLES` |

---

## `src/model/deadRegions.ts` — Dead-region elimination (shrink + pop)

### Detection / step functions (called each frame from `main.ts`)

| Function | Description |
|---|---|
| `detectSpecialCollapse(state)` / `stepSpecialCollapse(state, c)` / `specialCollapseVertices(c)` | The collapse registry (`COLLAPSE_KINDS` + `DETECT_ORDER`): the next special collapse to animate (first matching kind in priority order — louse, parallel-dead, triple-parallel-dead, triangle-dead, enclosed-triangle, quad-dead, bigon-tip, self-connected-dead), one frame of it (`label` names it for the trace), the vertices it owns. `SpecialCollapse` is the union of the per-kind interfaces below. main.ts and the headless drivers call only these three |
| `takeEncodingGateRefusal()` | Read-and-clear: did a surgery's encoding gate (`commitIfEncodingPreserved`) roll back an encoding-CHANGING surgery since the last call — i.e. a collapse bug, not an engine-not-loaded hiccup. main.ts's `revertIfCollapseRefused` acts on it. Test hook: `DEBUG.failNextCollapseGate` |
| `fullyDeadVertexIds(state)` | Set of all vertices in fully-dead connected components (used by smooth.ts to skip them) |
| `deadRegionStep(state, skip?, focus?)` | One frame for ONE fully-dead component (the `focus` one first, jammed/refused ones passed over): shrink toward centroid, pop when small enough. Returns `{ moving, popped, popCentroids, focus }`; main.ts feeds `focus` back so a component runs to its pop before the next starts |
| `eliminateIsolatedVertex(state, skip?)` | Splice out one degree-2 dead vertex between two non-bigon neighbors; returns pop position or null |
| `scabAloneCollapse(state, skipVertices?)` | To fixpoint: for each dead boundary with exactly one live vertex (a scab), delete the dead neighbors and create a self-loop edge on the scab. Skipped when a pocket of the structure that would merge into the scab's face holds anything alive (`holdsNothingAlive`), or when a deleted edge off the retraced loop bounds a live face (e.g. a second dead-dead edge wrapping round another component: game-equivalent, but the component would jump out of its enclosure). Runs only while Collapsing is on |

### Collapse animators (each is a detect + step pair)

| Detector | Step | Topology |
|---|---|---|
| `detectLouse(state)` | `louseCollapseStep(state, collapse)` | Theta-graph: 2 degree-3 vertices + 1 degree-2, 4 edges, 3 dead regions |
| `detectParallelDead(state)` | `parallelDeadStep(state, collapse)` | Bigon: 2 degree-3 vertices connected by exactly 2 parallel edges, each with one external edge. Animated by deflate-in-place (below); pop joins X-P + Q-Y into one X-Y edge (self-loop if X = Y) |
| `detectTripleParallelDead(state)` | `tripleParallelDeadStep(state, collapse)` | Three parallel edges between two degree-3 vertices, >=2 faces dead. Deflates in place: `tripleConfigs` picks which face stays (the other two must be EMPTY — only P,Q on their boundary; the first step tries each valid choice, since a near-whole-sphere disc can fail to mesh) and the disc bounded by the other two edges deflates with the middle edge carried along. Refused pop restores the pre-finish geometry |
| `detectTriangleDead(state)` | `triangleDeadStep(state, collapse)` | Triangle: 3-vertex dead boundary, each vertex with one external edge. Animated by deflate-in-place (below); pop re-roots B/C external edges at A on the centre |
| `detectQuadDead(state)` | `quadDeadStep(state, collapse)` | Quadrilateral: 4-vertex dead boundary; collapses to 2 new vertices + 5 edges |
| `detectBigonTip(state)` | `bigonTipStep(state, collapse)` | Degree-2 vertex hanging off a degree-3 vertex where both edges go to the same neighbor |
| `detectEnclosedTriangle(state)` | `enclosedTriangleStep(state, collapse)` | Dead triangle A-B-C where only A has a true external edge and B, C's other edge is a second B–C edge (a bigon); shrinks toward A by one homothety, pop makes a self-loop on A. Requires the bigon's far face F1 dead AND empty (2026-10-12: `failureSaves/fail-s4-g11-m11.json` step 11 had a whole component nested in F1; the shrink dragged BC1/BC2 across it and the gate refused every pop) |
| `detectSelfConnectedDead(state)` | `selfConnectedDeadStep(state, collapse)` | Dead S–T pair where S is degree-3 with a self-loop plus one edge to dead vertex T (case A: T has two external edges; case B: T is also self-connected). Animation (2026-10-13): S (and T, case B) RIDE the S–T edge frozen as a track (`scdAnimFor`/`trackPointAt`); the edge is the uncovered stretch; each loop is carried heading-relative (`loopShape`/`carryLoop`), shrunk with the gap and capped at 0.7× its vertex's clearance, halved while it crosses anything, and replaced by a `wedgeTeardrop` in its own wedge when halving can't clear a sphere-wrapping loop. Replaced a straight slerp that dragged curved S–T edges across other structure |

**Empty-face guards** (2026-10-12): a collapse never shrinks a face away or merges it into another unless that face is
empty — anything nested in it would be swept over or change face, and the gate would refuse (which now switches
Collapsing off). Animated collapses use the strict `faceIsEmpty` (one boundary: the shrink drags edges across even dead
content): enclosed-triangle's F1, bigon-tip's bigon face, self-connected-dead's self-loop insides (`selfLoopInsideFace`),
and for whole-component deletions (louse, `deadRegionStep`) `deletableComponent` — at most one of the component's faces
may hold anything. The instant scab uses the weaker `holdsNothingAlive` (dead-only content is invisible to the
encoding); over every scab in the test saves it rejects exactly the ones the gate refuses (3996 of 3996) and none it
accepts (11 of 11). Deflate-in-place collapses (parallel, triangle, triple) and quad only ever eliminate their own
already-empty face.

Each `Collapse` type above (`LouseCollapse`, `ParallelDeadCollapse`, `TripleParallelDeadCollapse`,
`TriangleDeadCollapse`, `QuadDeadCollapse`, `BigonTipCollapse`, `EnclosedTriangleCollapse`,
`SelfConnectedDeadCollapse`) is also exported as an interface describing the detected shape
passed from `detectX` into `xStep`.

**Deflate-in-place** (shared by `parallelDeadStep`, `triangleDeadStep` and `tripleParallelDeadStep`; the dead face shrinks onto a point
inside itself via `faceDeflate.ts`, external edges are EXTENDED each frame along their vertex's track so
smoothing keeps relaxing the surrounding structure during the collapse): `startDeflate` (snapshot the face
loop + optional external edges + optional interior edges, build the map), `nextDeflateDepth` (eased depth schedule), `deflateTo` (lay out
vertices/boundary edges/external-edge growth at depth r), `deflateRadius` (pop test). Pops hold until
`canonReady()` so the encoding gate can always run.

**One collapse at a time** (main.ts): `pendingCollapse` (special) and `generalCollapseFocus` (deadRegionStep's
component) are mutually exclusive (`collapseActive()`); `checkForCollapses` does nothing while either runs and is
re-run when a general shrink ends. The instant surgeries (`scabAloneCollapse`, `eliminateIsolatedVertex`) are not
queued. `window.__sprouts.collapse` reports the active one.

**Refused surgery** (main.ts `revertIfCollapseRefused`, after every surgery path): when `takeEncodingGateRefusal()`
reports a real refusal, the refused surgery is already rolled back; if it was the special collapse that just finished,
the board also goes back to `collapseSnapshot` (taken at detection — the animation moved geometry the gate's rollback
doesn't cover). Then Collapsing is switched off and `#collapse-off-note` shows. Every surgery, the scab included, runs
only while Collapsing is on, so once off nothing re-fires it.

Key internal helpers: `occupiedCentroidAntipode` (steering waypoint away from the occupied side
of the sphere, used by `quadDeadStep`), and a shared path-deformation group used by
`quadDeadStep`/`enclosedTriangleStep` to retrace real (frozen-at-detection) edges instead of slerping
toward a fresh target each frame: `pointAlongPath` (point at a fractional position along a frozen path),
`pathSlice` (sub-range of a frozen path, for the still-unreeled portion), `deformPreservingOffset`
(re-anchor a frozen path's shape to a live, possibly-waypoint-bent chord — see memory
`project_dead_region_elimination.md`), `shrinkTowardAnchor` (enclosedTriangleStep: a homothety about A in
the stereographic chart centred on A's external neighbour).

---

## `src/model/faceDeflate.ts` — Crossing-free "deflate in place" map for a dead face

Meshes the face (stereographic chart with the pole outside it; ear clipping → constrained Delaunay →
centroid refinement), then embeds the mesh onto a convex polygon inscribed in the unit circle with Floater
mean-value weights (injective by Floater/Tutte for ANY face shape). Deflation at depth r = H⁻¹(r·polygon):
nested curves, non-crossing tracks, and the face side is chosen by an `outside` point, never by area — so a
dead face covering most of the sphere works like a small one. (A conformal/zipper map was tried first;
crowding breaks it on thin sliver faces.)

| Function | Description |
|---|---|
| `stereoChart(pole)` | Stereographic chart `{fwd, inv}` projecting from `pole` (also used by `deadRegions.ts`'s `shrinkTowardAnchor`) |
| `buildFaceDeflation(loop, outside)` | Build the map for the face bounded by `loop` on the side away from `outside`; returns `thetas` (boundary angle per loop point) + `center`, or null if degenerate |
| `deflatePoint(def, theta, r)` | Point at depth r on boundary point theta's track |
| `diskBoundaryPoint(def, theta)` / `diskPointOf(def, p)` / `deflateInteriorPath(def, disk, r)` | Carry a curve lying INSIDE the face through the deflation: H of its points once (boundary ends by angle, interior points by chart barycentrics), then the scaled disk path traced exactly at each depth |
| `deflateArc(def, theta0, theta1, r)` | Deflated boundary between two angles, traced EXACTLY through the piecewise-linear map (a point per mesh-edge crossing, so chords can't clip neighbouring tracks) |
| `deflateTrack(def, theta, r0, r1)` | A boundary point's track between two depths, traced exactly |

---

## `src/model/moveRouter.ts` — Topological move router (side-aware Voronoi bisector)

Draws a stroke for a fully specified move, correct by construction. Seeds sampled along every
boundary dart of the face, offset INTO it (so the two sides of an edge are distinct seeds), plus
tight corner arcs and spot rings → spherical Delaunay mesh refined with medial circumcenters and an
open-space lattice, cut to in-face triangles → seeds labeled IN (a→c arc + `withArc` boundaries) /
OUT, interior points by nearest seed → corridors relabeled until each side is one piece → the
IN/OUT frontier traced through the mesh (zero crossing of dIN−dOUT) → coarse topology-preserving
smoothing. Joins (two different boundaries) are a clearance-weighted shortest path instead.

| Function | Description |
|---|---|
| `routedCandidates(state, parsed)` | One stroke per reading of a `ResolvedMove` (each live face holding both endpoints × each corner of a joint endpoint × the bracketed boundaries on either side of the lo→hi arc); the caller verifies |
| `routeSpecsFor(state, parsed)` | Those readings as `RouteSpec`s grouped by face (for debug tools) |
| `faceMeshFor(state, region)` | Memoized `buildFaceMesh` (keyed by a whole-drawing fingerprint + the face's boundary walk) |
| `buildFaceMesh(state, region)` | Build a face's `FaceMesh` (move-independent: every corner with free valence gets a full arc) |
| `routeOnMesh(mesh, spec, diag?)` | Route one `RouteSpec` (`split` a→c with `withArc`, `a===c` for a self-loop; or `join`). `diag` gets labels/failure reason/partial trace |
| `meshPieceOf(mesh, corner)` | The connected mesh piece holding the most of a corner's seeds. `routeSplit` labels only that piece: a thin wedge at a junction (~20-35°) can leave its corner seeds as an island (every linking triangle crosses a wall), which as a "stray piece" used to fail every split in the face |

---

## `src/model/strokeSynthesis.ts` — Synthesizing a drawable stroke for a move

| Function | Description |
|---|---|
| `candidateStrokeStream(state, parsed)` | LAZY generator of candidate sphere-point strokes reproducing a parsed move (for Recreate/preview); each group is built only when iteration reaches it. Order: plain geodesic / round loop first when nothing must be enclosed, then `routedCandidates`, then the legacy bowed/Voronoi candidates. Every candidate passes through `withMidClearance`. First-hit callers (synthesizeMove, Recreate no-pause, PB hover/precompute) iterate this — simple moves then never build router meshes (~100 ms → <5 ms per move) |
| `withMidClearance(state, stroke)` (internal generator) | When a candidate's new spot (`strokeMidIndex`) would land within `MID_CROWDED` (0.04 rad) of an existing edge or spot (e.g. a geodesic beside a near-geodesic edge joining the same spots, or one passing over an intermediate spot), yields copies nudged off it to ~`MID_TARGET` (0.07 rad) before the original: same side first (same topology), then the far side. A nudge is kept only if it improves clearance. Helpers: `nearestObstacle`, `bumpStroke` (sin-tapered sideways push) |
| `candidateStrokes(state, parsed)` | `[...candidateStrokeStream()]` — for callers needing every candidate (Recreate pause-mode display, debug, scripts) |
| `smallCircleSelfLoop(v, hint, radius, sampleCount?)` | Synthesize a small-circle self-loop stroke at vertex `v`, biased toward `hint` |
| `enclosureCandidates(state, parsed)` | Candidate strokes specifically for enclosure-style moves |
| `strokeCrossesEdges(state, stroke, skipEdgeId?)` | Does the stroke cross or TOUCH any existing edge — spherical, camera-independent, via `arcsProperlyCross` (meeting at a shared vertex doesn't count; end segments ARE tested) plus `polylinesTouch` (within `STROKE_TOUCH` = 1e-4 rad away from the stroke's end vertices). 2026-10-12: the old endpoint-skip arguments are gone, every caller uses this one rule. 2026-10-13: touching added — a plain geodesic between two vertices already joined by a geodesic edge lay ON that edge, a zero-width face that relax then recomputed inside out (seed 11 game 23) |
| `junctionVoronoiCandidates(state, parsed)` (internal generator) | The last group of `candidateStrokeStream` for an enclosing move: subregion-highlight + Voronoi junction-graph route, then (self-loop) the Voronoi loop arcs re-run with the junction graph's clustered extra seeds. Absorbed the extra-seed loops that used to live in recreate.ts/main.ts (`candidateSelfLoopArcsWithSeeds` is no longer exported) |

---

## `src/model/recreate.ts` — Move-sequence replay verification

| Function | Description |
|---|---|
| `applyTrial(state, v1, v2, stroke)` | THE one "try a stroke" primitive: the position the stroke produces on a clone, or null if it crosses an edge (`strokeCrossesEdges`) or fails to apply. Used by `strokeReproduces` and main.ts's Position Browser canon checks |
| `synthesizeMove(state, parsed, useLabels?)` | First candidate (`candidateStrokeStream`) that `strokeReproduces`, or null. (The old `checkCrossings` argument is gone — the crossing test is always on, inside `applyTrial`) |
| `strokeReproduces(state, parsed, stroke, useLabels?)` | `applyTrial` + `appliedMoveMatches`: legal and records exactly as the target token |
| `appliedMoveMatches(before, after, lo, hi, token, useLabels?)` | Does an already-applied move record as `token` (labelled codes re-derived from the post-move labels, like live play)? At a bare spot either self-loop face's bracket is accepted (the faces are interchangeable); at an appendage tip only the loop-alone face. Also verifies hand-drawn moves |
| `computeRecreateHints(state, parsed)` | Build `RecreateHints` (highlight targets) shown while the user manually recreates a move |

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
| `labelledMoveCode(before, v1, v2, after)` | The labelled move code (needs `after.spotLabels` already recomputed). The ONE form a save's `moveSequence` stores — main.ts's recorder and every script that writes saves use it; a raw-id token in a save is kept by Load as if it were labelled and replays as a different move |

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
sync via each collection's `genome` field in `src/data/collectionElements.json` (the engine's answer for the rep, refreshed by
`scripts/refreshGenomes.cjs`) → read at runtime by `stalks/tools/genome_defs.cpp`, and →
`scripts/genCollectionGenomesJson.cjs` → `src/data/collectionGenomes.generated.json` (every genome; what this file reads). Do not hand-edit the generated files. Both sides build the fold/collision registry from
every genome whose T-genes are all collection names; a genome still holding a nested, unnamed T genome is display-only.
`COLLECTION_GENOME_TEXT` holds every collection's genome text.

| Export | Description |
|---|---|
| `isSingleAlpha(enc)` | True if a canonical encoding contains exactly one ALPHA special-point token |
| `shiftMembraneLetters(enc)` | Re-letter membranes so an embedded left-side text doesn't collide with a host's own letters |
| `genomeKey(R, D, L, Tprime)` | Canonical dedup key for a 4-gene `(R,D,{L},{T'})` genome bucket |
| `expandGenomeShorthand(input)` / `nameForShorthand(input)` | Parse/resolve a typed shorthand (e.g. a family name or `⊕n` offset form) in the Collect search box |
| `registryIndexReady` (promise) | Resolves once `buildRegistryIndex()` has finished folding the stored genomes into the in-memory `REGISTRY` |
| `registryFoldName(g)` | Resolve a `{quickEnc, quickOffset}` pair to its registered family name, if any |
| `COLLECTION_ROSTERS` | One `CollectionRosterEntry` per (collection, offset) group of `collectionElements.json` — the single in-memory read of that file; genomeCensus.ts and the lists below derive from it |
| `KNOWN_COLLECTION_MEMBERS` / `KNOWN_COLLECTION_REP` | Per-family member lists / representative encodings, derived from `COLLECTION_ROSTERS` (`KNOWN_COLLECTION_REP_RAW` was removed 2026-10-12) |
| `GENOME_NAMES` / `NAMED_FAMILY_GENOME_TEXT` / `NAMED_FAMILIES` / `COLLECTION_GENOME_TEXT` | The resolved family registry (name → genome text, full family records; `COLLECTION_GENOME_TEXT` covers every collection incl. display-only ones) |
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

## `src/ui/ttreeExport.ts` — T-Tree "Export Tables" bulk LaTeX dump

| Function | Description |
|---|---|
| `buildTTreeTablesLatex(graph, onProgress?)` | One compilable LaTeX document: a genome table (`collect.ts`'s `buildGenomeTableLatex`, with each bypassed T-child's last column showing the position it bypasses to) for every `requiredByAny` (i.e. non-bypassed) node, fewest lives first, then ONE nimber table: the full game tree (every single subposition, via `analyze`) below every R/D/L/Z child those tables quote, smallest-lives parent first, each parent's distinct children + their nimbers (just the child's nimber, no written-out nim-sum). Sum XORs and per-parent mex are re-checked against the engine, mismatches flagged `(!)`. Each parent is one unbreakable longtable row with a nested children table; fixed column widths so one compile pass aligns the header |
| `downloadText(filename, text)` | Blob-download helper (the dump is too big to paste) |

## `src/model/genomeCensus.ts` — Genomes pane data

| Function | Description |
|---|---|
| `genomeCensus()` | One `GenomeCensusRow` per (collection, offset) group of `collectionElements.json` (plus any offset used as a T-gene with no elements of its own, e.g. `S_2⊕1`): genome text, rep, element count (offset 0 counts the rep), min/max extra-adjusted lives with the crit counted as one life (`CRIT_LIVES`, via `ttree.ts`'s `adjustedLivesOf`), number of collections using the group as a direct T-gene, and the sum of those collections' offset-0 counts. Computed once, cached |

## `src/ui/genomes.ts` — Genomes window (top-bar "Genomes" button)

| Function | Description |
|---|---|
| `initGenomes()` | Wire the sortable/filterable `genomeCensus()` table once; safe to call multiple times |

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
- **Advanced Collections panel**: browses the registered-family roster read directly from
  `src/data/collectionElements.json` (`collectAlpha.ts`'s `COLLECTION_ROSTERS`) and
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
rendering — see memory `project_scab_rendering.md`), `renderRegionDiagnostic` (region
bookkeeping-vs-geometry cross-check overlay), `renderRecreateHints`,
`renderRegionNetwork`, `renderPop`, `computeRegionHues`, `renderRegionFills`,
`screenOuterRegion`, `boundarySphereLoop`/`boundaryPolygon`, `renderBoundaryArrows`,
`projectAdaptive` (adaptive edge subdivision near projection singularities),
`renderSubregionHighlight`.

**Finding "which region/side is this" (containment queries):** use `regionContainsPointNearest` /
`regionNearestFeature` (`moves.ts`, 2026-10-01) — side of the region's nearest boundary feature
(`regionNearestFeature` also returns the distance, for hysteresis). Sphere-native, no antipodal
blind spot, identical for outer and non-outer regions, no elimination logic. Callers:
`computeScabArc`, `renderRegionDiagnostic`, `screenOuterRegion` (renderer.ts) and
`computeSpliceSlots` (moves.ts). It replaced a winding-number test (`regionContainsPoint`,
deleted) that read a false 0 for any region containing both the probe and its antipode (128 of 489
wedge probes on one 19-move save) and needed an outer-region-by-elimination workaround at every
call site. Don't write a new `pointInPolygon`-on-projection or winding-based check; see memory
`feedback_sphere_native_containment.md` for the history. `recomputeRegions` also uses it (via
`loopsNearestFeature` on each cycle's `loop3`) to nest a component/isolated spot into its containing face;
`windingAround` and `probeInsidePointSphere` no longer exist.

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
| `canonReady()` | True once `canonSync` can answer (module loaded) |
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
| `DEBUG` | Central debug-flag object, live on `window.__sproutsDebug`: `recreate` (candidate diagnostics), `tracked` (tracked-check logging), `failNextCollapseGate` (test hook: the next surgery's encoding gate refuses, exercising main.ts's revert-and-disable path; clears itself) |

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
- `checkForCollapses()` — scan for the next applicable collapse (`detectSpecialCollapse`) and set `pendingCollapse` (+ `collapseSnapshot`)
- `revertIfCollapseRefused(finished?)` — after any surgery: on a real encoding-gate refusal, revert (to `collapseSnapshot` if it was the finishing special collapse), switch Collapsing off, show `#collapse-off-note`. Returns whether it handled one
- `afterMoveCommitted(v1, v2, stroke)` — post-move pipeline: labels, `moveSeqEntryOf` → `moveSeqLog`, Move Sequence bar, instant surgeries + collapse check, schedule tracked check
- `moveSeqEntryOf(before, after, v1, v2)` — a move's four recorded token forms (label / raw-id × plain / `{encoding}`-tagged); used at commit and by `loadGameState`, which replays each saved stroke on its saved pre-move board to rebuild all four (a step whose replay records a different label token keeps the saved token in all four slots, with a console warning)
- `formatMoveSequence(tagged)` — the Move Sequence string: `n` + `L` (label tokens) + `C` (`{encoding}` tags) + `:` + tokens; Copy (`moveSeqCopyText`) always hands out the tagged form
- `sameEncodedPosition(a, b)` — Move Check's comparison: two `encodePosition` texts by WASM canon (the TS text isn't canonical)
- `wireOverlay(overlay, closeBtn, onClose?)` / `wirePanel(name, init)` — every modal overlay's close button, backdrop click and Escape (`overlayClosers`); `wirePanel` adds the top-bar button for Collect / T-Tree / Genomes
- `wireCharHover(el, infoOf)` / `renderCharSpans(el, text)` — encoding-bar hover highlight: one indexed span per character, mousemove looks up that character's vertex provenance (bottom bar, Position Browser live row, tracked panel)
- `computeLiveEncodingDisplay(state, enc)` — encoding-bar text + per-character provenance (compact canon when it lines up, else the decompressed `trackedLayout`)
- `clearManualPause()` / `endRecreate()` / `abortRecreate()` — leave a hand-drawn-move pause (hints, Voronoi overlay + path bar, banner) / leave Recreate mode (also drops the candidate preview, unpauses, re-enables input) / stop a running Recreate (resolves the pending pause or candidate preview as cancelled, then `endRecreate`); abort is called on New Game, Load, and opening Recreate
- `scheduleTrackedCheck()` / `runPendingTrackedCheck()` — debounce and run the engine-vs-geometry check after a move
- `resyncTrackedFromHistory()` — rebuild engine tracking state by replaying move history (after undo/load)
- `precomputeChildrenMoves(targets)` / `synthesizeVerifiedMove(target)` — Position Browser move-preview stroke synthesis. The background pass only runs while the board is at rest (`layoutQuiet`: no Recreate, no collapse, no drag, last smoothStep under settleEpsilon); a new position's children wait in `pendingChildTargets` and `maybeStartPrecompute` (called every frame) starts/resumes it; it yields per candidate and parks itself if the board moves. A hover checks the cache first, else computes its own child on demand. A double-click (`onConfirm`) reuses the hover's stroke only if it was found for that same child and still crosses nothing, and re-checks crossings, live-ness and that no move landed right before committing. (Running it during motion rebuilt router face meshes per child — ~4 fps and multi-second freezes during Recreate.)
- `runRecreate(seq)` — replay a parsed Move Sequence into the current position
- `promptManual(parsed, moveNum)` / `promptCandidates(parsed, moveNum)` / `verifyManualMove(v1, v2)` — manual (user-drawn) Recreate flow; `promptCandidates`' no-pause path is recreate.ts `synthesizeMove`, the same call the route scripts replay through
- `firstLegalCandidate(parsed)` — the manual-pause blue hint arc (`proposedArc`): first candidate that crosses nothing. Enter force-commits it without token verification, and re-checks crossings first (the board may have moved)
- `undoLast(recordRedo?)` / `redoLast()` / `pushHistorySnapshot()` — undo/redo stack
- `commitStroke(v1, v2, stroke)` — commit a programmatic stroke exactly as live input does (snapshot, applyMove, warn if a new edge crosses, afterMoveCommitted); used by Recreate, Enter force-commit, the Position Browser's double-click and `__sprouts.commitMove`
- `updateMoveSeq()` / `moveSeqCopyText()` — Move Sequence bar (see memory `project_pb_panel_move_seq_bar.md`)
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
`genome_defs.hpp`/`.cpp` (loads the registry genomes — those with all-named T-genes — + `maxShift`/`maxFoldDepth` from
`src/data/collectionElements.json` at runtime, via the engine's `collectionElementsJson()`).

Native data loading: `stalks/src/json.hpp`/`.cpp` is a minimal JSON parser; `collections.cpp`'s
`collectionElementsJson()` reads `src/data/collectionElements.json` once per process (path baked in
by `CMakeLists.txt`'s `STALKS_COLLECTION_ELEMENTS_JSON`, set on `stalks_core` only) and builds the
single/double/multi registries from it, so a JSON edit needs no native rebuild. Without that macro
(the WASM build) `collections.cpp` compiles the registry from `collection_elements.generated.hpp`.

## Advanced Collections registry: discovery (find new candidate families)

| Tool | Purpose |
|---|---|
| `find_yellow_candidates.cpp` | Scan `.spec` corpus files for single-alpha left sides whose genome matches a named family and aren't yet registered ("go yellow") |
| `unregistered_left_sides.cpp` | Report every quick-canon single-alpha left side (grouped by life count) not recognized by any registered collection; columns `enc` (quick-canon form), `genome`, `raw` (the first raw corpus position that reduced to it) |
| `unregistered_double_crit_regions.cpp` | Double-crit analogue of the above: candidate two-membrane regions not in `doubleCritRegistry()` |
| `double_crit_candidates_report.cpp` | For unregistered double-crit candidates, compute + group by genome text to spot shared families |
| `check_candidates.cpp` | Vet a manually-supplied candidate list (e.g. rows pulled from the Shue-pairings paper CSV) that never passed through the automated corpus scan |
| `classify_candidates.cpp` | Which existing collection does each candidate left side belong to? Per candidate: `reducesTo` (current registry's quickCanon), `yellow` (every S_1–S_32 family at every shift for which `isYellowCandidate` says YES), `genomeMatch` (collections whose stored genome equals its `rootGenomeText`, offset 0 only — the only check that covers S_33+), plus its genome text and `resolvedGenomeName`. `classify_candidates <candidates.txt> [out.tsv]` |

## Advanced Collections registry: audit (is the registry itself minimal/correct?)

| Tool | Purpose |
|---|---|
| `audit_registry.cpp` | Re-check a roster of `family\tencoding` rows against CURRENT classification logic — which previously-registered elements would still be accepted |
| `audit_registry_redundancy.cpp` | For every registered element, check whether its OWN registry entry ever actually fires during `quickCanon()`, or if some other rule already reduces it first (redundant) |
| `audit_registry_necessity.cpp` | True leave-one-out audit: exclude one entry at a time and re-run `quickCanon()` — the correct successor to `audit_registry_redundancy.cpp`'s heuristic, which had a race-condition blind spot |
| `verify_registry_shrink.cpp` | Regression check after editing the registry: every original element (removed or not) must still reduce to the same (rep, offset) it did pre-edit |
| `check_ttree_extras.cpp` | Whole-T-Tree cross-check of `isYellowCandidate` — verifies every required/bypass-witness descendant is clean, not just the root |
| `audit_yellow_bases.cpp` | For every registered base (offset-0) rep, runs `isYellowCandidate` against every one of the 32 named families (all shifts) other than its own — looking for an already-registered family that secretly duplicates/bypasses into another. `isYellowCandidate` checks the `(R,D,{L},{Z})` head itself since the 2026-09-27 fix (before it, two families sharing a generic T-gene list gave false positives) |
| `find_child_parents.cpp` | Given a target T-child, report which candidate parents actually reach it as a real T-child (traces a specific data-integrity issue back to its source) |
| `probe_dupe_nodes.cpp` | Check a `.spec` file for duplicate-encoding nodes (should be zero after `merge_specs.cpp`) |
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
| `collectionsJson.cjs` | Shared reader/writer + schema doc for `src/data/collectionElements.json` (collections → shared `rep` + `genome` → `offsets` → `single`/`double`/`multi` element lists) |
| `genCollectionElementsHeader.cjs` | `src/data/collectionElements.json` → `stalks/src/collection_elements.generated.hpp` (flattened to per-section families; WASM build only — native builds read the JSON at runtime via `collections.cpp`'s `collectionElementsJson()`) |
| `genCollectionGenomesJson.cjs` | `src/data/collectionElements.json` → `src/data/collectionGenomes.generated.json` (genomes only, for the front end) |
| `exportCollectionsLatex.cjs` | Registry (Collections panel data) → standalone LaTeX: one section per collection S_n over a range (default S_2–S_10), base collection left / its ⊕1 offset right, rep first, membrane letters shifted to start at C; `--from/--to/--out/--pdf` |
| `checkGeneratedHeaders.cjs` | CI-style check: fails if any generated file above is stale relative to its JSON source; wired into `npm run build` |
| `refreshGenomes.cjs` | Recompute every collection's genome from its rep via `stalks/build/genome_for_reps.exe` and rewrite it in `collectionElements.json` (`node scripts/refreshGenomes.cjs [exe] [--check]`; `--check` only reports differences). Rebuild the native tools first after any registry change, then `npm run gen:headers` |
| `renameGenomes.cjs` | Rename Advanced Collections/genome families across both JSON sources and regenerate everything derived from them in one pass (`node scripts/renameGenomes.cjs <mapping.json> [--dry-run] [--skip-native]`) — built as a standing tool since family renames have happened multiple times (see `project_advanced_collections.md`, `project_genome_renaming_tool.md`) |
| `filterLives.cjs` | Quick filter pass over `master_meta.json` for encodings with life count 5-7 containing a DisaPoint — pure-JS port, no WASM needed |

## `scripts/route/*.ts` — Stroke-synthesis test tools (Node; bundle with esbuild from the repo root)

| Script | Purpose |
|---|---|
| `routeHarness.ts` | Plays random games and measures, per engine child, whether `pipeline` (`candidateStrokes`), `new` (router alone) or `enum` (every router reading, independent of `resolveMoveVertices`) reaches it — exact decompressed-canon oracle. Dumps a failing child/position for `routeDebug.ts`. Also exports `relax(state)` (the post-commit physics) and `edgeCrossings(state)` (edge pairs that properly cross — `arcsProperlyCross`; blind to a rotation flip at a shared vertex, which `recomputeRegions` on a clone catches) for the other scripts |
| `routeDebug.ts` | Renders one dumped case to PNG per reading: walls, face mesh, IN/OUT labels, mixed boundary chords, routed stroke or failed trace, and what the stroke actually produces (`CLEAN=1` for walls + stroke only) |
| `rasterPng.ts` | Dependency-free RGB raster + PNG encoder used by `routeDebug.ts` |
| `recreateReplay.ts` | Headless Recreate (same candidateStrokes→strokeReproduces→applyMove→relax loop as `runRecreate`); on a step with no reproducing stroke prints the code every candidate produces. Env: `TRACE=<move>` (which smoothing phase first creates a crossing), `SAVE=<file>` (per-move canon vs the save's own history), `REGIONS=<move>`, `NORELAX=1` |
| `failDiag.ts` | Dumps one `failureSaves/*.json` position, flags each undrawable child `TWIN`/`NON-TWIN` (DisaPoint twin = a drawable child shares its compact canon), and per-spec router failures. Env: `MESH=<region id>` (seed counts per corner), `ENDS=1`, `DECOMP=1` (analyze the decompressed text like the app) |
| `saveMoveCodes.ts` | Re-derives each saved move's code (both self-loop faces) from a save's history — shows when a recorded token no longer matches its own move |
| `failureSaves.ts` | Plays random games and writes a loadable save (with undo history) for every position where some engine child can't be drawn, tested exactly as Load rebuilds it, plus `REPORT.md` listing the failing children, the hover's endpoint translation, what strokes between those endpoints produce instead, and whether Recreate replays the game's own labelled (`nL:`) move sequence. Saves store labelled codes, as live play does. Args `[games=25] [maxSpots=7] [seeds=4,5] [outDir=failureSaves]`; files are named `fail-s<seed>-g<game>-m<move>.json` |
| `recreateSweep.ts` | Record/replay sweep: random router-played games, each move code recorded as live play does (`LABELS=1` for labelled codes), replayed through Recreate's `synthesizeMove`, comparing the CANON after every move (a token can match while the position diverges). Per-game faithful / DIVERGED / stuck + move kind; `SHOW=1` regions at the first divergence, `DUMP=g:m` move-region analysis, `SAVE_DIR=<dir>` writes each unfaithful game as a loadable save (plus a `-before.json` of the position before the failing move); saves always store labelled codes, whatever `LABELS` replays. Args `<games> <maxSpots> <seed>`. Tallies from two code versions only compare like-for-like when the played games match — a change to the router-move crossing filter changes every later game; cross-replay the saved games through both versions instead |
