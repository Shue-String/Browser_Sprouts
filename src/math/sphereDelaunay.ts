/**
 * Spherical Delaunay triangulation via the 3D convex hull: for points on the unit sphere, the
 * hull's faces are exactly the Delaunay triangles (a face's plane cuts the sphere in that
 * triangle's empty circumcircle). Incremental hull; points are inserted in a space-filling-curve
 * order and located by walking from the previous insertion's faces, so typical inputs (the few
 * thousand points moveRouter.ts feeds it) cost roughly O(n log n).
 *
 * Faces whose plane does not have the origin strictly on its inner side are dropped: when every
 * point lies in one hemisphere those "bottom" faces cover the same patch of sphere as the real
 * triangles (radially projected) and would overlap them.
 *
 * Robustness: callers should perturb exactly co-circular inputs slightly (see moveRouter's
 * jittered()). The visible region is grown as a CONNECTED set from the most-visible face found,
 * and a point whose horizon isn't one simple cycle is skipped rather than inserted — noise at
 * the epsilon can't fold the surface, at worst a near-duplicate point is left out.
 */
import type { SpherePoint } from './sphere';

export interface SphereTriangulation {
  /** Triangles as point-index triples, CCW seen from outside the sphere. */
  tris: [number, number, number][];
  /** Spherical circumcenter of each triangle (unit vector). */
  centers: SpherePoint[];
}

interface Face { a: number; b: number; c: number; nx: number; ny: number; nz: number; d: number; alive: boolean }

const EPS = 1e-12;

/** 30-bit Morton code of a unit vector (10 bits per axis) — locality-preserving insertion order. */
function morton(p: SpherePoint): number {
  const q = (c: number): number => Math.min(1023, Math.max(0, Math.floor((c + 1) * 512)));
  const spread = (v: number): number => {
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    v = (v | (v << 2)) & 0x09249249;
    return v;
  };
  return (spread(q(p.x)) | (spread(q(p.y)) << 1) | (spread(q(p.z)) << 2)) >>> 0;
}

export function sphericalDelaunay(pts: readonly SpherePoint[]): SphereTriangulation {
  const n = pts.length;
  const empty: SphereTriangulation = { tris: [], centers: [] };
  if (n < 4) return empty;

  const faces: Face[] = [];
  // Directed edge (u -> v) of a live face, keyed u * n + v, to that face's index.
  const edgeFace = new Map<number, number>();

  const makeFace = (a: number, b: number, c: number): number => {
    const pa = pts[a], pb = pts[b], pc = pts[c];
    const ux = pb.x - pa.x, uy = pb.y - pa.y, uz = pb.z - pa.z;
    const vx = pc.x - pa.x, vy = pc.y - pa.y, vz = pc.z - pa.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const idx = faces.length;
    faces.push({ a, b, c, nx, ny, nz, d: nx * pa.x + ny * pa.y + nz * pa.z, alive: true });
    edgeFace.set(a * n + b, idx);
    edgeFace.set(b * n + c, idx);
    edgeFace.set(c * n + a, idx);
    return idx;
  };
  const killFace = (fi: number): void => {
    const f = faces[fi];
    f.alive = false;
    for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) {
      if (edgeFace.get(u * n + v) === fi) edgeFace.delete(u * n + v);
    }
  };
  const height = (f: Face, p: SpherePoint): number => f.nx * p.x + f.ny * p.y + f.nz * p.z - f.d;
  const twinOf = (u: number, v: number): number | undefined => edgeFace.get(v * n + u);

  // Insertion order: along a space-filling curve, so consecutive points are close and the
  // locating walk below starts next to its target.
  const order = Array.from({ length: n }, (_, i) => i);
  const codes = pts.map(morton);
  order.sort((a, b) => codes[a] - codes[b]);

  // Initial tetrahedron from the first four points (in that order) in general position.
  const orient = (a: number, b: number, c: number, d: number): number => {
    const pa = pts[a], pb = pts[b], pc = pts[c], pd = pts[d];
    const ux = pb.x - pa.x, uy = pb.y - pa.y, uz = pb.z - pa.z;
    const vx = pc.x - pa.x, vy = pc.y - pa.y, vz = pc.z - pa.z;
    const wx = pd.x - pa.x, wy = pd.y - pa.y, wz = pd.z - pa.z;
    return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
  };
  const i0 = order[0];
  let i1 = -1, i2 = -1, i3 = -1;
  for (const i of order) {
    if (i1 >= 0) break;
    const dx = pts[i].x - pts[i0].x, dy = pts[i].y - pts[i0].y, dz = pts[i].z - pts[i0].z;
    if (dx * dx + dy * dy + dz * dz > 1e-14) i1 = i;
  }
  if (i1 < 0) return empty;
  for (const i of order) {
    if (i2 >= 0) break;
    if (i === i0 || i === i1) continue;
    const pa = pts[i0], pb = pts[i1], pc = pts[i];
    const ux = pb.x - pa.x, uy = pb.y - pa.y, uz = pb.z - pa.z;
    const vx = pc.x - pa.x, vy = pc.y - pa.y, vz = pc.z - pa.z;
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 1e-10) i2 = i;
  }
  if (i2 < 0) return empty;
  for (const i of order) {
    if (i3 >= 0) break;
    if (i === i0 || i === i1 || i === i2) continue;
    if (Math.abs(orient(i0, i1, i2, i)) > 1e-12) i3 = i;
  }
  if (i3 < 0) return empty;

  const cx = (pts[i0].x + pts[i1].x + pts[i2].x + pts[i3].x) / 4;
  const cy = (pts[i0].y + pts[i1].y + pts[i2].y + pts[i3].y) / 4;
  const cz = (pts[i0].z + pts[i1].z + pts[i2].z + pts[i3].z) / 4;
  // Decide the winding BEFORE creating the face: a temporarily mis-wound face would overwrite
  // (and its removal would then delete) a directed-edge entry owned by an earlier face.
  const addOutward = (a: number, b: number, c: number): void => {
    const pa = pts[a], pb = pts[b], pc = pts[c];
    const ux = pb.x - pa.x, uy = pb.y - pa.y, uz = pb.z - pa.z;
    const vx = pc.x - pa.x, vy = pc.y - pa.y, vz = pc.z - pa.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const side = nx * (cx - pa.x) + ny * (cy - pa.y) + nz * (cz - pa.z);
    if (side > 0) makeFace(a, c, b);
    else makeFace(a, b, c);
  };
  addOutward(i0, i1, i2);
  addOutward(i0, i1, i3);
  addOutward(i0, i2, i3);
  addOutward(i1, i2, i3);

  let aliveCount = 4;
  let lastFace = faces.length - 1;

  /** Some face visible from p (height > EPS), or -1 if none (p on/inside the hull). */
  const locate = (p: SpherePoint): number => {
    // Greedy walk uphill in height from the last created face; a convex surface rarely traps
    // it, and when it does (or it wanders too long) a full scan settles the question.
    let f = faces[lastFace]?.alive ? lastFace : -1;
    if (f >= 0) {
      let h = height(faces[f], p);
      for (let steps = 0; steps < 4 * Math.sqrt(aliveCount) + 50; steps++) {
        if (h > EPS) return f;
        const F = faces[f];
        let best = -1, bestH = h;
        for (const [u, v] of [[F.a, F.b], [F.b, F.c], [F.c, F.a]] as [number, number][]) {
          const t = twinOf(u, v);
          if (t === undefined) continue;
          const th = height(faces[t], p);
          if (th > bestH) { bestH = th; best = t; }
        }
        if (best < 0) break;
        f = best; h = bestH;
      }
    }
    let best = -1, bestH = EPS;
    for (let fi = 0; fi < faces.length; fi++) {
      const F = faces[fi];
      if (!F.alive) continue;
      const h = height(F, p);
      if (h > bestH) { bestH = h; best = fi; }
    }
    return best;
  };

  for (const p of order) {
    // Dead faces stay in the array (their indices are referenced by edgeFace); compact once
    // they dominate so the fallback scan stays proportional to the live hull.
    if (faces.length > 3 * aliveCount + 64) {
      const live = faces.filter(f => f.alive);
      const lastObj = faces[lastFace];
      faces.length = 0;
      edgeFace.clear();
      for (const f of live) {
        const idx = faces.length;
        faces.push(f);
        if (f === lastObj) lastFace = idx;
        edgeFace.set(f.a * n + f.b, idx);
        edgeFace.set(f.b * n + f.c, idx);
        edgeFace.set(f.c * n + f.a, idx);
      }
      if (!faces[lastFace] || faces[lastFace] !== lastObj) lastFace = 0;
    }
    if (p === i0 || p === i1 || p === i2 || p === i3) continue;
    const pp = pts[p];
    const start = locate(pp);
    if (start < 0) continue; // on/inside the hull (duplicate or degenerate) — skip
    // Visible region = faces CONNECTED to the located one. Near-coplanar seed rows put some
    // heights at the noise floor; a disconnected noisy face must not join the region.
    const vis = new Set<number>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const f = faces[stack.pop()!];
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]] as [number, number][]) {
        const twin = twinOf(u, v);
        if (twin === undefined || vis.has(twin)) continue;
        if (height(faces[twin], pp) > EPS) { vis.add(twin); stack.push(twin); }
      }
    }
    // Horizon: edges of visible faces whose twin face is not visible.
    const horizon: [number, number][] = [];
    for (const fi of vis) {
      const f = faces[fi];
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]] as [number, number][]) {
        const twin = twinOf(u, v);
        if (twin === undefined || !vis.has(twin)) horizon.push([u, v]);
      }
    }
    // The visible region must be a disk: its horizon one simple cycle. Otherwise (an annulus or
    // a pinch, again from noise) inserting would fold the surface — drop this point instead.
    const nextOf = new Map<number, number>();
    let simple = horizon.length >= 3;
    for (const [u, v] of horizon) {
      if (nextOf.has(u)) { simple = false; break; }
      nextOf.set(u, v);
    }
    if (simple) {
      let steps = 0;
      let cur = horizon[0][0];
      do { cur = nextOf.get(cur) ?? -1; steps++; } while (cur !== horizon[0][0] && cur >= 0 && steps <= horizon.length);
      simple = cur === horizon[0][0] && steps === horizon.length;
    }
    if (!simple) continue;
    for (const fi of vis) killFace(fi);
    for (const [u, v] of horizon) lastFace = makeFace(u, v, p);
    aliveCount += horizon.length - vis.size;
  }

  const tris: [number, number, number][] = [];
  const centers: SpherePoint[] = [];
  for (const f of faces) {
    if (!f.alive || f.d <= 1e-12) continue;
    tris.push([f.a, f.b, f.c]);
    centers.push({ x: f.nx, y: f.ny, z: f.nz });
  }
  return { tris, centers };
}
