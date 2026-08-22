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
 * `oplus`: a T move can land on a SPLIT position (a sum of multiple components, only one of which
 * still contains alpha) -- movetype classification only makes sense applied to that one
 * alpha-bearing component, so the other component(s)' nimbers can't just be dropped; they're
 * nim-summed (XORed) together and folded into `oplus`, along with the quick-canon offset (this
 * genome is always computed from a position's QUICK-CANON representative, which is itself only
 * nimber-equivalent up to that offset -- see quickAlphaSplitOf). Displayed as "⊕oplus" after the
 * tuple when nonzero (see collect.ts's genomeParts); 0 means neither a split nor a nonzero offset
 * applies, and is not shown. */
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
  oplus: number;
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
 * distinct T-children commonly reduce to the exact same quick-canon rep (see the module header's
 * "2AB|2a,AB" example), so computing genomes this way is what lets [T] dedup meaningfully instead
 * of listing near-identical structural variants separately; the tradeoff, per the user, is that the
 * rep can itself be a split position, handled via `oplus`.
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
  const oplus = split.offset ^ split.awayNimberXor;

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
  const tChildren: typeof res.children = [];
  for (const child of res.children) {
    const mt = child.move?.movetype;
    if (!mt) continue;
    switch (mt) {
      case 1: R = child.nimber; Rc = { enc: child.enc, nimber: child.nimber }; break;
      case 2: D = child.nimber; Dc = { enc: child.enc, nimber: child.nimber }; break;
      case 3: L.push(child.nimber); Lc.push({ enc: child.enc, nimber: child.nimber }); break;
      case 4: Tprime.push(child.nimber); TprimeC.push({ enc: child.enc, nimber: child.nimber }); break;
      case 5: tChildren.push(child); break;
      default: break;
    }
  }

  if (depth >= MAX_GENOME_DEPTH) {
    return { position, genome: { R, D, L: sortedDedup(L), Tprime: sortedDedup(Tprime), oplus, Rc, Dc, Lc, TprimeC } };
  }

  const T = await Promise.all(
    tChildren.map(async (child): Promise<TChild> => {
      const tChild: TChild = { ...(await quickRef(child.enc)), nimber: child.nimber, lives: child.lives };
      if (child.lives <= MAX_NESTED_GENOME_LIVES) {
        const nested = await computeAlphaGenomeAt(child.enc, depth + 1);
        if (nested) tChild.genome = nested.genome;
      }
      return tChild;
    }),
  );

  return { position, genome: { R, D, L: sortedDedup(L), Tprime: sortedDedup(Tprime), oplus, Rc, Dc, Lc, TprimeC, T } };
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

/** Named shorthands for common genomes -- typing one of these keys in the search bar expands to
 * its full genome-query text before parsing (see collect.ts). S_1 = the single-scab position
 * (0,1,{0},{},[]). Its quick-canon-offset pair, "S_1⊕1" = (1,0,{1},{},[S_1]) -- literally
 * containing S_1 as its one T-child -- is the first of what will become a family of named pairs
 * (see GENOME_NAMES); it can be typed as "S_1+1" or, for backward compatibility, "S_2". C_3 =
 * (1,1,{0},{0},[]) -- only occurs at [3α]/[3,α] themselves, but shows up constantly as a T-child
 * for lower-order positions. C_4 = (1,2,{1},{0},[S_1]) -- literally containing S_1 as its one
 * T-child. S_5 = (0,1,{0,2},{},[C_4,S_1⊕1]) -- containing both C_4 and S_1⊕1 as its two
 * T-children. S_7 = (0,3,{0,2},{},[C_3,S_1⊕1]) -- containing both C_3 and S_1⊕1 as its two
 * T-children. [T] entries in GENOME_NAMES keys are always in lexicographic order (see
 * collect.ts's genomeParts, which sorts [T] the same way before matching) -- the engine's own T
 * move-search order is arbitrary and unrelated to this.
 *
 * IMPORTANT when adding a new name: the display name for a pair (e.g. "S_1⊕1" in NAMED_GENOME_DEFS
 * below) is ALWAYS written with NO spaces around "⊕", never "S_1 ⊕ 1" -- collect.ts's foldToName
 * produces "name" + "⊕N" (no space) whenever a tuple is recognized via its OPLUS-SUFFIX form
 * rather than an exact full-tuple match, so a spaced name would silently mismatch and fail to fold
 * half the time depending on which of the two forms a T-child happens to arrive in (this exact
 * mismatch was a real bug: S_1⊕1 folded fine standalone via the suffix path but a parent genome
 * whose key text embedded "S_1⊕1" wouldn't match the spaced value some T-children resolved to via
 * the direct full-tuple-match path, until the position was reselected and recomputed through the
 * OTHER path). Extend this table as more named genomes are identified; unrecognized names fall
 * through to ordinary (probably-failing) genome/position parsing. */
export const GENOME_SHORTHANDS: Record<string, string> = {
  S_1: '(0,1,{0},{},[])',
  'S_1+1': '(1,0,{1},{},[(0,1,{0},{},[])])',
  S_2: '(1,0,{1},{},[(0,1,{0},{},[])])',
  C_3: '(1,1,{0},{0},[])',
  C_4: '(1,2,{1},{0},[(0,1,{0},{},[])])',
  S_5: '(0,1,{0,2},{},[(1,0,{1},{},[(0,1,{0},{},[])]),(1,2,{1},{0},[(0,1,{0},{},[])])])',
  S_7: '(0,3,{0,2},{},[(1,1,{0},{0},[]),(1,0,{1},{},[(0,1,{0},{},[])])])',
};

/** Expand a search-bar shorthand name (e.g. "S_1", "S_1+1", "S_2") to its full genome-query text;
 * returns the input unchanged if it isn't a recognized shorthand. */
export function expandGenomeShorthand(input: string): string {
  return GENOME_SHORTHANDS[input.trim()] ?? input;
}

/** Display names for recognized genome tuples, keyed by the exact plain-text a genome node folds
 * to (see collect.ts's genomeParts/foldToName) -- NOT the same text GENOME_SHORTHANDS parses from
 * search input, since a nested T-child folds to ITS name first (e.g. "S_1⊕1"'s one T-child
 * folds to "S_1" before the parent tuple is checked, so the parent's match key already has "S_1"
 * inside its "[...]", not the raw nested tuple). Used by the Collect pane's Quick-Genome toggle to
 * fold a recognized tuple down to its name at any nesting depth. Paired names (X, X⊕1, no space --
 * see the NAMED_GENOME_DEFS doc comment below for why the spacing must be exact) reflect the
 * quick-canon offset convention (see quickLabel in collect.ts) -- extend this table alongside
 * GENOME_SHORTHANDS as more named genomes/pairs are identified. */
// Every named genome also gets a compact-form key -- the plain-text a genome node prints when it
// carries no T array at all (past collectAlphaGenomes.json's/computeAlphaGenome's depth cap: see
// classifyByMovetype/MAX_GENOME_DEPTH), i.e. the same (R,D,{L},{T'}) text WITHOUT the trailing
// ",[T])" -- so a hover preview or deeply-nested T-child whose T info got truncated still folds by
// its R/D/L/T' alone, same as the full form does.
function withCompactKeys(names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...names };
  for (const [key, name] of Object.entries(names)) {
    const compact = key.replace(/,\[[^\]]*\]\)$/, ')');
    if (compact !== key && !(compact in out)) out[compact] = name;
  }
  return out;
}

// Single source of truth for every named genome's FULL (uncompacted) plain-text key -- both
// GENOME_NAMES (fold-matching, +compact-form keys) and NAMED_FAMILIES (Advanced-Collection
// membership data, see below) are derived from this one table rather than maintained separately.
// S_1/S_1⊕1 are real, computable single-alpha genome shapes; S_3/S_4 have no entry here at all --
// their left sides carry TWO special-point crits (alpha AND beta), which isSingleAlpha rejects
// outright, so there's no genome to classify a real position against. Their Collections-panel
// folders come entirely from the roster JSON below (COLLECTION_ROSTER_FOLDER_NAMES) instead.
const NAMED_GENOME_DEFS: Record<string, string> = {
  '(0,1,{0},{},[])': 'S_1',
  '(1,0,{1},{},[S_1])': 'S_1⊕1',
  '(1,1,{0},{0},[])': 'C_3',
  '(1,2,{1},{0},[S_1])': 'C_4',
  '(0,1,{0,2},{},[C_4,S_1⊕1])': 'S_5',
  '(0,3,{0,2},{},[C_3,S_1⊕1])': 'S_7',
};

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
 * the Collect pane's own folder name for the SAME collection, for the one case where they differ.
 * S_1's Pairing-Theorem offset-1 sibling is folded/displayed as "S_1⊕1" throughout this file (a
 * naming convention baked into GENOME_NAMES fold-matching well before this roster sync existed --
 * see NAMED_GENOME_DEFS above), not "S_2" -- so the roster's "S_2" group needs aliasing onto that
 * same folder rather than getting a second, redundant one. Everything else (S_3, S_4, and whatever
 * gets registered later) has no such pre-existing alias and passes through unchanged. */
const ROSTER_TO_FOLDER_NAME: Record<string, string> = { S_2: 'S_1⊕1' };

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

export const GENOME_NAMES: Record<string, string> = withCompactKeys(NAMED_GENOME_DEFS);

/** Inverse of NAMED_GENOME_DEFS: each named family's own assigned genome tuple text (folded form --
 * nested named T-children shown as their own names, e.g. C_4's "[S_1]" rather than S_1's full
 * tuple), keyed by the family name. Used by the Collect pane's Collections panel to show which
 * genome shape a pre-defined folder (S_1, S_1⊕1, C_3, C_4, S_5, S_7) actually stands for, right on
 * its header -- S_3/S_4 (roster-only, two-crit, no single-alpha genome at all) simply have no entry
 * here, same as they have none in NAMED_GENOME_DEFS. */
export const NAMED_FAMILY_GENOME_TEXT: Record<string, string> = Object.fromEntries(
  Object.entries(NAMED_GENOME_DEFS).map(([key, name]) => [name, key]),
);

/** A named genome's identity for Advanced-Collection membership testing: its (R,D,{L},{T'}) core
 * (the compact-form key text, e.g. "(0,1,{0,2},{})") plus the folded-plain names of its own
 * lowest-order T-children (e.g. S_5's ["C_4","S_1⊕1"]). A bigger, non-lowest-order position
 * belongs to this family (per the user's Advanced Collection / Grandparent Bypass rule -- see
 * collect.ts's isInAdvancedCollection) when its own core matches AND its own T-children are a
 * superset of tChildPlains AND every extra T-child beyond that has some T-child already in an
 * Advanced Collection. */
export interface NamedFamily {
  name: string;
  coreKey: string;
  tChildPlains: string[];
}

const NAMED_GENOME_DEF_RE = /^\((-?\d+),(-?\d+),\{([^}]*)\},\{([^}]*)\},\[([^\]]*)\]\)$/;

export const NAMED_FAMILIES: NamedFamily[] = Object.entries(NAMED_GENOME_DEFS).map(([key, name]) => {
  const m = NAMED_GENOME_DEF_RE.exec(key);
  if (!m) throw new Error(`NAMED_GENOME_DEFS key doesn't match the expected shape: ${key}`);
  const [, R, D, L, Tprime, tChildren] = m;
  return {
    name,
    coreKey: `(${R},${D},{${L}},{${Tprime}})`,
    tChildPlains: tChildren.length === 0 ? [] : tChildren.split(','),
  };
});

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
