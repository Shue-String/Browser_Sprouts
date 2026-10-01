/**
 * T-Tree "Export Tables" bulk dump: one self-contained LaTeX document with
 *
 *  1. a genome table (collect.ts's own `buildGenomeTableLatex`, the exact table Collect's Export
 *     button produces) for every node that isn't merely bypassed -- i.e. every `requiredByAny` node.
 *     A bypassed T-child (only red edges into it, only a blue edge out of it) never gets
 *     `requiredByAny`, so that flag is exactly the "not bypassed" filter; a node that's ALSO required
 *     or resolved-into elsewhere does carry it and does get a table. A T-child that IS bypassed shows
 *     the position it bypasses to (the tree's own red-then-blue edge) in the table's last column.
 *  2. ONE nimber table proving every R/D/L/Z-child nimber those genome tables quote: the full game
 *     tree below each of those children, as single subpositions (connected components -- a sum's
 *     nimber is the XOR of its components'). Rows are grouped by parent, smallest (fewest lives) first,
 *     so by the time a parent appears every child it lists has already been proven further up. A
 *     parent's group lists each of its distinct children with that child's nimber (a child that is
 *     itself a sum shows just its nimber, which is the XOR of its components' nimbers -- all earlier
 *     parents -- re-checked but not written out).
 *
 * Nimbers are all real engine values (`analyze`, never quick-canon). The XOR on a sum child and the
 * mex on each parent are re-checked against the engine's own numbers; a disagreement is flagged in
 * the output, never silently dropped.
 */

import { analyze } from '../engine/stalks';
import { type MoveChildRef } from '../model/collectAlpha';
import { type TTreeGraph } from '../model/ttree';
import { buildGenomeTableLatex, exportEncoding } from './collect';

interface ChildEntry {
  enc: string;
  /** Engine nimber of the whole child (null only if the parent couldn't be valued). */
  nimber: number | null;
  /** The child's single subpositions (empty for the dead position 'N'). */
  comps: string[];
}

interface GamePosition {
  enc: string;
  nimber: number | null;
  lives: number;
  children: ChildEntry[];
}

const piecesOf = (enc: string): string[] => enc.split('+').filter(p => p !== 'N' && p !== '');

function mexOf(values: number[]): number {
  let m = 0;
  while (values.includes(m)) m++;
  return m;
}

const fmtNim = (n: number | null): string => (n === null ? '?' : String(n));

/** Every single subposition reachable from `seeds` (themselves included), each analyzed once. */
async function collectGameTree(
  seeds: string[],
  onProgress?: (message: string) => void,
): Promise<Map<string, GamePosition>> {
  const positions = new Map<string, GamePosition>();
  const visit = async (enc: string): Promise<void> => {
    if (positions.has(enc)) return;
    const res = await analyze(enc);
    const pos: GamePosition = { enc, nimber: null, lives: 0, children: [] };
    positions.set(enc, pos); // before recursing -- a position is never its own descendant, but cheap insurance
    if (!res.ok) return;
    pos.nimber = res.nimber;
    pos.lives = res.lives ?? enc.length;
    const seen = new Set<string>();
    for (const c of res.children) {
      if (seen.has(c.enc)) continue;
      seen.add(c.enc);
      pos.children.push({ enc: c.enc, nimber: c.nimber, comps: piecesOf(c.enc) });
    }
    for (const child of pos.children) {
      for (const comp of child.comps) await visit(comp);
    }
    if (positions.size % 25 === 0) onProgress?.(`Walking game tree… ${positions.size} positions`);
  };
  for (const seed of seeds) await visit(seed);
  return positions;
}

/** The single nimber table (see the module header). */
function buildNimberTable(positions: Map<string, GamePosition>): string {
  const label = (comps: string[]): string =>
    comps.length ? comps.map(c => exportEncoding(c)).join(' \\oplus ') : '\\emptyset';

  const ordered = [...positions.values()].sort((a, b) => a.lives - b.lives || (a.enc < b.enc ? -1 : 1));

  // Fixed-width columns: longtable otherwise sizes its columns from the previous LaTeX pass, so a
  // single compile draws the header row offset from the body.
  const centered = '>{\\centering\\arraybackslash}';
  // Each parent is ONE longtable row (a row can't break across pages, so a parent's children never get
  // separated from their label); its children live in a nested two-column table whose rows share
  // the child/nimber alignment by construction. The header uses the identical nested table so it
  // lines up with every body row exactly.
  // Column widths are sized to the data (longest cell, estimated from its visible characters) so the
  // table is only as wide as it needs to be; a cell that outgrows its cap just wraps.
  const visibleChars = (latex: string): number =>
    latex.replace(/\\[a-zA-Z]+\s?/g, 'x').replace(/[$_^{}\\]/g, '').length;
  const widthCm = (cells: string[], header: string, cap: number): string => {
    const longest = Math.max(header.length, ...cells.map(visibleChars));
    return `${Math.min(cap, longest * 0.2 + 0.3).toFixed(1)}cm`;
  };
  const widths = {
    pos: widthCm(ordered.map(p => exportEncoding(p.enc)), 'Position', 8),
    nim: widthCm(ordered.map(p => fmtNim(p.nimber)), 'Nimber', 2),
    child: widthCm(ordered.flatMap(p => p.children.map(c => label(c.comps))), 'Child', 12),
    childNim: widthCm(ordered.flatMap(p => p.children.map(c => fmtNim(c.nimber))), 'Child nimber', 4),
  };
  const nested = (rows: string[]): string =>
    `\\begin{tabular}[c]{@{}${centered}p{${widths.child}}|${centered}p{${widths.childNim}}@{}}${rows.join(' \\\\ \\hline ')}\\end{tabular}`;

  const lines: string[] = [];
  lines.push(`\\begin{longtable}{|${centered}m{${widths.pos}}|${centered}m{${widths.nim}}|@{}c@{}|}`);
  lines.push(`\\hline Position & Nimber & ${nested(['Child & Child nimber'])} \\\\ \\hline \\endhead`);
  for (const pos of ordered) {
    const children = [...pos.children].sort(
      (a, b) => (a.nimber ?? -1) - (b.nimber ?? -1) || (a.enc < b.enc ? -1 : 1),
    );
    const known = children.every(c => c.nimber !== null);
    const mexFlag =
      known && pos.nimber !== null && mexOf(children.map(c => c.nimber as number)) !== pos.nimber
        ? ' \\ \\mathbf{(!)}'
        : '';
    const childRows = children.map(child => {
      const xor = child.comps.reduce((acc, c) => acc ^ (positions.get(c)?.nimber ?? 0), 0);
      const compsKnown = child.comps.every(c => positions.get(c)?.nimber != null);
      // The cell is just the nimber; the component XOR is still re-checked and only surfaces on a mismatch.
      const xorFlag =
        child.comps.length > 1 && compsKnown && child.nimber !== null && child.nimber !== xor
          ? ' \\ \\mathbf{(!)}'
          : '';
      return `$${label(child.comps)}$ & $${fmtNim(child.nimber)}${xorFlag}$`;
    });
    lines.push(
      `$${exportEncoding(pos.enc)}$ & $${fmtNim(pos.nimber)}${mexFlag}$ & ${nested(childRows)} \\\\ \\hline`,
    );
  }
  lines.push('\\end{longtable}');
  return lines.join('\n');
}

/** The whole dump as one compilable LaTeX document (see the module header). `onProgress` gets a
 * human-readable status line as the work proceeds. */
export async function buildTTreeTablesLatex(
  graph: TTreeGraph,
  onProgress?: (message: string) => void,
): Promise<string> {
  // Smallest (fewest lives) first, same as the nimber table below.
  const nodes = [...graph.nodes.values()]
    .filter(n => n.requiredByAny)
    .sort((a, b) => a.lives - b.lives || (a.id < b.id ? -1 : 1));

  const lines: string[] = [];
  lines.push('\\documentclass{article}');
  lines.push('\\usepackage{amsmath,amssymb,array,longtable}');
  lines.push('\\usepackage[landscape,margin=1.2cm]{geometry}');
  lines.push('\\begin{document}');
  lines.push(`\\section*{Genome tables (${nodes.length} non-bypassed nodes)}`);

  const seeds = new Set<string>();
  let done = 0;
  for (const node of nodes) {
    // bypassed T-child -> the position it bypasses to, for this node's own red-then-blue edge
    const bypassTargets = new Map<string, string>();
    for (const e of graph.edges) {
      if (e.from === node.id && e.kind === 'bypass' && e.via) bypassTargets.set(e.via, e.to);
    }
    lines.push(`% node: ${node.id}`);
    lines.push('\\begin{center}');
    lines.push(await buildGenomeTableLatex(node.id, bypassTargets));
    lines.push('\\end{center}');
    lines.push('');

    const g = node.genome;
    const moveChildren: (MoveChildRef | undefined)[] = [g.Rc, g.Dc, ...(g.Lc ?? []), ...(g.Zc ?? [])];
    for (const c of moveChildren) if (c) for (const p of piecesOf(c.enc)) seeds.add(p);
    onProgress?.(`Genome tables… ${++done}/${nodes.length}`);
  }

  lines.push('\\clearpage');
  lines.push('\\section*{Nimber table}');
  const positions = await collectGameTree([...seeds], onProgress);
  lines.push(buildNimberTable(positions));
  lines.push('\\end{document}');
  return lines.join('\n');
}

/** Hands `text` to the browser as a file download (a sizable dump isn't practical to paste). */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-tex' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
