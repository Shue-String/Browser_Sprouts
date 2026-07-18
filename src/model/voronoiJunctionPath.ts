/**
 * Junction-color-name-based path system: V1/V2 endpoints, the central C/non-C
 * boundary cycle traversal, and the Last->Exit stitching. Supersedes the old
 * three-phase findVoronoiPath algorithm entirely (see project memory).
 */

import type { VoronoiData, VoronoiEdgeName } from './voronoiGraph';
import type { SpherePoint } from '../math/sphere';
import { slerp } from '../math/sphere';
import { DEBUG } from '../debug/flags';

export interface JunctionPathStep {
  fromNode: number;
  toNode: number;
  /** The specific directed named edge used for this hop (e.g. "CG", "GC2", "RA", "CI"). */
  edgeName: string;
}

export interface JunctionPathResult {
  nodeIds: number[]; // start..end inclusive
  steps: JunctionPathStep[];
  endNode: number;
}

export interface V1SequenceResult extends JunctionPathResult {
  /** First node the linksToV1 search reaches that borders a non-C cell (may be the start node itself). */
  enterNode: number;
  /** The "CGR"-named node reached via the GC/RC-only continuation from enterNode (may equal enterNode). */
  cgr1Node: number;
}

export interface V2SequenceResult extends JunctionPathResult {
  /** Where the V2 search ends — either the first non-C node found avoiding the V1 path, or CGR1 via the CG2/CR2 fallback. */
  exitNode: number;
  /** True if the direct search was blocked by the V1 path and the CG2/CR2 fallback was used instead. */
  usedFallback: boolean;
}

export interface LastSegmentResult extends JunctionPathResult {
  /** The first 'CRG' node reached walking backwards against the central cycle from CGR1. */
  lastNode: number;
}

export interface LastToExitResult extends JunctionPathResult {
  /** True if the direct GC-around-the-cycle attempt was skipped/blocked and the CR2/CG2 ring fallback was used instead. */
  usedFallback: boolean;
  /** True if the fallback additionally had to reroute its Last->Enter portion via RC2/GC2 because it passed through Enter. */
  usedEnterOverride: boolean;
}

export interface FullPathResult extends JunctionPathResult {}

function buildUndirectedAdjacency(data: VoronoiData): Map<number, number[]> {
  const adjacency = new Map<number, number[]>();
  const add = (from: number, to: number): void => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(to);
  };
  for (const e of data.fullEdges) { add(e.nodeA, e.nodeB); add(e.nodeB, e.nodeA); }
  return adjacency;
}

/** Directed adjacency restricted to named edges whose name is in `allowedNames`. */
function buildDirectedAdjacency(data: VoronoiData, allowedNames: Set<string>): Map<number, VoronoiEdgeName[]> {
  const adjacency = new Map<number, VoronoiEdgeName[]>();
  for (const e of data.namedEdges) {
    if (!allowedNames.has(e.name)) continue;
    if (!adjacency.has(e.nodeA)) adjacency.set(e.nodeA, []);
    adjacency.get(e.nodeA)!.push(e);
  }
  return adjacency;
}

interface BfsResult { dist: Map<number, number>; prev: Map<number, number> }

function bfsMultiSourceUndirected(sources: number[], adjacency: Map<number, number[]>, forbidden: Set<number>): BfsResult {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const queue: number[] = [];
  for (const s of sources) {
    if (forbidden.has(s) || dist.has(s)) continue;
    dist.set(s, 0);
    queue.push(s);
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const next of adjacency.get(cur) ?? []) {
      if (forbidden.has(next) || dist.has(next)) continue;
      dist.set(next, dist.get(cur)! + 1);
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return { dist, prev };
}

function bfsMultiSourceDirected(
  sources: number[],
  adjacency: Map<number, VoronoiEdgeName[]>,
  forbidden: Set<number> = new Set(),
): { dist: Map<number, number>; prevEdge: Map<number, VoronoiEdgeName> } {
  const dist = new Map<number, number>();
  const prevEdge = new Map<number, VoronoiEdgeName>();
  const queue: number[] = [];
  for (const s of sources) {
    if (!dist.has(s)) { dist.set(s, 0); queue.push(s); }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const e of adjacency.get(cur) ?? []) {
      if (forbidden.has(e.nodeB) || dist.has(e.nodeB)) continue;
      dist.set(e.nodeB, dist.get(cur)! + 1);
      prevEdge.set(e.nodeB, e);
      queue.push(e.nodeB);
    }
  }
  return { dist, prevEdge };
}

/** Among reached nodes matching `predicate`, the ones at the smallest distance (ties possible), lowest id first. */
function nearestMatches(dist: Map<number, number>, predicate: (id: number) => boolean): { distance: number; nodes: number[] } | null {
  let best = Infinity;
  let nodes: number[] = [];
  for (const [id, d] of dist) {
    if (!predicate(id)) continue;
    if (d < best) { best = d; nodes = [id]; }
    else if (d === best) nodes.push(id);
  }
  if (nodes.length === 0) return null;
  nodes.sort((a, b) => a - b);
  return { distance: best, nodes };
}

/** Picks whichever directed/undirected named edge connects `from` -> `to`, preferring the non-"2" variant. */
function edgeNameFor(data: VoronoiData, from: number, to: number): string {
  let fallback: string | undefined;
  for (const e of data.namedEdges) {
    if (e.nodeA !== from || e.nodeB !== to) continue;
    if (!e.name.endsWith('2')) return e.name;
    fallback = e.name;
  }
  return fallback ?? '?';
}

function reconstructUndirected(data: VoronoiData, prev: Map<number, number>, end: number): JunctionPathResult {
  const nodeIds: number[] = [end];
  const steps: JunctionPathStep[] = [];
  let cur = end;
  while (prev.has(cur)) {
    const p = prev.get(cur)!;
    steps.push({ fromNode: p, toNode: cur, edgeName: edgeNameFor(data, p, cur) });
    nodeIds.push(p);
    cur = p;
  }
  nodeIds.reverse();
  steps.reverse();
  return { nodeIds, steps, endNode: end };
}

function reconstructDirected(prevEdge: Map<number, VoronoiEdgeName>, sources: Set<number>, end: number): JunctionPathResult {
  const nodeIds: number[] = [end];
  const steps: JunctionPathStep[] = [];
  let cur = end;
  while (!sources.has(cur) && prevEdge.has(cur)) {
    const e = prevEdge.get(cur)!;
    steps.push({ fromNode: e.nodeA, toNode: e.nodeB, edgeName: e.name });
    nodeIds.push(e.nodeA);
    cur = e.nodeA;
  }
  nodeIds.reverse();
  steps.reverse();
  return { nodeIds, steps, endNode: end };
}

/** Walks a path backwards, re-resolving each hop's edge name for the reversed direction. */
function reverseJunctionPath(data: VoronoiData, path: JunctionPathResult): JunctionPathResult {
  const nodeIds = [...path.nodeIds].reverse();
  const steps: JunctionPathStep[] = [];
  for (let i = path.steps.length - 1; i >= 0; i--) {
    const s = path.steps[i];
    steps.push({ fromNode: s.toNode, toNode: s.fromNode, edgeName: edgeNameFor(data, s.toNode, s.fromNode) });
  }
  return { nodeIds, steps, endNode: nodeIds[nodeIds.length - 1] };
}

/**
 * V1 side: shortest hop-path from any linksToV1 node to any non-'CCC' node
 * ("Enter"), then — among all equally-short such arrivals — whichever has the
 * shortest continuation via GC/RC-only directed edges to a node named "CGR"
 * ("CGR1"). 0 hops at either stage is fine.
 */
export function computeV1Sequence(data: VoronoiData): V1SequenceResult | null {
  const surviving = new Set(data.survivingNodeIds);
  const sources = data.graph.nodes.filter(n => n.linksToV1 && surviving.has(n.id)).map(n => n.id);
  if (sources.length === 0) return null;

  const undirected = buildUndirectedAdjacency(data);
  const { dist, prev } = bfsMultiSourceUndirected(sources, undirected, new Set());
  const nameOf = (id: number): string => data.fullNodes[id]?.name ?? '';
  const arrivals = nearestMatches(dist, id => nameOf(id) !== 'CCC');
  if (!arrivals) return null;

  const directed = buildDirectedAdjacency(data, new Set(['GC', 'RC']));
  const { dist: dist2, prevEdge } = bfsMultiSourceDirected(arrivals.nodes, directed);
  const cgrMatches = nearestMatches(dist2, id => nameOf(id) === 'CGR');
  if (!cgrMatches) return null;

  // Walk back from the winning CGR1 node via the directed continuation to find
  // which tied arrival ("Enter" candidate) it actually originated from.
  let enterNode = cgrMatches.nodes[0];
  while (prevEdge.has(enterNode)) enterNode = prevEdge.get(enterNode)!.nodeA;

  const primary = reconstructUndirected(data, prev, enterNode);
  const secondary = reconstructDirected(prevEdge, new Set(arrivals.nodes), cgrMatches.nodes[0]);

  return {
    nodeIds: [...primary.nodeIds, ...secondary.nodeIds.slice(1)],
    steps: [...primary.steps, ...secondary.steps],
    endNode: cgrMatches.nodes[0],
    enterNode,
    cgr1Node: cgrMatches.nodes[0],
  };
}

/**
 * V2 side: shortest hop-path from any linksToV2 node to any non-'CCC' node,
 * avoiding every node on the V1 sequence except CGR1 (which stays open).
 * If no such path exists, falls back to: nearest non-'CCC' node to linksToV2
 * (unrestricted this time), then walk forward via CG2/CR2-only directed
 * edges until CGR1 is reached.
 */
export function computeV2Sequence(data: VoronoiData, v1: V1SequenceResult): V2SequenceResult | null {
  const surviving = new Set(data.survivingNodeIds);
  const sources = data.graph.nodes.filter(n => n.linksToV2 && surviving.has(n.id)).map(n => n.id);
  if (sources.length === 0) return null;

  const undirected = buildUndirectedAdjacency(data);
  const nameOf = (id: number): string => data.fullNodes[id]?.name ?? '';

  const forbidden = new Set(v1.nodeIds.filter(id => id !== v1.cgr1Node));
  const { dist, prev } = bfsMultiSourceUndirected(sources, undirected, forbidden);
  const direct = nearestMatches(dist, id => nameOf(id) !== 'CCC');
  if (direct) {
    const result = reconstructUndirected(data, prev, direct.nodes[0]);
    return { ...result, exitNode: direct.nodes[0], usedFallback: false };
  }

  // Fallback: unrestricted nearest non-CCC node, then ride CG2/CR2 to CGR1.
  const { dist: distUnrestricted, prev: prevUnrestricted } = bfsMultiSourceUndirected(sources, undirected, new Set());
  const jumpOn = nearestMatches(distUnrestricted, id => nameOf(id) !== 'CCC');
  if (!jumpOn) return null;

  const toEntry = reconstructUndirected(data, prevUnrestricted, jumpOn.nodes[0]);
  const directed = buildDirectedAdjacency(data, new Set(['CG2', 'CR2']));
  const { prevEdge } = bfsMultiSourceDirected([jumpOn.nodes[0]], directed);
  const ring = reconstructDirected(prevEdge, new Set([jumpOn.nodes[0]]), v1.cgr1Node);

  return {
    nodeIds: [...toEntry.nodeIds, ...ring.nodeIds.slice(1)],
    steps: [...toEntry.steps, ...ring.steps],
    endNode: v1.cgr1Node,
    exitNode: v1.cgr1Node,
    usedFallback: true,
  };
}

/**
 * "Last": walking backwards against the central cycle from CGR1, the first
 * 'CRG' node reached. The central cycle is the C=1 subset of phase1 (the
 * C-R/C-G edges directed with C on the right, i.e. the CW walk around the C
 * blob) — CC edges are excluded since they aren't part of that ring.
 * Backwards means following nodeB -> nodeA instead of nodeA -> nodeB.
 */
function findLastNode(data: VoronoiData, cgr1Node: number): number {
  const nameOf = (id: number): string => data.fullNodes[id]?.name ?? '';
  const backward = new Map<number, number>();
  for (const e of data.graph.phase1) {
    if (e.C === 2) continue;
    backward.set(e.nodeB, e.nodeA);
  }
  let cur = cgr1Node;
  const seen = new Set([cur]);
  while (nameOf(cur) !== 'CRG') {
    const prev = backward.get(cur);
    if (prev === undefined || seen.has(prev)) break; // dead end / cycle exhausted — best effort
    cur = prev;
    seen.add(cur);
  }
  return cur;
}

/**
 * Segment from CGR1 to "Last", travelling only GC and GR named edges (both
 * oriented clockwise — same rotational sense as the central cycle).
 */
export function computeLastSegment(data: VoronoiData, cgr1Node: number): LastSegmentResult | null {
  const lastNode = findLastNode(data, cgr1Node);
  if (lastNode === cgr1Node) return { nodeIds: [cgr1Node], steps: [], endNode: cgr1Node, lastNode };

  const directed = buildDirectedAdjacency(data, new Set(['GC', 'GR']));
  const { prevEdge } = bfsMultiSourceDirected([cgr1Node], directed);
  if (!prevEdge.has(lastNode)) return null;

  const path = reconstructDirected(prevEdge, new Set([cgr1Node]), lastNode);
  return { ...path, lastNode };
}

/**
 * Segment from "Last" to "Exit". Tries the direct route first: around the
 * central cycle via GC edges only, avoiding every node already touched by
 * the V1/Last segments — skipped entirely (falls straight through) if Exit
 * is itself already touched. If that's unavailable, falls back to a CR2/CG2
 * ring walk from Last to Exit; if that ring walk happens to pass through
 * "Enter", the Last->Enter portion is rebuilt using RC2/GC2 instead (the
 * Enter->Exit tail stays on CR2/CG2).
 */
export function computeLastToExitSegment(
  data: VoronoiData,
  lastNode: number,
  enterNode: number,
  exitNode: number,
  touchedNodes: Set<number>,
): LastToExitResult | null {
  if (!touchedNodes.has(exitNode)) {
    const directDirected = buildDirectedAdjacency(data, new Set(['GC']));
    const { prevEdge } = bfsMultiSourceDirected([lastNode], directDirected, touchedNodes);
    if (lastNode === exitNode || prevEdge.has(exitNode)) {
      const path = reconstructDirected(prevEdge, new Set([lastNode]), exitNode);
      return { ...path, usedFallback: false, usedEnterOverride: false };
    }
  }

  // Fallback: CR2/CG2 ring walk from Last to Exit.
  const forwardDirected = buildDirectedAdjacency(data, new Set(['CR2', 'CG2']));
  const { prevEdge: forwardPrev } = bfsMultiSourceDirected([lastNode], forwardDirected);
  if (lastNode !== exitNode && !forwardPrev.has(exitNode)) return null;
  const forwardPath = reconstructDirected(forwardPrev, new Set([lastNode]), exitNode);

  const enterIdx = forwardPath.nodeIds.indexOf(enterNode);
  if (enterIdx <= 0) {
    return { ...forwardPath, usedFallback: true, usedEnterOverride: false };
  }

  // The ring walk passed through Enter — rebuild the Last->Enter portion via RC2/GC2.
  const backwardDirected = buildDirectedAdjacency(data, new Set(['RC2', 'GC2']));
  const { prevEdge: backwardPrev } = bfsMultiSourceDirected([lastNode], backwardDirected);
  if (lastNode !== enterNode && !backwardPrev.has(enterNode)) return null;
  const toEnter = reconstructDirected(backwardPrev, new Set([lastNode]), enterNode);

  const tailNodeIds = forwardPath.nodeIds.slice(enterIdx);
  const tailSteps = forwardPath.steps.slice(enterIdx);

  return {
    nodeIds: [...toEnter.nodeIds, ...tailNodeIds.slice(1)],
    steps: [...toEnter.steps, ...tailSteps],
    endNode: exitNode,
    usedFallback: true,
    usedEnterOverride: true,
  };
}

/**
 * Stitches the full path together: V1 (source1 -> Enter -> CGR1), Last
 * segment (CGR1 -> Last), Last->Exit segment, then the V2 segment reversed
 * (Exit -> ... -> source2, since computeV2Sequence itself walks source2 ->
 * Exit).
 */
export function computeFullPath(
  data: VoronoiData,
  v1: V1SequenceResult,
  lastSegment: LastSegmentResult,
  lastToExit: LastToExitResult,
  v2: V2SequenceResult,
): FullPathResult {
  const v2Reversed = reverseJunctionPath(data, v2);
  return {
    nodeIds: [...v1.nodeIds, ...lastSegment.nodeIds.slice(1), ...lastToExit.nodeIds.slice(1), ...v2Reversed.nodeIds.slice(1)],
    steps: [...v1.steps, ...lastSegment.steps, ...lastToExit.steps, ...v2Reversed.steps],
    endNode: v2Reversed.endNode,
  };
}

// ── Unused-cycle discovery and "squeeze" attachment ─────────────────────────
//
// The stitched V1->Enter->CGR1->Last->Exit->V2 path above only walks the
// central C/non-C boundary. Any GR (a G cell and an R cell touching, no C)
// or GC (a G cell and a C cell touching, away from the "2"-offset ring used
// by the central path) boundary elsewhere in the graph forms its own closed
// cycle that the drawn stroke must also detour through and back out of —
// "squeezing" through whichever RR/GG/CR/RC edge bridges the gap, like a
// narrow crack between two cliffs. This mirrors the old expandSeg2 side-cycle
// detour from voronoiGraphPath.ts (kept for reference), generalized to the
// named-edge system and to two cycle families (GR, GC) instead of one.

export interface UnusedCycle {
  type: 'GR' | 'GC';
  /** Node ids in cyclic order (nodeIds[i] -> nodeIds[i+1], wrapping). */
  nodeIds: number[];
}

/**
 * Directed successor chain using only namedEdges named exactly `edgeName`
 * (e.g. "GR", never its reverse "RG"), skipping any edge touching an
 * excluded node. Using a single direction keeps every hop's rotational sense
 * consistent — mixing both directed halves of the same undirected edge let
 * the walk zigzag orientation node to node, which produced self-crossing
 * detours.
 */
function buildDirectedChain(data: VoronoiData, edgeName: string, excluded: Set<number>): Map<number, number> {
  const next = new Map<number, number>();
  for (const e of data.namedEdges) {
    if (e.name !== edgeName) continue;
    if (excluded.has(e.nodeA) || excluded.has(e.nodeB)) continue;
    next.set(e.nodeA, e.nodeB);
  }
  return next;
}

/**
 * Walks each node's single-direction successor chain into a cyclic node
 * order. Since these components are meant to be closed rings with no
 * branches, following `next` from any node should return to that same node
 * — logs a warning (best-effort continues) if that double-check fails.
 */
function findCyclesFromChain(next: Map<number, number>, type: 'GR' | 'GC'): UnusedCycle[] {
  const visited = new Set<number>();
  const cycles: UnusedCycle[] = [];
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const order: number[] = [start];
    visited.add(start);
    let cur = start;
    let closed = false;
    while (true) {
      const nxt = next.get(cur);
      if (nxt === undefined) break;
      if (nxt === start) { closed = true; break; }
      if (visited.has(nxt)) break;
      order.push(nxt);
      visited.add(nxt);
      cur = nxt;
    }
    if (!closed || order.length < 3) {
      if (DEBUG.recreate) console.warn(`[voronoiJunctionPath] ${type} component starting at node ${start} is not a clean cycle (dead end or branch) — nodes: ${order.join(',')}`);
    }
    cycles.push({ type, nodeIds: order });
  }
  return cycles;
}

/**
 * `reversed` walks each cycle's opposite directed half (RG/CG instead of
 * GR/GC) — needed when the main path itself runs the opposite rotational
 * sense (the mono-boundary case, see computeMonoDirectSegment), so the
 * squeeze detour's winding matches the main path's and doesn't cross it.
 */
function findUnusedCycles(data: VoronoiData, excluded: Set<number>, reversed: boolean): UnusedCycle[] {
  const surviving = new Set(data.survivingNodeIds);
  const notSurviving = new Set<number>();
  for (const n of data.fullNodes) if (!surviving.has(n.id)) notSurviving.add(n.id);
  const fullExcluded = new Set([...excluded, ...notSurviving]);

  const grChain = buildDirectedChain(data, reversed ? 'RG' : 'GR', fullExcluded);
  const gcChain = buildDirectedChain(data, reversed ? 'CG' : 'GC', fullExcluded);
  return [...findCyclesFromChain(grChain, 'GR'), ...findCyclesFromChain(gcChain, 'GC')];
}

/** Rotates `cycle.nodeIds` to start at `entry`, then returns the full loop back to `entry` (entry included at both ends). */
function cycleLoopFrom(cycle: UnusedCycle, entry: number): number[] {
  const idx = cycle.nodeIds.indexOf(entry);
  if (idx < 0) return [entry];
  const n = cycle.nodeIds.length;
  const rotated = Array.from({ length: n }, (_, i) => cycle.nodeIds[(idx + i) % n]);
  return [...rotated, entry];
}

/** Shortest directed-edge-name path from any of `sources` to the nearest node belonging to one of `cycles`, avoiding `touched`. */
function tryAttachViaDirected(
  data: VoronoiData,
  sources: number[],
  edgeNames: Set<string>,
  touched: Set<number>,
  cycles: UnusedCycle[],
): { bridge: JunctionPathResult; cycleIdx: number } | null {
  if (sources.length === 0 || cycles.length === 0) return null;
  const directed = buildDirectedAdjacency(data, edgeNames);
  const { dist, prevEdge } = bfsMultiSourceDirected(sources, directed, touched);
  let best: { distance: number; node: number; cycleIdx: number } | null = null;
  for (let ci = 0; ci < cycles.length; ci++) {
    for (const n of cycles[ci].nodeIds) {
      if (!dist.has(n)) continue;
      const d = dist.get(n)!;
      if (!best || d < best.distance || (d === best.distance && n < best.node)) {
        best = { distance: d, node: n, cycleIdx: ci };
      }
    }
  }
  if (!best) return null;
  const bridge = reconstructDirected(prevEdge, new Set(sources), best.node);
  return { bridge, cycleIdx: best.cycleIdx };
}

/** Splices `detourNodeIds` into `path` right after the (first) occurrence of `atNode`. */
function spliceDetourAt(data: VoronoiData, path: JunctionPathResult, atNode: number, detourNodeIds: number[]): JunctionPathResult {
  const idx = path.nodeIds.indexOf(atNode);
  if (idx < 0) return path;
  const newNodeIds = [...path.nodeIds.slice(0, idx + 1), ...detourNodeIds, ...path.nodeIds.slice(idx + 1)];

  const detourSteps: JunctionPathStep[] = [];
  let prev = atNode;
  for (const n of detourNodeIds) {
    detourSteps.push({ fromNode: prev, toNode: n, edgeName: edgeNameFor(data, prev, n) });
    prev = n;
  }
  return {
    nodeIds: newNodeIds,
    steps: [...path.steps.slice(0, idx), ...detourSteps, ...path.steps.slice(idx)],
    endNode: path.endNode,
  };
}

/**
 * Finds every GR/GC cycle not already on `base`, and stitches each into the
 * path via a "squeeze": shortest CR path from an already-touched CGR node to
 * an untouched CRG node (checking again from any CGR node newly gained this
 * way, in case it unlocks another cycle), then — once no more CR attachments
 * are found — shortest RR/GG path from any touched node to any untouched
 * cycle node. Both kinds of attachment repeat to a fixpoint, so a cycle
 * reached only via a bridge from another just-attached cycle still gets
 * picked up, until every reachable node has been touched.
 */
export function expandPathWithCycles(data: VoronoiData, base: FullPathResult, reversed = false): FullPathResult {
  const touched = new Set(base.nodeIds);
  const cycles = findUnusedCycles(data, touched, reversed);
  let path: FullPathResult = base;

  let progressed = true;
  while (progressed && cycles.length > 0) {
    progressed = false;

    const cgrSources = [...touched].filter(id => data.fullNodes[id]?.name === 'CGR');
    let attach = tryAttachViaDirected(data, cgrSources, new Set([reversed ? 'RC' : 'CR']), touched, cycles);
    if (!attach) {
      attach = tryAttachViaDirected(data, [...touched], new Set(['RA', 'RB', 'GA', 'GB']), touched, cycles);
    }
    if (!attach) break;

    const { bridge, cycleIdx } = attach;
    const cycle = cycles[cycleIdx];
    const entry = bridge.endNode;
    const loopTail = cycleLoopFrom(cycle, entry).slice(1);
    const backTail = [...bridge.nodeIds].reverse().slice(1);
    const detour = [...bridge.nodeIds.slice(1), ...loopTail, ...backTail];

    path = spliceDetourAt(data, path, bridge.nodeIds[0], detour);
    for (const n of cycle.nodeIds) touched.add(n);
    for (const n of bridge.nodeIds) touched.add(n);
    cycles.splice(cycleIdx, 1);
    progressed = true;
  }

  if (cycles.length > 0) {
    if (DEBUG.recreate) console.warn(`[voronoiJunctionPath] ${cycles.length} unused cycle(s) could not be reached from the main path:`, cycles);
  }

  return path;
}

function geodesicSegment(a: SpherePoint, b: SpherePoint, steps = 16): SpherePoint[] {
  const pts: SpherePoint[] = [];
  for (let i = 0; i <= steps; i++) pts.push(slerp(a, b, i / steps));
  return pts;
}

export interface JunctionVoronoiPathResult {
  pts: SpherePoint[];
  nodeIds: number[];
  /** Index in nodeIds where the central-cycle (CGR1->Last) leg begins. */
  seg2Start: number;
  /** Index in nodeIds where the final (Exit->V2) leg begins. */
  seg3Start: number;
  /** Set only for the mono-boundary case: the node id treated as both Enter and CGR1 despite not actually being a 'CGR'-named junction. */
  fakeCgrNodeId?: number;
}

/** True if the graph has at least one CGR or CRG node — a mixed (C touches both R and G) boundary. */
function hasMixedBoundary(data: VoronoiData): boolean {
  const surviving = new Set(data.survivingNodeIds);
  for (const n of data.fullNodes) {
    if (!surviving.has(n.id)) continue;
    if (n.name === 'CGR' || n.name === 'CRG') return true;
  }
  return false;
}

/** Converts a stitched node sequence into the final geodesic point path + markers. Returns null if too short. */
function buildResultFromNodeIds(
  data: VoronoiData,
  nodeIds: number[],
  seg2Node: number,
  seg3Node: number,
  v1Pos?: SpherePoint,
  v2Pos?: SpherePoint,
  fakeCgrNodeId?: number,
): JunctionVoronoiPathResult | null {
  const pts: SpherePoint[] = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const cc = data.circumcenters[nodeIds[i]];
    if (!cc) continue;
    if (i === 0) {
      pts.push(cc);
    } else {
      const prev = data.circumcenters[nodeIds[i - 1]];
      if (prev) {
        const seg = geodesicSegment(prev, cc);
        for (let k = 1; k < seg.length; k++) pts.push(seg[k]);
      } else {
        pts.push(cc);
      }
    }
  }
  if (pts.length < 2) return null;

  const first = data.circumcenters[nodeIds[0]];
  const last = data.circumcenters[nodeIds[nodeIds.length - 1]];
  const prefix = v1Pos && first ? geodesicSegment(v1Pos, first).slice(0, -1) : [];
  const suffix = v2Pos && last ? geodesicSegment(last, v2Pos).slice(1) : [];

  // Splicing detours in never duplicates an anchor node before inserting
  // after it, so the first occurrence of each marker node still identifies
  // where that segment begins even after cycle expansion.
  return {
    pts: [...prefix, ...pts, ...suffix],
    nodeIds,
    seg2Start: nodeIds.indexOf(seg2Node),
    seg3Start: nodeIds.indexOf(seg3Node),
    ...(fakeCgrNodeId !== undefined ? { fakeCgrNodeId } : {}),
  };
}

/**
 * Mono-boundary case: the C blob's boundary touches only one of R/G, so no
 * CGR/CRG node exists anywhere to lock onto. "Enter" doubles as "CGR1" —
 * the nearest non-'CCC' node reachable from a linksToV1 source. "Exit" is
 * the nearest non-'CCC' node reachable from linksToV2, avoiding Enter. If
 * that's impossible, the next-nearest Enter candidate from V1 is tried
 * instead (repeatedly), and only once V1 has no alternative left do Enter
 * and Exit collapse onto the same node.
 */
function computeMonoV1AndV2(data: VoronoiData): { v1: V1SequenceResult; v2: V2SequenceResult } | null {
  const surviving = new Set(data.survivingNodeIds);
  const v1Sources = data.graph.nodes.filter(n => n.linksToV1 && surviving.has(n.id)).map(n => n.id);
  if (v1Sources.length === 0) return null;

  const undirected = buildUndirectedAdjacency(data);
  const nameOf = (id: number): string => data.fullNodes[id]?.name ?? '';
  const { dist: v1Dist, prev: v1Prev } = bfsMultiSourceUndirected(v1Sources, undirected, new Set());

  const makeV1 = (enterNode: number): V1SequenceResult => {
    const primary = reconstructUndirected(data, v1Prev, enterNode);
    return { ...primary, enterNode, cgr1Node: enterNode };
  };

  const excluded = new Set<number>();
  for (;;) {
    const arrivals = nearestMatches(v1Dist, id => nameOf(id) !== 'CCC' && !excluded.has(id));
    if (!arrivals) break;
    const enterNode = arrivals.nodes[0];
    const v1 = makeV1(enterNode);
    const v2 = computeV2SequenceMono(data, enterNode);
    if (v2) return { v1, v2 };
    excluded.add(enterNode);
  }

  // No alternative Enter unlocks a distinct Exit — fall back to sharing one node.
  const arrivals = nearestMatches(v1Dist, id => nameOf(id) !== 'CCC');
  if (!arrivals) return null;
  const enterNode = arrivals.nodes[0];
  const v1 = makeV1(enterNode);

  const v2Sources = data.graph.nodes.filter(n => n.linksToV2 && surviving.has(n.id)).map(n => n.id);
  const { dist: v2Dist, prev: v2Prev } = bfsMultiSourceUndirected(v2Sources, undirected, new Set());
  if (!v2Dist.has(enterNode)) return null;
  const v2Primary = reconstructUndirected(data, v2Prev, enterNode);
  const v2: V2SequenceResult = { ...v2Primary, exitNode: enterNode, usedFallback: false };
  return { v1, v2 };
}

/** V2 side of the mono-boundary case: nearest non-'CCC' node from linksToV2, avoiding `enterNode`. */
function computeV2SequenceMono(data: VoronoiData, enterNode: number): V2SequenceResult | null {
  const surviving = new Set(data.survivingNodeIds);
  const sources = data.graph.nodes.filter(n => n.linksToV2 && surviving.has(n.id)).map(n => n.id);
  if (sources.length === 0) return null;

  const undirected = buildUndirectedAdjacency(data);
  const nameOf = (id: number): string => data.fullNodes[id]?.name ?? '';
  const { dist, prev } = bfsMultiSourceUndirected(sources, undirected, new Set([enterNode]));
  const direct = nearestMatches(dist, id => nameOf(id) !== 'CCC');
  if (!direct) return null;
  const result = reconstructUndirected(data, prev, direct.nodes[0]);
  return { ...result, exitNode: direct.nodes[0], usedFallback: false };
}

/** Direct Enter->Exit walk for the mono-boundary case, via RC-only or GC-only directed edges (whichever color is present — same canonical CW sense as the mixed-boundary central cycle). */
function computeMonoDirectSegment(data: VoronoiData, enterNode: number, exitNode: number): JunctionPathResult | null {
  if (enterNode === exitNode) return { nodeIds: [enterNode], steps: [], endNode: enterNode };
  for (const edgeNames of [new Set(['RC']), new Set(['GC'])]) {
    const directed = buildDirectedAdjacency(data, edgeNames);
    const { prevEdge } = bfsMultiSourceDirected([enterNode], directed);
    if (prevEdge.has(exitNode)) return reconstructDirected(prevEdge, new Set([enterNode]), exitNode);
  }
  return null;
}

/**
 * Squeezes out to the nearest unused cycle immediately from `node` (shortest
 * bridge, via the same-color RA/RB/GA/GB edges — there's no CGR node here to
 * source a CR bridge from, so this is always the fallback attach), splices it
 * in as an out-and-back detour right there, and returns the extended path.
 * Cycle chain direction is the reversed convention (RG/CG) — "the way we
 * originally had it" for this first squeeze. Returns `path` unchanged if no
 * cycle is reachable that way.
 */
function trySqueezeImmediately(data: VoronoiData, path: JunctionPathResult, node: number, touched: Set<number>): JunctionPathResult {
  const cycles = findUnusedCycles(data, touched, true);
  const attach = tryAttachViaDirected(data, [node], new Set(['RA', 'RB', 'GA', 'GB']), touched, cycles);
  if (!attach) return path;

  const { bridge, cycleIdx } = attach;
  const cycle = cycles[cycleIdx];
  const entry = bridge.endNode;
  const loopTail = cycleLoopFrom(cycle, entry).slice(1);
  const backTail = [...bridge.nodeIds].reverse().slice(1);
  const detour = [...bridge.nodeIds.slice(1), ...loopTail, ...backTail];
  return spliceDetourAt(data, path, bridge.nodeIds[0], detour);
}

function computeMonoJunctionVoronoiPath(
  data: VoronoiData,
  v1Pos?: SpherePoint,
  v2Pos?: SpherePoint,
): JunctionVoronoiPathResult | null {
  const seqs = computeMonoV1AndV2(data);
  if (!seqs) return null;
  const { v1, v2 } = seqs;

  // Squeeze out immediately from the fake-CGR node — as short as possible,
  // via the reversed CR/CG convention — before following the main RC/GC walk.
  const v1Path = trySqueezeImmediately(data, v1, v1.enterNode, new Set(v1.nodeIds));

  const direct = computeMonoDirectSegment(data, v1.enterNode, v2.exitNode);
  if (!direct) return null;

  const v2Reversed = reverseJunctionPath(data, v2);
  const full: FullPathResult = {
    nodeIds: [...v1Path.nodeIds, ...direct.nodeIds.slice(1), ...v2Reversed.nodeIds.slice(1)],
    steps: [...v1Path.steps, ...direct.steps, ...v2Reversed.steps],
    endNode: v2Reversed.endNode,
  };
  const expanded = expandPathWithCycles(data, full);
  return buildResultFromNodeIds(data, expanded.nodeIds, v1.enterNode, v1.enterNode, v1Pos, v2Pos, v1.enterNode);
}

/**
 * Last-resort case: the region has no internal junction structure at all (no
 * other boundaries to triangulate against), so even the mono-boundary walk in
 * computeMonoJunctionVoronoiPath finds no non-'CCC' node to lock onto. Instead
 * of naming anything, just take the plain shortest undirected hop-path from
 * any linksToV1 node to any linksToV2 node, then let buildResultFromNodeIds
 * connect its two ends to V1 and V2 with geodesic approach/departure segments
 * (same as every other case here) — a bare "shortest path across the cell"
 * rather than a named V1->Enter->...->Exit->V2 walk.
 */
function computeSimpleLinkedPath(data: VoronoiData): JunctionPathResult | null {
  const surviving = new Set(data.survivingNodeIds);
  const sources = data.graph.nodes.filter(n => n.linksToV1 && surviving.has(n.id)).map(n => n.id);
  const targets = new Set(data.graph.nodes.filter(n => n.linksToV2 && surviving.has(n.id)).map(n => n.id));
  if (sources.length === 0 || targets.size === 0) return null;

  const undirected = buildUndirectedAdjacency(data);
  const { dist, prev } = bfsMultiSourceUndirected(sources, undirected, new Set());
  const arrivals = nearestMatches(dist, id => targets.has(id));
  if (!arrivals) return null;

  return reconstructUndirected(data, prev, arrivals.nodes[0]);
}

/**
 * Runs the full junction-color-name-based path algorithm end to end (V1 ->
 * Enter -> CGR1 -> Last -> Exit -> V2) and converts the resulting node
 * sequence to sphere points via geodesic interpolation between circumcenters,
 * matching the drop-in shape of the old findVoronoiPath (voronoiGraphPath.ts)
 * so callers don't need to change. Returns null if any stage fails.
 *
 * If the C blob's boundary is monochromatic (touches only R or only G, so no
 * CGR/CRG node exists to lock onto), falls back to computeMonoJunctionVoronoiPath;
 * if that also finds no junction structure to work with (the region has no
 * other boundaries at all), falls back further to computeSimpleLinkedPath.
 */
export function computeJunctionVoronoiPath(
  data: VoronoiData,
  v1Pos?: SpherePoint,
  v2Pos?: SpherePoint,
): JunctionVoronoiPathResult | null {
  if (!hasMixedBoundary(data)) {
    const mono = computeMonoJunctionVoronoiPath(data, v1Pos, v2Pos);
    if (mono) return mono;
    const simple = computeSimpleLinkedPath(data);
    if (!simple) return null;
    return buildResultFromNodeIds(data, simple.nodeIds, simple.endNode, simple.endNode, v1Pos, v2Pos);
  }

  const v1 = computeV1Sequence(data);
  if (!v1) return null;
  const v2 = computeV2Sequence(data, v1);
  if (!v2) return null;
  const lastSegment = computeLastSegment(data, v1.cgr1Node);
  if (!lastSegment) return null;
  const touched = new Set([...v1.nodeIds, ...lastSegment.nodeIds]);
  const lastToExit = computeLastToExitSegment(data, lastSegment.lastNode, v1.enterNode, v2.exitNode, touched);
  if (!lastToExit) return null;

  const full = computeFullPath(data, v1, lastSegment, lastToExit, v2);
  const expanded = expandPathWithCycles(data, full);
  return buildResultFromNodeIds(data, expanded.nodeIds, v1.cgr1Node, lastSegment.lastNode, v1Pos, v2Pos);
}
