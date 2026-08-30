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
 * real, engine-verified T-children, not a hand-derived pattern -- see NAMED_GENOME_DEFS's S_3⊕1/
 * S_3⊕2 entries. There is deliberately no separate "oplus" field any more: every correction is
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

/** `enc`'s REAL structural components, split into "the one still containing alpha" (`realAlphaEnc`)
 * and every other ("away") component (`awayEncs`) -- a pure syntactic split (Sprouts positions use
 * '+' as the literal disjoint-sum separator, so this needs no engine call), with NO quick-canon
 * reduction applied to either side. computeAlphaGenomeAt classifies movetypes directly on
 * `realAlphaEnc` itself (not a quick-canon rep -- see that function's own doc comment for why an
 * earlier version's rep-based classification was unsound), and away-component-move candidates
 * reattach whichever side DIDN'T move using these same real encodings verbatim -- never a quick-canon
 * stand-in, which would report a T-child that's only nimber-equivalent to a reachable position, not
 * actually reachable itself (e.g. for `enc` = "1a+22", the away move on "22" actually reaches "1a", a
 * genuine S_1⊕1 member -- reattaching alpha's quick-canon rep "2a" instead claimed the reached
 * position was "2a", i.e. S_1 exactly: an impossible T-child, since a collection member can't lead
 * back into its own collection). */
function quickAlphaSplitOf(enc: string): { realAlphaEnc: string; awayEncs: string[] } {
  const parts = enc.split('+').filter(p => p !== 'N');
  const realAlphaEnc = parts.find(p => p.includes('a')) ?? enc;
  const awayEncs = parts.filter(p => p !== realAlphaEnc);
  return { realAlphaEnc, awayEncs };
}

/** Compute the genome of `enc`, classifying movetypes directly on its REAL alpha-bearing component
 * (see quickAlphaSplitOf) -- an earlier version of this function ran classification on that
 * component's quick-canon REP instead (to dedup quick-canon-equivalent alpha shapes to the same
 * genome), but that's unsound: a rep is only proven NIMBER-equivalent to the real component, not
 * proven to share its move graph, so reusing the rep's own children as if they were the real
 * component's own real T-children can silently drop or misreport moves that only the real structure
 * actually has. Concretely, searching S_5 and opening a T-child that quick-canons to "S_5 ⊕ 1"
 * (i.e. its own alpha component's real-to-rep offset is 1, with no away component to blame the
 * offset on) showed T=[S_1,S_2] -- S_5's OWN unshifted T-list, verbatim, recomputed from the rep with
 * the offset applied only to R/D/L/T', never to T -- instead of the mathematically required
 * T=[S_1⊕1,S_2⊕1,S_5] (S_5's T-children shifted the same way, per the "family at every shift
 * 0..shift-1" rule genomeDefs.json's resolveGenome already applies for NAMED families -- see its own
 * doc comment). Classifying on the real component directly sidesteps the whole issue: its own real
 * moves already reach genuinely real positions (here, real structural variants that themselves
 * happen to quick-canon to S_1⊕1, S_5, and S_2⊕1 respectively -- confirmed against the live engine),
 * with no offset bookkeeping needed for the alpha side at all. Dedup of quick-canon-equivalent alpha
 * shapes still happens, just one level up: two different real structures reaching the same FOLDED
 * NAME display identically regardless of which real variant produced it, which is what a reader
 * actually sees -- the raw candidate encodings never needed to match for that.
 *
 * When `enc` is a split (a sum of components, only one bearing alpha), the away component(s)'
 * nim-summed (real, exact) nimber is XORed directly into R/D/L/T' (a real component of nimber n
 * forces moves to every nimber 0..n-1 by mex, so this is what actually happens to the position's
 * values when it's played as a disjoint sum -- not a display-only correction), and each away
 * component's own real moves are enumerated as additional T-children (see quickAlphaSplitOf's own
 * doc comment) -- this is what lets shapes like S_3⊕1/S_3⊕2 arise as real, named T-children instead
 * of only ever showing up as an approximate "⊕N" suffix on the alpha component's own tuple.
 * Whichever side DIDN'T move in a given candidate is reattached using its REAL encoding
 * (split.realAlphaEnc / split.awayEncs), never a quick-canon stand-in.
 *
 * `depth` controls how far [T] nests -- see MAX_GENOME_DEPTH/MAX_NESTED_GENOME_LIVES: at
 * MAX_GENOME_DEPTH, the result is truncated to a bare FourGeneGenome (no T-children computed at all,
 * since nothing would ever recurse past this depth anyway), so recursion always terminates. Null on
 * any engine failure or a position that doesn't contain exactly one alpha token. */
async function computeAlphaGenomeAt(
  enc: string,
  depth: number,
): Promise<{ position: PositionRef; genome: AlphaGenome | FourGeneGenome } | null> {
  const split = quickAlphaSplitOf(enc);
  const [position, res, awayResults] = await Promise.all([
    quickRef(enc),
    analyze(split.realAlphaEnc),
    Promise.all(split.awayEncs.map(e => analyze(e))),
  ]);
  if (!res.ok) return null;
  if (!isSingleAlpha(res.canon)) return null;

  let awayNimberXor = 0;
  let awayLivesSum = 0;
  for (const r of awayResults) {
    if (r.ok) { awayNimberXor ^= r.nimber; awayLivesSum += r.lives ?? 0; }
  }
  const awayPrefix = split.awayEncs.length ? split.awayEncs.join('+') + '+' : '';

  let R: number | null = null;
  let D: number | null = null;
  let Rc: MoveChildRef | undefined;
  let Dc: MoveChildRef | undefined;
  const L: number[] = [];
  const Tprime: number[] = [];
  const Lc: MoveChildRef[] = [];
  const TprimeC: MoveChildRef[] = [];
  // Every T-move candidate reachable from the full split position: one per real move of the
  // alpha component (away part(s) carried through unchanged, at their REAL encoding) plus one per
  // real move of each away component (alpha part carried through unchanged, at ITS real encoding) --
  // see this function's own doc comment.
  const candidates: { enc: string; nimber: number; lives: number }[] = [];
  for (const child of res.children) {
    const mt = child.move?.movetype;
    if (!mt) continue;
    const shifted = child.nimber ^ awayNimberXor;
    switch (mt) {
      case 1: R = shifted; Rc = { enc: child.enc, nimber: child.nimber }; break;
      case 2: D = shifted; Dc = { enc: child.enc, nimber: child.nimber }; break;
      case 3: L.push(shifted); Lc.push({ enc: child.enc, nimber: child.nimber }); break;
      case 4: Tprime.push(shifted); TprimeC.push({ enc: child.enc, nimber: child.nimber }); break;
      case 5: candidates.push({ enc: awayPrefix + child.enc, nimber: shifted, lives: child.lives + awayLivesSum }); break;
      default: break;
    }
  }
  // Away-component moves: alpha stays untouched at its own real encoding/nimber (`res`, already the
  // real alpha's own analyze() result -- see this function's own doc comment).
  for (let i = 0; i < split.awayEncs.length; i++) {
    const awayRes = awayResults[i];
    if (!awayRes.ok) continue;
    const otherAway = split.awayEncs.filter((_, j) => j !== i);
    const otherAwayNimberXor = awayNimberXor ^ awayRes.nimber;
    const otherAwayLivesSum = awayLivesSum - (awayRes.lives ?? 0);
    for (const awayChild of awayRes.children) {
      const parts = [split.realAlphaEnc, ...otherAway, awayChild.enc].filter(p => p !== 'N');
      candidates.push({
        enc: parts.join('+'),
        nimber: res.nimber ^ otherAwayNimberXor ^ awayChild.nimber,
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

/** Numeric data for every named single-crit genome family ("Z_1"/"Z_2" excluded -- authored in the
 * roster as "S_3"/"S_4", they carry TWO special-point crits, which isSingleAlpha rejects outright,
 * so there's no single-alpha genome to define for them; their Collections-panel folders come
 * entirely from the roster JSON instead -- see COLLECTION_ROSTER_FOLDER_NAMES below).
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
 * (`shift`, default 0) -- e.g. S_3's one T-child is S_1 at shift 0, S_5's second T-child is S_1 at
 * shift 1 (displayed "S_1⊕1"). Why "X⊕n" exists at all: a T move can land on a SPLIT position (a
 * sum of components, only one of which still contains alpha) -- the other component(s)' nim-
 * summed nimber gets XORed directly into R/D/L/T', and (since a component of nimber n forces moves
 * to every nimber 0..n-1 by mex) each away component's own moves surface as additional, real
 * T-children X⊕0..X⊕(n-1) -- see FourGeneGenome's doc comment and computeAlphaGenomeAt.
 * `resolveGenome` below is the same rule applied algebraically: fold `shift` into every gene via
 * XOR, and the T-list is {this family's own T-children, each shifted further by the same amount}
 * UNION {this family at every shift 0..shift-1}. Confirmed against the real engine for the shape
 * now called S_3 and for S_11 (both base and shifted forms) before generalizing to every other
 * family here.
 *
 * Two 2026-08-25 provenance notes, using THAT DAY's labels (both shapes have since been renamed --
 * see below -- so don't read these as referring to the CURRENT S_10/S_11/S_13/S_16): the shape then
 * called "S_10" (now "S_8") had its genome corrected in-session, having originally been given as
 * identical to the shape then called "S_11" (now "S_5") by mistake. Separately, the shapes then
 * called "S_13" and "S_16" (now "S_4" and "S_23") were noted as having no collectionsRoster.json
 * entry of their own at the time (caught by crit-cell congruity instead) -- that claim no longer
 * holds for either shape's current label (both are in the roster today, see ROSTER_TO_FOLDER_NAME),
 * so treat it as historical only, not a live invariant to preserve.
 *
 * Renamed 2026-08-28, in sequence: the shape originally called "C_3" is now "S_2" (repurposing the
 * label the roster's real S_1-Pairing-Theorem-sibling group had already vacated -- see
 * ROSTER_TO_FOLDER_NAME below); then the shape originally called "C_4" took over the now-vacant
 * "C_3" label. Both renames needed a matching ROSTER_TO_FOLDER_NAME entry (the roster's own
 * collections.cpp-authored names don't rename themselves), and the C_4->C_3 step also needed
 * updating LEGACY_FOLD_KEYS' second entry, whose "key" string embeds the T-child's folded NAME.
 *
 * Same day, a much larger user-directed cascade: S_13->C_4, S_11->S_5, S_10->S_8, S_6->S_9,
 * S_14->S_10, S_7->S_12, S_18->S_14, S_19->S_17, S_15->S_18, S_5->S_20, S_20->S_21, S_8->S_22,
 * S_16->S_23, S_9->S_25, S_17->S_26 -- 15 renames at once, several of them cyclic (S_5 and S_20
 * swap roles, etc.), so the whole `families` object was rebuilt directly from the target state
 * rather than edited as a sequence of individual renames (which would silently collide on shared
 * JSON keys mid-sequence -- see the earlier chat's "mechanical footguns" note on this). The vacated
 * labels S_6, S_7, S_11, S_13, S_15, S_16, S_19 (plus never-used S_24) were immediately reassigned
 * to 8 BRAND NEW families, each verified against the live engine (not hand-derived) before being
 * added: their genome and T-children matched the user's own table exactly. See
 * ROSTER_TO_FOLDER_NAME's own doc comment for the (large) roster-aliasing fallout this required.
 *
 * Renamed AGAIN 2026-08-28, immediately after: the roster's two double-crit collections (no
 * GENOME_DEFS entry of their own -- see this comment's opening paragraph) moved from their roster-
 * authored "S_3"/"S_4" display to "Z_1"/"Z_2", freeing "S_3"/"S_4" for what the cascade above had
 * just called "C_3"/"C_4" -- per the user's own naming scheme, ALL single-crit families now use
 * "S_n" and both double-crit ones use "Z_n". Order mattered (vacate before reassigning, same as the
 * S_2 rename), and the C_3->S_3 step needed the same LEGACY_FOLD_KEYS update the C_4->C_3 step did
 * two paragraphs up, for the same reason (its "key" string embeds the T-child's folded NAME). */
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
 * displayed everywhere else as "S_9⊕1") -- distinct from LEGACY_FOLD_KEYS above, which is about
 * unexplained fold targets, not naming history. Values are the CANONICAL (derivable) shorthand
 * text, i.e. what the alias expands to one more step. "S_2" USED to alias to "S_1+1" here, back
 * when "S_2" was only the roster's name for S_1's Pairing-Theorem sibling -- removed 2026-08-28
 * when "S_2" was repurposed as the former "C_3"'s own plain name (see GENOME_DEFS above): "S_2"
 * now has a real GENOME_DEFS entry of its own, so it must resolve directly via
 * REGISTRY.byShorthand below, not get intercepted here first.
 *
 * "S_12" USED to alias to "S_9+1" here (changed from "S_6+1" earlier the same day, when the
 * 15-family cascade moved that shape's own label from "S_6" to "S_9") -- removed entirely
 * 2026-08-29, for the SAME reason "S_2" was removed above: collections.cpp's own roster was
 * renamed to match genomeDefs.json directly that day (see ROSTER_TO_FOLDER_NAME's own doc
 * comment), and "S_12" is now itself a real GENOME_DEFS family (the shape formerly called "S_7"),
 * so leaving this alias in place would have silently intercepted a search for the CURRENT S_12 and
 * redirected it to the unrelated "S_9+1" shape instead -- exactly the collision class
 * ROSTER_TO_FOLDER_NAME's own doc comment warns about, just on the search-bar side. Empty for now;
 * add an entry here again only for a genuinely retired name with no current real meaning (the
 * original "S_2"/"S_1+1" story before it got repurposed, not this one). */
const LEGACY_SEARCH_ALIASES: Record<string, string> = {};

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
  /** name (as typed with '+', e.g. "S_6+1") -> the exact canonical name it denotes (e.g. "S_6⊕1"),
   * for nameForShorthand. Kept separate from byShorthand's ResolvedGenome values because a search
   * for a specific shorthand needs the family it explicitly named, not whichever family happens to
   * share its bare (R,D,{L},{T'}) core -- see nameForShorthand's own doc comment. */
  shorthandNames: Record<string, string>;
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
  const shorthandNames: Record<string, string> = {};

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
    const shorthand = name.replace(/⊕/g, '+');
    byShorthand[shorthand] = g;
    shorthandNames[shorthand] = name;
  }

  for (const family of Object.keys(GENOME_DEFS)) register(family, 0);
  for (const family of Object.keys(GENOME_DEFS)) {
    for (let shift = 1; shift <= MAX_SHIFT; shift++) register(family, shift);
  }
  for (const { key, name } of LEGACY_FOLD_KEYS) named[key] = name;
  families.unshift(...LEGACY_FOLD_KEYS.map(({ name, tChildPlains }) => ({ name, coreKey: '(0,1,{0},{})', tChildPlains })));

  return { named, genomeTextByName, families, byShorthand, shorthandNames };
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

/** The exact family name (e.g. "S_1⊕2") a search-bar shorthand explicitly denotes, or undefined if
 * `input` isn't a recognized shorthand -- e.g. a raw "(R,D,{L},{T'})" tuple, or free text. Exists
 * because expandGenomeShorthand only carries the bare four-gene query forward, and re-deriving the
 * searched name from that bare tuple afterward (GENOME_NAMES[key]) is lossy: several different
 * named families can share the exact same (R,D,{L},{T'}) core with different T-lists (e.g. S_1⊕2
 * and S_15 both key to "(2,3,{2},{})"), so that reverse lookup silently picks whichever family
 * happened to register first -- not necessarily the one actually typed. Called BEFORE expansion, on
 * the user's own raw input, so it can return the exact name unambiguously. */
export function nameForShorthand(input: string): string | undefined {
  const trimmed = input.trim();
  const canonical = LEGACY_SEARCH_ALIASES[trimmed] ?? trimmed;
  return REGISTRY.shorthandNames[canonical];
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
 *
 * EMPTIED 2026-08-29: collections.cpp's own roster names were renamed directly (in one pass, same
 * session) to match genomeDefs.json's current scheme, so every roster name IS its own correct
 * folder name now -- no bridging needed. This table held up to 22 entries through 2026-08-25/28's
 * four renames, each requiring the roster's OLD name mapped to the shape's NEW genomeDefs.json
 * name (collections.cpp was explicitly out of scope for the earlier JSON consolidation and never
 * renamed in lockstep -- see genomeDefs.json's own "Renamed" doc comments for that history).
 *
 * **Real bug caught and fixed while emptying this**: simply leaving the OLD entries in place after
 * renaming collections.cpp itself would have been actively WRONG, not just dead weight -- several
 * old KEYS (e.g. "S_2", "S_5", "S_8"...) are ALSO names the renamed roster now legitimately emits
 * for a DIFFERENT shape (e.g. the roster's real new "S_2" entry, formerly "C_3", would have been
 * silently redirected onto the "S_1⊕1" folder by the stale `S_2: 'S_1⊕1'` entry -- wrong target,
 * silently). Whenever collections.cpp itself gets renamed to match a genomeDefs.json rename (now
 * the preferred approach -- see genomeDefs.json's own doc comment), this table needs NO entries for
 * that rename, precisely because there's no more name mismatch to bridge. Only add an entry here
 * again for a case collections.cpp genuinely can't/won't mirror directly (its own two double-crit
 * groups, if renamed on the TS side without a matching C++ rename, would need this again). */
const ROSTER_TO_FOLDER_NAME: Record<string, string> = {};

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
 * (S_3/S_4 -- displayed as "Z_1"/"Z_2" since 2026-08-28, see ROSTER_TO_FOLDER_NAME -- in particular
 * have two crits, which isSingleAlpha rejects outright; S_1/S_2's
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
 * S_1⊕1, Z_1, Z_2, and whatever's added later) even when no NAMED_GENOME_DEFS entry exists for it
 * (the roster's own "S_3"/"S_4", displayed as "Z_1"/"Z_2" today), with no TS-side edit required
 * when collections.cpp registers something new. */
export const COLLECTION_ROSTER_FOLDER_NAMES: string[] = COLLECTION_ROSTERS.map(r => rosterFolderName(r.name));

export const GENOME_NAMES: Record<string, string> = withCompactKeys(REGISTRY.named);

/** Each named family's own assigned genome tuple text (folded form -- nested named T-children
 * shown as their own names, e.g. S_3's "[S_1]" rather than S_1's full tuple), keyed by the family
 * name. Used by the Collect pane's Collections panel to show which genome shape a pre-defined
 * folder actually stands for, right on its header -- Z_1/Z_2 (the roster's own two-crit "S_3"/
 * "S_4", roster-only, no single-alpha genome at all) simply have no entry here, same as they have
 * none in GENOME_DEFS. */
export const NAMED_FAMILY_GENOME_TEXT: Record<string, string> = REGISTRY.genomeTextByName;

/** A named genome's identity for Advanced-Collection membership testing: its (R,D,{L},{T'}) core
 * plus the folded-plain names of its own lowest-order T-children (e.g. S_20's ["S_3","S_1⊕1"]). A
 * bigger, non-lowest-order position belongs to this family (per the user's Advanced Collection /
 * Grandparent Bypass rule -- see collect.ts's isInAdvancedCollection) when its own core matches
 * AND its own T-children are a superset of tChildPlains AND every extra T-child beyond that has
 * some T-child already in an Advanced Collection. See buildRegistry's own doc comment for why
 * this array's ORDER matters (multiple families can share a core with different T-lists). */
export const NAMED_FAMILIES: NamedFamily[] = REGISTRY.families;

export interface NamedFamilyGroup {
  /** The shift-0 (plain) name, e.g. "S_1". */
  base: string;
  /** "base⊕1".."base⊕MAX_SHIFT", in shift order -- buildRegistry always registers exactly this
   * many for every GENOME_DEFS family unconditionally (see its own second registration pass), so
   * this is computed directly via nameOf rather than filtered out of REGISTRY.families -- no risk
   * of missing or extra entries. */
  offsets: string[];
}

/** One group per GENOME_DEFS family, in GENOME_DEFS' own declaration order (a DIFFERENT thing from
 * display order -- collect.ts sorts these itself for the Collections panel; this array's order
 * stays tied to GENOME_DEFS purely because that's the natural free order to compute it in). Lets a
 * consumer nest each family's "X⊕n" siblings inside its own base's collapsible section instead of
 * listing ~4x as many top-level folders -- exactly what the Collections panel needed. */
export const NAMED_FAMILY_GROUPS: NamedFamilyGroup[] = Object.keys(GENOME_DEFS).map(base => ({
  base,
  offsets: Array.from({ length: MAX_SHIFT }, (_, i) => nameOf(base, i + 1)),
}));

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
