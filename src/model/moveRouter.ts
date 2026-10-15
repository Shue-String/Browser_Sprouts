/**
 * Topological move router: draws a stroke for a move whose combinatorial effect is fully
 * specified (which face, which corner at each endpoint, which of the face's other boundaries end
 * up on which side), correct by construction rather than guessed and filtered.
 *
 * Method — the Voronoi-cell-edge idea, made side-aware:
 *  1. Seeds are sampled along every dart of the face's boundary walks, offset a little INTO the
 *     face (to the left of the dart), plus small arcs around each corner and rings around spots.
 *     Because each side of an edge gets its own seed row, the two sides of a bridge edge, or the
 *     two visits to a joint, are distinct seeds — the thing a vertex-only Voronoi can't express.
 *  2. A spherical Delaunay mesh of the seeds (refined with circumcenters in open space) is cut
 *     down to the triangles lying inside the face: none of their edges cross a wall and none
 *     contains a wall point.
 *  3. Each seed is labeled by the side it must end up on (IN = the a→c arc of the move's
 *     boundary plus the boundaries assigned to it; OUT = everything else); interior points take
 *     the label of the nearest seed through the mesh. The IN/OUT frontier is the bisector between
 *     the two sides — the stroke.
 *  4. If either side's labels are disconnected (a hole whose nearest neighbours are on the other
 *     side, or vice versa), a corridor of interior points is relabeled to join it up — which
 *     is what makes the frontier a single arc from one endpoint to the other.
 *  5. The frontier is traced through the mesh (marching triangles) from the mixed corner chord at
 *     one endpoint to the one at the other.
 * Joins (endpoints on two different boundaries) don't partition anything: they're a clearance-
 * weighted shortest path through the same mesh.
 */
import type { GameState, Region, VertexId } from './types';
import type { SpherePoint } from '../math/sphere';
import { normalize, slerp, arcsCross, dot, cross, sphereAngle as ang, fibonacciSphere, resamplePolyline } from '../math/sphere';
import { sphericalDelaunay } from '../math/sphereDelaunay';
import { UnionFind } from '../math/unionFind';
import { edgePtsForEntry, bearingFrom, pointAtBearing, boundarySphereLoop, loopsNearestFeature } from './moves';
import { distanceToArc } from './smoothGeometry';
import type { ResolvedMove } from './moveCodeParse';

type V3 = SpherePoint;
const TAU = Math.PI * 2;
const mod = (x: number, m: number): number => ((x % m) + m) % m;

/** Offset distance bounds (radians) and the longest wall sub-segment kept in the index. */
const DELTA_MIN = 0.003;
const DELTA_MAX = 0.03;
const SEG_MAX = 0.04;
/** Spacing of the open-space lattice points added to the face mesh. */
const LATTICE = 0.08;
/** Seeds closer than this are merged (the hull's visibility epsilon can't separate them). */
const MIN_SEED_GAP = 2e-4;

/** A boundary corner: region.boundaries[b].entries[k]. */
export interface Corner { b: number; k: number }

export type RouteSpec =
  /** a and c on the same boundary (a === c for a self-loop). `withArc` = indices of the face's
   *  OTHER boundaries that end up on the same side as the forward walk a→c (for a self-loop:
   *  inside the loop). */
  | { kind: 'split'; a: Corner; c: Corner; withArc: ReadonlySet<number> }
  /** a and c on different boundaries — fuses them, partitions nothing. */
  | { kind: 'join'; a: Corner; c: Corner };

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

class SphereGrid<T> {
  private cells = new Map<number, T[]>();
  constructor(private readonly h: number) {}
  private idx(c: number): number { return Math.floor((c + 1.5) / this.h); }
  private key(ix: number, iy: number, iz: number): number { return (ix * 4096 + iy) * 4096 + iz; }
  insert(p: V3, item: T): void {
    const k = this.key(this.idx(p.x), this.idx(p.y), this.idx(p.z));
    let cell = this.cells.get(k);
    if (!cell) { cell = []; this.cells.set(k, cell); }
    cell.push(item);
  }
  /** Calls fn for every item whose insertion point is within chord distance ~r of p (superset). */
  query(p: V3, r: number, fn: (item: T) => void): void {
    const x0 = this.idx(p.x - r), x1 = this.idx(p.x + r);
    const y0 = this.idx(p.y - r), y1 = this.idx(p.y + r);
    const z0 = this.idx(p.z - r), z1 = this.idx(p.z + r);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > this.cells.size) {
      // Big query box: walking the occupied cells is cheaper than probing empty ones.
      for (const cell of this.cells.values()) for (const it of cell) fn(it);
      return;
    }
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) {
          const cell = this.cells.get(this.key(ix, iy, iz));
          if (cell) for (const it of cell) fn(it);
        }
  }
}

interface Wall { a: V3; b: V3; edgeId: number }


/** Every wall of a face: its boundary darts' polylines, split into short indexed segments. */
class WallIndex {
  readonly walls: Wall[] = [];
  private segGrid = new SphereGrid<Wall>(0.06);
  private ptGrid = new SphereGrid<V3>(0.06);

  addPolyline(pts: V3[], edgeId: number): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const pieces = Math.max(1, Math.ceil(ang(a, b) / SEG_MAX));
      let prev = a;
      for (let s = 1; s <= pieces; s++) {
        const next = s === pieces ? b : slerp(a, b, s / pieces);
        this.addSeg(prev, next, edgeId);
        prev = next;
      }
    }
    for (const p of pts) this.ptGrid.insert(p, p);
  }
  addPoint(p: V3): void {
    this.addSeg(p, p, -1);
    this.ptGrid.insert(p, p);
  }
  private addSeg(a: V3, b: V3, edgeId: number): void {
    const w = { a, b, edgeId };
    this.walls.push(w);
    this.segGrid.insert(normalize({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }), w);
  }

  /** Nearest wall distance from p within `r` (Infinity if none), optionally skipping walls. */
  clearance(p: V3, r: number, skip?: (w: Wall) => boolean): number {
    let best = Infinity;
    this.segGrid.query(p, r + SEG_MAX, w => {
      if (skip && skip(w)) return;
      const d = distanceToArc(p, w.a, w.b);
      if (d < best) best = d;
    });
    return best;
  }

  /** True if the great-circle segment u-v crosses any wall (optionally skipping some). */
  crosses(u: V3, v: V3, skip?: (w: Wall) => boolean): boolean {
    const mid = normalize({ x: u.x + v.x, y: u.y + v.y, z: u.z + v.z });
    let hit = false;
    this.segGrid.query(mid, ang(u, v) / 2 + SEG_MAX, w => {
      if (hit || (skip && skip(w)) || w.a === w.b) return;
      if (arcsCross(u, v, w.a, w.b)) hit = true;
    });
    return hit;
  }

  /** True if some wall point lies strictly inside the CCW spherical triangle a,b,c. */
  triangleHasPoint(a: V3, b: V3, c: V3, center: V3, radius: number): boolean {
    const nab = cross(a, b), nbc = cross(b, c), nca = cross(c, a);
    let hit = false;
    this.ptGrid.query(center, radius + 1e-9, p => {
      if (hit) return;
      if (dot(nab, p) > 1e-12 && dot(nbc, p) > 1e-12 && dot(nca, p) > 1e-12) hit = true;
    });
    return hit;
  }
}

// ---------------------------------------------------------------------------
// Face mesh
// ---------------------------------------------------------------------------

/** Where a seed came from — enough to label it for any RouteSpec on the same face. */
type SeedTag =
  | { kind: 'dart'; b: number; k: number }
  | { kind: 'corner'; b: number; k: number; t: number }; // t in (0,1) along the corner's CCW sweep

interface CornerInfo { b: number; k: number; vertexId: VertexId; pos: V3 }

/**
 * A triangulated approximation of one face's interior. Built once per face and reused for every
 * RouteSpec on it (labels are the only per-spec state).
 */
export class FaceMesh {
  pts: V3[] = [];
  /** Seed tag per point; null for free interior points. */
  tags: (SeedTag | null)[] = [];
  /** Offset used at this point (seeds) / wall clearance (interior points). */
  clr: number[] = [];
  tris: [number, number, number][] = [];
  /** Undirected mesh-edge key (min*N+max) -> triangles using it. */
  edgeTris = new Map<number, number[]>();
  nbrs: number[][] = [];
  corners: CornerInfo[] = [];
  ok = false;

  constructor(readonly state: GameState, readonly region: Region, readonly walls: WallIndex) {}

  ekey(u: number, v: number): number { return u < v ? u * this.pts.length + v : v * this.pts.length + u; }
}

/**
 * Walls with an endpoint at `u`. Two edges meeting at a vertex share it only to rounding (their end
 * points can differ in the last bit), and ang() = acos(dot) turns that into ~2e-8 — so the match
 * must be looser than that, or a joint's corner sees its own incident edges as foreign walls.
 */
function wallsAt(u: V3): (w: Wall) => boolean {
  return w => ang(w.a, u) < 1e-6 || ang(w.b, u) < 1e-6;
}

/** First point along `poly` (from its start) at least `minDist` from poly[0], else the last. */
function pointAway(poly: V3[], minDist: number): V3 {
  for (let i = 1; i < poly.length; i++) if (ang(poly[0], poly[i]) >= minDist) return poly[i];
  return poly[poly.length - 1];
}

/** Dart polylines (from entry k's vertex to entry k+1's) of one boundary walk. */
function dartPolylines(state: GameState, entries: Region['boundaries'][number]['entries']): (V3[] | null)[] {
  return entries.map(en => {
    const edge = en.edgeId !== undefined ? state.edges.get(en.edgeId) : undefined;
    return edge ? edgePtsForEntry(en, edge) : null;
  });
}

export function buildFaceMesh(state: GameState, region: Region): FaceMesh {
  const walls = new WallIndex();
  const mesh = new FaceMesh(state, region, walls);

  // --- Walls -------------------------------------------------------------------------------
  const darts: (V3[] | null)[][] = region.boundaries.map(bd => dartPolylines(state, bd.entries));
  region.boundaries.forEach((bd, b) => {
    if (bd.entries.length === 1 && !darts[b][0]) {
      const v = state.vertices.get(bd.entries[0].vertexId);
      if (v) walls.addPoint(v.pos);
      return;
    }
    // Every dart's polyline (a bridge edge's two darts add the same wall twice — harmless).
    bd.entries.forEach((en, k) => {
      const poly = darts[b][k];
      if (poly && en.edgeId !== undefined) walls.addPolyline(poly, en.edgeId);
    });
  });

  // Any corner at a vertex with free valence can be a move endpoint: give it a full arc (enough
  // seeds to split into IN/OUT/IN), so one mesh serves every move in this face.
  const canMoveAt = (b: number, k: number): boolean => {
    const v = state.vertices.get(region.boundaries[b].entries[k].vertexId);
    return !!v && !v.isPseudo && v.degree <= 2;
  };
  const seeds: { p: V3; tag: SeedTag; clr: number }[] = [];
  const deltaAt = (gap: number): number => Math.max(DELTA_MIN, Math.min(DELTA_MAX, 0.3 * gap));
  // Corner arcs stay tight: they must be the first seeds met leaving the vertex, inside the
  // stretch where the incident darts' rows are suppressed (see cornerR below).
  const cornerRadius = (gap: number): number => Math.max(DELTA_MIN, Math.min(2 * DELTA_MIN, 0.3 * gap));

  // --- Seeds ---------------------------------------------------------------------------------
  region.boundaries.forEach((bd, b) => {
    const n = bd.entries.length;
    if (n === 1 && !darts[b][0]) {
      // Isolated spot: a full ring.
      const v = state.vertices.get(bd.entries[0].vertexId);
      if (!v) return;
      const u = v.pos;
      const gap = walls.clearance(u, 0.2, w => w.a === u && w.b === u);
      const rho = cornerRadius(gap);
      const J = 12;
      for (let j = 0; j < J; j++) {
        const t = (j + 0.5) / J;
        seeds.push({ p: pointAtBearing(u, t * TAU, rho), tag: { kind: 'corner', b, k: 0, t }, clr: rho });
      }
      mesh.corners.push({ b, k: 0, vertexId: v.id, pos: u });
      return;
    }
    // Per-corner arc geometry first: each dart row needs the radii at both of its ends.
    const cornerR: number[] = [];
    const cornerGeo: ({ u: V3; bOut: number; sweep: number; J: number; isSpecial: boolean } | null)[] = [];
    for (let k = 0; k < n; k++) {
      const out = darts[b][k];
      const inc = darts[b][(k + n - 1) % n];
      if (!out || !inc) { cornerR.push(0); cornerGeo.push(null); continue; }
      const u = out[0];
      const touchesU = wallsAt(u);
      const rho = cornerRadius(walls.clearance(u, 0.2, touchesU));
      const bOut = bearingFrom(u, pointAway(out, rho * 0.5));
      const bIn = bearingFrom(u, pointAway([...inc].reverse(), rho * 0.5));
      let sweep = mod(bIn - bOut, TAU);
      if (sweep < 1e-9) sweep = TAU;
      const isSpecial = canMoveAt(b, k);
      const J = Math.max(isSpecial ? 6 : 1, Math.ceil(sweep / 0.5));
      // A move endpoint's arc must keep all J seeds distinguishable even in a thin wedge.
      cornerR.push(isSpecial ? Math.min(DELTA_MAX, Math.max(rho, (4 * MIN_SEED_GAP * J) / sweep)) : rho);
      cornerGeo.push({ u, bOut, sweep, J, isSpecial });
    }
    for (let k = 0; k < n; k++) {
      const out = darts[b][k];
      const geo = cornerGeo[k];
      if (!out || !geo) continue;
      const { u, bOut, sweep, J, isSpecial } = geo;
      const r = cornerR[k];
      const touchesU = wallsAt(u);

      // Corner arc: CCW sweep from the outgoing stub to the incoming stub.
      for (let j = 0; j < J; j++) {
        const t = (j + 0.5) / J;
        const p = pointAtBearing(u, bOut + t * sweep, r);
        if (!isSpecial && walls.clearance(p, r, touchesU) < 0.5 * r) continue;
        if (walls.crosses(u, p, touchesU)) continue;
        seeds.push({ p, tag: { kind: 'corner', b, k, t }, clr: r });
      }
      const vid = bd.entries[k].vertexId;
      if (!state.vertices.get(vid)?.isPseudo) mesh.corners.push({ b, k, vertexId: vid, pos: u });

      // Dart row: offset to the left of out, adaptive spacing.
      const edgeId = bd.entries[k].edgeId!;
      const notOwn = (w: Wall): boolean => w.edgeId === edgeId;
      const cum: number[] = [0];
      for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + ang(out[i - 1], out[i]));
      const L = cum[cum.length - 1];
      const uEnd = out[out.length - 1];
      const rEnd = cornerR[(k + 1) % n];
      let s = 0;
      let seg = 0;
      while (true) {
        // Sample position at arc length s (skip the first/last bit: corner arcs cover those).
        const q0 = s;
        if (q0 > L) break;
        while (seg < out.length - 2 && cum[seg + 1] < q0) seg++;
        const sl = cum[seg + 1] - cum[seg];
        const q = sl < 1e-12 ? out[seg] : slerp(out[seg], out[seg + 1], (q0 - cum[seg]) / sl);
        const tdir = { x: out[seg + 1].x - out[seg].x, y: out[seg + 1].y - out[seg].y, z: out[seg + 1].z - out[seg].z };
        const gap = walls.clearance(q, 0.2, notOwn);
        const delta = deltaAt(gap);
        const step = Math.max(0.004, Math.min(0.04, 1.3 * delta));
        if (s > 0 && L - s > 0.25 * step) {
          const nl = cross(q, tdir);
          const nlen = Math.hypot(nl.x, nl.y, nl.z);
          if (nlen > 1e-12) {
            const p = normalize({ x: q.x + delta * nl.x / nlen, y: q.y + delta * nl.y / nlen, z: q.z + delta * nl.z / nlen });
            const clearOfCorners = ang(p, u) > 1.3 * r && ang(p, uEnd) > 1.3 * rEnd;
            if (clearOfCorners && walls.clearance(p, delta, notOwn) >= 0.5 * delta && !walls.crosses(q, p, notOwn)) {
              seeds.push({ p, tag: { kind: 'dart', b, k }, clr: delta });
            }
          }
        }
        s += step;
      }
    }
  });

  // Dedupe near-coincident seeds (converging rows), keeping the first.
  const seedGrid = new SphereGrid<V3>(0.02);
  for (const sd of seeds) {
    let dup = false;
    seedGrid.query(sd.p, 1e-3, q => { if (!dup && ang(q, sd.p) < MIN_SEED_GAP) dup = true; });
    if (dup) continue;
    seedGrid.insert(sd.p, sd.p);
    mesh.pts.push(sd.p);
    mesh.tags.push(sd.tag);
    mesh.clr.push(sd.clr);
  }
  if (mesh.pts.length < 4) return mesh;

  // --- Mesh: triangulate, keep in-face triangles, refine open space ---------------------------
  const crossCache = new Map<number, boolean>();
  const edgeCrosses = (i: number, j: number): boolean => {
    const key = i < j ? i * 1e6 + j : j * 1e6 + i;
    let c = crossCache.get(key);
    if (c === undefined) { c = walls.crosses(mesh.pts[i], mesh.pts[j]); crossCache.set(key, c); }
    return c;
  };
  const sameCorner = (a: number, b: number, c: number): boolean => {
    const ta = mesh.tags[a], tb = mesh.tags[b], tc = mesh.tags[c];
    return !!ta && !!tb && !!tc && ta.kind === 'corner' && tb.kind === 'corner' && tc.kind === 'corner'
      && ta.b === tb.b && ta.b === tc.b && ta.k === tb.k && ta.k === tc.k;
  };
  const triangulate = (): { tri: [number, number, number]; center: V3; radius: number }[] => {
    const { tris, centers } = sphericalDelaunay(jittered(mesh.pts));
    const kept: { tri: [number, number, number]; center: V3; radius: number }[] = [];
    for (let t = 0; t < tris.length; t++) {
      const [a, b, c] = tris[t];
      if (sameCorner(a, b, c)) continue; // the pocket between a corner arc and its vertex
      if (edgeCrosses(a, b) || edgeCrosses(b, c) || edgeCrosses(c, a)) continue;
      const radius = ang(centers[t], mesh.pts[a]);
      if (walls.triangleHasPoint(mesh.pts[a], mesh.pts[b], mesh.pts[c], centers[t], radius)) continue;
      kept.push({ tri: tris[t], center: centers[t], radius });
    }
    return kept;
  };
  const addFree = (p: V3, clr: number): void => {
    mesh.pts.push(p);
    mesh.tags.push(null);
    mesh.clr.push(clr);
  };

  // Pass 1 (seeds only): the circumcenters of in-face triangles are the Voronoi vertices of the
  // seeds — samples of the face's medial axis, exactly where routes want to run.
  const added = new SphereGrid<V3>(0.05);
  const farFrom = (p: V3, spacing: number): boolean => {
    let close = false;
    added.query(p, spacing, q => { if (!close && ang(q, p) < spacing) close = true; });
    return !close;
  };
  for (const k of triangulate()) {
    const [a, b, c] = k.tri;
    const pa = mesh.pts[a], pb = mesh.pts[b], pc = mesh.pts[c];
    const cen = normalize({ x: pa.x + pb.x + pc.x, y: pa.y + pb.y + pc.y, z: pa.z + pb.z + pc.z });
    const p = k.center;
    const clr = walls.clearance(p, Math.max(0.05, k.radius));
    if (clr < 1.5 * DELTA_MIN || clr < 0.5 * Math.min(mesh.clr[a], mesh.clr[b], mesh.clr[c])) continue;
    if (walls.crosses(cen, p)) continue; // reachable from inside the triangle => inside the face
    const spacing = Math.max(0.5 * Math.min(clr, k.radius, LATTICE), DELTA_MIN);
    if (!farFrom(p, spacing)) continue;
    added.insert(p, p);
    addFree(p, clr);
  }
  // Open space: a uniform lattice, admitted by the sphere-native face test.
  const loops = region.boundaries.map(bd => boundarySphereLoop(bd.entries, state));
  const onlySpots = loops.every(l => l.length < 2);
  for (const p of fibonacciSphere(Math.round((4 * Math.PI) / (LATTICE * LATTICE)))) {
    const clr = walls.clearance(p, LATTICE);
    if (clr < 0.5 * LATTICE) continue;
    if (!farFrom(p, 0.5 * LATTICE)) continue;
    if (!onlySpots && !loopsNearestFeature(loops, p).inside) continue;
    added.insert(p, p);
    addFree(p, clr);
  }

  // Pass 2: the final mesh, minus any piece not connected to a seed (stray in-face pockets).
  const kept = triangulate();
  const N = mesh.pts.length;
  const uf = new UnionFind<number>();
  for (const { tri: [a, b, c] } of kept) { uf.union(a, b); uf.union(b, c); }
  const seeded = new Set<number>();
  for (let i = 0; i < N; i++) if (mesh.tags[i]) seeded.add(uf.find(i));

  mesh.tris = kept.filter(k => seeded.has(uf.find(k.tri[0]))).map(k => k.tri);
  mesh.nbrs = mesh.pts.map(() => []);
  const seen = new Set<number>();
  mesh.tris.forEach((tri, t) => {
    for (let e = 0; e < 3; e++) {
      const u = tri[e], v = tri[(e + 1) % 3];
      const key = mesh.ekey(u, v);
      let lst = mesh.edgeTris.get(key);
      if (!lst) { lst = []; mesh.edgeTris.set(key, lst); }
      lst.push(t);
      if (!seen.has(key)) { seen.add(key); mesh.nbrs[u].push(v); mesh.nbrs[v].push(u); }
    }
  });
  mesh.ok = true;
  return mesh;
}

/**
 * Deterministic perturbation (well below MIN_SEED_GAP) so exactly co-circular seed sets — a row
 * offset from a straight edge lies on one small circle — sit clearly off the hull's epsilon.
 */
function jittered(pts: V3[]): V3[] {
  let s = 12345;
  const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  return pts.map(p => normalize({ x: p.x + 2e-6 * rnd(), y: p.y + 2e-6 * rnd(), z: p.z + 2e-6 * rnd() }));
}

// ---------------------------------------------------------------------------
// Labels, topology repair, frontier tracing
// ---------------------------------------------------------------------------

const IN = 1, OUT = 0;

function seedLabel(tag: SeedTag, spec: Extract<RouteSpec, { kind: 'split' }>, region: Region): number {
  const b0 = spec.a.b;
  if (tag.b !== b0) return spec.withArc.has(tag.b) ? IN : OUT;
  const n = region.boundaries[b0].entries.length;
  const ka = spec.a.k, kc = spec.c.k;
  if (ka === kc) {
    // Self-loop: only the middle of the departure corner is inside.
    return tag.kind === 'corner' && tag.k === ka && tag.t >= 1 / 3 && tag.t < 2 / 3 ? IN : OUT;
  }
  const along = mod(tag.k - ka, n);       // steps forward from a
  const arcLen = mod(kc - ka, n);         // darts ka..kc-1 are the a→c arc
  if (tag.kind === 'dart') return along < arcLen ? IN : OUT;
  if (tag.k === ka) return tag.t < 0.5 ? IN : OUT;  // sweep starts at the (IN) outgoing dart
  if (tag.k === kc) return tag.t < 0.5 ? OUT : IN;  // ...and here the outgoing dart is OUT
  return along > 0 && along < arcLen ? IN : OUT;
}

/** Multi-source Dijkstra over the mesh. Returns per-point distance and nearest-source index. */
function dijkstra(
  mesh: FaceMesh,
  sources: number[],
  passable: (v: number) => boolean,
  weight: (u: number, v: number) => number,
): { dist: Float64Array; from: Int32Array; prev: Int32Array } {
  const N = mesh.pts.length;
  const dist = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  const heap: [number, number][] = [];
  const push = (d: number, v: number): void => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of sources) { dist[s] = 0; from[s] = s; push(0, s); }
  while (heap.length > 0) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    for (const v of mesh.nbrs[u]) {
      if (!passable(v)) continue;
      const nd = d + weight(u, v);
      if (nd < dist[v]) { dist[v] = nd; from[v] = from[u]; prev[v] = u; push(nd, v); }
    }
  }
  return { dist, from, prev };
}

/** Connected components of the points with label X (mesh edges between equal labels). */
function components(mesh: FaceMesh, label: Int8Array, X: number): Int32Array {
  const comp = new Int32Array(mesh.pts.length).fill(-1);
  let c = 0;
  for (let s = 0; s < mesh.pts.length; s++) {
    if (label[s] !== X || comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = c;
    while (stack.length > 0) {
      const u = stack.pop()!;
      for (const v of mesh.nbrs[u]) if (label[v] === X && comp[v] < 0) { comp[v] = c; stack.push(v); }
    }
    c++;
  }
  return comp;
}

/** Optional out-param for debugging tools (src/dev): the final labels and why a route failed. */
export interface RouteDiag { label?: Int8Array; failure?: string; trace?: V3[] }

function routeSplit(mesh: FaceMesh, spec: Extract<RouteSpec, { kind: 'split' }>, diag?: RouteDiag): V3[] | null {
  const fail = (why: string): null => { if (diag) diag.failure = why; return null; };
  const N = mesh.pts.length;
  const label = new Int8Array(N).fill(-1);
  const fixed: number[] = [];
  for (let i = 0; i < N; i++) {
    const tag = mesh.tags[i];
    // A seed whose triangles were all cut (e.g. pinched against a wall) isn't in the mesh at all.
    if (tag && mesh.nbrs[i].length > 0) { label[i] = seedLabel(tag, spec, mesh.region); fixed.push(i); }
  }
  const seedLabelOf = (i: number): number => seedLabel(mesh.tags[i]!, spec, mesh.region);
  const len = (u: number, v: number): number => ang(mesh.pts[u], mesh.pts[v]);
  const { near, clearance } = seedClearance(mesh, fixed);
  for (let i = 0; i < N; i++) {
    if (label[i] < 0 && near.from[i] >= 0) label[i] = label[near.from[i]]; // unreachable stays -1
  }

  // Anchors: the departure corner's IN part and its OUT part always exist (6+ arc seeds).
  const isA = (i: number): boolean => isCornerSeed(mesh, i, spec.a);
  const anchor = [-1, -1];
  for (let i = 0; i < N; i++) if (isA(i) && label[i] >= 0 && anchor[label[i]] < 0) anchor[label[i]] = i;
  if (diag) diag.label = label;
  if (anchor[IN] < 0 || anchor[OUT] < 0) return fail('departure corner lacks IN or OUT seeds');

  // Topology repair: each side must be one connected piece, every piece anchored by seeds.
  for (let iter = 0; iter < 200; iter++) {
    let changed = false;
    for (const X of [IN, OUT]) {
      const comp = components(mesh, label, X);
      const hasSeed = new Set<number>();
      for (const i of fixed) if (label[i] === X) hasSeed.add(comp[i]);
      for (let i = 0; i < N; i++) {
        if (label[i] === X && !hasSeed.has(comp[i])) { label[i] = 1 - X; changed = true; }
      }
    }
    if (changed) continue;
    for (const X of [IN, OUT]) {
      const comp = components(mesh, label, X);
      const main = comp[anchor[X]];
      let stray = -1;
      for (const i of fixed) if (label[i] === X && comp[i] !== main) { stray = comp[i]; break; }
      if (stray < 0) continue;
      // Corridor: cheapest run of free other-side points from the stray piece to any other
      // X piece, favouring clearance (the middle of the gap) so it doesn't pinch a seed row.
      const srcs: number[] = [];
      for (let i = 0; i < N; i++) if (comp[i] === stray) srcs.push(i);
      const res = dijkstra(
        mesh, srcs,
        v => (label[v] === X ? comp[v] !== stray : !mesh.tags[v]),
        (u, v) => len(u, v) / Math.max(clearance(v), DELTA_MIN),
      );
      let best = -1;
      for (let i = 0; i < N; i++) {
        if (label[i] === X && comp[i] !== stray && res.dist[i] < Infinity && (best < 0 || res.dist[i] < res.dist[best])) best = i;
      }
      if (best < 0) {
        if (!diag) return null;
        const pieces = new Map<number, { n: number; tags: Set<string> }>();
        for (let i = 0; i < N; i++) {
          if (label[i] !== X) continue;
          const pc = pieces.get(comp[i]) ?? pieces.set(comp[i], { n: 0, tags: new Set() }).get(comp[i])!;
          pc.n++;
          const t = mesh.tags[i];
          if (t) pc.tags.add(`${t.kind[0]}${t.b}.${t.k}`);
        }
        return fail(`no corridor joins a stray ${X === IN ? 'IN' : 'OUT'} piece; pieces: ` +
          [...pieces.entries()].map(([c, pc]) => `${c === main ? 'MAIN' : c === stray ? 'STRAY' : 'other'}:${pc.n}[${[...pc.tags].join(' ')}]`).join('  '));
      }
      for (let v = res.prev[best]; v >= 0 && comp[v] !== stray; v = res.prev[v]) label[v] = X;
      changed = true;
      break;
    }
    if (!changed) break;
  }

  // Frontier tracing.
  const mixedBoundary: number[][] = []; // [u, v, tri]
  for (const [key, ts] of mesh.edgeTris) {
    if (ts.length !== 1) continue;
    const u = Math.floor(key / N), v = key % N;
    if (label[u] !== label[v]) mixedBoundary.push([u, v, ts[0]]);
  }
  const loPos = cornerPos(mesh, spec.a), hiPos = cornerPos(mesh, spec.c);
  if (!loPos || !hiPos) return fail('endpoint corner missing');
  // Frontier points sit where the signed field dIN - dOUT (from the seeds' own labels, i.e.
  // before corridor repair) crosses zero along each mixed edge — a smooth bisector instead of
  // edge midpoints that zigzag through the triangles. Where repair flipped a label against the
  // field there is no crossing; fall back to the midpoint.
  const dIn = dijkstra(mesh, fixed.filter(i => seedLabelOf(i) === IN), () => true, len).dist;
  const dOut = dijkstra(mesh, fixed.filter(i => seedLabelOf(i) === OUT), () => true, len).dist;
  const midOf = (u: number, v: number): V3 => {
    const fu = dIn[u] - dOut[u], fv = dIn[v] - dOut[v];
    const t = fu * fv < 0 && Number.isFinite(fu) && Number.isFinite(fv) ? Math.min(0.85, Math.max(0.15, fu / (fu - fv))) : 0.5;
    return slerp(mesh.pts[u], mesh.pts[v], t);
  };
  const startCands = mixedBoundary.filter(([u, v]) => isA(u) && isA(v));
  if (startCands.length === 0) return fail(`no mixed boundary chord at the departure corner (${mixedBoundary.length} mixed boundary edges)`);
  const isC = (i: number): boolean => isCornerSeed(mesh, i, spec.c);

  for (const [su, sv, st] of startCands) {
    const path: V3[] = [loPos, midOf(su, sv)];
    let cu = su, cv = sv, tri = st;
    let done = false;
    for (let guard = 0; guard < 4 * mesh.tris.length + 10; guard++) {
      const [a, b, c] = mesh.tris[tri];
      const edges: [number, number][] = [[a, b], [b, c], [c, a]];
      const exit = edges.find(([x, y]) => label[x] !== label[y] && mesh.ekey(x, y) !== mesh.ekey(cu, cv));
      if (!exit) break;
      [cu, cv] = exit;
      path.push(midOf(cu, cv));
      const ts = mesh.edgeTris.get(mesh.ekey(cu, cv))!;
      if (ts.length === 1) {
        // Mixed chords on the mesh boundary only occur where labels switch along the boundary
        // walk — at the two move corners — so arriving at one touching the arrival corner (one
        // end may be a dart-row seed beside the arc) is arriving there.
        const atC = isC(cu) || isC(cv) || ang(midOf(cu, cv), hiPos) < 4 * DELTA_MAX;
        done = atC && mesh.ekey(cu, cv) !== mesh.ekey(su, sv);
        break;
      }
      tri = ts[0] === tri ? ts[1] : ts[0];
    }
    if (done) {
      path.push(hiPos);
      return path;
    }
    if (diag) diag.trace = path;
  }
  return fail(`frontier from the departure corner doesn't reach the arrival corner (${mixedBoundary.length} mixed boundary edges)`);
}

/** Is mesh point i one of corner c's arc seeds? */
function isCornerSeed(mesh: FaceMesh, i: number, c: Corner): boolean {
  const t = mesh.tags[i];
  return !!t && t.kind === 'corner' && t.b === c.b && t.k === c.k;
}

/** The vertex position of corner c. */
function cornerPos(mesh: FaceMesh, c: Corner): V3 | undefined {
  return mesh.corners.find(k => k.b === c.b && k.k === c.k)?.pos;
}

/** Distance to the nearest seed through the mesh, and the clearance it implies at each point (a
 * seed keeps its own offset; a free point at least its wall clearance). */
function seedClearance(mesh: FaceMesh, seeds: number[]): { near: ReturnType<typeof dijkstra>; clearance: (v: number) => number } {
  const near = dijkstra(mesh, seeds, () => true, (u, v) => ang(mesh.pts[u], mesh.pts[v]));
  return { near, clearance: v => (mesh.tags[v] ? mesh.clr[v] : Math.max(mesh.clr[v], near.dist[v])) };
}

function routeJoin(mesh: FaceMesh, spec: Extract<RouteSpec, { kind: 'join' }>): V3[] | null {
  const N = mesh.pts.length;
  const srcs: number[] = [];
  for (let i = 0; i < N; i++) if (isCornerSeed(mesh, i, spec.a)) srcs.push(i);
  if (srcs.length === 0) return null;
  const fixed: number[] = [];
  for (let i = 0; i < N; i++) if (mesh.tags[i]) fixed.push(i);
  const { clearance } = seedClearance(mesh, fixed);
  const res = dijkstra(mesh, srcs, () => true, (u, v) => ang(mesh.pts[u], mesh.pts[v]) / Math.max(clearance(v), DELTA_MIN));
  let best = -1;
  for (let i = 0; i < N; i++) if (isCornerSeed(mesh, i, spec.c) && res.dist[i] < Infinity && (best < 0 || res.dist[i] < res.dist[best])) best = i;
  if (best < 0) return null;
  const chain: V3[] = [];
  for (let v = best; v >= 0; v = res.prev[v]) chain.push(mesh.pts[v]);
  chain.reverse();
  const loPos = cornerPos(mesh, spec.a), hiPos = cornerPos(mesh, spec.c);
  if (!loPos || !hiPos) return null;
  return [loPos, ...chain, hiPos];
}

/** Subdivide long segments (same geometry: great-circle pieces) so the stroke is drawn-like. */
function densify(path: V3[], maxStep = 0.02): V3[] {
  const out: V3[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const pieces = Math.max(1, Math.ceil(ang(a, b) / maxStep));
    for (let s = 1; s <= pieces; s++) out.push(s === pieces ? b : slerp(a, b, s / pieces));
  }
  return out;
}


/**
 * Smooth a routed polyline without changing its topology. The route's interior (everything but
 * the endpoint and the first point out of each endpoint's wedge) is resampled coarsely, so
 * relaxation acts at the scale of the wiggles rather than of the sample spacing; a point may only
 * move if neither new segment crosses a wall, the triangles it sweeps hold no wall point, and it
 * doesn't end up closer to a wall than it was (or than half its raw clearance capped at
 * KEEP_CLEAR_MAX, whichever is smaller).
 */
const KEEP_CLEAR_RANGE = 0.3; // walls farther than this don't constrain smoothPath
const KEEP_CLEAR_SHARE = 0.5; // fraction of its raw clearance a smoothed point must keep
const KEEP_CLEAR_MAX = 0.1;   // ...capped, so open space doesn't hold the route off its walls

function smoothPath(walls: WallIndex, raw: V3[]): V3[] {
  if (raw.length < 5) return raw;
  const inner = raw.slice(1, raw.length - 1);
  let L = 0;
  for (let i = 1; i < inner.length; i++) L += ang(inner[i - 1], inner[i]);
  const count = Math.max(3, Math.min(80, Math.ceil(L / 0.03) + 1));
  const p = [raw[0], ...resamplePolyline(inner, count), raw[raw.length - 1]];
  // Taut-string relaxation hugs any obstacle it wraps (a lone spot ended up half a pixel off the
  // stroke), so each point keeps a share of the room the route had there: the old fixed few-pixel
  // floor let a route running 0.2 rad clear of a spot be pulled to 0.01.
  const clr = p.map(q => walls.clearance(q, KEEP_CLEAR_RANGE));
  const floor = clr.map(c => Math.min(KEEP_CLEAR_SHARE * c, KEEP_CLEAR_MAX));
  for (let it = 0; it < 40; it++) {
    for (let i = 2; i < p.length - 2; i++) {
      const cand = normalize({
        x: p[i - 1].x + p[i + 1].x + 2 * p[i].x,
        y: p[i - 1].y + p[i + 1].y + 2 * p[i].y,
        z: p[i - 1].z + p[i + 1].z + 2 * p[i].z,
      });
      const cc = walls.clearance(cand, KEEP_CLEAR_RANGE);
      if (cc < Math.min(clr[i], floor[i])) continue;
      if (walls.crosses(p[i - 1], cand) || walls.crosses(cand, p[i + 1])) continue;
      if (sweptHasPoint(walls, p[i - 1], p[i], cand) || sweptHasPoint(walls, p[i], p[i + 1], cand)) continue;
      p[i] = cand;
      clr[i] = cc;
    }
  }
  return p;
}

function sweptHasPoint(walls: WallIndex, a: V3, b: V3, c: V3): boolean {
  // Orientation-agnostic: test both windings.
  const cen = normalize({ x: a.x + b.x + c.x, y: a.y + b.y + c.y, z: a.z + b.z + c.z });
  const r = Math.max(ang(cen, a), ang(cen, b), ang(cen, c));
  return walls.triangleHasPoint(a, b, c, cen, r) || walls.triangleHasPoint(a, c, b, cen, r);
}

/** The unsmoothed route behind each stroke routeOnMesh returned (debug overlay: see rawRouteOf). */
const rawRoutes = new WeakMap<SpherePoint[], SpherePoint[]>();

/** The route a stroke came from before smoothPath, or undefined if the stroke wasn't routed. */
export function rawRouteOf(stroke: SpherePoint[]): SpherePoint[] | undefined {
  return rawRoutes.get(stroke);
}

/** Route one fully-specified move on a prebuilt face mesh. */
export function routeOnMesh(mesh: FaceMesh, spec: RouteSpec, diag?: RouteDiag): SpherePoint[] | null {
  if (!mesh.ok) return null;
  let raw = spec.kind === 'split' ? routeSplit(mesh, spec, diag) : routeJoin(mesh, spec);
  if (!raw && spec.kind === 'split' && (spec.a.b !== spec.c.b || spec.a.k !== spec.c.k)) {
    // The same partition read from the other endpoint (c→a arc, complementary boundaries) is a
    // different labeling of the mesh, and the repair/trace can succeed where this one didn't.
    const withArc = new Set(mesh.region.boundaries.map((_, b) => b).filter(b => b !== spec.a.b && !spec.withArc.has(b)));
    const rev = routeSplit(mesh, { kind: 'split', a: spec.c, c: spec.a, withArc }, diag);
    raw = rev ? [...rev].reverse() : null;
  }
  if (!raw) return null;
  const rawDense = densify(raw);
  const smooth = densify(smoothPath(mesh.walls, raw));
  const stroke = selfCrosses(smooth) ? rawDense : smooth;
  rawRoutes.set(stroke, rawDense);
  return stroke;
}

function selfCrosses(p: V3[]): boolean {
  for (let i = 0; i + 1 < p.length; i++)
    for (let j = i + 2; j + 1 < p.length; j++) {
      if (i === 0 && j + 2 === p.length) continue; // a self-loop's closing pair shares its vertex
      if (arcsCross(p[i], p[i + 1], p[j], p[j + 1])) return true;
    }
  return false;
}

// ---------------------------------------------------------------------------
// Adapter: ResolvedMove -> candidate strokes
// ---------------------------------------------------------------------------

/**
 * Candidate strokes for a parsed move, one per plausible reading of it: every live face where
 * both endpoints have a corner, every corner choice for a joint endpoint, and for splits both
 * ways of putting the bracketed boundaries relative to the lo→hi arc. The caller verifies each
 * against the target (the readings that don't match the target produce some OTHER legal move).
 */
export function routedCandidates(state: GameState, parsed: ResolvedMove): SpherePoint[][] {
  const out: SpherePoint[][] = [];
  for (const { region, specs } of routeSpecsFor(state, parsed)) {
    const mesh = faceMeshFor(state, region);
    for (const s of specs) {
      const stroke = routeOnMesh(mesh, s);
      if (stroke) out.push(stroke);
    }
  }
  return out;
}

/**
 * Face meshes are pure functions of the face's geometry, and the Position Browser routes every
 * child of a position in one go — memoize on a fingerprint of the whole drawing (any vertex or
 * edge-point move invalidates) plus the face's combinatorial identity.
 */
const meshCache = new Map<string, FaceMesh>();
const MESH_CACHE_MAX = 24;

function drawingFingerprint(state: GameState): string {
  let h = 0, n = 0;
  const mix = (x: number): void => { h = (h * 31 + Math.round(x * 1e9)) % 2147483647; n++; };
  for (const v of state.vertices.values()) { mix(v.id); mix(v.pos.x); mix(v.pos.y); mix(v.pos.z); }
  for (const e of state.edges.values()) { mix(e.id); for (const p of e.points) { mix(p.x); mix(p.y); mix(p.z); } }
  return `${state.moveCount}:${n}:${h}`;
}

export function faceMeshFor(state: GameState, region: Region): FaceMesh {
  const faceKey = region.boundaries.map(bd => bd.entries.map(en => `${en.vertexId}/${en.edgeId ?? ''}`).join(',')).join('|');
  const key = `${drawingFingerprint(state)}#${faceKey}`;
  let mesh = meshCache.get(key);
  if (!mesh) {
    mesh = buildFaceMesh(state, region);
    meshCache.set(key, mesh);
    if (meshCache.size > MESH_CACHE_MAX) meshCache.delete(meshCache.keys().next().value!);
  }
  return mesh;
}

/** Every reading of `parsed` as a RouteSpec, grouped by face (see routedCandidates). */
export function routeSpecsFor(state: GameState, parsed: ResolvedMove): { region: Region; specs: RouteSpec[] }[] {
  const out: { region: Region; specs: RouteSpec[] }[] = [];
  const bracketSet = new Set(parsed.brackets ?? []);
  for (const region of state.regions.values()) {
    if (region.isDead) continue;
    const cornersOf = (vid: VertexId): Corner[] => {
      const cs: Corner[] = [];
      region.boundaries.forEach((bd, b) => bd.entries.forEach((en, k) => { if (en.vertexId === vid) cs.push({ b, k }); }));
      return cs;
    };
    const as = cornersOf(parsed.lo);
    const cs = parsed.lo === parsed.hi ? as : cornersOf(parsed.hi);
    if (as.length === 0 || cs.length === 0) continue;

    const specs: RouteSpec[] = [];
    for (const a of as) {
      for (const c of cs) {
        if (parsed.lo === parsed.hi && (a.b !== c.b || a.k !== c.k)) continue;
        if (a.b !== c.b) { specs.push({ kind: 'join', a, c }); continue; }
        const withBr = new Set<number>(), without = new Set<number>();
        region.boundaries.forEach((bd, b) => {
          if (b === a.b) return;
          (bd.entries.some(en => bracketSet.has(en.vertexId)) ? withBr : without).add(b);
        });
        specs.push({ kind: 'split', a, c, withArc: withBr });
        specs.push({ kind: 'split', a, c, withArc: without });
      }
    }
    if (specs.length > 0) out.push({ region, specs });
  }
  return out;
}

/**
 * Every move the router can be asked to draw in this position, lazily: each live face, each pair
 * of corners with free valence (self-loops only at degree <= 1), and for splits every assignment
 * of the face's other boundaries to the two sides (faces with more than `maxOtherBoundaries`
 * others skip splits — 2^k readings). Unverified: callers apply + canonicalize to see which child
 * each one reaches. Independent of any move-to-vertex translation, so it covers children whose
 * engine indices can't be resolved to live vertices.
 */
export function* allRoutedMoves(state: GameState, maxOtherBoundaries = 7): Generator<{ v1: VertexId; v2: VertexId; stroke: SpherePoint[] }> {
  for (const region of [...state.regions.values()]) {
    if (region.isDead) continue;
    const corners: (Corner & { vid: VertexId; deg: number })[] = [];
    region.boundaries.forEach((bd, b) => bd.entries.forEach((en, k) => {
      const v = state.vertices.get(en.vertexId);
      if (v && !v.isPseudo && v.degree <= 2) corners.push({ b, k, vid: v.id, deg: v.degree });
    }));
    if (corners.length === 0) continue;
    const mesh = faceMeshFor(state, region);
    const others = (b0: number): number[] => region.boundaries.map((_, x) => x).filter(x => x !== b0);
    for (let i = 0; i < corners.length; i++) {
      for (let j = i; j < corners.length; j++) {
        const a = corners[i], c = corners[j];
        if (i === j ? a.deg > 1 : a.vid === c.vid) continue;
        const specs: RouteSpec[] = [];
        if (a.b !== c.b) specs.push({ kind: 'join', a, c });
        else {
          const rest = others(a.b);
          if (rest.length > maxOtherBoundaries) continue;
          for (let mask = 0; mask < 1 << rest.length; mask++) {
            specs.push({ kind: 'split', a, c, withArc: new Set(rest.filter((_, t) => (mask >> t) & 1)) });
          }
        }
        for (const spec of specs) {
          const stroke = routeOnMesh(mesh, spec);
          if (stroke) yield { v1: a.vid, v2: c.vid, stroke };
        }
      }
    }
  }
}
