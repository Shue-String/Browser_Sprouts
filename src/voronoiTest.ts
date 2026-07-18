/**
 * voronoiTest — standalone viewer for the Voronoi junction graph captured by
 * "Save Game State" during a paused enclosure move in the main game.
 *
 * Renders the graph topology (buildVoronoiGraph's fullNodes/fullEdges/namedEdges)
 * as a plain 2D node-link diagram: force-directed initial layout, nodes
 * draggable by hand afterward. No sphere, no cell-fill rendering — that lives
 * in index.html. Nodes not connected (via any path) to a C-bordering node
 * are dropped, per buildVoronoiGraph's survivingNodeIds.
 */

import type { GameState } from './model/types';
import { recomputeRegions } from './model/moves';
import { buildSubregionHighlight } from './model/subregionHighlight';
import { buildVoronoiGraph } from './model/voronoiGraph';
import type { VoronoiData, VoronoiEdgeName } from './model/voronoiGraph';
import { computeV1Sequence, computeV2Sequence, computeLastSegment, computeLastToExitSegment, computeFullPath } from './model/voronoiJunctionPath';
import type { JunctionPathStep, V1SequenceResult, V2SequenceResult, LastSegmentResult, LastToExitResult, FullPathResult } from './model/voronoiJunctionPath';
import { deserializeGameState } from './model/saveState';
import type { SaveFileV1 } from './model/saveState';

const canvas     = document.getElementById('vt-canvas')  as HTMLCanvasElement;
const loadBtn    = document.getElementById('load-btn')   as HTMLButtonElement;
const loadInput  = document.getElementById('load-input') as HTMLInputElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const pathBar    = document.getElementById('path-bar')   as HTMLDivElement;
const pathText   = document.getElementById('path-text')  as HTMLSpanElement;
const pathText2  = document.getElementById('path-text-2') as HTMLSpanElement;
const pathText3  = document.getElementById('path-text-3') as HTMLSpanElement;
const pathText4  = document.getElementById('path-text-4') as HTMLSpanElement;
const pathText5  = document.getElementById('path-text-5') as HTMLSpanElement;

const ctx = canvas.getContext('2d')!;

function emptyState(): GameState {
  return {
    vertices: new Map(),
    edges: new Map(),
    regions: new Map(),
    spotLabels: new Map(),
    subpositions: [],
    nextVertexId: 0,
    nextEdgeId: 0,
    nextRegionId: 0,
    moveCount: 0,
  };
}

let state: GameState = emptyState();

// ---------------------------------------------------------------------------
// Graph model: nodes carry a world-space (x, y) position; edges reference
// node ids. Layout runs once (force-directed) after a load, then nodes are
// repositioned purely by hand via drag.
// ---------------------------------------------------------------------------

interface GraphNode {
  id: number;
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface LayoutEdge {
  nodeA: number;
  nodeB: number;
}

let nodes: GraphNode[] = [];
let layoutEdges: LayoutEdge[] = [];
let namedEdges: VoronoiEdgeName[] = [];
let v1Result: V1SequenceResult | null = null;
let v2Result: V2SequenceResult | null = null;
let lastResult: LastSegmentResult | null = null;
let lastToExitResult: LastToExitResult | null = null;
let fullPathResult: FullPathResult | null = null;

// View transform: world-space graph coordinates -> canvas pixels.
let viewScale = 1, viewOffsetX = 0, viewOffsetY = 0;

const NODE_RADIUS = 9;

function worldToScreen(x: number, y: number): { sx: number; sy: number } {
  return { sx: x * viewScale + viewOffsetX, sy: y * viewScale + viewOffsetY };
}
function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - viewOffsetX) / viewScale, y: (sy - viewOffsetY) / viewScale };
}

/** Recomputes viewScale/viewOffset so the current node layout fits the canvas with margin. */
function fitView(): void {
  if (nodes.length === 0) { viewScale = 1; viewOffsetX = canvas.width / 2; viewOffsetY = canvas.height / 2; return; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const margin = 60;
  const availW = Math.max(canvas.width - 2 * margin, 1);
  const availH = Math.max(canvas.height - 2 * margin, 1);
  viewScale = Math.min(availW / spanX, availH / spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  viewOffsetX = canvas.width / 2 - cx * viewScale;
  viewOffsetY = canvas.height / 2 - cy * viewScale;
}

/** True for nodes that border C and at least one other color — the central-cycle ring (excludes pure 'CCC'). */
function isMainCycleName(name: string): boolean {
  return name.includes('C') && name !== 'CCC';
}

/**
 * Orders the main-cycle nodes into a single ring by following the C=1 subset
 * of phase1 (the CW-directed C-R/C-G edges) — the same central cycle used by
 * findLastNode. Starts at `enterNode` if it's on the cycle, else an arbitrary
 * cycle node. Best-effort: stops early if the chain breaks or loops short.
 */
function orderMainCycle(vData: VoronoiData, mainCycleIds: Set<number>, enterNode: number | undefined): number[] {
  const next = new Map<number, number>();
  for (const e of vData.graph.phase1) {
    if (e.C === 2) continue;
    if (mainCycleIds.has(e.nodeA) && mainCycleIds.has(e.nodeB)) next.set(e.nodeA, e.nodeB);
  }
  const start = enterNode !== undefined && mainCycleIds.has(enterNode) ? enterNode : [...mainCycleIds][0];
  if (start === undefined) return [];
  const order = [start];
  const seen = new Set([start]);
  let cur = start;
  while (true) {
    const nxt = next.get(cur);
    if (nxt === undefined || seen.has(nxt)) break;
    order.push(nxt);
    seen.add(nxt);
    cur = nxt;
  }
  return order;
}

const CYCLE_RADIUS = 220;
const RING_MARGIN = 30;

/**
 * Places main-cycle nodes (name has C plus another letter) fixed on a ring,
 * enterNode at the top, in the cycle's CW direction. Pure-C ('CCC') nodes are
 * relaxed inside the ring, non-C nodes relaxed outside it — both via the same
 * spring-electrical simulation, radially clamped to stay on their side.
 */
function layoutGraph(vData: VoronoiData, enterNode: number | undefined): void {
  const n = nodes.length;
  if (n === 0) return;

  const mainCycleIds = new Set(nodes.filter(nd => isMainCycleName(nd.name)).map(nd => nd.id));
  const cycleOrder = orderMainCycle(vData, mainCycleIds, enterNode);

  const nodeById = new Map(nodes.map(nd => [nd.id, nd]));
  const fixed = new Set<number>();
  cycleOrder.forEach((id, i) => {
    const node = nodeById.get(id)!;
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / cycleOrder.length;
    node.x = Math.cos(angle) * CYCLE_RADIUS;
    node.y = Math.sin(angle) * CYCLE_RADIUS;
    node.vx = 0; node.vy = 0;
    fixed.add(id);
  });

  // Any main-cycle node the ring-walk didn't reach (broken/disconnected chain) still
  // needs a deterministic starting position; drop it to the "outside" pool instead.
  for (const id of mainCycleIds) {
    if (!fixed.has(id)) mainCycleIds.delete(id);
  }

  // Deterministic starting positions for everything else (avoids NaN from coincident points).
  const others = nodes.filter(nd => !fixed.has(nd.id));
  others.forEach((node, i) => {
    const isInside = node.name === 'CCC';
    const angle = (2 * Math.PI * i) / Math.max(others.length, 1);
    const radius = isInside ? CYCLE_RADIUS * 0.4 : CYCLE_RADIUS * 1.4;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
    node.vx = 0; node.vy = 0;
  });

  const nodeIndex = new Map<number, number>();
  nodes.forEach((node, i) => nodeIndex.set(node.id, i));

  const REPULSION_K = 4000;
  const SPRING_K = 0.02;
  const SPRING_LENGTH = 80;
  const DAMPING = 0.85;
  const ITERATIONS = 400;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (const node of nodes) { node.vx = 0; node.vy = 0; }

    // Repulsion between every pair of nodes.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1e-4) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); distSq = dx * dx + dy * dy; }
        const dist = Math.sqrt(distSq);
        const force = REPULSION_K / distSq;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // Spring attraction along edges.
    for (const edge of layoutEdges) {
      const ia = nodeIndex.get(edge.nodeA), ib = nodeIndex.get(edge.nodeB);
      if (ia === undefined || ib === undefined) continue;
      const a = nodes[ia], b = nodes[ib];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-4) { dx = 0.1; dy = 0; dist = 0.1; }
      const force = SPRING_K * (dist - SPRING_LENGTH);
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    for (const node of nodes) {
      if (fixed.has(node.id)) continue; // main-cycle nodes stay pinned to the ring
      node.x += node.vx * DAMPING;
      node.y += node.vy * DAMPING;

      // Radial clamp: inside pool stays inside the ring, outside pool stays outside it.
      const isInside = node.name === 'CCC';
      const dist = Math.hypot(node.x, node.y) || 1e-6;
      const limit = isInside ? CYCLE_RADIUS - RING_MARGIN : CYCLE_RADIUS + RING_MARGIN;
      if (isInside ? dist > limit : dist < limit) {
        const scale = limit / dist;
        node.x *= scale; node.y *= scale;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Left-of-travel color for a directed edge name's first letter (the "left" cell). */
function edgeColor(firstLetter: string): string {
  if (firstLetter === 'C') return '#888888';
  if (firstLetter === 'G') return '#2f9e44';
  return '#c0392b'; // R
}

const CELL_LETTERS = new Set(['C', 'G', 'R']);

/** True for a differently-colored-neighbor edge name ("CG", "RG2", ...), false for same-color ("RA"/"RB") or C-C ("CI"/"CO"). */
function isMixedName(name: string): boolean {
  const base = name.endsWith('2') ? name.slice(0, -1) : name;
  return base.length === 2 && CELL_LETTERS.has(base[0]) && CELL_LETTERS.has(base[1]) && base[0] !== base[1];
}

const BASE_OFFSET = 4;
const DOUBLE_OFFSET = 9;

function drawOffsetLine(pa: { sx: number; sy: number }, pb: { sx: number; sy: number }, offset: number, color: string): void {
  let tx = pb.sx - pa.sx, ty = pb.sy - pa.sy;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;
  // Left-normal in canvas coords (y-down): perpendicular to tangent, pointing left of travel.
  const nx = ty, ny = -tx;
  ctx.beginPath();
  ctx.moveTo(pa.sx + nx * offset, pa.sy + ny * offset);
  ctx.lineTo(pb.sx + nx * offset, pb.sy + ny * offset);
  ctx.strokeStyle = color;
  ctx.stroke();
}

function render(): void {
  const pathBarHeight = pathBar.classList.contains('visible') ? pathBar.getBoundingClientRect().height : 0;
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight - 40 - pathBarHeight;
  if (canvas.width === 0 || canvas.height === 0) return; // not yet visible/laid out

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (nodes.length === 0) return;

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Group named edges by unordered node pair so each pair's directed halves
  // can be drawn together (as parallel offset lines, or one plain line for
  // same-color/C-C pairs whose side assignment is still undecided).
  const groups = new Map<string, VoronoiEdgeName[]>();
  for (const e of namedEdges) {
    const a = nodeById.get(e.nodeA), b = nodeById.get(e.nodeB);
    if (!a || !b) continue; // pruned
    const key = e.nodeA < e.nodeB ? `${e.nodeA}_${e.nodeB}` : `${e.nodeB}_${e.nodeA}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  ctx.lineWidth = 1.5;
  for (const group of groups.values()) {
    if (isMixedName(group[0].name)) {
      // Differently-colored neighbors: each direction offset to its own left-of-travel side.
      for (const e of group) {
        const a = nodeById.get(e.nodeA)!, b = nodeById.get(e.nodeB)!;
        const pa = worldToScreen(a.x, a.y), pb = worldToScreen(b.x, b.y);
        const offset = e.name.endsWith('2') ? DOUBLE_OFFSET : BASE_OFFSET;
        drawOffsetLine(pa, pb, offset, edgeColor(e.name[0]));
      }
    } else {
      // Same-color (RR/GG) or C-C: side assignment deferred — draw one plain centerline.
      const e = group[0];
      const a = nodeById.get(e.nodeA)!, b = nodeById.get(e.nodeB)!;
      const pa = worldToScreen(a.x, a.y), pb = worldToScreen(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.strokeStyle = edgeColor(e.name[0]);
      ctx.stroke();
    }
  }

  // Highlight the V1 and V2 sequence edges (drawn over the base edges, thicker/brighter).
  const highlightStep = (step: JunctionPathStep, color: string): void => {
    const a = nodeById.get(step.fromNode), b = nodeById.get(step.toNode);
    if (!a || !b) return;
    const pa = worldToScreen(a.x, a.y), pb = worldToScreen(b.x, b.y);
    const offset = step.edgeName.endsWith('2') ? DOUBLE_OFFSET : isMixedName(step.edgeName) ? BASE_OFFSET : 0;
    ctx.lineWidth = 3.5;
    if (offset === 0) {
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      drawOffsetLine(pa, pb, offset, color);
    }
  };
  for (const step of v1Result?.steps ?? []) highlightStep(step, '#1565c0');
  for (const step of v2Result?.steps ?? []) highlightStep(step, '#e65100');
  for (const step of lastResult?.steps ?? []) highlightStep(step, '#2e7d32');
  for (const step of lastToExitResult?.steps ?? []) highlightStep(step, '#8e24aa');

  const flagsByNode = new Map<number, string[]>();
  const addFlag = (id: number | undefined, label: string): void => {
    if (id === undefined) return;
    if (!flagsByNode.has(id)) flagsByNode.set(id, []);
    flagsByNode.get(id)!.push(label);
  };
  addFlag(v1Result?.enterNode, 'Enter');
  addFlag(v1Result?.cgr1Node, 'CGR1');
  addFlag(v2Result?.exitNode, 'Exit');
  addFlag(lastResult?.lastNode, 'Last');
  addFlag(fullPathResult?.endNode, 'V2');

  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const node of nodes) {
    const p = worldToScreen(node.x, node.y);
    const flags = flagsByNode.get(node.id);
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, NODE_RADIUS, 0, 2 * Math.PI);
    ctx.fillStyle = node.name === 'CRG' ? '#9933cc' : node.name === 'CGR' ? '#ffffff' : '#4a90d9';
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (flags) {
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, NODE_RADIUS + 3, 0, 2 * Math.PI);
      ctx.strokeStyle = '#f2c94c';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = '#000000';
    ctx.fillText(`${node.id} ${node.name}`, p.sx, p.sy - NODE_RADIUS - 8);
    if (flags) {
      ctx.fillStyle = '#b8860b';
      ctx.fillText(flags.join('/'), p.sx, p.sy + NODE_RADIUS + 10);
    }
  }
}
render();

window.addEventListener('resize', () => { fitView(); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

// ---------------------------------------------------------------------------
// Drag a node by hand.
// ---------------------------------------------------------------------------

let draggingNode: GraphNode | undefined;

function nodeAtScreenPoint(sx: number, sy: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  let bestDistSq = (NODE_RADIUS + 4) * (NODE_RADIUS + 4);
  for (const node of nodes) {
    const p = worldToScreen(node.x, node.y);
    const dx = p.sx - sx, dy = p.sy - sy;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) { bestDistSq = distSq; best = node; }
  }
  return best;
}

canvas.addEventListener('pointerdown', e => {
  const rect = canvas.getBoundingClientRect();
  const hit = nodeAtScreenPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (hit) { draggingNode = hit; canvas.setPointerCapture(e.pointerId); }
});
canvas.addEventListener('pointermove', e => {
  if (!draggingNode) return;
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  draggingNode.x = world.x;
  draggingNode.y = world.y;
  render();
});
window.addEventListener('pointerup', () => { draggingNode = undefined; });

// ---------------------------------------------------------------------------
// Load a save file
// ---------------------------------------------------------------------------

loadBtn.addEventListener('click', () => loadInput.click());

loadInput.addEventListener('change', () => {
  const file = loadInput.files?.[0] ?? null;
  loadInput.value = '';
  if (!file) return;
  void file.text().then(text => {
    let save: SaveFileV1;
    try {
      save = JSON.parse(text);
    } catch (err) {
      statusText.textContent = `Invalid save file: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    try {
      loadSave(save, file.name);
    } catch (err) {
      statusText.textContent = `Failed to load save: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
});

function loadSave(save: SaveFileV1, fileName: string): void {
  const deserialized = deserializeGameState(save);
  state = deserialized.state;
  recomputeRegions(state);

  nodes = [];
  layoutEdges = [];
  namedEdges = [];
  v1Result = null;
  v2Result = null;
  lastResult = null;
  lastToExitResult = null;
  fullPathResult = null;
  pathBar.classList.remove('visible');

  if (!deserialized.pendingMove) {
    statusText.textContent = `${fileName}: no pending move in this save — nothing to visualize.`;
    render();
    return;
  }

  const { lo, hi, brackets } = deserialized.pendingMove;
  // Saved pending moves always resume in raw-id terms (see main.ts resume path),
  // so brackets are already plain vertex ids despite the static BracketEntry[] type.
  const sh = buildSubregionHighlight(state, lo, hi, (brackets as number[] | null) ?? []);
  if (!sh) {
    statusText.textContent = `${fileName}: pending move ${lo}→${hi} isn't a recognizable enclosure in this board — nothing to visualize.`;
    render();
    return;
  }

  const vData: VoronoiData = buildVoronoiGraph(state, sh, lo, hi);
  const { fullNodes, fullEdges, namedEdges: allNamedEdges, survivingNodeIds } = vData;

  const surviving = new Set(survivingNodeIds);
  nodes = fullNodes.filter(n => surviving.has(n.id)).map(n => ({ id: n.id, name: n.name, x: 0, y: 0, vx: 0, vy: 0 }));
  layoutEdges = fullEdges.filter(e => surviving.has(e.nodeA) && surviving.has(e.nodeB));
  namedEdges = allNamedEdges.filter(e => surviving.has(e.nodeA) && surviving.has(e.nodeB));

  v1Result = computeV1Sequence(vData);
  layoutGraph(vData, v1Result?.enterNode);
  fitView();

  const formatSequence = (steps: JunctionPathStep[], startNode: number): string =>
    steps.length === 0 ? `${startNode}` : `${startNode} ${steps.map(s => `--${s.edgeName}--> ${s.toNode}`).join(' ')}`;

  if (v1Result) {
    pathText.textContent = `V1 → Enter=${v1Result.enterNode}, CGR1=${v1Result.cgr1Node}: ${formatSequence(v1Result.steps, v1Result.nodeIds[0])}`;
    v2Result = computeV2Sequence(vData, v1Result);
    if (v2Result) {
      const fallbackNote = v2Result.usedFallback ? ' (CG2/CR2 fallback)' : '';
      pathText2.textContent = `V2 → Exit=${v2Result.exitNode}${fallbackNote}: ${formatSequence(v2Result.steps, v2Result.nodeIds[0])}`;
    } else {
      pathText2.textContent = 'V2 → (no linksToV2 node found)';
    }
    lastResult = computeLastSegment(vData, v1Result.cgr1Node);
    if (lastResult) {
      pathText3.textContent = `Last=${lastResult.lastNode}: ${formatSequence(lastResult.steps, lastResult.nodeIds[0])}`;
    } else {
      pathText3.textContent = 'Last → (no CR/GR path from CGR1 to Last)';
    }
    if (lastResult && v2Result) {
      const touched = new Set([...v1Result.nodeIds, ...lastResult.nodeIds]);
      lastToExitResult = computeLastToExitSegment(vData, lastResult.lastNode, v1Result.enterNode, v2Result.exitNode, touched);
      if (lastToExitResult) {
        const note = !lastToExitResult.usedFallback ? '' : lastToExitResult.usedEnterOverride ? ' (CR2/CG2 fallback, RC2/GC2 around Enter)' : ' (CR2/CG2 fallback)';
        pathText4.textContent = `Last→Exit${note}: ${formatSequence(lastToExitResult.steps, lastToExitResult.nodeIds[0])}`;
        fullPathResult = computeFullPath(vData, v1Result, lastResult, lastToExitResult, v2Result);
        pathText5.textContent = `Full path: ${formatSequence(fullPathResult.steps, fullPathResult.nodeIds[0])}`;
      } else {
        pathText4.textContent = 'Last→Exit → (no viable path)';
        pathText5.textContent = '';
      }
    } else {
      pathText4.textContent = '';
      pathText5.textContent = '';
    }
  } else {
    pathText.textContent = 'V1 → (no linksToV1 node found)';
    pathText2.textContent = '';
    pathText3.textContent = '';
    pathText4.textContent = '';
    pathText5.textContent = '';
  }
  pathBar.classList.add('visible');
  statusText.textContent = `${fileName}: move ${lo}→${hi} — ${nodes.length} nodes, ${layoutEdges.length} edges`;

  render();
}
