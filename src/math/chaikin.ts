/**
 * Chaikin's corner-cutting algorithm for smooth curve rendering.
 *
 * Each iteration replaces every segment AB with two new points:
 *   Q = A + 0.25 * (B - A)  =  0.75*A + 0.25*B
 *   R = A + 0.75 * (B - A)  =  0.25*A + 0.75*B
 *
 * The first and last points of an open curve are preserved so curves
 * stay anchored to their endpoints (the vertices they connect).
 *
 * We operate on 2D canvas points since smoothing happens at render time
 * after projection, not on the sphere itself.
 */

import type { CanvasPoint } from './sphere';

/**
 * Run Chaikin smoothing for `iterations` passes on an array of canvas points.
 * The first and last points are pinned.
 */
export function chaikin(pts: CanvasPoint[], iterations: number = 3): CanvasPoint[] {
  if (pts.length < 3) return pts;

  let cur = pts;
  for (let iter = 0; iter < iterations; iter++) {
    const next: CanvasPoint[] = [cur[0]]; // pin start
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      next.push({
        px: 0.75 * a.px + 0.25 * b.px,
        py: 0.75 * a.py + 0.25 * b.py,
      });
      next.push({
        px: 0.25 * a.px + 0.75 * b.px,
        py: 0.25 * a.py + 0.75 * b.py,
      });
    }
    next.push(cur[cur.length - 1]); // pin end
    cur = next;
  }
  return cur;
}
