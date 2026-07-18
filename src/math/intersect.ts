/**
 * 2D line segment intersection helpers.
 * All operations are in canvas (screen) coordinates.
 */

import type { CanvasPoint } from './sphere';

/** Shoelace signed area of a canvas polygon (positive ⇒ clockwise on screen, y-down). */
export function signedArea(pts: CanvasPoint[]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    area += a.px * b.py - b.px * a.py;
  }
  return area / 2;
}

/** Euclidean distance between two canvas points. */
export function dist(a: CanvasPoint, b: CanvasPoint): number {
  return Math.hypot(a.px - b.px, a.py - b.py);
}

/**
 * Ray-casting point-in-polygon test for a closed canvas polygon.
 * Returns true if p is strictly inside poly.
 */
export function pointInPolygon(poly: CanvasPoint[], p: CanvasPoint): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].px, yi = poly[i].py;
    const xj = poly[j].px, yj = poly[j].py;
    if ((yi > p.py) !== (yj > p.py) &&
        p.px < ((xj - xi) * (p.py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
