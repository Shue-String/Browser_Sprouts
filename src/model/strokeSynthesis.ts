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
import { normalize, slerp, sphereCentroid, dot, cross, add, scale, tangentFrame, polylinesProperlyCross, sphereAngle, chord2 } from '../math/sphere';
import { distanceToArc, nearestOnArc } from './smoothGeometry';
import { strokeMidIndex } from './moves';
import type { ResolvedMove } from './moveCodeParse';
import { compWithBoth, inBrackets } from './moveCode';
import { buildSubregionHighlight } from './subregionHighlight';
import { buildVoronoiGraph } from './voronoiGraph';
import { computeJunctionVoronoiPath } from './voronoiJunctionPath';
import { routedCandidates } from './moveRouter';

const SAMPLES = 24; // points per synthesized stroke arc

type V3 = SpherePoint;

/**
 * Every candidate stroke for `parsed` (see candidateStrokeStream), as an array — for callers
 * that genuinely need them all (e.g. Recreate's pause-mode display). Callers that stop at the
 * first stroke that verifies should iterate candidateStrokeStream instead, so the expensive
 * groups further down are never built.
 */
export function candidateStrokes(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  return [...candidateStrokeStream(state, parsed)];
}

/**
 * Candidate strokes to try for `parsed`, best-guess first, generated LAZILY: each group is built
 * only when iteration reaches it. The orchestrator verifies each against the target and uses the
 * first that reproduces it, and most moves are reproduced by the plain geodesic / small loop at
 * the front — so the router's face meshes (40–125 ms each) and the legacy junction-graph Voronoi
 * fallback are only built when the cheap candidates have already failed. Yields nothing when no
 * candidate can be proposed (→ the controller falls back to manual draw).
 *
 * Each candidate whose new spot would land on top of existing geometry is preceded by nudged
 * copies of itself (see withMidClearance).
 */
export function* candidateStrokeStream(state: GameState, parsed: ResolvedMove): Generator<SpherePoint[]> {
  for (const stroke of rawCandidateStream(state, parsed)) yield* withMidClearance(state, stroke);
}

function* rawCandidateStream(state: GameState, parsed: ResolvedMove): Generator<SpherePoint[]> {
  const a = state.vertices.get(parsed.lo)?.pos;
  const b = state.vertices.get(parsed.hi)?.pos;
  if (!a || !b) return;

  // Topological router (moveRouter.ts): one stroke per reading of the move, each correct by
  // construction for its reading — so for anything that has to separate boundaries it goes
  // first. A move with nothing to enclose keeps its plain geodesic / round loop in front, which
  // looks nicer whenever it happens to be legal.
  const enclosing = !!parsed.brackets && parsed.brackets.length > 0;

  if (parsed.lo === parsed.hi) {
    if (!enclosing) yield* loopCircles(a, [0.35, 0.6, 0.9], 4);
    yield* routedCandidates(state, parsed);
    if (enclosing) {
      yield* targetedSelfLoopCandidates(state, parsed);
      yield* voronoiSelfLoopArcs(state, parsed);
      yield* loopCircles(a, [0.35, 0.6, 0.9], 4);
    }
    // Last resort: when the vertex sits in a crowded tangent space, none of the
    // above (which sweep out to radius 0.9) may clear existing geometry. Tiny
    // loops squeezed right up against the vertex are far more likely to miss
    // everything, and the physics smoothing step naturally pushes such a tight
    // loop open into free space once the move commits (see smooth.ts's
    // repulsion zones) — so they're a reasonable-looking result even though
    // they start out nearly degenerate.
    yield* loopCircles(a, [0.03, 0.06, 0.1, 0.15], 8);
  } else {
    if (!enclosing) yield geodesic(a, b);
    yield* routedCandidates(state, parsed);
    // For enclosure moves, Voronoi-boundary arcs trace the natural separation curve between the
    // enclosed components and the rest of the region — a topologically-guided candidate before
    // the generic bowed arcs.
    if (enclosing) yield* voronoiBoundaryArcs(state, parsed);
    yield* arcCandidates(a, b).slice(enclosing ? 0 : 1); // [0] is the geodesic
    yield* enclosureCandidates(state, parsed);
  }
  // Deepest fallback: route through the junction-graph Voronoi system, the only path that
  // understands topology in regions with no other boundary to bow the simpler curves around.
  if (enclosing) yield* junctionVoronoiCandidates(state, parsed);
}

/**
 * Last-resort candidates for enclosure moves (including self-loops, where lo === hi): the
 * subregion-highlight + Voronoi junction graph's route (whose own fallbacks — including the
 * plain-shortest-path case for a region with no other boundaries at all — mean this still has a
 * shot when the simpler curve attempts come back empty), then, for a self-loop, the Voronoi loop
 * arcs re-run with the junction graph's clustered extra seeds (hue -2 = bracket side = inside).
 */
function* junctionVoronoiCandidates(state: GameState, parsed: ResolvedMove): Generator<SpherePoint[]> {
  if (!parsed.brackets || parsed.brackets.length === 0) return;
  const loV = state.vertices.get(parsed.lo);
  const hiV = state.vertices.get(parsed.hi);
  if (!loV || !hiV) return;
  const highlight = buildSubregionHighlight(state, parsed.lo, parsed.hi, parsed.brackets);
  if (!highlight) return;
  const vData = buildVoronoiGraph(state, highlight, parsed.lo, parsed.hi);
  const result = computeJunctionVoronoiPath(vData, loV.pos, hiV.pos);
  if (result) yield result.pts;
  if (parsed.lo === parsed.hi && vData.extraSeeds.length > 0) {
    const extraIn = vData.extraSeeds.filter(s => s.hue === -2).map(s => s.pos);
    const extraOut = vData.extraSeeds.filter(s => s.hue !== -2).map(s => s.pos);
    yield* voronoiSelfLoopArcs(state, parsed, extraIn, extraOut);
  }
}

/**
 * Geodesic between two endpoints, plus arcs bulged to either side by a range of
 * magnitudes. The straight geodesic is tried first (typical merge); the bulges
 * let the verify loop dodge a blocking edge or pick the enclosure side.
 */
function arcCandidates(a: V3, b: V3): SpherePoint[][] {
  const out: SpherePoint[][] = [geodesic(a, b)];
  const nrm = bowNormal(a, b);
  for (const mag of [0.25, 0.5, 0.8, 1.2]) {
    out.push(bowedArc(a, b, nrm, mag));
    out.push(bowedArc(a, b, nrm, -mag));
  }
  // Long geodesic (around the back) and bowed variants at the same magnitudes.
  out.push(bowedLongArc(a, b, nrm, 0));
  for (const mag of [0.25, 0.5, 0.8, 1.2]) {
    out.push(bowedLongArc(a, b, nrm, mag));
    out.push(bowedLongArc(a, b, nrm, -mag));
  }
  return out;
}

/** Unit normal of the a-b great circle (an arbitrary one when a, b are (anti)podal). */
function bowNormal(a: V3, b: V3): V3 {
  const nrm = cross(a, b);
  return normalize(Math.hypot(nrm.x, nrm.y, nrm.z) < 1e-6 ? { x: 0, y: 0, z: 1 } : nrm);
}

/** Evenly slerp-sampled great-circle arc from a to b (inclusive endpoints). */
function geodesic(a: V3, b: V3): SpherePoint[] {
  const pts: SpherePoint[] = [];
  for (let i = 0; i < SAMPLES; i++) pts.push(slerp(a, b, i / (SAMPLES - 1)));
  return pts;
}

/** Two slerp-sampled arcs a → via → b (SAMPLES points in all). */
function throughPoint(a: V3, via: V3, b: V3): SpherePoint[] {
  const half = Math.ceil(SAMPLES / 2);
  const pts: SpherePoint[] = [];
  for (let i = 0; i < half; i++) pts.push(slerp(a, via, i / (half - 1)));
  for (let i = 1; i <= SAMPLES - half; i++) pts.push(slerp(via, b, i / (SAMPLES - half)));
  return pts;
}

/** Arc from a to b bowed toward `nrm` by `mag` (signed): through a control point lifted off the
 * great circle at the midpoint. */
function bowedArc(a: V3, b: V3, nrm: V3, mag: number): SpherePoint[] {
  return throughPoint(a, normalize(add(slerp(a, b, 0.5), scale(nrm, mag))), b);
}

/** The long way around (the major arc, through the antipode of the short arc's midpoint), bowed
 * toward `nrm` by `mag` (signed; 0 = the plain long geodesic). */
function bowedLongArc(a: V3, b: V3, nrm: V3, mag: number): SpherePoint[] {
  return throughPoint(a, normalize(add(scale(slerp(a, b, 0.5), -1), scale(nrm, mag))), b);
}

/**
 * Targeted self-loop candidates: circles at `v` whose center is aimed toward the
 * centroid of the bracket inside-vertices, at many radii. This finds the radius
 * that includes exactly the bracket set without picking up close neighbours.
 */
function targetedSelfLoopCandidates(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  if (!parsed.brackets || parsed.brackets.length === 0) return [];
  const loV = state.vertices.get(parsed.lo);
  if (!loV) return [];
  const bracketSet = new Set(parsed.brackets);

  // Inside vertex positions (same classification as voronoiSelfLoopArcs).
  const insideVids = new Set<VertexId>();
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    for (const bound of r.boundaries) {
      if (inBrackets(bound, state, bracketSet)) for (const e of bound.entries) insideVids.add(e.vertexId);
    }
  }
  insideVids.delete(parsed.lo);
  const insidePts = [...insideVids].flatMap(vid => {
    const v = state.vertices.get(vid);
    return v && !v.isPseudo ? [v.pos] : [];
  });
  if (insidePts.length === 0) return [];
  const centroid = sphereCentroid(insidePts);

  // Direction from v toward centroid (tangent component).
  const vN = normalize(loV.pos);
  const raw = add(centroid, scale(vN, -dot(centroid, vN)));
  const rawLen = Math.hypot(raw.x, raw.y, raw.z);
  if (rawLen < 1e-9) return [];
  const dir = scale(raw, 1 / rawLen);

  // Sweep many radii: small (tight around nearby vertex) to large (encompass all).
  const out: SpherePoint[][] = [];
  for (const radius of [0.1, 0.18, 0.25, 0.35, 0.45, 0.55, 0.65, 0.8, 1.0, 1.2]) {
    out.push(circleThrough(vN, normalize(add(vN, scale(dir, radius)))));
    // Opposite side (encloses everything else — rarely needed but covers edge cases).
    out.push(circleThrough(vN, normalize(add(vN, scale(dir, -radius)))));
  }
  return out;
}

/** Small circles through vertex `v`, centred `radius` away in each of `dirs` evenly spaced
 * tangent directions, for every radius. Each starts and ends exactly at the vertex. */
function loopCircles(v: V3, radii: number[], dirs: number): SpherePoint[][] {
  const vN = normalize(v);
  const { e1, e2 } = tangentFrame(vN);
  const out: SpherePoint[][] = [];
  for (const radius of radii) {
    for (let d = 0; d < dirs; d++) {
      const ang = (2 * Math.PI * d) / dirs;
      const off = add(scale(e1, Math.cos(ang) * radius), scale(e2, Math.sin(ang) * radius));
      out.push(circleThrough(vN, normalize(add(vN, off))));
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
  let t = add(hint, scale(vN, -dot(hint, vN)));
  if (Math.hypot(t.x, t.y, t.z) < 1e-9) t = tangentFrame(vN).e1; // hint ~coincident (or antipodal) with v
  const dir = normalize(t);
  const centre = normalize(add(scale(vN, Math.cos(radius)), scale(dir, Math.sin(radius))));
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
 * Strategy: in the region whose boundary holds both lo and hi (compWithBoth), centroid the
 * vertices of the bracketed sub-boundaries; bow from lo to hi toward that centroid at several
 * magnitudes, then V-lassos through a waypoint near it (deeper penetration).
 */
export function enclosureCandidates(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  if (!parsed.brackets || parsed.brackets.length === 0) return [];

  const loV = state.vertices.get(parsed.lo);
  const hiV = state.vertices.get(parsed.hi);
  if (!loV || !hiV) return [];

  const a = loV.pos;
  const b = hiV.pos;
  const bracketSet = new Set(parsed.brackets);

  // Region R: first living region whose boundary component contains both lo and hi.
  const bracketVerts: SpherePoint[] = [];
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    const comp = compWithBoth(r, parsed.lo, parsed.hi);
    if (!comp) continue;
    for (const sub of r.boundaries) {
      if (sub === comp || !inBrackets(sub, state, bracketSet)) continue;
      for (const e of sub.entries) {
        const v = state.vertices.get(e.vertexId);
        if (v && !v.isPseudo) bracketVerts.push(v.pos);
      }
    }
    break;
  }
  if (bracketVerts.length === 0) return [];

  const centroid = sphereCentroid(bracketVerts);

  // Direction perpendicular to the lo-hi great circle, snapped to point toward the centroid.
  let nrm = bowNormal(a, b);
  if (dot(centroid, nrm) < 0) nrm = scale(nrm, -1);

  const results: SpherePoint[][] = [];
  // Centroid-directed bowed arcs: larger magnitudes than arcCandidates to reach deeper into the face.
  for (const mag of [0.4, 0.8, 1.3, 1.8]) results.push(bowedArc(a, b, nrm, mag));
  // V-lasso: lo → waypoint pushed from the lo-hi midpoint toward the centroid → hi.
  const mid = slerp(a, b, 0.5);
  for (const reach of [0.5, 1.0, 1.5]) results.push(throughPoint(a, normalize(add(mid, scale(nrm, reach))), b));
  return results;
}

// ---------------------------------------------------------------------------
// New-spot clearance
// ---------------------------------------------------------------------------

/** A new spot closer than this (radians) to an existing edge or spot is drawn on top of it. */
const MID_CROWDED = 0.04;
/** Clearance a nudged stroke aims to give its new spot. */
const MID_TARGET = 0.07;

/** Nearest existing geometry to `p` — any edge, or any spot other than `ends` — as its distance
 * and the nearest point. */
function nearestObstacle(state: GameState, p: V3, ends: V3[]): { d: number; q: V3 } | null {
  let best: { d: number; q: V3 } | null = null;
  const reach2 = (2 * MID_TARGET) ** 2;
  for (const edge of state.edges.values()) {
    const pts = edge.points;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (chord2(p, pts[k]) > reach2 + 4 * chord2(pts[k], pts[k + 1])) continue; // can't be near
      const n = nearestOnArc(p, pts[k], pts[k + 1]);
      if (!best || n.d < best.d) best = { d: n.d, q: n.q };
    }
  }
  for (const v of state.vertices.values()) {
    if (ends.some(e => chord2(e, v.pos) < 1e-12)) continue;
    const d = sphereAngle(p, v.pos);
    if (!best || d < best.d) best = { d, q: v.pos };
  }
  return best;
}

/** `stroke` with its interior pushed sideways by `off` radians at the middle, tapering to 0 at
 * both ends (sin bump over arc length), along each point's left normal (cross(p, tangent)). */
function bumpStroke(stroke: V3[], off: number): V3[] {
  const cum = [0];
  for (let i = 1; i < stroke.length; i++) cum.push(cum[i - 1] + sphereAngle(stroke[i - 1], stroke[i]));
  const L = cum[cum.length - 1] || 1;
  return stroke.map((p, i) => {
    if (i === 0 || i === stroke.length - 1) return p;
    const t = normalize(add(stroke[i + 1], scale(stroke[i - 1], -1)));
    return normalize(add(p, scale(normalize(cross(p, t)), off * Math.sin(Math.PI * cum[i] / L))));
  });
}

/**
 * The stroke, preceded — when its new spot (strokeMidIndex) would sit within MID_CROWDED of an
 * existing edge or spot, e.g. a geodesic between two spots already joined by a near-geodesic edge,
 * or one passing over an intermediate spot — by copies nudged off that obstacle: first on the side
 * the spot already lies (same topology as the original, so the move it makes is unchanged), then the
 * other side (for a spot dead on the obstacle, where the side is a coin flip). A nudge is kept only
 * if it actually improves the spot's clearance; the verifier's crossing check judges the rest, and
 * the untouched stroke stays as the last resort.
 */
function* withMidClearance(state: GameState, stroke: V3[]): Generator<V3[]> {
  if (stroke.length < 3) { yield stroke; return; }
  const ends = [stroke[0], stroke[stroke.length - 1]];
  const mi = strokeMidIndex(stroke);
  if (mi === 0 || mi === stroke.length - 1) { yield stroke; return; }
  const m = stroke[mi];
  const near = nearestObstacle(state, m, ends);
  if (!near || near.d >= MID_CROWDED) { yield stroke; return; }
  // Signed offset of the spot from the obstacle along the stroke's left normal at the spot.
  const nrm = normalize(cross(m, normalize(add(stroke[mi + 1], scale(stroke[mi - 1], -1)))));
  const side = dot(add(m, scale(near.q, -1)), nrm) >= 0 ? 1 : -1;
  for (const s of [side, -side]) {
    const nudged = bumpStroke(stroke, s * (MID_TARGET - near.d * (s === side ? 1 : -1)));
    const after = nearestObstacle(state, nudged[strokeMidIndex(nudged)], ends);
    if (!after || after.d > near.d) yield nudged;
  }
  yield stroke;
}

// ---------------------------------------------------------------------------
// Crossing check
// ---------------------------------------------------------------------------

/** A stroke this close (radians) to an existing edge, away from its own end vertices, touches it. */
const STROKE_TOUCH = 1e-4;

/**
 * True if `stroke` (in sphere space) crosses or touches any existing edge — tested spherically, so it
 * is camera-independent. Segments that merely meet at a shared vertex don't count (see
 * arcsProperlyCross); every segment of the stroke is tested, end segments included — skipping them
 * hid real crossings near a vertex. A touch (the stroke running along an edge, e.g. a plain geodesic
 * between two vertices already joined by a geodesic edge) is no legal drawing either: the face
 * between them has no width, and which side anything is on is left to rounding (recreateSweep seed
 * 11 game 23: the replay's move 3 lay on edge 1–(−4) and the next frames recomputed the spots into
 * the wrong face). Pass `skipEdgeId` to exclude one edge (e.g. the edge just committed, to avoid
 * self-comparison).
 */
export function strokeCrossesEdges(state: GameState, stroke: SpherePoint[], skipEdgeId?: EdgeId): boolean {
  if (stroke.length < 2) return false;
  for (const edge of state.edges.values()) {
    if (edge.id === skipEdgeId) continue;
    if (polylinesProperlyCross(stroke, edge.points) || polylinesTouch(stroke, edge.points)) return true;
  }
  return false;
}

/** Does a point of either polyline lie within STROKE_TOUCH of the other, away from the stroke's ends
 * (where an edge sharing the end vertex legitimately meets it)? */
function polylinesTouch(stroke: SpherePoint[], edge: SpherePoint[]): boolean {
  const ends = [stroke[0], stroke[stroke.length - 1]];
  const awayFromEnds = (p: SpherePoint) => ends.every(q => sphereAngle(p, q) > 10 * STROKE_TOUCH);
  const near = (p: SpherePoint, line: SpherePoint[]) => {
    for (let k = 0; k + 1 < line.length; k++) {
      if (chord2(p, line[k]) > 4 * chord2(line[k], line[k + 1]) + 1e-6) continue; // too far to touch
      if (distanceToArc(p, line[k], line[k + 1]) < STROKE_TOUCH) return true;
    }
    return false;
  };
  return stroke.some(p => awayFromEnds(p) && near(p, edge)) || edge.some(p => awayFromEnds(p) && near(p, stroke));
}

// ---------------------------------------------------------------------------
// Voronoi-boundary arc synthesis
// ---------------------------------------------------------------------------

/** STEP-sized walking along the spherical Voronoi bisector between two seed sets. */
function voronoiBisector(insideSeeds: V3[], outsideSeeds: V3[]) {
  // Nearest-seed functions on the sphere (max dot product = min angle).
  const nearIn  = (P: V3): V3 => insideSeeds.reduce((best, s) => dot(P, s) > dot(P, best) ? s : best);
  const nearOut = (P: V3): V3 => outsideSeeds.reduce((best, s) => dot(P, s) > dot(P, best) ? s : best);
  // Snap a point onto the bisector (equidistant from the nearest inside and outside seeds) by
  // gradient descent on f(P) = P·ni − P·no.
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
  /** One step of `stepLen` along the bisector at `cur`; sign=+1 keeps the inside seeds on the left.
   *  Null where the bisector direction degenerates. */
  const step = (cur: V3, sign: 1 | -1, stepLen: number): V3 | null => {
    const ni = nearIn(cur), no = nearOut(cur);
    const cd = normalize({ x: ni.x - no.x, y: ni.y - no.y, z: ni.z - no.z }); // outside → inside
    const raw = scale(cross(cd, cur), sign); // tangent at cur, perpendicular to cd
    const tl = Math.hypot(raw.x, raw.y, raw.z);
    if (tl < 1e-9) return null;
    return snap(normalize(add(cur, scale(raw, stepLen / tl))));
  };
  return { nearIn, snap, step };
}

/** Every vertex of the boundaries in `bounds`, split by whether it's in `insideVids`. */
function splitSeeds(state: GameState, bounds: readonly { entries: { vertexId: VertexId }[] }[], insideVids: Set<VertexId>, outside: V3[]): { inside: V3[]; outside: V3[] } {
  const inside: V3[] = [];
  const seen = new Set<VertexId>();
  for (const bd of bounds) for (const e of bd.entries) {
    if (seen.has(e.vertexId)) continue;
    seen.add(e.vertexId);
    const v = state.vertices.get(e.vertexId);
    if (v) (insideVids.has(e.vertexId) ? inside : outside).push(v.pos);
  }
  return { inside, outside };
}

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
  const bracketSet = new Set(parsed.brackets);

  // Region R: the boundary that contains both lo and hi. Use the LONGEST such boundary to avoid
  // being fooled by a joint vertex that also appears on an inner sub-component.
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

  // Inside = the bracket components; lo and hi are always outside.
  const insideVids = new Set<VertexId>();
  for (const sub of regionBounds) {
    if (sub !== outerComp && inBrackets(sub, state, bracketSet)) for (const e of sub.entries) insideVids.add(e.vertexId);
  }
  if (insideVids.size === 0) return [];
  const seeds = splitSeeds(state, regionBounds, insideVids, [a, b]);
  if (seeds.inside.length === 0) return [];
  const { nearIn, snap, step } = voronoiBisector(seeds.inside, seeds.outside);

  // Entry and exit points on the boundary, approached from lo and hi respectively.
  const startB = snap(normalize(add(a, nearIn(a))));
  const endB   = snap(normalize(add(b, nearIn(b))));

  // Trace the boundary with a fixed angular step, keeping inside to one side.
  const STEP = 0.06; // ~3.4° per step
  const MAX_STEPS = 200;
  const STOP_COS = Math.cos(STEP * 2); // stop when close enough to endB
  const tracePath = (sign: 1 | -1): V3[] => {
    const path: V3[] = [startB];
    let cur = startB;
    for (let k = 0; k < MAX_STEPS; k++) {
      const next = step(cur, sign, STEP);
      if (!next) break;
      if (k > 3 && dot(next, endB) > STOP_COS) break;
      path.push(next);
      cur = next;
    }
    path.push(endB);
    return path;
  };

  // A complete arc: lo → [approach slerp] → boundary → [departure slerp] → hi.
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
 * curve that starts and ends at lo. Each boundary of the region (the outer one included) counts
 * as inside when the bracket list names it (inBrackets). `extraInsideSeeds`/`extraOutsideSeeds`
 * come from the junction graph's clustering (see junctionVoronoiCandidates).
 *
 * Returns two candidates: one tracing CW around the inside blob, one CCW.
 * The verify loop in recreate.ts picks whichever encloses the right side.
 */
function voronoiSelfLoopArcs(state: GameState, parsed: ResolvedMove, extraInsideSeeds: V3[] = [], extraOutsideSeeds: V3[] = []): SpherePoint[][] {
  if (!parsed.brackets || parsed.brackets.length === 0) return [];
  const loV = state.vertices.get(parsed.lo);
  if (!loV) return [];
  const a = loV.pos;
  const bracketSet = new Set(parsed.brackets);

  // The region whose boundary contains lo and has sub-boundaries; prefer the longest such boundary.
  let regionBounds: readonly { entries: { vertexId: VertexId }[] }[] = [];
  let bestLen = -1;
  for (const r of state.regions.values()) {
    if (r.isDead || r.boundaries.length < 2) continue;
    for (const bound of r.boundaries) {
      if (bound.entries.some(e => e.vertexId === parsed.lo) && bound.entries.length > bestLen) {
        bestLen = bound.entries.length;
        regionBounds = r.boundaries;
      }
    }
  }
  if (regionBounds.length === 0) return [];

  const insideVids = new Set<VertexId>();
  for (const bound of regionBounds) {
    if (inBrackets(bound, state, bracketSet)) for (const e of bound.entries) insideVids.add(e.vertexId);
  }
  insideVids.delete(parsed.lo); // lo is always outside (grey cell)
  if (insideVids.size === 0) return [];
  const seeds = splitSeeds(state, regionBounds, insideVids, [a]);
  seeds.inside.push(...extraInsideSeeds);
  seeds.outside.push(...extraOutsideSeeds);
  if (seeds.inside.length === 0) return [];
  const { nearIn, snap, step } = voronoiBisector(seeds.inside, seeds.outside);

  // Snap from lo toward the nearest inside seed to land on the Voronoi boundary.
  const startB = snap(normalize(add(a, nearIn(a))));

  const STEP = 0.06;
  const MAX_STEPS = 300;
  const CLOSE_COS = Math.cos(STEP * 2);
  const stepB = (cur: V3, sign: 1 | -1): V3 => step(cur, sign, STEP) ?? cur;

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
    for (let k = 0; k < MAX_STEPS; k++) {
      const next = stepB(cur, sign);
      path.push(next);
      cur = next;
      if (k > 15 && dot(next, entryPt) > CLOSE_COS) break;
    }
    return path;
  };

  // A full stroke: a → exitPt → [trace] → entryPt → a.
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
