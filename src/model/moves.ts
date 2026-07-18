/**
 * Applies a committed move to the GameState.
 *
 * A move consists of:
 *   - A stroke (ordered SpherePoints from v1 to v2)
 *   - The two endpoint vertex IDs
 *   - Optional geometry callbacks for region-update bookkeeping
 *
 * The geometric layer (vertices/edges) is updated directly here. The
 * combinatorial layer (regions/boundaries/subpositions) is then RECOMPUTED FROM
 * SCRATCH from the planar embedding via a rotation system — see recomputeRegions.
 * There is no incremental split/merge/loop-move handling any more; faces are derived
 * from the actual graph drawing, so the model can never drift from the geometry.
 */

import type { GameState, VertexId, EdgeId, RegionId, Edge, BoundaryEntry } from './types';
import { VertexType, VertexVisualState } from './types';
import type { SpherePoint, CanvasPoint } from '../math/sphere';

/**
 * Returns the slice of edge.points that a BoundaryEntry should traverse.
 * For ordinary entries the full edge is returned (direction from vertexId==e.v1).
 * For entries with pseudoHalf set, only the relevant half is returned.
 * Callers should render pts[0..pts.length-2] (omit last — start of next entry).
 */
export function edgePtsForEntry(entry: BoundaryEntry, edge: Edge): SpherePoint[] {
  const mid = Math.floor(edge.points.length / 2);
  switch (entry.pseudoHalf) {
    case 'first-fwd':  return edge.points.slice(0, mid + 1);
    case 'second-fwd': return edge.points.slice(mid);
    case 'first-rev':  return [...edge.points].reverse().slice(0, edge.points.length - mid);
    case 'second-rev': return [...edge.points].reverse().slice(edge.points.length - 1 - mid);
    default: return edge.v1 === entry.vertexId ? edge.points : [...edge.points].reverse();
  }
}
import { normalize } from '../math/sphere';
import { pointInPolygon, signedArea } from '../math/intersect';
import { allocVertexId, allocEdgeId } from './gameState';
import { beginTrace, trace, snapshotRegions, recordMove } from '../debug/moveLog';
import { canonicalEncoding } from './encoding';

export interface MoveInput {
  v1: VertexId;
  v2: VertexId;
  /** Full stroke from v1's position to v2's position, including endpoints. */
  stroke: SpherePoint[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function applyMove(state: GameState, move: MoveInput): void {
  const { v1, v2, stroke } = move;

  beginTrace();
  const before = snapshotRegions(state);

  // --- Place new vertex at arc-length midpoint of stroke ---
  const cumLen: number[] = [0];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1], b = stroke[i];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    cumLen.push(cumLen[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const half = cumLen[cumLen.length - 1] / 2;
  let midIdx = 0;
  for (let i = 1; i < cumLen.length; i++) {
    if (Math.abs(cumLen[i] - half) < Math.abs(cumLen[midIdx] - half)) midIdx = i;
  }
  const midPos = normalize(stroke[midIdx]);
  const newVid = allocVertexId(state);

  state.vertices.set(newVid, {
    id:        newVid,
    pos:       midPos,
    type:      VertexType.Membrane,
    degree:    2,
    visual:    VertexVisualState.Active,
    isMidpoint: true,
  });

  // --- Split stroke into two edges at the midpoint ---
  const stroke1 = stroke.slice(0, midIdx + 1); // v1 → newV
  const stroke2 = stroke.slice(midIdx);         // newV → v2

  const eid1 = allocEdgeId(state);
  const eid2 = allocEdgeId(state);
  state.edges.set(eid1, { id: eid1, v1, v2: newVid, points: stroke1, leftRegion: -1, rightRegion: -1 });
  state.edges.set(eid2, { id: eid2, v1: newVid, v2, points: stroke2, leftRegion: -1, rightRegion: -1 });

  // --- Recompute the entire combinatorial layer from the new drawing ---
  // Pass the move's identity so the new edge's endpoint darts can be placed by
  // region membership (see recomputeRegions) rather than by raw tangent angle,
  // which is unreliable right at a crowded vertex.
  recomputeRegions(state, { v1, v2, newEdgeIds: [eid1, eid2], midVid: newVid });

  state.moveCount++;

  recordMove(state, { v1, v2, isLoop: v1 === v2 }, 'recompute', before, canonicalEncoding(state));
}

// ===========================================================================
// Rotation-system face recomputation
// ===========================================================================

type V3 = { x: number; y: number; z: number };
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** One directed half-edge (dart). */
interface Dart {
  idx: number;
  edge: Edge;
  origin: VertexId;
  head: VertexId;
  twin: number;     // index of the reverse dart
  angle: number;    // CCW angle (from outside the sphere) of the tangent leaving origin
}

interface Cycle {
  darts: number[];
  comp: number;          // connected-component id of the cycle's vertices
  poly: CanvasPoint[];   // projected boundary polygon
  area: number;          // |signed area| of poly
  rep: CanvasPoint;      // a representative interior-ish point (poly centroid)
  leftInside: boolean;   // is a probe just LEFT of the walk inside the polygon?
}

/** Bearing (CCW angle, tangent-plane) from a point ON the sphere toward another point. */
export function bearingFrom(from: SpherePoint, to: SpherePoint): number {
  const n = from as V3;
  const d: V3 = { x: to.x - n.x, y: to.y - n.y, z: to.z - n.z };
  const t: V3 = { x: d.x - dot(d, n) * n.x, y: d.y - dot(d, n) * n.y, z: d.z - dot(d, n) * n.z };
  const up: V3 = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const e1 = normalize({ x: up.x - dot(up, n) * n.x, y: up.y - dot(up, n) * n.y, z: up.z - dot(up, n) * n.z }) as V3;
  const e2 = cross(n, e1);
  return Math.atan2(dot(t, e2), dot(t, e1));
}

/**
 * Inverse of bearingFrom: a point a small angular `dist` (radians) away from
 * `from`, in direction `bearing` (same CCW-from-outside tangent-plane
 * convention). Used only for debug-overlay rendering — reuses the exact same
 * local-frame construction as bearingFrom/tangentAngle so a drawn ray is
 * guaranteed to point where the real rotation-order code thinks it does.
 */
export function pointAtBearing(from: SpherePoint, bearing: number, dist: number): SpherePoint {
  const n = from as V3;
  const up: V3 = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const e1 = normalize({ x: up.x - dot(up, n) * n.x, y: up.y - dot(up, n) * n.y, z: up.z - dot(up, n) * n.z }) as V3;
  const e2 = cross(n, e1);
  const dir: V3 = { x: Math.cos(bearing) * e1.x + Math.sin(bearing) * e2.x,
                     y: Math.cos(bearing) * e1.y + Math.sin(bearing) * e2.y,
                     z: Math.cos(bearing) * e1.z + Math.sin(bearing) * e2.z };
  return normalize({ x: n.x * Math.cos(dist) + dir.x * Math.sin(dist),
                      y: n.y * Math.cos(dist) + dir.y * Math.sin(dist),
                      z: n.z * Math.cos(dist) + dir.z * Math.sin(dist) });
}

/**
 * Find the first point from `pts[startIdx]` (stepping by `dir`) that is
 * meaningfully displaced from it. Using the point right at an endpoint risks
 * a near-degenerate (near-zero-length) tangent sample; skipping ahead until
 * there's real displacement gives a reliable LOCAL direction of travel at
 * that end of the stroke, without going all the way out to a whole-stroke
 * landmark (like the arc's own midpoint) that varies with the stroke's
 * overall shape/length rather than which way it actually leaves the vertex.
 */
export function stablePt(pts: SpherePoint[], startIdx: number, dir: 1 | -1): SpherePoint {
  const s = pts[startIdx];
  const limit = dir > 0 ? pts.length : -1;
  for (let i = startIdx + dir; i !== limit; i += dir) {
    const p = pts[i];
    const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z;
    if (dx * dx + dy * dy + dz * dz > 1e-4) return p;
  }
  return pts[startIdx + dir * Math.sign(pts.length - 1 - startIdx + dir)] ?? pts[startIdx];
}

interface SpliceSlot {
  /** The OLD edge (departing this vertex) that the new dart(s) must be inserted
   *  immediately after in ring order. Null means the vertex had no prior ring
   *  (degree 0) — the new dart becomes the whole ring. */
  afterEdgeId: EdgeId | null;
}

/**
 * Determine, for each endpoint of a newly-drawn edge, where in that vertex's
 * EXISTING (stable) rotation ring the new dart(s) must be inserted — decided by
 * which pre-existing, still-committed region contains the new edge, not by the
 * new edge's own (fragile, near-vertex) tangent angle.
 *
 * A move's stroke is validated to never cross an existing edge, so its entire
 * interior — represented here by the new midpoint vertex — lies in exactly one
 * region of the graph as it stood BEFORE this move (state.regions, read here
 * before recomputeRegions clears and rebuilds it). That region's boundary walk
 * already records, for each vertex it touches, which existing edge is "next"
 * from there — exactly the ring-adjacency slot the new dart must be spliced
 * into. If a vertex is a joint (visits the region's boundary more than once),
 * the correct slot is picked by comparing bearings against the LOCAL direction
 * the new stroke actually leaves that specific vertex (a stable point a few
 * samples in, skipping near-degenerate near-vertex noise — see stablePt) —
 * NOT the new edge's whole-arc midpoint. A joint's two occurrences differ only
 * in which local wedge of that vertex's own rotation the new dart falls into;
 * the arc's overall midpoint is a whole-stroke landmark that shifts with the
 * stroke's shape/length (e.g. short geodesic vs. the long way around the
 * sphere) even for the identical topological move, so bearing toward it could
 * flip which occurrence looks closer. For a self-loop (v1 === v2) the two new
 * darts share one vertex with no clean "this new edge belongs to this
 * endpoint" split, so that case still falls back to the midpoint landmark.
 */
function computeSpliceSlots(
  state: GameState,
  proj: (p: SpherePoint) => CanvasPoint,
  moveInfo: { v1: VertexId; v2: VertexId; newEdgeIds: [EdgeId, EdgeId]; midVid: VertexId },
): Map<VertexId, SpliceSlot> {
  const result = new Map<VertexId, SpliceSlot>();
  const midPos = state.vertices.get(moveInfo.midVid)?.pos;
  if (!midPos) return result;
  const midProj = proj(midPos);

  // Locate the old (still-committed) region containing the new edge's midpoint:
  // the smallest bounded region whose primary boundary polygon contains it, else
  // the global outer region.
  let containing: { boundaries: { entries: BoundaryEntry[] }[] } | null = null;
  let bestArea = Infinity;
  for (const region of state.regions.values()) {
    if (region.isDead || region.isOuter) continue;
    const primary = region.boundaries[0];
    if (!primary || primary.entries.length < 3) continue;
    const poly = polyFromEntries(primary.entries, state, proj);
    if (poly.length < 3 || !pointInPolygon(poly, midProj)) continue;
    const area = Math.abs(signedArea(poly));
    if (area < bestArea) { bestArea = area; containing = region; }
  }
  if (!containing) {
    for (const region of state.regions.values()) if (region.isOuter) { containing = region; break; }
  }
  if (!containing) return result;

  // For a join (not self-loop), each endpoint has its OWN new edge — v1's is
  // the v1→mid half, v2's is the mid→v2 half — so a genuinely LOCAL bearing
  // (a stable point a few samples in from that endpoint, same technique as
  // the rest of this file's dart-angle sampling) is available and preferred
  // over the whole-arc midpoint landmark for joint disambiguation.
  const localTarget = (vid: VertexId): SpherePoint | null => {
    if (moveInfo.v1 === moveInfo.v2) return null; // self-loop: no clean per-endpoint split
    const edgeId = vid === moveInfo.v1 ? moveInfo.newEdgeIds[0] : moveInfo.newEdgeIds[1];
    const edge = state.edges.get(edgeId);
    if (!edge || edge.points.length < 2) return null;
    return edge.v1 === vid ? stablePt(edge.points, 0, 1) : stablePt(edge.points, edge.points.length - 1, -1);
  };

  const pickSlot = (vid: VertexId): void => {
    const vPos = state.vertices.get(vid)?.pos;
    if (!vPos) return;
    // A candidate's bearing must be sampled the SAME way the rotation ring it
    // will be spliced into is built, and the SAME way the target is: the LOCAL
    // direction the edge leaves THIS vertex (a stable point a few samples in —
    // see stablePt), NOT the edge's whole-arc global midpoint. A candidate old
    // edge can curve dramatically between the vertex and its midpoint — most
    // severely a parallel edge, whose midpoint is the outward bulge where its
    // pseudo-vertex sits — so a midpoint bearing can point nowhere near where the
    // edge actually departs the vertex. Comparing a midpoint-sampled candidate
    // against the locally-sampled target is exactly the mismatch that spliced a
    // join into a joint's WRONG wedge, pulling an unrelated invisible neighbour
    // into the region (see project_membrane_joint_subposition_bug). Sampling both
    // sides locally makes these bearings live in the identical metric as the
    // oldDarts angle-sort in recomputeRegions, so the slot we pick lines up with
    // where the dart actually lands.
    const localBearing = (edge: Edge): number =>
      bearingFrom(vPos, edge.v1 === vid
        ? stablePt(edge.points, 0, 1)
        : stablePt(edge.points, edge.points.length - 1, -1));
    const candidates: { edgeId: EdgeId; bearing: number }[] = [];
    for (const b of containing!.boundaries) {
      for (const entry of b.entries) {
        if (entry.vertexId !== vid || entry.edgeId === undefined) continue;
        const edge = state.edges.get(entry.edgeId);
        if (!edge || edge.points.length < 2) continue;
        candidates.push({ edgeId: entry.edgeId, bearing: localBearing(edge) });
      }
    }
    if (candidates.length === 0) { result.set(vid, { afterEdgeId: null }); return; }
    const targetPt = localTarget(vid) ?? midPos;
    const target = bearingFrom(vPos, targetPt);
    // Splice the new dart at its TRUE angular position in the ring: pick the
    // candidate edge that is the new dart's immediate COUNTER-CLOCKWISE
    // predecessor — the old edge with the smallest CCW gap up to the new dart's
    // bearing. recomputeRegions keeps oldDarts in ascending-angle order and
    // inserts the new dart immediately AFTER this edge, so the CCW predecessor is
    // exactly the slot that leaves the ring sorted (equivalently: which of a
    // joint's two wedges the new stroke enters). The old "closest bearing" rule
    // could pick the FAR edge of an asymmetric wedge and land the dart on the
    // wrong side.
    const TAU = 2 * Math.PI;
    let best = candidates[0], bestGap = Infinity;
    for (const c of candidates) {
      const gap = (((target - c.bearing) % TAU) + TAU) % TAU;
      if (gap < bestGap) { bestGap = gap; best = c; }
    }
    result.set(vid, { afterEdgeId: best.edgeId });
  };

  pickSlot(moveInfo.v1);
  if (moveInfo.v2 !== moveInfo.v1) pickSlot(moveInfo.v2);
  return result;
}

/**
 * Recompute regions, subpositions, edge sides, vertex degrees and types entirely
 * from the current vertices+edges, treating the drawing as a planar graph on the
 * sphere. Faces are traced via a per-vertex rotation system; disconnected pieces
 * (isolated spots, separate clusters) are nested into their containing face by
 * point-in-polygon.
 */
export function recomputeRegions(
  state: GameState,
  moveInfo?: { v1: VertexId; v2: VertexId; newEdgeIds: [EdgeId, EdgeId]; midVid: VertexId },
): void {
  // Determination must NOT depend on the camera (twisting the view must never
  // change the combinatorics). Use a CAMERA-INDEPENDENT, pole-safe stereographic
  // projection whose pole points away from every vertex, so no edge passes near
  // the projection singularity and all point-in-polygon tests are well-conditioned.
  const proj = makeSafeProjection(state);

  // --- Splice plan for the new edge's endpoint darts (region-membership fix). ---
  // A move's stroke is validated to never cross an existing edge, so the entire
  // new edge lies within exactly ONE pre-existing (still-committed) region — the
  // region state.regions held before this call. Rather than trusting a raw
  // tangent-angle comparison of the new dart against a crowded vertex's other
  // darts (fragile: a hooked/near-vertex stroke sample can land ~180° off), find
  // that region by point-in-polygon on the new edge's midpoint vertex, then read
  // off exactly which two OLD, stable darts the new dart must be inserted
  // between at each endpoint. See conversation 2026-07-08 (region determination
  // near-vertex tangent bug).
  const spliceSlots = moveInfo ? computeSpliceSlots(state, proj, moveInfo) : null;

  // --- Degrees from the edge set (self-loop edges count twice). ---
  const degree = new Map<VertexId, number>();
  for (const v of state.vertices.keys()) degree.set(v, 0);
  for (const e of state.edges.values()) {
    degree.set(e.v1, (degree.get(e.v1) ?? 0) + 1);
    degree.set(e.v2, (degree.get(e.v2) ?? 0) + 1);
  }
  for (const v of state.vertices.values()) v.degree = degree.get(v.id) ?? 0;

  // --- Connected components over the graph (isolated vertices are singletons). ---
  const parent = new Map<VertexId, VertexId>();
  const find = (x: VertexId): VertexId => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    while (parent.get(x)! !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  for (const v of state.vertices.keys()) parent.set(v, v);
  for (const e of state.edges.values()) { parent.set(find(e.v1), find(e.v2)); }

  // --- Pseudo-vertices for parallel edges (rotation-system orientation fix). ---
  // Two parallel edges between A and B produce darts at A with nearly-identical
  // angles (both pointing toward B), making ring-sort unreliable.  Fix: insert
  // a pseudo-vertex at each arc's index-midpoint so the darts at A aim at
  // distinct positions instead.  IDs are large negatives (-9999, -9998, …) and
  // are rebuilt fresh every recomputeRegions call.
  //
  // Pseudo-vertices are inserted unconditionally for every parallel-edge pair.
  // (Previously gated to only pairs where both endpoints were exclusively
  // connected to each other, since permanent pseudo-vertices caused spurious
  // boundary entries that confused dead-region collapse. That was fixed by
  // having fullyDeadByComponent skip isPseudo vertices — see deadRegions.ts —
  // so it's now safe to always insert them. The gated version left the
  // rotation-system ring-sort to fall back on stablePt tangent disambiguation
  // once either endpoint gained another connection, which isn't always enough
  // angular separation and produced wrong face cycles — a parallel-edge region
  // vanishing into a spurious self-loop scab.)
  for (const id of [...state.vertices.keys()]) { if (state.vertices.get(id)?.isPseudo) state.vertices.delete(id); }
  const pseudoOfEdge = new Map<number, VertexId>(); // edgeId → pseudo-vertex ID
  let nextPseudoId = -9999;
  const edgeList = [...state.edges.values()];
  // Group edges by canonical (min,max) endpoint pair to find parallel sets.
  const edgesByPair = new Map<string, typeof edgeList>();
  for (const e of edgeList) {
    const key = `${Math.min(e.v1, e.v2)}_${Math.max(e.v1, e.v2)}`;
    let arr = edgesByPair.get(key);
    if (!arr) { arr = []; edgesByPair.set(key, arr); }
    arr.push(e);
  }
  for (const parallelEdges of edgesByPair.values()) {
    if (parallelEdges.length < 2) continue;
    const A = parallelEdges[0].v1;
    for (const e of parallelEdges) {
      if (e.points.length < 3) continue;
      const midIdx = Math.floor(e.points.length / 2);
      const pv = { id: nextPseudoId--, pos: e.points[midIdx], type: VertexType.Dead,
                   degree: 0, visual: VertexVisualState.Saturated, isPseudo: true, pseudoEdgeId: e.id };
      state.vertices.set(pv.id, pv);
      pseudoOfEdge.set(e.id, pv.id);
      parent.set(pv.id, pv.id);
      parent.set(find(A), find(pv.id)); // union pseudo into the component
    }
  }

  const pseudoIds = new Set<VertexId>(pseudoOfEdge.values());

  // --- Build darts + per-vertex rotation order. Phantom edges excluded. ---
  const darts: Dart[] = [];
  const tangentAngle = (vid: VertexId, neighbor: SpherePoint): number =>
    bearingFrom(state.vertices.get(vid)!.pos, neighbor);
  for (const e of state.edges.values()) {
    const aNbr = stablePt(e.points, 0, 1);
    const bNbr = stablePt(e.points, e.points.length - 1, -1);
    const pvId = pseudoOfEdge.get(e.id);
    if (pvId !== undefined) {
      // Parallel edge: split through pseudo-vertex P at arc midpoint.
      // Emit 4 darts: A→P, P→A, P→B, B→P.
      // The darts at A and B now aim at geometrically distinct pseudo-vertices
      // rather than both aiming at the same real endpoint — reliable angle sort.
      const midIdx = Math.floor(e.points.length / 2);
      const pvAward = e.points[Math.max(0, midIdx - 1)]; // direction from P toward A
      const pvBward = e.points[Math.min(e.points.length - 1, midIdx + 1)]; // direction from P toward B
      const ai = darts.length;
      darts.push({ idx: ai,     edge: e, origin: e.v1, head: pvId,  twin: ai + 1, angle: tangentAngle(e.v1, aNbr) });
      darts.push({ idx: ai + 1, edge: e, origin: pvId,  head: e.v1, twin: ai,     angle: tangentAngle(pvId,  pvAward) });
      darts.push({ idx: ai + 2, edge: e, origin: pvId,  head: e.v2, twin: ai + 3, angle: tangentAngle(pvId,  pvBward) });
      darts.push({ idx: ai + 3, edge: e, origin: e.v2, head: pvId,  twin: ai + 2, angle: tangentAngle(e.v2,  bNbr) });
    } else {
      const ai = darts.length;
      darts.push({ idx: ai,     edge: e, origin: e.v1, head: e.v2, twin: ai + 1, angle: tangentAngle(e.v1, aNbr) });
      darts.push({ idx: ai + 1, edge: e, origin: e.v2, head: e.v1, twin: ai,     angle: tangentAngle(e.v2, bNbr) });
    }
  }

  const outByVertex = new Map<VertexId, number[]>();
  for (const d of darts) {
    const list = outByVertex.get(d.origin);
    if (list) list.push(d.idx); else outByVertex.set(d.origin, [d.idx]);
  }
  const newEdgeIdSet = new Set(moveInfo?.newEdgeIds ?? []);
  for (const [vid, list] of outByVertex.entries()) {
    const slot = spliceSlots?.get(vid);
    if (!slot) { list.sort((a, b) => darts[a].angle - darts[b].angle); continue; }
    // This vertex is an endpoint of the just-added edge: keep the OLD darts in
    // their existing (stable) angle order, and splice the new dart(s) in at the
    // ring position determined by region membership rather than by comparing
    // the new dart's own (potentially unreliable) angle against the rest.
    const oldDarts = list.filter(di => !newEdgeIdSet.has(darts[di].edge.id));
    const newDarts = list.filter(di => newEdgeIdSet.has(darts[di].edge.id));
    oldDarts.sort((a, b) => darts[a].angle - darts[b].angle);
    newDarts.sort((a, b) => darts[a].angle - darts[b].angle);
    let insertAt = oldDarts.length;
    if (slot.afterEdgeId !== null) {
      const pos = oldDarts.findIndex(di => darts[di].edge.id === slot.afterEdgeId);
      if (pos >= 0) insertAt = pos + 1;
    }
    list.length = 0;
    list.push(...oldDarts.slice(0, insertAt), ...newDarts, ...oldDarts.slice(insertAt));
  }

  // DEBUG: dump per-vertex angle order + flag near-tied angles (candidate cause
  // of nondeterministic face-tracing when two darts at a vertex sort unstably).
  const ANGLE_TIE_EPS = 1e-3;
  for (const [vid, list] of outByVertex.entries()) {
    if (list.length < 2) continue;
    const parts = list.map(di => `d${di}->${darts[di].head}@${darts[di].angle.toFixed(6)}`);
    trace(`angles v${vid}: ${parts.join('  ')}`);
    for (let i = 0; i < list.length; i++) {
      const a = darts[list[i]].angle;
      const b = darts[list[(i + 1) % list.length]].angle;
      let gap = b - a;
      if (gap < 0) gap += 2 * Math.PI;
      if (gap < ANGLE_TIE_EPS) {
        trace(`  ** NEAR-TIE at v${vid}: d${list[i]} vs d${list[(i + 1) % list.length]}, gap=${gap.toFixed(6)}`);
      }
    }
  }

  const posInRing = new Map<number, number>(); // dart idx → position within its origin's ring
  for (const list of outByVertex.values()) list.forEach((di, i) => posInRing.set(di, i));

  // next dart around a face (interior on the left): arrive via d into head H, take
  // the dart immediately CLOCKWISE from twin(d) in H's CCW ring.
  const nextDart = (di: number): number => {
    const tw = darts[di].twin;
    const ring = outByVertex.get(darts[tw].origin)!;
    const p = posInRing.get(tw)!;
    return ring[(p - 1 + ring.length) % ring.length];
  };

  // --- Trace face cycles. ---
  const cycles: Cycle[] = [];
  const visited = new Set<number>();
  for (let s = 0; s < darts.length; s++) {
    if (visited.has(s)) continue;
    const seq: number[] = [];
    let cur = s;
    do {
      visited.add(cur);
      seq.push(cur);
      cur = nextDart(cur);
    } while (cur !== s && !visited.has(cur));

    const poly = polyFromDarts(seq, darts, proj, pseudoIds);
    const leftInside = probeLeftInside(seq, darts, poly, proj, pseudoIds);
    // Placeholder — replaced below with a probe-based point once leftInside is
    // final (see the degenerate-self-loop correction, which can still flip it).
    const rep = poly.length ? poly[0] : { px: 0, py: 0 };
    cycles.push({ darts: seq, comp: find(darts[s].origin), poly, area: Math.abs(signedArea(poly)), rep, leftInside });
  }

  // --- Degenerate self-loop correction. A lone self-loop bisects whatever face
  //     it's drawn in into exactly two cycles: a tiny (often monogon) loop-alone
  //     cycle and the remainder. Those two MUST be exactly complementary — one
  //     outer, one bounded — since they trace the same physical curve from
  //     opposite sides. But probeLeftInside's vote for the monogon rests on a
  //     single dart (the self-loop's own), while the remainder's vote is a
  //     majority over every other dart in the component; the monogon's lone
  //     vote can come out wrong and agree with the remainder's instead of
  //     opposing it. When a component resolves to exactly two cycles that
  //     agree — a contradiction — trust the cycle backed by more darts and
  //     flip the other, rather than falling through to the global fallback
  //     below (which picks an arbitrary side and can misclassify the true
  //     outer face as bounded, orphaning any untouched spot into its own
  //     spurious subposition).
  const cyclesByComp = new Map<number, number[]>();
  cycles.forEach((c, i) => {
    let arr = cyclesByComp.get(c.comp);
    if (!arr) { arr = []; cyclesByComp.set(c.comp, arr); }
    arr.push(i);
  });
  for (const idxs of cyclesByComp.values()) {
    if (idxs.length !== 2) continue;
    const [i, j] = idxs;
    if (cycles[i].leftInside !== cycles[j].leftInside) continue; // already complementary
    const weaker = cycles[i].darts.length <= cycles[j].darts.length ? i : j;
    cycles[weaker].leftInside = !cycles[weaker].leftInside;
    trace(`recompute: forced complementary leftInside for degenerate 2-cycle component ` +
      `(comp=${cycles[i].comp}), flipped cycle ${weaker}`);
  }

  // --- Representative points, now that leftInside is final. A cycle's own
  //     boundary polygon is IDENTICAL to its complementary twin's (a loop's two
  //     halves trace the same physical curve), so a naive vertex-average
  //     centroid sits right on that shared curve — an ambiguous, floating-point-
  //     sensitive point that can land on the wrong side, or read as "inside"
  //     some unrelated nearby polygon in containingFace's point-in-polygon test
  //     (the actual cause of the "sometimes right, sometimes wrong" subposition
  //     splitting: a small loop's outer-face rep point spuriously testing
  //     positive against a different, unrelated small loop's polygon). Instead,
  //     probe a point a few pixels off one edge of the cycle's own curve, on the
  //     side leftInside says is genuinely interior to THIS cycle — reliable
  //     regardless of the cycle's shape or where else on the sphere it sits.
  for (const c of cycles) {
    c.rep = probeInsidePoint(c.darts, darts, proj, pseudoIds, c.leftInside) ?? c.rep;
  }

  // --- Classify each cycle as a bounded face vs its component's exterior cycle.
  //     A loop's two halves share an identical polygon, so containment can't tell
  //     them apart — only orientation can. With consistent dart orientation the
  //     face lies on one fixed side of every dart; "bounded" means that side is
  //     INSIDE the polygon. Which side (handedness) is a global constant, picked
  //     so that the number of exterior cycles equals the number of components
  //     (each component has exactly one outer face). ---
  const compsWithDarts = new Set(cycles.map(c => c.comp)).size;
  const extIfFaceLeft  = cycles.filter(c => !c.leftInside).length;   // bounded ⇔ leftInside
  const extIfFaceRight = cycles.filter(c => c.leftInside).length;    // bounded ⇔ !leftInside
  let faceOnLeft: boolean;
  if (extIfFaceLeft === compsWithDarts) {
    faceOnLeft = true;
  } else if (extIfFaceRight === compsWithDarts) {
    faceOnLeft = false;
  } else {
    // Neither handedness yields exactly one exterior cycle per component. That
    // means the per-cycle leftInside vote is internally inconsistent — a sign of
    // a near-degenerate drawing or genuine model corruption. Pick the more
    // plausible side and leave a breadcrumb; the dead-region surgery should
    // treat a recompute that logs this as suspect.
    faceOnLeft = extIfFaceLeft <= extIfFaceRight;
    trace(`recompute: handedness vote inconsistent — comps=${compsWithDarts}, ` +
      `extIfLeft=${extIfFaceLeft}, extIfRight=${extIfFaceRight}`);
  }
  const isOuterCycle = cycles.map(c => (faceOnLeft ? !c.leftInside : c.leftInside));

  // --- Faces. Bounded (inner) cycles are standalone faces; outer cycles and
  //     isolated vertices nest into the smallest bounded face that contains them
  //     (excluding their own component), else the single global outer face. ---
  interface Face { boundaries: BoundaryEntry[][]; isOuter: boolean; }
  const boundedIdx: number[] = [];
  cycles.forEach((_, i) => { if (!isOuterCycle[i]) boundedIdx.push(i); });

  const faces: Face[] = [];
  const cycleToFace = new Map<number, number>(); // bounded cycle idx → face index
  for (const ci of boundedIdx) {
    cycleToFace.set(ci, faces.length);
    faces.push({ boundaries: [entriesFromDarts(cycles[ci].darts, darts, pseudoIds)], isOuter: false });
  }
  const globalOuter: Face = { boundaries: [], isOuter: true };

  // Smallest bounded face (from another component) whose polygon contains pt.
  const containingFace = (pt: CanvasPoint, ownComp: number | null): number => {
    let best = -1, bestArea = Infinity;
    for (const ci of boundedIdx) {
      if (ownComp !== null && cycles[ci].comp === ownComp) continue;
      if (cycles[ci].poly.length >= 3 && pointInPolygon(cycles[ci].poly, pt) && cycles[ci].area < bestArea) {
        bestArea = cycles[ci].area; best = cycleToFace.get(ci)!;
      }
    }
    return best;
  };

  // Outer cycles → attach as a boundary of their containing face (a hole).
  cycles.forEach((c, i) => {
    if (!isOuterCycle[i]) return;
    const fi = containingFace(c.rep, c.comp);
    const entries = entriesFromDarts(c.darts, darts, pseudoIds);
    (fi >= 0 ? faces[fi] : globalOuter).boundaries.push(entries);
  });

  // Isolated vertices (degree 0) → single-entry boundary in their containing face.
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue;
    if ((degree.get(v.id) ?? 0) !== 0) continue;
    const fi = containingFace(proj(v.pos), null);
    const entry: BoundaryEntry[] = [{ vertexId: v.id, side: 'only' }];
    (fi >= 0 ? faces[fi] : globalOuter).boundaries.push(entry);
  }

  faces.push(globalOuter);

  // --- isOuter: the global-outer (catch-all) face is the one containing the
  //     projection pole — the unbounded point of the safe projection. If the
  //     sphere is fully tiled (nothing nested to the outer), fall back to the
  //     face with the largest-area boundary (the one wrapping everything). ---
  if (globalOuter.boundaries.length === 0) {
    globalOuter.isOuter = false;
    let best = -1, bestArea = -1;
    for (let fi = 0; fi < faces.length - 1; fi++) {
      for (const b of faces[fi].boundaries) {
        const a = Math.abs(signedArea(polyFromEntries(b, state, proj)));
        if (a > bestArea) { bestArea = a; best = fi; }
      }
    }
    if (best >= 0) faces[best].isOuter = true; else globalOuter.isOuter = true;
  }

  // --- Commit faces as Regions, keyed by face index. Empty non-outer faces are
  //     skipped, so the surviving region ids need not be contiguous (nothing
  //     indexes regions by a dense 0..k-1 range). ---
  state.regions.clear();
  const regionIds: RegionId[] = [];
  faces.forEach((f, i) => {
    const boundaries = f.boundaries
      .filter(b => b.length > 0)
      .map(b => ({ entries: assignSides(b) }));
    if (boundaries.length === 0 && !f.isOuter) return; // skip empty non-outer
    // Count DISTINCT living vertices by degree band.
    // A region is dead when no legal move can be made within it:
    //   • 0 vertices with degree < 3 → obviously dead
    //   • exactly 1 vertex with degree 2 (and none with degree < 2) → dead:
    //     can't self-loop (need degree < 2) and no second vertex to draw to
    // In all other cases (≥2 living vertices, or a degree-0/1 vertex) a move
    // exists (draw between two degree<3 verts, or self-loop on a degree<2 vert).
    const liveVerts     = new Set<VertexId>();
    const lowDegreeVerts = new Set<VertexId>(); // degree 0 or 1
    for (const b of boundaries) {
      for (const e of b.entries) {
        if (pseudoIds.has(e.vertexId)) continue; // pseudo-vertices don't count toward aliveness
        const d = degree.get(e.vertexId) ?? 0;
        if (d < 3) liveVerts.add(e.vertexId);
        if (d < 2) lowDegreeVerts.add(e.vertexId);
      }
    }
    const isDead = liveVerts.size === 0
      || (liveVerts.size === 1 && lowDegreeVerts.size === 0);
    state.regions.set(i, { id: i, boundaries, isDead, isOuter: f.isOuter });
    regionIds.push(i);
  });
  state.nextRegionId = faces.length;

  // --- Edge left/right regions from the dart→face map (no longer stale). ---
  const faceOfDart = new Map<number, RegionId>();
  cycles.forEach((c, i) => {
    const rid = isOuterCycle[i]
      ? outerCycleFace(i, cycles, boundedIdx, cycleToFace, globalOuterId(faces))
      : cycleToFace.get(i)!;
    for (const di of c.darts) faceOfDart.set(di, rid);
  });
  for (const e of state.edges.values()) {
    // find the two darts of this edge
    let da = -1, db = -1;
    for (const d of darts) { if (d.edge === e) { if (da < 0) da = d.idx; else db = d.idx; } }
    e.leftRegion  = da >= 0 ? (faceOfDart.get(da) ?? -1) : -1;
    e.rightRegion = db >= 0 ? (faceOfDart.get(db) ?? -1) : -1;
  }

  // --- Subpositions: regions linked when they share a living (degree<3) vertex. ---
  state.subpositions = buildSubpositions(state, degree);

  // --- Vertex types/visual from final degrees. ---
  for (const v of state.vertices.values()) classifyVertexByDegree(state, v.id);

  trace(`recompute: ${state.regions.size} regions, ${state.subpositions.length} subpositions, ${cycles.length} face cycles`);
}

/** Region id that an outer cycle's darts border (the face it nests into). */
function outerCycleFace(
  i: number,
  cycles: Cycle[],
  boundedIdx: number[],
  cycleToFace: Map<number, number>,
  globalOuterFace: number,
): RegionId {
  let best = -1, bestArea = Infinity;
  for (const ci of boundedIdx) {
    if (cycles[ci].comp === cycles[i].comp) continue;
    if (cycles[ci].poly.length >= 3 && pointInPolygon(cycles[ci].poly, cycles[i].rep) && cycles[ci].area < bestArea) {
      bestArea = cycles[ci].area; best = cycleToFace.get(ci)!;
    }
  }
  return best >= 0 ? best : globalOuterFace;
}

/** The face index used as the global outer region (always last in `faces`). */
function globalOuterId(faces: { isOuter: boolean }[]): RegionId {
  for (let i = faces.length - 1; i >= 0; i--) if (faces[i].isOuter) return i;
  return faces.length - 1;
}

// ---------------------------------------------------------------------------
// Geometry / cycle helpers
// ---------------------------------------------------------------------------

/** Boundary entries (vertex + outgoing edge) for a dart cycle, sides unassigned.
 *  Pseudo-vertex darts are included with pseudoHalf set so boundary listings and
 *  renderers can draw the correct half of each parallel edge. */
function entriesFromDarts(seq: number[], darts: Dart[], pseudoIds: Set<VertexId>): BoundaryEntry[] {
  return seq.map(di => {
    const d = darts[di];
    const pseudoOrigin = pseudoIds.has(d.origin);
    const pseudoHead   = pseudoIds.has(d.head);
    let pseudoHalf: BoundaryEntry['pseudoHalf'];
    if (pseudoOrigin) {
      pseudoHalf = d.head === d.edge.v2 ? 'second-fwd' : 'second-rev';
    } else if (pseudoHead) {
      pseudoHalf = d.origin === d.edge.v1 ? 'first-fwd' : 'first-rev';
    }
    return { vertexId: d.origin, side: 'only' as const, edgeId: d.edge.id, ...(pseudoHalf ? { pseudoHalf } : {}) };
  });
}

/** Projected polygon following each dart's actual edge curve in walk direction.
 *  For parallel edges split through a pseudo-vertex, only the dart FROM the real
 *  vertex pushes points (covering the full arc); the pseudo-vertex dart is skipped
 *  to avoid double-counting. */
function polyFromDarts(seq: number[], darts: Dart[], project: (p: SpherePoint) => CanvasPoint, pseudoIds: Set<VertexId>): CanvasPoint[] {
  const poly: CanvasPoint[] = [];
  for (const di of seq) {
    const d = darts[di];
    if (pseudoIds.has(d.origin)) continue; // pseudo-vertex dart: partner dart covers this edge
    const pts = d.origin === d.edge.v1 ? d.edge.points : [...d.edge.points].reverse();
    for (let j = 0; j < pts.length - 1; j++) poly.push(project(pts[j]));
  }
  return poly;
}

/** Projected polygon for a finished boundary (entries carry edgeId). */
export function polyFromEntries(
  entries: BoundaryEntry[],
  state: GameState,
  project: (p: SpherePoint) => CanvasPoint,
): CanvasPoint[] {
  const poly: CanvasPoint[] = [];
  for (const e of entries) {
    const edge = e.edgeId !== undefined ? state.edges.get(e.edgeId) : undefined;
    if (edge) {
      const pts = edgePtsForEntry(e, edge);
      for (let j = 0; j < pts.length - 1; j++) poly.push(project(pts[j]));
    } else {
      const v = state.vertices.get(e.vertexId);
      if (v) poly.push(project(v.pos));
    }
  }
  return poly;
}

/**
 * A camera-independent, pole-safe stereographic projection used for all of
 * recomputeRegions' geometry tests. The projection pole is chosen (from a
 * Fibonacci-sphere candidate set) to point as far as possible from every vertex,
 * so no edge passes near the singularity and point-in-polygon / area-sign /
 * handedness tests are well-conditioned regardless of how the view is twisted.
 * Output scale is arbitrary — every consumer is scale-invariant.
 */
export function makeSafeProjection(state: GameState): (p: SpherePoint) => CanvasPoint {
  const verts = [...state.vertices.values()];
  const N = 64;
  const ga = Math.PI * (3 - Math.sqrt(5));
  let pole: V3 = { x: 0, y: 0, z: 1 };
  let bestMaxDot = Infinity;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * i + 1) / N;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    const c: V3 = { x: Math.cos(th) * r, y, z: Math.sin(th) * r };
    let maxDot = -Infinity;
    for (const v of verts) { const d = dot(c, v.pos as V3); if (d > maxDot) maxDot = d; }
    if (maxDot < bestMaxDot) { bestMaxDot = maxDot; pole = c; }
  }
  const up: V3 = Math.abs(pole.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = normalize({ x: up.x - dot(up, pole) * pole.x, y: up.y - dot(up, pole) * pole.y, z: up.z - dot(up, pole) * pole.z }) as V3;
  const ww = cross(pole, u);
  const raw = (p: SpherePoint): CanvasPoint => {
    const dz = dot(p as V3, pole);
    const den = Math.max(1 - dz, 1e-6);
    return { px: dot(p as V3, u) / den, py: dot(p as V3, ww) / den };
  };
  // Scale to a pixel-like magnitude so the fixed probe/offset sizes used by the
  // classification (probeLeftInside, ~3px) are small relative to the geometry.
  let maxR = 1e-6;
  for (const v of verts) { const c = raw(v.pos); maxR = Math.max(maxR, Math.hypot(c.px, c.py)); }
  const scale = 300 / maxR;
  return (p: SpherePoint): CanvasPoint => { const c = raw(p); return { px: c.px * scale, py: c.py * scale }; };
}

/**
 * Decide whether the cycle's interior lies on the LEFT of its walk, by probing a
 * point just left of EVERY dart's midpoint and taking a majority vote.
 *
 * A single probe (the old behaviour) is fragile: one midpoint sitting near
 * another boundary, in a concave pinch, or on a near-degenerate edge flips the
 * whole cycle's bounded/exterior classification — and through the handedness
 * vote, potentially the encoding. Voting over all edges makes the result a
 * stable function of the cycle's shape rather than of one arbitrary edge.
 */
function probeLeftInside(
  seq: number[],
  darts: Dart[],
  poly: CanvasPoint[],
  project: (p: SpherePoint) => CanvasPoint,
  pseudoIds: Set<VertexId>,
): boolean {
  const PROBE = 3;
  let inVotes = 0, outVotes = 0;
  for (const di of seq) {
    const d = darts[di];
    if (pseudoIds.has(d.origin)) continue; // pseudo-vertex dart: no geometry to probe
    const pts = d.origin === d.edge.v1 ? d.edge.points : [...d.edge.points].reverse();
    if (pts.length < 2) continue;
    const mi = Math.floor(pts.length / 2);
    const A = project(pts[Math.max(0, mi - 1)]);
    const B = project(pts[Math.min(pts.length - 1, mi + 1)]);
    let tx = B.px - A.px, ty = B.py - A.py;
    const L = Math.hypot(tx, ty);
    if (L < 1e-6) continue;
    tx /= L; ty /= L;
    const M = project(pts[mi]);
    // For the reverse dart of a self-loop (both endpoints the same vertex), the
    // "interior left" of the forward dart is the exterior of the reverse dart.
    // Flip the probe direction so the two self-loop darts get opposite leftInside
    // votes and the face classifier can distinguish inner from outer.
    const isSelfLoopReverse = d.edge.v1 === d.edge.v2 && d.idx > d.twin;
    // left = (ty, -tx) in canvas (y-down) space; right = (-ty, tx).
    const probeX = M.px + (isSelfLoopReverse ? -ty : ty) * PROBE;
    const probeY = M.py + (isSelfLoopReverse ?  tx : -tx) * PROBE;
    if (pointInPolygon(poly, { px: probeX, py: probeY })) inVotes++;
    else outVotes++;
  }
  return inVotes > outVotes;
}

/**
 * A single point a few pixels off the cycle's own boundary curve, on whichever
 * side `leftInside` (the cycle's final, possibly-corrected interior side) says
 * is genuinely interior — used as containingFace's containment-test point
 * instead of a naive vertex-average centroid. A loop's bounded face and its
 * complementary outer face share the exact same physical curve, so a centroid
 * of that curve sits right on the shared boundary: an ambiguous point whose
 * classification is at the mercy of floating-point noise, and which can read
 * as "inside" some unrelated nearby polygon. A point just off the curve, on
 * the side this specific cycle actually occupies, has no such ambiguity.
 */
function probeInsidePoint(
  seq: number[],
  darts: Dart[],
  project: (p: SpherePoint) => CanvasPoint,
  pseudoIds: Set<VertexId>,
  leftInside: boolean,
): CanvasPoint | null {
  const PROBE = 3;
  for (const di of seq) {
    const d = darts[di];
    if (pseudoIds.has(d.origin)) continue; // pseudo-vertex dart: no geometry to probe
    const pts = d.origin === d.edge.v1 ? d.edge.points : [...d.edge.points].reverse();
    if (pts.length < 2) continue;
    const mi = Math.floor(pts.length / 2);
    const A = project(pts[Math.max(0, mi - 1)]);
    const B = project(pts[Math.min(pts.length - 1, mi + 1)]);
    let tx = B.px - A.px, ty = B.py - A.py;
    const L = Math.hypot(tx, ty);
    if (L < 1e-6) continue;
    tx /= L; ty /= L;
    const M = project(pts[mi]);
    // Same "conventional side" as probeLeftInside's vote (left, flipped for a
    // self-loop's reverse dart); leftInside tells us whether that side is
    // actually this cycle's interior, or — after the degenerate-loop
    // correction may have flipped it — the opposite side is.
    const isSelfLoopReverse = d.edge.v1 === d.edge.v2 && d.idx > d.twin;
    const useLeftOffset = isSelfLoopReverse ? !leftInside : leftInside;
    const sx = useLeftOffset ? ty : -ty;
    const sy = useLeftOffset ? -tx : tx;
    return { px: M.px + sx * PROBE, py: M.py + sy * PROBE };
  }
  return null;
}

/** Assign 'only'/'firstVisit'/'secondVisit' to a boundary by vertex repetition. */
function assignSides(entries: BoundaryEntry[]): BoundaryEntry[] {
  const counts = new Map<VertexId, number>();
  for (const e of entries) counts.set(e.vertexId, (counts.get(e.vertexId) ?? 0) + 1);
  const seen = new Set<VertexId>();
  return entries.map(e => {
    const c = counts.get(e.vertexId) ?? 1;
    let side: BoundaryEntry['side'] = 'only';
    if (c > 1) { side = seen.has(e.vertexId) ? 'secondVisit' : 'firstVisit'; seen.add(e.vertexId); }
    return { vertexId: e.vertexId, side, edgeId: e.edgeId, ...(e.pseudoHalf ? { pseudoHalf: e.pseudoHalf } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Subpositions
// ---------------------------------------------------------------------------

/**
 * Two regions are in the same subposition when they're connected — directly
 * or transitively — by a shared edge whose union is still GAME-relevant: at
 * least one of that edge's two endpoints must have an unused slot (degree <
 * 3). Every Edge already records the two regions it borders (leftRegion/
 * rightRegion), giving the connected-components relation on the graph's face
 * set — but an edge with BOTH endpoints fully saturated (degree 3, no more
 * moves ever possible through either) can still geometrically border two
 * regions that have nothing further to do with each other: a fully dead
 * sub-loop nested purely for display inside a face whose own bridging vertex
 * has since been used up by another move. Unioning through such an edge
 * conflates "these two faces happen to touch" with "a move can still bridge
 * them" — the latter is what a subposition split actually needs. Filtering
 * on degree here (not by connected-component identity, which would also
 * exclude legitimate same-component nesting) is what lets an isolated loop's
 * hole correctly stay merged with its host WHILE that host still has a live
 * bridge, and correctly split off once that bridge is fully consumed by a
 * later move (see project_membrane_joint_subposition_bug).
 */
function buildSubpositions(state: GameState, degree: Map<VertexId, number>): { regionIds: RegionId[] }[] {
  const ids = [...state.regions.keys()];
  const parent = new Map<RegionId, RegionId>();
  const find = (x: RegionId): RegionId => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: RegionId, b: RegionId) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const id of ids) parent.set(id, id);
  for (const e of state.edges.values()) {
    const d1 = degree.get(e.v1) ?? 0, d2 = degree.get(e.v2) ?? 0;
    if (d1 < 3 || d2 < 3) union(e.leftRegion, e.rightRegion);
  }

  const groups = new Map<RegionId, RegionId[]>();
  for (const id of ids) {
    const root = find(id);
    const g = groups.get(root);
    if (g) g.push(id); else groups.set(root, [id]);
  }
  return [...groups.values()].map(regionIds => ({ regionIds }));
}

// ---------------------------------------------------------------------------
// Vertex classification
// classifyVertexByDegree: fast degree-only cache update, called after every recompute.
// classifyVertexFull (encoding.ts): authoritative region-aware classification, used for encoding.
// ---------------------------------------------------------------------------

function classifyVertexByDegree(state: GameState, vid: VertexId): void {
  const v = state.vertices.get(vid);
  if (!v) return;
  if (v.degree === 0)      { v.type = VertexType.Spot;      v.visual = VertexVisualState.Active; }
  else if (v.degree === 1) { v.type = VertexType.Appendage; v.visual = VertexVisualState.Active; }
  else if (v.degree === 2) { v.type = VertexType.Membrane;  v.visual = VertexVisualState.Active; }
  else                     { v.type = VertexType.Dead;      v.visual = VertexVisualState.Saturated; }
}
