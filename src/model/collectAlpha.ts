/**
 * Model helpers for the alpha-based Collect feature: bucketing a position's children by the
 * engine's own movetype classification (moves.hpp::specialPointMovetypes, exposed via analyze()'s
 * MoveInfo.movetype -- see stalks.ts) into the (R,D,{L},{T'},[T]) genome tuple, per the user's
 * mapping: movetype 1 -> R, 2 -> D, 3 -> L, 4 -> T', 5 -> T.
 *
 * Restricted, for now, to positions containing EXACTLY ONE special-point token, and that token
 * must be alpha ('a') -- packMovetypes' base-6 digit position is fixed by symbol identity, so with
 * only alpha present the packed value IS the raw 1-5 movetype directly; a second symbol (beta, ...)
 * would need unpacking this doesn't do yet.
 *
 * This supersedes collectGenetics.ts's DisaPoint-based pipeline for the alpha case. That file
 * needed elaborate tracked-provenance machinery (relocateDisaPoint, traceTMove, classifyChildren-
 * ByDisaPoint, etc.) purely because the engine had no native way to classify a move relative to a
 * chosen point -- alpha is a literal, standard token (no compression/decompression, no "detached
 * pair" convention), and the engine now tags every child edge with its own movetype directly, so
 * classification is just bucketing analyze()'s ordinary children list: one WASM round-trip, no
 * provenance tracking, no relocation logic needed at all.
 */

import { analyze, quickCanonOf } from '../engine/stalks';

/** A position reference carrying both its real (exact structural) encoding -- the authoritative
 * identity, used for any further engine call (re-analysis, etc.) -- and its quick-canon (Advanced
 * Collections) display form. A quick-canon rep is only proven nimber-equivalent (up to
 * quickOffset) to the real position, not proven to have the same GENOME under movetype
 * classification, so `enc` must stay the one actually re-analyzed; quickEnc/quickOffset are
 * display-only, per the user's request to surface the more compact quick-canon form. */
export interface PositionRef {
  enc: string;
  quickEnc: string;
  quickOffset: number;
}

/** Maximum recursion depth for nested [T] genomes: 0 = the searched-for position itself, 1 = its
 * T witnesses' own (complete) genomes, 2 = the T witnesses of THOSE genomes -- truncated to just
 * the 4-value (R,D,{L},{T'}) tuple, no further [T] expansion, per the user's "third layer in, only
 * the first four genes" rule. */
const MAX_GENOME_DEPTH = 2;

/** Above this many lives, a position's own T witnesses don't get a nested genome computed at all
 * (they still appear in [T] as plain position/nimber/lives witnesses, just without `.genome`) --
 * a safety cap so a single search can't explode into an unbounded number of engine calls. */
const MAX_NESTED_GENOME_LIVES = 5;

/** The bare (R,D,{L},{T'}) tuple, with no [T] expansion -- what a depth-2 ("third layer") witness
 * gets instead of a full AlphaGenome.
 *
 * `oplus`: a T move can land on a SPLIT position (a sum of multiple components, only one of which
 * still contains alpha) -- movetype classification only makes sense applied to that one
 * alpha-bearing component, so the other component(s)' nimbers can't just be dropped; they're
 * nim-summed (XORed) together and folded into `oplus`, along with the quick-canon offset (this
 * genome is always computed from a position's QUICK-CANON representative, which is itself only
 * nimber-equivalent up to that offset -- see quickAlphaSplitOf). Displayed as "⊕oplus" after the
 * tuple when nonzero (see collect.ts's genomeParts); 0 means neither a split nor a nonzero offset
 * applies, and is not shown. */
export interface FourGeneGenome {
  R: number | null;
  D: number | null;
  L: number[];
  Tprime: number[];
  oplus: number;
}

/** A single movetype-5 ("T") child witness: the position it reaches, its nimber, its own lives
 * count (used to decide whether it's eligible for nested-genome expansion -- absent for witnesses
 * loaded from GENOME_DB, which predates the lives field and doesn't carry it, so those never get a
 * nested genome), and -- when depth and lives budget allow -- its own genome (complete at depth 1,
 * four-gene-only at depth 2). */
export interface TWitness extends PositionRef {
  nimber: number;
  lives?: number;
  genome?: AlphaGenome | FourGeneGenome;
}

export interface AlphaGenome extends FourGeneGenome {
  T: TWitness[];
}

/** True iff `enc` contains exactly one special-point character, and it's alpha specifically --
 * the scope this feature is restricted to for now (see module header). Special-point characters
 * are the lowercase letters 'a'-'j' (tokens.hpp::tokenChar); alpha is 'a'. */
export function isSingleAlpha(enc: string): boolean {
  let count = 0;
  let sawAlpha = false;
  for (const ch of enc) {
    if (ch >= 'a' && ch <= 'j') {
      count++;
      if (ch === 'a') sawAlpha = true;
    }
  }
  return count === 1 && sawAlpha;
}

function sortedDedup(vals: number[]): number[] {
  return [...new Set(vals)].sort((a, b) => a - b);
}

/** Resolve a real encoding's quick-canon display form. Falls back to the real encoding itself
 * (offset 0) if the quick-canon call fails for any reason -- better an uncompressed but correct
 * label than no label at all. */
async function quickRef(enc: string): Promise<PositionRef> {
  const qc = await quickCanonOf(enc);
  return qc.ok ? { enc, quickEnc: qc.enc, quickOffset: qc.offset } : { enc, quickEnc: enc, quickOffset: 0 };
}

/** A position's quick-canon representative, split into "the component still containing alpha"
 * (what movetype classification actually runs on) and everything else folded into a single nimber
 * (nim-summed together, since a move can split a position into 3+ parts at once -- see the module
 * header). Falls back to treating `enc` itself as its own (unsplit, offset-0) representative if the
 * quickCanonOf call fails outright, rather than losing the genome entirely over a display-only
 * lookup failure. */
async function quickAlphaSplitOf(enc: string): Promise<{ alphaEnc: string; offset: number; awayNimberXor: number }> {
  const qc = await quickCanonOf(enc);
  const repEnc = qc.ok ? qc.enc : enc;
  const offset = qc.ok ? qc.offset : 0;
  const parts = repEnc.split('+');
  const alphaEnc = parts.find(p => p.includes('a')) ?? repEnc;
  const awayParts = parts.filter(p => p !== alphaEnc && p !== 'N');
  let awayNimberXor = 0;
  for (const p of awayParts) {
    const r = await analyze(p);
    if (r.ok) awayNimberXor ^= r.nimber;
  }
  return { alphaEnc, offset, awayNimberXor };
}

/** Compute the genome of `enc`, classifying movetypes on its QUICK-CANON representative's
 * alpha-bearing component (see quickAlphaSplitOf) -- not the real structural encoding. Several
 * distinct T witnesses commonly reduce to the exact same quick-canon rep (see the module header's
 * "2AB|2a,AB" example), so computing genomes this way is what lets [T] dedup meaningfully instead
 * of listing near-identical structural variants separately; the tradeoff, per the user, is that the
 * rep can itself be a split position, handled via `oplus`.
 *
 * `depth` controls how far [T] nests -- see MAX_GENOME_DEPTH/MAX_NESTED_GENOME_LIVES: at
 * MAX_GENOME_DEPTH, the result is truncated to a bare FourGeneGenome (no witnesses computed at all,
 * since nothing would ever recurse past this depth anyway), so recursion always terminates. Null on
 * any engine failure or a position that doesn't contain exactly one alpha token. */
async function computeAlphaGenomeAt(
  enc: string,
  depth: number,
): Promise<{ position: PositionRef; genome: AlphaGenome | FourGeneGenome } | null> {
  const [position, split] = await Promise.all([quickRef(enc), quickAlphaSplitOf(enc)]);
  const oplus = split.offset ^ split.awayNimberXor;

  const res = await analyze(split.alphaEnc);
  if (!res.ok) return null;
  if (!isSingleAlpha(res.canon)) return null;

  let R: number | null = null;
  let D: number | null = null;
  const L: number[] = [];
  const Tprime: number[] = [];
  const tChildren: typeof res.children = [];
  for (const child of res.children) {
    const mt = child.move?.movetype;
    if (!mt) continue;
    switch (mt) {
      case 1: R = child.nimber; break;
      case 2: D = child.nimber; break;
      case 3: L.push(child.nimber); break;
      case 4: Tprime.push(child.nimber); break;
      case 5: tChildren.push(child); break;
      default: break;
    }
  }

  if (depth >= MAX_GENOME_DEPTH) {
    return { position, genome: { R, D, L: sortedDedup(L), Tprime: sortedDedup(Tprime), oplus } };
  }

  const T = await Promise.all(
    tChildren.map(async (child): Promise<TWitness> => {
      const witness: TWitness = { ...(await quickRef(child.enc)), nimber: child.nimber, lives: child.lives };
      if (child.lives <= MAX_NESTED_GENOME_LIVES) {
        const nested = await computeAlphaGenomeAt(child.enc, depth + 1);
        if (nested) witness.genome = nested.genome;
      }
      return witness;
    }),
  );

  return { position, genome: { R, D, L: sortedDedup(L), Tprime: sortedDedup(Tprime), oplus, T } };
}

/** Public entry point: compute the full (depth-0) genome of a position -- always an AlphaGenome
 * (complete, with its own [T]), since MAX_GENOME_DEPTH is never 0. See computeAlphaGenomeAt for the
 * depth-aware implementation shared with nested T witnesses. */
export async function computeAlphaGenome(enc: string): Promise<{ position: PositionRef; genome: AlphaGenome } | null> {
  const result = await computeAlphaGenomeAt(enc, 0);
  return result ? { position: result.position, genome: result.genome as AlphaGenome } : null;
}

/** Genome bucket key format: "(R,D,{l1,...},{t1,...})", L and T' each sorted ascending and
 * deduped -- byte-identical to stalks/tools/collect_alpha_genetics.cpp's genomeKey, which built
 * src/data/collectAlphaGenomes.json's keys. */
export function genomeKey(R: number, D: number, L: number[], Tprime: number[]): string {
  return `(${R},${D},{${sortedDedup(L).join(',')}},{${sortedDedup(Tprime).join(',')}})`;
}

// The trailing ",[...]" (the [T] portion) is optional and, when present, its contents are not
// parsed/validated -- [T] isn't part of the genome bucket key (genomeKey below), so both the old
// 4-value form "(R,D,{L},{T'})" and the new 5-value form "(R,D,{L},{T'},[...])" resolve to the
// exact same DB lookup. `.` (dotAll off) still matches newlines here because [\s\S] is used instead
// so a multi-line pasted [T] list doesn't break the match.
const GENOME_QUERY_RE =
  /^\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*\{([0-9,\s]*)\}\s*,\s*\{([0-9,\s]*)\}\s*(?:,\s*\[([\s\S]*)\]\s*)?\)$/;

/** Named shorthands for common genomes -- typing one of these keys in the search bar expands to
 * its full genome-query text before parsing (see collect.ts). S_1 = the single-scab position
 * (0,1,{0},{},[]); S_2 = (1,0,{1},{},[S_1]) -- literally containing S_1 as its one T witness.
 * Extend this table as more named genomes are identified; unrecognized S_n names fall through to
 * ordinary (probably-failing) genome/position parsing. */
export const GENOME_SHORTHANDS: Record<string, string> = {
  S_1: '(0,1,{0},{},[])',
  S_2: '(1,0,{1},{},[(0,1,{0},{},[])])',
};

/** Expand a search-bar shorthand name (e.g. "S_1") to its full genome-query text; returns the
 * input unchanged if it isn't a recognized shorthand. */
export function expandGenomeShorthand(input: string): string {
  return GENOME_SHORTHANDS[input.trim()] ?? input;
}

function parseNumSet(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const vals = trimmed.split(',').map(s => Number.parseInt(s.trim(), 10));
  return vals.some(n => Number.isNaN(n)) ? null : vals;
}

export interface ParsedGenomeQuery {
  key: string;
  R: number;
  D: number;
  L: number[];
  Tprime: number[];
}

/** Parse a typed genome query "(R,D,{L},{T'})" into its normalized key + parts, or null if it
 * doesn't match the expected shape. */
export function parseGenomeQuery(input: string): ParsedGenomeQuery | null {
  const m = GENOME_QUERY_RE.exec(input.trim());
  if (!m) return null;
  const R = Number.parseInt(m[1], 10);
  const D = Number.parseInt(m[2], 10);
  const L = parseNumSet(m[3]);
  const Tprime = parseNumSet(m[4]);
  if (L === null || Tprime === null) return null;
  const sortedL = sortedDedup(L);
  const sortedTprime = sortedDedup(Tprime);
  return { key: genomeKey(R, D, sortedL, sortedTprime), R, D, L: sortedL, Tprime: sortedTprime };
}
