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
 * Not a discovery tool, but -- unlike Collect's own `lookupGenome` -- every genome here is
 * resolved LIVE (`computeAlphaGenome()`, a WASM call), never from the offline
 * `collectAlphaGenomes.json` snapshot: that file is built from a fixed, necessarily incomplete
 * `.spec` corpus (`stalks/tools/collect_alpha_genetics.cpp` only counts a move's child as a
 * T-child when that child ALSO happens to be a pre-solved node in the same corpus -- a real move
 * to a position the corpus never independently reached is silently dropped, no error). A position
 * that's IN the snapshot but has a silently truncated T-list is indistinguishable from a genuinely
 * complete one to a caller that trusts it, which is exactly what broke `[0,1,5,2a/`'s bypass
 * verification (root-caused 2026-09-17): its T-child `0,1,2,2a` displayed 11 T-children from the
 * snapshot instead of the true 14, and the missing 14th (`0,1,2a`) was the one that would have
 * proven the bypass back to S_1. Only this module's own in-session `genomeCache` (below) is
 * reused across calls -- correct because it's populated exclusively from live results, never from
 * the snapshot. A single T-Tree only ever touches the handful of positions actually in it, so
 * resolving everything live costs about a second even cold (confirmed: warming ~1100 positions to
 * depth 6 for this exact bug's repro), nowhere near enough to justify trusting unverifiable
 * offline data instead. Collect's OWN pane still uses the snapshot for its general "search any
 * position" flow -- that usage was never the correctness problem here and is unchanged.
 *
 * A node earns a place in the tree only once something in the tree actually requires it (the
 * root always does, by construction); a node reached ONLY via a bypass arrow never gets its own
 * T-children expanded (per the user's own "bypass-only positions don't need their children shown"
 * rule) -- but if some OTHER branch later requires that exact same position, it still gets
 * expanded, since node identity is keyed on real encoding and "required by something" can be
 * discovered from either direction. This is why the build below is a worklist, not a single
 * top-down recursive pass: required-ness isn't always known the first time a node is reached.
 */

import { analyze, canon, canonFull } from '../engine/stalks';
import {
  type AlphaGenome,
  type FourGeneGenome,
  type NamedFamily,
  type ResolveChild,
  NAMED_FAMILIES,
  classifyTChildren,
  computeAlphaGenome,
  familyRequiresTChildPlain,
  isFullGenome,
  resolvedFoldName,
} from './collectAlpha';
import genomeDbJson from '../data/collectAlphaGenomes.json';
import tokenLifeJson from '../data/token_life.generated.json';

// Deliberately just `lives` -- the ONLY field of the snapshot's byEnc entries this module reads
// (see livesOf). That field is a pure function of a position's own structure, with no dependency
// on the corpus's move-discovery completeness (unlike a hit's other fields -- R/D/L/Tprime/T --
// see this file's own doc comment), so it carries none of the staleness risk that made genome data
// unsafe to trust from here. Typing only what's read keeps that "never trust genome fields from
// this snapshot" invariant visible in the type itself, not just in this comment.
interface ByEncHit {
  lives: number;
}
interface GenomeDbJson {
  genomes: Record<string, unknown>;
  byEnc: Record<string, ByEncHit>;
}
const BY_ENC = (genomeDbJson as unknown as GenomeDbJson).byEnc;

/** Per-token life value: generated from tokens.hpp's leftSideLives2() (halved -- see that
 * function's own doc comment: "used exclusively for left-side life counts", exactly this feature's
 * scope, and it differs from the engine's general-purpose lives2() only for DisaPoint (1 life
 * instead of 2) and Split point (2 lives instead of 3)) by stalks/tools/dump_token_life.cpp --
 * single source of truth, re-run that tool and commit the output if leftSideLives2() ever changes.
 * A joint's two visit characters ('7' then '8') split 1 life as 0.5 apiece rather than the engine's
 * own 1-then-0 split; since they always appear in a matched pair, the AGGREGATE contribution per
 * joint is identical either way -- this is just a friendlier per-character accounting for the same
 * total. A membrane letter is likewise 0.5 (it always appears in a matched pair too, one occurrence
 * per side). Special-point letters ('a'-'j', the open-crit marker this whole feature is scoped to)
 * and delimiters (',', '|') contribute 0 (absent from the generated table). */
const TOKEN_LIFE: Record<string, number> = tokenLifeJson;

/** Y-axis grouping for the T-Tree pane: the sum of `fullEnc`'s own token life-values (see
 * TOKEN_LIFE), minus 1 for each subposition beyond the first -- '+' (encoding.cpp's serialize())
 * is exactly the separator between components/subpositions, so a literal '+' count is
 * (subposition count - 1). `fullEnc` must be the FULLY compressed form (DisaPoints included, i.e.
 * canonFull's output) -- the structural id itself deliberately leaves DisaPoints decompressed
 * (see canonFullSync's doc comment), so summing token values over the structural id would silently
 * never see a '3' at all. Verified against the default example and a couple of known small
 * positions in the browser during implementation, not hand-derived. */
export function adjustedLivesOf(fullEnc: string): number {
  let total = 0;
  let subpositions = 1;
  for (const ch of fullEnc) {
    if (ch === '7' || ch === '8' || (ch >= 'A' && ch <= 'Z')) total += 0.5;
    else if (ch === '+') subpositions++;
    else total += TOKEN_LIFE[ch] ?? 0;
  }
  return total - (subpositions - 1);
}

/** Resolves `enc` to its fully-compressed form (see adjustedLivesOf) and sums its token lives.
 * Falls back to treating `enc` itself as already-compressed if the engine call fails for any
 * reason (better an approximate row than a thrown error). */
async function adjustedLivesOfEnc(enc: string): Promise<number> {
  const full = await canonFull(enc);
  return adjustedLivesOf(full || enc);
}

/** Own, independent genome cache -- deliberately NOT collect.ts's `lookupGenome` (see this
 * module's own doc comment / the plan's "Sharing logic with collect.ts" section): that function's
 * fresh-fetch completion calls `scheduleRender()` on the COLLECT pane, which a T-Tree lookup must
 * never trigger. Persists across separate buildTTree() calls (cheap reuse, no correctness impact
 * -- a position's genome doesn't change between searches). */
const genomeCache = new Map<string, AlphaGenome | FourGeneGenome | null>();

/** Encodings whose own T-descendant subtree `warmCache` has already recursed into (or is
 * currently recursing into) -- checked/set BEFORE that recursion starts (not after it finishes),
 * so a second call reaching the same enc while the first is still in flight also short-circuits.
 * Without this, a shared descendant reached via more than one path gets its entire subtree
 * re-walked once per path even though every leaf underneath is already in `genomeCache` -- pure
 * repeated Promise/microtask fan-out for corpora where cousins/siblings routinely converge on the
 * same descendant. As a side effect this also gives the recursion a hard backstop against ever
 * looping forever if the "a real T-move strictly reduces complexity" invariant `warmCache`'s own
 * doc comment relies on for termination were ever violated by an engine edge case -- a position
 * that somehow reappeared among its own descendants would find itself already marked and stop,
 * rather than recursing without end. Persists across buildTTree() calls like `genomeCache` itself. */
const warmedSubtree = new Set<string>();

async function resolveGenomeAsync(
  enc: string,
  embedded?: AlphaGenome | FourGeneGenome,
): Promise<AlphaGenome | FourGeneGenome | undefined> {
  if (embedded && isFullGenome(embedded)) return embedded;
  const cached = genomeCache.get(enc);
  if (cached !== undefined) return cached ?? undefined;
  const fresh = await computeAlphaGenome(enc);
  const g = fresh?.genome;
  genomeCache.set(enc, g ?? null);
  return g;
}

/** Recursively resolves `enc`'s own genome AND warms the cache for every nested T-descendant, so
 * that a subsequent SYNCHRONOUS `cacheResolveChild` call (see below) -- as used by
 * `resolvedFoldName`/`classifyTChildren`'s own recursive descent -- never has to fall back to
 * "still pending" for anything reachable from this call.
 *
 * No depth cap (a bounded MAX_WARM_DEPTH -- an EARLIER version of this function used one -- is
 * unsound here, not just conservative): `genomeCache` dedups by encoding, so a shared descendant
 * only ever gets warmed via whichever path reaches it FIRST, and a fixed cap counts hops from the
 * OUTER root, not from wherever that position actually got first visited -- a position reached
 * shallowly gets its own children explored several hops further than the identical position
 * reached deeper down, purely depending on `Promise.all` scheduling order, not on the tree's real
 * shape. Root-caused 2026-09-18: this silently starved the bypass check for `[0,1,5,2a/` (needed
 * a grandchild several hops past where the old cap=4 had already run out for that specific
 * traversal order) even though the exact same query resolved fine through a plain, uncapped
 * depth-first warm in isolation -- i.e. the SAME data, just reachable at a depth the cap forbade
 * exploring past. Termination doesn't need a cap: a real T-move strictly reduces a position's own
 * complexity (fewer lives), so no position can ever be its own descendant, and this recursion
 * bottoms out naturally once a branch reaches positions with no more T-children -- exactly the
 * same recursion `resolvedFoldName`/`classifyTChildren` themselves do once the data exists, so
 * this can never need to touch more than they would anyway. See `warmedSubtree` above for how
 * repeated visits to the same shared descendant are kept cheap despite the missing depth cap. */
async function warmCache(
  enc: string,
  embedded: AlphaGenome | FourGeneGenome | undefined,
): Promise<AlphaGenome | FourGeneGenome | undefined> {
  const alreadyWarming = warmedSubtree.has(enc);
  if (!alreadyWarming) warmedSubtree.add(enc);
  const g = await resolveGenomeAsync(enc, embedded);
  if (!alreadyWarming && g && isFullGenome(g)) {
    await Promise.all(g.T.map(t => warmCache(t.enc, t.genome)));
  }
  return g;
}

/** Synchronous, cache-only `ResolveChild` for collectAlpha.ts's shared functions -- safe to use
 * only after the relevant subtree has been `warmCache`d (see above); never triggers a fetch of its
 * own. */
const cacheResolveChild: ResolveChild = (enc, embedded) => {
  if (embedded && isFullGenome(embedded)) return embedded;
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
  // A left side is properly denoted with a trailing '/' rather than ']' (stalks/src/collections.hpp's
  // own convention -- see bracketDisplaySlash/leftSideDisplay), but the engine's own parser only
  // strips '[' and ']' as no-op grouping characters (see encoding.cpp's cleaned()) and has no idea
  // '/' means the same thing; accept either form here rather than making the user swap punctuation
  // to paste a "proper" left side back in. Every '/' is unambiguously that closing marker (it never
  // appears anywhere else in an encoding), so a blanket replace is exact, not a heuristic.
  const typed = rootEncRaw.trim().replace(/\//g, ']');
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

  // A T-child's raw enc (collectAlpha.ts's movetype-5 candidate list) is a plain string-join of
  // its alpha-bearing and away components in whatever order that candidate happened to build them
  // in ('+' is a commutative disjoint-sum separator, so e.g. "12+2a" and "2a+12" denote the exact
  // same real position) -- never itself re-canonicalized. Two different candidates reaching the
  // identical real position but joined in a different component order would otherwise dedup as two
  // separate nodes. Canonicalizing here (once, before the dedup check) is what actually gives every
  // node its "real structural encoding" identity the module doc comment already promises; this is a
  // TS-side fix, not a Stalks one -- canon() itself already normalizes component order correctly
  // (see canon.cpp's own subposition sort), this call was just missing.
  async function ensureNode(encRaw: string, embedded?: AlphaGenome | FourGeneGenome): Promise<TTreeNode | null> {
    const enc = (await canon(encRaw)) || encRaw;
    const existing = nodes.get(enc);
    if (existing) return existing;
    const genome = await warmCache(enc, embedded);
    if (!genome || !isFullGenome(genome)) return null;
    const lives = await livesOf(enc);
    const adjustedLives = await adjustedLivesOfEnc(enc);
    const name = resolvedFoldName(genome, cacheResolveChild);
    const node: TTreeNode = {
      id: enc,
      genome,
      name,
      requiredByAny: false,
      lives,
      adjustedLives,
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
    const key = `${edge.from} ${edge.to} ${edge.kind} ${edge.via ?? ''}`;
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
      if (familyRequiresTChildPlain(family, row.resolvedName)) {
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

/** A node's row (0 = top) and column (0-based, left to right within that row) -- integer grid
 * positions only; the SVG renderer and the TikZ exporter each convert these to their own
 * pixel/LaTeX-unit coordinates from the SAME grid, which is what keeps the two relationally
 * consistent without needing to be pixel-identical (per the user's own "doesn't have to be an
 * exact match, just relative to each other" request). */
export interface TTreeLayoutPos {
  row: number;
  col: number;
}

export interface TTreeLayout {
  /** Row 0 first; only levels actually present (post row-monotonicity fixup, see layoutTTree) get
   * a row -- an unoccupied level in between is simply skipped, per the user's own "arrows may
   * traverse more than one level" allowance. */
  rowLevels: number[];
  positions: Map<string, TTreeLayoutPos>;
}

/** adjustedLives is a "how many lives-equivalent remain" reading, not a move-depth counter -- it's
 * NOT guaranteed to strictly decrease along a real edge, since DisaPoint/Split compression can
 * introduce a pseudo-point the parent didn't have even though raw `lives` always strictly drops
 * (every real move strictly reduces raw lives). Left as pure adjustedLives buckets, an edge could
 * end up pointing sideways or even upward in the rendered tree -- which is exactly what the user
 * reported seeing as a curve that heads up before turning back down. This walks nodes in
 * descending raw `lives` order (a valid topological order, since lives(parent) > lives(child) is
 * always true) and bumps a node's level to strictly below every node that must sit above it --
 * its `from` for a required/extra edge, and BOTH `from` and `via` for a bypass (there's no
 * separate edge object for the implied from->via link) -- so every real edge in the final layout
 * points strictly downward, while nodes that don't need bumping keep their natural adjustedLives
 * grouping. */
function computeLevels(graph: TTreeGraph): Map<string, number> {
  const mustBeBelow = new Map<string, string[]>();
  const addBelow = (below: string, above: string) => {
    (mustBeBelow.get(below) ?? mustBeBelow.set(below, []).get(below)!).push(above);
  };
  for (const e of graph.edges) {
    if (e.kind === 'bypass' && e.via) {
      addBelow(e.via, e.from);
      addBelow(e.to, e.via);
    } else {
      addBelow(e.to, e.from);
    }
  }

  const order = [...graph.nodes.values()].sort((a, b) => b.lives - a.lives);
  const level = new Map<string, number>();
  for (const node of order) {
    let lvl = -node.adjustedLives;
    for (const above of mustBeBelow.get(node.id) ?? []) {
      const aboveLevel = level.get(above);
      if (aboveLevel !== undefined) lvl = Math.max(lvl, aboveLevel + 1);
    }
    level.set(node.id, lvl);
  }
  return level;
}

/** Buckets nodes into rows by ascending (row-monotonicity-corrected, see computeLevels) level,
 * then runs a small fixed number of barycenter-ordering passes (the standard Sugiyama-framework
 * crossing-reduction heuristic) to choose each row's left-to-right column order -- alternating
 * downward and upward sweeps so a node's position accounts for both its parents' and its
 * children's current columns. This is a heuristic, not a globally-optimal crossing minimizer (the
 * user was explicit that's fine: "if there's no easy route, I'm fine if we skip this -- I can
 * hand-adjust the graph myself"). */
/** Every edge, as an undirected adjacency. A bypass's `via` node needs BOTH legs of its implied
 * path wired in (from->via AND via->to), not just from->to -- for layoutTTree's barycenter
 * ordering below, a node's neighbors must account for BOTH directions (the required/bypass parent
 * above it and any children below it), and missing the via->to leg once left a via node's column
 * order decided purely by its distance to `from`, blind to where its own `to` (usually several
 * rows further down, and often the only OTHER thing tying it anywhere) actually sits; with many
 * via-siblings tied on that single shared `from` score, ties broke on arbitrary insertion order
 * instead, which is what let a via node land at a far column while both its real neighbors sat
 * close together elsewhere. Shared with ui/ttree.ts, which uses the identical adjacency for its
 * own (separate) pixel-position averaging pass. */
export function buildTTreeNeighbors(graph: TTreeGraph): Map<string, string[]> {
  const neighbors = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
    (neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
  };
  for (const e of graph.edges) {
    add(e.from, e.to);
    if (e.via) {
      add(e.from, e.via);
      add(e.via, e.to);
    }
  }
  return neighbors;
}

export function layoutTTree(graph: TTreeGraph): TTreeLayout {
  const level = computeLevels(graph);
  const levelSet = new Set<number>(level.values());
  const rowLevels = [...levelSet].sort((a, b) => a - b);
  const rowOf = new Map<number, number>();
  rowLevels.forEach((lvl, i) => rowOf.set(lvl, i));

  const rows: string[][] = rowLevels.map(() => []);
  for (const node of graph.nodes.values()) {
    rows[rowOf.get(level.get(node.id) as number) as number].push(node.id);
  }

  const col = new Map<string, number>();
  for (const row of rows) row.forEach((id, i) => col.set(id, i));

  const neighbors = buildTTreeNeighbors(graph);

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

/** One label line (a position encoding or a genome name) into LaTeX math-mode text: α/⊕ as their
 * proper control sequences (never the raw Unicode glyphs -- fine on screen, not guaranteed to be
 * in every LaTeX font encoding), and a genome name's "_12"-style subscript braced ("_{12}") so a
 * two-digit family number subscripts as a whole instead of LaTeX's default "subscript just the
 * next single character" behavior silently only sinking the "1" in "S_12". Exported so the TikZ
 * exporter in ui/ttree.ts (which needs the same pixel-accurate layout the SVG pane itself computes,
 * so it lives alongside that layout code rather than here) can reuse it verbatim. */
export function toLatexMath(text: string): string {
  return text
    .replace(/_(\d+)/g, '_{$1}')
    .replace(/⊕/g, '\\oplus ')
    .replace(/α/g, '\\alpha ');
}
