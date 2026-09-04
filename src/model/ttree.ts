/**
 * T-Tree: given a left-side encoding (in the same format Collect's search bar accepts), build the
 * tree of its T-moves only, distinguishing REQUIRED T-genes (a node's own resolved family's
 * `tChildPlains`) from BYPASSED ones (a T-child that isn't itself required, but one of its own
 * T-children -- a grandchild -- resolves back to the SAME family, so play can return to it one
 * move later) from unexplained "extra" T-children (drawn but flagged, shouldn't occur for a
 * genuinely registered element). This reuses collectAlpha.ts's `resolvedFoldName`/
 * `classifyTChildren` -- the exact same decision logic collect.ts's own T-gene table uses, applied
 * once per node instead of once for a single pane-wide searched genome (see that module's own doc
 * comments for the underlying rule).
 *
 * Not a discovery tool: every position encountered is resolved via the same two-tier lookup
 * Collect's own `lookupGenome` uses (the offline `collectAlphaGenomes.json` byEnc index first, a
 * live `computeAlphaGenome()` WASM call second) -- this only errors when a position genuinely
 * fails to analyze, not because it's missing from the small offline dataset.
 *
 * A node earns a place in the tree only once something in the tree actually requires it (the
 * root always does, by construction); a node reached ONLY via a bypass arrow never gets its own
 * T-children expanded (per the user's own "bypass-only positions don't need their children shown"
 * rule) -- but if some OTHER branch later requires that exact same position, it still gets
 * expanded, since node identity is keyed on real encoding and "required by something" can be
 * discovered from either direction. This is why the build below is a worklist, not a single
 * top-down recursive pass: required-ness isn't always known the first time a node is reached.
 */

import { analyze } from '../engine/stalks';
import {
  type AlphaGenome,
  type FourGeneGenome,
  type NamedFamily,
  type PositionRef,
  type ResolveChild,
  NAMED_FAMILIES,
  classifyTChildren,
  computeAlphaGenome,
  isFullGenome,
  resolvedFoldName,
} from './collectAlpha';
import genomeDbJson from '../data/collectAlphaGenomes.json';

interface ByEncHit {
  R: number;
  D: number;
  L: number[];
  Tprime: number[];
  lives: number;
  T: (PositionRef & { nimber: number })[];
}
interface GenomeDbJson {
  genomes: Record<string, unknown>;
  byEnc: Record<string, ByEncHit>;
}
const BY_ENC = (genomeDbJson as unknown as GenomeDbJson).byEnc;

function byEncGenome(enc: string): AlphaGenome | undefined {
  const hit = BY_ENC[enc];
  return hit ? { R: hit.R, D: hit.D, L: hit.L, Tprime: hit.Tprime, T: hit.T } : undefined;
}

/** DisaPoint (tokens.hpp's DISA, encoding digit '3') and Split point (SPLIT, digit '5') are the
 * two "compressed pseudo-point" token kinds the encoding grammar represents as a single decimal
 * digit (encoding.hpp: "digits 0-9, both base and compression tokens" -- no multi-digit numbers
 * anywhere in this format), so a literal count of '3'/'5' characters across the whole encoding is
 * exactly a count of DisaPoints/Split points, with no risk of matching part of a larger number.
 * Used only for the T-Tree pane's Y-axis grouping -- verified against the default example and a
 * couple of known small positions in the browser during implementation, not hand-derived. */
export function adjustedLivesOf(enc: string, lives: number): number {
  let count = 0;
  for (const ch of enc) {
    if (ch === '3' || ch === '5') count++;
  }
  return lives - count;
}

/** Own, independent genome cache -- deliberately NOT collect.ts's `lookupGenome` (see this
 * module's own doc comment / the plan's "Sharing logic with collect.ts" section): that function's
 * fresh-fetch completion calls `scheduleRender()` on the COLLECT pane, which a T-Tree lookup must
 * never trigger. Persists across separate buildTTree() calls (cheap reuse, no correctness impact
 * -- a position's genome doesn't change between searches). */
const genomeCache = new Map<string, AlphaGenome | FourGeneGenome | null>();

async function resolveGenomeAsync(
  enc: string,
  embedded?: AlphaGenome | FourGeneGenome,
): Promise<AlphaGenome | FourGeneGenome | undefined> {
  if (embedded && isFullGenome(embedded)) return embedded;
  const direct = byEncGenome(enc);
  if (direct) return direct;
  const cached = genomeCache.get(enc);
  if (cached !== undefined) return cached ?? undefined;
  const fresh = await computeAlphaGenome(enc);
  const g = fresh?.genome;
  genomeCache.set(enc, g ?? null);
  return g;
}

/** How many T-generations deep a single `warmCache` call chases live fetches, relative to the
 * node it's warming (NOT relative to the whole tree -- each node in the worklist below gets its
 * own local warm-up, so an arbitrarily large/deep T-Tree is fine; only one node's own immediate
 * naming/classification needs are ever in flight at once). Matches the depth collect.ts's own
 * MAX_LOOKUP_FETCH_DEPTH uses for the same "don't let one lookup cascade into an unbounded chain
 * of fresh engine calls" reason. */
const MAX_WARM_DEPTH = 4;

/** Recursively resolves `enc`'s own genome AND warms the cache for its nested T-children up to
 * MAX_WARM_DEPTH, so that a subsequent SYNCHRONOUS `cacheResolveChild` call (see below) -- as used
 * by `resolvedFoldName`/`classifyTChildren`'s own recursive descent -- never has to fall back to
 * "still pending" for anything this call already touched. */
async function warmCache(
  enc: string,
  embedded: AlphaGenome | FourGeneGenome | undefined,
  depth: number,
): Promise<AlphaGenome | FourGeneGenome | undefined> {
  const g = await resolveGenomeAsync(enc, embedded);
  if (g && isFullGenome(g) && depth < MAX_WARM_DEPTH) {
    await Promise.all(g.T.map(t => warmCache(t.enc, t.genome, depth + 1)));
  }
  return g;
}

/** Synchronous, cache-only `ResolveChild` for collectAlpha.ts's shared functions -- safe to use
 * only after the relevant subtree has been `warmCache`d (see above); never triggers a fetch of its
 * own. */
const cacheResolveChild: ResolveChild = (enc, embedded) => {
  if (embedded && isFullGenome(embedded)) return embedded;
  const direct = byEncGenome(enc);
  if (direct) return direct;
  return genomeCache.get(enc) ?? undefined;
};

async function livesOf(enc: string): Promise<number> {
  const hit = BY_ENC[enc];
  if (hit) return hit.lives;
  const res = await analyze(enc);
  return res.ok ? res.lives ?? 0 : 0;
}

export type TTreeEdgeKind = 'required' | 'bypass' | 'extra';

export interface TTreeNode {
  /** Real structural encoding -- the dedup key for the whole graph (see the module doc comment). */
  id: string;
  genome: AlphaGenome;
  /** This node's own resolved family name, or null if its genome doesn't fold to one -- a node
   * that's `requiredByAny` should always have a name in well-formed (already-registered) input;
   * null here past that point just means its own T-children can't be classified, so they aren't
   * shown (matches the "position isn't in there" error for the ROOT, but degrades gracefully for
   * a deeper node instead of failing the whole build). */
  name: string | null;
  requiredByAny: boolean;
  lives: number;
  adjustedLives: number;
}

export interface TTreeEdge {
  from: string;
  to: string;
  kind: TTreeEdgeKind;
  /** For a bypass edge only: the id of the intermediate (bypassed) T-child the arrow visually
   * travels through on its way to `to`. */
  via?: string;
}

export interface TTreeGraph {
  rootId: string;
  nodes: Map<string, TTreeNode>;
  edges: TTreeEdge[];
}

export type TTreeResult = { ok: true; graph: TTreeGraph } | { ok: false; error: string };

/** Builds the full T-Tree rooted at `rootEncRaw` (worklist/BFS -- see the module doc comment for
 * why a single top-down pass isn't enough). */
export async function buildTTree(rootEncRaw: string): Promise<TTreeResult> {
  const typed = rootEncRaw.trim();
  if (!typed) return { ok: false, error: 'Enter a position encoding.' };

  // Normalize to the engine's own bracketless canonical form before using it as this node's
  // identity: a typed query may be wrapped in brackets (Collect's search bar accepts that), but
  // every OTHER encoding in the tree (T-children, byEnc keys) is always bracket-free, so using the
  // raw typed text as-is here would both double-bracket the root's own display label and break
  // dedup if some descendant ever looped back to it.
  const rootAnalysis = await analyze(typed);
  if (!rootAnalysis.ok) {
    return {
      ok: false,
      error: `Couldn't analyze "${rootEncRaw}" -- check it parses and contains exactly one α (not a membrane, and not more than one).`,
    };
  }
  const rootEnc = rootAnalysis.canon;

  const nodes = new Map<string, TTreeNode>();
  const edges: TTreeEdge[] = [];

  async function ensureNode(enc: string, embedded?: AlphaGenome | FourGeneGenome): Promise<TTreeNode | null> {
    const existing = nodes.get(enc);
    if (existing) return existing;
    const genome = await warmCache(enc, embedded, 0);
    if (!genome || !isFullGenome(genome)) return null;
    const lives = await livesOf(enc);
    const name = resolvedFoldName(genome, cacheResolveChild);
    const node: TTreeNode = {
      id: enc,
      genome,
      name,
      requiredByAny: false,
      lives,
      adjustedLives: adjustedLivesOf(enc, lives),
    };
    nodes.set(enc, node);
    return node;
  }

  const root = await ensureNode(rootEnc);
  if (!root) {
    return {
      ok: false,
      error:
        `Couldn't analyze "${rootEncRaw}" -- check it parses and contains exactly one α ` +
        '(not a membrane, and not more than one).',
    };
  }
  if (root.name === null) {
    return {
      ok: false,
      error: `"${rootEncRaw}" doesn't resolve to a known named family, so its required T-genes can't be determined.`,
    };
  }
  root.requiredByAny = true;

  const queue: string[] = [rootEnc];
  const expanded = new Set<string>();
  // `g.T` (the raw movetype-5 child list) isn't deduped by encoding -- collect.ts's own T-gene
  // table shows one row per real move on purpose, since two different raw moves CAN reach the
  // identical resulting position (see collectAlpha.ts's MoveChildRef doc comment). For the tree
  // DIAGRAM that just means the exact same visual arrow would otherwise get drawn once per such
  // move, which reads as clutter rather than information -- so edges are deduped by their own
  // (from, to, kind, via) identity before being added.
  const edgeKeys = new Set<string>();
  function addEdge(edge: TTreeEdge): void {
    const key = `${edge.from} ${edge.to} ${edge.kind} ${edge.via ?? ''}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  }

  while (queue.length > 0) {
    const enc = queue.shift() as string;
    if (expanded.has(enc)) continue;
    expanded.add(enc);
    const node = nodes.get(enc);
    if (!node || node.name === null) continue;

    const family: NamedFamily | undefined = NAMED_FAMILIES.find(f => f.name === node.name);
    const rows = classifyTChildren(node.genome.T, family, node.name, cacheResolveChild);

    for (const row of rows) {
      const isRequired = !!family && typeof row.resolvedName === 'string' && family.tChildPlains.includes(row.resolvedName);
      if (isRequired) {
        const childNode = await ensureNode(row.t.enc, row.tGenome ?? row.t.genome);
        if (!childNode) continue;
        addEdge({ from: enc, to: childNode.id, kind: 'required' });
        markRequired(childNode, queue);
        continue;
      }

      const match = row.matches && row.matches.length > 0 ? row.matches[0] : null;
      if (match) {
        const bypassedNode = await ensureNode(row.t.enc, row.tGenome ?? row.t.genome);
        // Prefer a witness that's already a node in the tree, to minimize total node count (the
        // user's own "clever" request) -- a greedy, order-dependent heuristic, not a globally
        // optimal one.
        const target = match.witnesses.find(w => nodes.has(w.enc)) ?? match.witness;
        const grandNode = await ensureNode(target.enc, target.genome);
        if (!bypassedNode || !grandNode) continue;
        addEdge({ from: enc, to: grandNode.id, kind: 'bypass', via: bypassedNode.id });
        markRequired(grandNode, queue);
        continue;
      }

      // Unexplained "extra" T-child (row.isExtra, or still pending after warmCache -- treated the
      // same way: draw it, flagged, per the user's own call rather than failing the whole build).
      const extraNode = await ensureNode(row.t.enc, row.tGenome ?? row.t.genome);
      if (!extraNode) continue;
      addEdge({ from: enc, to: extraNode.id, kind: 'extra' });
      markRequired(extraNode, queue);
    }
  }

  return { ok: true, graph: { rootId: rootEnc, nodes, edges } };
}

function markRequired(node: TTreeNode, queue: string[]): void {
  if (node.requiredByAny) return;
  node.requiredByAny = true;
  queue.push(node.id);
}

/** A node's row (0 = top, i.e. highest adjustedLives) and column (0-based, left to right within
 * that row) -- integer grid positions only; the SVG renderer and the TikZ exporter each convert
 * these to their own pixel/LaTeX-unit coordinates from the SAME grid, which is what keeps the two
 * relationally consistent without needing to be pixel-identical (per the user's own "doesn't have
 * to be an exact match, just relative to each other" request). */
export interface TTreeLayoutPos {
  row: number;
  col: number;
}

export interface TTreeLayout {
  /** Row 0 first (highest adjustedLives); only adjustedLives values actually present in the graph
   * get a row -- an unoccupied level in between is simply skipped, per the user's own "arrows may
   * traverse more than one level" allowance. */
  rowLevels: number[];
  positions: Map<string, TTreeLayoutPos>;
}

/** Buckets nodes into rows by descending adjustedLives, then runs a small fixed number of
 * barycenter-ordering passes (the standard Sugiyama-framework crossing-reduction heuristic) to
 * choose each row's left-to-right column order -- alternating downward and upward sweeps so a
 * node's position accounts for both its parents' and its children's current columns. This is a
 * heuristic, not a globally-optimal crossing minimizer (the user was explicit that's fine: "if
 * there's no easy route, I'm fine if we skip this -- I can hand-adjust the graph myself"). */
export function layoutTTree(graph: TTreeGraph): TTreeLayout {
  const levelSet = new Set<number>();
  for (const node of graph.nodes.values()) levelSet.add(node.adjustedLives);
  const rowLevels = [...levelSet].sort((a, b) => b - a);
  const rowOf = new Map<number, number>();
  rowLevels.forEach((level, i) => rowOf.set(level, i));

  const rows: string[][] = rowLevels.map(() => []);
  for (const node of graph.nodes.values()) {
    rows[rowOf.get(node.adjustedLives) as number].push(node.id);
  }

  const col = new Map<string, number>();
  for (const row of rows) row.forEach((id, i) => col.set(id, i));

  // Every edge, as an undirected adjacency (a node's barycenter should account for neighbors in
  // BOTH directions -- the required/bypass parent above it and any children below it -- not just
  // the direction the current sweep happens to be moving through).
  const neighbors = new Map<string, string[]>();
  const addEdge = (a: string, b: string) => {
    (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
    (neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
  };
  for (const e of graph.edges) {
    addEdge(e.from, e.to);
    if (e.via) addEdge(e.from, e.via);
  }

  const PASSES = 4;
  for (let pass = 0; pass < PASSES; pass++) {
    const rowOrder = pass % 2 === 0 ? rows.map((_, i) => i) : rows.map((_, i) => i).reverse();
    for (const r of rowOrder) {
      const row = rows[r];
      const barycenter = new Map<string, number>();
      for (const id of row) {
        const ns = neighbors.get(id) ?? [];
        const cols = ns.map(n => col.get(n)).filter((c): c is number => c !== undefined);
        barycenter.set(id, cols.length > 0 ? cols.reduce((a, b) => a + b, 0) / cols.length : (col.get(id) as number));
      }
      row.sort((a, b) => (barycenter.get(a) as number) - (barycenter.get(b) as number));
      row.forEach((id, i) => col.set(id, i));
    }
  }

  const positions = new Map<string, TTreeLayoutPos>();
  rows.forEach((row, r) => row.forEach((id, c) => positions.set(id, { row: r, col: c })));
  return { rowLevels, positions };
}

/** Emits TikZ matching the user's own example conventions -- `edge`/`layersep` tikzset, `\node`
 * per position, `\draw[edge]` for required arrows, a curved `to[bend]` for bypass arrows (visually
 * passing near the bypassed node it skips), and a distinct dashed style for unexplained "extra"
 * edges. Coordinates come straight from `layout`'s row/col grid (same one the SVG view uses), so
 * the two stay relationally consistent -- not necessarily pixel-identical, per the user's own
 * request. */
/** One label line (a position encoding or a genome name) into LaTeX math-mode text: α/⊕ as their
 * proper control sequences (never the raw Unicode glyphs -- fine on screen, not guaranteed to be
 * in every LaTeX font encoding), and a genome name's "_12"-style subscript braced ("_{12}") so a
 * two-digit family number subscripts as a whole instead of LaTeX's default "subscript just the
 * next single character" behavior silently only sinking the "1" in "S_12". */
function toLatexMath(text: string): string {
  return text
    .replace(/_(\d+)/g, '_{$1}')
    .replace(/⊕/g, '\\oplus ')
    .replace(/α/g, '\\alpha ');
}

export function buildTikz(graph: TTreeGraph, layout: TTreeLayout, labelOf: (node: TTreeNode) => string[]): string {
  // Wider than the SVG pane's own column spacing -- LaTeX text sets noticeably wider than the
  // pane's compact boxes (especially the root's own long encoding), so the same unit reads as
  // cramped once it's actually typeset; the pane and the export only need to agree on RELATIVE
  // node position, not on the literal unit size (per the user's own "doesn't have to be an exact
  // match" request).
  const COL_UNIT = 3.0;
  const ROW_UNIT = 2.4;

  const nodeIdOf = (enc: string): string => `n${[...enc].map(c => c.charCodeAt(0).toString(36)).join('')}`;
  const xOf = (col: number): number => col * COL_UNIT;
  const yOf = (row: number): number => -row * ROW_UNIT;

  const lines: string[] = [];
  lines.push('\\begin{tikzpicture}');
  lines.push('  \\tikzset{');
  lines.push('    edge/.style = {->,> = latex},');
  lines.push('    bypass/.style = {->,> = latex,color=purple!70!black},');
  lines.push('    extra/.style = {->,> = latex,dashed,color=gray},');
  lines.push('  }');
  lines.push('');

  for (const [id, pos] of layout.positions) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    // Each line gets its OWN $...$ pair -- one big $...$ around a "line1 \\ line2" pair breaks,
    // since \\ isn't valid directly inside a single inline-math group.
    const label = labelOf(node)
      .map(line => `$${toLatexMath(line)}$`)
      .join(' \\\\ ');
    lines.push(`  \\node (${nodeIdOf(id)}) at (${xOf(pos.col).toFixed(2)}, ${yOf(pos.row).toFixed(2)}) {${label}};`);
  }
  lines.push('');

  for (const e of graph.edges) {
    const style = e.kind === 'required' ? 'edge' : e.kind === 'bypass' ? 'bypass' : 'extra';
    if (e.kind === 'bypass' && e.via) {
      // Route the curve's own control point through the bypassed child's actual position (not a
      // fixed generic bend angle) -- otherwise two bypasses from the same node into the same
      // target, through two DIFFERENT bypassed children, would draw as identical-looking curves.
      const viaPos = layout.positions.get(e.via);
      if (viaPos) {
        const cx = xOf(viaPos.col) + 0.35;
        const cy = yOf(viaPos.row);
        lines.push(`  \\draw[${style}] (${nodeIdOf(e.from)}) .. controls (${cx.toFixed(2)}, ${cy.toFixed(2)}) .. (${nodeIdOf(e.to)});`);
        continue;
      }
    }
    lines.push(`  \\draw[${style}] (${nodeIdOf(e.from)}) to (${nodeIdOf(e.to)});`);
  }

  lines.push('\\end{tikzpicture}');
  return lines.join('\n');
}
