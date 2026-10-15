import type { GameState, Edge, VertexId } from './types';
import type { SpherePoint } from '../math/sphere';
import { slerp, arcsCross, arcsProperlyCross, sphereAngle, dot, cross, chord2, polylineLength, resamplePolyline } from '../math/sphere';
import { fullyDeadVertexIds } from './deadRegions';
import { anchorEdge, syncPseudoVertices } from './gameState';
import { tunables } from './tunables';
import { nearestOnArc, refinementSpacing } from './smoothGeometry';

export interface DragTarget {
  vertexId: VertexId;
  target: SpherePoint;
}

// Tunable physics/timing constants now live in ./tunables (read live every frame
// so the Debug â†’ Tuning panel can adjust them without a reload). See that file
// for defaults and the panel spec.

// Raw per-frame max movement from the most recent smoothStep call (radians), even
// when below tunables.settleEpsilon. Callers that only need "basically stopped"
// (e.g. the Recreate controller deciding it's safe to make the next move) can use
// a looser threshold against this instead of waiting out smoothStep's strict
// asymptotic tail.
export let lastMaxMovement = 0;

const EMPTY_SKIP: Set<VertexId> = new Set(); // shared no-op skip set (shrink off); never mutated

// ---------------------------------------------------------------------------
// Force winddown — large components drift indefinitely if forces never fully
// settle to zero (accumulated float error, competing repulsion/tightening
// forces never quite cancelling). Rather than chase that asymptote, fade every
// ambient force to exactly zero a fixed time after the layout was last
// disturbed, so motion always comes to a clean stop.
// ---------------------------------------------------------------------------

const FORCE_FADE_MS = 3000; // duration of the linear fade to zero, once it starts

let activityAnchor: number | null = null; // performance.now() timestamp of the last reset
let activityHoldMs = 3000;                // how long forces stay at full strength before fading

/**
 * Call when the layout has just been disturbed (a move committed, or the user
 * started dragging a vertex) to (re)start the winddown countdown.
 * `holdMs` is how long forces stay at full strength before the fade begins —
 * a move commit uses the default 3s, a drag-start uses a shorter 1.5s so the
 * countdown feels responsive to further user input rather than restarting a
 * full 3s hold every time.
 */
export function resetActivityTimer(holdMs = 3000): void {
  activityAnchor = performance.now();
  activityHoldMs = holdMs;
}

/**
 * Current ambient-force multiplier: 1 while within the hold window, linearly
 * fading to 0 over FORCE_FADE_MS after that. Returns 1 if the timer was never
 * armed (e.g. before the first move) so existing behavior is unaffected.
 */
export function getForceScale(): number {
  if (activityAnchor === null) return 1;
  const elapsed = performance.now() - activityAnchor;
  if (elapsed < activityHoldMs) return 1;
  const fadeElapsed = elapsed - activityHoldMs;
  if (fadeElapsed >= FORCE_FADE_MS) return 0;
  return 1 - fadeElapsed / FORCE_FADE_MS;
}

/**
 * One incremental smoothing + repulsion step — call each frame.
 * Returns true if any point moved more than tunables.settleEpsilon (still animating),
 * false if everything has settled (caller can stop ticking).
 */
export function smoothStep(state: GameState, shrinkDead = false, extraSkip?: Set<VertexId>): boolean {
  // Settle on NET movement over the whole step. Redistribution, Laplacian
  // smoothing and repulsion pull in competing directions, so each sub-step can
  // report a >epsilon move while they nearly cancel out. Trusting those
  // per-step flags left the system in a perpetual limit cycle: the render loop
  // never slept, geometry crept by a few micro-radians every frame, and the
  // camera-dependent outer-region pick flipped each frame (colour flicker).
  // Comparing positions before/after the full step lets it actually settle.
  const before = snapshotPositions(state);

  // Vertices in fully-dead components are collapsed by deadRegionStep; exclude
  // them here so normal repulsion doesn't fight the shrink (its spacing floor
  // would otherwise stop them ever getting small enough to pop). Only when the
  // shrink feature is on — otherwise dead structure smooths normally. [easy revert]
  const deadSkip = shrinkDead ? fullyDeadVertexIds(state) : EMPTY_SKIP;
  const skip = extraSkip && extraSkip.size > 0
    ? new Set([...deadSkip, ...extraSkip])
    : deadSkip;
  const forceScale = getForceScale();
  const allEdges = [...state.edges.values()];
  const index = new SegmentIndex(allEdges, isolatedSpots(state));
  const obstacles = [...state.vertices.values()].filter(v => !v.isPseudo);

  for (const e of allEdges) {
    if (e.points.length < 3) continue;
    if (skip.has(e.v1) && skip.has(e.v2)) continue; // fully-dead or collapsing edge
    const { ideal, want } = interiorTargets(e, obstacles);
    if (edgeNeedsResample(e, ideal, want)) {
      // A stroke drawn needlessly long (or an edge dragged much shorter since its
      // last resample) can end up with far more interior points than its current
      // arc length needs. Packed that tightly, redistributePoints/laplacianSmooth
      // can't converge the point count down — they just reshuffle existing points.
      // Recompute the point count the same way a move commit does.
      resampleEdge(e, index, want);
      continue;
    }
    const mayMove = (i: number, next: SpherePoint): boolean => !pointMoveCrosses(index, e, i, next);
    // All or nothing: if any point's move is refused, the edge keeps its spacing this frame. Refusing
    // single points leaves them out of order between moved neighbours, folding the edge into a
    // visible zig-zag (worst on an edge a collapse is growing each frame, whose targets all shift).
    redistributePoints(e.points, next =>
      next.every((p, i) => p === e.points[i] || mayMove(i, p)) &&
      !(polylineCrossesOthers(index, e, next) && !polylineCrossesOthers(index, e, e.points)));
    laplacianSmooth(e.points, 1, tunables.laplacianStrength * forceScale, mayMove);
    index.refresh(e);
  }
  repulsionStep(state, undefined, skip, skip.size > 0, forceScale);

  const netMove = maxNetMovement(state, before);
  lastMaxMovement = netMove;
  const moved = netMove > tunables.settleEpsilon;

  // Once settled, discard the sub-epsilon residual jitter and restore the exact
  // pre-step positions. This makes a settled render byte-for-byte identical
  // frame to frame, so merely hovering (which repaints) can no longer creep the
  // geometry and flip the camera-dependent outer-region pick.
  if (!moved) restorePositions(state, before);

  return moved;
}

/** Snapshot every vertex position and edge sample point (deep-copied). */
function snapshotPositions(state: GameState): Map<string, SpherePoint> {
  const snap = new Map<string, SpherePoint>();
  for (const v of state.vertices.values()) snap.set(`v${v.id}`, { ...v.pos });
  for (const e of state.edges.values()) {
    e.points.forEach((p, i) => snap.set(`e${e.id}.${i}`, { ...p }));
  }
  return snap;
}

/** Write snapshot coordinates back into the live vertices and edge points. */
function restorePositions(state: GameState, before: Map<string, SpherePoint>): void {
  for (const v of state.vertices.values()) {
    const b = before.get(`v${v.id}`);
    if (b) v.pos = { ...b };
  }
  for (const e of state.edges.values()) {
    for (let i = 0; i < e.points.length; i++) {
      const b = before.get(`e${e.id}.${i}`);
      if (b) e.points[i] = { ...b };
    }
  }
}

/** Largest geodesic distance any tracked point moved since the snapshot. */
function maxNetMovement(state: GameState, before: Map<string, SpherePoint>): number {
  let max = 0;
  const consider = (key: string, p: SpherePoint) => {
    const b = before.get(key);
    if (!b) return;
    max = Math.max(max, sphereAngle(b, p));
  };
  for (const v of state.vertices.values()) consider(`v${v.id}`, v.pos);
  for (const e of state.edges.values()) {
    e.points.forEach((p, i) => consider(`e${e.id}.${i}`, p));
  }
  return max;
}

// ---------------------------------------------------------------------------
// Parallel-edge locked midpoints
// ---------------------------------------------------------------------------

/** Return the point at fraction `frac` (0â€“1) of the arc length of a polyline. */
function arcLengthPoint(pts: SpherePoint[], frac: number): SpherePoint {
  let total = 0;
  const cumLen = [0];
  for (let i = 1; i < pts.length; i++) {
    total += sphereAngle(pts[i - 1], pts[i]);
    cumLen.push(total);
  }
  const target = total * frac;
  let seg = 0;
  while (seg < pts.length - 2 && cumLen[seg + 1] < target) seg++;
  const segLen = cumLen[seg + 1] - cumLen[seg];
  const t = segLen < 1e-12 ? 0 : (target - cumLen[seg]) / segLen;
  return slerp(pts[seg], pts[seg + 1], t);
}

/**
 * Return the point a fixed arc-length `dist` (radians) in from one end of a
 * polyline. `fromEnd` walks back from the last point instead of the first.
 * Unlike a fraction, this stays anchored near the endpoint however long the
 * polyline is.
 */
function pointAtDistFromEnd(pts: SpherePoint[], dist: number, fromEnd: boolean): SpherePoint {
  const seq = fromEnd ? [...pts].reverse() : pts;
  let acc = 0;
  for (let i = 1; i < seq.length; i++) {
    const segLen = sphereAngle(seq[i - 1], seq[i]);
    if (acc + segLen >= dist) {
      const t = segLen < 1e-12 ? 0 : (dist - acc) / segLen;
      return slerp(seq[i-1], seq[i], t);
    }
    acc += segLen;
  }
  return { ...seq[seq.length - 1] };
}

/**
 * Returns invisible repeller points used during repulsion:
 * - Parallel edges (same two endpoints): one midpoint per edge, keeping them apart.
 *   Each midpoint's edgeId prevents it from repelling its own edge's interior.
 * - Self-loop edges (v1===v2): 1/3 and 2/3 arc-length points, keeping the two arms open.
 *   These use negative sentinel edgeIds so they repel the loop's own interior.
 *   `skipVertexIds` prevents them from pushing the self-loop vertex away from itself.
 * A parallel pair whose endpoints are both in `skip` is collapsing: its edges are drawing
 * together, so it gets no repellers.
 */
export function edgeRepellers(state: GameState, skip?: Set<VertexId>): Array<{ edgeId: number; point: SpherePoint; skipVertexIds?: Set<number> }> {
  const edges = [...state.edges.values()];
  const result: Array<{ edgeId: number; point: SpherePoint; skipVertexIds?: Set<number> }> = [];
  const seen = new Set<number>();

  for (let a = 0; a < edges.length; a++) {
    for (let b = a + 1; b < edges.length; b++) {
      const ea = edges[a], eb = edges[b];
      const parallel =
        (ea.v1 === eb.v1 && ea.v2 === eb.v2) ||
        (ea.v1 === eb.v2 && ea.v2 === eb.v1);
      if (!parallel || seen.has(ea.id)) continue;
      seen.add(ea.id);
      seen.add(eb.id);
      if (skip?.has(ea.v1) && skip.has(ea.v2)) continue;
      const sharedEndpoints = new Set([ea.v1, ea.v2]);
      for (const e of [ea, eb]) {
        if (e.points.length < 3) continue;
        result.push({ edgeId: e.id, point: arcLengthPoint(e.points, 0.5), skipVertexIds: sharedEndpoints });
      }
    }
  }

  // Self-loop edges (v1===v2): 1/3 and 2/3 arc-length repellers.
  // Sentinel edgeIds (-e.id-1 and -e.id-2) ensure they are included when
  // repelling the self-loop's own interior points (keeping the two arms apart).
  // skipVertexIds skips ALL vertices: the sentinels should only push loop-interior
  // sample points (step 3), never vertices. Pushing other nearby vertices indirectly
  // torques the self-loop vertex via vertex-vertex repulsion, causing slow spinning.
  const allVertexIds = new Set(edges.flatMap(e => [e.v1, e.v2]));
  for (const e of edges) {
    if (e.v1 !== e.v2 || e.points.length < 3) continue;
    result.push({ edgeId: -e.id - 1, point: arcLengthPoint(e.points, 1/3), skipVertexIds: allVertexIds });
    result.push({ edgeId: -e.id - 2, point: arcLengthPoint(e.points, 2/3), skipVertexIds: allVertexIds });
  }

  // Self-loop cross-edge repellers: for each self-loop vertex A, add a repeller on
  // every other incident edge. Without this the self-loop interior has no outward
  // force from those edges and the loop can spin freely through them.
  // The repeller is anchored ~2 sample-spacings in from A (not at the edge midpoint):
  // on a long dangling edge the midpoint is far from the loop and exerts no useful
  // torque, so the loop keeps slowly spinning. Anchoring it near A pins the loop.
  // skipVertexIds=allVertexIds so the repeller only acts on edge interior points
  // (step 3), never on vertices.
  const selfLoopVerts = new Set(edges.filter(e => e.v1 === e.v2).map(e => e.v1));
  for (const v of selfLoopVerts) {
    for (const e of edges) {
      if (e.v1 === e.v2) continue; // skip self-loops themselves
      if ((e.v1 !== v && e.v2 !== v) || e.points.length < 3) continue;
      const dist = 2 * polylineLength(e.points) / (e.points.length - 1); // ~2 sample-spacings from A
      result.push({ edgeId: e.id, point: pointAtDistFromEnd(e.points, dist, e.v2 === v), skipVertexIds: allVertexIds });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Repulsion
// ---------------------------------------------------------------------------

/**
 * Move a point on the unit sphere away from a repeller.
 * Uses a quadratic falloff: force = step * (1 - d/radius)^2 for d < radius. `dist` overrides the
 * distance the falloff uses (the push is still directly away from `repeller`) — how a sample is
 * made to feel a vertex that its adjacent chord passes close to.
 */
function repulsePoint(p: SpherePoint, repeller: SpherePoint, step: number, radius: number, dist?: number): SpherePoint {
  const c = Math.max(-1, Math.min(1, dot(p, repeller)));
  const d = dist ?? Math.acos(c);
  if (d < 1e-6 || d >= radius) return p;
  const t = 1 - d / radius;
  const force = step * t * t;
  // tangent at p pointing away from repeller
  const tx = p.x - c*repeller.x;
  const ty = p.y - c*repeller.y;
  const tz = p.z - c*repeller.z;
  const tlen = Math.sqrt(tx*tx + ty*ty + tz*tz);
  if (tlen < 1e-9) return p;
  const nx = p.x + force * tx/tlen;
  const ny = p.y + force * ty/tlen;
  const nz = p.z + force * tz/tlen;
  const nlen = Math.sqrt(nx*nx + ny*ny + nz*nz);
  return { x: nx/nlen, y: ny/nlen, z: nz/nlen };
}

/** Move a point on the unit sphere toward a target by at most `step` radians. */
function attractPoint(p: SpherePoint, target: SpherePoint, step: number): SpherePoint {
  const c = Math.max(-1, Math.min(1, dot(p, target)));
  const d = Math.acos(c);
  if (d < 1e-6) return p;
  const tx = target.x - c*p.x;
  const ty = target.y - c*p.y;
  const tz = target.z - c*p.z;
  const tlen = Math.sqrt(tx*tx + ty*ty + tz*tz);
  if (tlen < 1e-9) return p;
  const force = Math.min(step, d);
  const nx = p.x + force * tx/tlen;
  const ny = p.y + force * ty/tlen;
  const nz = p.z + force * tz/tlen;
  const nlen = Math.sqrt(nx*nx + ny*ny + nz*nz);
  return { x: nx/nlen, y: ny/nlen, z: nz/nlen };
}

/**
 * Returns true if moving a vertex from `before` to `after` would cross any
 * segment of any non-incident edge.
 */
function wouldCrossAnyEdge(
  before: SpherePoint,
  after: SpherePoint,
  vid: number,
  edges: Edge[],
): boolean {
  for (const e of edges) {
    if (e.v1 === vid || e.v2 === vid) continue;
    for (let i = 0; i < e.points.length - 1; i++) {
      if (arcsCross(before, after, e.points[i], e.points[i + 1])) return true;
    }
  }
  return false;
}

/** Positions of the vertices no edge touches. */
function isolatedSpots(state: GameState): SpherePoint[] {
  const used = new Set<VertexId>();
  for (const e of state.edges.values()) { used.add(e.v1); used.add(e.v2); }
  return [...state.vertices.values()].filter(v => !v.isPseudo && !used.has(v.id)).map(v => v.pos);
}


/**
 * Uniform 3D grid over edge segments, so a crossing query tests only the segments near it rather
 * than every segment on the board (which made each smoothStep quadratic in the point count).
 * A segment is filed under every cell its bounding box overlaps, padded by how far the great-circle
 * arc bulges past its chord; a query arc looks in the cells of its own padded box, so two arcs that
 * meet always share a cell. Segment end points are read live from edge.points, but which cells an
 * edge is filed under is only as current as its last refresh() — callers refresh an edge after
 * moving its points, and a query skips the edge being moved and scans that one directly.
 */
class SegmentIndex {
  private static readonly H = 0.1;        // cell size; segments are ~1/pointsPerRadian long
  private static readonly MAX_CELLS = 512; // a segment spanning more goes on the always-checked list
  private cells = new Map<number, { e: Edge; k: number; mark: number }[]>();
  private oversize: { e: Edge; k: number; mark: number }[] = [];
  private keysOf = new Map<Edge, number[]>();
  private stamp = 0;

  /**
   * `spots` are the isolated vertices (no incident edge). Nothing else stops an edge point being
   * dragged across one: a vertex with edges is fenced in by them, but a lone spot is just a point.
   */
  constructor(edges: Edge[], private readonly spots: SpherePoint[] = []) { for (const e of edges) this.add(e); }

  /** True if some isolated spot lies strictly inside the spherical triangle a,b,c (either winding). */
  sweepsSpot(a: SpherePoint, b: SpherePoint, c: SpherePoint): boolean {
    const nab = cross(a, b), nbc = cross(b, c), nca = cross(c, a);
    const hx = a.x + b.x + c.x, hy = a.y + b.y + c.y, hz = a.z + b.z + c.z;
    for (const p of this.spots) {
      // Accepting either winding below would also accept a spot ANTIPODAL to the triangle (all three
      // signs flip), so require it on the triangle's own hemisphere first.
      if (p.x*hx + p.y*hy + p.z*hz <= 0) continue;
      const s1 = dot(nab, p), s2 = dot(nbc, p), s3 = dot(nca, p);
      if ((s1 > 1e-12 && s2 > 1e-12 && s3 > 1e-12) || (s1 < -1e-12 && s2 < -1e-12 && s3 < -1e-12)) return true;
    }
    return false;
  }

  /** Re-file `e` after its points moved or were replaced. */
  refresh(e: Edge): void {
    for (const key of this.keysOf.get(e) ?? []) {
      const cell = this.cells.get(key);
      if (cell) this.cells.set(key, cell.filter(r => r.e !== e));
    }
    this.oversize = this.oversize.filter(r => r.e !== e);
    this.add(e);
  }

  /**
   * True if arc a0->a1 properly crosses a segment of any edge other than `self`, or — when `ownSkip`
   * is given — a segment k of `self` itself for which ownSkip(k) is false.
   */
  hits(a0: SpherePoint, a1: SpherePoint, self: Edge, ownSkip?: (k: number) => boolean): boolean {
    const mark = ++this.stamp;
    const test = (cell: { e: Edge; k: number; mark: number }[]): boolean => {
      for (const r of cell) {
        if (r.mark === mark || r.e === self) continue;
        r.mark = mark;
        const q = r.e.points;
        if (r.k + 1 < q.length && arcsProperlyCross(a0, a1, q[r.k], q[r.k + 1])) return true;
      }
      return false;
    };
    if (test(this.oversize)) return true;
    const [x0, x1, y0, y1, z0, z1] = SegmentIndex.box(a0, a1);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > this.cells.size) {
      for (const cell of this.cells.values()) if (test(cell)) return true;
    } else {
      for (let ix = x0; ix <= x1; ix++)
        for (let iy = y0; iy <= y1; iy++)
          for (let iz = z0; iz <= z1; iz++) {
            const cell = this.cells.get(SegmentIndex.key(ix, iy, iz));
            if (cell && test(cell)) return true;
          }
    }
    if (ownSkip) {
      const q = self.points;
      for (let k = 0; k + 1 < q.length; k++) if (!ownSkip(k) && arcsProperlyCross(a0, a1, q[k], q[k + 1])) return true;
    }
    return false;
  }

  private add(e: Edge): void {
    const keys: number[] = [];
    for (let k = 0; k + 1 < e.points.length; k++) {
      const rec = { e, k, mark: 0 };
      const [x0, x1, y0, y1, z0, z1] = SegmentIndex.box(e.points[k], e.points[k + 1]);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > SegmentIndex.MAX_CELLS) { this.oversize.push(rec); continue; }
      for (let ix = x0; ix <= x1; ix++)
        for (let iy = y0; iy <= y1; iy++)
          for (let iz = z0; iz <= z1; iz++) {
            const key = SegmentIndex.key(ix, iy, iz);
            let cell = this.cells.get(key);
            if (!cell) { cell = []; this.cells.set(key, cell); }
            cell.push(rec);
            keys.push(key);
          }
    }
    this.keysOf.set(e, keys);
  }

  private static key(ix: number, iy: number, iz: number): number { return (ix * 64 + iy) * 64 + iz; }

  /** Cell-index box of the arc p->q: its chord's bounding box grown by the arc's sagitta. */
  private static box(p: SpherePoint, q: SpherePoint): number[] {
    const pad = 1 - Math.sqrt(Math.max(0, 1 - chord2(p, q) / 4)) + 1e-9;
    const idx = (c: number): number => Math.floor((c + 1.5) / SegmentIndex.H);
    return [
      idx(Math.min(p.x, q.x) - pad), idx(Math.max(p.x, q.x) + pad),
      idx(Math.min(p.y, q.y) - pad), idx(Math.max(p.y, q.y) + pad),
      idx(Math.min(p.z, q.z) - pad), idx(Math.max(p.z, q.z) + pad),
    ];
  }
}

/**
 * True if sliding interior point `i` of `e` to `next` would make either of its two segments cross
 * another edge (or a non-adjacent segment of its own edge) that the segments at its CURRENT
 * position don't already cross. Edge points move every frame (redistribution, Laplacian smoothing,
 * repulsion, tightening) and without this check a smoothing pass can shorten a loop straight
 * through an obstacle — vertex moves are guarded by wouldCrossAnyEdge, but interior points
 * weren't. Segments that merely touch at a shared end point (edges meeting at a vertex) don't count.
 */
function pointMoveCrosses(index: SegmentIndex, e: Edge, i: number, next: SpherePoint): boolean {
  const pts = e.points;
  const crossesAny = (p: SpherePoint): boolean =>
    index.hits(pts[i - 1], p, e, k => Math.abs(k - (i - 1)) <= 1) ||
    index.hits(p, pts[i + 1], e, k => Math.abs(k - i) <= 1);
  if (index.sweepsSpot(pts[i - 1], pts[i], next) || index.sweepsSpot(pts[i], pts[i + 1], next)) return true;
  return crossesAny(next) && !crossesAny(pts[i]);
}

/** True if any segment of `pts` (a candidate polyline for edge `e`) crosses another edge. */
function polylineCrossesOthers(index: SegmentIndex, e: Edge, pts: SpherePoint[]): boolean {
  for (let k = 0; k + 1 < pts.length; k++) if (index.hits(pts[k], pts[k + 1], e)) return true;
  return false;
}

/** Move p directly away from `from` along the sphere by `amount` radians. */
function stepAway(p: SpherePoint, from: SpherePoint, amount: number): SpherePoint {
  const d = Math.max(-1, Math.min(1, dot(p, from)));
  const tx = p.x - d * from.x, ty = p.y - d * from.y, tz = p.z - d * from.z;
  const tl = Math.hypot(tx, ty, tz);
  if (tl < 1e-9) return p;
  const nx = p.x + amount * tx / tl, ny = p.y + amount * ty / tl, nz = p.z + amount * tz / tl;
  const nl = Math.hypot(nx, ny, nz);
  return { x: nx / nl, y: ny / nl, z: nz / nl };
}

/**
 * Hard minimum spacing, applied after the forces. The forces shape the drawing but are soft: an
 * edge pulled taut round a vertex (Laplacian + tightening) can out-pull the repulsion until a
 * chord grazes it. This pushes the geometry apart until, measured to the actual segments:
 *   - a vertex is at least tunables.edgeClearance from every edge it isn't attached to, and
 *   - two vertices are at least twice that apart (an edge has to fit between them).
 * Each separation is shared between the two parties, except that the dragged vertex is never
 * moved (the user has it) and a segment with no movable sample (both ends are vertices) leaves
 * the vertex to move alone. Every move goes through the same crossing guards as the forces, so a
 * crowded board ends up tight but legal rather than crossed. Vertices in `skip` (collapsing dead
 * structure, which has to be free to shrink) and pseudo-vertices are exempt.
 */
function enforceClearance(state: GameState, skip: Set<VertexId> | undefined, dragId: VertexId | undefined): void {
  const c = tunables.edgeClearance;
  if (c <= 0) return;
  const edges = [...state.edges.values()];
  const verts = [...state.vertices.values()].filter(v => !v.isPseudo && !skip?.has(v.id));
  const nudgeVertex = (v: { id: VertexId; pos: SpherePoint }, from: SpherePoint, amount: number): boolean => {
    if (amount <= 1e-9) return false;
    const next = stepAway(v.pos, from, amount);
    if (next === v.pos || wouldCrossAnyEdge(v.pos, next, v.id, edges)) return false;
    v.pos = next;
    return true;
  };

  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let a = 0; a < verts.length; a++) {
      for (let b = a + 1; b < verts.length; b++) {
        const va = verts[a], vb = verts[b];
        const d = sphereAngle(va.pos, vb.pos);
        if (d >= 2 * c || d < 1e-9) continue;
        const aDrag = va.id === dragId, bDrag = vb.id === dragId;
        if (aDrag && bDrag) continue;
        const need = 2 * c - d;
        const aShare = bDrag ? 1 : aDrag ? 0 : 0.5;
        const pa = va.pos, pb = vb.pos;
        if (nudgeVertex(va, pb, need * aShare)) moved = true;
        if (nudgeVertex(vb, pa, need * (1 - aShare))) moved = true;
      }
    }
    if (moved) anchorEdgeEnds(state);

    let index: SegmentIndex | null = null; // built on the first sample that has to move
    for (const v of verts) {
      const vDrag = v.id === dragId;
      for (const e of edges) {
        if (e.v1 === v.id || e.v2 === v.id) continue;
        if (skip && skip.has(e.v1) && skip.has(e.v2)) continue; // fully-dead edge, collapsing
        const pts = e.points;
        for (let k = 0; k + 1 < pts.length; k++) {
          const a = pts[k], b = pts[k + 1];
          if (Math.sqrt(chord2(v.pos, a)) > c + 1.01 * Math.sqrt(chord2(a, b))) continue;
          const r = nearestOnArc(v.pos, a, b);
          if (r.d >= c) continue;
          const need = c - r.d;
          const movA = k >= 1, movB = k + 1 <= pts.length - 2; // interior samples; the ends are vertices
          const vShare = vDrag ? 0 : (movA || movB ? 0.5 : 1);
          if (nudgeVertex(v, r.q, need * vShare)) moved = true;
          const eNeed = need * (1 - vShare);
          if (eNeed <= 1e-9) continue;
          const wa = movA ? (1 - r.t) : 0, wb = movB ? r.t : 0;
          const w2 = wa * wa + wb * wb;
          if (w2 < 0.04) continue; // contact point sits on a fixed end: nothing to move
          index ??= new SegmentIndex(edges, isolatedSpots(state));
          for (const [i, w] of [[k, wa], [k + 1, wb]] as const) {
            if (w <= 0) continue;
            const next = stepAway(pts[i], v.pos, eNeed * w / w2);
            if (next !== pts[i] && !pointMoveCrosses(index, e, i, next)) { pts[i] = next; moved = true; }
          }
          index.refresh(e);
        }
      }
    }
    if (moved) anchorEdgeEnds(state);
    if (!moved) break;
  }
}

/** Re-anchor every edge's end points to its (possibly moved) vertices. */
function anchorEdgeEnds(state: GameState): void {
  for (const e of state.edges.values()) anchorEdge(state, e);
}

/**
 * Per-frame repulsion step:
 *   1. Repel true vertices from all other vertices + parallel midpoints +
 *      interior sample points of non-incident edges.
 *   2. Re-anchor edge endpoints to their (moved) vertex positions.
 *   3. Repel edge interior sample points from all vertices + midpoints of OTHER edges.
 */
function repulsionStep(state: GameState, drag?: DragTarget, skip?: Set<VertexId>, suppressCoRegionBoost = false, forceScale = 1): void {
  const vertexEntries = [...state.vertices.values()].filter(v => !v.isPseudo).map(v => ({ id: v.id, pos: v.pos }));
  const vertexPositions = vertexEntries.map(e => e.pos); // positions-only view for edge-sample repulsion
  const midpoints = edgeRepellers(state, skip);
  const allEdges = [...state.edges.values()];

  // Build co-region lookup: which regions contain each vertex?
  const vertexRegions = new Map<VertexId, Set<number>>();
  for (const [rid, region] of state.regions) {
    for (const boundary of region.boundaries) {
      for (const entry of boundary.entries) {
        let s = vertexRegions.get(entry.vertexId);
        if (!s) { s = new Set(); vertexRegions.set(entry.vertexId, s); }
        s.add(rid);
      }
    }
  }
  const sharesRegion = (a: VertexId, b: VertexId): boolean => {
    const ra = vertexRegions.get(a), rb = vertexRegions.get(b);
    if (!ra || !rb) return false;
    for (const id of ra) if (rb.has(id)) return true;
    return false;
  };

  // 1. Move true vertices. (Skipped vertices stay put but remain repellers, so
  //    living structure still spreads into the space dead clusters vacate.)
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue; // pseudo-vertices are rebuilt each recomputeRegions; never moved
    if (skip?.has(v.id)) continue;
    const orig = v.pos;
    let pos = orig;
    for (const re of vertexEntries) {
      if (re.pos === orig) continue;
      const coRegion = !suppressCoRegionBoost && sharesRegion(v.id, re.id);
      const step = (coRegion ? tunables.vertexRepulsionStep * tunables.coRegionBoost : tunables.vertexRepulsionStep) * forceScale;
      const radius = coRegion ? tunables.coRegionRadius : tunables.repulsionRadius;
      pos = repulsePoint(pos, re.pos, step, radius);
    }
    for (const m of midpoints) {
      if (m.skipVertexIds?.has(v.id)) continue;
      pos = repulsePoint(pos, m.point, tunables.vertexRepulsionStep * forceScale, tunables.repulsionRadius);
    }
    // Repel from the nearest point of every segment of edges not incident to this vertex. A
    // segment's push scales with its length (relative to the usual sample spacing), so the total
    // doesn't depend on how many samples an edge happens to have and a chord can't slip past.
    for (const e of allEdges) {
      if (e.v1 === v.id || e.v2 === v.id) continue;
      const last = e.points.length - 2;
      for (let i = 0; i <= last; i++) {
        const a = e.points[i], b = e.points[i + 1];
        const segLen = Math.sqrt(chord2(a, b)) * 1.01;
        if (Math.sqrt(chord2(pos, a)) > tunables.repulsionRadius + segLen) continue;
        const r = nearestOnArc(pos, a, b);
        if (r.d >= tunables.repulsionRadius) continue;
        if ((i === 0 && r.t === 0) || (i === last && r.t === 1)) continue; // a terminal vertex: vertex-vertex handles it
        pos = repulsePoint(pos, r.q, tunables.sampleRepulsionStep * forceScale * segLen * tunables.pointsPerRadian, tunables.repulsionRadius);
      }
    }
    // --- TIGHT-ANGLE SPREADING ---
    {
      const norm = v.pos; // use original position as tangent-plane normal
      const tangents: Array<{ x: number; y: number; z: number }> = [];
      for (const e of allEdges) {
        let nbr: SpherePoint | null = null;
        if      (e.v1 === v.id && e.points.length >= 2) nbr = e.points[1];
        else if (e.v2 === v.id && e.points.length >= 2) nbr = e.points[e.points.length - 2];
        if (!nbr) continue;
        const dx = nbr.x - norm.x, dy = nbr.y - norm.y, dz = nbr.z - norm.z;
        const proj = dx*norm.x + dy*norm.y + dz*norm.z;
        const tx = dx - proj*norm.x, ty = dy - proj*norm.y, tz = dz - proj*norm.z;
        const tl = Math.sqrt(tx*tx + ty*ty + tz*tz);
        if (tl < 1e-9) continue;
        tangents.push({ x: tx/tl, y: ty/tl, z: tz/tl });
      }
      for (let a = 0; a < tangents.length; a++) {
        for (let b = a + 1; b < tangents.length; b++) {
          const cosA = Math.max(-1, Math.min(1,
            tangents[a].x*tangents[b].x + tangents[a].y*tangents[b].y + tangents[a].z*tangents[b].z));
          const angle = Math.acos(cosA);
          if (angle >= tunables.tightAngleThreshold) continue;
          const bx = tangents[a].x + tangents[b].x;
          const by = tangents[a].y + tangents[b].y;
          const bz = tangents[a].z + tangents[b].z;
          const bl = Math.sqrt(bx*bx + by*by + bz*bz);
          if (bl < 1e-9) continue;
          const force = tunables.tightAngleStep * (1 - angle / tunables.tightAngleThreshold) * forceScale;
          const nx = pos.x + force*bx/bl;
          const ny = pos.y + force*by/bl;
          const nz = pos.z + force*bz/bl;
          const nl = Math.sqrt(nx*nx + ny*ny + nz*nz);
          pos = { x: nx/nl, y: ny/nl, z: nz/nl };
        }
      }
    }
    // ---

    // Apply drag attraction (bypasses crossing check — user has control).
    if (drag && v.id === drag.vertexId) {
      pos = attractPoint(pos, drag.target, tunables.dragAttractionStep);
    }

    // Safety: cancel the move if it would cross any non-incident edge.
    // Skipped for the dragged vertex — crossing is caught at the frame level in smoothStepDrag.
    if (pos !== orig) {
      if (drag?.vertexId !== v.id && wouldCrossAnyEdge(orig, pos, v.id, allEdges)) {
        pos = orig;
      } else {
        v.pos = pos;
      }
    }
  }

  // 2. Re-anchor edge endpoints.
  anchorEdgeEnds(state);

  // 3. Repel interior sample points.
  //    Each edge's own midpoint is excluded — it must not repel itself.
  const index = new SegmentIndex(allEdges, isolatedSpots(state)); // after the re-anchoring above
  for (const e of state.edges.values()) {
    if (skip && skip.has(e.v1) && skip.has(e.v2)) continue; // fully-dead edge, collapsing
    const edgeMidpoints = midpoints
      .filter(m => m.edgeId !== e.id)
      .map(m => m.point);
    for (let i = 1; i < e.points.length - 1; i++) {
      const orig = e.points[i];
      let p = orig;
      // A vertex the edge isn't attached to is felt through the sample's two chords, so a long
      // chord passing close to it pushes both its end points even when they're far away.
      const chordA = sphereAngle(e.points[i - 1], p), chordB = sphereAngle(p, e.points[i + 1]);
      for (const r of vertexEntries) {
        const pointDist = sphereAngle(p, r.pos);
        if (pointDist >= tunables.repulsionRadius + Math.max(chordA, chordB)) continue;
        const attached = r.id === e.v1 || r.id === e.v2;
        const d = attached ? pointDist
          : Math.min(pointDist, nearestOnArc(r.pos, e.points[i - 1], p).d, nearestOnArc(r.pos, p, e.points[i + 1]).d);
        p = repulsePoint(p, r.pos, tunables.sampleRepulsionStep * forceScale, tunables.repulsionRadius, d);
      }
      for (const r of edgeMidpoints) {
        p = repulsePoint(p, r, tunables.sampleRepulsionStep * forceScale, tunables.repulsionRadius);
      }
      // --- FREE-SPACE TIGHTENING ---
      const inRepulsionZone = vertexPositions.some(r => sphereAngle(p, r) < tunables.repulsionRadius);
      if (!inRepulsionZone) {
        const neighborMid = slerp(e.points[i - 1], e.points[i + 1], 0.5);
        p = slerp(p, neighborMid, tunables.tighteningStep * forceScale);
      }
      // ---

      if (p !== orig && !pointMoveCrosses(index, e, i, p)) {
        e.points[i] = p;
      }
    }
    index.refresh(e);
  }

  enforceClearance(state, skip, drag?.vertexId);

  // Pseudo-vertices move with their edge's midpoint rather than floating free.
  syncPseudoVertices(state);
}

// ---------------------------------------------------------------------------
// Drag step with rollback on crossing
// ---------------------------------------------------------------------------

/** True if any two non-adjacent edges in the current state cross. */
function detectCrossings(state: GameState): boolean {
  const edges = [...state.edges.values()];
  for (let i = 0; i < edges.length; i++) {
    const ea = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const eb = edges[j];
      // Adjacent edges share a vertex — skip (their shared endpoint segments touch but don't cross)
      if (ea.v1 === eb.v1 || ea.v1 === eb.v2 || ea.v2 === eb.v1 || ea.v2 === eb.v2) continue;
      for (let a = 0; a < ea.points.length - 1; a++) {
        for (let b = 0; b < eb.points.length - 1; b++) {
          if (arcsCross(ea.points[a], ea.points[a + 1], eb.points[b], eb.points[b + 1])) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Smooth step for use during vertex drag.
 * Runs the full smooth frame with the drag attraction force applied, then checks
 * for any newly introduced edge crossings. If a crossing is detected the state
 * is rolled back to its pre-step snapshot and the function returns true so the
 * caller can cancel the drag immediately.
 */
export function smoothStepDrag(state: GameState, drag: DragTarget): boolean /* rolledBack */ {
  const hadCrossings = detectCrossings(state);
  const before = snapshotPositions(state);
  const dragVertBefore = state.vertices.get(drag.vertexId)?.pos;

  for (const e of state.edges.values()) {
    if (e.points.length < 3) continue;
    redistributePoints(e.points);
    laplacianSmooth(e.points, 1, tunables.laplacianStrength);
  }
  repulsionStep(state, drag);

  if (!hadCrossings && detectCrossings(state)) {
    restorePositions(state, before);
    return true;
  }

  // Check whether the dragged vertex itself crossed a non-incident edge this frame.
  // Use pre-step edge positions (from snapshot) to avoid false positives from edge drift.
  if (dragVertBefore) {
    const dragVertAfter = state.vertices.get(drag.vertexId)?.pos;
    if (dragVertAfter) {
      for (const e of state.edges.values()) {
        if (e.v1 === drag.vertexId || e.v2 === drag.vertexId) continue;
        const pts: SpherePoint[] = [];
        for (let i = 0; i < e.points.length; i++) {
          const p = before.get(`e${e.id}.${i}`);
          if (p) pts.push(p);
        }
        for (let i = 0; i < pts.length - 1; i++) {
          if (arcsCross(dragVertBefore, dragVertAfter, pts[i], pts[i + 1])) {
            restorePositions(state, before);
            return true;
          }
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Edge resampling (called on move commit, and mid-animation if overcrowded)
// ---------------------------------------------------------------------------

// tunables.pointsPerRadian: interior points per radian of arc length.
//
// tunables.overcrowdRatio / overcrowdMinExcess: how far a smoothing edge's point
// count is allowed to drift above what its *current* arc length calls for before
// smoothStep forces a resample. Needs both a ratio and an absolute floor: the
// ratio alone would trigger on short edges with just a couple of "extra" points
// from normal jitter.

/**
 * How many interior points an edge should have: `ideal` from its arc length alone, and `want`,
 * which is more when it passes close to a vertex it isn't attached to or bends sharply (see
 * refinementSpacing) — redistributePoints keeps an edge's spacing uniform, so the only way to
 * sample a tight spot finely is to sample the whole edge more finely.
 */
function interiorTargets(e: Edge, vertices: { id: VertexId; pos: SpherePoint }[]): { ideal: number; want: number } {
  const arcLen = polylineLength(e.points);
  const ideal = Math.max(1, Math.round(arcLen * tunables.pointsPerRadian));
  const obstacles = vertices.filter(v => v.id !== e.v1 && v.id !== e.v2).map(v => v.pos);
  const spacing = refinementSpacing(e.points, obstacles, tunables.curveRefineAngle, tunables.curveRefineWindow);
  const refined = Number.isFinite(spacing) ? Math.min(tunables.maxEdgePoints, Math.ceil(arcLen / spacing) - 1) : 0;
  return { ideal, want: Math.max(ideal, refined) };
}

/**
 * True if an edge's point count has drifted from what it should be: far more interior points
 * than `want` (e.g. a stroke drawn needlessly long across the sphere whose endpoints have since
 * been pulled close together — redistributePoints/laplacianSmooth only reposition the existing
 * points, they never change how many there are), or well under it because the edge now needs
 * refining. Needs both a ratio and an absolute floor on the too-many side: the ratio alone would
 * trigger on short edges with just a couple of "extra" points from normal jitter; the too-few
 * side has a 20% dead band so a target that wobbles by a point doesn't resample every frame.
 */
function edgeNeedsResample(e: Edge, ideal: number, want: number): boolean {
  const actualInterior = e.points.length - 2;
  return (actualInterior > want * tunables.overcrowdRatio && actualInterior - want > tunables.overcrowdMinExcess)
      || (want > ideal && actualInterior < 0.8 * want);
}

/**
 * Resample every edge (see resampleEdge), each one checked against the others as it goes.
 */
export function resampleAllEdges(state: GameState): void {
  const allEdges = [...state.edges.values()];
  const index = new SegmentIndex(allEdges, isolatedSpots(state));
  const vertices = [...state.vertices.values()].filter(v => !v.isPseudo);
  for (const e of allEdges) resampleEdge(e, index, interiorTargets(e, vertices).want);
}

/**
 * Resample an edge to `interior` interior points (see interiorTargets).
 * Replaces e.points in-place; endpoints are preserved exactly.
 *
 * Resampling puts new points on the old polyline, so each new chord cuts the corner it spans — on
 * a long segment hugging a tight bend (a loop wrapped round a lens tip) that chord can slice
 * across a neighbouring edge. A result that newly crosses another edge is retried with twice, then
 * four times, the points (chords hug the curve more closely), and the edge is left as it was if
 * even that crosses. Re-files the edge in `index` when its points change.
 */
function resampleEdge(e: Edge, index: SegmentIndex, interior: number): void {
  const old = e.points;
  if (old.length < 2) return;
  const ideal = interior;
  const crossedBefore = polylineCrossesOthers(index, e, old);
  for (const factor of [1, 2, 4]) {
    const next = resamplePolyline(old, ideal * factor + 2);
    if (crossedBefore || !polylineCrossesOthers(index, e, next)) {
      e.points = next;
      index.refresh(e);
      return;
    }
  }
}


// ---------------------------------------------------------------------------
// Arc-length redistribution
// ---------------------------------------------------------------------------

/** Respace an edge's interior points evenly along its arc length. `accept` (if given) vets the whole
 * respaced polyline, which is applied only if it passes. */
function redistributePoints(pts: SpherePoint[], accept?: (next: SpherePoint[]) => boolean): boolean {
  const n = pts.length;
  if (polylineLength(pts) < 1e-12) return false;
  const result = resamplePolyline(pts, n);

  // Endpoints are untouched; pass them through as the same objects so `accept` can tell them apart.
  result[0] = pts[0];
  result[n - 1] = pts[n - 1];
  if (accept && !accept(result)) return false;
  let moved = false;
  for (let i = 1; i < n - 1; i++) {
    if (sphereAngle(pts[i], result[i]) > tunables.settleEpsilon) moved = true;
    pts[i] = result[i];
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Geodesic Laplacian smoothing
// ---------------------------------------------------------------------------

function laplacianSmooth(pts: SpherePoint[], iterations: number, strength: number, mayMove?: (i: number, next: SpherePoint) => boolean): boolean {
  const n = pts.length;
  let moved = false;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 1; i < n - 1; i++) {
      const mid = slerp(pts[i-1], pts[i+1], 0.5);
      const next = slerp(pts[i], mid, strength);
      if (mayMove && !mayMove(i, next)) continue;
      if (sphereAngle(pts[i], next) > tunables.settleEpsilon) moved = true;
      pts[i] = next;
    }
  }
  return moved;
}
