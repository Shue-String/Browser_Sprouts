/**
 * Dead-region elimination — PHASE 1: shrink fully-dead components out of
 * existence (shrink-then-pop), freeing board space for live play.
 *
 * This layer is GEOMETRY-ONLY until the final pop, so it can never change the
 * game: shrinking moves dead vertices/edge points but leaves the graph topology
 * (and therefore the canonical encoding) untouched. The pop deletes a fully-dead
 * connected component once it has shrunk below a threshold; that deletion is
 * encoding-safe (an all-dead component contributes nothing) and is still gated
 * by a before/after encoding check with rollback, just in case.
 *
 * "Fully-dead component" = a connected component of the graph in which every
 * vertex is dead. A vertex counts as dead when it is degree-3 (can never be an
 * endpoint) or it borders no living region (a trapped degree-2). Degree-0/1
 * vertices can always make a loop move, so they keep their region alive and never sit
 * in a fully-dead component.
 *
 * EASY REVERT: delete this file, the `deadRegionStep` call + import in main.ts,
 * and the `fullyDeadVertexIds` skip block in smooth.ts.
 *
 * NOT YET HANDLED (next increment): compacting dead regions that are EMBEDDED in
 * a living component (they can only be shrunk, never popped — see project memory).
 */

import type { GameState, VertexId, EdgeId, RegionId, Region, Vertex, Edge, BoundaryEntry } from './types';
import { VertexType, VertexVisualState } from './types';
import type { SpherePoint } from '../math/sphere';
import { normalize, slerp, arcsCross, sphereAngle, sphereCentroid, polylineLength, polylinesProperlyCross, cross } from '../math/sphere';
import { UnionFind } from '../math/unionFind';
import { recomputeRegions, regionContainsPointNearest, entryIsForward } from './moves';
import { cloneState, addEdge, deleteVertices, anchorEdge, pointsFrom, syncPseudoVertices } from './gameState';
import { canonicalEncoding } from './encoding';
import { distanceToArc } from './smoothGeometry';
import { canonSync, canonReady } from '../engine/stalks';
import { smallCircleSelfLoop } from './strokeSynthesis';
import { stereoChart, buildFaceDeflation, deflatePoint, deflateArc, closeArc, deflateTrack, diskBoundaryPoint, diskPointOf, deflateInteriorPath } from './faceDeflate';
import type { FaceDeflation } from './faceDeflate';
import { tunables } from './tunables';
import { DEBUG } from '../debug/flags';

// Collapse-generated self-loops: when the concatenated/shrunk geometry feeding a new self-loop
// is confined to a small neighbourhood, it's replaced with a genuine small circle (see
// smallCircleSelfLoop) rather than trusted as-is — a near-straight source edge squeezed down to
// its own reflection has no lateral area for edgeRepellers() to bow into a circle. Threshold is
// well above the ~0.04 rad POP_RADIUS scale these collapses shrink to, so it only catches
// genuinely tiny/degenerate loops and leaves real spread-out dead-region boundaries untouched.
const SELF_LOOP_DEGENERATE_THRESHOLD = 0.15;
const SELF_LOOP_SYNTH_RADIUS = 0.12;

/** Largest geodesic distance between any two points in `pts` (unit sphere, radians). O(n^2) —
 * only meant for the small point sets a single collapse's self-loop geometry produces. */
function maxPairwiseAngularDistance(pts: SpherePoint[]): number {
  let max = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) max = Math.max(max, sphereAngle(pts[i], pts[j]));
  return max;
}

/** Geometry for a self-loop at `v` built from `pts` (a walked/concatenated boundary): kept as-is when
 * it has real spread, replaced by a genuine small circle when it is confined to a small
 * neighbourhood — a near-collinear "loop" has no lateral area for edgeRepellers() to bow open. */
function selfLoopPoints(v: SpherePoint, pts: SpherePoint[]): SpherePoint[] {
  if (maxPairwiseAngularDistance(pts) >= SELF_LOOP_DEGENERATE_THRESHOLD) return pts;
  return smallCircleSelfLoop(v, pts[Math.min(1, pts.length - 1)], SELF_LOOP_SYNTH_RADIUS);
}

/** Pull an edge's interior points `step` of the way toward `target`, then re-anchor its ends. */
function pullEdgeToward(state: GameState, e: Edge | undefined, target: SpherePoint, step: number): void {
  if (!e) return;
  for (let i = 1; i < e.points.length - 1; i++) e.points[i] = slerp(e.points[i], target, step);
  anchorEdge(state, e);
}

/** A vertex's edges other than those in `exclude`, with the neighbour at the far end. */
function externalEdges(state: GameState, vid: VertexId, exclude: ReadonlySet<EdgeId>): { eid: EdgeId; nbr: VertexId }[] {
  const out: { eid: EdgeId; nbr: VertexId }[] = [];
  for (const e of state.edges.values()) {
    if (exclude.has(e.id)) continue;
    if (e.v1 === vid) out.push({ eid: e.id, nbr: e.v2 });
    else if (e.v2 === vid) out.push({ eid: e.id, nbr: e.v1 });
  }
  return out;
}

/**
 * Does face `id` hold nothing but its own outer boundary — no nested component, spot or other
 * structure? A collapse may only shrink a face away, or merge it into another face, when it is
 * empty: anything nested in it would be swept over by the animation or end up in a different face,
 * changing the position (and the encoding gate would refuse the pop).
 */
function faceIsEmpty(state: GameState, id: RegionId): boolean {
  const r = state.regions.get(id);
  return !!r && r.boundaries.length === 1;
}

/**
 * Weaker than faceIsEmpty, for an INSTANT surgery (no animation sweeping the face): may face `id`
 * merge into another? Only if everything nested in it — each boundary not touching `own`, the
 * structure being removed — is dead (degree 3): dead content contributes nothing to the encoding,
 * a spot or any vertex with a life left does. (Checked against the encoding gate over every scab in
 * the test saves: this rule rejects exactly the scabs the gate refuses.)
 */
function holdsNothingAlive(state: GameState, id: RegionId, own: ReadonlySet<VertexId>): boolean {
  const r = state.regions.get(id);
  return !!r && r.boundaries.every(b =>
    b.entries.some(en => own.has(en.vertexId))
    || b.entries.every(en => { const v = state.vertices.get(en.vertexId); return !v || v.isPseudo || v.degree >= 3; }));
}

/** The faces on either side of these edges. */
function facesOf(edges: Iterable<Edge>): Set<RegionId> {
  const out = new Set<RegionId>();
  for (const e of edges) { out.add(e.leftRegion); out.add(e.rightRegion); }
  return out;
}

/** Can a whole component with these edges be deleted without moving anything between faces? Its
 * faces all merge into one, so at most one of them may hold anything besides the component itself. */
function deletableComponent(state: GameState, edges: Iterable<Edge>): boolean {
  return [...facesOf(edges)].filter(f => !faceIsEmpty(state, f)).length <= 1;
}

/** The face inside a self-loop: the side whose boundary walk is the loop alone. */
function selfLoopInsideFace(state: GameState, loop: Edge): RegionId | null {
  for (const id of [loop.leftRegion, loop.rightRegion]) {
    const r = state.regions.get(id);
    if (r?.boundaries.some(b => {
      const real = b.entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
      return real.length === 1 && real[0].vertexId === loop.v1 && real[0].edgeId === loop.id;
    })) return id;
  }
  return null;
}

/**
 * The real (non-pseudo) boundary walk of `r` when it is a dead face bounded by a simple n-gon of
 * dead vertices: one boundary, exactly n real entries on n distinct edges, n distinct vertices, all
 * degree 3. Pseudo-vertices add entries without changing the shape, so they're filtered first. Null
 * for anything else. Shared header of the fixed-shape detectors (parallel, triangle, quad, enclosed).
 */
function deadPolygon(state: GameState, r: Region, n: number): (BoundaryEntry & { edgeId: EdgeId })[] | null {
  if (!r.isDead || r.boundaries.length !== 1) return null;
  const real = r.boundaries[0].entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
  if (real.length !== n || real.some(en => en.edgeId === undefined)) return null;
  if (new Set(real.map(en => en.vertexId)).size !== n || new Set(real.map(en => en.edgeId)).size !== n) return null;
  if (real.some(en => state.vertices.get(en.vertexId)?.degree !== 3)) return null;
  return real as (BoundaryEntry & { edgeId: EdgeId })[];
}

/** Sweep orphaned edges (endpoint deleted) then recompute regions. Logs anything suspicious. */
function safeRecompute(state: GameState, caller: string): void {
  for (const [eid, e] of [...state.edges]) {
    const v1ok = state.vertices.has(e.v1);
    const v2ok = state.vertices.has(e.v2);
    if (!v1ok || !v2ok) {
      console.error(`[${caller}] orphaned edge ${eid}: v1=${e.v1}(${v1ok?'ok':'MISSING'}) v2=${e.v2}(${v2ok?'ok':'MISSING'}) — deleting`);
      state.edges.delete(eid);
    }
  }
  recomputeRegions(state);
}

/**
 * Run a dead-region surgery that mutates `state` (deletes/creates vertices+edges and
 * recomputes regions), then verify it preserved the canonical encoding. A
 * topologically-sound collapse never changes the encoding, but a geometric mishap
 * conceivably could — so if the encoding differs, roll the whole state back to the
 * pre-surgery snapshot and report failure. This makes it impossible for any collapse
 * to silently alter the game.
 *
 * `surgery` MUST include its own safeRecompute() call so the post-surgery encoding is
 * read from freshly-rebuilt regions. Returns true if committed, false if rolled back.
 */
function commitIfEncodingPreserved(state: GameState, surgery: () => void): boolean {
  // The WASM engine's canon() is the single source of canonical identity (M6, see
  // project_encoding_canon_rework) — encodePosition()/canonicalEncoding() only need to
  // produce a VALID, self-consistent string now, not a canonical one, so there is no
  // string-compare fallback here anymore. If the module hasn't finished loading yet
  // (see preloadModule() in main.ts, called at startup) this surgery is simply deferred:
  // `toPop`/whatever triggered it is recomputed from unchanged state next frame, so a
  // few frames of delay at the very start of a session is harmless — never a correctness
  // issue, just a slightly later pop.
  const encBefore = canonicalEncoding(state);
  const before = canonSync(encBefore);
  if (before === null) return false;
  const snapshot = cloneState(state);
  surgery();
  const encAfter = canonicalEncoding(state);
  const after = canonSync(encAfter);
  const forced = DEBUG.failNextCollapseGate;
  if (after === null || after !== before || forced) {
    Object.assign(state, snapshot); // rollback — surgery changed the encoding (shouldn't happen)
    if (after !== null) gateRefused = true; // a real refusal, not an engine hiccup
    DEBUG.failNextCollapseGate = false;
    return false;
  }
  return true;
}

/** Set when commitIfEncodingPreserved rolls back a surgery that changed the canonical encoding — a
 * collapse bug. main.ts then reverts the board to before that collapse and turns collapsing off.
 * Read-and-clear. */
let gateRefused = false;
export function takeEncodingGateRefusal(): boolean {
  const r = gateRefused;
  gateRefused = false;
  return r;
}

/** Per-frame slerp fraction `step` (a geometric shrink: (1 - step)^k remains after k frames)
 * run at `speed` times its pace, so the same distance is covered in 1/speed as many frames. */
function scaledStep(step: number, speed: number): number {
  return 1 - Math.pow(1 - step, speed);
}

/** Fraction to slerp each dead point toward its component centroid per frame (at speed 1). */
const DEAD_SHRINK_STEP = 0.06;
/** Geodesic radians: once a dead component's radius drops below this, it pops. */
const POP_RADIUS = 0.12;

/** Vertex ids that lie on the boundary of at least one living region. */
export function livingVertexSet(state: GameState): Set<VertexId> {
  const living = new Set<VertexId>();
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    for (const b of r.boundaries) for (const e of b.entries) living.add(e.vertexId);
  }
  return living;
}

/** Map every vertex to its connected-component root (union-find over edges). */
function componentRoots(state: GameState): Map<VertexId, VertexId> {
  const uf = new UnionFind<VertexId>();
  for (const e of state.edges.values()) uf.union(e.v1, e.v2);
  const map = new Map<VertexId, VertexId>();
  for (const v of state.vertices.keys()) map.set(v, uf.find(v));
  return map;
}

/** Per-component flag: is EVERY vertex in the component dead? */
function fullyDeadByComponent(
  state: GameState,
  comp: Map<VertexId, VertexId>,
): Map<VertexId, boolean> {
  // A vertex counts as dead only if it borders no living region — degree alone
  // is not enough. A degree-3 vertex can still sit on the boundary of a region
  // that encloses an untouched living spot (e.g. an isolated degree-0 point),
  // and shrinking/popping that vertex's component would visually swallow that
  // region even though the spot inside it was never touched.
  const living = livingVertexSet(state);
  const isDead = (v: Vertex) => !living.has(v.id);
  const allDead = new Map<VertexId, boolean>();
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue; // pseudo-vertices are structural; never count toward aliveness
    const root = comp.get(v.id)!;
    const prev = allDead.get(root);
    allDead.set(root, prev === undefined ? isDead(v) : prev && isDead(v));
  }
  return allDead;
}

/**
 * Vertices that belong to a fully-dead connected component. smooth.ts excludes
 * these from normal repulsion/smoothing so the shrink below can actually collapse
 * them (otherwise repulsion's spacing floor would stop them ever getting small).
 */
export function fullyDeadVertexIds(state: GameState): Set<VertexId> {
  const comp = componentRoots(state);
  const allDead = fullyDeadByComponent(state, comp);
  const out = new Set<VertexId>();
  for (const v of state.vertices.keys()) if (allDead.get(comp.get(v)!)) out.add(v);
  return out;
}


/**
 * A dead component (or dead bigon P/Q pair) sitting off-center inside its
 * enclosing structure will, if collapsed toward the plain centroid of its OWN
 * vertices, sometimes sweep its shrinking edges straight across nearby live
 * content that happens to sit in the smaller half. To avoid that, find every
 * living region touching this component's vertices, centroid their (non-dead)
 * boundary vertices, and return the point ANTIPODAL to that — i.e. collapse
 * away from where the live content actually is. Returns null if no adjacent
 * living region has any content (nothing to steer away from; caller should
 * fall back to the plain centroid, no extra computation needed).
 */
function occupiedCentroidAntipode(
  state: GameState,
  compVertexIds: Set<VertexId>,
): SpherePoint | null {
  const seen = new Set<VertexId>();
  let sx = 0, sy = 0, sz = 0;
  let any = false;
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    const touchesComp = r.boundaries.some(b => b.entries.some(en => compVertexIds.has(en.vertexId)));
    if (!touchesComp) continue;
    for (const b of r.boundaries) {
      for (const en of b.entries) {
        const vid = en.vertexId;
        if (compVertexIds.has(vid) || seen.has(vid)) continue;
        const v = state.vertices.get(vid);
        if (!v || v.isPseudo) continue;
        seen.add(vid);
        sx += v.pos.x; sy += v.pos.y; sz += v.pos.z;
        any = true;
      }
    }
  }
  if (!any) return null;
  const oc = normalize({ x: sx, y: sy, z: sz });
  return normalize({ x: -oc.x, y: -oc.y, z: -oc.z });
}

/** True if the straight chord `p1`↔`p2` crosses any edge bordering a living
 * region (i.e. leaves dead territory) — excludeEdgeIds skips edges that are
 * expected to be nearby/collapsing themselves (e.g. the dead quad's own 4
 * boundary edges), so only genuinely unrelated living structure counts. */
function chordCrossesLivingEdges(
  state: GameState,
  p1: SpherePoint,
  p2: SpherePoint,
  excludeEdgeIds: Set<EdgeId>,
): boolean {
  for (const e of state.edges.values()) {
    if (excludeEdgeIds.has(e.id)) continue;
    const lr = state.regions.get(e.leftRegion);
    const rr = state.regions.get(e.rightRegion);
    if ((lr?.isDead ?? true) && (rr?.isDead ?? true)) continue; // both sides dead — not living structure
    for (let i = 0; i < e.points.length - 1; i++) {
      if (arcsCross(p1, p2, e.points[i], e.points[i + 1])) return true;
    }
  }
  return false;
}

/**
 * One frame of dead-region shrink + pop, for ONE fully-dead component at a time
 * (so collapses play out one after another rather than all at once). The
 * component pulls toward its centroid; once it is smaller than POP_RADIUS it is
 * deleted (the deletion is encoding-gated with rollback). Returns whether
 * anything moved, whether the component popped this frame, and `focus`: the
 * vertex ids of the component still shrinking, to pass back in next frame so
 * it is carried through to its pop before another one starts (null once none is).
 *
 * GUARD: a component will not shrink a step that would drag one of its (dead)
 * edges across a LIVING edge. This makes a dead component that encloses living
 * structure simply jam instead of collapsing through it — the proper handling of
 * living-inside-dead is left to the planned topology pass. A jammed component
 * is passed over for the next one.
 *
 * skipVertices: any component that contains one of these vertex IDs is left alone
 * this frame (used to hand off control to a special-collapse animator).
 */
export function deadRegionStep(
  state: GameState,
  skipVertices?: Set<VertexId>,
  focus?: Set<VertexId> | null,
): { moving: boolean; popped: boolean; popCentroids: SpherePoint[]; focus: Set<VertexId> | null } {
  const comp = componentRoots(state);
  const allDead = fullyDeadByComponent(state, comp);

  // Roots of components that have their own animator and must be left alone.
  const skipRoots = new Set<VertexId>();
  if (skipVertices) {
    for (const vid of skipVertices) {
      const r = comp.get(vid);
      if (r !== undefined) skipRoots.add(r);
    }
  }

  // Edges belonging to a NOT-fully-dead component — dead structure must not
  // shrink through these.
  const livingEdges = [...state.edges.values()].filter(e => !allDead.get(comp.get(e.v1)!));

  // Group fully-dead components' vertices and edges (skip delegated ones).
  const compVerts = new Map<VertexId, Vertex[]>();
  const compEdges = new Map<VertexId, typeof livingEdges>();
  for (const v of state.vertices.values()) {
    const root = comp.get(v.id)!;
    if (!allDead.get(root)) continue;
    if (skipRoots.has(root)) continue;
    (compVerts.get(root) ?? compVerts.set(root, []).get(root)!).push(v);
  }
  for (const e of state.edges.values()) {
    const root = comp.get(e.v1)!;
    if (!allDead.get(root)) continue;
    if (skipRoots.has(root)) continue;
    (compEdges.get(root) ?? compEdges.set(root, []).get(root)!).push(e);
  }

  // The component already under way goes first.
  const roots = [...compVerts.keys()];
  const focusRoot = focus ? [...focus].map(id => comp.get(id)).find(r => r !== undefined && compVerts.has(r)) : undefined;
  if (focusRoot !== undefined) roots.sort((x, y) => (y === focusRoot ? 1 : 0) - (x === focusRoot ? 1 : 0));

  for (const root of roots) {
    const verts = compVerts.get(root)!;
    const edges = compEdges.get(root) ?? [];
    // Its pop would merge two faces that both hold something (e.g. it separates live content):
    // never shrink it. (A dead component nested in one of its faces is not blocked by this — that
    // one has only the face it sits in non-empty, so it pops first.)
    if (!deletableComponent(state, edges)) continue;
    const c = sphereCentroid(verts.map(v => v.pos));
    let radius = 0;
    for (const v of verts) radius = Math.max(radius, sphereAngle(v.pos, c));
    if (radius < POP_RADIUS) {
      // Pop it (encoding-gated); a refused pop is passed over for the next component.
      const popped = commitIfEncodingPreserved(state, () => {
        deleteVertices(state, [...state.vertices.keys()].filter(id => comp.get(id) === root));
        safeRecompute(state, 'deadRegionStep');
      });
      if (popped) return { moving: true, popped: true, popCentroids: [c], focus: null };
      continue;
    }

    // Would this shrink step drag a dead edge across a living edge? If so, jam.
    const step = scaledStep(DEAD_SHRINK_STEP, tunables.deadShrinkSpeed);
    const tent = new Map<VertexId, SpherePoint>();
    for (const v of verts) tent.set(v.id, slerp(v.pos, c, step));
    let blocked = false;
    for (const e of edges) {
      const tpts = e.points.map((p, i) =>
        i === 0 ? tent.get(e.v1)!
        : i === e.points.length - 1 ? tent.get(e.v2)!
        : slerp(p, c, step));
      if (livingEdges.some(le => polylinesProperlyCross(tpts, le.points))) { blocked = true; break; }
    }
    if (blocked) continue;

    // Commit the shrink: vertices, then edge interior points, then re-anchor.
    for (const v of verts) v.pos = slerp(v.pos, c, step);
    for (const e of edges) pullEdgeToward(state, e, c, step);
    return { moving: true, popped: false, popCentroids: [], focus: new Set(verts.map(v => v.id)) };
  }

  return { moving: false, popped: false, popCentroids: [], focus: null };
}

// ===========================================================================
// Isolated degree-2 vertex elimination
// ===========================================================================
//
// A degree-2 vertex W that borders no living region is "isolated." Its two
// incident edges (a–W and W–b) can be merged into a single a–b edge. W is
// then deleted and a pop burst plays at its former position.
//
// This fires immediately (no slerp) whenever such a vertex exists while the
// shrink toggle is on.

/**
 * Find and eliminate one isolated degree-2 vertex: splice its two incident
 * edges into one, delete it, recompute regions, and return its position for
 * a pop burst. Returns null if no eligible vertex exists.
 *
 * skip: vertex IDs currently owned by an active special-collapse animator —
 * those are left alone so the animator can finish cleanly.
 */
export function eliminateIsolatedVertex(
  state: GameState,
  skip?: Set<VertexId>,
): SpherePoint | null {
  const living = livingVertexSet(state);

  for (const v of state.vertices.values()) {
    if (v.degree !== 2) continue;
    if (living.has(v.id)) continue;
    if (skip?.has(v.id)) continue;

    // Collect the incident edges.
    const incident: Edge[] = [];
    for (const e of state.edges.values()) {
      if (e.v1 === v.id || e.v2 === v.id) incident.push(e);
    }

    if (incident.length !== 2) continue;

    const [e1, e2] = incident;

    // Orient both segments so the path reads a → W → b.
    const a    = e1.v2 === v.id ? e1.v1 : e1.v2;
    const b    = e2.v1 === v.id ? e2.v2 : e2.v1;

    // Bigon case: both edges go to the same vertex A.
    // Naively deleting W would leave A with degree − 2, potentially creating a
    // false appendage.  Leave this for detectBigonTip to handle as an animation.
    if (a === b) continue;

    const popAt = { ...v.pos };
    const aToW = pointsFrom(e1, v.id).reverse();
    const wToB = pointsFrom(e2, v.id);

    const ok = commitIfEncodingPreserved(state, () => {
      state.vertices.delete(v.id);
      state.edges.delete(e1.id);
      state.edges.delete(e2.id);
      addEdge(state, a, b, [...aToW, ...wToB.slice(1)]);
      safeRecompute(state, 'eliminateIsolatedVertex');
    });
    return ok ? popAt : null;
  }

  return null;
}

// ===========================================================================
// Louse collapse
// ===========================================================================
//
// A "louse" is a theta-graph component: two degree-3 vertices (A, W) connected
// by exactly two parallel edges, each also connected to one degree-2 vertex (X)
// whose two edges go to A and to W. All three regions of this configuration are
// dead (the inner bigon has no live vertices; each triangle has exactly one
// degree-2 vertex and no degree-0/1 vertex), so the whole component is fully
// dead and would ordinarily be centroid-shrunk by deadRegionStep. The louse gets
// its own animator: A and W slerp toward X (the "middle" vertex), then the
// component is deleted with an encoding-gated pop.

/** Louse component descriptor returned by detectLouse. */
export interface LouseCollapse {
  kind: 'louse';
  /** The two degree-3 (dead) vertices that animate toward inner. */
  outer: [VertexId, VertexId];
  /** The degree-2 (isolated) vertex that the outers collapse onto. */
  inner: VertexId;
  /** All four edges of the component (deleted on pop). */
  edges: EdgeId[];
}

const LOUSE_SHRINK_STEP = 0.09;
const LOUSE_POP_RADIUS  = 0.05;

/**
 * Scan for a louse: a 3-vertex connected component whose vertices have degrees
 * 3, 3, 2 and whose edge structure is the theta graph described above.
 * Returns the first match found, or null.
 */
export function detectLouse(state: GameState): LouseCollapse | null {
  const comp = componentRoots(state);

  const byRoot = new Map<VertexId, VertexId[]>();
  for (const v of state.vertices.values()) {
    const root = comp.get(v.id)!;
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(v.id);
  }

  for (const [root, vids] of byRoot) {
    if (vids.length !== 3) continue;

    const vs = vids.map(id => state.vertices.get(id)!);
    const inner = vs.find(v => v.degree === 2);
    const outers = vs.filter(v => v.degree === 3);
    if (!inner || outers.length !== 2) continue;

    const [a, w] = outers;

    // Collect all edges whose v1 belongs to this component.
    const compEdges: EdgeId[] = [];
    for (const e of state.edges.values()) {
      if (comp.get(e.v1) === root) compEdges.push(e.id);
    }
    if (compEdges.length !== 4) continue;

    // Exactly 2 parallel edges between A and W.
    const awCount = compEdges.filter(id => {
      const e = state.edges.get(id)!;
      return (e.v1 === a.id && e.v2 === w.id) || (e.v1 === w.id && e.v2 === a.id);
    }).length;
    if (awCount !== 2) continue;

    // X's two edges must go to A and W.
    const xEdges = compEdges.filter(id => {
      const e = state.edges.get(id)!;
      return e.v1 === inner.id || e.v2 === inner.id;
    });
    if (xEdges.length !== 2) continue;
    const xNbrs = new Set(xEdges.map(id => {
      const e = state.edges.get(id)!;
      return e.v1 === inner.id ? e.v2 : e.v1;
    }));
    if (!xNbrs.has(a.id) || !xNbrs.has(w.id)) continue;

    // Guard: the inner (degree-2) vertex must not border any living region.
    // If a live isolated spot lives inside one of the louse's faces, that face
    // is alive and this "louse" must not be collapsed.
    const living = livingVertexSet(state);
    if (living.has(inner.id)) continue;
    // The pop deletes the whole louse, merging its three faces: at most one may hold anything.
    if (!deletableComponent(state, compEdges.map(id => state.edges.get(id)!))) continue;

    return { kind: 'louse', outer: [a.id, w.id], inner: inner.id, edges: compEdges };
  }
  return null;
}

/**
 * One frame of louse collapse animation. Sleps A and W toward X; once both are
 * within LOUSE_POP_RADIUS of X the component is deleted (encoding-gated).
 * Returns { done, popAt }: done=true when the animation is finished (whether or
 * not the pop succeeded); popAt is X's position for a burst animation on success.
 */
export function louseCollapseStep(
  state: GameState,
  collapse: LouseCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const inner = state.vertices.get(collapse.inner);
  const a     = state.vertices.get(collapse.outer[0]);
  const w     = state.vertices.get(collapse.outer[1]);
  if (!inner || !a || !w) return { done: true, popAt: null };

  const target = inner.pos;

  const distA = sphereAngle(a.pos, target);
  const distW = sphereAngle(w.pos, target);

  if (distA < LOUSE_POP_RADIUS && distW < LOUSE_POP_RADIUS) {
    if (!canonReady()) return { done: false, popAt: null }; // hold until the engine can vet the surgery
    const popAt = { ...target };
    const ok = commitIfEncodingPreserved(state, () => {
      // Every edge incident to a louse vertex — the four detected ones plus any extras
      // eliminateIsolatedVertex created during the animation.
      deleteVertices(state, [collapse.inner, ...collapse.outer]);
      safeRecompute(state, 'louseCollapseStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // Slerp A and W toward X (X stays fixed as the target anchor).
  const step = scaledStep(LOUSE_SHRINK_STEP, tunables.louseSpeed);
  a.pos = slerp(a.pos, target, step);
  w.pos = slerp(w.pos, target, step);

  for (const eid of collapse.edges) pullEdgeToward(state, state.edges.get(eid), target, step);

  return { done: false, popAt: null };
}

// ===========================================================================
// Deflate-in-place animation (shared)
// ===========================================================================
//
// A dead face with nothing inside it collapses by deflating in place (see
// faceDeflate.ts): its boundary shrinks through nested curves onto a point
// inside the face, each boundary vertex travelling along its own track, and
// each vertex's external edge growing along the track its vertex has covered.
// The deflation is a homeomorphism of the face onto part of itself and the
// tracks lie in the part already vacated, so the face never crosses itself or
// its own external edges, whichever side of the sphere the face is on (the
// caller names the side by a point outside it). The external edges are only
// EXTENDED each frame, never rebuilt, so smoothing keeps relaxing them (and
// pulling the surrounding structure along) while the face deflates.

/** Depth schedule: r = exp(-u) with u = U_STEP·k²/(k + EASE) at frame k — eases
 * in, then shrinks the face by a constant factor per frame (≈ e^-U_STEP). */
const DEFLATE_U_STEP = 0.1;
const DEFLATE_EASE_FRAMES = 4;

interface DeflateAnim {
  def: FaceDeflation;
  frame: number;
  r: number; // current depth: 1 = original boundary, 0 = the centre point
  /** Boundary edges: the deflation angles of their start and end in loop order, and
   * whether the loop runs along the edge's own v1→v2 direction. */
  edges: { id: EdgeId; theta0: number; theta1: number; forward: boolean }[];
  /** Boundary vertices: their deflation angle and their external edge (none for a vertex whose
   * whole degree is spent inside the face, e.g. a triple bigon's P and Q). */
  verts: { id: VertexId; theta: number; extId?: EdgeId }[];
  /** Edges lying inside the face with both ends on its boundary: their disk-space path (scaled by
   * the depth each frame) and whether it runs along the edge's own v1→v2 direction. */
  inner: { id: EdgeId; disk: { x: number; y: number }[] }[];
}

/** Snapshot a dead face for deflation. `loop` walks its boundary (each vertex with
 * the edge leaving it toward the next vertex), `ext` gives each boundary vertex's
 * one external edge (if it has one), `inner` lists edges inside the face that join two
 * boundary vertices, and `outside` is any point outside the face. Null if the face
 * can't be meshed. */
function startDeflate(
  state: GameState,
  loop: { vid: VertexId; eid: EdgeId }[],
  ext: Map<VertexId, EdgeId>,
  outside: SpherePoint,
  inner: EdgeId[] = [],
): DeflateAnim | null {
  const pts: SpherePoint[] = [];
  const spans: { id: EdgeId; start: number; end: number; forward: boolean }[] = [];
  const vertStarts: { id: VertexId; idx: number }[] = [];
  for (const { vid, eid } of loop) {
    const e = state.edges.get(eid);
    const v = state.vertices.get(vid);
    if (!e || !v) return null;
    const forward = e.v1 === vid;
    const edgePts = forward ? e.points : [...e.points].reverse();
    vertStarts.push({ id: vid, idx: pts.length });
    spans.push({ id: eid, start: pts.length, end: pts.length + edgePts.length - 1, forward });
    pts.push({ ...v.pos }, ...edgePts.slice(1, -1).map(p => ({ ...p })));
  }
  const def = buildFaceDeflation(pts, outside);
  if (!def) return null;
  // Angles increase along the loop; the closing edge ends back at the first point, a full turn on.
  const theta = (i: number) => (i < pts.length ? def.thetas[i] : def.thetas[0] + 2 * Math.PI);
  const edges = spans.map(s => ({ id: s.id, theta0: theta(s.start), theta1: theta(s.end), forward: s.forward }));
  const verts: DeflateAnim['verts'] = [];
  for (const { id, idx } of vertStarts) {
    const extId = ext.get(id);
    if (extId !== undefined && !state.edges.has(extId)) return null;
    verts.push({ id, theta: theta(idx), extId });
  }
  const innerEdges: DeflateAnim['inner'] = [];
  for (const eid of inner) {
    const e = state.edges.get(eid);
    const t1 = verts.find(v => v.id === e?.v1), t2 = verts.find(v => v.id === e?.v2);
    if (!e || !t1 || !t2) return null;
    innerEdges.push({
      id: eid,
      disk: [
        diskBoundaryPoint(def, t1.theta),
        ...e.points.slice(1, -1).map(p => diskPointOf(def, p)),
        diskBoundaryPoint(def, t2.theta),
      ],
    });
  }
  return { def, frame: 0, r: 1, edges, verts, inner: innerEdges };
}

/** The depth for the next animation frame, the schedule run at `speed` times its pace
 * (`frame` advances by `speed`, so it is fractional off speed 1). */
function nextDeflateDepth(anim: DeflateAnim, speed: number): number {
  anim.frame += speed;
  const k = anim.frame;
  return Math.exp(-DEFLATE_U_STEP * k * k / (k + DEFLATE_EASE_FRAMES));
}

/** Lay out the face's boundary vertices, boundary edges and external edges at depth `r`. */
function deflateTo(state: GameState, anim: DeflateAnim, r: number): void {
  const { def } = anim;
  deflateVertsTo(state, anim, r);
  const ids = new Set<EdgeId>();
  for (const be of anim.edges) {
    const e = state.edges.get(be.id);
    if (!e) continue;
    ids.add(be.id);
    const arc = deflateArc(def, be.theta0, be.theta1, r);
    e.points = be.forward ? arc : arc.reverse();
    anchorEdge(state, e);
  }
  for (const ie of anim.inner) {
    const e = state.edges.get(ie.id);
    if (!e) continue;
    ids.add(ie.id);
    e.points = deflateInteriorPath(def, ie.disk, r);
    anchorEdge(state, e);
  }
  syncPseudoVertices(state, ids);
  anim.r = r;
}

/** Move the face's boundary vertices to depth `r` along their tracks, growing each external
 * edge by the stretch its vertex just travelled. Leaves anim.r for the caller to advance. */
function deflateVertsTo(state: GameState, anim: DeflateAnim, r: number): void {
  const { def } = anim;
  for (const v of anim.verts) {
    const pos = deflatePoint(def, v.theta, r);
    const step = deflateTrack(def, v.theta, anim.r, r);
    step[step.length - 1] = pos;
    const vx = state.vertices.get(v.id);
    if (vx) vx.pos = { ...pos };
    // Grow the external edge by the stretch its vertex just travelled (its old end
    // point is the vertex's old position), keeping whatever shape smoothing gave the rest.
    // Keep the edge's point count steady unless it actually got longer: extra points
    // overcrowd it within a few frames, and the resample that follows (and the smoothing
    // regime change around it) makes the edge jitter. The traced step has a point at every
    // mesh crossing, so keep only track points at least the edge's own spacing apart, then
    // drop any surplus right next to the vertex — points just laid on the track.
    const e = v.extId === undefined ? undefined : state.edges.get(v.extId);
    if (e) {
      const toV = e.v2 === v.id ? e.points : [...e.points].reverse();
      const spacing = polylineLength(toV) / (toV.length - 1);
      const pts = toV.slice(0, -1);
      let lastKept = pts[pts.length - 1];
      for (const p of step.slice(0, -1)) {
        if (sphereAngle(lastKept, p) >= spacing) { pts.push(p); lastKept = p; }
      }
      pts.push(step[step.length - 1]);
      const target = Math.max(toV.length, Math.round(polylineLength(pts) / spacing) + 1);
      while (pts.length > target && pts.length > 2) pts.splice(pts.length - 2, 1);
      e.points = e.v2 === v.id ? pts : pts.reverse();
    }
  }
}


/** Largest distance (radians) from the deflation centre to the face's current boundary. */
function deflateRadius(state: GameState, anim: DeflateAnim): number {
  let max = 0;
  for (const be of anim.edges) {
    const e = state.edges.get(be.id);
    if (!e) continue;
    for (const p of e.points) max = Math.max(max, sphereAngle(p, anim.def.center));
  }
  return max;
}

/** Finish a deflation onto its centre and run `surgery` under the encoding gate. Finishing flattens
 * every boundary edge to a single point, so if the gate refuses, the pre-finish geometry is put back:
 * a refused pop must leave a drawable board (a one-point edge can be neither resampled nor routed). */
function finishDeflateAndCommit(state: GameState, anim: DeflateAnim, surgery: () => void): boolean {
  const preFinish = cloneState(state);
  deflateTo(state, anim, 0);
  const ok = commitIfEncodingPreserved(state, surgery);
  if (!ok) Object.assign(state, preFinish);
  return ok;
}

// ===========================================================================
// Parallel-dead collapse (case 2)
// ===========================================================================
//
// Condition: a dead region whose only boundary is a bigon — two parallel edges
// between P and Q — where both P and Q are fully dead (degree 3). P has exactly
// one other edge (to X) and Q has exactly one other edge (to Y).
//
// Animation: the bigon closes like an eye while P and Q draw together. The two
// parallel edges close onto one curve between P and Q (the chord of the
// bigon's deflation disk — see closeArc) as P and Q travel along their
// deflation tracks to its centre, the external edges growing behind them, so
// nothing crosses, whichever side of the sphere the bigon is on.
// Surgery: once it is small, the bigon finishes onto its centre; P, Q, both
// parallel edges and both external edges are deleted and a new X-Y edge is
// made from (X-P edge) + (Q-Y edge), which meet at the centre.

export interface ParallelDeadCollapse {
  kind: 'parallel-dead';
  p: VertexId;
  q: VertexId;
  /** The bigon's boundary walk: each vertex with the parallel edge leaving it. */
  loop: { vid: VertexId; eid: EdgeId }[];
  edgeP: EdgeId;  // external edge incident to P (the side going to X)
  edgeQ: EdgeId;  // external edge incident to Q (the side going to Y)
  x: VertexId;   // external neighbour of P
  y: VertexId;   // external neighbour of Q
  /** Deflation state, built on the first animation frame. */
  deflate: DeflateAnim | null;
}

const PARALLEL_DEAD_POP_RADIUS = 0.05;
/** P and Q travel to the centre at depth^PACE of the schedule while the edges close at
 * 1 - depth: below 1, the merge lags the closing, so the bigon reads as shutting first. */
const PARALLEL_DEAD_MERGE_PACE = 0.6;

/**
 * Scan for a dead bigon whose two endpoints are both fully dead (degree 3) and
 * each has exactly one external edge. Returns the first match or null.
 */
export function detectParallelDead(state: GameState): ParallelDeadCollapse | null {
  for (const r of state.regions.values()) {
    const real = deadPolygon(state, r, 2);
    if (!real) continue;
    const [e0, e1] = real;
    const p = e0.vertexId, q = e1.vertexId;

    // The one external edge at P (resp. Q): not in the bigon, and not a FURTHER P↔Q parallel edge —
    // a third P-Q edge from a triple bigon must never be mistaken for P's external connection, or the
    // region-deadness checks below get silently bypassed.
    const bigon = new Set([e0.edgeId, e1.edgeId]);
    const extP = externalEdges(state, p, bigon).find(x => x.nbr !== q);
    const extQ = externalEdges(state, q, bigon).find(x => x.nbr !== p);
    if (!extP || !extQ) continue;
    const edgeP = extP.eid, x = extP.nbr, edgeQ = extQ.eid, y = extQ.nbr;
    // x === y is fine here: the surgery below builds a self-loop on the shared neighbour —
    // but ONLY if the third face that shares that neighbour (bounded by edgeP, edgeQ, and
    // whichever parallel edge borders it) is ALSO dead. Two bigon-adjacent regions next to
    // each other like this need BOTH their shared inner pockets empty: r (checked above,
    // the pure bigon interior) and this second one. The far side beyond x (reached via x's
    // third edge) does NOT need to be dead — that's the living structure the collapse must
    // never encroach into.
    // Both faces across the bigon touch x, so "touches x" can't tell the pocket apart: the
    // pocket is the face with a boundary walk of exactly x, P, Q (pseudo-vertices aside). When
    // x has no third edge (degree 2) BOTH faces are such triangles, and either one being dead
    // is enough.
    if (x === y) {
      const pocketIds = new Set([p, q, x]);
      const isDeadPocket = (eid: EdgeId): boolean => {
        const e = state.edges.get(eid);
        if (!e) return false;
        const reg = state.regions.get(e.leftRegion === r.id ? e.rightRegion : e.leftRegion);
        return !!reg && reg.isDead && reg.boundaries.some(bd => {
          const real = bd.entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
          return real.length === 3 && real.every(en => pocketIds.has(en.vertexId));
        });
      };
      if (!isDeadPocket(e0.edgeId) && !isDeadPocket(e1.edgeId)) continue;
    }

    return {
      kind: 'parallel-dead',
      p, q,
      loop: [{ vid: p, eid: e0.edgeId }, { vid: q, eid: e1.edgeId }],
      edgeP, edgeQ,
      x, y,
      deflate: null,
    };
  }
  return null;
}

/**
 * One frame of parallel-dead collapse: close and shrink the dead bigon one step;
 * once it is smaller than PARALLEL_DEAD_POP_RADIUS, finish onto its centre and do
 * the surgery (P and Q deleted, X-P and Q-Y joined into one X-Y edge). Returns
 * the new edge ID so the caller can resample it.
 */
export function parallelDeadStep(
  state: GameState,
  collapse: ParallelDeadCollapse,
): { done: boolean; popAt: SpherePoint | null; newEdgeId?: EdgeId } {
  const vp = state.vertices.get(collapse.p);
  const vq = state.vertices.get(collapse.q);
  if (!vp || !vq) return { done: true, popAt: null };
  // External edges can be deleted by eliminateIsolatedVertex if their far endpoint
  // was a dead degree-2 vertex that got spliced out — abort the collapse gracefully.
  if (!state.edges.has(collapse.edgeP) || !state.edges.has(collapse.edgeQ)) return { done: true, popAt: null };

  if (!collapse.deflate) {
    const vx = state.vertices.get(collapse.x);
    const ext = new Map([[collapse.p, collapse.edgeP], [collapse.q, collapse.edgeQ]]);
    collapse.deflate = vx ? startDeflate(state, collapse.loop, ext, vx.pos) : null;
    if (!collapse.deflate) {
      console.warn('[parallelDeadStep] could not build the deflation for', collapse.loop);
      return { done: true, popAt: null };
    }
  }
  const anim = collapse.deflate;
  const depth = nextDeflateDepth(anim, tunables.parallelDeadSpeed);
  closeBigonTo(state, anim, depth ** PARALLEL_DEAD_MERGE_PACE, 1 - depth);
  // Hold (still shrinking) until the canon engine can vet the surgery.
  if (deflateRadius(state, anim) >= PARALLEL_DEAD_POP_RADIUS || !canonReady()) return { done: false, popAt: null };

  const popAt = { ...anim.def.center };
  let newEid = -1;
  // Finish onto the centre: P, Q and the ends of both external edges arrive there.
  const ok = finishDeflateAndCommit(state, anim, () => {
    // X→P (ending at the centre) + Q→Y (starting there, first point dropped).
    const xToPPts = pointsFrom(state.edges.get(collapse.edgeP)!, collapse.p).reverse();
    const qToYPts = pointsFrom(state.edges.get(collapse.edgeQ)!, collapse.q);
    const newPoints: SpherePoint[] = [...xToPPts.slice(0, -1), { ...popAt }, ...qToYPts.slice(1)];

    // Every edge incident to P or Q: the parallel edges, the external edges, and any further P↔Q
    // edges eliminateIsolatedVertex may have created during the animation.
    deleteVertices(state, [collapse.p, collapse.q]);

    const vx = state.vertices.get(collapse.x);
    if (collapse.x === collapse.y && vx) {
      // X and Y are the same vertex — the concatenated path is a self-loop anchored at X.
      newPoints[0] = { ...vx.pos };
      newPoints[newPoints.length - 1] = { ...vx.pos };
      newEid = addEdge(state, collapse.x, collapse.x, selfLoopPoints(vx.pos, newPoints));
    } else {
      newEid = addEdge(state, collapse.x, collapse.y, newPoints);
    }

    safeRecompute(state, 'parallelDeadStep');
  });
  if (ok) return { done: true, popAt, newEdgeId: newEid };
  return { done: true, popAt: null };
}

/** Lay out a bigon with P and Q at depth `r` and its two edges `s` of the way onto the chord
 * between them. */
function closeBigonTo(state: GameState, anim: DeflateAnim, r: number, s: number): void {
  deflateVertsTo(state, anim, r);
  const ids = new Set<EdgeId>();
  for (const be of anim.edges) {
    const e = state.edges.get(be.id);
    if (!e) continue;
    ids.add(be.id);
    const arc = closeArc(anim.def, be.theta0, be.theta1, s, r);
    e.points = be.forward ? arc : arc.reverse();
    anchorEdge(state, e);
  }
  syncPseudoVertices(state, ids);
  anim.r = r;
}

// ===========================================================================
// Triple-parallel-dead collapse
// ===========================================================================
//
// Condition: two degree-3 vertices P, Q connected by all THREE of their edges
// (a "triple bigon" — no external structure at all). Three parallel arcs
// between two points divide the sphere into exactly three faces. P and Q can
// only fully disappear once at least TWO of those three faces are dead —
// analogous to the plain 2-edge bigon (detectParallelDead) needing its one
// enclosed face dead, but here there's no single "inside": every pair of
// adjacent edges encloses its own face, and any one of the three could be the
// side that's still alive. Popping deletes P, Q, and all three edges; the
// (up to) one living face absorbs the space — no reconnection is needed since
// P and Q have no external edges to preserve.
//
// Animation: the two dead faces together form one disc D, bounded by the two
// edges that border the remaining (living) face; the third edge runs through
// the middle of D. D deflates in place (see "Deflate-in-place animation"
// above) onto a point inside itself, the middle edge carried along with it, so
// the whole component folds in on its own dead side whatever side of the
// sphere that is. (An earlier version slid P and Q toward the antipode of the
// living content's centroid; with the living face wrapped around the pair that
// target sat inside living territory and the edges swept across it.)

export interface TripleParallelDeadCollapse {
  kind: 'triple-parallel-dead';
  p: VertexId;
  q: VertexId;
  edges: [EdgeId, EdgeId, EdgeId];
  /** Which disc deflates, chosen on the first animation frame (see tripleConfigs): the two edges
   * bounding it (P along one to Q, Q along the other back) and the edge through its middle. */
  loop: { vid: VertexId; eid: EdgeId }[] | null;
  inner: EdgeId | null;
  /** Deflation state, built on the first animation frame. */
  deflate: DeflateAnim | null;
}

const TRIPLE_PARALLEL_POP_RADIUS = 0.04;

/** One way to split a triple bigon into a deflating disc and the face that stays. */
interface TripleConfig {
  keptFace: RegionId;
  loop: { vid: VertexId; eid: EdgeId }[];
  inner: EdgeId;
}

/**
 * Every valid way to pick the face that stays: the other two faces, together with the edge
 * between them, form the disc D that deflates, so both must be EMPTY — nothing on their boundary
 * but P and Q. (A dead face can still hold another dead component; deflating over that would
 * sweep through it, so the triple waits until that component has gone.) The living face, if
 * any, comes first. Read from the live regions each time: region ids are renumbered whenever
 * surgery recomputes them, so none is kept between frames.
 */
function tripleConfigs(state: GameState, p: VertexId, q: VertexId, between: EdgeId[]): TripleConfig[] {
  const faceIds = new Set<RegionId>();
  for (const eid of between) {
    const edge = state.edges.get(eid);
    if (!edge) return [];
    faceIds.add(edge.leftRegion);
    faceIds.add(edge.rightRegion);
  }
  if (faceIds.size !== 3) return [];
  const isEmpty = (fid: RegionId): boolean => {
    const r = state.regions.get(fid);
    if (!r || r.boundaries.length !== 1) return false;
    return r.boundaries[0].entries.every(en => en.vertexId === p || en.vertexId === q || !!state.vertices.get(en.vertexId)?.isPseudo);
  };
  const configs: TripleConfig[] = [];
  for (const kept of faceIds) {
    if (![...faceIds].every(f => f === kept || isEmpty(f))) continue;
    const outer = between.filter(eid => {
      const edge = state.edges.get(eid)!;
      return edge.leftRegion === kept || edge.rightRegion === kept;
    });
    const inner = between.filter(eid => !outer.includes(eid));
    if (outer.length !== 2 || inner.length !== 1) continue;
    configs.push({ keptFace: kept, loop: [{ vid: p, eid: outer[0] }, { vid: q, eid: outer[1] }], inner: inner[0] });
  }
  return configs.sort((a, b) => Number(!!state.regions.get(a.keptFace)?.isDead) - Number(!!state.regions.get(b.keptFace)?.isDead));
}

/**
 * Scan for two degree-3 vertices connected by exactly three parallel edges
 * (using up all of both endpoints' degree, i.e. no external edges) where at
 * least two of the three faces those edges bound are dead and a disc to
 * deflate exists (see tripleConfigs). Returns the first match or null.
 */
export function detectTripleParallelDead(state: GameState): TripleParallelDeadCollapse | null {
  const seen = new Set<string>();
  for (const e of state.edges.values()) {
    const p = e.v1, q = e.v2;
    if (p === q) continue;
    const key = p < q ? `${p}:${q}` : `${q}:${p}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const vp = state.vertices.get(p), vq = state.vertices.get(q);
    if (!vp || !vq || vp.degree !== 3 || vq.degree !== 3) continue;

    const between: EdgeId[] = [];
    for (const e2 of state.edges.values()) {
      if ((e2.v1 === p && e2.v2 === q) || (e2.v1 === q && e2.v2 === p)) between.push(e2.id);
    }
    if (between.length !== 3) continue;

    // P and Q must have NO other edges — all of both endpoints' degree is
    // spent on this triple bundle.
    let otherIncident = false;
    for (const e2 of state.edges.values()) {
      if (between.includes(e2.id)) continue;
      if (e2.v1 === p || e2.v2 === p || e2.v1 === q || e2.v2 === q) { otherIncident = true; break; }
    }
    if (otherIncident) continue;

    const faceIds = new Set<RegionId>();
    for (const eid of between) {
      const edge = state.edges.get(eid)!;
      faceIds.add(edge.leftRegion);
      faceIds.add(edge.rightRegion);
    }
    if (faceIds.size !== 3) continue;
    const deadCount = [...faceIds].filter(fid => state.regions.get(fid)?.isDead).length;
    if (deadCount < 2) continue;
    if (tripleConfigs(state, p, q, between).length === 0) continue;

    return {
      kind: 'triple-parallel-dead', p, q, edges: between as [EdgeId, EdgeId, EdgeId],
      loop: null, inner: null, deflate: null,
    };
  }
  return null;
}

/**
 * A point outside the dead disc D, for the deflation to tell D's side from the other: a vertex
 * on the kept face's boundary if it has one besides P and Q, else a point just inside the kept
 * face beside one of the outer edges. Null if neither can be found.
 */
function pointOutsideTripleDisc(state: GameState, cfg: TripleConfig, p: VertexId, q: VertexId): SpherePoint | null {
  const kept = state.regions.get(cfg.keptFace);
  if (!kept) return null;
  for (const b of kept.boundaries) for (const en of b.entries) {
    const v = state.vertices.get(en.vertexId);
    if (v && !v.isPseudo && en.vertexId !== p && en.vertexId !== q) return { ...v.pos };
  }
  const e = state.edges.get(cfg.loop[0].eid);
  if (!e || e.points.length < 3) return null;
  const k = Math.floor(e.points.length / 2);
  const a = e.points[k - 1], m = e.points[k], c = e.points[k + 1] ?? m;
  // Unit normal to the edge at its middle, tried on both sides.
  const nrm = normalize(cross(m, normalize({ x: c.x - a.x, y: c.y - a.y, z: c.z - a.z })));
  for (const sgn of [1, -1]) for (const off of [0.02, 0.01, 0.005]) {
    const cand = normalize({ x: m.x + sgn * off * nrm.x, y: m.y + sgn * off * nrm.y, z: m.z + sgn * off * nrm.z });
    if (regionContainsPointNearest(state, kept, cand)) return cand;
  }
  return null;
}

/**
 * One frame of triple-parallel-dead collapse: deflate the dead disc one step (P, Q and all
 * three edges folding in on its centre); once it is small, finish onto the centre and delete
 * P, Q and the three edges (encoding-gated) — nothing survives to reconnect.
 */
export function tripleParallelDeadStep(
  state: GameState,
  collapse: TripleParallelDeadCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const vp = state.vertices.get(collapse.p);
  const vq = state.vertices.get(collapse.q);
  if (!vp || !vq) return { done: true, popAt: null };
  if (collapse.edges.some(eid => !state.edges.has(eid))) return { done: true, popAt: null };

  if (!collapse.deflate) {
    // Try each valid choice of kept face; one whose disc is nearly the whole sphere can fail to
    // mesh where the other choice (a small disc) builds fine.
    for (const cfg of tripleConfigs(state, collapse.p, collapse.q, collapse.edges)) {
      const outside = pointOutsideTripleDisc(state, cfg, collapse.p, collapse.q);
      const anim = outside ? startDeflate(state, cfg.loop, new Map(), outside, [cfg.inner]) : null;
      if (anim) { collapse.deflate = anim; collapse.loop = cfg.loop; collapse.inner = cfg.inner; break; }
    }
    if (!collapse.deflate) {
      console.warn('[tripleParallelDeadStep] could not build the deflation for', collapse.edges);
      return { done: true, popAt: null };
    }
  }
  const anim = collapse.deflate;
  deflateTo(state, anim, nextDeflateDepth(anim, tunables.tripleParallelDeadSpeed));
  // Hold (still shrinking) until the canon engine can vet the surgery.
  if (deflateRadius(state, anim) >= TRIPLE_PARALLEL_POP_RADIUS || !canonReady()) return { done: false, popAt: null };

  const popAt = { ...anim.def.center };
  const ok = finishDeflateAndCommit(state, anim, () => {
    deleteVertices(state, [collapse.p, collapse.q]);
    safeRecompute(state, 'tripleParallelDeadStep');
  });
  return { done: true, popAt: ok ? popAt : null };
}

// ===========================================================================
// Triangle-dead collapse (case 3)
// ===========================================================================
//
// Condition: a dead region whose boundary is a triangle — exactly 3 entries,
// all three vertices degree 3. Each vertex has exactly one external edge
// (to some neighbour X, Y, Z).
//
// Animation: the dead face deflates in place (see the shared section above).
//
// Surgery: once the face is small, it finishes deflating onto its centre point;
// A takes that point, B, C and the triangle's edges are deleted, and B's and
// C's external edges (which have followed B and C onto the centre) become new
// edges A→Y and A→Z. A's own external edge (A→X) is kept.

export interface TriangleDeadCollapse {
  kind: 'triangle-dead';
  a: VertexId;                          // lowest-ID vertex (kept after pop)
  b: VertexId;                          // deleted on pop
  c: VertexId;                          // deleted on pop
  triangleEdges: [EdgeId, EdgeId, EdgeId];
  /** The dead face's boundary walk: each vertex with the triangle edge leaving it. */
  loop: { vid: VertexId; eid: EdgeId }[];
  edgeA: EdgeId;                        // external edge at A (kept)
  edgeB: EdgeId;                        // external edge at B → becomes A–Y
  edgeC: EdgeId;                        // external edge at C → becomes A–Z
  x: VertexId;                          // external neighbour of A
  y: VertexId;                          // external neighbour of B
  z: VertexId;                          // external neighbour of C
  /** Deflation state, built on the first animation frame. */
  deflate: DeflateAnim | null;
}

const TRIANGLE_DEAD_POP_RADIUS = 0.05;

/**
 * Scan for a dead triangular region (3 boundary entries, all degree-3 vertices,
 * each with exactly one external edge). Returns the first match or null.
 */
export function detectTriangleDead(state: GameState): TriangleDeadCollapse | null {
  for (const r of state.regions.values()) {
    const realEntries = deadPolygon(state, r, 3);
    if (!realEntries) continue;
    const vids = realEntries.map(en => en.vertexId) as [VertexId, VertexId, VertexId];
    const triEdgeIds = realEntries.map(en => en.edgeId) as [EdgeId, EdgeId, EdgeId];
    const triEdgeSet = new Set<EdgeId>(triEdgeIds);

    // Each vertex's one external edge (degree 3, two of them on the triangle).
    const exts = vids.map(vid => externalEdges(state, vid, triEdgeSet)[0] ?? null);
    if (exts.some(ex => !ex)) continue;

    // Skip if any external neighbour is itself a triangle vertex (surgery would
    // try to re-root an edge onto a vertex being deleted, leaving a false appendage).
    const triVidSet = new Set<VertexId>(vids);
    if (exts.some(ex => triVidSet.has(ex!.nbr))) continue;

    // Pick lowest-ID vertex as the anchor A.
    const sorted = [...vids].sort((x, y) => x - y);
    const aId = sorted[0];
    const [bId, cId] = sorted.slice(1) as [VertexId, VertexId];
    const extMap = new Map(vids.map((id, i) => [id, exts[i]!]));

    return {
      kind: 'triangle-dead',
      a: aId, b: bId, c: cId,
      triangleEdges: triEdgeIds,
      loop: realEntries.map(en => ({ vid: en.vertexId, eid: en.edgeId })),
      edgeA: extMap.get(aId)!.eid,
      edgeB: extMap.get(bId)!.eid,
      edgeC: extMap.get(cId)!.eid,
      x: extMap.get(aId)!.nbr,
      y: extMap.get(bId)!.nbr,
      z: extMap.get(cId)!.nbr,
      deflate: null,
    };
  }
  return null;
}

/**
 * One frame of triangle-dead collapse: deflate the dead face one step; once it
 * is smaller than TRIANGLE_DEAD_POP_RADIUS, finish onto its centre and do the
 * surgery (B and C deleted, their external edges re-rooted at A).
 */
export function triangleDeadStep(
  state: GameState,
  collapse: TriangleDeadCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const va = state.vertices.get(collapse.a);
  const vb = state.vertices.get(collapse.b);
  const vc = state.vertices.get(collapse.c);
  if (!va || !vb || !vc) return { done: true, popAt: null };
  // External edges can be removed by eliminateIsolatedVertex if their far
  // endpoint was eliminated while the triangle was animating.
  if (!state.edges.has(collapse.edgeA) || !state.edges.has(collapse.edgeB) || !state.edges.has(collapse.edgeC)) {
    return { done: true, popAt: null };
  }

  if (!collapse.deflate) {
    const vx = state.vertices.get(collapse.x);
    const ext = new Map([[collapse.a, collapse.edgeA], [collapse.b, collapse.edgeB], [collapse.c, collapse.edgeC]]);
    collapse.deflate = vx ? startDeflate(state, collapse.loop, ext, vx.pos) : null;
    if (!collapse.deflate) {
      console.warn('[triangleDeadStep] could not build the deflation for', collapse.loop);
      return { done: true, popAt: null };
    }
  }
  const anim = collapse.deflate;
  deflateTo(state, anim, nextDeflateDepth(anim, tunables.triangleDeadSpeed));
  // Hold (still shrinking) until the canon engine can vet the surgery.
  if (deflateRadius(state, anim) >= TRIANGLE_DEAD_POP_RADIUS || !canonReady()) return { done: false, popAt: null };

  const center = { ...anim.def.center };
  // Finish onto the centre: every vertex and the end of every external edge
  // arrive at it along their own tracks.
  const ok = finishDeflateAndCommit(state, anim, () => {
    const aToY = pointsFrom(state.edges.get(collapse.edgeB)!, collapse.b);
    aToY[0] = { ...center };
    const aToZ = pointsFrom(state.edges.get(collapse.edgeC)!, collapse.c);
    aToZ[0] = { ...center };

    va.pos = { ...center };
    // B, C and every edge incident to either — the triangle edges, the external edges, and any
    // extra edges eliminateIsolatedVertex created next to B or C during the animation.
    deleteVertices(state, [collapse.b, collapse.c]);
    addEdge(state, collapse.a, collapse.y, aToY);
    addEdge(state, collapse.a, collapse.z, aToZ);

    safeRecompute(state, 'triangleDeadStep');
  });
  return { done: true, popAt: ok ? center : null };
}

// ===========================================================================
// Scab-alone collapse
// ===========================================================================
//
// When a scab vertex (degree-2, borders exactly one living region) is the SOLE
// live vertex in a dead region's boundary, the dead vertices and their edges are
// surgically removed and a real self-loop is created on the scab by concatenating
// the boundary edge geometry.  This is called to fixpoint after each move (and
// after each isolated-vertex elimination that might expose a new scab-alone).

/**
 * Find every dead-region boundary that has exactly one live vertex (the scab S)
 * and more than zero dead neighbours.  Delete the dead neighbours and their
 * edges; concatenate the boundary edge geometry into a real self-loop on S.
 * Loops to fixpoint (a collapse can expose another scab-alone).
 */
export function scabAloneCollapse(state: GameState, skipVertices?: Set<VertexId>): boolean {
  let anyCollapse = false;
  let didCollapse = true;
  while (didCollapse) {
    didCollapse = false;

    outer:
    for (const r of state.regions.values()) {
      if (!r.isDead) continue;
      for (const b of r.boundaries) {
        // Count distinct live vertex IDs in this boundary.
        const liveIds = new Set<VertexId>();
        for (const entry of b.entries) {
          const v = state.vertices.get(entry.vertexId);
          // Pseudo-vertices (parallel-edge midpoints, degree 0) are structural, not live.
          if (v && !v.isPseudo && v.degree < 3) liveIds.add(v.id);
        }
        if (liveIds.size !== 1) continue;

        const scabId = [...liveIds][0];
        if (skipVertices?.has(scabId)) continue;

        // A true scab must border at least one living region. A louse inner vertex
        // only touches dead regions and must not self-connect (it gets deleted with the louse).
        const bordersLiving = [...state.edges.values()].some(e => {
          if (e.v1 !== scabId && e.v2 !== scabId) return false;
          const lr = state.regions.get(e.leftRegion);
          const rr = state.regions.get(e.rightRegion);
          return (lr && !lr.isDead) || (rr && !rr.isDead);
        });
        if (!bordersLiving) continue;

        // Collect dead vertex IDs to delete.
        const vertsToDelete = new Set<VertexId>();
        for (const entry of b.entries) {
          if (entry.vertexId !== scabId && !state.vertices.get(entry.vertexId)?.isPseudo) vertsToDelete.add(entry.vertexId);
        }
        if (vertsToDelete.size === 0) continue; // already a clean self-loop
        // Never delete a vertex an animated collapse owns — let that collapse play out.
        if (skipVertices && [...vertsToDelete].some(v => skipVertices.has(v))) continue;

        // Guard: skip if any dead boundary vertex has an edge to a vertex outside
        // this boundary (vertsToDelete ∪ {scabId}).  Deleting such a vertex would
        // orphan a living edge, changing the game state.
        const safeSet = new Set([scabId, ...vertsToDelete]);
        const hasExternalEdge = [...state.edges.values()].some(e =>
          (vertsToDelete.has(e.v1) && !safeSet.has(e.v2)) ||
          (vertsToDelete.has(e.v2) && !safeSet.has(e.v1))
        );
        if (hasExternalEdge) continue;

        // The new self-loop retraces b, so r keeps its side and the scab's own faces survive; every
        // OTHER face of this structure (pockets between the dead vertices' edges) merges into the
        // scab's face. Anything alive in such a pocket would change face (failureSaves/
        // fail-s4-g11-m11.json move 5: a pocket holding another component with a life left).
        const incident = [...state.edges.values()].filter(e => safeSet.has(e.v1) || safeSet.has(e.v2));
        // ...which only holds if no deleted edge OFF the retraced loop bounds a live face. Such an
        // edge (a second edge between two dead vertices, wrapping round another component) would
        // vanish from that face's boundary, merging it with whatever lies beyond: game-equivalent
        // when the far side holds no lives, but the enclosed component visibly jumps out
        // (replay-2026-10-16 g17 move 9, `-4X2(6)[]`).
        const onLoop = new Set(b.entries.map(e => e.edgeId));
        const liveFace = (id: number): boolean => { const f = state.regions.get(id); return !!f && !f.isDead; };
        if (incident.some(e => !onLoop.has(e.id) && (liveFace(e.leftRegion) || liveFace(e.rightRegion)))) continue;
        const scabFaces = facesOf(incident.filter(e => e.v1 === scabId || e.v2 === scabId));
        if ([...facesOf(incident)].some(f => f !== r.id && !scabFaces.has(f) && !holdsNothingAlive(state, f, safeSet))) continue;

        const n = b.entries.length;
        const scabPos = b.entries.findIndex(e => e.vertexId === scabId);
        if (scabPos === -1) continue;

        // Walk boundary from scabPos, collecting edge geometry.
        // entry[i].edgeId = edge departing FROM entry[i].vertexId TO entry[(i+1)%n].vertexId.
        // Direction: edge.v1 === fromVid → forward; else reverse.
        const loopPoints: SpherePoint[] = [];
        for (let i = 0; i < n; i++) {
          const idx = (scabPos + i) % n;
          const entry = b.entries[idx];
          // A pseudo-vertex splits its parallel edge into two boundary steps; the real-vertex
          // step already contributes the whole edge geometry, so skip the second half.
          if (state.vertices.get(entry.vertexId)?.isPseudo) continue;
          const eid = entry.edgeId;
          if (eid === undefined) { loopPoints.length = 0; break; }
          const edge = state.edges.get(eid);
          if (!edge) { loopPoints.length = 0; break; }

          // entryIsForward, not "edge.v1 === vertexId": a self-loop's direction lives on the entry.
          const pts = entryIsForward(entry, edge) ? [...edge.points] : [...edge.points].reverse();
          if (loopPoints.length === 0) loopPoints.push(...pts);
          else         loopPoints.push(...pts.slice(1));
        }

        if (loopPoints.length < 2) continue;
        // The walked loop can be a thin sliver (e.g. a bigon an earlier collapse already squeezed):
        // selfLoopPoints replaces a degenerate one with a real circle.
        const scabVertex = state.vertices.get(scabId);
        const finalLoopPoints = scabVertex ? selfLoopPoints(scabVertex.pos, loopPoints) : loopPoints;

        const ok = commitIfEncodingPreserved(state, () => {
          // Every edge incident to a dead vertex goes with it; then the real self-loop on the scab.
          deleteVertices(state, vertsToDelete);
          addEdge(state, scabId, scabId, finalLoopPoints);
          safeRecompute(state, 'scabAloneCollapse');
        });
        // On rollback, didCollapse stays false so the fixpoint while-loop exits
        // cleanly rather than re-detecting and retrying the same bad collapse.
        if (ok) { didCollapse = true; anyCollapse = true; }
        break outer;
      }
    }
  }
  return anyCollapse;
}

// ===========================================================================
// Shared path-deformation helpers (quad-dead, enclosed-triangle)
// ===========================================================================
//
// Both collapses below move vertices toward each other by retracing the
// REAL, already-valid edges between them (frozen at detection time) rather
// than slerping toward a freshly-computed target each frame. A raw slerp
// toward an artificial target ignores whatever route the real edge actually
// takes and can sweep straight across unrelated content, or — worse — end up
// on the wrong side of the sphere entirely when the true dead region is the
// majority of the sphere and the naive short-arc path cuts through the small
// live side instead (see project_dead_region_elimination for both bugs).

/** Point at normalized position `frac` (0 = path[0], 1 = path[last]) along a frozen
 * polyline, index-parametrized like the rest of this file's edge interpolation. */
function pointAlongPath(path: SpherePoint[], frac: number): SpherePoint {
  const n = path.length - 1;
  if (n <= 0) return { ...path[0] };
  const pos = Math.max(0, Math.min(n, frac * n));
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, n);
  const localT = pos - i0;
  return i0 === i1 ? { ...path[i0] } : slerp(path[i0], path[i1], localT);
}

/** The portion of a frozen path between fractional positions `fracLo` and `fracHi`
 * (fracLo <= fracHi), inclusive of interpolated tips at both ends — used when BOTH
 * ends of an edge are reeling inward toward a shared meeting point. */
function pathSlice(path: SpherePoint[], fracLo: number, fracHi: number): SpherePoint[] {
  const n = path.length - 1;
  if (n <= 0) return [{ ...path[0] }];
  const posLo = Math.max(0, Math.min(n, fracLo * n));
  const posHi = Math.max(0, Math.min(n, fracHi * n));
  const iLo = Math.floor(posLo), tLo = posLo - iLo;
  const iHi = Math.floor(posHi), tHi = posHi - iHi;
  const startPt = tLo > 1e-9 && iLo < n ? slerp(path[iLo], path[iLo + 1], tLo) : { ...path[iLo] };
  const pts: SpherePoint[] = [startPt];
  for (let i = iLo + 1; i <= iHi; i++) pts.push({ ...path[i] });
  if (tHi > 1e-9) pts.push(slerp(path[iHi], path[iHi + 1], tHi));
  return pts;
}

/** Deform a frozen path so every point keeps its original offset from the path's
 * OWN original chord (its first↔last point), re-anchored to the LIVE chord
 * `p1`↔`p2` and scaled down by `remaining`. This is a closed-form function of the
 * current frame rather than an incremental relax toward a moving target, so it
 * can't lag: at the path's own endpoints the offset is exactly zero, so the
 * result always matches p1/p2 exactly, however fast they're moving — no visible
 * kink between an exactly-snapped endpoint and a catching-up neighbour.
 *
 * If `waypoint` is given, the "chord" is bent through it (two half-arcs meeting
 * at the waypoint) instead of taking the direct short arc — used when p1/p2 are
 * two independently-moving points (not converging to a shared point), where the
 * live chord can rotate far enough from its original orientation that
 * re-attaching the original offset directly would swing it outside the safe
 * region. See quadDeadStep, which routes it through occupiedCentroidAntipode. */
function deformPreservingOffset(
  frozenPath: SpherePoint[], p1: SpherePoint, p2: SpherePoint, remaining: number,
  waypoint?: SpherePoint | null,
): SpherePoint[] {
  const n = frozenPath.length - 1;
  if (n <= 0) return [{ ...frozenPath[0] }];
  const orig1 = frozenPath[0], orig2 = frozenPath[n];
  const chord = (a: SpherePoint, b: SpherePoint, u: number): SpherePoint =>
    !waypoint ? slerp(a, b, u)
    : u <= 0.5 ? slerp(a, waypoint, u * 2) : slerp(waypoint, b, (u - 0.5) * 2);
  const pts: SpherePoint[] = new Array(frozenPath.length);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const baselineOrig = chord(orig1, orig2, u);
    const baselineNew  = chord(p1, p2, u);
    const orig = frozenPath[i];
    pts[i] = normalize({
      x: baselineNew.x + remaining * (orig.x - baselineOrig.x),
      y: baselineNew.y + remaining * (orig.y - baselineOrig.y),
      z: baselineNew.z + remaining * (orig.z - baselineOrig.z),
    });
  }
  return pts;
}

/** Shrink a frozen path toward `anchor` by the factor `remaining`: a homothety about
 * the anchor in the stereographic chart centred on `pole`.
 *
 * `pole` must lie OUTSIDE the dead region being collapsed, so that the region maps
 * to a bounded area and `anchor`, on its boundary, is a finite point. Scaling about
 * the anchor then pulls every point straight toward it in the chart — an isotopy of
 * the whole dead region, so shrinking all of its boundary/interior edges this same
 * way keeps them consistent with each other and keeps them on the dead side of the
 * anchor. Deformations phrased relative to the short geodesic between two moving
 * points instead (see deformPreservingOffset) are ill-conditioned when those points
 * are nearly antipodal — the dead triangle spanning most of the sphere — and can
 * sweep straight through live content hanging off the anchor. See
 * enclosedTriangleStep. */
function shrinkTowardAnchor(
  frozenPath: SpherePoint[], anchor: SpherePoint, pole: SpherePoint, remaining: number,
): SpherePoint[] {
  const { fwd, inv } = stereoChart(pole);
  const c = fwd(anchor);
  return frozenPath.map(p => {
    const q = fwd(p);
    return inv({ x: c.x + remaining * (q.x - c.x), y: c.y + remaining * (q.y - c.y) });
  });
}

// ===========================================================================
// Quad-dead collapse (case 4)
// ===========================================================================
//
// Condition: a dead region whose single boundary is a quadrilateral — exactly
// 4 entries, all 4 vertices degree 3, each with exactly 1 external edge.
//
// Labeling preference: A-B and C-D should be "opposite" edges that share the
// same outside region (so the collapse is symmetric).  If the other pair
// (B-C and D-A) shares an outside region instead, rotate by one step.
//
// Animation:
//   • A and B slerp toward their shared midpoint (P).
//   • C and D slerp toward their shared midpoint (Q).
//   • Boundary edges AB and CD pull inward; BC and DA just re-anchor.
//
// Surgery:
//   • Merge A+B → new vertex P = min(A,B) at their midpoint.
//   • Merge C+D → new vertex Q = min(C,D) at their midpoint.
//   • Delete A, B, C, D and all incident edges.
//   • Create P and Q plus 5 edges: P→nbrA, P→nbrB, Q→nbrC, Q→nbrD, P→Q.
//     The P→Q edge uses the geometry of the former B→C edge (D→A is dropped).

export interface QuadDeadCollapse {
  kind: 'quad-dead';
  a: VertexId;           // first collapsing pair: A+B → P
  b: VertexId;
  c: VertexId;           // second collapsing pair: C+D → Q
  d: VertexId;
  edgeAB: EdgeId;        // boundary edge A↔B  (collapses to point P)
  edgeBC: EdgeId;        // boundary edge B↔C  (becomes P→Q edge)
  edgeCD: EdgeId;        // boundary edge C↔D  (collapses to point Q)
  edgeDA: EdgeId;        // boundary edge D↔A  (dropped on pop)
  extA: EdgeId;          // external edge from A  →  nbrA
  extB: EdgeId;          // external edge from B  →  nbrB
  extC: EdgeId;          // external edge from C  →  nbrC
  extD: EdgeId;          // external edge from D  →  nbrD
  nbrA: VertexId;
  nbrB: VertexId;
  nbrC: VertexId;
  nbrD: VertexId;
  // Snapshots of AB/BC/CD/DA's geometry taken at detection time. A and B reel
  // toward each other along abPath (meeting at its own original midpoint);
  // C and D likewise along cdPath. BC and DA deform in place, preserving their
  // shape relative to their own original chord, rather than being replaced by
  // a fresh straight line each frame — the dead quad face can be the sphere's
  // MAJORITY region (see project_dead_region_elimination), in which case a
  // naive short-arc line between the merge points cuts through the small live
  // side instead of through the actual (large) dead face. Retracing the real
  // edges — which are already known to correctly bound the dead face, however
  // it wraps around the sphere — is safe by construction. See quadDeadStep.
  abPath: SpherePoint[];  // oriented A-first
  cdPath: SpherePoint[];  // oriented C-first
  bcPath: SpherePoint[];  // oriented B-first
  daPath: SpherePoint[];  // oriented D-first
  // BC and DA connect two independently-moving points (B→P, C→Q for one; D→Q,
  // A→P for the other) rather than converging to a shared point, so their
  // live chord can rotate far from its original orientation as the animation
  // runs. Steer their deformation through the antipode of whatever living
  // content sits just outside them (same technique as tripleParallelDeadStep's
  // occupiedCentroidAntipode) rather than a direct line that can swing back
  // across that content. Null when nothing nearby needs steering around.
  bcWaypoint: SpherePoint | null;
  daWaypoint: SpherePoint | null;
  t: number;               // animation progress: 0 at detection, 1 once merged
}

const QUAD_DEAD_STEP_DELTA   = 0.035; // per-frame progress along abPath/cdPath
const QUAD_DEAD_POP_FRACTION = 0.06;  // pop once this much of the path remains

/**
 * Scan for a dead quadrilateral region (4 boundary entries, all degree-3,
 * each with exactly 1 external edge). Returns the first match or null.
 * Prefers labeling where the A-B edge and C-D edge share the same outside
 * region; if the B-C / D-A pair shares an outside region instead, rotates.
 */
export function detectQuadDead(state: GameState): QuadDeadCollapse | null {
  for (const r of state.regions.values()) {
    const realEntries = deadPolygon(state, r, 4);
    if (!realEntries) continue;
    const [e0, e1, e2, e3] = realEntries;
    const vids = realEntries.map(en => en.vertexId) as [VertexId, VertexId, VertexId, VertexId];
    const quadEdgeIds = realEntries.map(en => en.edgeId) as [EdgeId, EdgeId, EdgeId, EdgeId];
    const quadEdgeSet = new Set<EdgeId>(quadEdgeIds);

    // Each vertex must have exactly 1 external edge.
    const exts = vids.map(vid => { const x = externalEdges(state, vid, quadEdgeSet); return x.length === 1 ? x[0] : null; });
    if (exts.some(x => !x)) continue;
    const [extA0, extB0, extC0, extD0] = exts as [{ eid: EdgeId; nbr: VertexId }, { eid: EdgeId; nbr: VertexId }, { eid: EdgeId; nbr: VertexId }, { eid: EdgeId; nbr: VertexId }];

    // Determine which "opposite pair" shares an outside region.
    // Outside region = the face on the other side of each boundary edge from r.id.
    const outsideOf = (eid: EdgeId): number => {
      const edge = state.edges.get(eid)!;
      return edge.leftRegion === r.id ? edge.rightRegion : edge.leftRegion;
    };
    const out0 = outsideOf(e0.edgeId); // edge v0↔v1
    const out1 = outsideOf(e1.edgeId); // edge v1↔v2
    const out2 = outsideOf(e2.edgeId); // edge v2↔v3
    const out3 = outsideOf(e3.edgeId); // edge v3↔v0

    // Pair 0-2 shares outside? (v0-v1 and v2-v3)
    const pair02Same = out0 === out2 && out0 >= 0;
    // Pair 1-3 shares outside? (v1-v2 and v3-v0)
    const pair13Same = out1 === out3 && out1 >= 0;

    let a: VertexId, b_: VertexId, c: VertexId, d: VertexId;
    let edgeAB: EdgeId, edgeBC: EdgeId, edgeCD: EdgeId, edgeDA: EdgeId;
    let extA: typeof extA0, extB: typeof extA0, extC: typeof extA0, extD: typeof extA0;

    if (pair02Same || !pair13Same) {
      // Preferred: A=v0, B=v1, C=v2, D=v3
      [a, b_, c, d] = [vids[0], vids[1], vids[2], vids[3]];
      [edgeAB, edgeBC, edgeCD, edgeDA] = quadEdgeIds;
      [extA, extB, extC, extD] = [extA0, extB0, extC0, extD0];
    } else {
      // Rotate: A=v1, B=v2, C=v3, D=v0  (pair 1-3 collapses)
      [a, b_, c, d] = [vids[1], vids[2], vids[3], vids[0]];
      [edgeAB, edgeBC, edgeCD, edgeDA] = [quadEdgeIds[1], quadEdgeIds[2], quadEdgeIds[3], quadEdgeIds[0]];
      [extA, extB, extC, extD] = [extB0, extC0, extD0, extA0];
    }

    // Skip degenerate cases where surgery would create self-loops or ID conflicts.
    const allExtNbrs = [extA.nbr, extB.nbr, extC.nbr, extD.nbr];
    const quadVidSet = new Set([a, b_, c, d]);
    if (allExtNbrs.some(nbr => quadVidSet.has(nbr))) continue; // external nbr is quad vertex
    if (extA.nbr === extB.nbr) continue; // P would have a self-loop via its two external edges
    if (extC.nbr === extD.nbr) continue; // Q would have a self-loop

    // Snapshot the 4 boundary edges now, oriented as documented on the
    // interface, for A/B/C/D to reel along during the animation.
    const frozen = (eid: EdgeId, from: VertexId) => pointsFrom(state.edges.get(eid)!, from).map(p => ({ ...p }));
    const abPath = frozen(edgeAB, a), cdPath = frozen(edgeCD, c), bcPath = frozen(edgeBC, b_), daPath = frozen(edgeDA, d);

    // BC and DA both eventually straighten into the same P–Q segment (P = AB's
    // merge point, Q = CD's merge point; DA just runs it in reverse) as B/C/D/A
    // slide onto their respective merge points — see quadDeadStep. Antipodal
    // steering is only needed when that eventual direct P–Q chord would actually
    // cut across living structure (the majority-dead-region case); for a small,
    // self-contained dead quad the direct chord never leaves the dead face, and
    // forcing it through a distant antipodal waypoint anyway produces a pointless
    // "around the back" detour instead of a plain shrink. Reuses the exact same
    // pointAlongPath merge-point computation quadDeadStep uses, so this predicts
    // what the animation will actually converge to.
    const midAB = pointAlongPath(abPath, 0.5);
    const midCD = pointAlongPath(cdPath, 0.5);
    const quadEdgeSetForChordCheck = new Set<EdgeId>([edgeAB, edgeBC, edgeCD, edgeDA]);
    const needsDetour = chordCrossesLivingEdges(state, midAB, midCD, quadEdgeSetForChordCheck);
    const bcWaypoint = needsDetour ? occupiedCentroidAntipode(state, new Set([b_, c])) : null;
    const daWaypoint = needsDetour ? occupiedCentroidAntipode(state, new Set([d, a])) : null;

    return {
      kind: 'quad-dead',
      a, b: b_, c, d,
      edgeAB, edgeBC, edgeCD, edgeDA,
      extA: extA.eid, extB: extB.eid, extC: extC.eid, extD: extD.eid,
      nbrA: extA.nbr, nbrB: extB.nbr, nbrC: extC.nbr, nbrD: extD.nbr,
      abPath, cdPath, bcPath, daPath, bcWaypoint, daWaypoint, t: 0,
    };
  }
  return null;
}


/**
 * One frame of quad-dead collapse.
 * A and B reel toward each other along edgeAB's own frozen geometry, meeting
 * exactly at its original midpoint (P); C and D likewise along edgeCD (Q).
 * BC and DA deform in place rather than being replaced by a fresh straight
 * line — see the interface doc comment and deformPreservingOffset.
 * On pop: merge A+B → P = min(A,B), C+D → Q = min(C,D), surgery fires.
 */
export function quadDeadStep(
  state: GameState,
  collapse: QuadDeadCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const va = state.vertices.get(collapse.a);
  const vb = state.vertices.get(collapse.b);
  const vc = state.vertices.get(collapse.c);
  const vd = state.vertices.get(collapse.d);
  if (!va || !vb || !vc || !vd) return { done: true, popAt: null };

  const midAB = pointAlongPath(collapse.abPath, 0.5); // abPath's own frozen midpoint
  const midCD = pointAlongPath(collapse.cdPath, 0.5);
  const remaining = 1 - collapse.t;

  if (remaining < QUAD_DEAD_POP_FRACTION) {
    if (!canonReady()) return { done: false, popAt: null }; // hold until the engine can vet the surgery
    const popAt = slerp(midAB, midCD, 0.5); // burst between the two merge points

    // Guard: required edges must still exist (eliminateIsolatedVertex may have
    // removed a neighbouring vertex while the animation was in progress).
    const eBC = state.edges.get(collapse.edgeBC);
    const eExtA = state.edges.get(collapse.extA);
    const eExtB = state.edges.get(collapse.extB);
    const eExtC = state.edges.get(collapse.extC);
    const eExtD = state.edges.get(collapse.extD);
    if (!eBC || !eExtA || !eExtB || !eExtC || !eExtD) {
      return { done: true, popAt: null };
    }

    // External edge geometry oriented away from the old vertex, starting at its merge point. (A-D
    // themselves are deleted by the surgery, so nothing outside the encoding gate moves them.)
    const buildExt = (e: Edge, fromVid: VertexId, newOrigin: SpherePoint): SpherePoint[] => {
      const pts = pointsFrom(e, fromVid);
      pts[0] = { ...newOrigin };
      return pts;
    };
    const pToNbrA = buildExt(eExtA, collapse.a, midAB);
    const pToNbrB = buildExt(eExtB, collapse.b, midAB);
    const qToNbrC = buildExt(eExtC, collapse.c, midCD);
    const qToNbrD = buildExt(eExtD, collapse.d, midCD);

    // P→Q from the (now nearly-collapsed) live BC edge, re-anchored at both ends.
    const pToQ = pointsFrom(eBC, collapse.b);
    pToQ[0] = { ...midAB };
    pToQ[pToQ.length - 1] = { ...midCD };

    const p = Math.min(collapse.a, collapse.b);
    const q = Math.min(collapse.c, collapse.d);

    const ok = commitIfEncodingPreserved(state, () => {
      deleteVertices(state, [collapse.a, collapse.b, collapse.c, collapse.d]);

      // Create merged vertices P and Q.
      state.vertices.set(p, {
        id: p, pos: { ...midAB },
        type: VertexType.Dead, degree: 3, visual: VertexVisualState.Saturated,
        isMidpoint: true,
      });
      state.vertices.set(q, {
        id: q, pos: { ...midCD },
        type: VertexType.Dead, degree: 3, visual: VertexVisualState.Saturated,
        isMidpoint: true,
      });

      addEdge(state, p, collapse.nbrA, pToNbrA);
      addEdge(state, p, collapse.nbrB, pToNbrB);
      addEdge(state, q, collapse.nbrC, qToNbrC);
      addEdge(state, q, collapse.nbrD, qToNbrD);
      addEdge(state, p, q, pToQ);

      safeRecompute(state, 'quadDeadStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  collapse.t = Math.min(1, collapse.t + QUAD_DEAD_STEP_DELTA * tunables.quadDeadSpeed);
  const newRemaining = 1 - collapse.t;
  const half = collapse.t / 2;

  // A and B reel toward each other along their own frozen edge, meeting
  // exactly at abPath's own original midpoint; C and D likewise along cdPath.
  va.pos = pointAlongPath(collapse.abPath, half);
  vb.pos = pointAlongPath(collapse.abPath, 1 - half);
  vc.pos = pointAlongPath(collapse.cdPath, half);
  vd.pos = pointAlongPath(collapse.cdPath, 1 - half);

  const eAB = state.edges.get(collapse.edgeAB);
  if (eAB) {
    const slice = pathSlice(collapse.abPath, half, 1 - half);
    eAB.points = eAB.v1 === collapse.a ? slice : [...slice].reverse();
  }
  const eCD = state.edges.get(collapse.edgeCD);
  if (eCD) {
    const slice = pathSlice(collapse.cdPath, half, 1 - half);
    eCD.points = eCD.v1 === collapse.c ? slice : [...slice].reverse();
  }

  // BC and DA deform in place instead of being replaced by a fresh straight
  // line each frame — safe regardless of which side of the sphere the dead
  // quad face actually wraps around (it can be the sphere's MAJORITY region).
  const eBC = state.edges.get(collapse.edgeBC);
  if (eBC) {
    const newPts = deformPreservingOffset(collapse.bcPath, vb.pos, vc.pos, newRemaining, collapse.bcWaypoint);
    eBC.points = eBC.v1 === collapse.b ? newPts : [...newPts].reverse();
  }
  const eDA = state.edges.get(collapse.edgeDA);
  if (eDA) {
    const newPts = deformPreservingOffset(collapse.daPath, vd.pos, va.pos, newRemaining, collapse.daWaypoint);
    eDA.points = eDA.v1 === collapse.d ? newPts : [...newPts].reverse();
  }

  // External edges: re-anchor the quad-vertex endpoint only.
  for (const eid of [collapse.extA, collapse.extB, collapse.extC, collapse.extD]) {
    const e = state.edges.get(eid);
    if (e) anchorEdge(state, e);
  }

  return { done: false, popAt: null };
}

// ===========================================================================
// Enclosed-triangle collapse
// ===========================================================================
//
// Condition: a dead triangle face (3 boundary entries, all degree-3) where
// exactly one vertex (A) has a true external edge (to a non-triangle vertex X),
// and the other two (B and C) have their only non-triangle edge going to each
// other — the parallel BC edge that forms an internal bigon.
//
// Animation: the dead triangle+bigon shrinks toward A (A stays fixed as anchor).
//
// Surgery: delete B and C (and all incident edges); create a self-loop on A
// from the parallel BC2 geometry. A keeps its external edge to X.
// Result: A has degree 3 (self-loop = 2, ext = 1) — dead and stable.
// No further collapse is triggered (the self-loop vertex on the end of one edge
// should not slerp anywhere).

export interface EnclosedTriangleCollapse {
  kind: 'enclosed-triangle';
  a: VertexId;         // anchor — has the true external edge; stays put
  b: VertexId;         // enclosed vertex 1 — reels in along abPath to A
  c: VertexId;         // enclosed vertex 2 — reels in along acPath to A
  triEdgeAB: EdgeId;   // triangle boundary edge A↔B
  triEdgeAC: EdgeId;   // triangle boundary edge A↔C
  triEdgeBC1: EdgeId;  // triangle boundary edge B↔C (bounding the face)
  triEdgeBC2: EdgeId;  // the parallel B↔C edge (becomes the self-loop on A)
  extA: EdgeId;        // A's external edge (A→X)
  x: VertexId;         // external neighbour of A
  // Snapshots of edge AB/AC's geometry taken at detection time, A-end first.
  // They (and BC1/BC2 below) are shrunk toward A by one shared homothety rather
  // than slerping B and C toward A along fresh great circles, which would ignore
  // the detours the real edges took and could sweep across unrelated content
  // elsewhere on the sphere. See enclosedTriangleStep.
  abPath: SpherePoint[];
  acPath: SpherePoint[];
  // Snapshots of BC1/BC2's geometry taken at detection time, B-end first.
  bc1Path: SpherePoint[];
  bc2Path: SpherePoint[];
  t: number;            // animation progress: 0 at detection, 1 once B/C reach A
}

const ENCLOSED_TRIANGLE_STEP_DELTA     = 0.035; // per-frame progress along abPath/acPath
const ENCLOSED_TRIANGLE_POP_FRACTION   = 0.06;  // pop once this much of the path remains

export function detectEnclosedTriangle(state: GameState): EnclosedTriangleCollapse | null {
  for (const r of state.regions.values()) {
    const realEntries = deadPolygon(state, r, 3);
    if (!realEntries) continue;
    const vids = realEntries.map(en => en.vertexId) as [VertexId, VertexId, VertexId];
    const triEdgeIds = realEntries.map(en => en.edgeId) as [EdgeId, EdgeId, EdgeId];
    const triEdgeSet = new Set<EdgeId>(triEdgeIds);
    const triVidSet  = new Set<VertexId>(vids);

    // For each triangle vertex, its one non-triangle-edge neighbour.
    const exts = vids.map(vid => externalEdges(state, vid, triEdgeSet)[0] ?? null);
    if (exts.some(ex => !ex)) continue; // every vertex must have exactly one non-tri edge

    // Need exactly 1 vertex with a true external neighbour (outside the triangle).
    const trueExtCount = exts.filter(ex => !triVidSet.has(ex!.nbr)).length;
    if (trueExtCount !== 1) continue;

    // Identify the anchor (true external) and the two enclosed vertices.
    const anchorIdx = exts.findIndex(ex => !triVidSet.has(ex!.nbr));
    const bIdx = (anchorIdx + 1) % 3;
    const cIdx = (anchorIdx + 2) % 3;
    const aId = vids[anchorIdx], bId = vids[bIdx], cId = vids[cIdx];

    // B and C's non-tri edges must go to each other (the parallel bigon edge).
    if (exts[bIdx]!.nbr !== cId || exts[cIdx]!.nbr !== bId) continue;
    if (exts[bIdx]!.eid !== exts[cIdx]!.eid) continue; // same shared edge

    const triEdgeBC2 = exts[bIdx]!.eid;
    const extA       = exts[anchorIdx]!.eid;
    const x          = exts[anchorIdx]!.nbr;

    const isInc = (eid: EdgeId, u: VertexId, v: VertexId) => {
      const e = state.edges.get(eid)!;
      return (e.v1 === u && e.v2 === v) || (e.v1 === v && e.v2 === u);
    };
    const edgeAB  = triEdgeIds.find(eid => isInc(eid, aId, bId));
    const edgeAC  = triEdgeIds.find(eid => isInc(eid, aId, cId));
    const edgeBC1 = triEdgeIds.find(eid => isInc(eid, bId, cId));
    // Edge ids can be 0 (falsy), so check for undefined explicitly rather than truthiness.
    if (edgeAB === undefined || edgeAC === undefined || edgeBC1 === undefined) continue;

    // The triangle (r) is only one of the two faces the BC bigon (BC1/BC2)
    // bounds — the other, F1, sits on BC1's far side from the triangle and
    // never touches A. The shrink sweeps F1 away along with the triangle, so
    // F1 must be dead AND empty, like the triangle: a separate component
    // nested in it (e.g. a spot enclosed by an earlier self-loop move, or a
    // whole dead pocket's contents) would be dragged over and land outside
    // A's new self-loop (failureSaves/fail-s4-g11-m11.json move 11).
    const eBC1 = state.edges.get(edgeBC1)!;
    const f1Id = eBC1.leftRegion === r.id ? eBC1.rightRegion : eBC1.leftRegion;
    const f1 = state.regions.get(f1Id);
    if (!f1 || !f1.isDead || !faceIsEmpty(state, f1Id)) continue;

    // Snapshot A→B and A→C now, oriented A-first, for B/C to reel themselves
    // in along during the animation (see enclosedTriangleStep).
    const frozen = (eid: EdgeId, from: VertexId) => pointsFrom(state.edges.get(eid)!, from).map(p => ({ ...p }));
    const abPath = frozen(edgeAB, aId), acPath = frozen(edgeAC, aId);
    // Snapshot BC1/BC2 too, oriented B-first, so their shape can decay relative
    // to their OWN original chord rather than the live (already-mutated) edge.
    const bc1Path = frozen(edgeBC1, bId), bc2Path = frozen(triEdgeBC2, bId);

    return {
      kind: 'enclosed-triangle',
      a: aId, b: bId, c: cId,
      triEdgeAB: edgeAB, triEdgeAC: edgeAC, triEdgeBC1: edgeBC1,
      triEdgeBC2, extA, x,
      abPath, acPath, bc1Path, bc2Path, t: 0,
    };
  }
  return null;
}

/**
 * One frame of enclosed-triangle collapse. The whole dead region (AB, AC, BC1,
 * BC2) shrinks toward A by a single homothety about A in the stereographic
 * chart centred on A's external neighbour X (see shrinkTowardAnchor), so B and C
 * converge on A and BC1/BC2 shrink to nothing exactly when they arrive. On pop,
 * B and C are deleted and BC2 is replaced by a synthetic self-loop on A.
 */
export function enclosedTriangleStep(
  state: GameState,
  collapse: EnclosedTriangleCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const va = state.vertices.get(collapse.a);
  const vb = state.vertices.get(collapse.b);
  const vc = state.vertices.get(collapse.c);
  if (!va || !vb || !vc) return { done: true, popAt: null };

  const target = va.pos;
  const remaining = 1 - collapse.t; // fraction of abPath/acPath still left to reel in

  if (remaining < ENCLOSED_TRIANGLE_POP_FRACTION) {
    if (!canonReady()) return { done: false, popAt: null }; // hold until the engine can vet the surgery
    const popAt = { ...target };

    const eBC2 = state.edges.get(collapse.triEdgeBC2);
    if (!eBC2) return { done: true, popAt: null };

    // BC2's endpoints (B, C) are both nearly at A by now, and BC2 itself is typically close to
    // a geodesic — squeezing a near-straight edge's two ends together yields a near-collinear
    // "loop" with no lateral area, which edgeRepellers() can never bow open into a circle
    // (pushing points apart along an already-straight path just redistributes them). Synthesize
    // a genuine small circle instead of reusing BC2's squeezed geometry; oriented toward B's
    // pre-deletion position so it bulges the same direction BC2 used to run.
    const loopPts = smallCircleSelfLoop(target, vb.pos, SELF_LOOP_SYNTH_RADIUS);

    const ok = commitIfEncodingPreserved(state, () => {
      deleteVertices(state, [collapse.b, collapse.c]);
      addEdge(state, collapse.a, collapse.a, loopPts);
      safeRecompute(state, 'enclosedTriangleStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  collapse.t = Math.min(1, collapse.t + ENCLOSED_TRIANGLE_STEP_DELTA * tunables.enclosedTriangleSpeed);
  const newRemaining = 1 - collapse.t;

  // The whole dead region (triangle edges AB/AC and the BC1/BC2 bigon) shrinks
  // toward A by one shared homothety, projected from A's external neighbour X
  // (always outside the dead region). Reeling B and C along their own frozen
  // AB/AC paths while BC1/BC2 shrank by some other rule let BC2 sweep through the
  // live content hanging off A once B and C were nearly antipodal (the dead
  // triangle spanning most of the sphere), e.g. A's external edge and whatever
  // it leads to; one common isotopy keeps all four edges consistent.
  const vx = state.vertices.get(collapse.x);
  const pole = vx ? vx.pos : { x: -va.pos.x, y: -va.pos.y, z: -va.pos.z };
  const shrink = (path: SpherePoint[]) => shrinkTowardAnchor(path, va.pos, pole, newRemaining);

  const abNow = shrink(collapse.abPath); // A -> current B
  const acNow = shrink(collapse.acPath); // A -> current C
  abNow[0] = { ...va.pos }; acNow[0] = { ...va.pos }; // A itself may have drifted since the snapshot
  vb.pos = abNow[abNow.length - 1];
  vc.pos = acNow[acNow.length - 1];

  const eAB = state.edges.get(collapse.triEdgeAB);
  if (eAB) eAB.points = eAB.v1 === collapse.a ? abNow : [...abNow].reverse();
  const eAC = state.edges.get(collapse.triEdgeAC);
  if (eAC) eAC.points = eAC.v1 === collapse.a ? acNow : [...acNow].reverse();

  for (const [eid, frozenPath] of [
    [collapse.triEdgeBC1, collapse.bc1Path],
    [collapse.triEdgeBC2, collapse.bc2Path],
  ] as const) {
    const e = state.edges.get(eid);
    if (!e) continue;
    const newPts = shrink(frozenPath); // B-first
    e.points = e.v1 === collapse.b ? newPts : [...newPts].reverse();
  }

  return { done: false, popAt: null };
}

// ===========================================================================
// Bigon-tip collapse
// ===========================================================================
//
// Condition: a degree-2 isolated vertex W whose two incident edges both go to
// the same degree-3 vertex A (a "dead bigon" hanging off A's third edge).
//
// Naively eliminating W would leave A with degree 1 (a false appendage).
// Instead:
//   • If A's external neighbour X is live  → leave the bigon in place.
//   • If A's external neighbour X is dead  → W slerps to A; on collision A is
//     deleted, the two bigon edges become a self-loop on W, and A's external
//     edge is re-rooted at W (giving W degree 3 = dead).

export interface BigonTipCollapse {
  kind: 'bigon-tip';
  w: VertexId;    // degree-2 bigon vertex (does the moving)
  a: VertexId;    // degree-3 anchor (gets popped on contact)
  e1: EdgeId;     // first bigon edge  (between W and A)
  e2: EdgeId;     // second bigon edge (between W and A)
  eExt: EdgeId;   // A's single external edge
  x: VertexId;    // external neighbour of A
}

const BIGON_TIP_SHRINK_STEP = 0.09;
const BIGON_TIP_POP_RADIUS  = 0.04;

/**
 * Scan for a dead bigon-tip: a degree-2 isolated vertex W whose two incident
 * edges both connect to the same degree-3 vertex A, where A's external
 * neighbour is also dead. Returns the first match or null.
 */
export function detectBigonTip(state: GameState): BigonTipCollapse | null {
  const living = livingVertexSet(state);

  for (const v of state.vertices.values()) {
    if (v.degree !== 2) continue;
    if (living.has(v.id)) continue;

    const incident: { id: EdgeId; v1: VertexId; v2: VertexId; points: SpherePoint[] }[] = [];
    for (const e of state.edges.values()) {
      if (e.v1 === v.id || e.v2 === v.id) incident.push(e);
    }
    if (incident.length !== 2) continue;

    const [e1, e2] = incident;
    const a1 = e1.v1 === v.id ? e1.v2 : e1.v1;
    const a2 = e2.v1 === v.id ? e2.v2 : e2.v1;
    if (a1 !== a2) continue; // not a bigon

    const A = a1;
    const vA = state.vertices.get(A);
    if (!vA || vA.degree !== 3) continue;

    // Find A's one external edge (not e1 or e2).
    const bigonSet = new Set([e1.id, e2.id]);
    let eExt: typeof e1 | null = null;
    for (const e of state.edges.values()) {
      if (bigonSet.has(e.id)) continue;
      if (e.v1 === A || e.v2 === A) { eExt = e; break; }
    }
    if (!eExt) continue;

    const x = eExt.v1 === A ? eExt.v2 : eExt.v1;
    const vX = state.vertices.get(x);
    if (!vX) continue;

    // X live → leave the bigon alone (no collapse).
    if (vX.degree < 3) continue;

    // W slerping onto A shrinks the bigon's own face (the one whose walk is just W, A) to nothing:
    // it must be empty.
    const e1Full = state.edges.get(e1.id)!;
    const bigonFace = [e1Full.leftRegion, e1Full.rightRegion].find(id => state.regions.get(id)?.boundaries.some(bd => {
      const real = bd.entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
      return real.length === 2 && real.every(en => en.vertexId === v.id || en.vertexId === A);
    }));
    if (bigonFace === undefined || !faceIsEmpty(state, bigonFace)) continue;

    return { kind: 'bigon-tip', w: v.id, a: A, e1: e1.id, e2: e2.id, eExt: eExt.id, x };
  }
  return null;
}

/**
 * One frame of bigon-tip collapse.  W slerps toward A; on contact A is deleted,
 * the two bigon edges become a self-loop on W, and A's external edge is
 * re-rooted at W.  Result: W.degree = 3 (dead), no false appendage.
 * @public
 */
export function bigonTipStep(
  state: GameState,
  collapse: BigonTipCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const vw = state.vertices.get(collapse.w);
  const va = state.vertices.get(collapse.a);
  if (!vw || !va) return { done: true, popAt: null };

  const target = va.pos;
  const dist = sphereAngle(vw.pos, target);

  if (dist < BIGON_TIP_POP_RADIUS) {
    if (!canonReady()) return { done: false, popAt: null }; // hold until the engine can vet the surgery
    const popAt = { ...target };

    const e1   = state.edges.get(collapse.e1);
    const e2   = state.edges.get(collapse.e2);
    const eExt = state.edges.get(collapse.eExt);
    if (!e1 || !e2 || !eExt) return { done: true, popAt: null };

    // Self-loop on W: w→(via e1)→A→(via e2 reversed)→w
    const wToA = pointsFrom(e1, collapse.w);
    const aToW = pointsFrom(e2, collapse.a);
    const loopPoints: SpherePoint[] = [...wToA, ...aToW.slice(1)];

    // Re-root A's external edge: replace A's endpoint with W's position.
    const aToX = pointsFrom(eExt, collapse.a);
    aToX[0] = { ...target };

    const ok = commitIfEncodingPreserved(state, () => {
      deleteVertices(state, [collapse.a]);
      vw.pos = { ...target }; // W takes A's former position
      addEdge(state, collapse.w, collapse.w, loopPoints);
      addEdge(state, collapse.w, collapse.x, aToX);
      safeRecompute(state, 'bigonTipStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // Slerp W toward A; re-anchor bigon edge endpoints.
  const step = scaledStep(BIGON_TIP_SHRINK_STEP, tunables.bigonTipSpeed);
  vw.pos = slerp(vw.pos, target, step);
  for (const eid of [collapse.e1, collapse.e2]) pullEdgeToward(state, state.edges.get(eid), target, step);

  return { done: false, popAt: null };
}

// ===========================================================================
// Self-connected-dead collapse (case 7)
// ===========================================================================
//
// A "self-connected dead" vertex S is degree-3 with a self-loop (2 connections)
// and exactly one external edge to vertex T (1 connection). If T is also dead
// (degree 3), the whole S–T configuration can be collapsed.
//
// Two sub-cases:
//
//   Case A — T is NOT self-connected: T has edges to S, X, and Y.
//     Animation: S rides the S-T edge (frozen as a track) to T, which stays fixed, dragging its
//       shrinking self-loop behind it; the edge is whatever of the track S hasn't covered yet.
//     Surgery: delete S, its self-loop, and edge S-T; concatenate T's X and Y
//       edges into a single X-Y edge (through T's position); delete T.
//
//   Case B — T IS also self-connected: T has its own self-loop + edge to S.
//     Animation: S and T ride the track toward its midpoint, each dragging its own loop.
//
// Riding the frozen edge instead of slerping straight at the target keeps the collapse inside its
// own face: the S-T edge is a bridge (the same face on both sides), so S, the shrinking edge and a
// loop kept within S's clearance never sweep over anything, where a straight slerp pulls a curved
// S-T edge across whatever it bends around.
//     Surgery: delete S, T, both self-loops, and edge S-T. Nothing survives.

export interface SelfConnectedDeadCollapse {
  kind: 'self-connected-dead';
  s: VertexId;        // self-connected dead vertex (has self-loop + one external edge)
  t: VertexId;        // the other dead vertex
  selfLoopS: EdgeId;  // S's self-loop
  edgeST: EdgeId;     // edge between S and T
  symmetric: boolean; // true → case B (T also self-connected); false → case A
  selfLoopT?: EdgeId; // T's self-loop (case B only)
  extT1?: EdgeId;     // first external edge of T (case A: goes to nbrT1)
  extT2?: EdgeId;     // second external edge of T (case A: goes to nbrT2)
  nbrT1?: VertexId;
  nbrT2?: VertexId;
  /** Animation state, set up on the first frame (see scdAnimFor). */
  anim?: ScdAnim;
}

/** A self-loop in polar coordinates about its vertex, relative to the vertex's heading along the
 *  track: each point's distance and unit direction (along, left of) the heading. */
interface LoopShape { loop: EdgeId; pts: { d: number; a: number; b: number }[]; radius: number; scale: number }

interface ScdAnim {
  /** The S-T edge as it was when the collapse started, S → T, with cumulative arc length. */
  track: SpherePoint[];
  cum: number[];
  /** Track length still between S and T. */
  gap: number;
  loopS: LoopShape;
  loopT?: LoopShape;
}

const SCD_SHRINK_STEP = 0.09;
const SCD_POP_RADIUS  = 0.05;

/**
 * Find the first self-connected dead vertex S (degree-3, has a self-loop, has
 * exactly one other edge to a dead vertex T). Returns the collapse descriptor or
 * null if none exists.
 */
export function detectSelfConnectedDead(state: GameState): SelfConnectedDeadCollapse | null {
  for (const s of state.vertices.values()) {
    if (s.degree !== 3) continue;

    let selfLoopS: EdgeId | null = null;
    let edgeST: EdgeId | null = null;
    let t: VertexId | null = null;

    for (const e of state.edges.values()) {
      if (e.v1 === s.id && e.v2 === s.id) {
        if (selfLoopS === null) selfLoopS = e.id;
      } else if (e.v1 === s.id || e.v2 === s.id) {
        if (edgeST === null) {
          edgeST = e.id;
          t = e.v1 === s.id ? e.v2 : e.v1;
        }
      }
    }

    if (selfLoopS === null || edgeST === null || t === null) continue;

    const vt = state.vertices.get(t);
    if (!vt || vt.degree !== 3) continue;

    // The pop deletes S's self-loop, merging the face inside it into the one outside: it must be empty.
    const loopEmpty = (eid: EdgeId): boolean => {
      const inside = selfLoopInsideFace(state, state.edges.get(eid)!);
      return inside !== null && faceIsEmpty(state, inside);
    };
    if (!loopEmpty(selfLoopS)) continue;

    // Check T's structure: self-loop and/or external edges (excluding the S-T edge).
    let selfLoopT: EdgeId | null = null;
    const tExternals: { eid: EdgeId; nbr: VertexId }[] = [];

    for (const e of state.edges.values()) {
      if (e.id === edgeST) continue;
      if (e.v1 === t && e.v2 === t) {
        selfLoopT = e.id;
      } else if (e.v1 === t) {
        tExternals.push({ eid: e.id, nbr: e.v2 });
      } else if (e.v2 === t) {
        tExternals.push({ eid: e.id, nbr: e.v1 });
      }
    }

    if (selfLoopT !== null) {
      // Case B: T also has a self-loop — symmetric collapse. The whole component goes, so T's loop
      // must be empty inside too.
      if (!loopEmpty(selfLoopT)) continue;
      return {
        kind: 'self-connected-dead',
        s: s.id, t,
        selfLoopS, edgeST,
        symmetric: true,
        selfLoopT,
      };
    }

    // Case A: T has two external edges to distinct neighbours.
    if (tExternals.length !== 2) continue;
    const [ext1, ext2] = tExternals;
    if (ext1.nbr === ext2.nbr) continue; // surgery would create a self-loop on the shared neighbour

    return {
      kind: 'self-connected-dead',
      s: s.id, t,
      selfLoopS, edgeST,
      symmetric: false,
      extT1: ext1.eid, extT2: ext2.eid,
      nbrT1: ext1.nbr, nbrT2: ext2.nbr,
    };
  }
  return null;
}

/**
 * One frame of self-connected-dead collapse.
 *
 * Case A: S slerps toward T; on pop, S and T are deleted and their topology
 *   is replaced by a single X-Y edge formed by concatenating T's two external edges.
 * Case B: S and T slerp toward their midpoint; on pop, the entire component is deleted.
 */
export function selfConnectedDeadStep(
  state: GameState,
  collapse: SelfConnectedDeadCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const vs = state.vertices.get(collapse.s);
  const vt = state.vertices.get(collapse.t);
  if (!vs || !vt) return { done: true, popAt: null };

  const anim = collapse.anim ??= scdAnimFor(state, collapse);
  if (!anim) return { done: true, popAt: null };

  // S (and T, case B) sit on the track; the pop is where they meet.
  if (anim.gap < (collapse.symmetric ? 2 : 1) * SCD_POP_RADIUS) {
    if (!canonReady()) return { done: false, popAt: null }; // hold until the engine can vet the surgery
    const popAt = collapse.symmetric ? slerp(vs.pos, vt.pos, 0.5) : { ...vt.pos };

    if (collapse.symmetric) {
      // Case B: delete everything — S, T, both self-loops, and edge S-T.
      const ok = commitIfEncodingPreserved(state, () => {
        deleteVertices(state, [collapse.s, collapse.t]);
        safeRecompute(state, 'selfConnectedDeadStep(B)');
      });
      return { done: true, popAt: ok ? popAt : null };
    }

    // Case A: concatenate T's two external edges into X-Y, delete S and T.
    const eExt1 = collapse.extT1 !== undefined ? state.edges.get(collapse.extT1) : undefined;
    const eExt2 = collapse.extT2 !== undefined ? state.edges.get(collapse.extT2) : undefined;
    if (!eExt1 || !eExt2 || collapse.nbrT1 === undefined || collapse.nbrT2 === undefined) {
      return { done: true, popAt: null };
    }
    // Capture the guard-narrowed neighbours as locals — the closure below would
    // otherwise widen these property accesses back to `VertexId | undefined`.
    const nbrT1 = collapse.nbrT1, nbrT2 = collapse.nbrT2;

    // Orient: X→T (reverse ext1 if it runs T→X) then T→Y (forward ext2 if it runs T→Y).
    const xToT = pointsFrom(eExt1, collapse.t).reverse();
    const tToY = pointsFrom(eExt2, collapse.t);
    const newPoints: SpherePoint[] = [...xToT, ...tToY.slice(1)];

    const ok = commitIfEncodingPreserved(state, () => {
      deleteVertices(state, [collapse.s, collapse.t]);
      addEdge(state, nbrT1, nbrT2, newPoints);
      safeRecompute(state, 'selfConnectedDeadStep(A)');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // --- Animation frame ---
  anim.gap *= 1 - scaledStep(SCD_SHRINK_STEP, tunables.selfConnectedDeadSpeed);
  const len = anim.cum[anim.cum.length - 1];
  const sAt = collapse.symmetric ? (len - anim.gap) / 2 : len - anim.gap;
  const tAt = sAt + anim.gap;
  vs.pos = trackPointAt(anim, sAt);
  vt.pos = trackPointAt(anim, tAt);

  // The S-T edge is the stretch of track still between them.
  const eST = state.edges.get(collapse.edgeST);
  if (eST) {
    const pts = [vs.pos, ...anim.track.filter((_, i) => anim.cum[i] > sAt && anim.cum[i] < tAt), vt.pos].map(p => ({ ...p }));
    eST.points = eST.v1 === collapse.s ? pts : pts.reverse();
  }

  // Each loop rides along with its vertex, heading-relative, shrinking.
  carryLoop(state, anim.loopS, vs.pos, trackPointAt(anim, sAt + SCD_HEADING_LOOKAHEAD), anim.gap / len, collapse.edgeST);
  if (anim.loopT) carryLoop(state, anim.loopT, vt.pos, trackPointAt(anim, tAt - SCD_HEADING_LOOKAHEAD), anim.gap / len, collapse.edgeST);

  // In case A, T's external edges only need their T-end re-anchored (T doesn't move).
  if (!collapse.symmetric) {
    for (const eid of [collapse.extT1, collapse.extT2]) {
      const e = eid === undefined ? undefined : state.edges.get(eid);
      if (e) anchorEdge(state, e);
    }
  }

  return { done: false, popAt: null };
}

/** How far ahead along the track (radians) a riding vertex looks for its heading. */
const SCD_HEADING_LOOKAHEAD = 0.01;
/** A carried loop's radius stays within this fraction of its vertex's clearance from other edges. */
const SCD_LOOP_CLEARANCE = 0.7;
/** Most a carried loop may shrink in one frame to meet that clearance (so it never jumps). */
const SCD_LOOP_MAX_SHRINK = 0.25;
/** Halvings a carried loop gets to clear a crossing before it's left as is. */
const SCD_LOOP_MAX_HALVINGS = 12;

/** Freeze the S-T edge as the track, and each loop's shape relative to its vertex's heading. */
function scdAnimFor(state: GameState, c: SelfConnectedDeadCollapse): ScdAnim | undefined {
  const eST = state.edges.get(c.edgeST);
  if (!eST || eST.points.length < 2) return undefined;
  const track = pointsFrom(eST, c.s).map(p => ({ ...p }));
  const cum = [0];
  for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + sphereAngle(track[i - 1], track[i]));
  const len = cum[cum.length - 1];
  if (len <= 0) return undefined;
  const loopS = loopShape(state, c.selfLoopS, track[0], track[1]);
  const loopT = c.symmetric && c.selfLoopT !== undefined
    ? loopShape(state, c.selfLoopT, track[track.length - 1], track[track.length - 2]) : undefined;
  if (!loopS || (c.symmetric && !loopT)) return undefined;
  return { track, cum, gap: len, loopS, loopT };
}

/** The track point `at` radians from S (clamped to the track). */
function trackPointAt(anim: ScdAnim, at: number): SpherePoint {
  const { track, cum } = anim;
  const s = Math.max(0, Math.min(cum[cum.length - 1], at));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1];
  return slerp(track[i - 1], track[i], seg > 0 ? (s - cum[i - 1]) / seg : 0);
}

/** Unit tangent at `p` heading toward `q`, and its left normal p × t. */
function headingFrame(p: SpherePoint, q: SpherePoint): { t: SpherePoint; n: SpherePoint } {
  const k = p.x * q.x + p.y * q.y + p.z * q.z;
  const t = normalize({ x: q.x - k * p.x, y: q.y - k * p.y, z: q.z - k * p.z });
  return { t, n: cross(p, t) };
}

function loopShape(state: GameState, loopId: EdgeId, at: SpherePoint, toward: SpherePoint): LoopShape | undefined {
  const loop = state.edges.get(loopId);
  if (!loop) return undefined;
  const { t, n } = headingFrame(at, toward);
  const pts = loop.points.map(p => {
    const d = sphereAngle(at, p);
    const k = Math.cos(d);
    const v = { x: p.x - k * at.x, y: p.y - k * at.y, z: p.z - k * at.z };
    const a = v.x * t.x + v.y * t.y + v.z * t.z, b = v.x * n.x + v.y * n.y + v.z * n.z;
    const m = Math.hypot(a, b);
    return m > 1e-12 ? { d, a: a / m, b: b / m } : { d: 0, a: 1, b: 0 };
  });
  return { loop: loopId, pts, radius: Math.max(...pts.map(q => q.d)), scale: 1 };
}

/**
 * Redraw a loop at its vertex's new position `at` (heading toward `toward`), scaled to `frac` of
 * its original size, and further as needed to stay within SCD_LOOP_CLEARANCE of the vertex's
 * distance to every other edge but the S-T edge it hangs off: never shrinking more than
 * SCD_LOOP_MAX_SHRINK per frame, never growing back. A scaled loop can still cross something the
 * clearance ball doesn't see (the S-T edge bending back, or a loop so big it wraps the sphere and
 * scales unevenly), so it is then halved until it crosses nothing. Halving can't clear a loop that
 * wraps around past T, since scaling pulls its far side in along S's heading, onto the S-T edge, so
 * a loop still crossing after that is replaced by a teardrop inside its own wedge at the vertex
 * (wedgeTeardrop), then halved again.
 */
function carryLoop(state: GameState, shape: LoopShape, at: SpherePoint, toward: SpherePoint, frac: number, edgeST: EdgeId): void {
  const loop = state.edges.get(shape.loop);
  if (!loop) return;
  let clear = Infinity;
  for (const e of state.edges.values()) {
    if (e.id === loop.id || e.id === edgeST) continue;
    for (let i = 0; i + 1 < e.points.length; i++) clear = Math.min(clear, distanceToArc(at, e.points[i], e.points[i + 1]));
  }
  const fit = Math.min(frac, SCD_LOOP_CLEARANCE * clear / shape.radius);
  shape.scale = Math.min(shape.scale, Math.max(fit, shape.scale * (1 - SCD_LOOP_MAX_SHRINK)));
  const { t, n } = headingFrame(at, toward);
  const draw = (): SpherePoint[] => shape.pts.map(({ d, a, b }) => {
    const rr = d * shape.scale, c = Math.cos(rr), sn = Math.sin(rr);
    return normalize({
      x: at.x * c + (a * t.x + b * n.x) * sn,
      y: at.y * c + (a * t.y + b * n.y) * sn,
      z: at.z * c + (a * t.z + b * n.z) * sn,
    });
  });
  const others = [...state.edges.values()].filter(e => e.id !== loop.id);
  const crosses = () => others.some(e => polylinesProperlyCross(loop.points, e.points));
  const halveClear = () => {
    for (let i = 0; i < SCD_LOOP_MAX_HALVINGS && crosses(); i++) { shape.scale /= 2; loop.points = draw(); }
  };
  loop.points = draw();
  halveClear();
  if (crosses()) {
    wedgeTeardrop(shape, Math.min(SCD_LOOP_CLEARANCE * clear, SCD_TEARDROP_RADIUS));
    loop.points = draw();
    halveClear();
  }
  anchorEdge(state, loop);
}

/** Largest angular radius of a wedgeTeardrop replacement loop. */
const SCD_TEARDROP_RADIUS = 0.1;

/**
 * Replace `shape` with a teardrop of angular radius `radius` that leaves and returns along the
 * loop's own exit directions and sweeps only the wedge between them that doesn't hold the heading
 * (the S-T edge): the corner of the loop's empty inside face, so it bounds an empty face too.
 */
function wedgeTeardrop(shape: LoopShape, radius: number): void {
  const { pts } = shape;
  if (pts.length < 3) return;
  const a1 = Math.atan2(pts[1].b, pts[1].a), a2 = Math.atan2(pts[pts.length - 2].b, pts[pts.length - 2].a);
  const TAU = 2 * Math.PI;
  const ccw = (((a2 - a1) % TAU) + TAU) % TAU;
  const toHeading = (((-a1) % TAU) + TAU) % TAU;
  const sweep = toHeading < ccw ? ccw - TAU : ccw; // the way round that misses the heading (angle 0)
  const N = 13;
  shape.pts = Array.from({ length: N }, (_, k) => {
    const th = a1 + sweep * k / (N - 1);
    return { d: radius * Math.sin(Math.PI * k / (N - 1)), a: Math.cos(th), b: Math.sin(th) };
  });
  shape.radius = radius;
  shape.scale = 1;
}

// ===========================================================================
// Special-collapse registry — the ONE list of collapse kinds (main.ts drives it)
// ===========================================================================

export type SpecialCollapse = LouseCollapse | ParallelDeadCollapse | TripleParallelDeadCollapse | TriangleDeadCollapse
  | EnclosedTriangleCollapse | QuadDeadCollapse | BigonTipCollapse | SelfConnectedDeadCollapse;

interface CollapseKind<C extends SpecialCollapse> {
  detect: (state: GameState) => C | null;
  step: (state: GameState, c: C) => { done: boolean; popAt: SpherePoint | null };
  /** Vertices the animation owns: smoothing and the other surgeries leave them alone. */
  vertices: (c: C) => VertexId[];
  /** Name shown in the Collapse List debug trace. */
  label: (c: C) => string;
}

const COLLAPSE_KINDS: { [K in SpecialCollapse['kind']]: CollapseKind<Extract<SpecialCollapse, { kind: K }>> } = {
  'louse':                { detect: detectLouse,              step: louseCollapseStep,     vertices: c => [...c.outer, c.inner],  label: () => 'louseCollapseStep' },
  'parallel-dead':        { detect: detectParallelDead,       step: parallelDeadStep,      vertices: c => [c.p, c.q],             label: () => 'parallelDeadStep' },
  'triple-parallel-dead': { detect: detectTripleParallelDead, step: tripleParallelDeadStep, vertices: c => [c.p, c.q],            label: () => 'tripleParallelDeadStep' },
  'triangle-dead':        { detect: detectTriangleDead,       step: triangleDeadStep,      vertices: c => [c.a, c.b, c.c],        label: () => 'triangleDeadStep' },
  'enclosed-triangle':    { detect: detectEnclosedTriangle,   step: enclosedTriangleStep,  vertices: c => [c.a, c.b, c.c],        label: () => 'enclosedTriangleStep' },
  'quad-dead':            { detect: detectQuadDead,           step: quadDeadStep,          vertices: c => [c.a, c.b, c.c, c.d],   label: () => 'quadDeadStep' },
  'bigon-tip':            { detect: detectBigonTip,           step: bigonTipStep,          vertices: c => [c.w, c.a],             label: () => 'bigonTipStep' },
  'self-connected-dead':  { detect: detectSelfConnectedDead,  step: selfConnectedDeadStep, vertices: c => [c.s, c.t],
                            label: c => `selfConnectedDeadStep (${c.symmetric ? 'case B symmetric' : 'case A'})` },
};

/** Detection priority: the first kind that matches is the one that animates next. */
const DETECT_ORDER: SpecialCollapse['kind'][] = [
  'louse', 'parallel-dead', 'triple-parallel-dead', 'triangle-dead', 'enclosed-triangle', 'quad-dead', 'bigon-tip', 'self-connected-dead',
];

const kindOf = (c: SpecialCollapse) => COLLAPSE_KINDS[c.kind] as unknown as CollapseKind<SpecialCollapse>;

/** The next special collapse to animate, or null. */
export function detectSpecialCollapse(state: GameState): SpecialCollapse | null {
  for (const k of DETECT_ORDER) {
    const c = (COLLAPSE_KINDS[k] as unknown as CollapseKind<SpecialCollapse>).detect(state);
    if (c) return c;
  }
  return null;
}

/** The vertices a pending special collapse owns. */
export function specialCollapseVertices(c: SpecialCollapse): Set<VertexId> {
  return new Set(kindOf(c).vertices(c));
}

/** One animation frame of a pending special collapse; `label` names it for the debug trace. */
export function stepSpecialCollapse(state: GameState, c: SpecialCollapse): { done: boolean; popAt: SpherePoint | null; label: string } {
  const k = kindOf(c);
  return { ...k.step(state, c), label: k.label(c) };
}
