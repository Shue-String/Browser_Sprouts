/**
 * T-Tree pane: type a left-side encoding (same format as Collect's own search bar) to render the
 * tree of its T-moves only -- required T-genes as black arrows, bypasses as a curved arrow through
 * the bypassed child to the grandchild that satisfies it, and any unexplained "extra" T-child
 * (shouldn't occur for a genuinely registered element) as a dashed grey arrow. An Export button
 * copies an equivalent TikZ figure to the clipboard. See src/model/ttree.ts for the tree-building
 * and layout logic this only renders.
 */

import { shiftMembraneLetters } from '../model/collectAlpha';
import {
  type TTreeGraph,
  type TTreeLayout,
  type TTreeNode,
  buildTikz,
  buildTTree,
  layoutTTree,
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
  const enc = bracketDisplaySlash(markAlpha(shiftMembraneLetters(node.id)));
  return node.name && node.requiredByAny ? [enc, node.name] : [enc];
}

const COL_PX = 190;
const ROW_PX = 130;
const BOX_W = 160;
const BOX_H_1LINE = 34;
const BOX_H_2LINE = 50;
const MARGIN = 40;

function boxSize(node: TTreeNode): { w: number; h: number } {
  return { w: BOX_W, h: node.name && node.requiredByAny ? BOX_H_2LINE : BOX_H_1LINE };
}

function centerOf(node: TTreeNode, layout: TTreeLayout): { x: number; y: number } {
  const pos = layout.positions.get(node.id);
  if (!pos) return { x: MARGIN, y: MARGIN };
  return { x: MARGIN + pos.col * COL_PX + BOX_W / 2, y: MARGIN + pos.row * ROW_PX + boxSize(node).h / 2 };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSvg(graph: TTreeGraph, layout: TTreeLayout): string {
  let maxCol = 0;
  for (const pos of layout.positions.values()) maxCol = Math.max(maxCol, pos.col);
  const width = MARGIN * 2 + (maxCol + 1) * COL_PX;
  const height = MARGIN * 2 + layout.rowLevels.length * ROW_PX;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  );
  parts.push(`
    <defs>
      <marker id="ttree-arrow-req" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#1a1a1a" />
      </marker>
      <marker id="ttree-arrow-bypass" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#DD1111" />
      </marker>
      <marker id="ttree-arrow-extra" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#888" />
      </marker>
    </defs>
  `);

  // Edges first, so node boxes paint over any edge that passes near their own center.
  for (const e of graph.edges) {
    const from = graph.nodes.get(e.from);
    const to = graph.nodes.get(e.to);
    if (!from || !to) continue;
    const a = centerOf(from, layout);
    const b = centerOf(to, layout);
    if (e.kind === 'required') {
      parts.push(
        `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#1a1a1a" stroke-width="1.6" marker-end="url(#ttree-arrow-req)" />`,
      );
    } else if (e.kind === 'bypass') {
      const via = e.via ? graph.nodes.get(e.via) : undefined;
      const mid = via ? centerOf(via, layout) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Quadratic curve through the bypassed child's own position, per the user's "arrow travels
      // through the bypassed child" request -- a slight extra bow so it reads as a curve rather
      // than a straight line that happens to pass through a point.
      const bow = 18;
      const cx = mid.x + bow;
      parts.push(
        `<path d="M${a.x},${a.y} Q${cx},${mid.y} ${b.x},${b.y}" fill="none" stroke="#DD1111" stroke-width="1.6" marker-end="url(#ttree-arrow-bypass)" />`,
      );
    } else {
      parts.push(
        `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#888" stroke-width="1.4" stroke-dasharray="5,4" marker-end="url(#ttree-arrow-extra)" />`,
      );
    }
  }

  for (const node of graph.nodes.values()) {
    const pos = layout.positions.get(node.id);
    if (!pos) continue;
    const { w, h } = boxSize(node);
    const x = MARGIN + pos.col * COL_PX;
    const y = MARGIN + pos.row * ROW_PX;
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
  const tikz = buildTikz(lastGraph, lastLayout, nodeLabel);
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
