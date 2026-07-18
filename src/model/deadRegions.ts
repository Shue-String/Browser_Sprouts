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

import type { GameState, VertexId, EdgeId, RegionId, Vertex } from './types';
import { VertexType, VertexVisualState } from './types';
import type { SpherePoint } from '../math/sphere';
import { normalize, slerp, arcsCross } from '../math/sphere';
import { recomputeRegions } from './moves';
import { cloneState, allocEdgeId } from './gameState';
import { canonicalEncoding } from './encoding';
import { canonSync } from '../engine/stalks';
import { smallCircleSelfLoop } from './strokeSynthesis';

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
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dot = Math.max(-1, Math.min(1, pts[i].x*pts[j].x + pts[i].y*pts[j].y + pts[i].z*pts[j].z));
      const d = Math.acos(dot);
      if (d > max) max = d;
    }
  }
  return max;
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
  if (after === null || after !== before) {
    Object.assign(state, snapshot); // rollback — surgery changed the encoding (shouldn't happen)
    return false;
  }
  return true;
}

/** Fraction to slerp each dead point toward its component centroid per frame. */
const DEAD_SHRINK_STEP = 0.06;
/** Geodesic radians: once a dead component's radius drops below this, it pops. */
const POP_RADIUS = 0.12;

/** Vertex ids that lie on the boundary of at least one living region. */
function livingVertexSet(state: GameState): Set<VertexId> {
  const living = new Set<VertexId>();
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    for (const b of r.boundaries) for (const e of b.entries) living.add(e.vertexId);
  }
  return living;
}

/** Map every vertex to its connected-component root (union-find over edges). */
function componentRoots(state: GameState): Map<VertexId, VertexId> {
  const parent = new Map<VertexId, VertexId>();
  const find = (x: VertexId): VertexId => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    while (parent.get(x)! !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  for (const v of state.vertices.keys()) parent.set(v, v);
  for (const e of state.edges.values()) parent.set(find(e.v1), find(e.v2));
  const map = new Map<VertexId, VertexId>();
  for (const v of state.vertices.keys()) map.set(v, find(v));
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

/** Do two polylines (sphere-point arrays) cross anywhere? */
function polylinesCross(a: SpherePoint[], b: SpherePoint[]): boolean {
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++)
      if (arcsCross(a[i], a[i+1], b[j], b[j+1])) return true;
  return false;
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

/**
 * One frame of dead-region shrink + pop. Pulls every fully-dead component toward
 * its centroid; once a component is smaller than POP_RADIUS it is deleted (the
 * deletion is encoding-gated with rollback). Returns whether anything is still
 * animating and whether a component popped this frame.
 *
 * GUARD: a component will not shrink a step that would drag one of its (dead)
 * edges across a LIVING edge. This makes a dead component that encloses living
 * structure simply jam instead of collapsing through it — the proper handling of
 * living-inside-dead is left to the planned topology pass.
 *
 * skipVertices: any component that contains one of these vertex IDs is left alone
 * this frame (used to hand off control to a special-collapse animator).
 */
export function deadRegionStep(
  state: GameState,
  skipVertices?: Set<VertexId>,
): { moving: boolean; popped: boolean; popCentroids: SpherePoint[] } {
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

  const toPop = new Set<VertexId>();
  const centroidByRoot = new Map<VertexId, SpherePoint>();
  let moving = false;

  for (const [root, verts] of compVerts) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of verts) { cx += v.pos.x; cy += v.pos.y; cz += v.pos.z; }
    const c = normalize({ x: cx, y: cy, z: cz });
    centroidByRoot.set(root, c);

    let radius = 0;
    for (const v of verts) {
      const dot = Math.max(-1, Math.min(1, v.pos.x * c.x + v.pos.y * c.y + v.pos.z * c.z));
      radius = Math.max(radius, Math.acos(dot));
    }
    if (radius < POP_RADIUS) { toPop.add(root); continue; }

    const edges = compEdges.get(root) ?? [];

    // Would this shrink step drag a dead edge across a living edge? If so, jam.
    const tent = new Map<VertexId, SpherePoint>();
    for (const v of verts) tent.set(v.id, slerp(v.pos, c, DEAD_SHRINK_STEP));
    let blocked = false;
    for (const e of edges) {
      const tpts = e.points.map((p, i) =>
        i === 0 ? tent.get(e.v1)!
        : i === e.points.length - 1 ? tent.get(e.v2)!
        : slerp(p, c, DEAD_SHRINK_STEP));
      if (livingEdges.some(le => polylinesCross(tpts, le.points))) { blocked = true; break; }
    }
    if (blocked) continue;

    // Commit the shrink: vertices, then edge interior points, then re-anchor.
    for (const v of verts) v.pos = slerp(v.pos, c, DEAD_SHRINK_STEP);
    for (const e of edges) {
      for (let i = 1; i < e.points.length - 1; i++) e.points[i] = slerp(e.points[i], c, DEAD_SHRINK_STEP);
      const v1 = state.vertices.get(e.v1), v2 = state.vertices.get(e.v2);
      if (v1) e.points[0] = { ...v1.pos };
      if (v2) e.points[e.points.length - 1] = { ...v2.pos };
    }
    moving = true;
  }

  // Pop fully-shrunk components (encoding-gated).
  let popped = false;
  if (toPop.size > 0) {
    popped = commitIfEncodingPreserved(state, () => {
      for (const id of [...state.vertices.keys()]) {
        if (toPop.has(comp.get(id)!)) state.vertices.delete(id);
      }
      for (const [id, e] of [...state.edges]) {
        if (toPop.has(comp.get(e.v1)!)) state.edges.delete(id);
      }
      safeRecompute(state, 'deadRegionStep');
    });
  }

  const popCentroids = popped
    ? [...toPop].map(root => centroidByRoot.get(root)!).filter(Boolean)
    : [];

  return { moving: moving || popped, popped, popCentroids };
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
    const incident: { id: EdgeId; v1: VertexId; v2: VertexId; points: SpherePoint[] }[] = [];
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
    const aToW = e1.v2 === v.id ? [...e1.points] : [...e1.points].reverse();
    const wToB = e2.v1 === v.id ? [...e2.points] : [...e2.points].reverse();

    const ok = commitIfEncodingPreserved(state, () => {
      state.vertices.delete(v.id);
      state.edges.delete(e1.id);
      state.edges.delete(e2.id);

      const newEid = allocEdgeId(state);
      state.edges.set(newEid, {
        id: newEid, v1: a, v2: b,
        points: [...aToW, ...wToB.slice(1)],
        leftRegion: -1, rightRegion: -1,
      });

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

  const distA = Math.acos(Math.max(-1, Math.min(1,
    a.pos.x*target.x + a.pos.y*target.y + a.pos.z*target.z)));
  const distW = Math.acos(Math.max(-1, Math.min(1,
    w.pos.x*target.x + w.pos.y*target.y + w.pos.z*target.z)));

  if (distA < LOUSE_POP_RADIUS && distW < LOUSE_POP_RADIUS) {
    const popAt = { ...target };
    const ok = commitIfEncodingPreserved(state, () => {
      state.vertices.delete(collapse.inner);
      state.vertices.delete(collapse.outer[0]);
      state.vertices.delete(collapse.outer[1]);
      // Sweep ALL edges incident to any louse vertex — covers the four detected
      // edges plus any extras created by eliminateIsolatedVertex during animation.
      const louseVerts = new Set([collapse.inner, collapse.outer[0], collapse.outer[1]]);
      for (const [eid, e] of [...state.edges]) {
        if (louseVerts.has(e.v1) || louseVerts.has(e.v2)) state.edges.delete(eid);
      }
      safeRecompute(state, 'louseCollapseStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // Slerp A and W toward X (X stays fixed as the target anchor).
  a.pos = slerp(a.pos, target, LOUSE_SHRINK_STEP);
  w.pos = slerp(w.pos, target, LOUSE_SHRINK_STEP);

  // Slerp edge interior points toward X, then re-anchor endpoints.
  for (const eid of collapse.edges) {
    const e = state.edges.get(eid);
    if (!e) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], target, LOUSE_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1);
    const v2 = state.vertices.get(e.v2);
    if (v1) e.points[0] = { ...v1.pos };
    if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }

  return { done: false, popAt: null };
}

// ===========================================================================
// Parallel-dead collapse (case 2)
// ===========================================================================
//
// Condition: a dead region whose only boundary is a bigon — two parallel edges
// between P and Q — where both P and Q are fully dead (degree 3). P has exactly
// one other edge (to X) and Q has exactly one other edge (to Y).
//
// Animation: P and Q slerp toward each other until they meet.
// Surgery: delete P, Q, both parallel edges, and both external edges; create a
// new X-Y edge whose points concatenate (reversed X-P edge) + (P-Q via one
// parallel) + (Q-Y edge). The new edge is returned for resampling by the caller.

export interface ParallelDeadCollapse {
  kind: 'parallel-dead';
  p: VertexId;
  q: VertexId;
  parallelEdges: [EdgeId, EdgeId];
  extraParallelEdges: EdgeId[];  // any additional P↔Q edges beyond the detected bigon
  edgeP: EdgeId;  // external edge incident to P (the side going to X)
  edgeQ: EdgeId;  // external edge incident to Q (the side going to Y)
  x: VertexId;   // external neighbour of P
  y: VertexId;   // external neighbour of Q
}

const PARALLEL_DEAD_SHRINK_STEP = 0.08;
const PARALLEL_DEAD_POP_RADIUS  = 0.04;

/**
 * Scan for a dead bigon whose two endpoints are both fully dead (degree 3) and
 * each has exactly one external edge. Returns the first match or null.
 */
export function detectParallelDead(state: GameState): ParallelDeadCollapse | null {
  for (const r of state.regions.values()) {
    if (!r.isDead) continue;
    if (r.boundaries.length !== 1) continue;
    const b = r.boundaries[0];
    // Pseudo-vertices (inserted to disambiguate parallel-edge rotation order,
    // see [[project_pseudo_vertices]]) add extra boundary entries for a plain
    // 2-edge bigon without changing its topology — filter them out before
    // counting real vertex entries.
    const realEntries = b.entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
    if (realEntries.length !== 2) continue;

    const e0 = realEntries[0], e1 = realEntries[1];
    if (e0.edgeId === undefined || e1.edgeId === undefined || e0.edgeId === e1.edgeId) continue;

    const p = e0.vertexId, q = e1.vertexId;
    if (p === q) continue;

    const vp = state.vertices.get(p), vq = state.vertices.get(q);
    if (!vp || !vq) continue;
    if (vp.degree !== 3 || vq.degree !== 3) continue;

    // Find the one external edge at P (not in the bigon, and not a FURTHER P↔Q
    // parallel edge — e.g. a third P-Q edge from a triple bigon must never be
    // mistaken for P's external connection, or the region-deadness checks below
    // get silently bypassed).
    let edgeP: EdgeId | null = null, x: VertexId | null = null;
    for (const e of state.edges.values()) {
      if (e.id === e0.edgeId || e.id === e1.edgeId) continue;
      if ((e.v1 === p && e.v2 === q) || (e.v1 === q && e.v2 === p)) continue;
      if (e.v1 === p) { edgeP = e.id; x = e.v2; break; }
      if (e.v2 === p) { edgeP = e.id; x = e.v1; break; }
    }
    if (edgeP === null || x === null) continue;

    // Find the one external edge at Q (same exclusion as above).
    let edgeQ: EdgeId | null = null, y: VertexId | null = null;
    for (const e of state.edges.values()) {
      if (e.id === e0.edgeId || e.id === e1.edgeId) continue;
      if ((e.v1 === p && e.v2 === q) || (e.v1 === q && e.v2 === p)) continue;
      if (e.v1 === q) { edgeQ = e.id; y = e.v2; break; }
      if (e.v2 === q) { edgeQ = e.id; y = e.v1; break; }
    }
    if (edgeQ === null || y === null) continue;
    // x === y is fine here: the surgery below builds a self-loop on the shared neighbour —
    // but ONLY if the third face that shares that neighbour (bounded by edgeP, edgeQ, and
    // whichever parallel edge borders it) is ALSO dead. Two bigon-adjacent regions next to
    // each other like this need BOTH their shared inner pockets empty: r (checked above,
    // the pure bigon interior) and this second one. The far side beyond x (reached via x's
    // third edge) does NOT need to be dead — that's the living structure the collapse must
    // never encroach into.
    if (x === y) {
      const otherSideOf = (eid: EdgeId): RegionId | null => {
        const e = state.edges.get(eid);
        if (!e) return null;
        return e.leftRegion === r.id ? e.rightRegion : e.leftRegion;
      };
      const touchesVertex = (rid: RegionId | null, vid: VertexId): boolean => {
        if (rid === null) return false;
        const reg = state.regions.get(rid);
        return !!reg && reg.boundaries.some(bd => bd.entries.some(en => en.vertexId === vid));
      };
      const side0 = otherSideOf(e0.edgeId);
      const side1 = otherSideOf(e1.edgeId);
      const sharedFaceId = touchesVertex(side0, x) ? side0 : touchesVertex(side1, x) ? side1 : null;
      const sharedFace = sharedFaceId !== null ? state.regions.get(sharedFaceId) : null;
      if (!sharedFace || !sharedFace.isDead) continue;
    }

    // Collect any additional P↔Q edges not part of the detected bigon boundary.
    const extraParallelEdges: EdgeId[] = [];
    for (const e of state.edges.values()) {
      if (e.id === e0.edgeId || e.id === e1.edgeId) continue;
      if ((e.v1 === p && e.v2 === q) || (e.v1 === q && e.v2 === p)) {
        extraParallelEdges.push(e.id);
      }
    }

    return {
      kind: 'parallel-dead',
      p, q,
      parallelEdges: [e0.edgeId, e1.edgeId],
      extraParallelEdges,
      edgeP, edgeQ,
      x, y,
    };
  }
  return null;
}

/**
 * One frame of parallel-dead collapse animation.
 * P and Q slerp toward their midpoint; once within PARALLEL_DEAD_POP_RADIUS the
 * topology surgery fires. Returns the new edge ID so the caller can resample it.
 */
export function parallelDeadStep(
  state: GameState,
  collapse: ParallelDeadCollapse,
): { done: boolean; popAt: SpherePoint | null; newEdgeId?: EdgeId } {
  const vp = state.vertices.get(collapse.p);
  const vq = state.vertices.get(collapse.q);
  if (!vp || !vq) return { done: true, popAt: null };

  const mid = slerp(vp.pos, vq.pos, 0.5);
  const dp = Math.acos(Math.max(-1, Math.min(1, vp.pos.x*mid.x + vp.pos.y*mid.y + vp.pos.z*mid.z)));
  const dq = Math.acos(Math.max(-1, Math.min(1, vq.pos.x*mid.x + vq.pos.y*mid.y + vq.pos.z*mid.z)));

  if (dp < PARALLEL_DEAD_POP_RADIUS && dq < PARALLEL_DEAD_POP_RADIUS) {
    const popAt = { ...mid };

    // Snapshot edge geometry before deletion (P and Q may be mid-animation).
    // External edges can be deleted by eliminateIsolatedVertex if their far endpoint
    // was a dead degree-2 vertex that got spliced out — abort the collapse gracefully.
    const ep  = state.edges.get(collapse.edgeP);
    const eq  = state.edges.get(collapse.edgeQ);
    const e1  = state.edges.get(collapse.parallelEdges[0]);
    if (!ep || !eq || !e1) return { done: true, popAt: null };

    // Orient each segment in the direction needed for the X→Y path.
    const xToPPts = ep.v1 === collapse.p ? [...ep.points].reverse() : [...ep.points];
    const pToQPts = e1.v1 === collapse.p ? [...e1.points] : [...e1.points].reverse();
    const qToYPts = eq.v1 === collapse.q ? [...eq.points] : [...eq.points].reverse();

    // Concatenate: X→P + (P→Q without first point) + (Q→Y without first point).
    const newPoints: SpherePoint[] = [
      ...xToPPts,
      ...pToQPts.slice(1),
      ...qToYPts.slice(1),
    ];

    let newEid = -1;
    const ok = commitIfEncodingPreserved(state, () => {
      state.vertices.delete(collapse.p);
      state.vertices.delete(collapse.q);
      // Sweep for ALL edges incident to P or Q: covers the two detected parallel edges,
      // the external edges, the pre-detected extras, and any further P↔Q edges that
      // eliminateIsolatedVertex may have created during the animation (those wouldn't
      // be in extraParallelEdges since that was snapshotted at detection time).
      for (const [eid, e] of [...state.edges]) {
        if (e.v1 === collapse.p || e.v2 === collapse.p ||
            e.v1 === collapse.q || e.v2 === collapse.q) {
          state.edges.delete(eid);
        }
      }

      newEid = allocEdgeId(state);
      if (collapse.x === collapse.y) {
        // X and Y are the same vertex — the concatenated path is a self-loop.
        // Anchor both ends at X's position (they should already match, but the
        // interior slerp steps above may have nudged the endpoint copies apart).
        const vx = state.vertices.get(collapse.x);
        if (vx) {
          newPoints[0] = { ...vx.pos };
          newPoints[newPoints.length - 1] = { ...vx.pos };
        }
        // A near-collinear concatenated path (e.g. all three segments already shrunk thin by
        // this frame's animation) has no lateral area for edgeRepellers() to bow into a circle.
        // Replace it with a genuine small circle when the whole path is confined to a small
        // neighbourhood; a real spread-out loop is left untouched (same pattern as the other
        // self-loop sites above).
        let selfLoopPoints = newPoints;
        if (vx && maxPairwiseAngularDistance(newPoints) < SELF_LOOP_DEGENERATE_THRESHOLD) {
          selfLoopPoints = smallCircleSelfLoop(vx.pos, newPoints[Math.min(1, newPoints.length - 1)], SELF_LOOP_SYNTH_RADIUS);
        }
        state.edges.set(newEid, {
          id: newEid, v1: collapse.x, v2: collapse.x,
          points: selfLoopPoints, leftRegion: -1, rightRegion: -1,
        });
      } else {
        state.edges.set(newEid, {
          id: newEid, v1: collapse.x, v2: collapse.y,
          points: newPoints, leftRegion: -1, rightRegion: -1,
        });
      }

      safeRecompute(state, 'parallelDeadStep');
    });
    if (ok) return { done: true, popAt, newEdgeId: newEid };
    return { done: true, popAt: null };
  }

  // Slerp P and Q toward their shared midpoint.
  vp.pos = slerp(vp.pos, mid, PARALLEL_DEAD_SHRINK_STEP);
  vq.pos = slerp(vq.pos, mid, PARALLEL_DEAD_SHRINK_STEP);

  // Pull parallel edge interiors toward mid; re-anchor all incident edges.
  for (const eid of [...collapse.parallelEdges, ...collapse.extraParallelEdges]) {
    const e = state.edges.get(eid);
    if (!e) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], mid, PARALLEL_DEAD_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }
  for (const eid of [collapse.edgeP, collapse.edgeQ]) {
    const e = state.edges.get(eid);
    if (!e) continue;
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }

  return { done: false, popAt: null };
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

export interface TripleParallelDeadCollapse {
  kind: 'triple-parallel-dead';
  p: VertexId;
  q: VertexId;
  edges: [EdgeId, EdgeId, EdgeId];
}

const TRIPLE_PARALLEL_SHRINK_STEP = 0.08;
const TRIPLE_PARALLEL_POP_RADIUS  = 0.04;

/**
 * Scan for two degree-3 vertices connected by exactly three parallel edges
 * (using up all of both endpoints' degree, i.e. no external edges) where at
 * least two of the three faces those edges bound are dead. Returns the first
 * match or null.
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

    // The three edges bound exactly three faces (each face touches two of them).
    const faceIds = new Set<RegionId>();
    for (const eid of between) {
      const edge = state.edges.get(eid)!;
      faceIds.add(edge.leftRegion);
      faceIds.add(edge.rightRegion);
    }
    if (faceIds.size !== 3) continue;

    const deadCount = [...faceIds].filter(fid => state.regions.get(fid)?.isDead).length;
    if (deadCount < 2) continue;

    return { kind: 'triple-parallel-dead', p, q, edges: between as [EdgeId, EdgeId, EdgeId] };
  }
  return null;
}

/**
 * One frame of triple-parallel-dead collapse. P and Q slerp toward their
 * midpoint; on contact both vertices and all three connecting edges are
 * deleted (encoding-gated) — nothing survives to reconnect.
 */
export function tripleParallelDeadStep(
  state: GameState,
  collapse: TripleParallelDeadCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const vp = state.vertices.get(collapse.p);
  const vq = state.vertices.get(collapse.q);
  if (!vp || !vq) return { done: true, popAt: null };

  // Collapse toward the point antipodal to nearby live content (see
  // occupiedCentroidAntipode) rather than the raw P/Q midpoint, so this
  // doesn't sweep its shrinking edges across content sitting in the smaller half.
  const mid = occupiedCentroidAntipode(state, new Set([collapse.p, collapse.q]))
    ?? slerp(vp.pos, vq.pos, 0.5);
  const dp = Math.acos(Math.max(-1, Math.min(1, vp.pos.x*mid.x + vp.pos.y*mid.y + vp.pos.z*mid.z)));
  const dq = Math.acos(Math.max(-1, Math.min(1, vq.pos.x*mid.x + vq.pos.y*mid.y + vq.pos.z*mid.z)));

  if (dp < TRIPLE_PARALLEL_POP_RADIUS && dq < TRIPLE_PARALLEL_POP_RADIUS) {
    const popAt = { ...mid };
    const ok = commitIfEncodingPreserved(state, () => {
      state.vertices.delete(collapse.p);
      state.vertices.delete(collapse.q);
      for (const [eid, e] of [...state.edges]) {
        if (e.v1 === collapse.p || e.v2 === collapse.p ||
            e.v1 === collapse.q || e.v2 === collapse.q) {
          state.edges.delete(eid);
        }
      }
      safeRecompute(state, 'tripleParallelDeadStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  vp.pos = slerp(vp.pos, mid, TRIPLE_PARALLEL_SHRINK_STEP);
  vq.pos = slerp(vq.pos, mid, TRIPLE_PARALLEL_SHRINK_STEP);
  for (const eid of collapse.edges) {
    const e = state.edges.get(eid);
    if (!e) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], mid, TRIPLE_PARALLEL_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }

  return { done: false, popAt: null };
}

// ===========================================================================
// Triangle-dead collapse (case 3)
// ===========================================================================
//
// Condition: a dead region whose boundary is a triangle — exactly 3 entries,
// all three vertices degree 3. Each vertex has exactly one external edge
// (to some neighbour X, Y, Z).
//
// Animation: B and C slerp toward A (the lowest-ID of the three). A stays
// fixed as the anchor.
//
// Surgery: delete B, C, all three triangle edges, and the external edges of
// B and C; create new edges A→Y and A→Z from the re-routed external geometry.
// A's own external edge (A→X) is left untouched.

export interface TriangleDeadCollapse {
  kind: 'triangle-dead';
  a: VertexId;                          // lowest-ID vertex (kept after pop)
  b: VertexId;                          // deleted on pop
  c: VertexId;                          // deleted on pop
  triangleEdges: [EdgeId, EdgeId, EdgeId];
  edgeA: EdgeId;                        // external edge at A (kept, re-anchored)
  edgeB: EdgeId;                        // external edge at B → becomes A–Y
  edgeC: EdgeId;                        // external edge at C → becomes A–Z
  x: VertexId;                          // external neighbour of A
  y: VertexId;                          // external neighbour of B
  z: VertexId;                          // external neighbour of C
}

const TRIANGLE_DEAD_SHRINK_STEP = 0.09;
const TRIANGLE_DEAD_POP_RADIUS  = 0.05;

/**
 * Scan for a dead triangular region (3 boundary entries, all degree-3 vertices,
 * each with exactly one external edge). Returns the first match or null.
 */
export function detectTriangleDead(state: GameState): TriangleDeadCollapse | null {
  for (const r of state.regions.values()) {
    if (!r.isDead) continue;
    if (r.boundaries.length !== 1) continue;
    const b = r.boundaries[0];
    // Pseudo-vertices (inserted to disambiguate parallel-edge rotation order,
    // see [[project_pseudo_vertices]]) add extra boundary entries for a plain
    // triangle without changing its topology — filter them out before counting.
    const realEntries = b.entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
    if (realEntries.length !== 3) continue;

    const [e0, e1, e2] = realEntries;
    if (e0.edgeId === undefined || e1.edgeId === undefined || e2.edgeId === undefined) continue;

    const vids = [e0.vertexId, e1.vertexId, e2.vertexId] as [VertexId, VertexId, VertexId];
    if (vids[0] === vids[1] || vids[1] === vids[2] || vids[0] === vids[2]) continue;

    const vs = vids.map(id => state.vertices.get(id)!);
    if (vs.some(v => !v || v.degree !== 3)) continue;

    const triEdgeIds = [e0.edgeId, e1.edgeId, e2.edgeId] as [EdgeId, EdgeId, EdgeId];
    if (new Set(triEdgeIds).size !== 3) continue;
    const triEdgeSet = new Set<EdgeId>(triEdgeIds);

    // Find each vertex's one external edge.
    const findExternal = (vid: VertexId): { eid: EdgeId; nbr: VertexId } | null => {
      for (const e of state.edges.values()) {
        if (triEdgeSet.has(e.id)) continue;
        if (e.v1 === vid) return { eid: e.id, nbr: e.v2 };
        if (e.v2 === vid) return { eid: e.id, nbr: e.v1 };
      }
      return null;
    };

    const exts = vids.map(vid => findExternal(vid));
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
      edgeA: extMap.get(aId)!.eid,
      edgeB: extMap.get(bId)!.eid,
      edgeC: extMap.get(cId)!.eid,
      x: extMap.get(aId)!.nbr,
      y: extMap.get(bId)!.nbr,
      z: extMap.get(cId)!.nbr,
    };
  }
  return null;
}

/**
 * One frame of triangle-dead collapse. B and C slerp toward A; on pop, B and C
 * are deleted and their external edges are re-routed to A.
 */
export function triangleDeadStep(
  state: GameState,
  collapse: TriangleDeadCollapse,
): { done: boolean; popAt: SpherePoint | null } {
  const va = state.vertices.get(collapse.a);
  const vb = state.vertices.get(collapse.b);
  const vc = state.vertices.get(collapse.c);
  if (!va || !vb || !vc) return { done: true, popAt: null };

  // Centroid of the three vertices.
  const target = normalize({
    x: va.pos.x + vb.pos.x + vc.pos.x,
    y: va.pos.y + vb.pos.y + vc.pos.y,
    z: va.pos.z + vb.pos.z + vc.pos.z,
  });

  const da = Math.acos(Math.max(-1, Math.min(1, va.pos.x*target.x + va.pos.y*target.y + va.pos.z*target.z)));
  const db = Math.acos(Math.max(-1, Math.min(1, vb.pos.x*target.x + vb.pos.y*target.y + vb.pos.z*target.z)));
  const dc = Math.acos(Math.max(-1, Math.min(1, vc.pos.x*target.x + vc.pos.y*target.y + vc.pos.z*target.z)));

  if (da < TRIANGLE_DEAD_POP_RADIUS && db < TRIANGLE_DEAD_POP_RADIUS && dc < TRIANGLE_DEAD_POP_RADIUS) {
    const popAt = { ...target };

    // Build geometry for re-routed external edges (B→Y and C→Z become A→Y, A→Z).
    // Guard: external edges can be removed by eliminateIsolatedVertex if their far
    // endpoint was eliminated while the triangle was animating.
    const eb = state.edges.get(collapse.edgeB);
    const ec = state.edges.get(collapse.edgeC);
    if (!eb || !ec) return { done: true, popAt: null };

    const aToY = eb.v1 === collapse.b ? [...eb.points] : [...eb.points].reverse();
    aToY[0] = { ...target };
    const aToZ = ec.v1 === collapse.c ? [...ec.points] : [...ec.points].reverse();
    aToZ[0] = { ...target };

    const ok = commitIfEncodingPreserved(state, () => {
      // Snap A to the centroid.
      va.pos = { ...target };
      // Delete B, C, and all edges incident to either — covers the three triangle
      // edges, the external edges, and any extra edges that eliminateIsolatedVertex
      // may have created adjacent to B or C during the animation.
      state.vertices.delete(collapse.b);
      state.vertices.delete(collapse.c);
      for (const [eid, e] of [...state.edges]) {
        if (e.v1 === collapse.b || e.v2 === collapse.b ||
            e.v1 === collapse.c || e.v2 === collapse.c) {
          state.edges.delete(eid);
        }
      }

      // Create new A→Y and A→Z edges.
      const newEidB = allocEdgeId(state);
      state.edges.set(newEidB, { id: newEidB, v1: collapse.a, v2: collapse.y, points: aToY, leftRegion: -1, rightRegion: -1 });
      const newEidC = allocEdgeId(state);
      state.edges.set(newEidC, { id: newEidC, v1: collapse.a, v2: collapse.z, points: aToZ, leftRegion: -1, rightRegion: -1 });

      safeRecompute(state, 'triangleDeadStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // Slerp all three toward the centroid.
  va.pos = slerp(va.pos, target, TRIANGLE_DEAD_SHRINK_STEP);
  vb.pos = slerp(vb.pos, target, TRIANGLE_DEAD_SHRINK_STEP);
  vc.pos = slerp(vc.pos, target, TRIANGLE_DEAD_SHRINK_STEP);

  // Slerp triangle edge interiors toward centroid; re-anchor all incident edges.
  for (const eid of collapse.triangleEdges) {
    const e = state.edges.get(eid);
    if (!e) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], target, TRIANGLE_DEAD_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }
  for (const eid of [collapse.edgeA, collapse.edgeB, collapse.edgeC]) {
    const e = state.edges.get(eid);
    if (!e) continue;
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }

  return { done: false, popAt: null };
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
          if (v && v.degree < 3) liveIds.add(v.id);
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
          if (entry.vertexId !== scabId) vertsToDelete.add(entry.vertexId);
        }
        if (vertsToDelete.size === 0) continue; // already a clean self-loop

        // Guard: skip if any dead boundary vertex has an edge to a vertex outside
        // this boundary (vertsToDelete ∪ {scabId}).  Deleting such a vertex would
        // orphan a living edge, changing the game state.
        const safeSet = new Set([scabId, ...vertsToDelete]);
        const hasExternalEdge = [...state.edges.values()].some(e =>
          (vertsToDelete.has(e.v1) && !safeSet.has(e.v2)) ||
          (vertsToDelete.has(e.v2) && !safeSet.has(e.v1))
        );
        if (hasExternalEdge) continue;

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
          const eid = entry.edgeId;
          if (eid === undefined) { loopPoints.length = 0; break; }
          const edge = state.edges.get(eid);
          if (!edge) { loopPoints.length = 0; break; }

          const fromVid = entry.vertexId;
          const pts = edge.v1 === fromVid ? [...edge.points] : [...edge.points].reverse();
          if (i === 0) loopPoints.push(...pts);
          else         loopPoints.push(...pts.slice(1));
        }

        if (loopPoints.length < 2) continue;
        // The concatenated boundary walk can be a thin sliver (e.g. a bigon whose edges were
        // already shrunk close together by an earlier collapse animation this frame) —
        // near-collinear geometry that edgeRepellers() can never bow open into a circle (pushing
        // points apart along an already-straight path just redistributes them, it doesn't add
        // lateral area). When the whole walked loop is confined to a small neighbourhood, replace
        // it with a genuine small circle instead of trusting its possibly-degenerate shape; a
        // large real dead-region boundary (which legitimately has spread) is left untouched.
        let finalLoopPoints = loopPoints;
        const scabVertex = state.vertices.get(scabId);
        if (scabVertex && maxPairwiseAngularDistance(loopPoints) < SELF_LOOP_DEGENERATE_THRESHOLD) {
          finalLoopPoints = smallCircleSelfLoop(scabVertex.pos, loopPoints[Math.min(1, loopPoints.length - 1)], SELF_LOOP_SYNTH_RADIUS);
        }

        const ok = commitIfEncodingPreserved(state, () => {
          // Delete ALL edges incident to any dead vertex (covers boundary edges and
          // any extra edges those vertices may have to other parts of the graph).
          for (const [eid, e] of [...state.edges]) {
            if (vertsToDelete.has(e.v1) || vertsToDelete.has(e.v2)) {
              state.edges.delete(eid);
            }
          }
          for (const vid of vertsToDelete) state.vertices.delete(vid);

          // Create the real self-loop on the scab.
          const newEid = allocEdgeId(state);
          state.edges.set(newEid, {
            id: newEid, v1: scabId, v2: scabId,
            points: finalLoopPoints, leftRegion: -1, rightRegion: -1,
          });

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
}

const QUAD_DEAD_SHRINK_STEP = 0.09;
const QUAD_DEAD_POP_RADIUS  = 0.04;

/**
 * Scan for a dead quadrilateral region (4 boundary entries, all degree-3,
 * each with exactly 1 external edge). Returns the first match or null.
 * Prefers labeling where the A-B edge and C-D edge share the same outside
 * region; if the B-C / D-A pair shares an outside region instead, rotates.
 */
export function detectQuadDead(state: GameState): QuadDeadCollapse | null {
  for (const r of state.regions.values()) {
    if (!r.isDead) continue;
    if (r.boundaries.length !== 1) continue;
    const b = r.boundaries[0];
    // Pseudo-vertices (inserted to disambiguate parallel-edge rotation order,
    // see [[project_pseudo_vertices]]) add extra boundary entries for a plain
    // quadrilateral without changing its topology — filter them out before counting.
    const realEntries = b.entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
    if (realEntries.length !== 4) continue;

    const [e0, e1, e2, e3] = realEntries;
    if (e0.edgeId === undefined || e1.edgeId === undefined ||
        e2.edgeId === undefined || e3.edgeId === undefined) continue;

    // All 4 vertices must be distinct and degree 3.
    const vids = [e0.vertexId, e1.vertexId, e2.vertexId, e3.vertexId] as [VertexId, VertexId, VertexId, VertexId];
    if (new Set(vids).size !== 4) continue;
    const vs = vids.map(id => state.vertices.get(id)!);
    if (vs.some(v => !v || v.degree !== 3)) continue;

    // All 4 boundary edges must be distinct.
    const quadEdgeIds = [e0.edgeId, e1.edgeId, e2.edgeId, e3.edgeId] as [EdgeId, EdgeId, EdgeId, EdgeId];
    if (new Set(quadEdgeIds).size !== 4) continue;
    const quadEdgeSet = new Set<EdgeId>(quadEdgeIds);

    // Each vertex must have exactly 1 external edge.
    const findExt = (vid: VertexId): { eid: EdgeId; nbr: VertexId } | null => {
      const results: { eid: EdgeId; nbr: VertexId }[] = [];
      for (const e of state.edges.values()) {
        if (quadEdgeSet.has(e.id)) continue;
        if (e.v1 === vid) results.push({ eid: e.id, nbr: e.v2 });
        else if (e.v2 === vid) results.push({ eid: e.id, nbr: e.v1 });
      }
      return results.length === 1 ? results[0] : null;
    };
    const exts = vids.map(vid => findExt(vid));
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

    return {
      kind: 'quad-dead',
      a, b: b_, c, d,
      edgeAB, edgeBC, edgeCD, edgeDA,
      extA: extA.eid, extB: extB.eid, extC: extC.eid, extD: extD.eid,
      nbrA: extA.nbr, nbrB: extB.nbr, nbrC: extC.nbr, nbrD: extD.nbr,
    };
  }
  return null;
}


/**
 * One frame of quad-dead collapse.
 * A and B slerp toward midAB; C and D slerp toward midCD.
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

  const midAB = slerp(va.pos, vb.pos, 0.5);
  const midCD = slerp(vc.pos, vd.pos, 0.5);

  const dA = Math.acos(Math.max(-1, Math.min(1, va.pos.x*midAB.x + va.pos.y*midAB.y + va.pos.z*midAB.z)));
  const dB = Math.acos(Math.max(-1, Math.min(1, vb.pos.x*midAB.x + vb.pos.y*midAB.y + vb.pos.z*midAB.z)));
  const dC = Math.acos(Math.max(-1, Math.min(1, vc.pos.x*midCD.x + vc.pos.y*midCD.y + vc.pos.z*midCD.z)));
  const dD = Math.acos(Math.max(-1, Math.min(1, vd.pos.x*midCD.x + vd.pos.y*midCD.y + vd.pos.z*midCD.z)));

  if (dA < QUAD_DEAD_POP_RADIUS && dB < QUAD_DEAD_POP_RADIUS &&
      dC < QUAD_DEAD_POP_RADIUS && dD < QUAD_DEAD_POP_RADIUS) {
    const popAt = slerp(midAB, midCD, 0.5); // burst between the two merge points

    // Guard: required edges must still exist (eliminateIsolatedVertex may have
    // removed a neighbouring vertex while the animation was in progress).
    const eAB = state.edges.get(collapse.edgeAB);
    const eBC = state.edges.get(collapse.edgeBC);
    const eCD = state.edges.get(collapse.edgeCD);
    const eDA = state.edges.get(collapse.edgeDA);
    const eExtA = state.edges.get(collapse.extA);
    const eExtB = state.edges.get(collapse.extB);
    const eExtC = state.edges.get(collapse.extC);
    const eExtD = state.edges.get(collapse.extD);
    if (!eAB || !eBC || !eCD || !eDA || !eExtA || !eExtB || !eExtC || !eExtD) {
      return { done: true, popAt: null };
    }

    // Snap A, B → midAB and C, D → midCD before reading edge geometry.
    va.pos = { ...midAB }; vb.pos = { ...midAB };
    vc.pos = { ...midCD }; vd.pos = { ...midCD };

    // Build external edge geometry oriented away from the old vertex (outward).
    const buildExt = (e: typeof eExtA, fromVid: VertexId, newOrigin: SpherePoint): SpherePoint[] => {
      const pts = e.v1 === fromVid ? [...e.points] : [...e.points].reverse();
      pts[0] = { ...newOrigin };
      return pts;
    };
    const pToNbrA = buildExt(eExtA, collapse.a, midAB);
    const pToNbrB = buildExt(eExtB, collapse.b, midAB);
    const qToNbrC = buildExt(eExtC, collapse.c, midCD);
    const qToNbrD = buildExt(eExtD, collapse.d, midCD);

    // P→Q from the former B→C edge (re-anchored at both ends).
    const pToQ = eBC.v1 === collapse.b ? [...eBC.points] : [...eBC.points].reverse();
    pToQ[0] = { ...midAB };
    pToQ[pToQ.length - 1] = { ...midCD };

    const p = Math.min(collapse.a, collapse.b);
    const q = Math.min(collapse.c, collapse.d);

    const ok = commitIfEncodingPreserved(state, () => {
      // Delete A, B, C, D and every edge incident to any of them.
      const quadVids = new Set([collapse.a, collapse.b, collapse.c, collapse.d]);
      for (const [eid, e] of [...state.edges]) {
        if (quadVids.has(e.v1) || quadVids.has(e.v2)) state.edges.delete(eid);
      }
      for (const vid of quadVids) state.vertices.delete(vid);

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

      // Create 5 new edges.
      const addEdge = (v1: VertexId, v2: VertexId, pts: SpherePoint[]) => {
        const eid = allocEdgeId(state);
        state.edges.set(eid, { id: eid, v1, v2, points: pts, leftRegion: -1, rightRegion: -1 });
      };
      addEdge(p, collapse.nbrA, pToNbrA);
      addEdge(p, collapse.nbrB, pToNbrB);
      addEdge(q, collapse.nbrC, qToNbrC);
      addEdge(q, collapse.nbrD, qToNbrD);
      addEdge(p, q, pToQ);

      safeRecompute(state, 'quadDeadStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // Slerp A and B toward midAB, C and D toward midCD.
  va.pos = slerp(va.pos, midAB, QUAD_DEAD_SHRINK_STEP);
  vb.pos = slerp(vb.pos, midAB, QUAD_DEAD_SHRINK_STEP);
  vc.pos = slerp(vc.pos, midCD, QUAD_DEAD_SHRINK_STEP);
  vd.pos = slerp(vd.pos, midCD, QUAD_DEAD_SHRINK_STEP);

  // Pull AB and CD edge interiors toward their merge targets (these edges collapse).
  // BC and DA: re-anchor endpoints AND reparametrize interiors proportionally so
  // the full curve follows the moving endpoints (not just the tips).
  // External edges: re-anchor the quad-vertex endpoint only.
  const shrinkEdge = (eid: EdgeId, target: SpherePoint) => {
    const e = state.edges.get(eid);
    if (!e) return;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], target, QUAD_DEAD_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  };
  // Re-anchor endpoints and linearly reparametrize interiors between them.
  const reparametrizeEdge = (eid: EdgeId) => {
    const e = state.edges.get(eid);
    if (!e) return;
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
    const n = e.points.length;
    if (n < 3) return;
    const p0 = e.points[0], p1 = e.points[n - 1];
    for (let i = 1; i < n - 1; i++) {
      e.points[i] = slerp(p0, p1, i / (n - 1));
    }
  };
  const reanchorEdge = (eid: EdgeId) => {
    const e = state.edges.get(eid);
    if (!e) return;
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  };

  shrinkEdge(collapse.edgeAB, midAB);
  shrinkEdge(collapse.edgeCD, midCD);
  reparametrizeEdge(collapse.edgeBC);
  reparametrizeEdge(collapse.edgeDA);
  reanchorEdge(collapse.extA);
  reanchorEdge(collapse.extB);
  reanchorEdge(collapse.extC);
  reanchorEdge(collapse.extD);

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
// Animation: B and C slerp toward A (A stays fixed as anchor).
//
// Surgery: delete B and C (and all incident edges); create a self-loop on A
// from the parallel BC2 geometry. A keeps its external edge to X.
// Result: A has degree 3 (self-loop = 2, ext = 1) — dead and stable.
// No further collapse is triggered (the self-loop vertex on the end of one edge
// should not slerp anywhere).

export interface EnclosedTriangleCollapse {
  kind: 'enclosed-triangle';
  a: VertexId;         // anchor — has the true external edge; stays put
  b: VertexId;         // enclosed vertex 1 — slerps to A
  c: VertexId;         // enclosed vertex 2 — slerps to A
  triEdgeAB: EdgeId;   // triangle boundary edge A↔B
  triEdgeAC: EdgeId;   // triangle boundary edge A↔C
  triEdgeBC1: EdgeId;  // triangle boundary edge B↔C (bounding the face)
  triEdgeBC2: EdgeId;  // the parallel B↔C edge (becomes the self-loop on A)
  extA: EdgeId;        // A's external edge (A→X)
  x: VertexId;         // external neighbour of A
}

const ENCLOSED_TRIANGLE_SHRINK_STEP = 0.09;
const ENCLOSED_TRIANGLE_POP_RADIUS  = 0.04;

export function detectEnclosedTriangle(state: GameState): EnclosedTriangleCollapse | null {
  for (const r of state.regions.values()) {
    if (!r.isDead) continue;
    if (r.boundaries.length !== 1) continue;
    const b = r.boundaries[0];
    // Pseudo-vertices (inserted to disambiguate parallel-edge rotation order,
    // see [[project_pseudo_vertices]]) add extra boundary entries for a plain
    // triangle without changing its topology — filter them out before counting.
    const realEntries = b.entries.filter(en => !state.vertices.get(en.vertexId)?.isPseudo);
    if (realEntries.length !== 3) continue;

    const [e0, e1, e2] = realEntries;
    if (e0.edgeId === undefined || e1.edgeId === undefined || e2.edgeId === undefined) continue;

    const vids = [e0.vertexId, e1.vertexId, e2.vertexId] as [VertexId, VertexId, VertexId];
    if (vids[0] === vids[1] || vids[1] === vids[2] || vids[0] === vids[2]) continue;

    const vs = vids.map(id => state.vertices.get(id)!);
    if (vs.some(v => !v || v.degree !== 3)) continue;

    const triEdgeIds = [e0.edgeId, e1.edgeId, e2.edgeId] as [EdgeId, EdgeId, EdgeId];
    if (new Set(triEdgeIds).size !== 3) continue;
    const triEdgeSet = new Set<EdgeId>(triEdgeIds);
    const triVidSet  = new Set<VertexId>(vids);

    // For each triangle vertex, find its one non-triangle-edge neighbour.
    const findExternal = (vid: VertexId): { eid: EdgeId; nbr: VertexId } | null => {
      for (const e of state.edges.values()) {
        if (triEdgeSet.has(e.id)) continue;
        if (e.v1 === vid) return { eid: e.id, nbr: e.v2 };
        if (e.v2 === vid) return { eid: e.id, nbr: e.v1 };
      }
      return null;
    };

    const exts = vids.map(vid => findExternal(vid));
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

    return {
      kind: 'enclosed-triangle',
      a: aId, b: bId, c: cId,
      triEdgeAB: edgeAB, triEdgeAC: edgeAC, triEdgeBC1: edgeBC1,
      triEdgeBC2, extA, x,
    };
  }
  return null;
}

/**
 * One frame of enclosed-triangle collapse. B and C slerp toward A; on pop,
 * B and C are deleted and the parallel BC2 edge becomes a self-loop on A.
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
  const db = Math.acos(Math.max(-1, Math.min(1, vb.pos.x*target.x + vb.pos.y*target.y + vb.pos.z*target.z)));
  const dc = Math.acos(Math.max(-1, Math.min(1, vc.pos.x*target.x + vc.pos.y*target.y + vc.pos.z*target.z)));

  if (db < ENCLOSED_TRIANGLE_POP_RADIUS && dc < ENCLOSED_TRIANGLE_POP_RADIUS) {
    const popAt = { ...target };

    const eBC2 = state.edges.get(collapse.triEdgeBC2);
    if (!eBC2) return { done: true, popAt: null };

    // BC2's endpoints (B, C) were both shrunk toward A during the collapse animation, and BC2
    // itself is typically close to a geodesic — squeezing a near-straight edge's two ends
    // together yields a near-collinear "loop" with no lateral area, which edgeRepellers() can
    // never bow open into a circle (pushing points apart along an already-straight path just
    // redistributes them). Synthesize a genuine small circle instead of reusing BC2's squeezed
    // geometry; oriented toward B's pre-deletion position so it bulges the same direction BC2
    // used to run.
    const loopPts = smallCircleSelfLoop(target, vb.pos, SELF_LOOP_SYNTH_RADIUS);

    const ok = commitIfEncodingPreserved(state, () => {
      // Delete B, C, and all edges incident to either.
      state.vertices.delete(collapse.b);
      state.vertices.delete(collapse.c);
      for (const [eid, e] of [...state.edges]) {
        if (e.v1 === collapse.b || e.v2 === collapse.b ||
            e.v1 === collapse.c || e.v2 === collapse.c) {
          state.edges.delete(eid);
        }
      }

      // Create self-loop on A.
      const loopEid = allocEdgeId(state);
      state.edges.set(loopEid, {
        id: loopEid, v1: collapse.a, v2: collapse.a,
        points: loopPts, leftRegion: -1, rightRegion: -1,
      });

      safeRecompute(state, 'enclosedTriangleStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // Slerp B and C toward A; A stays fixed.
  vb.pos = slerp(vb.pos, target, ENCLOSED_TRIANGLE_SHRINK_STEP);
  vc.pos = slerp(vc.pos, target, ENCLOSED_TRIANGLE_SHRINK_STEP);

  // Shrink all triangle edges (including BC2) toward A; re-anchor external edge.
  for (const eid of [collapse.triEdgeAB, collapse.triEdgeAC, collapse.triEdgeBC1, collapse.triEdgeBC2]) {
    const e = state.edges.get(eid);
    if (!e) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], target, ENCLOSED_TRIANGLE_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }
  const eExt = state.edges.get(collapse.extA);
  if (eExt) {
    const v1 = state.vertices.get(eExt.v1); if (v1) eExt.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(eExt.v2); if (v2) eExt.points[eExt.points.length - 1] = { ...v2.pos };
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
  const dist = Math.acos(Math.max(-1, Math.min(1,
    vw.pos.x*target.x + vw.pos.y*target.y + vw.pos.z*target.z)));

  if (dist < BIGON_TIP_POP_RADIUS) {
    const popAt = { ...target };

    const e1   = state.edges.get(collapse.e1);
    const e2   = state.edges.get(collapse.e2);
    const eExt = state.edges.get(collapse.eExt);
    if (!e1 || !e2 || !eExt) return { done: true, popAt: null };

    // Self-loop on W: w→(via e1)→A→(via e2 reversed)→w
    const wToA = e1.v1 === collapse.w ? [...e1.points] : [...e1.points].reverse();
    const aToW = e2.v1 === collapse.a ? [...e2.points] : [...e2.points].reverse();
    const loopPoints: SpherePoint[] = [...wToA, ...aToW.slice(1)];

    // Re-root A's external edge: replace A's endpoint with W's position.
    const aToX = eExt.v1 === collapse.a ? [...eExt.points] : [...eExt.points].reverse();
    aToX[0] = { ...target };

    const ok = commitIfEncodingPreserved(state, () => {
      // Delete A and all edges incident to it.
      state.vertices.delete(collapse.a);
      for (const [eid, e] of [...state.edges]) {
        if (e.v1 === collapse.a || e.v2 === collapse.a) state.edges.delete(eid);
      }

      // Move W to A's former position.
      vw.pos = { ...target };

      // Create self-loop on W.
      const loopEid = allocEdgeId(state);
      state.edges.set(loopEid, {
        id: loopEid, v1: collapse.w, v2: collapse.w,
        points: loopPoints, leftRegion: -1, rightRegion: -1,
      });

      // Create W→X edge.
      const extEid = allocEdgeId(state);
      state.edges.set(extEid, {
        id: extEid, v1: collapse.w, v2: collapse.x,
        points: aToX, leftRegion: -1, rightRegion: -1,
      });

      safeRecompute(state, 'bigonTipStep');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // Slerp W toward A; re-anchor bigon edge endpoints.
  vw.pos = slerp(vw.pos, target, BIGON_TIP_SHRINK_STEP);
  for (const eid of [collapse.e1, collapse.e2]) {
    const e = state.edges.get(eid);
    if (!e) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], target, BIGON_TIP_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }

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
//     Animation: S slerps toward T (T stays fixed).
//     Surgery: delete S, its self-loop, and edge S-T; concatenate T's X and Y
//       edges into a single X-Y edge (through T's position); delete T.
//
//   Case B — T IS also self-connected: T has its own self-loop + edge to S.
//     Animation: S and T slerp toward their shared midpoint.
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
      // Case B: T also has a self-loop — symmetric collapse.
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

  const target = collapse.symmetric ? slerp(vs.pos, vt.pos, 0.5) : vt.pos;

  const distS = Math.acos(Math.max(-1, Math.min(1,
    vs.pos.x * target.x + vs.pos.y * target.y + vs.pos.z * target.z)));
  const distT = collapse.symmetric
    ? Math.acos(Math.max(-1, Math.min(1,
        vt.pos.x * target.x + vt.pos.y * target.y + vt.pos.z * target.z)))
    : 0;

  if (distS < SCD_POP_RADIUS && distT < SCD_POP_RADIUS) {
    const popAt = { ...target };

    if (collapse.symmetric) {
      // Case B: delete everything — S, T, both self-loops, and edge S-T.
      const ok = commitIfEncodingPreserved(state, () => {
        state.vertices.delete(collapse.s);
        state.vertices.delete(collapse.t);
        for (const [eid, e] of [...state.edges]) {
          if (e.v1 === collapse.s || e.v2 === collapse.s ||
              e.v1 === collapse.t || e.v2 === collapse.t) {
            state.edges.delete(eid);
          }
        }
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
    const xToT = eExt1.v1 === collapse.t ? [...eExt1.points].reverse() : [...eExt1.points];
    const tToY = eExt2.v1 === collapse.t ? [...eExt2.points] : [...eExt2.points].reverse();
    const newPoints: SpherePoint[] = [...xToT, ...tToY.slice(1)];

    const ok = commitIfEncodingPreserved(state, () => {
      state.vertices.delete(collapse.s);
      state.vertices.delete(collapse.t);
      for (const [eid, e] of [...state.edges]) {
        if (e.v1 === collapse.s || e.v2 === collapse.s ||
            e.v1 === collapse.t || e.v2 === collapse.t) {
          state.edges.delete(eid);
        }
      }

      const newEid = allocEdgeId(state);
      state.edges.set(newEid, {
        id: newEid, v1: nbrT1, v2: nbrT2,
        points: newPoints, leftRegion: -1, rightRegion: -1,
      });

      safeRecompute(state, 'selfConnectedDeadStep(A)');
    });
    return { done: true, popAt: ok ? popAt : null };
  }

  // --- Animation frame ---

  // S always slerps toward the target.
  vs.pos = slerp(vs.pos, target, SCD_SHRINK_STEP);
  // In case B, T slerps toward the midpoint too.
  if (collapse.symmetric) vt.pos = slerp(vt.pos, target, SCD_SHRINK_STEP);

  // Pull S's self-loop and edge S-T toward target; re-anchor endpoints.
  const edgesToPull = [collapse.selfLoopS, collapse.edgeST];
  if (collapse.symmetric && collapse.selfLoopT !== undefined) edgesToPull.push(collapse.selfLoopT);

  for (const eid of edgesToPull) {
    const e = state.edges.get(eid);
    if (!e) continue;
    for (let i = 1; i < e.points.length - 1; i++) {
      e.points[i] = slerp(e.points[i], target, SCD_SHRINK_STEP);
    }
    const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
    const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }

  // In case A, T's external edges only need their T-end re-anchored (T doesn't move).
  if (!collapse.symmetric) {
    for (const eid of [collapse.extT1, collapse.extT2]) {
      if (eid === undefined) continue;
      const e = state.edges.get(eid);
      if (!e) continue;
      const v1 = state.vertices.get(e.v1); if (v1) e.points[0] = { ...v1.pos };
      const v2 = state.vertices.get(e.v2); if (v2) e.points[e.points.length - 1] = { ...v2.pos };
    }
  }

  return { done: false, popAt: null };
}
