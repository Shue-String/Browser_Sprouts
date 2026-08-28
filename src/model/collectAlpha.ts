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
import collectionsRosterJson from '../data/collectionsRoster.json';
import genomeDefsData from '../data/genomeDefs.json';

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
 * T-children' own (complete) genomes, 2 = the T-children of THOSE genomes -- truncated to just
 * the 4-value (R,D,{L},{T'}) tuple, no further [T] expansion, per the user's "third layer in, only
 * the first four genes" rule. */
const MAX_GENOME_DEPTH = 2;

/** Above this many lives, a position's own T-children don't get a nested genome computed at all
 * (they still appear in [T] as plain position/nimber/lives T-children, just without `.genome`) --
 * a safety cap so a single search can't explode into an unbounded number of engine calls. */
const MAX_NESTED_GENOME_LIVES = 5;

/** The bare (R,D,{L},{T'}) tuple, with no [T] expansion -- what a depth-2 ("third layer") T-child
 * gets instead of a full AlphaGenome.
 *
 * A T move can land on a SPLIT position (a sum of multiple components, only one of which still
 * contains alpha) -- movetype classification only makes sense applied to that one alpha-bearing
 * component, but the other component(s) are never just discarded: their nim-summed nimber (plus
 * the quick-canon offset, since this is always computed on the quick-canon rep) is XORed directly
 * into R/D/L/T', and each away component's OWN real moves are enumerated as additional T-children
 * (they never touch alpha, so by definition they're T moves too) -- see quickAlphaSplitOf/
 * computeAlphaGenomeAt. A component with nimber n necessarily has moves reaching every nimber
 * 0..n-1 (mex), so this naturally reproduces the whole X⊕0..X⊕(n-1) family of a base shape X as
 * real, engine-verified T-children, not a hand-derived pattern -- see NAMED_GENOME_DEFS's C_3⊕1/
 * C_3⊕2 entries. There is deliberately no separate "oplus" field any more: every correction is
 * folded straight into R/D/L/T'/T, so two genomes with the same tuple text are the same gene. */
/** One raw (undeduped) R/D/L/T' child: its real structural encoding (the quick-canon alpha-bearing
 * rep's own child, NOT further quick-canon-reduced) and nimber. Unlike the deduped `L`/`Tprime`
 * nimber sets above, two entries here can share a nimber but have different encodings (the engine
 * can reach the same value via more than one distinct move) -- kept purely for the paper-format
 * export table (see collect.ts's buildExportLatex), which lists every raw move, not just the
 * deduped value set. Optional because only a fresh computeAlphaGenomeAt call populates it --
 * GENOME_DB-loaded/byEncGenome-loaded genomes predate this field and don't carry it. */
export interface MoveChildRef {
  enc: string;
  nimber: number;
}

export interface FourGeneGenome {
  R: number | null;
  D: number | null;
  L: number[];
  Tprime: number[];
  Rc?: MoveChildRef;
  Dc?: MoveChildRef;
  Lc?: MoveChildRef[];
  TprimeC?: MoveChildRef[];
}

/** A single movetype-5 ("T") T-child: the position it reaches, its nimber, its own lives
 * count (used to decide whether it's eligible for nested-genome expansion -- absent for T-children
 * loaded from GENOME_DB, which predates the lives field and doesn't carry it, so those never get a
 * nested genome), and -- when depth and lives budget allow -- its own genome (complete at depth 1,
 * four-gene-only at depth 2). */
export interface TChild extends PositionRef {
  nimber: number;
  lives?: number;
  genome?: AlphaGenome | FourGeneGenome;
}

export interface AlphaGenome extends FourGeneGenome {
  T: TChild[];
}

/** Shift every uppercase membrane letter (A-Z, tokens.hpp's degree-2 shared-region symbol) forward
 * by 2, wrapping Y/Z back to A/B -- the paper's own left/right pairing-letter convention (starting
 * at C instead of A, to keep them visually distinct from the lowercase special-point tokens like
 * alpha/beta). Applied both to the LaTeX export (exportEncoding) and to the Collect pane's own
 * on-screen labels (collect.ts's quickLabel) so the two always agree. Never applied to `enc` itself
 * (the real, engine-native encoding used for re-analysis) -- only to display-only text. */
export function shiftMembraneLetters(enc: string): string {
  return enc.replace(/[A-Z]/g, ch => String.fromCharCode(((ch.charCodeAt(0) - 65 + 2) % 26) + 65));
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
 * (what movetype classification runs on) and every other ("away") component -- kept as their own
 * real encodings, not collapsed to a single nimber, so their OWN moves can be enumerated as
 * genuine T-children by computeAlphaGenomeAt (a move purely within an away component never
 * touches alpha, so it's a T move by definition). Falls back to treating `enc` itself as its own
 * (unsplit, offset-0) representative if the quickCanonOf call fails outright, rather than losing
 * the genome entirely over a display-only lookup failure. */
async function quickAlphaSplitOf(enc: string): Promise<{ alphaEnc: string; awayEncs: string[]; offset: number }> {
  const qc = await quickCanonOf(enc);
  const repEnc = qc.ok ? qc.enc : enc;
  const offset = qc.ok ? qc.offset : 0;
  const parts = repEnc.split('+');
  const alphaEnc = parts.find(p => p.includes('a')) ?? repEnc;
  const awayEncs = parts.filter(p => p !== alphaEnc && p !== 'N');
  return { alphaEnc, awayEncs, offset };
}

/** Compute the genome of `enc`, classifying movetypes on its QUICK-CANON representative's
 * alpha-bearing component (see quickAlphaSplitOf) -- not the real structural encoding. Several
 * distinct T-children commonly reduce to the exact same quick-canon rep (see the module header's
 * "2AB|2a,AB" example), so computing genomes this way is what lets [T] dedup meaningfully instead
 * of listing near-identical structural variants separately.
 *
 * When the rep is a split (a sum of components, only one bearing alpha), the away component(s)'
 * nim-summed nimber and the quick-canon offset are XORed directly into R/D/L/T' (a real component
 * of nimber n forces moves to every nimber 0..n-1 by mex, so this is what actually happens to the
 * position's values when it's played as a disjoint sum -- not a display-only correction), and each
 * away component's own moves are enumerated as additional T-children (see quickAlphaSplitOf's own
 * doc comment) -- this is what lets shapes like C_3⊕1/C_3⊕2 arise as real, named T-children instead
 * of only ever showing up as an approximate "⊕N" suffix on the alpha component's own tuple.
 *
 * `depth` controls how far [T] nests -- see MAX_GENOME_DEPTH/MAX_NESTED_GENOME_LIVES: at
 * MAX_GENOME_DEPTH, the result is truncated to a bare FourGeneGenome (no T-children computed at all,
 * since nothing would ever recurse past this depth anyway), so recursion always terminates. Null on
 * any engine failure or a position that doesn't contain exactly one alpha token. */
async function computeAlphaGenomeAt(
  enc: string,
  depth: number,
): Promise<{ position: PositionRef; genome: AlphaGenome | FourGeneGenome } | null> {
  const [position, split] = await Promise.all([quickRef(enc), quickAlphaSplitOf(enc)]);
  const awayResults = await Promise.all(split.awayEncs.map(e => analyze(e)));
  let awayNimberXor = 0;
  let awayLivesSum = 0;
  for (const r of awayResults) {
    if (r.ok) { awayNimberXor ^= r.nimber; awayLivesSum += r.lives ?? 0; }
  }
  const oplus = split.offset ^ awayNimberXor;
  const awayPrefix = split.awayEncs.length ? split.awayEncs.join('+') + '+' : '';

  const res = await analyze(split.alphaEnc);
  if (!res.ok) return null;
  if (!isSingleAlpha(res.canon)) return null;

  let R: number | null = null;
  let D: number | null = null;
  let Rc: MoveChildRef | undefined;
  let Dc: MoveChildRef | undefined;
  const L: number[] = [];
  const Tprime: number[] = [];
  const Lc: MoveChildRef[] = [];
  const TprimeC: MoveChildRef[] = [];
  // Every T-move candidate reachable from the full split position: one per real move of the
  // alpha component (away part(s) carried through unchanged) plus one per real move of each away
  // component (alpha part carried through unchanged) -- see this function's own doc comment.
  const candidates: { enc: string; nimber: number; lives: number }[] = [];
  for (const child of res.children) {
    const mt = child.move?.movetype;
    if (!mt) continue;
    const shifted = child.nimber ^ oplus;
    switch (mt) {
      case 1: R = shifted; Rc = { enc: child.enc, nimber: child.nimber }; break;
      case 2: D = shifted; Dc = { enc: child.enc, nimber: child.nimber }; break;
      case 3: L.push(shifted); Lc.push({ enc: child.enc, nimber: child.nimber }); break;
      case 4: Tprime.push(shifted); TprimeC.push({ enc: child.enc, nimber: child.nimber }); break;
      case 5: candidates.push({ enc: awayPrefix + child.enc, nimber: shifted, lives: child.lives + awayLivesSum }); break;
      default: break;
    }
  }
  for (let i = 0; i < split.awayEncs.length; i++) {
    const awayRes = awayResults[i];
    if (!awayRes.ok) continue;
    const otherAway = split.awayEncs.filter((_, j) => j !== i);
    const otherAwayNimberXor = awayNimberXor ^ awayRes.nimber;
    const otherAwayLivesSum = awayLivesSum - (awayRes.lives ?? 0);
    for (const awayChild of awayRes.children) {
      const parts = [split.alphaEnc, ...otherAway, awayChild.enc].filter(p => p !== 'N');
      candidates.push({
        enc: parts.join('+'),
        nimber: res.nimber ^ otherAwayNimberXor ^ awayChild.nimber ^ split.offset,
        lives: (res.lives ?? 0) + otherAwayLivesSum + awayChild.lives,
      });
    }
  }

  if (depth >= MAX_GENOME_DEPTH) {
    return { position, genome: { R, D, L: sortedDedup(L), Tprime: sortedDedup(Tprime), Rc, Dc, Lc, TprimeC } };
  }

  const T = await Promise.all(
    candidates.map(async (c): Promise<TChild> => {
      const tChild: TChild = { ...(await quickRef(c.enc)), nimber: c.nimber, lives: c.lives };
      if (c.lives <= MAX_NESTED_GENOME_LIVES) {
        const nested = await computeAlphaGenomeAt(c.enc, depth + 1);
        if (nested) tChild.genome = nested.genome;
      }
      return tChild;
    }),
  );

  return { position, genome: { R, D, L: sortedDedup(L), Tprime: sortedDedup(Tprime), Rc, Dc, Lc, TprimeC, T } };
}

/** Public entry point: compute the full (depth-0) genome of a position -- always an AlphaGenome
 * (complete, with its own [T]), since MAX_GENOME_DEPTH is never 0. See computeAlphaGenomeAt for the
 * depth-aware implementation shared with nested T-children. */
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

/** Numeric data for every named single-crit genome family (S_3/S_4 excluded -- they carry TWO
 * special-point crits, which isSingleAlpha rejects outright, so there's no single-alpha genome to
 * define for them; their Collections-panel folders come entirely from the roster JSON instead --
 * see COLLECTION_ROSTER_FOLDER_NAMES below).
 *
 * The data lives in src/data/genomeDefs.json -- the SINGLE hand-authored source of these shapes,
 * shared with the native C++ side: stalks/tools/genome_defs.generated.hpp is mechanically
 * transcribed from this same JSON (run `node scripts/genGenomeDefsHeader.cjs` after editing it),
 * and alpha_genome.cpp's own resolveGenome/buildRegistry port consumes that header the same way
 * this file consumes the JSON directly. Previously this data was hand-entered independently in
 * THREE places (this file, alpha_genome.cpp's hardcoded name table, and briefly a third informal
 * copy) -- exactly the kind of drift risk (see the S_10/S_11 mix-up below) a single JSON source
 * eliminates. Do not hand-edit the numbers in two places again; edit genomeDefs.json and
 * regenerate.
 *
 * Every "X⊕n" sibling (n = 1..MAX_SHIFT), every fold-matching string, every display string, and
 * every search-shorthand string is derived from the JSON algorithmically below (see
 * resolveGenome/buildRegistry) -- previously all of that lived as ~140 hand-transcribed,
 * unreadable "(R,D,{L},{T'},[T])" strings (GENOME_SHORTHANDS/NAMED_GENOME_DEFS), which is exactly
 * backwards: entering a handful of easy-to-check numbers and having the rest built algorithmically
 * is both easier to verify and easier to extend.
 *
 * A T-child is a reference to another entry in this same table, optionally itself already shifted
 * (`shift`, default 0) -- e.g. C_3's one T-child is S_1 at shift 0, S_5's second T-child is S_1 at
 * shift 1 (displayed "S_1⊕1"). Why "X⊕n" exists at all: a T move can land on a SPLIT position (a
 * sum of components, only one of which still contains alpha) -- the other component(s)' nim-
 * summed nimber gets XORed directly into R/D/L/T', and (since a component of nimber n forces moves
 * to every nimber 0..n-1 by mex) each away component's own moves surface as additional, real
 * T-children X⊕0..X⊕(n-1) -- see FourGeneGenome's doc comment and computeAlphaGenomeAt.
 * `resolveGenome` below is the same rule applied algebraically: fold `shift` into every gene via
 * XOR, and the T-list is {this family's own T-children, each shifted further by the same amount}
 * UNION {this family at every shift 0..shift-1}. Confirmed against the real engine for C_3 and
 * S_11 (both base and shifted forms) before generalizing to every other family here.
 *
 * S_10/S_11 user-provided 2026-08-25 (S_10's genome was corrected in-session; it and S_11 were
 * originally both given as the same text). S_13/S_16 have no collectionsRoster.json entry (see
 * collections.cpp's own comment -- caught by crit-cell congruity already); present in the JSON for
 * display/T-subgenome purposes only.
 *
 * Renamed 2026-08-28, in sequence: the shape originally called "C_3" is now "S_2" (repurposing the
 * label the roster's real S_1-Pairing-Theorem-sibling group had already vacated -- see
 * ROSTER_TO_FOLDER_NAME below); then the shape originally called "C_4" took over the now-vacant
 * "C_3" label. Both renames needed a matching ROSTER_TO_FOLDER_NAME entry (the roster's own
 * collections.cpp-authored names don't rename themselves), and the C_4->C_3 step also needed
 * updating LEGACY_FOLD_KEYS' second entry, whose "key" string embeds the T-child's folded NAME. */
interface GenomeDef {
  R: number;
  D: number;
  L: number[];
  Tprime: number[];
  T: { name: string; shift?: number }[];
}

interface GenomeDefsJson {
  maxShift: number;
  families: Record<string, GenomeDef>;
  legacyFoldKeys: { key: string; name: string; tChildPlains: string[] }[];
}

const GENOME_DEFS_JSON = genomeDefsData as unknown as GenomeDefsJson;
const GENOME_DEFS: Record<string, GenomeDef> = GENOME_DEFS_JSON.families;

/** How many "X⊕n" siblings get derived for every family above. A component of nimber n forces
 * moves to every nimber 0..n-1 (mex), so this pattern genuinely could extend further, but per the
 * user's own call: treat this as a deliberate ceiling, not a waypoint, until a case actually needs
 * more. */
const MAX_SHIFT = GENOME_DEFS_JSON.maxShift;

function nameOf(family: string, shift: number): string {
  return shift === 0 ? family : `${family}⊕${shift}`;
}

/** A resolved (numeric) genome: same four genes as FourGeneGenome, plus its T-children as plain
 * NAMES (shift already folded in, e.g. "S_1⊕1") rather than nested structures -- what a GENOME_DEFS
 * entry folds out into once `shift` is applied. */
interface ResolvedGenome {
  R: number;
  D: number;
  L: number[];
  Tprime: number[];
  T: string[];
}

const resolvedCache = new Map<string, ResolvedGenome>();

/** Fold `shift` into `family`'s own GENOME_DEFS entry -- see GENOME_DEFS' own doc comment for the
 * rule. Memoized since building the full registry below resolves the same (family, shift) pair
 * repeatedly (once directly, and again each time another family references it as a T-child). */
function resolveGenome(family: string, shift: number): ResolvedGenome {
  const cacheKey = nameOf(family, shift);
  const cached = resolvedCache.get(cacheKey);
  if (cached) return cached;
  const def = GENOME_DEFS[family];
  if (!def) throw new Error(`GENOME_DEFS has no entry named "${family}"`);
  const names = new Set<string>();
  for (const child of def.T) names.add(nameOf(child.name, (child.shift ?? 0) ^ shift));
  for (let k = 0; k < shift; k++) names.add(nameOf(family, k));
  const resolved: ResolvedGenome = {
    R: def.R ^ shift,
    D: def.D ^ shift,
    L: sortedDedup(def.L.map(v => v ^ shift)),
    Tprime: sortedDedup(def.Tprime.map(v => v ^ shift)),
    T: [...names],
  };
  resolvedCache.set(cacheKey, resolved);
  return resolved;
}

function fourGeneKeyOf(g: ResolvedGenome): string {
  return `(${g.R},${g.D},{${g.L.join(',')}},{${g.Tprime.join(',')}})`;
}

function foldedKeyOf(g: ResolvedGenome): string {
  return `${fourGeneKeyOf(g).slice(0, -1)},[${[...g.T].sort().join(',')}])`;
}

export interface NamedFamily {
  name: string;
  coreKey: string;
  tChildPlains: string[];
}

/** Two legacy fold-target keys that predate GENOME_DEFS and don't fit its model -- S_1 (T=[])
 * reached with a non-empty T-list some other way. Preserved verbatim rather than silently dropped,
 * since their origin isn't understood well enough to be confident they're safe to remove; flagged
 * to the user rather than guessed at. Not derived from resolveGenome. Data lives in
 * genomeDefs.json's "legacyFoldKeys" (same single-source rule as GENOME_DEFS above). */
const LEGACY_FOLD_KEYS = GENOME_DEFS_JSON.legacyFoldKeys;

/** Old names kept working for backward-compatible search-bar typing (e.g. "S_12" for what's
 * displayed everywhere else as "S_6⊕1") -- distinct from LEGACY_FOLD_KEYS above, which is about
 * unexplained fold targets, not naming history. Values are the CANONICAL (derivable) shorthand
 * text, i.e. what the alias expands to one more step. "S_2" USED to alias to "S_1+1" here, back
 * when "S_2" was only the roster's name for S_1's Pairing-Theorem sibling -- removed 2026-08-28
 * when "S_2" was repurposed as the former "C_3"'s own plain name (see GENOME_DEFS above): "S_2"
 * now has a real GENOME_DEFS entry of its own, so it must resolve directly via
 * REGISTRY.byShorthand below, not get intercepted here first. */
const LEGACY_SEARCH_ALIASES: Record<string, string> = { S_12: 'S_6+1' };

interface GenomeRegistry {
  /** Fold-matching table: exact plain-text (with folded T-child NAMES, not nested tuples) -> name.
   * Source for GENOME_NAMES (after withCompactKeys). */
  named: Record<string, string>;
  /** Inverse: name -> its own canonical plain-text, for NAMED_FAMILY_GENOME_TEXT. */
  genomeTextByName: Record<string, string>;
  /** Advanced-Collection membership data, in resolution-priority order -- see this function's own
   * doc comment on why order matters here specifically. */
  families: NamedFamily[];
  /** name (as typed with '+', e.g. "S_6+1") -> resolved genome, for expandGenomeShorthand. */
  byShorthand: Record<string, ResolvedGenome>;
}

/** Everything derivable from GENOME_DEFS, built once at module load.
 *
 * Iteration order matters in one specific way: several different (family, shift) pairs can
 * compute to the exact same (R,D,{L},{T'}) core with DIFFERENT T-lists (e.g. S_7/S_9, S_10/S_19,
 * S_17/S_18 all collide on their base forms alone) -- and collect.ts's familyForGenome/
 * isInAdvancedCollection pick the FIRST `families` entry whose core matches. So every family's own
 * shift-0 form is registered before ANY shift>=1 form (bases always win a collision against a
 * derived shape), and within each of those two passes, families are visited in GENOME_DEFS'
 * declaration order with all of ONE family's shifts (1, then 2, then 3) registered together before
 * moving to the next family -- verified by diffing this exact ordering's `.find()` winner against
 * every real coreKey collision in the hand-written table it replaced (see chat history), not just
 * asserted by construction. A genuinely NEW collision between two GENOME_DEFS entries throws
 * instead of silently picking one, since that would be the same kind of discovery as S_12 turning
 * out to be S_6⊕1 -- worth surfacing, not papering over. */
function buildRegistry(): GenomeRegistry {
  const named: Record<string, string> = {};
  const genomeTextByName: Record<string, string> = {};
  const families: NamedFamily[] = [];
  const byShorthand: Record<string, ResolvedGenome> = {};

  function register(family: string, shift: number): void {
    const name = nameOf(family, shift);
    const g = resolveGenome(family, shift);
    const key = foldedKeyOf(g);
    const existing = named[key];
    if (existing && existing !== name) {
      throw new Error(
        `GENOME_DEFS collision: "${name}" and "${existing}" compute to the identical genome ` +
        `${key} -- these are the same real genome (see the S_12/S_6⊕1 discovery); pick one name ` +
        'and remove the other\'s own GENOME_DEFS entry, keeping it only as a T-child reference.',
      );
    }
    named[key] = name;
    genomeTextByName[name] = key;
    families.push({ name, coreKey: fourGeneKeyOf(g), tChildPlains: [...g.T].sort() });
    byShorthand[name.replace(/⊕/g, '+')] = g;
  }

  for (const family of Object.keys(GENOME_DEFS)) register(family, 0);
  for (const family of Object.keys(GENOME_DEFS)) {
    for (let shift = 1; shift <= MAX_SHIFT; shift++) register(family, shift);
  }
  for (const { key, name } of LEGACY_FOLD_KEYS) named[key] = name;
  families.unshift(...LEGACY_FOLD_KEYS.map(({ name, tChildPlains }) => ({ name, coreKey: '(0,1,{0},{})', tChildPlains })));

  return { named, genomeTextByName, families, byShorthand };
}

const REGISTRY = buildRegistry();

/** Expand a search-bar shorthand name (e.g. "S_1", "S_1+1", "S_6+1", "S_2", "S_12") to its
 * "(R,D,{L},{T'})" query text; returns the input unchanged if it isn't a recognized name. The [T]
 * portion is never included -- GENOME_QUERY_RE above never parses it either (see its own comment),
 * so there was never anything for a caller to gain from a longer string here. */
export function expandGenomeShorthand(input: string): string {
  const trimmed = input.trim();
  const canonical = LEGACY_SEARCH_ALIASES[trimmed] ?? trimmed;
  const g = REGISTRY.byShorthand[canonical];
  return g ? fourGeneKeyOf(g) : input;
}

function withCompactKeys(names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...names };
  for (const [key, name] of Object.entries(names)) {
    const compact = key.replace(/,\[[^\]]*\]\)$/, ')');
    if (compact !== key && !(compact in out)) out[compact] = name;
  }
  return out;
}

interface CollectionRosterEntry {
  name: string;
  offset: number;
  elements: string[];
  rep: string;
}
interface CollectionsRosterFile {
  collections: CollectionRosterEntry[];
}
const COLLECTION_ROSTERS = (collectionsRosterJson as unknown as CollectionsRosterFile).collections;

/** Roster name (as authored in stalks/src/collections.cpp -- "S_1", "S_2", "S_3", "S_4", ...) ->
 * the Collect pane's own folder name for the SAME collection, for cases where they differ.
 * S_1's Pairing-Theorem offset-1 sibling is folded/displayed as "S_1⊕1" throughout this file (a
 * naming convention baked into GENOME_NAMES fold-matching well before this roster sync existed --
 * see GENOME_DEFS above), not "S_2" -- so the roster's "S_2" group needs aliasing onto that
 * same folder rather than getting a second, redundant one. Same story for "S_12": discovered
 * 2026-08-25 to be S_6⊕1 under a plain name (see genomeDefs.json's own comment/GENOME_DEFS doc
 * comment on the S_12/S_6⊕1 collision) -- the roster still authors it as "S_12" (collections.cpp
 * predates the discovery), so it needs the same aliasing S_2 gets.
 *
 * "C_3": "S_2" and "C_4": "C_3" added 2026-08-28 for the OPPOSITE reason -- GENOME_DEFS's former
 * "C_3" entry was itself renamed to "S_2" (repurposing the label the roster's real S_1-sibling
 * group had already vacated via the alias just above), then the former "C_4" took over the
 * now-vacant "C_3" label. Either way, the roster's own real collected members under the OLD name
 * need redirecting onto the NEW folder instead of a stale, headerless one under the old name. This
 * is the generalizable version of the SAME situation: whenever a GENOME_DEFS family's plain name
 * changes, the roster's OLD name for it needs an entry here pointing at the NEW one, since
 * collections.cpp itself is out of scope for this file's single-source-of-truth consolidation (see
 * the JSON's own comment) and isn't renamed in lockstep.
 *
 * Everything else (S_3, S_4, and whatever gets registered later) has no such pre-existing alias
 * and passes through unchanged. */
const ROSTER_TO_FOLDER_NAME: Record<string, string> = {
  S_2: 'S_1⊕1',
  S_12: 'S_6⊕1',
  C_3: 'S_2',
  C_4: 'C_3',
};

function rosterFolderName(rosterName: string): string {
  return ROSTER_TO_FOLDER_NAME[rosterName] ?? rosterName;
}

/** A roster element's authored left-side encoding (stalks/src/collections.cpp's own convention --
 * digits 0-8 as-is, ports 'a'/'b' as literal crit-port letters, ',' separating boundaries) into the
 * paper's own left-side display form: crit ports as Greek letters (only 'a'/'b' ever appear, per
 * the k<=2 scope built so far) and a trailing '/' instead of ']' -- matching collections.hpp's own
 * "the text between '[' and '/'" convention (see also collect.ts's bracketDisplaySlash, which
 * applies the identical rule to REAL analyzed positions). */
function leftSideDisplay(enc: string): string {
  return `[${enc.replace(/a/g, 'α').replace(/b/g, 'β')}/`;
}

/** Every currently-registered Advanced Collection's known members, straight from
 * stalks/src/collections.cpp via src/data/collectionsRoster.json (regenerated by
 * tools/dump_collections_roster.cpp -- see that file's own header for the rebuild command) --
 * whenever a roster there is edited (elements added/removed, a whole new collection registered),
 * rerunning the dump tool updates this with no further TS-side changes needed, so the Collect
 * pane's Collections panel can never silently drift from what quickCanon() actually matches. Each
 * list's last entry, when present, is the collection's own shared reduction target -- the roster's
 * deliberately-OMITTED lowest-order/rep element (see registry()'s and doubleCritRegistry()'s
 * comments on why it's left out of the C++ matching map itself: a region already in rep form must
 * never re-match). A collection sharing its pair-partner's rep instead of having its own (S_2
 * shares S_1's; S_4 shares S_3's) has no extra entry for it here.
 *
 * Static reference labels, not PositionRef -- there's no real analyzed Collect entry behind them
 * (S_3/S_4 in particular have two crits, which isSingleAlpha rejects outright; S_1/S_2's
 * single-port shapes use 'a' as a schematic port placeholder in the registry, not necessarily the
 * literal alpha token). Keyed by rosterFolderName() so collect.ts's Collections panel lists them
 * under the right folder (aliased onto an existing NAMED_FAMILIES folder for S_1/S_2, or its own
 * roster-only folder otherwise -- see COLLECTION_ROSTER_FOLDER_NAMES). */
export const KNOWN_COLLECTION_MEMBERS: Record<string, string[]> = Object.fromEntries(
  COLLECTION_ROSTERS.map(r => {
    const labels = r.elements.map(leftSideDisplay);
    if (r.rep) labels.push(leftSideDisplay(r.rep));
    return [rosterFolderName(r.name), labels];
  }),
);

/** Folder names the roster JSON contributes to the Collections panel, in the JSON's own (authored)
 * order -- exported so collect.ts can render one folder per currently-registered collection (S_1,
 * S_1⊕1, S_3, S_4, and whatever's added later) even when no NAMED_GENOME_DEFS entry exists for it
 * (S_3/S_4 today), with no TS-side edit required when collections.cpp registers something new. */
export const COLLECTION_ROSTER_FOLDER_NAMES: string[] = COLLECTION_ROSTERS.map(r => rosterFolderName(r.name));

export const GENOME_NAMES: Record<string, string> = withCompactKeys(REGISTRY.named);

/** Each named family's own assigned genome tuple text (folded form -- nested named T-children
 * shown as their own names, e.g. C_3's "[S_1]" rather than S_1's full tuple), keyed by the family
 * name. Used by the Collect pane's Collections panel to show which genome shape a pre-defined
 * folder actually stands for, right on its header -- S_3/S_4 (roster-only, two-crit, no
 * single-alpha genome at all) simply have no entry here, same as they have none in GENOME_DEFS. */
export const NAMED_FAMILY_GENOME_TEXT: Record<string, string> = REGISTRY.genomeTextByName;

/** A named genome's identity for Advanced-Collection membership testing: its (R,D,{L},{T'}) core
 * plus the folded-plain names of its own lowest-order T-children (e.g. S_5's ["C_3","S_1⊕1"]). A
 * bigger, non-lowest-order position belongs to this family (per the user's Advanced Collection /
 * Grandparent Bypass rule -- see collect.ts's isInAdvancedCollection) when its own core matches
 * AND its own T-children are a superset of tChildPlains AND every extra T-child beyond that has
 * some T-child already in an Advanced Collection. See buildRegistry's own doc comment for why
 * this array's ORDER matters (multiple families can share a core with different T-lists). */
export const NAMED_FAMILIES: NamedFamily[] = REGISTRY.families;

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
