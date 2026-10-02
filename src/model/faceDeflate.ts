/**
 * Deflate-in-place geometry for a face of the sphere — the shared engine behind
 * the dead-region collapse animations.
 *
 * Given a face D (a closed boundary loop on the sphere, empty inside), we build
 * a homeomorphism H from D onto a convex polygon inscribed in the unit circle
 * (boundary point k ↦ the circle point at angle θ_k, θ proportional to arc
 * length). The deflation at depth r ∈ (0, 1] is then H⁻¹ of the polygon scaled
 * by r: r = 1 is the boundary itself, smaller r gives nested curves shrinking
 * onto H⁻¹(0), and each boundary point travels along H⁻¹ of its own ray.
 *
 * Why this can never cross anything: H is a piecewise-linear map built on a
 * triangulation of D, with the interior vertices placed by Floater's
 * mean-value-coordinate embedding. Floater's theorem (the generalisation of
 * Tutte's spring embedding) guarantees that with the boundary on a convex
 * polygon and positive weights the result is a valid embedding — so H is
 * injective whatever D's shape. Scaled copies of a convex polygon around 0 are
 * nested and their rays never meet, so the deflated curves are nested, the
 * point tracks never cross each other, and everything stays inside D (which is
 * empty). Nothing here cares which side of the loop is "smaller": D is whatever
 * side the caller names by giving a point OUTSIDE it, so a dead face covering
 * most of the sphere deflates exactly like a small one.
 *
 * (A conformal map — the Riemann map — would also be injective, but crowding
 * makes it numerically unusable for long thin faces such as sliver bigons.)
 *
 * All the work is done in a stereographic chart whose pole is outside D, so D
 * is a bounded planar polygon; the chart is a homeomorphism, so injectivity
 * carries back to the sphere.
 */

import type { SpherePoint } from '../math/sphere';
import { normalize, sphereAngle } from '../math/sphere';

/** Stereographic chart of the sphere centred on (projected from) `pole`: `fwd`
 * maps a sphere point to the plane, `inv` maps back. The pole itself goes to
 * infinity, so it must lie outside whatever is being moved around in the chart. */
export function stereoChart(pole: SpherePoint): {
  fwd: (p: SpherePoint) => { x: number; y: number };
  inv: (q: { x: number; y: number }) => SpherePoint;
} {
  const R = normalize(pole);
  const t: SpherePoint = Math.abs(R.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const e1 = normalize({ x: R.y * t.z - R.z * t.y, y: R.z * t.x - R.x * t.z, z: R.x * t.y - R.y * t.x });
  const e2: SpherePoint = { x: R.y * e1.z - R.z * e1.y, y: R.z * e1.x - R.x * e1.z, z: R.x * e1.y - R.y * e1.x };
  const dot = (p: SpherePoint, q: SpherePoint) => p.x * q.x + p.y * q.y + p.z * q.z;
  return {
    fwd: p => {
      const d = Math.max(1 - dot(p, R), 1e-9);
      return { x: dot(p, e1) / d, y: dot(p, e2) / d };
    },
    inv: q => {
      const r2 = q.x * q.x + q.y * q.y, d = r2 + 1, z = (r2 - 1) / d, k = 2 / d;
      return normalize({
        x: R.x * z + (e1.x * q.x + e2.x * q.y) * k,
        y: R.y * z + (e1.y * q.x + e2.y * q.y) * k,
        z: R.z * z + (e1.z * q.x + e2.z * q.y) * k,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Planar triangulation of a simple polygon (ear clipping → constrained
// Delaunay by Lawson flips → centroid refinement)
// ---------------------------------------------------------------------------

type Tri = [number, number, number];

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** > 0 when d is strictly inside the circumcircle of the CCW triangle abc. */
function inCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const adx = ax - dx, ady = ay - dy, bdx = bx - dx, bdy = by - dy, cdx = cx - dx, cdy = cy - dy;
  const ad = adx * adx + ady * ady, bd = bdx * bdx + bdy * bdy, cd = cdx * cdx + cdy * cdy;
  return adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx);
}

class Mesh {
  xs: number[]; ys: number[];
  tris: Tri[] = [];
  private edgeTris = new Map<number, number[]>();
  private constrained = new Set<number>();
  private static readonly K = 1 << 21;

  constructor(xs: number[], ys: number[]) { this.xs = xs; this.ys = ys; }

  key(a: number, b: number): number { return a < b ? a * Mesh.K + b : b * Mesh.K + a; }
  area(t: Tri): number {
    const { xs, ys } = this;
    return orient(xs[t[0]], ys[t[0]], xs[t[1]], ys[t[1]], xs[t[2]], ys[t[2]]) / 2;
  }
  constrain(a: number, b: number): void { this.constrained.add(this.key(a, b)); }

  private link(t: number): void {
    const [a, b, c] = this.tris[t];
    for (const k of [this.key(a, b), this.key(b, c), this.key(c, a)]) {
      const l = this.edgeTris.get(k);
      if (l) l.push(t); else this.edgeTris.set(k, [t]);
    }
  }
  private unlink(t: number): void {
    const [a, b, c] = this.tris[t];
    for (const k of [this.key(a, b), this.key(b, c), this.key(c, a)]) {
      const l = this.edgeTris.get(k)!;
      l.splice(l.indexOf(t), 1);
    }
  }
  add(t: Tri): number { this.tris.push(t); this.link(this.tris.length - 1); return this.tris.length - 1; }
  private set(i: number, t: Tri): void { this.unlink(i); this.tris[i] = t; this.link(i); }

  /** Lawson flips from the given edges until every unconstrained edge is locally Delaunay. */
  legalize(stack: [number, number][]): void {
    const { xs, ys } = this;
    let guard = 0;
    while (stack.length > 0 && guard++ < 200000) {
      let [a, b] = stack.pop()!;
      const k = this.key(a, b);
      if (this.constrained.has(k)) continue;
      const l = this.edgeTris.get(k);
      if (!l || l.length !== 2) continue;
      let [t1, t2] = l;
      // Orient so t1 contains a→b (opposite c) and t2 contains b→a (opposite d).
      const has = (t: Tri, u: number, v: number) => (t[0] === u && t[1] === v) || (t[1] === u && t[2] === v) || (t[2] === u && t[0] === v);
      if (!has(this.tris[t1], a, b)) [t1, t2] = [t2, t1];
      if (!has(this.tris[t1], a, b)) { [a, b] = [b, a]; if (!has(this.tris[t1], a, b)) [t1, t2] = [t2, t1]; }
      const c = this.tris[t1].find(v => v !== a && v !== b)!;
      const d = this.tris[t2].find(v => v !== a && v !== b)!;
      if (inCircle(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c], xs[d], ys[d]) <= 0) continue;
      const n1: Tri = [a, d, c], n2: Tri = [d, b, c];
      if (this.area(n1) <= 0 || this.area(n2) <= 0) continue; // non-convex quad: not flippable
      this.set(t1, n1);
      this.set(t2, n2);
      stack.push([a, d], [d, b], [b, c], [c, a]);
    }
  }

  /** Split triangle `t` at a new vertex (x, y) inside it, then restore Delaunay. */
  splitAt(t: number, x: number, y: number): void {
    const v = this.xs.length;
    this.xs.push(x); this.ys.push(y);
    const [a, b, c] = this.tris[t];
    this.set(t, [a, b, v]);
    this.add([b, c, v]);
    this.add([c, a, v]);
    this.legalize([[a, b], [b, c], [c, a]]);
  }

  /** The triangle on the other side of edge a–b from triangle t, or -1 (boundary). */
  across(t: number, a: number, b: number): number {
    const l = this.edgeTris.get(this.key(a, b))!;
    return l.length === 2 ? (l[0] === t ? l[1] : l[0]) : -1;
  }

  allEdges(): [number, number][] {
    return [...this.edgeTris.keys()].map(k => [Math.floor(k / Mesh.K), k % Mesh.K] as [number, number]);
  }
}

/** Ear-clip a CCW simple polygon (vertices 0..m-1 of the mesh). Null on failure. */
function earClip(mesh: Mesh, m: number): boolean {
  const { xs, ys } = mesh;
  const prev = Array.from({ length: m }, (_, i) => (i + m - 1) % m);
  const next = Array.from({ length: m }, (_, i) => (i + 1) % m);
  const turn = (i: number) => orient(xs[prev[i]], ys[prev[i]], xs[i], ys[i], xs[next[i]], ys[next[i]]);
  let remaining = m;
  let i = 0, sinceClip = 0;
  while (remaining > 3) {
    if (sinceClip > remaining) return false; // no ear found in a full lap
    const a = prev[i], c = next[i];
    let ear = turn(i) > 0;
    if (ear) {
      // No other remaining vertex may lie inside or on the candidate ear (only
      // non-convex vertices can, but collinear ones lie ON it, so test those too).
      for (let j = next[c]; j !== a; j = next[j]) {
        if (turn(j) > 0) continue;
        const px = xs[j], py = ys[j];
        if ((px === xs[a] && py === ys[a]) || (px === xs[c] && py === ys[c])) continue;
        if (orient(xs[a], ys[a], xs[i], ys[i], px, py) >= 0 &&
            orient(xs[i], ys[i], xs[c], ys[c], px, py) >= 0 &&
            orient(xs[c], ys[c], xs[a], ys[a], px, py) >= 0) { ear = false; break; }
      }
    }
    if (ear) {
      mesh.add([a, i, c]);
      next[a] = c; prev[c] = a;
      remaining--; sinceClip = 0;
      i = a;
    } else {
      i = next[i]; sinceClip++;
    }
  }
  mesh.add([prev[i], i, next[i]]);
  return true;
}

// ---------------------------------------------------------------------------
// Sphere-level API
// ---------------------------------------------------------------------------

/** Target interior vertex count of the deflation mesh. */
const DEFLATE_MESH_VERTICES = 600;

export interface FaceDeflation {
  chart: ReturnType<typeof stereoChart>;
  /** Mesh vertex positions: in the chart (px/py) and in the disk (dx/dy). */
  px: number[]; py: number[];
  dx: number[]; dy: number[];
  tris: Tri[];
  /** adj[3t+s]: the triangle across edge tris[t][s]→tris[t][s+1], or -1 on the boundary. */
  adj: number[];
  /** Disk-space bucket grid over [-1,1]² → triangle indices, for point location. */
  grid: number[][];
  gridN: number;
  /** Disk angles of the boundary polygon's vertices (increasing, spanning 2π). */
  boundaryThetas: number[];
  /** Boundary angle of each ORIGINAL loop point (unwrapped, increasing along the loop). */
  thetas: number[];
  /** -1 when the caller's loop runs clockwise around the face (angles stored negated). */
  flip: 1 | -1;
  /** The point the face deflates onto (H⁻¹(0)). */
  center: SpherePoint;
}

/**
 * Prepare the deflation of the face bounded by the closed `loop` (first point
 * NOT repeated at the end). `outside` is any point known to lie outside the
 * face (e.g. a vertex not on its boundary) — that alone decides which side of
 * the loop is the face. Returns null if the face can't be meshed (degenerate).
 */
export function buildFaceDeflation(loop: SpherePoint[], outside: SpherePoint): FaceDeflation | null {
  // Drop exact repeats, remembering where each original point landed.
  const pts: SpherePoint[] = [];
  const origIdx: number[] = [];
  for (const p of loop) {
    if (pts.length === 0 || sphereAngle(pts[pts.length - 1], p) > 1e-9) pts.push(p);
    origIdx.push(pts.length - 1);
  }
  if (pts.length > 1 && sphereAngle(pts[pts.length - 1], pts[0]) <= 1e-9) {
    pts.pop();
    for (let i = 0; i < origIdx.length; i++) if (origIdx[i] === pts.length) origIdx[i] = 0;
  }
  const m = pts.length;
  if (m < 3) return null;

  // Projection pole: the point outside the face farthest from its boundary
  // (keeps the chart's distortion of the face low). Sides are told apart in a
  // chart from `outside`, where the face is the bounded polygon.
  const chart0 = stereoChart(outside);
  const poly0 = pts.map(chart0.fwd);
  const inside0 = (q: { x: number; y: number }) => {
    let inside = false;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const a = poly0[i], b = poly0[j];
      if ((a.y > q.y) !== (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const distToLoop = (p: SpherePoint) => {
    let best = Infinity;
    for (const q of pts) { const d = sphereAngle(p, q); if (d < best) best = d; }
    return best;
  };
  let pole = outside, poleD = distToLoop(outside);
  const N_FIB = 400;
  for (let i = 0; i < N_FIB; i++) {
    const y = 1 - 2 * (i + 0.5) / N_FIB, rr = Math.sqrt(1 - y * y), phi = i * Math.PI * (3 - Math.sqrt(5));
    const c = { x: rr * Math.cos(phi), y, z: rr * Math.sin(phi) };
    const d = distToLoop(c);
    if (d > poleD && !inside0(chart0.fwd(c))) { poleD = d; pole = c; }
  }

  // Planar polygon in the final chart, normalised to a unit-ish box, CCW.
  const chart = stereoChart(pole);
  let xs = pts.map(p => chart.fwd(p).x), ys = pts.map(p => chart.fwd(p).y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.max(maxX - minX, maxY - minY) || 1;
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
  xs = xs.map(x => (x - ox) / scale);
  ys = ys.map(y => (y - oy) / scale);
  let area2 = 0;
  for (let i = 0; i < m; i++) { const j = (i + 1) % m; area2 += xs[i] * ys[j] - xs[j] * ys[i]; }
  const reversed = area2 < 0;
  // order[k] = which polygon point is the mesh's k-th (CCW) boundary vertex.
  const order = Array.from({ length: m }, (_, k) => (reversed ? m - 1 - k : k));
  const mesh = new Mesh(order.map(i => xs[i]), order.map(i => ys[i]));
  if (!earClip(mesh, m)) return null;
  for (let k = 0; k < m; k++) mesh.constrain(k, (k + 1) % m);
  mesh.legalize(mesh.allEdges());

  // Refine: split triangles bigger than the target size at their centroid.
  const targetArea = Math.abs(area2) / 2 / DEFLATE_MESH_VERTICES;
  for (let pass = 0; pass < 30; pass++) {
    let split = false;
    const n = mesh.tris.length;
    for (let t = 0; t < n && mesh.xs.length < m + 3 * DEFLATE_MESH_VERTICES; t++) {
      if (mesh.area(mesh.tris[t]) <= targetArea) continue;
      const [a, b, c] = mesh.tris[t];
      mesh.splitAt(t, (mesh.xs[a] + mesh.xs[b] + mesh.xs[c]) / 3, (mesh.ys[a] + mesh.ys[b] + mesh.ys[c]) / 3);
      split = true;
    }
    if (!split) break;
  }
  const nv = mesh.xs.length;
  if (mesh.tris.some(t => mesh.area(t) <= 0)) return null;

  // Boundary on the unit circle, angle ∝ spherical arc length.
  const boundaryThetas: number[] = [0];
  for (let k = 1; k < m; k++) boundaryThetas.push(boundaryThetas[k - 1] + sphereAngle(pts[order[k - 1]], pts[order[k]]));
  const perimeter = boundaryThetas[m - 1] + sphereAngle(pts[order[m - 1]], pts[order[0]]);
  for (let k = 0; k < m; k++) boundaryThetas[k] *= 2 * Math.PI / perimeter;
  const dx = new Array<number>(nv).fill(0), dy = new Array<number>(nv).fill(0);
  for (let k = 0; k < m; k++) { dx[k] = Math.cos(boundaryThetas[k]); dy[k] = Math.sin(boundaryThetas[k]); }

  // Floater mean-value weights: for each triangle corner at i, tan(angle/2)
  // goes to both incident edges, divided by that edge's length.
  const nbrs: Map<number, number>[] = Array.from({ length: nv }, () => new Map());
  for (const t of mesh.tris) {
    for (let s = 0; s < 3; s++) {
      const i = t[s], j = t[(s + 1) % 3], k = t[(s + 2) % 3];
      if (i < m) continue; // boundary vertices are fixed
      const ux = mesh.xs[j] - mesh.xs[i], uy = mesh.ys[j] - mesh.ys[i];
      const vx = mesh.xs[k] - mesh.xs[i], vy = mesh.ys[k] - mesh.ys[i];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      const ang = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
      const tn = Math.tan(ang / 2);
      nbrs[i].set(j, (nbrs[i].get(j) ?? 0) + tn / lu);
      nbrs[i].set(k, (nbrs[i].get(k) ?? 0) + tn / lv);
    }
  }
  const W = nbrs.map(nb => [...nb.values()].reduce((s, w) => s + w, 0));
  const nbrList = nbrs.map(nb => [...nb.entries()]);
  // Successive over-relaxation (Gauss–Seidel) to the embedding.
  for (let it = 0; it < 20000; it++) {
    let maxDelta = 0;
    for (let i = m; i < nv; i++) {
      let sx = 0, sy = 0;
      for (const [j, w] of nbrList[i]) { sx += w * dx[j]; sy += w * dy[j]; }
      const nx = dx[i] + 1.8 * (sx / W[i] - dx[i]), ny = dy[i] + 1.8 * (sy / W[i] - dy[i]);
      maxDelta = Math.max(maxDelta, Math.abs(nx - dx[i]), Math.abs(ny - dy[i]));
      dx[i] = nx; dy[i] = ny;
    }
    if (maxDelta < 1e-12) break;
  }
  for (const t of mesh.tris) {
    if (orient(dx[t[0]], dy[t[0]], dx[t[1]], dy[t[1]], dx[t[2]], dy[t[2]]) <= 0) return null;
  }


  // Triangle adjacency, for walking a disk path through the mesh.
  const adj: number[] = [];
  mesh.tris.forEach((t, ti) => { for (let s = 0; s < 3; s++) adj.push(mesh.across(ti, t[s], t[(s + 1) % 3])); });

  // Bucket grid for point location in the disk.
  const gridN = 48;
  const grid: number[][] = Array.from({ length: gridN * gridN }, () => []);
  const cell = (v: number) => Math.max(0, Math.min(gridN - 1, Math.floor((v + 1) / 2 * gridN)));
  mesh.tris.forEach((t, ti) => {
    const x0 = cell(Math.min(dx[t[0]], dx[t[1]], dx[t[2]])), x1 = cell(Math.max(dx[t[0]], dx[t[1]], dx[t[2]]));
    const y0 = cell(Math.min(dy[t[0]], dy[t[1]], dy[t[2]])), y1 = cell(Math.max(dy[t[0]], dy[t[1]], dy[t[2]]));
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) grid[gy * gridN + gx].push(ti);
  });

  // Undo the normalisation so mesh positions are real chart coordinates.
  const px = mesh.xs.map(x => x * scale + ox), py = mesh.ys.map(y => y * scale + oy);

  // Angles of the original loop points, in the caller's order, increasing along it.
  const flip: 1 | -1 = reversed ? -1 : 1;
  const thetas = origIdx.map(pi => flip * boundaryThetas[reversed ? m - 1 - pi : pi]);
  for (let k = 1; k < thetas.length; k++) {
    while (thetas[k] < thetas[k - 1]) thetas[k] += 2 * Math.PI;
    while (thetas[k] - thetas[k - 1] > 2 * Math.PI) thetas[k] -= 2 * Math.PI;
  }
  const def: FaceDeflation = { chart, px, py, dx, dy, tris: mesh.tris, adj, grid, gridN, boundaryThetas, thetas, flip, center: pts[0] };
  def.center = deflatePoint(def, 0, 0);
  return def;
}

// ---------------------------------------------------------------------------
// Evaluating the deflation
// ---------------------------------------------------------------------------
//
// H⁻¹ is affine on each mesh triangle, so the image of a straight disk segment
// is a polyline that bends only where the segment crosses a mesh edge. The
// curves below are traced EXACTLY that way (a point at every crossing), so the
// drawn polylines are the true images and inherit H's injectivity — sampled
// points joined by chords could cut corners and clip a neighbouring track.

type Pt = { x: number; y: number };

/** Disk point on the inscribed boundary polygon at disk angle `a` (any real). */
function polygonPoint(def: FaceDeflation, a: number): Pt {
  const bt = def.boundaryThetas, m = bt.length;
  const t = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let lo = 0, hi = m - 1; // largest k with bt[k] <= t
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bt[mid] <= t) lo = mid; else hi = mid - 1; }
  const k1 = (lo + 1) % m;
  const span = (k1 === 0 ? 2 * Math.PI : bt[k1]) - bt[lo];
  const f = span > 0 ? (t - bt[lo]) / span : 0;
  return { x: def.dx[lo] + (def.dx[k1] - def.dx[lo]) * f, y: def.dy[lo] + (def.dy[k1] - def.dy[lo]) * f };
}

/** Barycentric coordinates of disk point w in triangle t. */
function bary(def: FaceDeflation, t: number, w: Pt): [number, number, number] {
  const { dx, dy } = def;
  const [i, j, k] = def.tris[t];
  const A = orient(dx[i], dy[i], dx[j], dy[j], dx[k], dy[k]);
  const l0 = orient(w.x, w.y, dx[j], dy[j], dx[k], dy[k]) / A;
  const l1 = orient(dx[i], dy[i], w.x, w.y, dx[k], dy[k]) / A;
  return [l0, l1, 1 - l0 - l1];
}

/** The triangle containing disk point w (best match if w sits on an edge or just outside). */
function locate(def: FaceDeflation, w: Pt): number {
  const { gridN } = def;
  const cell = (v: number) => Math.max(0, Math.min(gridN - 1, Math.floor((v + 1) / 2 * gridN)));
  let best = -Infinity, bestT = -1;
  for (const ti of def.grid[cell(w.y) * gridN + cell(w.x)]) {
    const worst = Math.min(...bary(def, ti, w));
    if (worst > best) { best = worst; bestT = ti; }
    if (worst >= 0) break;
  }
  if (best < 0) {
    for (let ti = 0; ti < def.tris.length; ti++) {
      const worst = Math.min(...bary(def, ti, w));
      if (worst > best) { best = worst; bestT = ti; }
    }
  }
  return bestT;
}

/** H⁻¹ of disk point w, using triangle t's affine piece. */
function mapIn(def: FaceDeflation, t: number, w: Pt): SpherePoint {
  const b = bary(def, t, w).map(v => Math.max(0, v));
  const s = b[0] + b[1] + b[2];
  const [i, j, k] = def.tris[t];
  return def.chart.inv({
    x: (b[0] * def.px[i] + b[1] * def.px[j] + b[2] * def.px[k]) / s,
    y: (b[0] * def.py[i] + b[1] * def.py[j] + b[2] * def.py[k]) / s,
  });
}

/** Exact image of the disk polyline `path`, with a point at every mesh-edge crossing. */
function tracePath(def: FaceDeflation, path: Pt[]): SpherePoint[] {
  const out: SpherePoint[] = [];
  const push = (p: SpherePoint) => {
    const q = out[out.length - 1];
    if (!q || Math.abs(q.x - p.x) + Math.abs(q.y - p.y) + Math.abs(q.z - p.z) > 1e-13) out.push(p);
  };
  const { dx, dy } = def;
  for (let s = 0; s + 1 < path.length; s++) {
    const w0 = path[s], w1 = path[s + 1];
    const ddx = w1.x - w0.x, ddy = w1.y - w0.y;
    // Start in the triangle the segment heads into.
    let t = locate(def, { x: w0.x + ddx * 1e-9, y: w0.y + ddy * 1e-9 });
    if (t < 0) continue;
    if (s === 0) push(mapIn(def, t, w0));
    let lam = 0, entry = -1;
    for (let guard = 0; guard < 4 * def.tris.length + 16; guard++) {
      const tri = def.tris[t];
      let exitLam = Infinity, exitEdge = -1;
      for (let e = 0; e < 3; e++) {
        if (e === entry) continue;
        const a = tri[e], b = tri[(e + 1) % 3];
        // Signed distance (positive inside) of the segment's ends from this edge's line.
        const d0 = orient(dx[a], dy[a], dx[b], dy[b], w0.x, w0.y);
        const d1 = orient(dx[a], dy[a], dx[b], dy[b], w1.x, w1.y);
        if (d1 >= 0 || d1 >= d0) continue; // the segment doesn't leave through this edge
        const l = d0 / (d0 - d1);
        if (l >= lam - 1e-12 && l < exitLam) { exitLam = l; exitEdge = e; }
      }
      if (exitEdge < 0 || exitLam >= 1) break; // segment ends inside this triangle
      const next = def.adj[3 * t + exitEdge];
      if (next < 0) break; // reached the face boundary
      lam = Math.max(lam, exitLam);
      push(mapIn(def, t, { x: w0.x + ddx * lam, y: w0.y + ddy * lam }));
      // In the next triangle, don't immediately re-exit through the shared edge.
      const a = tri[exitEdge], b = tri[(exitEdge + 1) % 3];
      const nt = def.tris[next];
      entry = [0, 1, 2].find(e => nt[e] === b && nt[(e + 1) % 3] === a) ?? -1;
      t = next;
    }
    push(mapIn(def, t, w1));
  }
  return out;
}

/** The point at depth `r` (1 = on the boundary, 0 = the centre) on the track
 * of the boundary point with angle `theta`. */
export function deflatePoint(def: FaceDeflation, theta: number, r: number): SpherePoint {
  const b = polygonPoint(def, def.flip * theta);
  const w = { x: r * b.x, y: r * b.y };
  const t = locate(def, w);
  return t < 0 ? { ...def.center } : mapIn(def, t, w);
}

/** The deflated boundary at depth `r` between angles `theta0` and `theta1`
 * (either order), traced exactly: starts at deflatePoint(theta0, r) and ends at
 * deflatePoint(theta1, r). */
export function deflateArc(def: FaceDeflation, theta0: number, theta1: number, r: number): SpherePoint[] {
  const a0 = def.flip * theta0, a1 = def.flip * theta1;
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  // Polygon corners strictly between the two angles, in travel order.
  const corners: number[] = [];
  for (let j = Math.floor(lo / (2 * Math.PI)) - 1; j <= Math.ceil(hi / (2 * Math.PI)) + 1; j++) {
    for (const b of def.boundaryThetas) {
      const a = b + 2 * Math.PI * j;
      if (a > lo + 1e-12 && a < hi - 1e-12) corners.push(a);
    }
  }
  corners.sort((x, y) => (a1 >= a0 ? x - y : y - x));
  const path = [a0, ...corners, a1].map(a => { const p = polygonPoint(def, a); return { x: r * p.x, y: r * p.y }; });
  return tracePath(def, path);
}

/** The track of the boundary point with angle `theta` from depth `r0` to depth `r1`, traced exactly. */
export function deflateTrack(def: FaceDeflation, theta: number, r0: number, r1: number): SpherePoint[] {
  const b = polygonPoint(def, def.flip * theta);
  return tracePath(def, [{ x: r0 * b.x, y: r0 * b.y }, { x: r1 * b.x, y: r1 * b.y }]);
}
