/**
 * Combinatorial graph of the geodesic Voronoi diagram built during Recreate
 * enclosure moves.  Captures topology only — no coordinates.
 *
 * Cells are typed as:
 *   'C' — colorful (origin component of the move)
 *   'R' — red     (bracketed / enclosed component)
 *   'G' — green   (free, everything else)
 *
 * Nodes are Voronoi junctions (circumcenters of Delaunay triangles).
 * Edges are Voronoi cell borders (dual to Delaunay edges shared by 2 triangles).
 */

import type { Edge, GameState } from './types';
import type { SpherePoint } from '../math/sphere';
import { arcsCross, sphereCentroid } from '../math/sphere';
import type { SubregionHighlight } from '../render/renderer';
import { DEBUG } from '../debug/flags';

export type CellType = 'R' | 'G' | 'C';

export interface VoronoiNodeData {
  id: number;
  /**
   * Junction name based on adjacent cell colors. For a node touching all three
   * colors (C, R, G once each), the name is the clockwise sequence starting at
   * C — "CRG" or "CGR" (these are what CW/CCW below distinguish). Otherwise
   * the name is the three cell types sorted by fixed precedence C, G, R (e.g.
   * a corner of one C and two G cells is "CGG") — rotationally symmetric, so
   * there's no ambiguity to resolve.
   */
  name: string;
  /** True if clockwise rotation around this node gives C→R→G (only set when C=R=G=1). */
  CW?: true;
  /** True if clockwise rotation around this node gives C→G→R (only set when C=R=G=1). */
  CCW?: true;
  /** True if v1 (lo move endpoint) can reach this node via an uncrossed blue arc. */
  linksToV1?: true;
  /** True if v2 (hi move endpoint) can reach this node via an uncrossed blue arc. */
  linksToV2?: true;
}

export interface VoronoiEdgeData {
  nodeA: number;
  nodeB: number;
  R: number;
  G: number;
  C: number;
}

export interface VoronoiGraph {
  /** Total number of Voronoi nodes (junctions) before filtering. */
  nodeCount: number;
  /** Nodes where at least one of CW, CCW, linksToV1, linksToV2 is true. */
  nodes: VoronoiNodeData[];
  /** All Voronoi edges adjacent to at least one C cell.
   *  C-R and C-G edges are directed so C is on the right (CW side). */
  phase1: VoronoiEdgeData[];
  /** Voronoi edges that are not C-C and not R-R.
   *  R-G and C-G edges are directed so G is on the left (CCW side). */
  phase2: VoronoiEdgeData[];
}

export interface VoronoiFullEdge {
  nodeA: number;
  nodeB: number;
}

/**
 * One directed, named half of a Voronoi dual edge. Differently-colored
 * neighbors (e.g. C/G) get a 2-letter name — first letter is the cell on the
 * left when facing from nodeA to nodeB ("up"). Same-color neighbors (R/R or
 * G/G) get color+"A"/"B"; C/C neighbors get "CI"/"CO" — which physical side
 * is A vs B / I vs O is arbitrary for now (deferred). Edges bordering a C
 * cell and a non-C cell get a second, further-offset pair with "2" appended
 * to the name (e.g. "CG2"/"GC2").
 */
export interface VoronoiEdgeName {
  nodeA: number;
  nodeB: number;
  name: string;
}

export interface VoronoiData {
  graph: VoronoiGraph;
  /** Circumcenter positions indexed by node id. */
  circumcenters: SpherePoint[];
  /** Synthetic seeds inserted at crowded-junction centroids, with their hue. */
  extraSeeds: { pos: SpherePoint; hue: number }[];
  /** Every Voronoi junction (one per Delaunay triangle), unfiltered by CW/CCW/linksToV1/linksToV2. */
  fullNodes: VoronoiNodeData[];
  /** Every Voronoi dual edge between two triangles sharing a Delaunay edge (undirected, one entry per pair). Edges crossing an existing sprout stroke are excluded entirely. */
  fullEdges: VoronoiFullEdge[];
  /** Directed, named edges — see VoronoiEdgeName. Same exclusions as fullEdges. */
  namedEdges: VoronoiEdgeName[];
  /** Node ids with some path (via fullEdges) to a node bordering a C cell. Nodes not in this set should be dropped along with their edges. */
  survivingNodeIds: number[];
}

// ---------------------------------------------------------------------------

function classify(hue: number): CellType {
  if (hue === -2) return 'R';
  if (hue === -3) return 'G';
  return 'C';
}

const CELL_TYPE_PRIORITY: Record<CellType, number> = { C: 0, G: 1, R: 2 };

/**
 * Junction name from its 3 adjacent cell types (in CCW order). If all three
 * differ, names clockwise starting at C ("CRG"/"CGR" — same distinction as
 * CW/CCW). Otherwise sorts by fixed precedence C, G, R — rotationally
 * symmetric, so there's nothing else to disambiguate.
 */
function junctionName(cellTypesCCW: CellType[]): string {
  if (new Set(cellTypesCCW).size === 3) {
    const cIdx = cellTypesCCW.indexOf('C');
    const cw1 = cellTypesCCW[(cIdx + 2) % 3]; // predecessor in CCW order = successor clockwise
    const cw2 = cellTypesCCW[(cIdx + 1) % 3];
    return cellTypesCCW[cIdx] + cw1 + cw2;
  }
  return [...cellTypesCCW].sort((a, b) => CELL_TYPE_PRIORITY[a] - CELL_TYPE_PRIORITY[b]).join('');
}

/**
 * Whether segment A-B crosses any sprout edge, testing against a straight
 * geodesic between each edge's own two *vertex* endpoints rather than its
 * rendered polyline. A bulge in the drawn curve shouldn't spuriously cut a
 * Voronoi edge that's topologically fine; the game only cares which cells
 * are adjacent, not how a stroke happens to be smoothed.
 */
function sproutsCrossesStraight(state: GameState, A: SpherePoint, B: SpherePoint): boolean {
  for (const edge of state.edges.values()) {
    const v1 = state.vertices.get(edge.v1);
    const v2 = state.vertices.get(edge.v2);
    if (!v1 || !v2) continue;
    if (arcsCross(A, B, v1.pos, v2.pos)) return true;
  }
  return false;
}

/** Every sprout edge whose straight vertex-to-vertex geodesic crosses segment A-B. */
function findBlockingEdges(state: GameState, A: SpherePoint, B: SpherePoint): Edge[] {
  const blocking: Edge[] = [];
  for (const edge of state.edges.values()) {
    const v1 = state.vertices.get(edge.v1);
    const v2 = state.vertices.get(edge.v2);
    if (!v1 || !v2) continue;
    if (arcsCross(A, B, v1.pos, v2.pos)) blocking.push(edge);
  }
  return blocking;
}

/** How many times an edge's real (rendered) polyline crosses segment A-B. */
function countPolylineCrossings(edge: Edge, A: SpherePoint, B: SpherePoint): number {
  let count = 0;
  for (let m = 0; m < edge.points.length - 1; m++) {
    if (arcsCross(A, B, edge.points[m], edge.points[m + 1])) count++;
  }
  return count;
}

interface EdgeBlockInfo {
  blocked: boolean;
  /** The straight-line-crossing sprout edges responsible, kept for the degree-1 rescue check below. */
  blockingEdges: Edge[];
}

/**
 * Precomputes, for every Delaunay edge (triangle pair sharing a side), whether
 * it's blocked by the sprout graph — shared by the phase1/phase2 and
 * fullEdges/namedEdges passes below so both agree and the crossing test only
 * runs once per pair. Key is triangle indices `${min}_${max}`.
 *
 * Rescue pass: straight-line blocking can still leave a triangle-node with
 * only one surviving neighbor (down from up to 3) if the real edge causing
 * the block happens to be genuinely in the way. When that happens, and
 * exactly one sprout edge is responsible, re-test using that edge's *real*
 * bulging polyline: if it crosses the straight dual-edge segment exactly
 * twice, the two crossings cancel out topologically (the curve dips through
 * and back out) — that block is lifted rather than isolating the node. Two
 * *different* edges each blocking once is a genuine double-block, not a
 * cheat, and is left alone.
 */
function computeBlockInfo(
  state: GameState,
  circumcenters: SpherePoint[],
  edgeToTris: Map<string, number[]>,
): Map<string, EdgeBlockInfo> {
  const blockInfo = new Map<string, EdgeBlockInfo>();
  for (const tris of edgeToTris.values()) {
    if (tris.length !== 2) continue;
    const [t0, t1] = tris;
    const triKey = t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;
    if (blockInfo.has(triKey)) continue;
    const blockingEdges = findBlockingEdges(state, circumcenters[t0], circumcenters[t1]);
    blockInfo.set(triKey, { blocked: blockingEdges.length > 0, blockingEdges });
  }

  const nodeDegree = new Map<number, number>();
  const bump = (id: number, delta: number): void => { nodeDegree.set(id, (nodeDegree.get(id) ?? 0) + delta); };
  for (const [triKey, info] of blockInfo) {
    if (info.blocked) continue;
    const [a, b] = triKey.split('_').map(Number);
    bump(a, 1); bump(b, 1);
  }

  for (const [triKey, info] of blockInfo) {
    if (!info.blocked || info.blockingEdges.length !== 1) continue;
    const [a, b] = triKey.split('_').map(Number);
    if ((nodeDegree.get(a) ?? 0) !== 1 && (nodeDegree.get(b) ?? 0) !== 1) continue;
    const crossCount = countPolylineCrossings(info.blockingEdges[0], circumcenters[a], circumcenters[b]);
    if (crossCount === 2) {
      info.blocked = false;
      if ((nodeDegree.get(a) ?? 0) === 1) bump(a, 1);
      if ((nodeDegree.get(b) ?? 0) === 1) bump(b, 1);
    }
  }

  return blockInfo;
}

/** Scalar triple product: ccA · (ccB × seed). Positive → seed is on the left (CCW) side of ccA→ccB. */
function sideSign(ccA: SpherePoint, ccB: SpherePoint, seed: SpherePoint): number {
  const cx = ccB.y * seed.z - ccB.z * seed.y;
  const cy = ccB.z * seed.x - ccB.x * seed.z;
  const cz = ccB.x * seed.y - ccB.y * seed.x;
  return ccA.x * cx + ccA.y * cy + ccA.z * cz;
}

export function buildVoronoiGraph(
  state: GameState,
  hl: SubregionHighlight,
  v1: number,
  v2: number,
): VoronoiData {
  const emptyGraph: VoronoiGraph = { nodeCount: 0, nodes: [], phase1: [], phase2: [] };
  const empty: VoronoiData = { graph: emptyGraph, circumcenters: [], extraSeeds: [], fullNodes: [], fullEdges: [], namedEdges: [], survivingNodeIds: [] };

  // Seed list — all region-boundary vertices appearing in the highlight.
  // `isExtraSeed` (not a sentinel vertexId) marks synthetic centroid seeds
  // added below for crowded junctions — vertexId alone can't be used for
  // that, since real spot vertex ids include small negatives like -1 too.
  const seedPts: { pos: SpherePoint; vertexId: number; hue: number; isExtraSeed?: boolean }[] = [];
  for (const cell of hl.cells) {
    const v = state.vertices.get(cell.vertexId);
    if (v) seedPts.push({ pos: v.pos, vertexId: cell.vertexId, hue: cell.hue });
  }
  const n = seedPts.length;
  if (n < 3) return empty;

  // -------------------------------------------------------------------------
  // Spherical Delaunay triangulation — brute-force O(n^4).
  // Circumcenter of (a,b,c): normalize((a-b)×(a-c)), sign chosen so it has
  // positive dot product with a (sits on the same hemisphere as the seeds).
  // Delaunay condition: no other seed is strictly closer to the circumcenter.
  // -------------------------------------------------------------------------
  const triangles: [number, number, number][] = [];
  const circumcenters: SpherePoint[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = seedPts[i].pos, b = seedPts[j].pos, c = seedPts[k].pos;
        const abx = a.x - b.x, aby = a.y - b.y, abz = a.z - b.z;
        const acx = a.x - c.x, acy = a.y - c.y, acz = a.z - c.z;
        let ccx = aby * acz - abz * acy;
        let ccy = abz * acx - abx * acz;
        let ccz = abx * acy - aby * acx;
        const len = Math.sqrt(ccx * ccx + ccy * ccy + ccz * ccz);
        if (len < 1e-10) continue;
        ccx /= len; ccy /= len; ccz /= len;
        if (ccx * a.x + ccy * a.y + ccz * a.z < 0) { ccx = -ccx; ccy = -ccy; ccz = -ccz; }
        const threshold = ccx * a.x + ccy * a.y + ccz * a.z;
        let valid = true;
        for (let l = 0; l < n; l++) {
          if (l === i || l === j || l === k) continue;
          if (ccx * seedPts[l].pos.x + ccy * seedPts[l].pos.y + ccz * seedPts[l].pos.z > threshold + 1e-10) {
            valid = false; break;
          }
        }
        if (!valid) continue;
        triangles.push([i, j, k]);
        circumcenters.push({ x: ccx, y: ccy, z: ccz });
      }
    }
  }

  // ── Insert synthetic seeds at crowded-junction centroids ───────────────────
  // If any group of circumcenters is clustered within 3 arc-degrees of each
  // other, their centroid is added as a new Voronoi seed and the whole
  // triangulation is rerun. Cell type: G if any adjacent cell was G; else R if
  // any was R; else C.
  const CLUSTER_COS = Math.cos(3 * Math.PI / 180);
  const ufPar = Array.from({ length: circumcenters.length }, (_, i) => i);
  const ufFind = (x: number): number => {
    while (ufPar[x] !== x) { ufPar[x] = ufPar[ufPar[x]]; x = ufPar[x]; }
    return x;
  };
  for (let i = 0; i < circumcenters.length; i++) {
    for (let j = i + 1; j < circumcenters.length; j++) {
      const ci = circumcenters[i], cj = circumcenters[j];
      if (ci.x * cj.x + ci.y * cj.y + ci.z * cj.z > CLUSTER_COS) ufPar[ufFind(i)] = ufFind(j);
    }
  }
  const clusterGroups = new Map<number, number[]>();
  for (let i = 0; i < circumcenters.length; i++) {
    const root = ufFind(i);
    if (!clusterGroups.has(root)) clusterGroups.set(root, []);
    clusterGroups.get(root)!.push(i);
  }
  const extraSeeds: { pos: SpherePoint; hue: number }[] = [];
  for (const members of clusterGroups.values()) {
    if (members.length < 2) continue;
    // Centroid of the cluster (normalized).
    const clusterPts = members.map(m => circumcenters[m]);
    let sumLen = 0;
    for (const p of clusterPts) sumLen += Math.hypot(p.x, p.y, p.z);
    if (sumLen < 1e-12) continue;
    const centroid: SpherePoint = sphereCentroid(clusterPts);
    // Collect cell types from every triangle in the cluster.
    let hasG = false, hasR = false;
    for (const m of members) {
      for (const si of triangles[m]) {
        const t = classify(seedPts[si].hue);
        if (t === 'G') hasG = true;
        if (t === 'R') hasR = true;
      }
    }
    const hue = hasG ? -3 : hasR ? -2 : 0;
    extraSeeds.push({ pos: centroid, hue });
    seedPts.push({ pos: centroid, vertexId: -1, hue, isExtraSeed: true });
  }
  const addedSeed = extraSeeds.length > 0;

  // If new seeds were added, rerun the full Delaunay triangulation.
  if (addedSeed) {
    triangles.length = 0;
    circumcenters.length = 0;
    const m = seedPts.length;
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        for (let k = j + 1; k < m; k++) {
          const a = seedPts[i].pos, b = seedPts[j].pos, c = seedPts[k].pos;
          const abx = a.x - b.x, aby = a.y - b.y, abz = a.z - b.z;
          const acx = a.x - c.x, acy = a.y - c.y, acz = a.z - c.z;
          let ccx = aby * acz - abz * acy;
          let ccy = abz * acx - abx * acz;
          let ccz = abx * acy - aby * acx;
          const clen = Math.sqrt(ccx * ccx + ccy * ccy + ccz * ccz);
          if (clen < 1e-10) continue;
          ccx /= clen; ccy /= clen; ccz /= clen;
          if (ccx * a.x + ccy * a.y + ccz * a.z < 0) { ccx = -ccx; ccy = -ccy; ccz = -ccz; }
          const threshold = ccx * a.x + ccy * a.y + ccz * a.z;
          let valid = true;
          for (let l = 0; l < m; l++) {
            if (l === i || l === j || l === k) continue;
            if (ccx * seedPts[l].pos.x + ccy * seedPts[l].pos.y + ccz * seedPts[l].pos.z > threshold + 1e-10) {
              valid = false; break;
            }
          }
          if (!valid) continue;
          triangles.push([i, j, k]);
          circumcenters.push({ x: ccx, y: ccy, z: ccz });
        }
      }
    }
  }

  // Delaunay edge "minIdx_maxIdx" → triangle indices that share it.
  const edgeToTris = new Map<string, number[]>();
  for (let ti = 0; ti < triangles.length; ti++) {
    const [ii, jj, kk] = triangles[ti];
    for (const [a2, b2] of [[ii, jj], [jj, kk], [ii, kk]] as [number, number][]) {
      const key = a2 < b2 ? `${a2}_${b2}` : `${b2}_${a2}`;
      if (!edgeToTris.has(key)) edgeToTris.set(key, []);
      edgeToTris.get(key)!.push(ti);
    }
  }

  // Blocking decision per Delaunay edge, shared by phase1/phase2 and
  // fullEdges/namedEdges below (see computeBlockInfo for the straight-line +
  // degree-1 rescue logic).
  const blockInfo = computeBlockInfo(state, circumcenters, edgeToTris);

  // Seed indices and positions for the two move endpoints.
  const si1 = seedPts.findIndex(s => s.vertexId === v1);
  const si2 = seedPts.findIndex(s => s.vertexId === v2);
  const vPos1 = state.vertices.get(v1)?.pos;
  const vPos2 = state.vertices.get(v2)?.pos;

  // -------------------------------------------------------------------------
  // Build all nodes (one per Delaunay triangle = Voronoi junction).
  // -------------------------------------------------------------------------
  const allNodes: VoronoiNodeData[] = triangles.map(([i, j, k], ti) => {
    const cc = circumcenters[ti];
    const si = seedPts[i].pos, sj = seedPts[j].pos, sk = seedPts[k].pos;

    const ex = sj.x - si.x, ey = sj.y - si.y, ez = sj.z - si.z;
    const fx = sk.x - si.x, fy = sk.y - si.y, fz = sk.z - si.z;
    const ccwTest = (ey * fz - ez * fy) * cc.x + (ez * fx - ex * fz) * cc.y + (ex * fy - ey * fx) * cc.z;
    const [oi, oj, ok] = ccwTest > 0 ? [i, j, k] : [i, k, j];

    const cellTypes: CellType[] = [
      classify(seedPts[oi].hue),
      classify(seedPts[oj].hue),
      classify(seedPts[ok].hue),
    ];

    const R = cellTypes.filter(c => c === 'R').length;
    const G = cellTypes.filter(c => c === 'G').length;
    const C = cellTypes.filter(c => c === 'C').length;

    let CW = false, CCW = false;
    if (C === 1 && R === 1 && G === 1) {
      const cIdx = cellTypes.indexOf('C');
      const prev = cellTypes[(cIdx - 1 + cellTypes.length) % cellTypes.length];
      CW = prev === 'R';
      CCW = !CW;
    }

    const name = junctionName(cellTypes);

    const inTri = (s: number) => triangles[ti].includes(s);
    const linksToV1 = si1 >= 0 && inTri(si1) && vPos1 !== undefined
      ? !sproutsCrossesStraight(state, vPos1, cc) : false;
    const linksToV2 = si2 >= 0 && inTri(si2) && vPos2 !== undefined
      ? !sproutsCrossesStraight(state, vPos2, cc) : false;

    const node: VoronoiNodeData = { id: ti, name };
    if (CW) node.CW = true;
    if (CCW) node.CCW = true;
    if (linksToV1) node.linksToV1 = true;
    if (linksToV2) node.linksToV2 = true;
    return node;
  });

  // Filter: only keep nodes where at least one flag is set.
  const nodes = allNodes.filter(nd => nd.CW || nd.CCW || nd.linksToV1 || nd.linksToV2);

  // -------------------------------------------------------------------------
  // Build edges (one per Delaunay edge shared by exactly 2 triangles).
  // -------------------------------------------------------------------------
  const phase1: VoronoiEdgeData[] = [];
  const phase2: VoronoiEdgeData[] = [];

  for (const [key, tris] of edgeToTris) {
    if (tris.length !== 2) continue;
    const [a2, b2] = key.split('_').map(Number);
    const typeA = classify(seedPts[a2].hue);
    const typeB = classify(seedPts[b2].hue);
    const R = (typeA === 'R' ? 1 : 0) + (typeB === 'R' ? 1 : 0);
    const G = (typeA === 'G' ? 1 : 0) + (typeB === 'G' ? 1 : 0);
    const C = (typeA === 'C' ? 1 : 0) + (typeB === 'C' ? 1 : 0);
    const triKey = tris[0] < tris[1] ? `${tris[0]}_${tris[1]}` : `${tris[1]}_${tris[0]}`;
    if (blockInfo.get(triKey)?.blocked) continue;
    const hasC = C > 0;
    const isCC = C === 2;
    const isRR = R === 2;
    const isCR = C === 1 && R === 1;

    if (hasC) {
      let [nA, nB] = [tris[0], tris[1]];
      if (C === 1) {
        const seedC = typeA === 'C' ? seedPts[a2].pos : seedPts[b2].pos;
        if (sideSign(circumcenters[nA], circumcenters[nB], seedC) > 0) [nA, nB] = [nB, nA];
      }
      phase1.push({ nodeA: nA, nodeB: nB, R, G, C });
    }

    if (!isCC && !isRR && !isCR) {
      let [nA, nB] = [tris[0], tris[1]];
      if (G === 1) {
        const seedG = typeA === 'G' ? seedPts[a2].pos : seedPts[b2].pos;
        if (sideSign(circumcenters[nA], circumcenters[nB], seedG) < 0) [nA, nB] = [nB, nA];
      }
      phase2.push({ nodeA: nA, nodeB: nB, R, G, C });
    }
  }

  const graph: VoronoiGraph = { nodeCount: triangles.length, nodes, phase1, phase2 };

  // -------------------------------------------------------------------------
  // Full topology for the graph viewer: every non-blocked Voronoi dual edge,
  // both as a plain undirected pair (fullEdges) and as named directed halves
  // (namedEdges). Edges that cross an existing sprout stroke are dropped
  // entirely (not just visually — they don't count for connectivity either).
  // -------------------------------------------------------------------------
  const fullEdges: VoronoiFullEdge[] = [];
  const namedEdges: VoronoiEdgeName[] = [];

  for (const [key, tris] of edgeToTris) {
    if (tris.length !== 2) continue;
    const triKey = tris[0] < tris[1] ? `${tris[0]}_${tris[1]}` : `${tris[1]}_${tris[0]}`;
    if (blockInfo.get(triKey)?.blocked) continue;

    const [t0, t1] = tris;
    fullEdges.push({ nodeA: t0, nodeB: t1 });

    const [a2, b2] = key.split('_').map(Number);
    const typeA = classify(seedPts[a2].hue);
    const typeB = classify(seedPts[b2].hue);
    const aIsLeft = sideSign(circumcenters[t0], circumcenters[t1], seedPts[a2].pos) > 0;
    const leftType = aIsLeft ? typeA : typeB;
    const rightType = aIsLeft ? typeB : typeA;

    if (leftType === rightType) {
      if (leftType === 'C') {
        namedEdges.push({ nodeA: t0, nodeB: t1, name: 'CI' });
        namedEdges.push({ nodeA: t1, nodeB: t0, name: 'CO' });
      } else {
        namedEdges.push({ nodeA: t0, nodeB: t1, name: `${leftType}A` });
        namedEdges.push({ nodeA: t1, nodeB: t0, name: `${leftType}B` });
      }
    } else {
      const dir1 = leftType + rightType;
      const dir2 = rightType + leftType;
      namedEdges.push({ nodeA: t0, nodeB: t1, name: dir1 });
      namedEdges.push({ nodeA: t1, nodeB: t0, name: dir2 });
      if (leftType === 'C' || rightType === 'C') {
        namedEdges.push({ nodeA: t0, nodeB: t1, name: dir1 + '2' });
        namedEdges.push({ nodeA: t1, nodeB: t0, name: dir2 + '2' });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Bridge over isolated artificial (extra-seed) nodes. A crowded-junction
  // centroid's own triangle can end up with every one of its dual edges
  // blocked (see computeBlockInfo), losing that corner from the graph
  // entirely. Rather than dropping it silently, splice a direct edge between
  // the pair of neighbors that share the corner's other two sides — the same
  // two colors continue right through where the missing corner used to be,
  // so the edge name carries over unchanged (computed exactly like any other
  // named edge, from the shared color pair and sideSign). The third neighbor
  // (a different color pair) has no continuation partner and is skipped.
  // ---------------------------------------------------------------------------
  if (addedSeed) {
    const isArtificial = (ti: number): boolean => triangles[ti].some(si => seedPts[si].isExtraSeed);
    const survivingSet = new Set<number>();
    for (const e of fullEdges) { survivingSet.add(e.nodeA); survivingSet.add(e.nodeB); }

    for (let ti = 0; ti < triangles.length; ti++) {
      if (survivingSet.has(ti)) continue;
      if (!isArtificial(ti)) continue;

      const [i, j, k] = triangles[ti];
      const sides = ([[i, j], [j, k], [i, k]] as [number, number][]).map(pair => {
        const tA = classify(seedPts[pair[0]].hue), tB = classify(seedPts[pair[1]].hue);
        return { pair, typePair: [tA, tB].sort().join('') };
      });

      // Find the two sides sharing the same unordered color pair.
      let matchIdx: [number, number] | null = null;
      for (let a = 0; a < sides.length && !matchIdx; a++) {
        for (let b = a + 1; b < sides.length; b++) {
          if (sides[a].typePair === sides[b].typePair) { matchIdx = [a, b]; break; }
        }
      }
      if (!matchIdx) {
        if (DEBUG.recreate) console.warn(`[voronoiGraph] artificial node ${ti} lost entirely (all 3 sides differently colored) — no bridge possible`);
        continue;
      }

      const neighborOf = (pair: [number, number]): number | null => {
        const key = pair[0] < pair[1] ? `${pair[0]}_${pair[1]}` : `${pair[1]}_${pair[0]}`;
        const nbTris = edgeToTris.get(key);
        if (!nbTris || nbTris.length !== 2) return null;
        return nbTris[0] === ti ? nbTris[1] : nbTris[0];
      };
      const n1 = neighborOf(sides[matchIdx[0]].pair);
      const n2 = neighborOf(sides[matchIdx[1]].pair);
      if (n1 === null || n2 === null || n1 === n2) continue;

      const [seedA, seedB] = sides[matchIdx[0]].pair;
      const typeA = classify(seedPts[seedA].hue), typeB = classify(seedPts[seedB].hue);
      const aIsLeft = sideSign(circumcenters[n1], circumcenters[n2], seedPts[seedA].pos) > 0;
      const leftType = aIsLeft ? typeA : typeB;
      const rightType = aIsLeft ? typeB : typeA;

      fullEdges.push({ nodeA: n1, nodeB: n2 });
      if (leftType === rightType) {
        if (leftType === 'C') {
          namedEdges.push({ nodeA: n1, nodeB: n2, name: 'CI' });
          namedEdges.push({ nodeA: n2, nodeB: n1, name: 'CO' });
        } else {
          namedEdges.push({ nodeA: n1, nodeB: n2, name: `${leftType}A` });
          namedEdges.push({ nodeA: n2, nodeB: n1, name: `${leftType}B` });
        }
      } else {
        const dir1 = leftType + rightType;
        const dir2 = rightType + leftType;
        namedEdges.push({ nodeA: n1, nodeB: n2, name: dir1 });
        namedEdges.push({ nodeA: n2, nodeB: n1, name: dir2 });
        if (leftType === 'C' || rightType === 'C') {
          namedEdges.push({ nodeA: n1, nodeB: n2, name: dir1 + '2' });
          namedEdges.push({ nodeA: n2, nodeB: n1, name: dir2 + '2' });
        }
      }
    }
  }

  // Prune: a node survives if it borders a non-C cell (name !== 'CCC') and can
  // reach some node bordering C, OR it's a pure 'CCC' node and can reach some
  // node bordering a non-C cell (R or G). Non-CCC nodes trivially satisfy the
  // "reach a C node" half themselves whenever they border C at all, so this
  // only meaningfully restricts (a) fully-non-C nodes (GGG/GRR/etc, unchanged
  // from before) and (b) interior 'CCC' nodes with no route out to the R/G
  // boundary (new).
  const adjacency = new Map<number, number[]>();
  const addAdjacency = (from: number, to: number): void => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(to);
  };
  for (const e of fullEdges) { addAdjacency(e.nodeA, e.nodeB); addAdjacency(e.nodeB, e.nodeA); }

  const floodFrom = (seedIds: number[]): Set<number> => {
    const visited = new Set(seedIds);
    const stack = [...seedIds];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (!visited.has(next)) { visited.add(next); stack.push(next); }
      }
    }
    return visited;
  };
  const reachableToC = floodFrom(allNodes.filter(nd => nd.name.includes('C')).map(nd => nd.id));
  const reachableToNonC = floodFrom(allNodes.filter(nd => nd.name !== 'CCC').map(nd => nd.id));

  const survivingNodeIds = allNodes
    .filter(nd => nd.name === 'CCC' ? reachableToNonC.has(nd.id) : reachableToC.has(nd.id))
    .map(nd => nd.id);

  return { graph, circumcenters, extraSeeds, fullNodes: allNodes, fullEdges, namedEdges, survivingNodeIds };
}
