/**
 * T-Tree pane: type a left-side encoding (same format as Collect's own search bar) to render the
 * tree of its T-moves only -- required T-genes as solid black arrows; a bypass as TWO arrows, red
 * from the parent to the T-child that gets bypassed, then blue from that bypassed child on to the
 * grandchild that actually resolves back to the family (i.e. the one that allows the bypass); and
 * any unexplained "extra" T-child (shouldn't occur for a genuinely registered element) as a dashed
 * grey arrow. An Export button copies an equivalent TikZ figure to the clipboard. See
 * src/model/ttree.ts for the tree-building and layout logic this only renders.
 */

import { shiftMembraneLetters } from '../model/collectAlpha';
import { canonFullSync } from '../engine/stalks';
import {
  type TTreeGraph,
  type TTreeLayout,
  type TTreeLayoutPos,
  type TTreeNode,
  buildTTree,
  layoutTTree,
  toLatexMath,
} from '../model/ttree';
import { bracketDisplaySlash, markAlpha } from './collect';

let wired = false;
let lastGraph: TTreeGraph | null = null;
let lastLayout: TTreeLayout | null = null;
let status = '';
let statusIsError = false;
let searchGen = 0;

const DEFAULT_ENCODING = '[AB|ACD|BCE|2,DEa]';

function nodeLabel(node: TTreeNode): string[] {
  // DisaPoint notation (canonFullSync) rather than node.id's own strict/structural canon, per the
  // user's request -- more compact, at the cost of two graph-distinct nodes occasionally rendering
  // with an identical label (DisaPoint compression is lossy for true identity; node.id, the actual
  // dedup key, is unaffected). Falls back to the structural form if the engine isn't loaded yet.
  const displayEnc = canonFullSync(node.id) ?? node.id;
  const enc = bracketDisplaySlash(markAlpha(shiftMembraneLetters(displayEnc)));
  return node.name && node.requiredByAny ? [enc, node.name] : [enc];
}

const ROW_PX = 130;
const GAP_X = 30;
const BOX_PAD_X = 20;
const BOX_MIN_W = 50;
const BOX_H_1LINE = 34;
const BOX_H_2LINE = 50;
const MARGIN = 40;

/** Cached 2D context used only for text measurement (never drawn to) -- cheaper than a scratch DOM
 * element per label, and accurate enough since it's given the exact same font-size/family the SVG
 * text itself renders with (see the `text` style strings below / the container's own CSS). */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function measureTextWidth(text: string, fontPx: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * fontPx * 0.6; // conservative fallback if canvas is ever unavailable
  measureCtx.font = `${fontPx}px system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

/** Box width is sized to its own label -- not a shared fixed width -- so a short position like
 * "[2,α/" doesn't carry the same box width as the tree's longest encoding. */
function boxSize(node: TTreeNode): { w: number; h: number } {
  const lines = nodeLabel(node);
  const textW = Math.max(...lines.map((line, i) => measureTextWidth(line, i === 0 ? 13 : 12)));
  const w = Math.max(BOX_MIN_W, Math.ceil(textW) + BOX_PAD_X);
  return { w, h: node.name && node.requiredByAny ? BOX_H_2LINE : BOX_H_1LINE };
}

interface Rect { x: number; y: number; w: number; h: number }

/** Every edge as an undirected adjacency, for the priority-style horizontal alignment below --
 * plus the implied via-to link a bypass edge doesn't otherwise carry as a separate edge object
 * (from->to is added unconditionally, giving via and to both good neighbor context as well). */
function buildNeighbors(graph: TTreeGraph): Map<string, string[]> {
  const neighbors = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
    (neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
  };
  for (const e of graph.edges) {
    add(e.from, e.to);
    if (e.kind === 'bypass' && e.via) {
      add(e.from, e.via);
      add(e.via, e.to);
    }
  }
  return neighbors;
}

/** Per-node pixel rects. Row and left-to-right ORDER within a row both come straight from
 * `layout` (its own row-monotonicity-corrected grid and barycenter column ranks); what this adds
 * is the actual X position -- NOT a shared per-column-index grid (that approach left every row
 * independently left-packed from column 0, so a shallow row always hugged the left edge no matter
 * where its own children happened to fan out below it). Instead, each row is first packed at its
 * own boxes' real content widths, then refined in THREE phases, per the user's own "I've done
 * something similar by hand" recipe.
 *
 * Phase 1: a few rounds of PURE directional averaging with no regard for overlap -- a top-down
 * sweep pulls each node to the average of its PARENTS only, then a bottom-up sweep pulls each node
 * to the average of its CHILDREN only (repeated a few times) -- to find where a node "wants" to
 * sit, freed from fighting overlap-resolution on every single round the way a combined approach
 * would.
 *
 * Phase 2: ONE spread-out pass per row that takes those idealized positions and resolves overlaps
 * while preserving the row's existing left-to-right order: a forward min-gap clamp and a backward
 * one are computed independently (each internally consistent, i.e. neighbors in it are already
 * >= one gap apart) and then averaged per-node -- since forward and backward each already satisfy
 * the gap constraint on their own, the elementwise average provably does too, but without either
 * pass's own directional bias.
 *
 * Phase 3: anchor on the row with the widest span (left exactly as Phases 1-2 packed it -- the
 * user wants the widest row(s) to stay about as compact as they already are) and propagate
 * outward from it one row at a time -- each newly-touched row repositioned as the pure average of
 * whichever of ITS OWN neighbors live in an already-fixed (closer to the anchor) row, then
 * re-spread. This targets exactly the symmetry Phases 1-2 can leave slightly off around the
 * anchor's own immediate neighbors (their edges into/out of the wide row weren't being judged
 * against the wide row specifically, only against the whole tree's average pull), and the
 * outward propagation carries that same anchored correction to farther rows too.
 *
 * Finally shifted so the leftmost box's left edge sits at MARGIN. */
function computeNodeRects(graph: TTreeGraph, layout: TTreeLayout): Map<string, Rect> {
  const size = new Map<string, { w: number; h: number }>();
  for (const node of graph.nodes.values()) size.set(node.id, boxSize(node));

  const rows = new Map<number, string[]>();
  for (const node of graph.nodes.values()) {
    const pos = layout.positions.get(node.id);
    if (!pos) continue;
    (rows.get(pos.row) ?? rows.set(pos.row, []).get(pos.row)!).push(node.id);
  }
  for (const ids of rows.values()) {
    ids.sort((a, b) => (layout.positions.get(a) as TTreeLayoutPos).col - (layout.positions.get(b) as TTreeLayoutPos).col);
  }
  const rowIndices = [...rows.keys()].sort((a, b) => a - b);
  const rowOf = (id: string) => (layout.positions.get(id) as TTreeLayoutPos).row;

  const xCenter = new Map<string, number>();
  for (const ids of rows.values()) {
    let cursor = 0;
    for (const id of ids) {
      const w = (size.get(id) as { w: number }).w;
      cursor += w / 2;
      xCenter.set(id, cursor);
      cursor += w / 2 + GAP_X;
    }
  }

  const neighbors = buildNeighbors(graph);
  const halfGap = (a: string, b: string) =>
    (size.get(a) as { w: number }).w / 2 + GAP_X + (size.get(b) as { w: number }).w / 2;
  const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Phase 1: pure directional averaging, no overlap resolution at all -- nodes can freely overlap
  // here, since only their RELATIVE pull toward parents/children matters.
  const PASSES = 6;
  for (let pass = 0; pass < PASSES; pass++) {
    for (const row of rowIndices) {
      for (const id of rows.get(row) as string[]) {
        const parents = (neighbors.get(id) ?? []).filter(n => rowOf(n) < row).map(n => xCenter.get(n) as number);
        if (parents.length > 0) xCenter.set(id, average(parents));
      }
    }
    for (const row of [...rowIndices].reverse()) {
      for (const id of rows.get(row) as string[]) {
        const children = (neighbors.get(id) ?? []).filter(n => rowOf(n) > row).map(n => xCenter.get(n) as number);
        if (children.length > 0) xCenter.set(id, average(children));
      }
    }
  }

  // Phase 2: spread each row out from its (possibly overlapping) idealized positions into valid,
  // order-preserving ones -- see the function doc comment for why forward+backward averaging is
  // both bias-free and automatically gap-valid.
  const spreadRow = (ids: string[]) => {
    const ideal = ids.map(id => xCenter.get(id) as number);
    const fwd = [...ideal];
    for (let i = 1; i < fwd.length; i++) fwd[i] = Math.max(fwd[i], fwd[i - 1] + halfGap(ids[i - 1], ids[i]));
    const bwd = [...ideal];
    for (let i = bwd.length - 2; i >= 0; i--) bwd[i] = Math.min(bwd[i], bwd[i + 1] - halfGap(ids[i], ids[i + 1]));
    ids.forEach((id, i) => xCenter.set(id, (fwd[i] + bwd[i]) / 2));
  };
  for (const ids of rows.values()) spreadRow(ids);

  // Phase 3 (per the user's own recipe): anchor on the widest row -- left exactly as Phase 1+2
  // already packed it, on purpose -- then propagate outward from it one row at a time, each new
  // row repositioned as the pure average of whichever of its own neighbors live in an
  // already-fixed (closer to the anchor) row. This is deliberately a SECOND, independent averaging
  // pass keyed off the anchor rather than off the root/leaves, so a row's position reflects "where
  // its edges to the anchor side actually want to be" instead of a compromise across the whole
  // tree -- it's what was leaving the widest row's own immediate neighbors skewed toward one side.
  // Every row this touches is then re-spread (Phase 2's own routine) since pure averaging can again
  // overlap -- except the anchor row itself, which stays untouched throughout.
  if (rowIndices.length > 2) {
    let widestRow = rowIndices[0];
    let widestSpan = -Infinity;
    for (const row of rowIndices) {
      const ids = rows.get(row) as string[];
      const left = Math.min(...ids.map(id => (xCenter.get(id) as number) - (size.get(id) as { w: number }).w / 2));
      const right = Math.max(...ids.map(id => (xCenter.get(id) as number) + (size.get(id) as { w: number }).w / 2));
      if (right - left > widestSpan) {
        widestSpan = right - left;
        widestRow = row;
      }
    }

    const fixedRows = new Set<number>([widestRow]);
    const widestIdx = rowIndices.indexOf(widestRow);
    let lo = widestIdx;
    let hi = widestIdx;
    while (lo > 0 || hi < rowIndices.length - 1) {
      if (lo > 0) {
        lo--;
        const row = rowIndices[lo];
        const ids = rows.get(row) as string[];
        for (const id of ids) {
          const anchored = (neighbors.get(id) ?? [])
            .filter(n => fixedRows.has(rowOf(n)))
            .map(n => xCenter.get(n) as number);
          if (anchored.length > 0) xCenter.set(id, average(anchored));
        }
        spreadRow(ids);
        fixedRows.add(row);
      }
      if (hi < rowIndices.length - 1) {
        hi++;
        const row = rowIndices[hi];
        const ids = rows.get(row) as string[];
        for (const id of ids) {
          const anchored = (neighbors.get(id) ?? [])
            .filter(n => fixedRows.has(rowOf(n)))
            .map(n => xCenter.get(n) as number);
          if (anchored.length > 0) xCenter.set(id, average(anchored));
        }
        spreadRow(ids);
        fixedRows.add(row);
      }
    }
  }

  let minLeft = Infinity;
  for (const [id, xc] of xCenter) minLeft = Math.min(minLeft, xc - (size.get(id) as { w: number }).w / 2);

  const rects = new Map<string, Rect>();
  for (const [id, xc] of xCenter) {
    const { w, h } = size.get(id) as { w: number; h: number };
    const pos = layout.positions.get(id) as TTreeLayoutPos;
    rects.set(id, { x: MARGIN + (xc - minLeft) - w / 2, y: MARGIN + pos.row * ROW_PX, w, h });
  }
  return rects;
}

function centerOfRect(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Does the straight line from (x1,y1) to (x2,y2) pass behind `rect`, sampled at rect's own
 * vertical center? Every edge in this layout runs monotonically along the row axis (rows are
 * ordered by descending adjustedLives), so a single sample at the blocker's mid-height is enough
 * -- no need for full segment/rect intersection. `pad` widens the box slightly so a line that
 * just grazes an edge still counts as blocked. */
function lineHitsRect(x1: number, y1: number, x2: number, y2: number, rect: Rect, pad = 4): boolean {
  const cy = rect.y + rect.h / 2;
  if (cy < Math.min(y1, y2) || cy > Math.max(y1, y2)) return false;
  if (y1 === y2) return false;
  const t = (cy - y1) / (y2 - y1);
  const x = x1 + t * (x2 - x1);
  return x > rect.x - pad && x < rect.x + rect.w + pad;
}

/** Row parity of the edge's SOURCE node -- every curved edge (a blocked required/extra detour, or
 * a bypass) bows toward the side its own parity picks, so edges leaving an odd-numbered row read
 * as a visually distinct band from edges leaving an even one, per the user's own request. An edge
 * connecting immediately-adjacent rows never needs a bow at all (there's no room between them for
 * a blocker, and this fn is never consulted for those), so it's untouched either way. */
function bowsLeft(fromId: string, layout: TTreeLayout): boolean {
  const row = layout.positions.get(fromId)?.row ?? 0;
  return row % 2 === 1;
}

interface Pt { x: number; y: number }
/** A drawable edge path -- either a straight line, or the cubic detour buildPathSpec produces when
 * a blocker forces a bow (see its own doc comment). Kept as data (not an SVG string) so crossing
 * detection can sample it numerically before anything is committed to `d`. */
type PathSpec = { kind: 'line'; a: Pt; b: Pt } | { kind: 'cubic'; a: Pt; c1: Pt; c2: Pt; b: Pt };

/** Point at parameter `t` (0=a, 1=b) along `p`. */
function evalPath(p: PathSpec, t: number): Pt {
  if (p.kind === 'line') return { x: p.a.x + (p.b.x - p.a.x) * t, y: p.a.y + (p.b.y - p.a.y) * t };
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p.a.x + 3 * mt * mt * t * p.c1.x + 3 * mt * t * t * p.c2.x + t * t * t * p.b.x,
    y: mt * mt * mt * p.a.y + 3 * mt * mt * t * p.c1.y + 3 * mt * t * t * p.c2.y + t * t * t * p.b.y,
  };
}

const PATH_SAMPLES = 24;
function samplePath(p: PathSpec): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= PATH_SAMPLES; i++) pts.push(evalPath(p, i / PATH_SAMPLES));
  return pts;
}

/** Linear-interpolated x at a given y from a monotonic (in y), sorted-ascending sample list --
 * every path in this layout runs strictly downward (see the row-monotonicity fixup in
 * model/ttree.ts), so this is a valid, cheap stand-in for a true parametric x(y). */
function xAtY(samples: Pt[], y: number): number {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (y <= first.y) return first.x;
  if (y >= last.y) return last.x;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].y >= y) {
      const span = samples[i].y - samples[i - 1].y || 1;
      const t = (y - samples[i - 1].y) / span;
      return samples[i - 1].x + (samples[i].x - samples[i - 1].x) * t;
    }
  }
  return last.x;
}

/** Approximate crossing count between two paths, used to pick between candidate routings (see
 * bowsLeft's override below, and the same-origin straight/curve fix further down). Both paths run
 * strictly downward, so "which one is further left" at a shared set of y-levels is well-defined;
 * counting sign flips of that difference across their shared y-range is a cheap, robust stand-in
 * for exact curve/curve intersection math, and naturally ignores a shared endpoint (the diff there
 * is exactly 0, which never itself counts as a flip -- see the strict prev*diff<0 check). */
function countCrossings(p: PathSpec, q: PathSpec): number {
  const P = samplePath(p);
  const Q = samplePath(q);
  const yLo = Math.max(P[0].y, Q[0].y);
  const yHi = Math.min(P[P.length - 1].y, Q[Q.length - 1].y);
  if (yHi <= yLo) return 0;
  let crossings = 0;
  let prev = xAtY(P, yLo) - xAtY(Q, yLo);
  for (let i = 1; i <= PATH_SAMPLES; i++) {
    const y = yLo + ((yHi - yLo) * i) / PATH_SAMPLES;
    const diff = xAtY(P, y) - xAtY(Q, y);
    if (prev !== 0 && diff !== 0 && prev * diff < 0) crossings++;
    prev = diff;
  }
  return crossings;
}

function pathD(p: PathSpec): string {
  return p.kind === 'line'
    ? `M${p.a.x},${p.a.y} L${p.b.x},${p.b.y}`
    : `M${p.a.x},${p.a.y} C${p.c1.x},${p.c1.y} ${p.c2.x},${p.c2.y} ${p.b.x},${p.b.y}`;
}

/** Path spec for a required/extra edge from `a` to `b`, straight unless it would otherwise
 * visually cut through some OTHER node's box (a same-column, multi-row-deep layout can stack an
 * unrelated node directly on the straight path between a parent and a farther, non-adjacent
 * child) -- since node boxes paint over edges to hide a line merely passing near a box's own
 * center, an unrouted straight line there reads as two separate arrows meeting at the blocker
 * instead of one long edge skipping past it. When blocked, bulge around every blocking box
 * combined (a single detour spanning their full top-to-bottom extent) via a cubic Bezier -- the
 * control points sit level with the span's top/bottom so the curve only bows out for that
 * y-range and tracks the straight line everywhere else. `bowLeft` picks which side (see
 * bowsLeft); the two are symmetric since GAP_X (30) comfortably exceeds the 20px bow offset in
 * either direction. */
function buildPathSpec(a: Pt, b: Pt, blockers: Rect[], bowLeft: boolean): PathSpec {
  if (blockers.length === 0) return { kind: 'line', a, b };
  const top = Math.min(...blockers.map(r => r.y)) - 12;
  const bottom = Math.max(...blockers.map(r => r.y + r.h)) + 12;
  const bx = bowLeft
    ? Math.min(...blockers.map(r => r.x)) - 20
    : Math.max(...blockers.map(r => r.x + r.w)) + 20;
  return { kind: 'cubic', a, c1: { x: bx, y: top }, c2: { x: bx, y: bottom }, b };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The four T-Tree edge kinds' shared styling, keyed once so the SVG pane and the TikZ exporter
 * (buildTikzExport, below) can never drift apart on what a "required"/"bypassed"/"resolve"/"extra"
 * edge looks like -- each renderer only picks its own `svgMarker` or `tikzStyle` field out of the
 * same table. */
type EdgeStyleKind = 'required' | 'bypassed' | 'resolve' | 'extra';
const EDGE_STYLE: Record<EdgeStyleKind, { stroke: string; svgMarker: string; tikzStyle: string; tikzColor: string }> = {
  required: { stroke: '#1a1a1a', svgMarker: 'ttree-arrow-req', tikzStyle: 'edge', tikzColor: 'ttreeReq' },
  bypassed: { stroke: '#DD1111', svgMarker: 'ttree-arrow-bypassed', tikzStyle: 'bypassed', tikzColor: 'ttreeBypass' },
  resolve: { stroke: '#1565C0', svgMarker: 'ttree-arrow-resolve', tikzStyle: 'resolve', tikzColor: 'ttreeResolve' },
  extra: { stroke: '#888', svgMarker: 'ttree-arrow-extra', tikzStyle: 'extra', tikzColor: 'ttreeExtra' },
};

/** '#rgb' or '#rrggbb' -> 'RRGGBB' (TikZ \definecolor's HTML form), so EDGE_STYLE.stroke can feed
 * the TikZ exporter directly instead of a second hand-typed copy of the same hex value. */
function hexToTikzHtml(hex: string): string {
  const h = hex.slice(1);
  return (h.length === 3 ? h.split('').map(c => c + c).join('') : h).toUpperCase();
}

interface SegmentSpec { from: string; to: string; styleKind: EdgeStyleKind; dashed: boolean }
interface PlacedSegment extends SegmentSpec { a: Pt; b: Pt; blockers: Rect[]; path: PathSpec }

/** Turns a graph's raw edges into final, routed, pixel-space segments -- dedup, same-pair
 * parallel fan-out, detour bows around blocking boxes, crossing-minimization, and the
 * shared-origin straight/curve nudge, all exactly as the SVG pane needs them. Shared verbatim with
 * the TikZ exporter (buildTikzExport, below) so the two renderers can never draw a different graph
 * shape from the same underlying tree -- only their final coordinate space and stroke syntax
 * differ. */
function buildPlacedSegments(graph: TTreeGraph, layout: TTreeLayout, rects: Map<string, Rect>): PlacedSegment[] {
  const segments: SegmentSpec[] = [];
  for (const e of graph.edges) {
    if (e.kind === 'required') {
      segments.push({ from: e.from, to: e.to, styleKind: 'required', dashed: false });
    } else if (e.kind === 'extra') {
      segments.push({ from: e.from, to: e.to, styleKind: 'extra', dashed: true });
    } else if (e.via) {
      // Two real hops, each drawn (and detour-routed) independently, per the user's own color
      // scheme: red from the parent to the child that gets bypassed, blue from that bypassed
      // child on to the grandchild that actually satisfies the family (i.e. that allows the
      // bypass).
      segments.push({ from: e.from, to: e.via, styleKind: 'bypassed', dashed: false });
      segments.push({ from: e.via, to: e.to, styleKind: 'resolve', dashed: false });
    } else {
      segments.push({ from: e.from, to: e.to, styleKind: 'bypassed', dashed: false });
    }
  }

  // Collapse exact duplicates first -- e.g. two different bypasses (different red parents) that
  // happen to share the identical via->grandchild resolve step produce the SAME blue segment
  // twice; the red halves already show there were multiple paths in, so the repeated blue tail
  // adds nothing -- only the first survives (per the user's own "duplicates can be hidden, only
  // the first blue line is relevant" call).
  const seenSegments = new Set<string>();
  const dedupedSegments = segments.filter(s => {
    const key = `${s.from} ${s.to} ${s.styleKind}`;
    if (seenSegments.has(key)) return false;
    seenSegments.add(key);
    return true;
  });

  // Fan out same-(from,to) duplicates that DIFFER by color/kind (e.g. a node that both requires
  // and separately resolves a bypass into the exact same child) into parallel offset lines, per
  // the user's own request -- knowing both an edge exists AND what kind it is matters, so a
  // black+blue pair into the same target stays visible as two lines rather than collapsing.
  const bySamePair = new Map<string, SegmentSpec[]>();
  for (const s of dedupedSegments) {
    const key = `${s.from} ${s.to}`;
    (bySamePair.get(key) ?? bySamePair.set(key, []).get(key)!).push(s);
  }
  const PARALLEL_SPACING = 5;

  const placed: PlacedSegment[] = [];
  for (const group of bySamePair.values()) {
    group.forEach((s, i) => {
      const aRect = rects.get(s.from);
      const bRect = rects.get(s.to);
      if (!aRect || !bRect) return;
      let a = centerOfRect(aRect);
      let b = centerOfRect(bRect);
      const offset = (i - (group.length - 1) / 2) * PARALLEL_SPACING;
      if (offset !== 0) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = (-dy / len) * offset;
        const py = (dx / len) * offset;
        a = { x: a.x + px, y: a.y + py };
        b = { x: b.x + px, y: b.y + py };
      }
      const blockers: Rect[] = [];
      for (const [id, rect] of rects) {
        if (id === s.from || id === s.to) continue;
        if (lineHitsRect(a.x, a.y, b.x, b.y, rect)) blockers.push(rect);
      }
      const path = buildPathSpec(a, b, blockers, bowsLeft(s.from, layout));
      placed.push({ ...s, a, b, blockers, path });
    });
  }

  // Row-parity (bowsLeft) stays the default bow direction, but if the OTHER direction crosses
  // fewer of the tree's other edges, use that instead -- per the user's own "it isn't as important
  // anymore, but prefer fewer crossings when they conflict" call. A single greedy pass (compare
  // against every other edge's CURRENT path, keep the better direction) rather than a full
  // simultaneous optimization -- good enough for the modest edge counts this pane ever draws.
  for (const seg of placed) {
    if (seg.blockers.length === 0) continue;
    const altPath = buildPathSpec(seg.a, seg.b, seg.blockers, !bowsLeft(seg.from, layout));
    const others = placed.filter(o => o !== seg);
    const currentCrossings = others.reduce((sum, o) => sum + countCrossings(seg.path, o.path), 0);
    const altCrossings = others.reduce((sum, o) => sum + countCrossings(altPath, o.path), 0);
    if (altCrossings < currentCrossings) seg.path = altPath;
  }

  // A straight edge that crosses a CURVED sibling leaving the exact same node reads as an ugly X
  // right at their shared origin (the curve's own bow swings toward one side then back, briefly
  // overtaking the straight edge's more gradual path to a farther target). Search a small set of
  // horizontal nudges to the straight edge's own START point (never its target) for one that
  // clears every such crossing -- capped to roughly the source box's own half-width so the line
  // still visibly leaves from within it.
  const byFrom = new Map<string, PlacedSegment[]>();
  for (const seg of placed) (byFrom.get(seg.from) ?? byFrom.set(seg.from, []).get(seg.from)!).push(seg);
  for (const [fromId, segs] of byFrom) {
    const curved = segs.filter(s => s.path.kind === 'cubic');
    if (curved.length === 0) continue;
    const fromRect = rects.get(fromId);
    const maxDelta = fromRect ? Math.max(10, fromRect.w / 2 - 6) : 40;
    const deltas: number[] = [];
    for (let frac = 0.2; frac <= 1.0001; frac += 0.2) deltas.push(maxDelta * frac, -maxDelta * frac);
    for (const straight of segs) {
      if (straight.path.kind !== 'line') continue;
      if (!curved.some(c => countCrossings(straight.path, c.path) > 0)) continue;
      for (const delta of deltas) {
        const candidate: PathSpec = { kind: 'line', a: { x: straight.a.x + delta, y: straight.a.y }, b: straight.b };
        if (curved.every(c => countCrossings(candidate, c.path) === 0)) {
          straight.path = candidate;
          break;
        }
      }
    }
  }

  return placed;
}

function renderSvg(graph: TTreeGraph, layout: TTreeLayout): string {
  const rects = computeNodeRects(graph, layout);
  // +20 for the rare detour bow that clears the rightmost box in a row (see edgePathD) -- still
  // within GAP_X's own gap before a neighboring box would start, so this never has to grow with
  // graph size.
  let maxRight = MARGIN;
  for (const r of rects.values()) maxRight = Math.max(maxRight, r.x + r.w);
  const width = maxRight + MARGIN + 20;
  const height = MARGIN * 2 + layout.rowLevels.length * ROW_PX;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  );
  // Arrowhead fill colors are read straight off EDGE_STYLE.stroke (not re-typed) so they can't
  // drift from the edge lines themselves -- see EDGE_STYLE's own comment.
  const markers = Object.values(EDGE_STYLE)
    .map(
      style => `      <marker id="${style.svgMarker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="${style.stroke}" />
      </marker>`,
    )
    .join('\n');
  parts.push(`\n    <defs>\n${markers}\n    </defs>\n  `);

  const placed = buildPlacedSegments(graph, layout, rects);

  // Edges first, so node boxes paint over any edge that passes near their own center.
  for (const seg of placed) {
    const style = EDGE_STYLE[seg.styleKind];
    const dash = seg.dashed ? ' stroke-dasharray="5,4"' : '';
    parts.push(
      `<path d="${pathD(seg.path)}" fill="none" stroke="${style.stroke}" stroke-width="1.6"${dash} marker-end="url(#${style.svgMarker})" />`,
    );
  }

  for (const node of graph.nodes.values()) {
    const rect = rects.get(node.id);
    if (!rect) continue;
    const { x, y, w, h } = rect;
    const lines = nodeLabel(node);
    const flagged = node.name === null && node.requiredByAny;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${flagged ? '#fff3f3' : '#fff'}" stroke="${flagged ? '#c0392b' : '#444'}" stroke-width="1.2" />`,
    );
    lines.forEach((line, i) => {
      const ty = y + h / 2 + (lines.length === 1 ? 5 : i === 0 ? -3 : 15);
      const cls = i === 0 ? 'font-size:13px;fill:#1a1a1a' : 'font-size:12px;fill:#555';
      parts.push(
        `<text x="${x + w / 2}" y="${ty}" text-anchor="middle" style="${cls};font-family:inherit">${escapeXml(line)}</text>`,
      );
    });
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// Pixel-to-cm scale for the TikZ exporter, below -- chosen so ROW_PX's own 130px maps to ~2.4cm,
// matching what used to be the export's own hand-picked ROW_UNIT, so an existing pasted figure's
// rough scale doesn't jump on re-export. Applies uniformly to x and y so relative proportions
// (row spacing vs. box width vs. gaps) come through unchanged from the pane's own layout.
const PX_TO_CM = 0.0185;

function toLatexPt(p: Pt): { x: number; y: number } {
  // TikZ's y-axis points up; this pane's (and the SVG's) own row/pixel space points down.
  return { x: p.x * PX_TO_CM, y: -p.y * PX_TO_CM };
}
const fmt = (n: number): string => n.toFixed(3);

/** TikZ export matching the SVG pane pixel-for-pixel in everything but literal unit size: same
 * `computeNodeRects` box positions/sizes, same `buildPlacedSegments` edge routing (dedup, bows,
 * crossing-minimization, shared-origin nudges), same required/bypassed/resolve/extra coloring
 * (EDGE_STYLE), and the same flagged-node red styling for an unnamed-but-required position. Edges
 * are emitted as raw coordinates (straight `--` or a cubic `.. controls .. and ..`) rather than
 * named-node connections, since a fanned-out parallel duplicate or a nudged shared-origin start
 * point is deliberately offset from the node's own center -- exactly mirroring how the SVG path
 * itself is built from `centerOfRect`-derived points, not anchors. */
function buildTikzExport(graph: TTreeGraph, layout: TTreeLayout): string {
  const rects = computeNodeRects(graph, layout);
  const placed = buildPlacedSegments(graph, layout, rects);

  const lines: string[] = [];
  lines.push('% Requires \\usepackage{tikz} and \\usepackage{xcolor} in the preamble.');
  lines.push('\\begin{tikzpicture}');
  // Same source as the SVG markers above (EDGE_STYLE.stroke) -- not a second hardcoded copy.
  for (const style of Object.values(EDGE_STYLE)) {
    lines.push(`  \\definecolor{${style.tikzColor}}{HTML}{${hexToTikzHtml(style.stroke)}}`);
  }
  lines.push('  \\definecolor{ttreeBoxBorder}{HTML}{444444}');
  lines.push('  \\definecolor{ttreeFlagBorder}{HTML}{C0392B}');
  lines.push('  \\definecolor{ttreeFlagFill}{HTML}{FFF3F3}');
  lines.push('  \\definecolor{ttreeNameText}{HTML}{555555}');
  lines.push('  \\tikzset{');
  lines.push('    edge/.style = {->,>=latex,color=ttreeReq,line width=1.2pt},');
  lines.push('    bypassed/.style = {->,>=latex,color=ttreeBypass,line width=1.2pt},');
  lines.push('    resolve/.style = {->,>=latex,color=ttreeResolve,line width=1.2pt},');
  lines.push('    extra/.style = {->,>=latex,color=ttreeExtra,line width=1.2pt,dashed},');
  lines.push('    ttreebox/.style = {rectangle,rounded corners=2pt,draw=ttreeBoxBorder,line width=0.9pt,fill=white,align=center},');
  lines.push('    ttreeboxflag/.style = {rectangle,rounded corners=2pt,draw=ttreeFlagBorder,line width=0.9pt,fill=ttreeFlagFill,align=center},');
  lines.push('  }');
  lines.push('');

  // Edges first, so the (opaque-filled) node boxes drawn after paint over any edge that passes
  // near their own center -- same z-order reasoning as the SVG pane's own comment above.
  for (const seg of placed) {
    const style = EDGE_STYLE[seg.styleKind].tikzStyle;
    if (seg.path.kind === 'line') {
      const a = toLatexPt(seg.path.a);
      const b = toLatexPt(seg.path.b);
      lines.push(`  \\draw[${style}] (${fmt(a.x)},${fmt(a.y)}) -- (${fmt(b.x)},${fmt(b.y)});`);
    } else {
      const a = toLatexPt(seg.path.a);
      const c1 = toLatexPt(seg.path.c1);
      const c2 = toLatexPt(seg.path.c2);
      const b = toLatexPt(seg.path.b);
      lines.push(
        `  \\draw[${style}] (${fmt(a.x)},${fmt(a.y)}) .. controls (${fmt(c1.x)},${fmt(c1.y)}) and (${fmt(c2.x)},${fmt(c2.y)}) .. (${fmt(b.x)},${fmt(b.y)});`,
      );
    }
  }
  lines.push('');

  for (const node of graph.nodes.values()) {
    const rect = rects.get(node.id);
    if (!rect) continue;
    const center = toLatexPt(centerOfRect(rect));
    const w = fmt(rect.w * PX_TO_CM);
    const h = fmt(rect.h * PX_TO_CM);
    const flagged = node.name === null && node.requiredByAny;
    const boxStyle = flagged ? 'ttreeboxflag' : 'ttreebox';
    const label = nodeLabel(node)
      .map((line, i) => {
        const mathText = toLatexMath(line);
        return i === 0 ? `$${mathText}$` : `{\\footnotesize\\color{ttreeNameText}$${mathText}$}`;
      })
      .join(' \\\\ ');
    lines.push(
      `  \\node[${boxStyle}, minimum width=${w}cm, minimum height=${h}cm] at (${fmt(center.x)},${fmt(center.y)}) {${label}};`,
    );
  }

  lines.push('\\end{tikzpicture}');
  return lines.join('\n');
}

function render(): void {
  const statusEl = document.getElementById('ttree-status') as HTMLDivElement;
  statusEl.textContent = status;
  statusEl.className = 'ttree-status' + (statusIsError ? ' ttree-status-error' : '');

  const container = document.getElementById('ttree-graph-container') as HTMLDivElement;
  container.innerHTML = '';
  if (lastGraph && lastLayout) {
    container.innerHTML = renderSvg(lastGraph, lastLayout);
  }
}

async function runSearch(raw: string): Promise<void> {
  const myGen = ++searchGen;
  status = 'Building…';
  statusIsError = false;
  lastGraph = null;
  lastLayout = null;
  render();

  const result = await buildTTree(raw);
  if (myGen !== searchGen) return;

  if (!result.ok) {
    status = result.error;
    statusIsError = true;
    render();
    return;
  }

  lastGraph = result.graph;
  lastLayout = layoutTTree(result.graph);
  status = '';
  statusIsError = false;
  render();
}

async function runExport(): Promise<void> {
  if (!lastGraph || !lastLayout) return;
  const tikz = buildTikzExport(lastGraph, lastLayout);
  try {
    await navigator.clipboard.writeText(tikz);
    status = 'TikZ copied to clipboard.';
    statusIsError = false;
  } catch {
    status = "Couldn't copy to the clipboard.";
    statusIsError = true;
  }
  render();
}

export function initTTree(): void {
  if (wired) return;
  wired = true;

  const input = document.getElementById('ttree-search-input') as HTMLInputElement;
  input.value = DEFAULT_ENCODING;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runSearch(input.value);
    }
  });

  const exportBtn = document.getElementById('ttree-export-btn') as HTMLButtonElement;
  exportBtn.addEventListener('click', () => void runExport());

  void runSearch(DEFAULT_ENCODING);
}
