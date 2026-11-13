/**
 * T-Tree "Export Tables" bulk dump: one self-contained LaTeX document with the two parts below.
 * Everything is read off the graph, so a merged multi-root tree (several ';'-separated left sides)
 * gets the union of its roots' tables, each position once.
 *
 *  1. a genome table (collect.ts's `buildPaperGenomeTable` -- Collect's Export table as one \gtable
 *     call, cell values only; the preamble's GENOME_LATEX_MACROS lay it out and \defgenome lines
 *     fill in each named genome's closing row) for every node that isn't merely bypassed -- i.e.
 *     every `requiredByAny` node.
 *     A bypassed T-child (only red edges into it, only a blue edge out of it) never gets
 *     `requiredByAny`, so that flag is exactly the "not bypassed" filter; a node that's ALSO required
 *     or resolved-into elsewhere does carry it and does get a table. A T-child that IS bypassed shows
 *     the position it bypasses to (the tree's own red-then-blue edge) in the table's last column.
 *  2. ONE nimber table proving every R/D/L/Z-child nimber those genome tables quote: the full game
 *     tree below each of those children, as single subpositions (connected components -- a sum's
 *     nimber is the XOR of its components'). Rows are grouped by parent, fewest max remaining moves first
 *     (ties by printed tuple order, see compareRows), so by the time a parent appears every child it
 *     lists has already been proven further up. A parent's group lists each of its distinct children,
 *     by nimber then printed tuple order (max moves plays no part here), with that child's nimber (a child that is
 *     itself a sum shows just its nimber, which is the XOR of its components' nimbers -- all earlier
 *     parents -- re-checked but not written out).
 *
 * Nimbers are all real engine values (`analyze`, never quick-canon). The XOR on a sum child and the
 * mex on each parent are re-checked against the engine's own numbers; a disagreement is flagged in
 * the output, never silently dropped.
 */

import { analyze, canonFullSync } from '../engine/stalks';
import { type MoveChildRef } from '../model/collectAlpha';
import { type TTreeGraph, type TTreeNode } from '../model/ttree';
import {
  buildPaperGenomeTable,
  GENOME_LATEX_MACROS,
  genomeDefinitionsLatex,
  tablesEncodingText,
  toLatexSymbols,
} from './collect';
import { csvBlob } from './saveFile';

interface ChildEntry {
  enc: string;
  /** Engine nimber of the whole child (null only if the parent couldn't be valued). */
  nimber: number | null;
  /** Engine max remaining moves of the whole child (null only if the parent couldn't be valued). */
  maxMoves: number | null;
  /** The child's single subpositions (empty for the dead position 'N'). */
  comps: string[];
}

interface GamePosition {
  enc: string;
  nimber: number | null;
  maxMoves: number | null;
  children: ChildEntry[];
}

const piecesOf = (enc: string): string[] => enc.split('+').filter(p => p !== 'N' && p !== '');

/** A position's printed form -- the same compressed text the table prints (fullEncoding), minus
 * brackets -- as subpositions, each a list of regions, each a list of boundaries. */
function printedTuple(comps: string[]): string[][][] {
  return comps.map(c => (canonFullSync(c) ?? c).split('|').map(region => region.split(',')));
}

/** A boundary token's digit value: 0-9 as themselves, membrane letters A-Z as 10-35 (base 36), and
 * alpha (or any other special point) after those. */
const tokenValue = (ch: string): number =>
  ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : 36;

/** Boundaries by numeric value, reading each as a number in those digits: with leading zeros
 * dropped, fewer digits is smaller, then digit by digit. Equal values (only possible with leading
 * zeros) fall back to the full text, to stay deterministic. */
function compareBoundaries(a: string, b: string): number {
  const ta = a.replace(/^0+(?=.)/, '');
  const tb = b.replace(/^0+(?=.)/, '');
  if (ta.length !== tb.length) return ta.length - tb.length;
  for (let i = 0; i < ta.length; i++) {
    const d = tokenValue(ta[i]) - tokenValue(tb[i]);
    if (d) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Element-by-element comparison of two lists, with fewer elements always first. */
function compareLists<T>(a: T[], b: T[], cmp: (x: T, y: T) => number): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = cmp(a[i], b[i]);
    if (d) return d;
  }
  return 0;
}

/** Canon-style order on printed positions: fewer subpositions first, then subposition by
 * subposition (fewer regions first), region by region (fewer boundaries first), and boundary by
 * boundary (lowest numeric value first). */
function compareTuples(a: string[][][], b: string[][][]): number {
  return compareLists(a, b, (sa, sb) =>
    compareLists(sa, sb, (ra, rb) => compareLists(ra, rb, compareBoundaries)),
  );
}

/** The table's row order: fewest max remaining moves first (so every child a row lists was proven
 * further up), then the printed tuple order. */
function compareRows(
  a: { maxMoves: number | null; comps: string[] },
  b: { maxMoves: number | null; comps: string[] },
): number {
  return (a.maxMoves ?? -1) - (b.maxMoves ?? -1) || compareTuples(printedTuple(a.comps), printedTuple(b.comps));
}

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
    const pos: GamePosition = { enc, nimber: null, maxMoves: null, children: [] };
    positions.set(enc, pos); // before recursing -- a position is never its own descendant, but cheap insurance
    if (!res.ok) return;
    pos.nimber = res.nimber;
    pos.maxMoves = res.maxMoves;
    const seen = new Set<string>();
    for (const c of res.children) {
      if (seen.has(c.enc)) continue;
      seen.add(c.enc);
      pos.children.push({ enc: c.enc, nimber: c.nimber, maxMoves: c.maxMoves, comps: piecesOf(c.enc) });
    }
    for (const child of pos.children) {
      for (const comp of child.comps) await visit(comp);
    }
    if (positions.size % 25 === 0) onProgress?.(`Walking game tree… ${positions.size} positions`);
  };
  for (const seed of seeds) await visit(seed);
  return positions;
}

/** Full positions here, not left sides: membrane letters start at A (tablesEncoding's `full`).
 * Plain text (⊕/α as Unicode); the LaTeX table converts it with toLatexSymbols. */
const fullEncoding = (enc: string): string => tablesEncodingText(enc, true);

/** A nimber-table cell value: the printed position (or sum), its nimber, and whether a re-check
 * against the engine disagreed. */
interface NimberCell {
  printed: string;
  nimber: number | null;
  bad: boolean;
}

/** One nimber-table row: a parent and its distinct children, in table order. */
interface NimberRow extends NimberCell {
  children: NimberCell[];
}

/** The single nimber table's rows (see the module header), format-independent. */
function buildNimberRows(positions: Map<string, GamePosition>): NimberRow[] {
  const label = (comps: string[]): string => (comps.length ? comps.map(fullEncoding).join(' ⊕ ') : 'φ');

  const ordered = [...positions.values()].sort((a, b) =>
    compareRows({ maxMoves: a.maxMoves, comps: [a.enc] }, { maxMoves: b.maxMoves, comps: [b.enc] }),
  );

  // Distinct engine positions can print identically (fullEncoding's DisaPoint compression), and each
  // printed form gets ONE row: its children are the union of every such position's children, again
  // one per printed form. A row sits where its first position sorts. Every member still gets its own
  // mex check, and members (or same-printed children) disagreeing on a nimber flag the row.
  const groups = new Map<string, GamePosition[]>();
  for (const pos of ordered) {
    const key = fullEncoding(pos.enc);
    groups.set(key, [...(groups.get(key) ?? []), pos]);
  }
  const rows: NimberRow[] = [];
  for (const [printed, members] of groups) {
    const nimber = members[0].nimber;
    const mexBad = members.some(pos => {
      const known = pos.children.every(c => c.nimber !== null);
      return known && pos.nimber !== null && mexOf(pos.children.map(c => c.nimber as number)) !== pos.nimber;
    });

    const children = members
      .flatMap(pos => pos.children)
      .sort((a, b) => (a.nimber ?? -1) - (b.nimber ?? -1) || compareTuples(printedTuple(a.comps), printedTuple(b.comps)));
    const childCells = new Map<string, NimberCell>();
    for (const child of children) {
      const xor = child.comps.reduce((acc, c) => acc ^ (positions.get(c)?.nimber ?? 0), 0);
      const compsKnown = child.comps.every(c => positions.get(c)?.nimber != null);
      // The cell is just the nimber; the component XOR is still re-checked and only surfaces on a mismatch.
      const xorBad = child.comps.length > 1 && compsKnown && child.nimber !== null && child.nimber !== xor;
      const key = label(child.comps);
      const prev = childCells.get(key);
      if (prev) prev.bad ||= xorBad || prev.nimber !== child.nimber;
      else childCells.set(key, { printed: key, nimber: child.nimber, bad: xorBad });
    }
    rows.push({
      printed,
      nimber,
      bad: mexBad || members.some(pos => pos.nimber !== nimber),
      children: [...childCells.values()],
    });
  }
  return rows;
}

/** The nimber table as LaTeX. */
function nimberTableLatex(rows: NimberRow[]): string {
  const tex = (text: string): string => (text === 'φ' ? '\\phi' : toLatexSymbols(text));

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
  const allChildren = rows.flatMap(r => r.children);
  const widths = {
    pos: widthCm(rows.map(r => tex(r.printed)), 'Position', 8),
    nim: widthCm(rows.map(r => fmtNim(r.nimber)), 'Nimber', 2),
    child: widthCm(allChildren.map(c => tex(c.printed)), 'Child', 12),
    childNim: widthCm(allChildren.map(c => fmtNim(c.nimber)), 'Child nimber', 4),
  };
  const nested = (cells: string[]): string =>
    `\\begin{tabular}[c]{@{}${centered}p{${widths.child}}|${centered}p{${widths.childNim}}@{}}${cells.join(' \\\\ \\hline ')}\\end{tabular}`;
  const flag = (bad: boolean): string => (bad ? ' \\ \\mathbf{(!)}' : '');

  const lines: string[] = [];
  lines.push(`\\begin{longtable}{|${centered}m{${widths.pos}}|${centered}m{${widths.nim}}|@{}c@{}|}`);
  lines.push(`\\hline Position & Nimber & ${nested(['Child & Child nimber'])} \\\\ \\hline \\endhead`);
  for (const row of rows) {
    const childRows = row.children.map(c => `$${tex(c.printed)}$ & $${fmtNim(c.nimber)}${flag(c.bad)}$`);
    lines.push(`$${tex(row.printed)}$ & $${fmtNim(row.nimber)}${flag(row.bad)}$ & ${nested(childRows)} \\\\ \\hline`);
  }
  lines.push('\\end{longtable}');
  return lines.join('\n');
}

/** How many cells (parents and children) failed a re-check against the engine. */
function failedCheckCount(rows: NimberRow[]): number {
  return rows.reduce((n, r) => n + Number(r.bad) + r.children.filter(c => c.bad).length, 0);
}

/** The nimber table as CSV: one line per (parent, child) pair, the parent repeated on each (a
 * childless parent gets one line with the child columns empty). A failed re-check shows as "!" in
 * that cell's Check column; each Check column is left out when nothing in it failed. */
function nimberTableCsv(rows: NimberRow[]): Blob {
  const check = (bad: boolean): string => (bad ? '!' : '');
  const parentChecks = rows.some(r => r.bad);
  const childChecks = rows.some(r => r.children.some(c => c.bad));
  const header = ['Position', 'Nimber', ...(parentChecks ? ['Check'] : []), 'Child', 'Child nimber'];
  if (childChecks) header.push('Child check');
  const lines = [header];
  for (const row of rows) {
    const parent = [row.printed, fmtNim(row.nimber)];
    if (parentChecks) parent.push(check(row.bad));
    const children = row.children.length ? row.children : [null];
    for (const c of children) {
      const child = c ? [c.printed, fmtNim(c.nimber)] : ['', ''];
      if (childChecks) child.push(c ? check(c.bad) : '');
      lines.push([...parent, ...child]);
    }
  }
  return csvBlob(lines);
}

/** An export's file contents plus how many of its nimber-table re-checks failed (see failedCheckCount). */
export interface TTreeExport {
  blob: Blob;
  failedChecks: number;
}

/** The nodes that get a genome table (every non-bypassed one), smallest (fewest lives) first. */
function genomeTableNodes(graph: TTreeGraph): TTreeNode[] {
  return [...graph.nodes.values()]
    .filter(n => n.requiredByAny)
    .sort((a, b) => a.lives - b.lives || (a.id < b.id ? -1 : 1));
}

/** The nimber table's seeds: the single subpositions of every R/D/L/Z child the genome tables quote. */
function nimberTableSeeds(nodes: TTreeNode[]): string[] {
  const seeds = new Set<string>();
  for (const node of nodes) {
    const g = node.genome;
    const moveChildren: (MoveChildRef | undefined)[] = [g.Rc, g.Dc, ...(g.Lc ?? []), ...(g.Zc ?? [])];
    for (const c of moveChildren) if (c) for (const p of piecesOf(c.enc)) seeds.add(p);
  }
  return [...seeds];
}

/** Just the nimber table, as CSV (no genome tables). */
export async function buildTTreeNimberCsv(
  graph: TTreeGraph,
  onProgress?: (message: string) => void,
): Promise<TTreeExport> {
  const positions = await collectGameTree(nimberTableSeeds(genomeTableNodes(graph)), onProgress);
  const rows = buildNimberRows(positions);
  return { blob: nimberTableCsv(rows), failedChecks: failedCheckCount(rows) };
}

/** The whole dump as one compilable LaTeX document (see the module header). `onProgress` gets a
 * human-readable status line as the work proceeds. */
export async function buildTTreeTablesLatex(
  graph: TTreeGraph,
  onProgress?: (message: string) => void,
): Promise<TTreeExport> {
  const nodes = genomeTableNodes(graph);

  const tables: string[] = [];
  const names: string[] = [];
  let done = 0;
  for (const node of nodes) {
    // bypassed T-child -> the position it bypasses to, for this node's own red-then-blue edge
    const bypassTargets = new Map<string, string>();
    for (const e of graph.edges) {
      if (e.from === node.id && e.kind === 'bypass' && e.via) bypassTargets.set(e.via, e.to);
    }
    const table = await buildPaperGenomeTable(node.id, bypassTargets);
    if (table.name) names.push(table.name);
    tables.push(`% node: ${node.id}`, table.latex, '');
    onProgress?.(`Genome tables… ${++done}/${nodes.length}`);
  }

  const lines: string[] = [];
  lines.push('\\documentclass{article}');
  lines.push('\\usepackage{amsmath,amssymb,array,longtable}');
  lines.push('\\usepackage[landscape,margin=1.2cm]{geometry}');
  lines.push(GENOME_LATEX_MACROS);
  lines.push(genomeDefinitionsLatex(names));
  lines.push('\\begin{document}');
  lines.push(`\\section*{Genome tables (${nodes.length} non-bypassed nodes)}`);
  lines.push(...tables);
  lines.push('\\clearpage');
  lines.push('\\section*{Nimber table}');
  const positions = await collectGameTree(nimberTableSeeds(nodes), onProgress);
  const rows = buildNimberRows(positions);
  lines.push(nimberTableLatex(rows));
  lines.push('\\end{document}');
  return {
    blob: new Blob([lines.join('\n')], { type: 'application/x-tex' }),
    failedChecks: failedCheckCount(rows),
  };
}
