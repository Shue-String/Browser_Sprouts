/**
 * Geometry for Recreate: propose candidate strokes for a single target move.
 *
 * Design split (see plan): synthesis only PROPOSES geometry; the orchestrator
 * (recreate.ts) is the judge — it applies each candidate on a clone and accepts
 * the first whose computeMoveCode matches the target token. Because regions are
 * recomputed purely from geometry every move, and the layout physics tidies up
 * afterward, a candidate only has to be topologically correct: non-crossing and
 * (for enclosures) partitioning nested components onto the right side.
 *
 * Candidate sets: geodesic + bowed arcs for two-endpoint moves (both perpendicular
 * directions); centroid-directed bows + V-lasso for enclosures with a non-empty
 * bracket set; small-circle loops for self-loops.
 */

import type { GameState, VertexId, EdgeId } from './types';
import type { SpherePoint } from '../math/sphere';
import { normalize, slerp, segCrossesPolylineSphere, sphereCentroid } from '../math/sphere';
import type { ResolvedMove } from './moveCodeParse';
import { compWithBoth } from './moveCode';
import { buildSubregionHighlight } from './subregionHighlight';
import { buildVoronoiGraph } from './voronoiGraph';
import { computeJunctionVoronoiPath } from './voronoiJunctionPath';

const SAMPLES = 24; // points per synthesized stroke arc

type V3 = SpherePoint;
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

/**
 * Ordered list of candidate strokes to try for `parsed`, best-guess first.
 * The orchestrator verifies each against the target token and uses the first
 * that reproduces it. Returns [] when no candidate can be proposed (→ the
 * controller falls back to manual draw).
 */
export function candidateStrokes(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  const a = state.vertices.get(parsed.lo)?.pos;
  const b = state.vertices.get(parsed.hi)?.pos;
  if (!a || !b) return [];

  if (parsed.lo === parsed.hi) {
    const candidates: SpherePoint[][] = [];
    if (parsed.brackets && parsed.brackets.length > 0) {
      for (const c of targetedSelfLoopCandidates(state, parsed)) candidates.push(c);
      for (const c of voronoiSelfLoopArcs(state, parsed)) candidates.push(c);
    }
    for (const c of selfLoopCandidates(a)) candidates.push(c);
    // Last resort: when the vertex sits in a crowded tangent space, none of the
    // above (which sweep out to radius 0.9) may clear existing geometry. Tiny
    // loops squeezed right up against the vertex are far more likely to miss
    // everything, and the physics smoothing step naturally pushes such a tight
    // loop open into free space once the move commits (see smooth.ts's
    // repulsion zones) — so they're a reasonable-looking result even though
    // they start out nearly degenerate.
    for (const c of tinySelfLoopCandidates(a)) candidates.push(c);
    // Deepest fallback: the same junction-graph Voronoi routing used for
    // complicated enclosures (see main.ts's Recreate fallback), which the
    // simpler curve attempts above can't reach when the region has no other
    // boundary to bow around.
    if (parsed.brackets && parsed.brackets.length > 0) {
      const c = junctionVoronoiArc(state, parsed);
      if (c) candidates.push(c);
    }
    return candidates;
  }

  // For enclosure moves, prepend Voronoi-boundary arcs — they trace the natural
  // separation curve between the enclosed components and the rest of the region,
  // giving the verify loop a topologically-guided candidate before falling back
  // to the generic bowed arcs.
  const candidates: SpherePoint[][] = [];
  if (parsed.brackets && parsed.brackets.length > 0) {
    for (const c of voronoiBoundaryArcs(state, parsed)) candidates.push(c);
  }
  for (const c of arcCandidates(a, b)) candidates.push(c);
  for (const c of enclosureCandidates(state, parsed)) candidates.push(c);
  // Deepest fallback: route through the junction-graph Voronoi system (the
  // same one used for complicated enclosures) when nothing simpler verified —
  // this is the only path that understands topology in regions with no other
  // boundary to bow the basic curves around.
  if (parsed.brackets && parsed.brackets.length > 0) {
    const c = junctionVoronoiArc(state, parsed);
    if (c) candidates.push(c);
  }
  return candidates;
}

/**
 * Last-resort candidate for enclosure moves (including self-loops, where lo
 * === hi): builds the same subregion-highlight + Voronoi junction graph used
 * by the complicated-enclosure Recreate fallback (see main.ts) and asks
 * computeJunctionVoronoiPath for a route. Unlike voronoiBoundaryArcs/
 * voronoiSelfLoopArcs above (which need a distinguishable inner sub-boundary
 * to bow around), the junction graph's own fallbacks — including the
 * plain-shortest-path case for a region with no other boundaries at all —
 * mean this still has a shot when the simpler curve attempts come back empty.
 */
function junctionVoronoiArc(state: GameState, parsed: ResolvedMove): SpherePoint[] | null {
  if (!parsed.brackets || parsed.brackets.length === 0) return null;
  const loV = state.vertices.get(parsed.lo);
  const hiV = state.vertices.get(parsed.hi);
  if (!loV || !hiV) return null;

  const highlight = buildSubregionHighlight(state, parsed.lo, parsed.hi, parsed.brackets);
  if (!highlight) return null;
  const vData = buildVoronoiGraph(state, highlight, parsed.lo, parsed.hi);
  const result = computeJunctionVoronoiPath(vData, loV.pos, hiV.pos);
  return result ? result.pts : null;
}

/**
 * Geodesic between two endpoints, plus arcs bulged to either side by a range of
 * magnitudes. The straight geodesic is tried first (typical merge); the bulges
 * let the verify loop dodge a blocking edge or pick the enclosure side.
 */
function arcCandidates(a: V3, b: V3): SpherePoint[][] {
  const out: SpherePoint[][] = [geodesic(a, b)];

  // Direction perpendicular to the great-circle plane, used to bow the arc.
  let nrm = cross(a, b);
  if (Math.hypot(nrm.x, nrm.y, nrm.z) < 1e-6) nrm = { x: 0, y: 0, z: 1 };
  nrm = normalize(nrm);

  for (const mag of [0.25, 0.5, 0.8, 1.2]) {
    out.push(bowedArc(a, b, nrm, mag));
    out.push(bowedArc(a, b, nrm, -mag));
  }

  // Long geodesic (around the back) and bowed variants at the same magnitudes.
  out.push(longGeodesic(a, b));
  for (const mag of [0.25, 0.5, 0.8, 1.2]) {
    out.push(bowedLongArc(a, b, nrm, mag));
    out.push(bowedLongArc(a, b, nrm, -mag));
  }

  return out;
}

/** Evenly slerp-sampled great-circle arc from a to b (inclusive endpoints). */
function geodesic(a: V3, b: V3): SpherePoint[] {
  const pts: SpherePoint[] = [];
  for (let i = 0; i < SAMPLES; i++) pts.push(slerp(a, b, i / (SAMPLES - 1)));
  return pts;
}

/**
 * The long way around: the major arc from a to b on the same great circle.
 * Routes through the antipode of the short arc's midpoint, which lies on the
 * same great circle. Two slerp halves keep the path smooth.
 */
function longGeodesic(a: V3, b: V3): SpherePoint[] {
  const shortMid = slerp(a, b, 0.5);
  const via = normalize({ x: -shortMid.x, y: -shortMid.y, z: -shortMid.z });
  const half = Math.ceil(SAMPLES / 2);
  const pts: SpherePoint[] = [];
  for (let i = 0; i < half; i++) pts.push(slerp(a, via, i / (half - 1)));
  for (let i = 1; i <= SAMPLES - half; i++) pts.push(slerp(via, b, i / (SAMPLES - half)));
  return pts;
}

/**
 * Long arc from a to b (around the back), bowed toward `nrm` by `mag` (signed).
 * Same structure as longGeodesic but the via-midpoint is shifted sideways before
 * the two slerp halves are computed.
 */
function bowedLongArc(a: V3, b: V3, nrm: V3, mag: number): SpherePoint[] {
  const shortMid = slerp(a, b, 0.5);
  const via = normalize(add(
    { x: -shortMid.x, y: -shortMid.y, z: -shortMid.z },
    scale(nrm, mag),
  ));
  const half = Math.ceil(SAMPLES / 2);
  const pts: SpherePoint[] = [];
  for (let i = 0; i < half; i++) pts.push(slerp(a, via, i / (half - 1)));
  for (let i = 1; i <= SAMPLES - half; i++) pts.push(slerp(via, b, i / (SAMPLES - half)));
  return pts;
}

/**
 * Arc from a to b bowed toward `nrm` by `mag` (signed). Built as two slerps
 * through a control point lifted off the great circle at the midpoint.
 */
function bowedArc(a: V3, b: V3, nrm: V3, mag: number): SpherePoint[] {
  const mid = slerp(a, b, 0.5);
  const ctrl = normalize(add(mid, scale(nrm, mag)));
  const pts: SpherePoint[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / (SAMPLES - 1);
    pts.push(t < 0.5 ? slerp(a, ctrl, t * 2) : slerp(ctrl, b, (t - 0.5) * 2));
  }
  return pts;
}

/**
 * Self-loop candidates: small circles passing through the vertex, at a few radii
 * and orientations. Each starts and ends exactly at the vertex.
 */

/**
 * Targeted self-loop candidates: circles at `v` whose center is aimed toward the
 * centroid of the bracket inside-vertices, at many radii. This finds the radius
 * that includes exactly the bracket set without picking up close neighbours.
 */
function targetedSelfLoopCandidates(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  if (!parsed.brackets || parsed.brackets.length === 0) return [];
  const loV = state.vertices.get(parsed.lo);
  if (!loV) return [];
  const v = loV.pos;
  const bracketMins = new Set(parsed.brackets);

  // Collect inside vertex positions (same classification as voronoiSelfLoopArcs).
  const insideVids = new Set<VertexId>();
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    for (const bound of r.boundaries) {
      const minId = Math.min(...bound.entries.map(e => e.vertexId));
      if (bracketMins.has(minId)) {
        for (const e of bound.entries) insideVids.add(e.vertexId);
      }
    }
  }
  insideVids.delete(parsed.lo);
  if (insideVids.size === 0) return [];

  // Centroid of inside vertices.
  const insidePts: SpherePoint[] = [];
  for (const vid of insideVids) {
    const p = state.vertices.get(vid)?.pos;
    if (p) insidePts.push(p);
  }
  if (insidePts.length === 0) return [];
  const centroid = sphereCentroid(insidePts);

  // Direction from v toward centroid (tangent component).
  const vN = normalize(v);
  const raw = add(centroid, scale(vN, -dot(centroid, vN)));
  const rawLen = Math.hypot(raw.x, raw.y, raw.z);
  if (rawLen < 1e-9) return [];
  const dir = scale(raw, 1 / rawLen);

  // Sweep many radii: small (tight around nearby vertex) to large (encompass all).
  const out: SpherePoint[][] = [];
  for (const radius of [0.1, 0.18, 0.25, 0.35, 0.45, 0.55, 0.65, 0.8, 1.0, 1.2]) {
    const centre = normalize(add(vN, scale(dir, radius)));
    out.push(circleThrough(vN, centre));
    // Opposite side (encloses everything else — rarely needed but covers edge cases).
    out.push(circleThrough(vN, normalize(add(vN, scale(dir, -radius)))));
  }
  return out;
}

function selfLoopCandidates(v: V3): SpherePoint[][] {
  const vN = normalize(v);
  // Two tangent basis vectors at the vertex.
  const ref: V3 = Math.abs(vN.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const e1 = normalize(add(ref, scale(vN, -dot(ref, vN))));
  const e2 = cross(vN, e1);

  const out: SpherePoint[][] = [];
  for (const radius of [0.35, 0.6, 0.9]) {
    for (let dir = 0; dir < 4; dir++) {
      const ang = (Math.PI / 2) * dir;
      // Circle centre offset from the vertex along (cos,sin) in the tangent plane.
      const off = add(scale(e1, Math.cos(ang) * radius), scale(e2, Math.sin(ang) * radius));
      const centre = normalize(add(vN, off));
      out.push(circleThrough(vN, centre));
    }
  }
  return out;
}

/**
 * Fallback self-loop candidates for a vertex with little free tangent space: much
 * tighter loops than selfLoopCandidates (down to radius 0.03), swept through 8
 * directions instead of 4 for a better chance of finding a sliver of clearance.
 */
function tinySelfLoopCandidates(v: V3): SpherePoint[][] {
  const vN = normalize(v);
  const ref: V3 = Math.abs(vN.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const e1 = normalize(add(ref, scale(vN, -dot(ref, vN))));
  const e2 = cross(vN, e1);

  const out: SpherePoint[][] = [];
  for (const radius of [0.03, 0.06, 0.1, 0.15]) {
    for (let dir = 0; dir < 8; dir++) {
      const ang = (Math.PI / 4) * dir;
      const off = add(scale(e1, Math.cos(ang) * radius), scale(e2, Math.sin(ang) * radius));
      const centre = normalize(add(vN, off));
      out.push(circleThrough(vN, centre));
    }
  }
  return out;
}

/** Small circle centred at `centre` that passes through `v`, sampled v→...→v. */
function circleThrough(v: V3, centre: V3, sampleCount = SAMPLES): SpherePoint[] {
  const c = normalize(centre);
  // Basis in the plane perpendicular to the circle axis (c).
  const r0 = normalize(add(v, scale(c, -dot(v, c)))); // v projected onto the plane ⟂ c
  const r1 = cross(c, r0);
  const cosR = dot(v, c);
  const sinR = Math.sqrt(Math.max(0, 1 - cosR * cosR));
  const pts: SpherePoint[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = (2 * Math.PI * i) / (sampleCount - 1);
    pts.push(normalize(add(
      scale(c, cosR),
      add(scale(r0, Math.cos(t) * sinR), scale(r1, Math.sin(t) * sinR)),
    )));
  }
  // Snap the endpoints to exactly the vertex so the loop closes on it.
  pts[0] = { ...v };
  pts[pts.length - 1] = { ...v };
  return pts;
}

/**
 * A genuinely circular self-loop of angular `radius` at `v`, oriented toward `hint` (a nearby
 * point whose direction from `v` sets which way the loop bulges — arbitrary if `hint` is ~coincident
 * with `v`). For dead-region collapse (deadRegions.ts): those collapses build a self-loop by
 * shrinking an existing edge's two endpoints together, which for a near-straight edge produces a
 * near-collinear "loop" with no lateral area — repulsion forces have nothing to expand, since
 * pushing points apart along an already-straight path just redistributes them, it doesn't bow the
 * path outward. Synthesizing a real circle up front (the same primitive drawn self-loop moves use
 * via circleThrough above) guarantees non-degenerate starting geometry.
 */
export function smallCircleSelfLoop(v: SpherePoint, hint: SpherePoint, radius: number, sampleCount = 9): SpherePoint[] {
  const vN = normalize(v);
  const d = hint.x * vN.x + hint.y * vN.y + hint.z * vN.z;
  let tx = hint.x - d * vN.x, ty = hint.y - d * vN.y, tz = hint.z - d * vN.z;
  let len = Math.hypot(tx, ty, tz);
  if (len < 1e-9) {
    // hint is ~coincident with v (or antipodal) — fall back to an arbitrary tangent direction.
    const ref: V3 = Math.abs(vN.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const dp = ref.x * vN.x + ref.y * vN.y + ref.z * vN.z;
    tx = ref.x - dp * vN.x; ty = ref.y - dp * vN.y; tz = ref.z - dp * vN.z;
    len = Math.hypot(tx, ty, tz);
  }
  const dir = { x: tx / len, y: ty / len, z: tz / len };
  const cosR = Math.cos(radius), sinR = Math.sin(radius);
  const centre = normalize(add(scale(vN, cosR), scale(dir, sinR)));
  return circleThrough(vN, centre, sampleCount);
}

// ---------------------------------------------------------------------------
// Enclosure routing — centroid-directed bows + V-lasso
// ---------------------------------------------------------------------------

/**
 * Additional candidates for enclosure moves (lo and hi on the same boundary
 * component, parsed.brackets non-empty). The standard arcCandidates already
 * try both perpendicular directions, so we add candidates that aim specifically
 * at the bracket-set centroid, giving the verify loop a directed option when
 * the perpendicular arcs cross an existing edge or hit the wrong face.
 *
 * Strategy:
 *  1. Find region R (mirror compWithBoth from moveCode.ts).
 *  2. Collect positions of vertices in the bracket-set sub-boundaries.
 *  3. Compute their centroid.
 *  4. Bow from lo to hi toward that centroid (several magnitudes).
 *  5. Add a V-lasso: lo → waypoint near centroid → hi (deeper penetration).
 */
export function enclosureCandidates(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  if (!parsed.brackets || parsed.brackets.length === 0) return [];

  const loV = state.vertices.get(parsed.lo);
  const hiV = state.vertices.get(parsed.hi);
  if (!loV || !hiV) return [];

  const a = loV.pos;
  const b = hiV.pos;
  const bracketMins = new Set(parsed.brackets);

  // Find region R: first living region whose boundary component contains both lo and hi.
  let bracketVerts: SpherePoint[] = [];
  outer:
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    const comp = compWithBoth(r, parsed.lo, parsed.hi);
    if (!comp) continue;
    // Collect positions of vertices in bracket-set sub-boundaries.
    for (const sub of r.boundaries) {
      if (sub === comp) continue;
      const minId = Math.min(...sub.entries.map(e => e.vertexId));
      if (!bracketMins.has(minId)) continue;
      for (const e of sub.entries) {
        const v = state.vertices.get(e.vertexId);
        if (v) bracketVerts.push(v.pos);
      }
    }
    break outer;
  }

  if (bracketVerts.length === 0) return [];

  // Centroid of bracket-set vertex positions (normalised to sphere).
  const centroid = sphereCentroid(bracketVerts);

  // Direction perpendicular to the lo-hi great circle, snapped to point toward
  // the centroid (flip sign if centroid is on the wrong side).
  let nrm = cross(a, b);
  if (Math.hypot(nrm.x, nrm.y, nrm.z) < 1e-6) nrm = { x: 0, y: 0, z: 1 };
  nrm = normalize(nrm);
  if (dot(centroid, nrm) < 0) nrm = scale(nrm, -1);

  const results: SpherePoint[][] = [];

  // Centroid-directed bowed arcs: larger magnitudes than arcCandidates to reach
  // deeper into the face.
  for (const mag of [0.4, 0.8, 1.3, 1.8]) {
    results.push(bowedArc(a, b, nrm, mag));
  }

  // V-lasso: lo → waypoint offset from centroid (away from lo-hi midpoint) → hi.
  // Useful when the bracket set is deep inside the face and a simple bow is too shallow.
  const mid = slerp(a, b, 0.5);
  // Push the waypoint away from mid toward centroid.
  for (const reach of [0.5, 1.0, 1.5]) {
    const wp = normalize(add(mid, scale(nrm, reach)));
    results.push(vLasso(a, b, wp));
  }

  return results;
}

/** Two-segment V path: a → mid → b, each segment slerp-sampled. */
function vLasso(a: V3, mid: V3, b: V3): SpherePoint[] {
  const half = Math.ceil(SAMPLES / 2);
  const pts: SpherePoint[] = [];
  for (let i = 0; i < half; i++) pts.push(slerp(a, mid, i / (half - 1)));
  for (let i = 1; i < SAMPLES - half + 1; i++) pts.push(slerp(mid, b, i / (SAMPLES - half)));
  return pts;
}

// ---------------------------------------------------------------------------
// Crossing check
// ---------------------------------------------------------------------------

/**
 * Returns true if `stroke` (in sphere space) crosses any existing edge. The test
 * is spherical (great-circle arc vs great-circle arc via segCrossesPolylineSphere),
 * so it is camera-independent — a far-side edge that merely overlaps the stroke in
 * screen projection is not a false positive. Pass `skipEdgeId` to exclude one edge
 * (e.g. the edge just committed, to avoid self-comparison).
 *
 * `strokeV1` / `strokeV2` are the vertex IDs at the stroke's endpoints. For
 * any existing edge that shares one of those vertices, the edge segment
 * adjacent to the shared endpoint is skipped, along with the stroke's own first
 * and last segments — otherwise the tiny near-vertex samples cluster around the
 * shared point and produce false-positive crossings.
 */
export function strokeCrossesEdges(
  state: GameState,
  stroke: SpherePoint[],
  skipEdgeId?: EdgeId,
  strokeV1?: VertexId,
  strokeV2?: VertexId,
): boolean {
  if (stroke.length < 2) return false;
  for (const edge of state.edges.values()) {
    if (edge.id === skipEdgeId) continue;
    // Skip the first edge segment if edge.v1 shares a vertex with the stroke,
    // and the last edge segment if edge.v2 does. Covers self-loops (v1===v2)
    // by skipping both ends.
    const skipFirst = (strokeV1 != null && edge.v1 === strokeV1) || (strokeV2 != null && edge.v1 === strokeV2) ? 1 : 0;
    const skipLast  = (strokeV1 != null && edge.v2 === strokeV1) || (strokeV2 != null && edge.v2 === strokeV2) ? 1 : 0;
    // Also skip the first and last stroke segments for the same reason.
    for (let i = 1; i < stroke.length - 2; i++) {
      if (segCrossesPolylineSphere(stroke[i], stroke[i + 1], edge.points, skipLast, skipFirst)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Voronoi-boundary arc synthesis
// ---------------------------------------------------------------------------

/**
 * For an enclosure move, trace the Voronoi boundary between the bracket-set
 * vertices (inside) and all other region vertices (outside).  This boundary
 * is the natural curve that separates the enclosed components from the rest
 * of the face — tracing along it while connecting to lo and hi produces a
 * topologically reliable enclosure arc.
 *
 * Returns two candidates (one for each trace direction around the inside
 * components). The verify loop in recreate.ts picks whichever reproduces the
 * target token.
 */
function voronoiBoundaryArcs(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  if (!parsed.brackets || parsed.brackets.length === 0) return [];

  const loV = state.vertices.get(parsed.lo);
  const hiV = state.vertices.get(parsed.hi);
  if (!loV || !hiV) return [];

  const a = loV.pos;
  const b = hiV.pos;
  const bracketMins = new Set(parsed.brackets);

  // Find region R: the boundary that contains both lo and hi.
  // Use the LONGEST such boundary to avoid being fooled by a joint vertex that
  // also appears on an inner sub-component.
  let regionBounds: readonly { entries: { vertexId: VertexId }[] }[] = [];
  let outerComp: { entries: { vertexId: VertexId }[] } | null = null;
  let bestLen = -1;

  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    for (const bound of r.boundaries) {
      const ids = new Set(bound.entries.map(e => e.vertexId));
      if (ids.has(parsed.lo) && ids.has(parsed.hi) && bound.entries.length > bestLen) {
        bestLen = bound.entries.length;
        outerComp = bound;
        regionBounds = r.boundaries;
      }
    }
  }
  if (!outerComp) return [];

  // Classify region vertices as inside (bracket components) or outside.
  const insideVids = new Set<VertexId>();
  for (const sub of regionBounds) {
    if (sub === outerComp) continue;
    const minId = Math.min(...sub.entries.map(e => e.vertexId));
    if (bracketMins.has(minId)) {
      for (const e of sub.entries) insideVids.add(e.vertexId);
    }
  }
  if (insideVids.size === 0) return [];

  const insideSeeds: V3[] = [];
  const outsideSeeds: V3[] = [a, b]; // lo and hi are always outside
  const seen = new Set<VertexId>();
  for (const sub of regionBounds) {
    for (const e of sub.entries) {
      if (seen.has(e.vertexId)) continue;
      seen.add(e.vertexId);
      const v = state.vertices.get(e.vertexId);
      if (!v) continue;
      (insideVids.has(e.vertexId) ? insideSeeds : outsideSeeds).push(v.pos);
    }
  }

  // Nearest-seed functions on the sphere (max dot product = min angle).
  const nearIn  = (P: V3): V3 => insideSeeds.reduce((best, s) => dot(P, s) > dot(P, best) ? s : best);
  const nearOut = (P: V3): V3 => outsideSeeds.reduce((best, s) => dot(P, s) > dot(P, best) ? s : best);

  // Snap a point to the Voronoi boundary (equidistant from nearest inside and
  // outside seeds) by gradient descent on f(P) = P·ni − P·no.
  const snap = (P: V3): V3 => {
    for (let i = 0; i < 30; i++) {
      const ni = nearIn(P), no = nearOut(P);
      const diff = dot(P, ni) - dot(P, no);
      if (Math.abs(diff) < 1e-8) break;
      // grad_f = ni - no; step against gradient to reduce |diff|.
      P = normalize({
        x: P.x - 0.4 * diff * (ni.x - no.x),
        y: P.y - 0.4 * diff * (ni.y - no.y),
        z: P.z - 0.4 * diff * (ni.z - no.z),
      });
    }
    return P;
  };

  // Entry and exit points on the boundary, approached from lo and hi respectively.
  const startB = snap(normalize(add(a, nearIn(a))));
  const endB   = snap(normalize(add(b, nearIn(b))));

  // Trace the boundary with a fixed angular step, keeping inside to one side.
  // sign=+1: inside to left; sign=-1: inside to right.
  const STEP = 0.06; // ~3.4° per step
  const MAX_STEPS = 200;
  const STOP_COS = Math.cos(STEP * 2); // stop when close enough to endB

  const tracePath = (sign: 1 | -1): V3[] => {
    const path: V3[] = [startB];
    let cur = startB;
    for (let step = 0; step < MAX_STEPS; step++) {
      const ni = nearIn(cur), no = nearOut(cur);
      // crossDir points from outside toward inside.
      const cd = normalize({ x: ni.x - no.x, y: ni.y - no.y, z: ni.z - no.z });
      // Tangent in the sphere's tangent plane at cur, perpendicular to crossDir.
      const raw: V3 = {
        x: sign * (cd.y * cur.z - cd.z * cur.y),
        y: sign * (cd.z * cur.x - cd.x * cur.z),
        z: sign * (cd.x * cur.y - cd.y * cur.x),
      };
      const tl = Math.hypot(raw.x, raw.y, raw.z);
      if (tl < 1e-9) break;
      const next = snap(normalize(add(cur, scale(raw, STEP / tl))));
      if (step > 3 && dot(next, endB) > STOP_COS) break;
      path.push(next);
      cur = next;
    }
    path.push(endB);
    return path;
  };

  // Build a complete arc: lo → [approach slerp] → boundary → [departure slerp] → hi.
  const APPROACH = 6;
  const buildArc = (boundary: V3[]): SpherePoint[] => {
    const pts: SpherePoint[] = [];
    for (let i = 0; i <= APPROACH; i++) pts.push(slerp(a, startB, i / APPROACH));
    for (let i = 1; i < boundary.length; i++) pts.push(boundary[i]);
    for (let i = 1; i <= APPROACH; i++) pts.push(slerp(endB, b, i / APPROACH));
    return pts;
  };

  return [buildArc(tracePath(+1)), buildArc(tracePath(-1))];
}

/**
 * For a self-loop enclosure move (lo === hi, non-empty brackets), trace the
 * Voronoi boundary between inside (bracket) and outside vertices as a CLOSED
 * curve that starts and ends at lo.
 *
 * Vertex classification uses boundary-min: a boundary whose minimum vertex ID
 * is in bracketMins counts as "inside" — this correctly identifies both inner
 * sub-boundaries AND outer-boundary sections (whose min may be a bracket entry)
 * without over-expanding via the game graph.
 *
 * Returns two candidates: one tracing CW around the inside blob, one CCW.
 * The verify loop in recreate.ts picks whichever encloses the right side.
 */
/** Re-runs voronoi self-loop arc generation with classified extra seeds from Voronoi clustering.
 *  hue === -2 → red/bracket → inside; anything else → outside. */
export function candidateSelfLoopArcsWithSeeds(
  state: GameState,
  parsed: ResolvedMove,
  extraSeeds: { pos: SpherePoint; hue: number }[],
): SpherePoint[][] {
  const extraIn  = extraSeeds.filter(s => s.hue === -2).map(s => s.pos);
  const extraOut = extraSeeds.filter(s => s.hue !== -2).map(s => s.pos);
  return voronoiSelfLoopArcs(state, parsed, extraIn, extraOut);
}

function voronoiSelfLoopArcs(state: GameState, parsed: ResolvedMove, extraInsideSeeds?: V3[], extraOutsideSeeds?: V3[]): SpherePoint[][] {
  if (!parsed.brackets || parsed.brackets.length === 0) return [];
  const loV = state.vertices.get(parsed.lo);
  if (!loV) return [];
  const a = loV.pos;
  const bracketMins = new Set(parsed.brackets);

  // Find the region whose boundary contains lo and has sub-boundaries.
  // Among candidates prefer the boundary containing lo that is longest.
  let regionBounds: readonly { entries: { vertexId: VertexId }[] }[] = [];
  let bestLen = -1;
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    if (r.boundaries.length < 2) continue;
    for (const bound of r.boundaries) {
      const hasLo = bound.entries.some(e => e.vertexId === parsed.lo);
      if (hasLo && bound.entries.length > bestLen) {
        bestLen = bound.entries.length;
        regionBounds = r.boundaries;
      }
    }
  }
  if (regionBounds.length === 0) return [];

  // Classify each boundary as inside or outside by its minimum vertex ID.
  const insideVids = new Set<VertexId>();
  for (const bound of regionBounds) {
    const minId = Math.min(...bound.entries.map(e => e.vertexId));
    if (bracketMins.has(minId)) {
      for (const e of bound.entries) insideVids.add(e.vertexId);
    }
  }
  insideVids.delete(parsed.lo); // lo is always outside (grey cell)
  if (insideVids.size === 0) return [];

  const insideSeeds: V3[] = [];
  const outsideSeeds: V3[] = [a];
  const seen = new Set<VertexId>();
  for (const bound of regionBounds) {
    for (const e of bound.entries) {
      if (seen.has(e.vertexId)) continue;
      seen.add(e.vertexId);
      const v = state.vertices.get(e.vertexId);
      if (!v) continue;
      (insideVids.has(e.vertexId) ? insideSeeds : outsideSeeds).push(v.pos);
    }
  }
  if (extraInsideSeeds)  for (const s of extraInsideSeeds)  insideSeeds.push(s);
  if (extraOutsideSeeds) for (const s of extraOutsideSeeds) outsideSeeds.push(s);
  if (insideSeeds.length === 0) return [];

  const nearIn  = (P: V3): V3 => insideSeeds.reduce((best, s) => dot(P, s) > dot(P, best) ? s : best);
  const nearOut = (P: V3): V3 => outsideSeeds.reduce((best, s) => dot(P, s) > dot(P, best) ? s : best);

  const snap = (P: V3): V3 => {
    for (let i = 0; i < 30; i++) {
      const ni = nearIn(P), no = nearOut(P);
      const diff = dot(P, ni) - dot(P, no);
      if (Math.abs(diff) < 1e-8) break;
      P = normalize({
        x: P.x - 0.4 * diff * (ni.x - no.x),
        y: P.y - 0.4 * diff * (ni.y - no.y),
        z: P.z - 0.4 * diff * (ni.z - no.z),
      });
    }
    return P;
  };

  // Snap from lo toward the nearest inside seed to land on the Voronoi boundary.
  const startB = snap(normalize(add(a, nearIn(a))));

  const STEP = 0.06;
  const MAX_STEPS = 300;
  const CLOSE_COS = Math.cos(STEP * 2);

  // One step along the Voronoi boundary at cur in the given sign direction.
  const stepB = (cur: V3, sign: 1 | -1): V3 => {
    const ni = nearIn(cur), no = nearOut(cur);
    const cd = normalize({ x: ni.x - no.x, y: ni.y - no.y, z: ni.z - no.z });
    const raw: V3 = {
      x: sign * (cd.y * cur.z - cd.z * cur.y),
      y: sign * (cd.z * cur.x - cd.x * cur.z),
      z: sign * (cd.x * cur.y - cd.y * cur.x),
    };
    const tl = Math.hypot(raw.x, raw.y, raw.z);
    if (tl < 1e-9) return cur;
    return snap(normalize(add(cur, scale(raw, STEP / tl))));
  };

  // Walk a few steps in each direction from startB to get two distinct departure/
  // arrival points on the boundary. This ensures the two legs of the self-loop
  // leave vertex a at a meaningful angle rather than overlapping.
  const WING_STEPS = 4; // ≈ 4 × 3.4° ≈ 14° separation along the boundary
  let depB = startB; // departure point: outgoing leg goes a → depB
  let arrB = startB; // arrival point:   incoming leg goes arrB → a
  for (let i = 0; i < WING_STEPS; i++) depB = stepB(depB, +1);
  for (let i = 0; i < WING_STEPS; i++) arrB = stepB(arrB, -1);

  // Trace from depB to arrB in the given sign direction (all the way around).
  const traceLoop = (exitPt: V3, entryPt: V3, sign: 1 | -1): V3[] => {
    const path: V3[] = [exitPt];
    let cur = exitPt;
    for (let step = 0; step < MAX_STEPS; step++) {
      const next = stepB(cur, sign);
      path.push(next);
      cur = next;
      if (step > 15 && dot(next, entryPt) > CLOSE_COS) break;
    }
    return path;
  };

  // Build a full stroke: a → exitPt → [trace] → entryPt → a.
  const APPROACH = 4;
  const buildLoopArc = (exitPt: V3, loopPts: V3[], entryPt: V3): SpherePoint[] => {
    const pts: SpherePoint[] = [];
    for (let i = 0; i <= APPROACH; i++) pts.push(slerp(a, exitPt, i / APPROACH));
    for (let i = 1; i < loopPts.length; i++) pts.push(loopPts[i]);
    for (let i = 1; i <= APPROACH; i++) pts.push(slerp(entryPt, a, i / APPROACH));
    return pts;
  };

  // Two candidates: one going the +1 way around (depB → arrB), one going -1 (arrB → depB).
  return [
    buildLoopArc(depB, traceLoop(depB, arrB, +1), arrB),
    buildLoopArc(arrB, traceLoop(arrB, depB, -1), depB),
  ];
}

