import type { GameState, Edge, VertexId } from './types';
import type { SpherePoint } from '../math/sphere';
import { slerp, arcsCross } from '../math/sphere';
import { fullyDeadVertexIds } from './deadRegions';
import { tunables } from './tunables';

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

  for (const e of state.edges.values()) {
    if (e.points.length < 3) continue;
    if (skip.has(e.v1) && skip.has(e.v2)) continue; // fully-dead or collapsing edge
    if (edgeOvercrowded(e)) {
      // A stroke drawn needlessly long (or an edge dragged much shorter since its
      // last resample) can end up with far more interior points than its current
      // arc length needs. Packed that tightly, redistributePoints/laplacianSmooth
      // can't converge the point count down — they just reshuffle existing points.
      // Recompute the point count the same way a move commit does.
      resampleEdge(e);
      continue;
    }
    redistributePoints(e.points);
    laplacianSmooth(e.points, 1, tunables.laplacianStrength * forceScale);
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
    const dot = Math.max(-1, Math.min(1, b.x * p.x + b.y * p.y + b.z * p.z));
    const d = Math.acos(dot);
    if (d > max) max = d;
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
    const dot = Math.max(-1, Math.min(1, pts[i-1].x*pts[i].x + pts[i-1].y*pts[i].y + pts[i-1].z*pts[i].z));
    total += Math.acos(dot);
    cumLen.push(total);
  }
  const target = total * frac;
  let seg = 0;
  while (seg < pts.length - 2 && cumLen[seg + 1] < target) seg++;
  const segLen = cumLen[seg + 1] - cumLen[seg];
  const t = segLen < 1e-12 ? 0 : (target - cumLen[seg]) / segLen;
  return slerp(pts[seg], pts[seg + 1], t);
}

/** Total geodesic arc length (radians) of a polyline. */
function polylineLength(pts: SpherePoint[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dot = Math.max(-1, Math.min(1, pts[i-1].x*pts[i].x + pts[i-1].y*pts[i].y + pts[i-1].z*pts[i].z));
    total += Math.acos(dot);
  }
  return total;
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
    const dot = Math.max(-1, Math.min(1, seq[i-1].x*seq[i].x + seq[i-1].y*seq[i].y + seq[i-1].z*seq[i].z));
    const segLen = Math.acos(dot);
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
 */
export function edgeRepellers(state: GameState): Array<{ edgeId: number; point: SpherePoint; skipVertexIds?: Set<number> }> {
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
 * Uses a quadratic falloff: force = step * (1 - d/radius)^2 for d < radius.
 */
function repulsePoint(p: SpherePoint, repeller: SpherePoint, step: number, radius: number): SpherePoint {
  const dot = Math.max(-1, Math.min(1, p.x*repeller.x + p.y*repeller.y + p.z*repeller.z));
  const d = Math.acos(dot);
  if (d < 1e-6 || d >= radius) return p;
  const t = 1 - d / radius;
  const force = step * t * t;
  // tangent at p pointing away from repeller
  const tx = p.x - dot*repeller.x;
  const ty = p.y - dot*repeller.y;
  const tz = p.z - dot*repeller.z;
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
  const dot = Math.max(-1, Math.min(1, p.x*target.x + p.y*target.y + p.z*target.z));
  const d = Math.acos(dot);
  if (d < 1e-6) return p;
  const tx = target.x - dot*p.x;
  const ty = target.y - dot*p.y;
  const tz = target.z - dot*p.z;
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
  // Midpoint direction of the vertex movement arc (unnormalized, sufficient for sign checks).
  const vmx = before.x + after.x, vmy = before.y + after.y, vmz = before.z + after.z;
  for (const e of edges) {
    if (e.v1 === vid || e.v2 === vid) continue;
    for (let i = 0; i < e.points.length - 1; i++) {
      if (!arcsCross(before, after, e.points[i], e.points[i + 1])) continue;
      // arcsCross fires for both the real crossing and its antipodal ghost.
      // Confirm the intersection is on the same hemisphere as both arcs by checking
      // that their midpoint directions agree in sign.
      const p0 = e.points[i], p1 = e.points[i + 1];
      const emx = p0.x + p1.x, emy = p0.y + p1.y, emz = p0.z + p1.z;
      if (vmx*emx + vmy*emy + vmz*emz > 0) return true;
    }
  }
  return false;
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
  const midpoints = edgeRepellers(state);
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
    // Repel from interior sample points of edges not incident to this vertex.
    for (const e of allEdges) {
      if (e.v1 === v.id || e.v2 === v.id) continue;
      for (let i = 1; i < e.points.length - 1; i++) {
        pos = repulsePoint(pos, e.points[i], tunables.sampleRepulsionStep * forceScale, tunables.repulsionRadius);
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
  for (const e of state.edges.values()) {
    const v1 = state.vertices.get(e.v1);
    const v2 = state.vertices.get(e.v2);
    if (v1) e.points[0] = { ...v1.pos };
    if (v2) e.points[e.points.length - 1] = { ...v2.pos };
  }

  // 3. Repel interior sample points.
  //    Each edge's own midpoint is excluded — it must not repel itself.
  for (const e of state.edges.values()) {
    if (skip && skip.has(e.v1) && skip.has(e.v2)) continue; // fully-dead edge, collapsing
    const edgeMidpoints = midpoints
      .filter(m => m.edgeId !== e.id)
      .map(m => m.point);
    for (let i = 1; i < e.points.length - 1; i++) {
      const orig = e.points[i];
      let p = orig;
      for (const r of vertexPositions) {
        p = repulsePoint(p, r, tunables.sampleRepulsionStep * forceScale, tunables.repulsionRadius);
      }
      for (const r of edgeMidpoints) {
        p = repulsePoint(p, r, tunables.sampleRepulsionStep * forceScale, tunables.repulsionRadius);
      }
      // --- FREE-SPACE TIGHTENING ---
      const inRepulsionZone = vertexPositions.some(r => {
        const d = Math.max(-1, Math.min(1, p.x*r.x + p.y*r.y + p.z*r.z));
        return Math.acos(d) < tunables.repulsionRadius;
      });
      if (!inRepulsionZone) {
        const neighborMid = slerp(e.points[i - 1], e.points[i + 1], 0.5);
        p = slerp(p, neighborMid, tunables.tighteningStep * forceScale);
      }
      // ---

      if (p !== orig) {
        e.points[i] = p;
      }
    }
  }

  // Sync pseudo-vertex positions to their edge's current arc midpoint so they
  // move with the edge during smoothing rather than floating free.
  for (const v of state.vertices.values()) {
    if (!v.isPseudo || v.pseudoEdgeId === undefined) continue;
    const e = state.edges.get(v.pseudoEdgeId);
    if (!e || e.points.length < 3) continue;
    v.pos = e.points[Math.floor(e.points.length / 2)];
  }
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
        const pa0 = ea.points[a], pa1 = ea.points[a+1];
        const amx = pa0.x+pa1.x, amy = pa0.y+pa1.y, amz = pa0.z+pa1.z;
        for (let b = 0; b < eb.points.length - 1; b++) {
          if (!arcsCross(pa0, pa1, eb.points[b], eb.points[b+1])) continue;
          // Hemisphere guard: arcsCross fires for the real crossing AND its antipodal ghost.
          // The real crossing is on the same hemisphere as both arc midpoints.
          const pb0 = eb.points[b], pb1 = eb.points[b+1];
          const bmx = pb0.x+pb1.x, bmy = pb0.y+pb1.y, bmz = pb0.z+pb1.z;
          if (amx*bmx + amy*bmy + amz*bmz > 0) return true;
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
  // Guard with the hemisphere check: arcsCross fires for both a crossing and its antipodal
  // ghost, so confirm the vertex arc and edge segment are in the same hemisphere.
  if (dragVertBefore) {
    const dragVertAfter = state.vertices.get(drag.vertexId)?.pos;
    if (dragVertAfter) {
      const vmx = dragVertBefore.x + dragVertAfter.x;
      const vmy = dragVertBefore.y + dragVertAfter.y;
      const vmz = dragVertBefore.z + dragVertAfter.z;
      for (const e of state.edges.values()) {
        if (e.v1 === drag.vertexId || e.v2 === drag.vertexId) continue;
        const pts: SpherePoint[] = [];
        for (let i = 0; i < e.points.length; i++) {
          const p = before.get(`e${e.id}.${i}`);
          if (p) pts.push(p);
        }
        for (let i = 0; i < pts.length - 1; i++) {
          if (!arcsCross(dragVertBefore, dragVertAfter, pts[i], pts[i + 1])) continue;
          const emx = pts[i].x + pts[i+1].x;
          const emy = pts[i].y + pts[i+1].y;
          const emz = pts[i].z + pts[i+1].z;
          if (vmx*emx + vmy*emy + vmz*emz > 0) {
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
 * True if an edge has accumulated far more interior points than its current
 * (post-shrink) arc length needs — e.g. a stroke drawn needlessly long across
 * the sphere whose endpoints have since been pulled close together by layout
 * smoothing. redistributePoints/laplacianSmooth only reposition the existing
 * points along the polyline; they never change how many there are, so an
 * overcrowded edge can stay visibly bunched instead of settling.
 */
function edgeOvercrowded(e: Edge): boolean {
  const arcLen = polylineLength(e.points);
  const idealInterior = Math.max(1, Math.round(arcLen * tunables.pointsPerRadian));
  const actualInterior = e.points.length - 2;
  return actualInterior > idealInterior * tunables.overcrowdRatio
      && actualInterior - idealInterior > tunables.overcrowdMinExcess;
}

/**
 * Resample an edge to a point count proportional to its arc length.
 * Replaces e.points in-place; endpoints are preserved exactly.
 */
export function resampleEdge(e: Edge): void {
  const pts = e.points;
  if (pts.length < 2) return;

  // Compute total arc length
  let arcLen = 0;
  for (let i = 1; i < pts.length; i++) {
    const dot = Math.max(-1, Math.min(1, pts[i-1].x*pts[i].x + pts[i-1].y*pts[i].y + pts[i-1].z*pts[i].z));
    arcLen += Math.acos(dot);
  }

  const interiorCount = Math.max(1, Math.round(arcLen * tunables.pointsPerRadian));
  const totalCount = interiorCount + 2; // + 2 endpoints

  // Build cumulative arc lengths for interpolation
  const cumLen = [0];
  for (let i = 1; i < pts.length; i++) {
    const dot = Math.max(-1, Math.min(1, pts[i-1].x*pts[i].x + pts[i-1].y*pts[i].y + pts[i-1].z*pts[i].z));
    cumLen.push(cumLen[i-1] + Math.acos(dot));
  }

  const newPts: SpherePoint[] = [{ ...pts[0] }];
  let seg = 0;
  for (let i = 1; i < totalCount - 1; i++) {
    const target = (i / (totalCount - 1)) * arcLen;
    while (seg < pts.length - 2 && cumLen[seg + 1] < target) seg++;
    const segLen = cumLen[seg + 1] - cumLen[seg];
    const t = segLen < 1e-12 ? 0 : (target - cumLen[seg]) / segLen;
    newPts.push(slerp(pts[seg], pts[seg + 1], t));
  }
  newPts.push({ ...pts[pts.length - 1] });

  e.points = newPts;
}

/**
 * Resample an edge to an exact point count (including endpoints).
 * Use this to force multiple edges to share the same number of points so their
 * interior points can be animated as matched pairs.
 */
export function resampleEdgeToCount(e: Edge, targetCount: number): void {
  if (e.points.length === targetCount || targetCount < 2) return;
  const pts = e.points;
  if (pts.length < 2) return;

  const cumLen = [0];
  for (let i = 1; i < pts.length; i++) {
    const dot = Math.max(-1, Math.min(1, pts[i-1].x*pts[i].x + pts[i-1].y*pts[i].y + pts[i-1].z*pts[i].z));
    cumLen.push(cumLen[i-1] + Math.acos(dot));
  }
  const arcLen = cumLen[cumLen.length - 1];

  const newPts: SpherePoint[] = [{ ...pts[0] }];
  let seg = 0;
  for (let i = 1; i < targetCount - 1; i++) {
    const target = (i / (targetCount - 1)) * arcLen;
    while (seg < pts.length - 2 && cumLen[seg + 1] < target) seg++;
    const segLen = cumLen[seg + 1] - cumLen[seg];
    const t = segLen < 1e-12 ? 0 : (target - cumLen[seg]) / segLen;
    newPts.push(slerp(pts[seg], pts[seg + 1], t));
  }
  newPts.push({ ...pts[pts.length - 1] });

  e.points = newPts;
}

// ---------------------------------------------------------------------------
// Arc-length redistribution
// ---------------------------------------------------------------------------

function redistributePoints(pts: SpherePoint[]): boolean {
  const n = pts.length;
  const arcLen = [0];
  for (let i = 1; i < n; i++) {
    const d0 = Math.min(1, Math.max(-1, pts[i-1].x*pts[i].x + pts[i-1].y*pts[i].y + pts[i-1].z*pts[i].z));
    arcLen.push(arcLen[i-1] + Math.acos(d0));
  }
  const total = arcLen[n-1];
  if (total < 1e-12) return false;

  const result: SpherePoint[] = [{ ...pts[0] }];
  let seg = 0;
  for (let i = 1; i < n - 1; i++) {
    const target = (i / (n - 1)) * total;
    while (seg < n - 2 && arcLen[seg + 1] < target) seg++;
    const segLen = arcLen[seg + 1] - arcLen[seg];
    const t = segLen < 1e-12 ? 0 : (target - arcLen[seg]) / segLen;
    result.push(slerp(pts[seg], pts[seg + 1], t));
  }
  result.push({ ...pts[n-1] });

  let moved = false;
  for (let i = 1; i < n - 1; i++) {
    const dot = Math.max(-1, Math.min(1, pts[i].x*result[i].x + pts[i].y*result[i].y + pts[i].z*result[i].z));
    if (Math.acos(dot) > tunables.settleEpsilon) moved = true;
    pts[i] = result[i];
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Geodesic Laplacian smoothing
// ---------------------------------------------------------------------------

function laplacianSmooth(pts: SpherePoint[], iterations: number, strength: number): boolean {
  const n = pts.length;
  let moved = false;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 1; i < n - 1; i++) {
      const mid = slerp(pts[i-1], pts[i+1], 0.5);
      const next = slerp(pts[i], mid, strength);
      const dot = Math.max(-1, Math.min(1, pts[i].x*next.x + pts[i].y*next.y + pts[i].z*next.z));
      if (Math.acos(dot) > tunables.settleEpsilon) moved = true;
      pts[i] = next;
    }
  }
  return moved;
}
