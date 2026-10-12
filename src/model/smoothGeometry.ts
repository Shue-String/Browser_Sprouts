import type { SpherePoint } from '../math/sphere';

/**
 * Pure geometry for the smoothing physics (see smooth.ts): distance from a point to a great-circle
 * arc, and how finely an edge's polyline has to be sampled to stay well-formed near obstacles and
 * around sharp bends.
 */

const dot = (a: SpherePoint, b: SpherePoint): number => a.x * b.x + a.y * b.y + a.z * b.z;
const angle = (a: SpherePoint, b: SpherePoint): number => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/** Nearest point on the (short) great-circle arc a→b to p: distance, arc fraction t, and the point. */
export function nearestOnArc(p: SpherePoint, a: SpherePoint, b: SpherePoint): { d: number; t: number; q: SpherePoint } {
  const nx = a.y * b.z - a.z * b.y, ny = a.z * b.x - a.x * b.z, nz = a.x * b.y - a.y * b.x;
  const nl = Math.hypot(nx, ny, nz);
  if (nl > 1e-12) {
    const s = (p.x * nx + p.y * ny + p.z * nz) / nl;
    const qx = p.x - s * nx / nl, qy = p.y - s * ny / nl, qz = p.z - s * nz / nl;
    const ql = Math.hypot(qx, qy, qz);
    if (ql > 1e-12) {
      const q = { x: qx / ql, y: qy / ql, z: qz / ql };
      // q is between a and b when it lies on the b side of a and the a side of b
      const aq = (a.y * q.z - a.z * q.y) * nx + (a.z * q.x - a.x * q.z) * ny + (a.x * q.y - a.y * q.x) * nz;
      const qb = (q.y * b.z - q.z * b.y) * nx + (q.z * b.x - q.x * b.z) * ny + (q.x * b.y - q.y * b.x) * nz;
      if (aq >= 0 && qb >= 0) return { d: angle(p, q), t: angle(a, q) / Math.max(1e-12, angle(a, b)), q };
    }
  }
  const da = angle(p, a), db = angle(p, b);
  return da <= db ? { d: da, t: 0, q: a } : { d: db, t: 1, q: b };
}

/** Signed heading change (radians; left turns positive) at interior point i of a polyline. */
function turnAt(pts: SpherePoint[], i: number): number {
  const tangent = (from: SpherePoint, to: SpherePoint, at: SpherePoint): SpherePoint | null => {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const s = dx * at.x + dy * at.y + dz * at.z;
    const tx = dx - s * at.x, ty = dy - s * at.y, tz = dz - s * at.z;
    const tl = Math.hypot(tx, ty, tz);
    return tl < 1e-12 ? null : { x: tx / tl, y: ty / tl, z: tz / tl };
  };
  const tin = tangent(pts[i - 1], pts[i], pts[i]);
  const tout = tangent(pts[i], pts[i + 1], pts[i]);
  if (!tin || !tout) return 0;
  const side = (tin.y * tout.z - tin.z * tout.y) * pts[i].x + (tin.z * tout.x - tin.x * tout.z) * pts[i].y + (tin.x * tout.y - tin.y * tout.x) * pts[i].z;
  return side >= 0 ? angle(tin, tout) : -angle(tin, tout);
}

/**
 * The largest sample spacing (radians) the polyline `pts` can have and still be well-formed, or
 * Infinity when nothing constrains it:
 *  - near an obstacle (a vertex the edge isn't attached to) the spacing is at most half the
 *    distance to it, so no chord can cut a corner past the obstacle;
 *  - wherever the heading changes NET by more than `maxTurn` within `window` of arc length (left
 *    and right wiggles cancel), that window gets enough samples that no step turns by more than
 *    half of `maxTurn`.
 * Never below `floor`.
 */
export function refinementSpacing(pts: SpherePoint[], obstacles: SpherePoint[], maxTurn: number, window: number, floor = 0.01): number {
  const n = pts.length;
  let need = Infinity;
  for (let i = 1; i < n - 1; i++) {
    for (const o of obstacles) need = Math.min(need, 0.5 * angle(pts[i], o));
  }
  if (maxTurn > 0 && window > 0 && n >= 3) {
    const s = [0], turn = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + angle(pts[i - 1], pts[i]));
    for (let i = 1; i < n - 1; i++) turn[i] = turnAt(pts, i);
    turn.push(0);
    let lo = 1;
    let sum = 0;
    let hi = 1; // points lo..hi-1 are inside the window
    for (let i = 1; i < n - 1; i++) {
      while (hi < n - 1 && s[hi] - s[i] <= window / 2) sum += turn[hi++];
      while (lo < i && s[i] - s[lo] > window / 2) sum -= turn[lo++];
      if (Math.abs(sum) > maxTurn) need = Math.min(need, window / Math.ceil((2 * Math.abs(sum)) / maxTurn));
    }
  }
  return Math.max(floor, need);
}
