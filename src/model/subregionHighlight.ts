/**
 * Builds the per-vertex hue assignment for the subregions debug view /
 * Voronoi-cell path tracer. Pulled out of main.ts so voronoiTest.ts can call
 * the exact same logic against a loaded save file, instead of a duplicate.
 */

import type { GameState, Region } from './types';
import type { SubregionHighlight } from '../render/renderer';

// Special hue sentinels used by buildSubregionHighlight / renderSubregionHighlight.
// -1 = grey (lo vertex or outer-boundary vertex)
// -2 = red  (bracket component — enclosed on the arc side)
// -3 = green (everything else in the region)

/**
 * Push a raw 0–360 hue out of the bands reserved for the fixed red (0°) and
 * green (120°) cell colors, so origin-component ("colorful") cells are never
 * close enough in hue to be mistaken for a bracket or free-region cell.
 * Excludes ±18° around each, then stitches the two remaining arcs
 * (18°–102° and 138°–342°) end to end and remaps the input into that range.
 */
export function toSafeHue(rawHue: number): number {
  const SEG1 = 102 - 18;   // 84°, between the red and green exclusion zones
  const SEG2 = 342 - 138;  // 204°, the rest of the wheel
  const total = SEG1 + SEG2; // 288°
  const t = ((rawHue % 360 + 360) % 360) / 360 * total;
  return t < SEG1 ? 18 + t : 138 + (t - SEG1);
}

/**
 * If v1 and v2 are on the same boundary component of a living region that also
 * has inner sub-boundaries, return a SubregionHighlight for those sub-boundaries.
 * Returns null if this is not such an enclosure, or if there are no inner components.
 */
export function buildSubregionHighlight(
  preState: GameState,
  v1: number,
  v2: number,
  brackets?: readonly number[],
): SubregionHighlight | null {
  const bracketSet = new Set(brackets ?? []);

  // Helper: build the highlight for a region given its outer boundary index.
  const buildFromRegion = (r: Region, outerIdx: number): SubregionHighlight => {
    const assigned = new Map<number, number>(); // vertexId → hue sentinel

    // Everything starts green.
    for (const b of r.boundaries) for (const e of b.entries) assigned.set(e.vertexId, -3);

    // Any sub-boundary of r (other than the outer one) whose minimum entry id
    // is in the bracket set is fully enclosed on the arc side → red, every
    // entry of that sub-boundary. This mirrors the exact convention
    // buildBrackets (moveCode.ts) used to generate the bracket list in the
    // first place — Math.min over a sub-boundary's own entries — rather than
    // an independent graph-edge BFS from the bracket id. That matters because
    // a sub-boundary's min entry can be a pseudo-vertex (e.g. -9999, inserted
    // by recomputeRegions to disambiguate parallel-edge rotation order): it
    // exists in state.vertices but has no state.edges of its own, so a BFS
    // starting there finds zero neighbors and never reaches the real vertices
    // (like -18, 1, 3) sharing that same sub-boundary.
    if (bracketSet.size > 0) {
      for (let bi = 0; bi < r.boundaries.length; bi++) {
        if (bi === outerIdx) continue;
        const b = r.boundaries[bi];
        const minId = Math.min(...b.entries.map(e => e.vertexId));
        if (!bracketSet.has(minId)) continue;
        for (const e of b.entries) assigned.set(e.vertexId, -2);
      }
    }

    // Origin component (v1's connected component) → distinct hues.
    // Build adjacency from the full game graph then BFS from v1.
    const originAdj = new Map<number, number[]>();
    const addOriginEdge = (a: number, b: number) => {
      if (!originAdj.has(a)) originAdj.set(a, []);
      if (!originAdj.has(b)) originAdj.set(b, []);
      originAdj.get(a)!.push(b);
      originAdj.get(b)!.push(a);
    };
    for (const edge of preState.edges.values()) addOriginEdge(edge.v1, edge.v2);
    const originComp: number[] = [];
    const originSeen = new Set<number>([v1]);
    const originQ = [v1];
    while (originQ.length > 0) {
      const cur = originQ.shift()!;
      originComp.push(cur);
      for (const nb of (originAdj.get(cur) ?? [])) {
        if (!originSeen.has(nb)) { originSeen.add(nb); originQ.push(nb); }
      }
    }
    originComp.sort((a, b) => a - b);
    originComp.forEach((vid, i) => {
      const raw = Math.round((i / originComp.length) * 360) % 360;
      assigned.set(vid, toSafeHue(raw));
    });

    const cells = [...assigned.entries()].map(([vertexId, hue]) => ({ vertexId, hue }));
    return { cells, regionId: r.id, outerBoundaryIdx: outerIdx, originV1: v1, originV2: v2 };
  };

  // Primary: find a region whose single boundary contains BOTH v1 and v2.
  // Pick the longest such boundary as the outer clip.
  for (const r of preState.regions.values()) {
    if (r.isDead) continue;
    if (r.boundaries.length < 2) continue;
    let outerIdx = -1, outerLen = -1;
    for (let bi = 0; bi < r.boundaries.length; bi++) {
      const ids = new Set(r.boundaries[bi].entries.map(e => e.vertexId));
      if (ids.has(v1) && ids.has(v2)) {
        const len = r.boundaries[bi].entries.length;
        if (len > outerLen) { outerLen = len; outerIdx = bi; }
      }
    }
    if (outerIdx >= 0) return buildFromRegion(r, outerIdx);
  }

  // Fallback: v2 may not exist yet (e.g. it will be created as the move midpoint).
  // Find a region that contains v1 in any boundary and has inner sub-boundaries;
  // use the overall longest boundary as the outer clip for the Voronoi raster.
  for (const r of preState.regions.values()) {
    if (r.isDead) continue;
    if (r.boundaries.length < 2) continue;
    const hasV1 = r.boundaries.some(b => b.entries.some(e => e.vertexId === v1));
    if (!hasV1) continue;
    // Pick longest boundary in this region as the outer clip.
    let outerIdx = 0;
    for (let bi = 1; bi < r.boundaries.length; bi++) {
      if (r.boundaries[bi].entries.length > r.boundaries[outerIdx].entries.length) outerIdx = bi;
    }
    return buildFromRegion(r, outerIdx);
  }

  return null;
}
