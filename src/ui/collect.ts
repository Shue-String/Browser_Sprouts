/**
 * Collect: type a position encoding into the search bar (optionally marking one DisaPoint as the
 * critical membrane -- written 'α', e.g. "23A|Aα,13738" -- in place of its '3') to see the "genetic
 * code" of each DisaPoint it contains: the
 * nimber sets reachable via L (region-internal) and R (self-connect, branch disappears) moves, the
 * D (hypothetical scab-replace) nimber, and the lists of T and T' positions -- every other legal
 * move of the position, shown in canon (bracket/⊕) form. Internally this is still just a DisaPoint
 * (token '3') for every L/T-move computation; 'α' is purely how the chosen one is displayed, per the
 * paper's Left/Right-position notation (a second critical membrane, when double-crit positions are
 * added, will display as 'β'). The legacy trailing '*' right after a '3' (e.g. "23A|A3*,13738") is
 * still accepted as input for backward compatibility, but is never shown anymore -- output is always
 * 'α'. Every T/T' position still contains the
 * original DisaPoint somewhere: a plain T move keeps it a genuine DisaPoint (marked 'α', same
 * convention as the search result label) and is listed under "T"; a T' move instead strands it --
 * together with its detached partner -- as its own inert [22] ⊕-summand (marked '*' on that summand
 * instead; see TPositionMark) and is listed separately under "T'". Each T/T' position also gets a
 * trailing '?' when the Grandparent Bypass Theorem applies: this DisaPoint, tracked through that
 * move, has some grandchild-level descendant whose own (L,R,D) genetic code exactly matches this
 * one's.
 *
 * The genome tuple is (L,R,D,T') -- T' is the deduped nimber set reached by deleting each T'-move
 * child's isolated [22] summand and taking the nimber of what's left (see
 * computeTprimeGeneFromChildren); T itself is NOT part of the genome, just an extra column shown
 * last, same list-of-positions display as always.
 *
 * Typing a genome instead of a position -- anything starting with '(', e.g. "({0},1,1,{0})" (or the
 * legacy 3-tuple "({0},1,1)", which matches every T' bucket sharing that L/R/D) -- looks it up in
 * GENOME_DB (see src/data/collectGenomes.json, built by stalks/tools/collect_genetics.cpp) and
 * loads EVERY <=7-life position with that genome into the list on the left. GENOME_DB only stores
 * (enc, DisaPoint index, life count, Grandparent-Bypass-all-pass flag) per hit -- not T or the
 * L/R/D/T' witnessing positions -- so a genome-loaded entry's row/expand-dropdown data is computed
 * lazily, the first time it's actually opened (see fillDetail); L/R/D/T' themselves are known
 * immediately from the bucket.
 *
 * Every DisaPoint variation ever searched or genome-loaded (or seeded as a default from the
 * ({0},1,1) and ({1},0,0) genomes, see seedDefaultHistory) is kept as a "variation" in the list on
 * the left, in quick-canon (bracket/⊕) form with 'α' marking the DisaPoint, ordered by ascending
 * life count (not insertion order) and deduped by label. Each line also shows the variation's own
 * life count, right-aligned (the parent position's nimber isn't meaningful for collection
 * purposes), plus a '?' next to the label when every one of its T-move children satisfies the
 * Grandparent Bypass Theorem (the same condition that puts a '?' on an individual T row in the
 * detail pane below -- see TEntry.bypass). Every T/T' child position in the detail pane still shows
 * its own nimber, right-aligned, unchanged. The list persists across reloads via localStorage;
 * invalid/empty searches never get added to it.
 *
 * Limited to positions with 8 or fewer lives (counting each DisaPoint as one life) for now — see
 * the user's spec: beyond that the engine falls back to on-demand quick-canon nimber lookups,
 * which this feature doesn't attempt to handle yet.
 */

import { analyze, decompress } from '../engine/stalks';
import { display as bracketDisplay } from './positionBrowser';
import {
  parseEncoding,
  findDisaPoints,
  countLives,
  buildDisplayEncoding,
  computeR,
  buildReplaceEncoding,
  lMoveNimbersRobust,
  classifyChildrenByDisaPoint,
  analyzeTEntry,
  toDisplayForm,
  computeGeneticCode,
  computeTprimeGeneFromChildren,
  relocateDisaPoint,
  type DisaPointRef,
  type DisaGeneticCode,
  type TPositionMark,
} from '../model/collectGenetics';
import genomeDbJson from '../data/collectGenomes.json';

interface GenomeHit {
  enc: string;
  dp: number;
  /** Life count of the whole position (Position::lives2()/2 -- see stalks/tools/dump_low_life_quick.cpp),
   * not its nimber -- the parent position's nimber isn't meaningful for collection purposes. */
  lives: number;
  /** True iff every one of this DisaPoint's T-move children satisfies the Grandparent Bypass
   * Theorem (see stalks/tools/collect_genetics.cpp's computeAllBypass) -- precomputed offline so
   * the left-hand list can show its own '?' immediately, before fillDetail lazily computes T. */
  allBypass: boolean;
}

const GENOME_DB = genomeDbJson as unknown as Record<string, GenomeHit[]>;

interface TEntry {
  label: string;
  nimber: number;
  bypass: boolean;
  /** Set only when this T-move child is itself a genuine DisaPoint (mark.kind === 'disapoint',
   * the "T" -- not "T'" -- case): `enc` (compressed, matching toDisplayForm's coordinate space)
   * and `dpIndex` (its ordinal in findDisaPoints(parseEncoding(enc))) are what hovering/clicking
   * need to compute its own (L,R,D) genome on demand -- see computeTEntryGenome. */
  enc?: string;
  dpIndex?: number;
  /** Cached result of computeTEntryGenome, so repeat hovers/clicks don't recompute it. */
  genome?: DisaGeneticCode;
}

/** Render one T/T'-move child in canon form (brackets + ⊕). A genuine surviving DisaPoint is
 * marked 'α' in place of its '3' (see markNth); the T' case instead marks the isolated [22]
 * ⊕-summand it decayed into with a trailing '*' -- that's a different, summand-level marker (no
 * digit to swap for 'α' there) -- see TPositionMark. */
function formatTPosition(childEnc: string, mark: TPositionMark): string {
  const parsed = parseEncoding(childEnc);
  const compact = buildDisplayEncoding(parsed, findDisaPoints(parsed));

  if (mark.kind === 'disapoint') return bracketDisplay(markNth(compact, mark.index + 1));

  if (mark.kind === 'isolated') {
    const pieces = bracketDisplay(compact).split(' ⊕ ');
    if (pieces[mark.index] !== undefined) pieces[mark.index] += '*';
    return pieces.join(' ⊕ ');
  }

  return bracketDisplay(compact);
}

interface Entry {
  /** Quick-canon (bracket/⊕) form of the position, with 'α' marking this DisaPoint. Doubles as the
   * dedup key for the variation list. */
  label: string;
  /** Life count of the whole position this variation belongs to (same for every DisaPoint of one
   * search) -- the left-hand list is ordered by this and shows it beside each entry. The parent
   * position's nimber isn't meaningful for collection purposes, unlike its life count. */
  lives: number;
  /** True iff every one of this DisaPoint's T-move children satisfies the Grandparent Bypass
   * Theorem -- i.e. every row in the T section below would show its own '?' (see TEntry.bypass).
   * Known immediately for a genome-loaded entry (GenomeHit.allBypass); computed the moment T is
   * available otherwise (eagerly for a search entry, lazily in fillDetail for a genome/T-row one).
   * Drives the '?' shown next to this entry in the left-hand list. */
  bypass: boolean;
  /** Genome tuple, displayed/ordered L, R, D, T' (T is not part of the genome -- see module header). */
  L: number[];
  R: number | null;
  D: number | null;
  /** T' gene: deduped nimber set from deleting each T'-move child's isolated [22] summand and
   * analyzing what's left (see computeTprimeGeneFromChildren). Braced like L, not a position list. */
  Tprime: number[];
  /** T move list -- every other legal move, shown as a position list (unchanged from before). */
  T: TEntry[];
  /** T' move list (the actual [22]-decay child positions) -- kept for the expand dropdown; the T'
   * TABLE ROW itself now shows the `Tprime` nimber-set gene above, not this list directly. */
  TprimeChildren: TEntry[];
  /** Witnessing child position(s) for each element of L, for L's own expand dropdown -- reuses
   * classifyChildrenByDisaPoint's lChildren rather than recomputing (see computeGeneticCode header
   * note re: L/T' classification). */
  lRows: TEntry[];
  /** Witnessing child position for R (there's at most one R-move), for R's expand dropdown. */
  rRow: TEntry | null;
  /** The hypothetical D (scab-replace) position, for D's expand dropdown. Not a real game-tree
   * child -- built directly by buildReplaceEncoding -- but still openable/hoverable the same way. */
  dRow: TEntry | null;
  /** False for a genome-loaded entry until fillDetail has computed its T/T'/lRows/rRow/dRow rows.
   * Always true for entries built via a normal position search (computeEntry computes eagerly). */
  tComputed: boolean;
  /** Only set on genome-loaded entries -- what fillDetail needs to compute the rest lazily. */
  sourceEnc?: string;
  sourceDpIndex?: number;
}

function isEntry(x: unknown): x is Entry {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.label === 'string' &&
    typeof o.lives === 'number' &&
    typeof o.bypass === 'boolean' &&
    Array.isArray(o.L) &&
    Array.isArray(o.T) &&
    Array.isArray(o.Tprime) &&
    Array.isArray(o.TprimeChildren) &&
    Array.isArray(o.lRows) &&
    typeof o.tComputed === 'boolean'
  );
}

let wired = false;
let status = '';
let statusIsError = false;
let history: Entry[] = [];
let activeLabel: string | null = null;
let searchGen = 0;

// v9: Entry shape changed -- Tprime went from a TEntry[] position list to a number[] gene
// (renamed list is TprimeChildren), plus new lRows/rRow/dRow expand-dropdown fields -- bumped so
// stale v8-format entries don't linger in the list (isEntry would reject them anyway, but the key
// bump also lets old data coexist untouched rather than being silently dropped in place).
// v11: no shape change, but several R/D computation bugs were fixed across the v10 window itself
// (joint-wrap-arc collapse, alpha-mislabeling on witness rows) -- entries cached under v10 may have
// baked in a stale wrong value from before one of those fixes landed, with no other invalidation
// path (existing entries are never recomputed, only reused). Bump forces a clean reseed.
// v13: Entry.nimber (the parent position's nimber) replaced by Entry.lives (its life count) plus a
// new Entry.bypass flag -- isEntry would reject old v12 entries anyway (no `lives`/`bypass` fields),
// bumped for the same "don't silently drop old data in place" reason as v9.
// v14: no shape change, but classifyChildrenByDisaPoint switched from analyze()'s deduped children
// list to allMovesTracked (undeduped) -- a position with a structural automorphism between DisaPoints
// could previously lose real T moves to the dedup (in the worst case, showing T as empty). Entries
// cached under v13 may have baked in that undercount with no other invalidation path (tComputed
// entries are never recomputed). Bump forces a clean reseed against the fixed classification and the
// regenerated collectGenomes.json (same fix applied to the offline genome-DB builder).
const HISTORY_STORAGE_KEY = 'sprouts-collect-variations-v14';

function saveHistory(): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* ignore quota/availability errors */
  }
}

/** Record a variation at the front of history (most-recent-first, deduped by label). */
function addToHistory(entry: Entry): void {
  history = [entry, ...history.filter(h => h.label !== entry.label)];
  saveHistory();
}

function fmtSet(vals: number[]): string {
  return vals.length === 0 ? '{}' : '{' + vals.join(', ') + '}';
}

function fmtNimber(n: number | null): string {
  return n === null ? 'error' : String(n);
}

/** Replace the (1-indexed) nth '3' character in a display string with 'α' -- the chosen
 * DisaPoint standing in for a critical membrane, per the paper's Left/Right-position notation. */
function markNth(display: string, n: number): string {
  let count = 0;
  for (let i = 0; i < display.length; i++) {
    if (display[i] === '3') {
      count++;
      if (count === n) return display.slice(0, i) + 'α' + display.slice(i + 1);
    }
  }
  return display;
}

/** Find which '3' occurrence (0-indexed) raw input marks as the chosen DisaPoint -- either the
 * modern 'α' in place of a '3', or the legacy trailing '*' right after a '3' -- and return the
 * input with that marker normalized back to a plain '3' so the rest of parsing is unaffected.
 * `selected` indexes into findDisaPoints(parseEncoding(stripped)) directly -- NOT into whatever
 * order the engine's own analyze()/canon puts DisaPoints in, which can differ (see runSearch's use
 * of relocateDisaPoint to bridge the two). */
function extractSelection(raw: string): { stripped: string; selected: number | undefined } {
  const alphaIdx = raw.indexOf('α');
  if (alphaIdx !== -1) {
    let count = 0;
    for (let i = 0; i < alphaIdx; i++) if (raw[i] === '3') count++;
    return { stripped: raw.slice(0, alphaIdx) + '3' + raw.slice(alphaIdx + 1), selected: count };
  }
  const starIdx = raw.indexOf('*');
  let selected: number | undefined;
  if (starIdx !== -1) {
    let count = 0;
    for (let i = 0; i < starIdx; i++) if (raw[i] === '3') count++;
    selected = count;
  }
  return { stripped: raw.replace(/\*/g, ''), selected };
}

function sortedDedup(vals: number[]): number[] {
  return [...new Set(vals)].sort((a, b) => a - b);
}

// ---- genome key format: "({l1,...},R,D,{t1,...})", L and T' each sorted ascending and deduped --
// byte-identical to stalks/tools/collect_genetics.cpp's genomeKey, which built
// src/data/collectGenomes.json's keys.

function genomeKey(L: number[], R: number, D: number, Tprime: number[]): string {
  return `({${sortedDedup(L).join(',')}},${R},${D},{${sortedDedup(Tprime).join(',')}})`;
}

function parseNumSet(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const vals = trimmed.split(',').map(s => Number.parseInt(s.trim(), 10));
  return vals.some(n => Number.isNaN(n)) ? null : vals;
}

interface ParsedGenome {
  /** Exact GENOME_DB key when T' was given in the query; null when only (L,R,D) was typed --
   * callers then scan every key sharing that (L,R,D) via findKeysByLRD (see loadGenome), since
   * T' isn't knowable from the query alone in that form. */
  key: string | null;
  L: number[];
  R: number;
  D: number;
  Tprime: number[] | null;
}

/** Accepts the modern 4-tuple "({L},R,D,{T'})" and, for backward compatibility, the legacy
 * 3-tuple "({L},R,D)" (T' unspecified -- see ParsedGenome.key). */
function parseGenomeQuery(input: string): ParsedGenome | null {
  const m4 = /^\(\{([0-9,\s]*)\}\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*\{([0-9,\s]*)\}\s*\)$/.exec(input);
  if (m4) {
    const L = parseNumSet(m4[1]);
    const Tprime = parseNumSet(m4[4]);
    if (L === null || Tprime === null) return null;
    const R = Number.parseInt(m4[2], 10);
    const D = Number.parseInt(m4[3], 10);
    return { key: genomeKey(L, R, D, Tprime), L: sortedDedup(L), R, D, Tprime: sortedDedup(Tprime) };
  }
  const m3 = /^\(\{([0-9,\s]*)\}\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(input);
  if (m3) {
    const L = parseNumSet(m3[1]);
    if (L === null) return null;
    const R = Number.parseInt(m3[2], 10);
    const D = Number.parseInt(m3[3], 10);
    return { key: null, L: sortedDedup(L), R, D, Tprime: null };
  }
  return null;
}

/** Every GENOME_DB key sharing this exact (L,R,D), regardless of T' -- used whenever T' isn't
 * pinned down (legacy 3-tuple queries, and seedDefaultHistory's own (L,R,D)-only defaults). Each
 * bucket found gets its own T' attributed to its hits (buildGenomeEntry). */
function findKeysByLRD(L: number[], R: number, D: number): { key: string; Tprime: number[] }[] {
  const prefix = `({${sortedDedup(L).join(',')}},${R},${D},{`;
  const out: { key: string; Tprime: number[] }[] = [];
  for (const key of Object.keys(GENOME_DB)) {
    if (!key.startsWith(prefix)) continue;
    const inner = key.slice(prefix.length, key.length - 2); // strip trailing "})"
    const Tprime = inner.length === 0 ? [] : inner.split(',').map(s => Number.parseInt(s, 10));
    out.push({ key, Tprime });
  }
  return out;
}

/** Build a (rows-pending) Entry directly from a GENOME_DB hit -- no analyze() call needed for
 * L/R/D/T', since `hit.enc` is already the decompressed canonical text and the genome is implied
 * by the bucket. The row/expand-dropdown data (T, T' children, lRows, rRow, dRow) is still lazy. */
function buildGenomeEntry(hit: GenomeHit, L: number[], R: number, D: number, Tprime: number[]): Entry {
  const parsed = parseEncoding(hit.enc);
  const disaPoints = findDisaPoints(parsed);
  const display = buildDisplayEncoding(parsed, disaPoints);
  return {
    label: bracketDisplay(markNth(display, hit.dp + 1)),
    lives: hit.lives,
    bypass: hit.allBypass,
    L,
    R,
    D,
    Tprime,
    T: [],
    TprimeChildren: [],
    lRows: [],
    rRow: null,
    dRow: null,
    tComputed: false,
    sourceEnc: hit.enc,
    sourceDpIndex: hit.dp,
  };
}

/** Render one "witness" child position as a TEntry-shaped row -- shared plumbing for L/R/D/T/T's
 * expand dropdowns (see renderTCell). `enc`/`dpIndex` (needed for hover/click-to-open) are set
 * whenever the position still contains ANY DisaPoint -- since this doesn't do T's own
 * tracked-provenance retrace, it opens the FIRST DisaPoint found; good enough for "browse a
 * witnessing position" without claiming index-exact target identity.
 *
 * `markAsTarget` controls whether that first DisaPoint (if any) gets 'α'-marked in the label as if
 * it were the DisaPoint this whole detail view is about. Only genuine T rows (via `analyzeTEntry`'s
 * tracked-provenance retrace) get to claim that -- L, R, and D all leave `buildWitnessRow` at
 * `false`: any DisaPoint present in their result is some OTHER, unrelated one that just happens to
 * live elsewhere in the position (L doesn't specially preserve `target`'s own identity either --
 * that was a wrong assumption in an earlier pass of this code), and marking it 'α' would
 * misleadingly claim it's the tracked point. It renders as an ordinary '3' instead. */
function buildWitnessRow(enc: string, nimber: number, markAsTarget: boolean): TEntry {
  const parsed = parseEncoding(enc);
  const disaPoints = findDisaPoints(parsed);
  const compact = buildDisplayEncoding(parsed, disaPoints);
  const label = bracketDisplay(disaPoints.length > 0 && markAsTarget ? markNth(compact, 1) : compact);
  return {
    label,
    nimber,
    bypass: false,
    ...(disaPoints.length > 0 ? { enc, dpIndex: 0 } : {}),
  };
}

interface RowsAndGenes {
  T: TEntry[];
  TprimeChildren: TEntry[];
  Tprime: number[];
  lRows: TEntry[];
  rRow: TEntry | null;
}

/** Everything move-classification-derived, shared by the eager (computeEntry) and lazy
 * (fillDetail) paths: T/T' row lists, the T' gene (computeTprimeGeneFromChildren), and L/R's
 * witnessing-position rows (reusing classifyChildrenByDisaPoint's lChildren/rChild rather than
 * recomputing -- see that function's doc comment). T' gene is computed BEFORE the T rows so the
 * (L,R,D,T') rootCode passed into analyzeTEntry's Grandparent Bypass check is complete. */
async function computeRowsAndGenes(
  canonText: string,
  dp: DisaPointRef,
  L: number[],
  R: number | null,
  D: number | null,
  rCanon: string | null,
): Promise<RowsAndGenes> {
  const { lChildren, rChild, tChildren } = await classifyChildrenByDisaPoint(canonText, dp, rCanon);
  const Tprime = await computeTprimeGeneFromChildren(canonText, tChildren, dp);
  const rootCode: DisaGeneticCode = { L, R, D, Tprime };

  // T/T' row lists: every classified child, shown as-is (the quick-canon dedup attempt tried here
  // previously was rolled back -- it mismatched DisaPoint identity across representatives and
  // produced garbled/incorrectly-collapsed labels, e.g. showing an uncompacted detached pair
  // instead of the proper compact form; see git history for the full attempt and why it was reverted).
  const classifiedT = await Promise.all(
    tChildren.map(async tChild => {
      const { enc, mark, bypass } = await analyzeTEntry(canonText, dp, tChild, rootCode);
      const display = await toDisplayForm(enc, mark);
      const entry: TEntry = {
        label: formatTPosition(display.enc, display.mark),
        nimber: tChild.nimber,
        bypass,
        ...(display.mark.kind === 'disapoint' ? { enc: display.enc, dpIndex: display.mark.index } : {}),
      };
      return { mark, entry };
    }),
  );

  const lRows = lChildren.map(lc => buildWitnessRow(lc.enc, lc.nimber, false));
  // rChild only ever comes back non-null in the rare coincidence where some genuine OTHER move of
  // the position happens to land on the same canonical result as R -- see ClassifiedChildren's doc
  // comment in collectGenetics.ts for why R is structurally never a member of `children` in general.
  // The normal case builds the witness row directly from rCanon/R, exactly like D's dRow below.
  const rRow = rChild
    ? buildWitnessRow(rChild.enc, rChild.nimber, false)
    : rCanon !== null && R !== null
      ? buildWitnessRow(rCanon, R, false)
      : null;

  return {
    T: classifiedT.filter(c => c.mark.kind !== 'isolated').map(c => c.entry),
    TprimeChildren: classifiedT.filter(c => c.mark.kind === 'isolated').map(c => c.entry),
    Tprime,
    lRows,
    rRow,
  };
}

/** (L,R,D,T') genome of a "T" entry's own surviving DisaPoint, computed on first hover/click and
 * cached on the TEntry itself. Returns null for entries that aren't a genuine DisaPoint (T' rows,
 * and T rows where the tracked point didn't survive at all -- see TEntry's enc/dpIndex doc). */
async function computeTEntryGenome(t: TEntry): Promise<DisaGeneticCode | null> {
  if (t.genome) return t.genome;
  if (t.enc === undefined || t.dpIndex === undefined) return null;
  const dp = findDisaPoints(parseEncoding(t.enc))[t.dpIndex];
  if (!dp) return null;
  const genome = await computeGeneticCode(t.enc, dp);
  t.genome = genome;
  return genome;
}

/** Build a (rows-pending) Entry from a T-row's own genome, mirroring buildGenomeEntry -- same
 * lazy shape, just sourced from a T-move child instead of a GENOME_DB hit. `t.enc` is always set
 * here (selectTEntry only reaches this once that's confirmed) -- used to compute this position's
 * own life count, since a TEntry only carries its nimber. `bypass` isn't known yet (T isn't
 * computed for a fresh lazy entry); fillDetail fills it in once T is actually available. */
function buildEntryFromTEntry(t: TEntry, genome: DisaGeneticCode): Entry {
  const parsed = parseEncoding(t.enc ?? '');
  const lives = countLives(parsed, findDisaPoints(parsed));
  return {
    label: t.label,
    lives,
    bypass: false,
    L: genome.L,
    R: genome.R,
    D: genome.D,
    Tprime: genome.Tprime,
    T: [],
    TprimeChildren: [],
    lRows: [],
    rRow: null,
    dRow: null,
    tComputed: false,
    sourceEnc: t.enc,
    sourceDpIndex: t.dpIndex,
  };
}

/** Clicking a "T" row: reuse the existing history entry if this position's already in the list
 * (keeping any T/T' it already computed), otherwise add a fresh lazy entry for it. Either way it
 * becomes the active (open) entry so its full genome is visible. */
async function selectTEntry(t: TEntry): Promise<void> {
  const existing = history.find(h => h.label === t.label);
  if (existing) {
    addToHistory(existing);
    activeLabel = existing.label;
    render();
    return;
  }
  const genome = await computeTEntryGenome(t);
  if (!genome) return;
  addToHistory(buildEntryFromTEntry(t, genome));
  activeLabel = t.label;
  render();
}

/** Full genetic-code entry for one DisaPoint of an already-analyzed position (the manual-search path). */
async function computeEntry(
  canonText: string,
  lives: number,
  dp: DisaPointRef,
  idx: number,
  display: string,
): Promise<Entry> {
  const parsed = parseEncoding(canonText);
  const L = await lMoveNimbersRobust(canonText, dp);
  const dEnc = buildReplaceEncoding(parsed, dp);
  const [rEnc, dRes] = await Promise.all([computeR(parsed, dp), analyze(dEnc)]);
  const rRes = rEnc !== null ? await analyze(rEnc) : null;
  const R = rRes && rRes.ok ? rRes.nimber : null;
  const D = dRes.ok ? dRes.nimber : null;

  const { T, TprimeChildren, Tprime, lRows, rRow } = await computeRowsAndGenes(canonText, dp, L, R, D, rEnc);
  const dRow = dRes.ok ? buildWitnessRow(dEnc, dRes.nimber, false) : null;
  const bypass = T.length > 0 && T.every(t => t.bypass);

  return {
    label: bracketDisplay(markNth(display, idx + 1)),
    lives,
    bypass,
    L,
    R,
    D,
    Tprime,
    T,
    TprimeChildren,
    lRows,
    rRow,
    dRow,
    tComputed: true,
  };
}

/** Lazily fill in the row/expand-dropdown data for a genome-loaded entry the first time it's
 * actually viewed. Mutates `entry` in place and persists the result so it's only ever computed
 * once. L/R/D/T' (the genome itself) are already known from the GENOME_DB bucket; this only fills
 * T, T's own witnessing children, and the L/R/D expand rows. */
async function fillDetail(entry: Entry): Promise<void> {
  if (entry.tComputed || entry.sourceEnc === undefined || entry.sourceDpIndex === undefined) return;

  const result = await analyze(entry.sourceEnc);
  if (!result.ok) {
    entry.tComputed = true;
    return;
  }
  // entry.sourceDpIndex is an ordinal into findDisaPoints(parseEncoding(entry.sourceEnc)) -- NOT
  // necessarily into findDisaPoints(parseEncoding(result.canon)). analyze() re-canonicalizes, which
  // can reorder regions differently than however sourceEnc's own text happened to be ordered (it
  // may come straight from GENOME_DB, whose C++ builder never ran it through the live engine's own
  // canon()). Looking the index up directly against the fresh canon's disaPoints list silently
  // picked the WRONG DisaPoint whenever that reordering happened -- see relocateDisaPoint.
  const sourceParsed = parseEncoding(entry.sourceEnc);
  const sourceDp = findDisaPoints(sourceParsed)[entry.sourceDpIndex];
  const parsed = parseEncoding(result.canon);
  const dp = sourceDp ? await relocateDisaPoint(sourceParsed, sourceDp, result.canon) : null;
  if (!dp) {
    entry.tComputed = true;
    return;
  }

  const dEnc = buildReplaceEncoding(parsed, dp);
  const rEnc = await computeR(parsed, dp);
  const { T, TprimeChildren, lRows, rRow } = await computeRowsAndGenes(result.canon, dp, entry.L, entry.R, entry.D, rEnc);

  entry.T = T;
  entry.TprimeChildren = TprimeChildren;
  entry.lRows = lRows;
  entry.rRow = rRow;
  entry.dRow = entry.D !== null ? buildWitnessRow(dEnc, entry.D, false) : null;
  // Refine the precomputed (or T-row-added, always-false) bypass marker now that T is actually
  // known -- self-correcting against the offline data file, same condition computeEntry uses.
  entry.bypass = T.length > 0 && T.every(t => t.bypass);
  entry.tComputed = true;
  saveHistory();
}

/** Populate the persistent variation list with every position matching the ({0},1,1) and
 * ({1},0,0) (L,R,D) genomes from GENOME_DB (any T'), as sensible defaults to browse before any
 * search has run. */
function seedDefaultHistory(): void {
  const seen = new Set<string>();
  const seeded: Entry[] = [];
  const defaults: { L: number[]; R: number; D: number }[] = [
    { L: [0], R: 1, D: 1 },
    { L: [1], R: 0, D: 0 },
  ];
  for (const { L, R, D } of defaults) {
    for (const { key, Tprime } of findKeysByLRD(L, R, D)) {
      const hits = GENOME_DB[key] ?? [];
      for (const hit of hits) {
        const entry = buildGenomeEntry(hit, L, R, D, Tprime);
        if (seen.has(entry.label)) continue;
        seen.add(entry.label);
        seeded.push(entry);
      }
    }
  }
  history = seeded;
  saveHistory();
}

function loadHistory(): void {
  try {
    const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.every(isEntry)) {
        history = parsed;
        return;
      }
    }
  } catch {
    /* fall through to seeding */
  }
  seedDefaultHistory();
}

/** Look up a genome query and load every matching <=7-life position into history. Accepts either
 * the full 4-tuple ({L},R,D,{T'}) (exact GENOME_DB key) or the legacy 3-tuple ({L},R,D), which
 * matches every T' bucket sharing that (L,R,D) -- see findKeysByLRD. */
function loadGenome(raw: string): void {
  const parsedGenome = parseGenomeQuery(raw);
  if (!parsedGenome) {
    status = `Couldn't parse that genome — expected a form like ({0,1},2,3,{0}).`;
    statusIsError = true;
    render();
    return;
  }

  const buckets =
    parsedGenome.key !== null && parsedGenome.Tprime !== null
      ? [{ key: parsedGenome.key, Tprime: parsedGenome.Tprime }]
      : findKeysByLRD(parsedGenome.L, parsedGenome.R, parsedGenome.D);

  const entries: Entry[] = [];
  for (const { key, Tprime } of buckets) {
    const hits = GENOME_DB[key];
    if (!hits) continue;
    for (const hit of hits) entries.push(buildGenomeEntry(hit, parsedGenome.L, parsedGenome.R, parsedGenome.D, Tprime));
  }

  if (entries.length === 0) {
    status = `No positions with genome ({${parsedGenome.L.join(',')}},${parsedGenome.R},${parsedGenome.D}) found (8 or fewer lives).`;
    statusIsError = true;
    render();
    return;
  }

  // A genome search replaces the list rather than appending to it, so it's always clear that
  // every entry on screen shares this exact genome (anything looked at afterward re-appends normally).
  history = [];
  for (let i = entries.length - 1; i >= 0; i--) addToHistory(entries[i]);
  activeLabel = entries[0].label;
  status = '';
  statusIsError = false;
  render();
}

async function runSearch(raw: string): Promise<void> {
  const myGen = ++searchGen;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    status = '';
    statusIsError = false;
    render();
    return;
  }

  status = 'Searching…';
  statusIsError = false;
  render();

  const { stripped, selected } = extractSelection(trimmed);
  // `stripped`'s own '3' tokens are still raw (undecompressed) life-count digits at this point --
  // they only become real DisaPoint structure (a membrane letter + its own detached "2X" pair
  // region) once decompressed, so findDisaPoints on `stripped` directly always returns []. Decompress
  // first: decompress() is a pure function of its input, so this reproduces the exact same expansion
  // (same left-to-right token order, so the Nth '3' in `stripped` is still the Nth DisaPoint found
  // here) that analyze() performs internally when it builds `result.canon` below -- letting
  // relocateDisaPoint bridge the two coordinate spaces afterward.
  const strippedDecompRes = await decompress(stripped);
  const strippedDisaPoints = strippedDecompRes.ok ? findDisaPoints(parseEncoding(strippedDecompRes.enc)) : [];
  const selectedIdx = Math.min(Math.max(selected ?? 0, 0), Math.max(strippedDisaPoints.length - 1, 0));
  const selectedTarget = strippedDisaPoints[selectedIdx];
  const result = await analyze(stripped);
  if (myGen !== searchGen) return;

  if (!result.ok) {
    status = result.message ?? `Couldn't parse that encoding (${result.reason}).`;
    statusIsError = true;
    render();
    return;
  }

  const parsed = parseEncoding(result.canon);
  const disaPoints = findDisaPoints(parsed);
  if (disaPoints.length === 0) {
    status = 'No DisaPoints found in this position.';
    statusIsError = true;
    render();
    return;
  }

  const lives = countLives(parsed, disaPoints);
  if (lives > 8) {
    status = `This position has ${lives} lives — only 8 or fewer are supported for now.`;
    statusIsError = true;
    render();
    return;
  }

  const display = buildDisplayEncoding(parsed, disaPoints);

  const computed = await Promise.all(disaPoints.map((dp, idx) => computeEntry(result.canon, lives, dp, idx, display)));
  if (myGen !== searchGen) return;

  for (let i = computed.length - 1; i >= 0; i--) addToHistory(computed[i]);
  // Which DisaPoint the user actually marked (selectedTarget, found in `stripped`'s OWN decompressed
  // coordinate space) must be relocated into disaPoints -- analyze()'s canon can reorder regions
  // differently than that decompression did, so a raw ordinal index doesn't reliably survive
  // canonicalization (see relocateDisaPoint's doc comment; this used to also carry an off-by-one
  // against extractSelection's 0-indexed `selected`, on top of the reordering issue).
  let pickIdx = 0;
  if (selectedTarget && strippedDecompRes.ok) {
    const relocated = await relocateDisaPoint(parseEncoding(strippedDecompRes.enc), selectedTarget, result.canon);
    if (relocated) {
      const found = disaPoints.findIndex(
        d => d.component === relocated.component && d.region === relocated.region && d.boundary === relocated.boundary && d.token === relocated.token,
      );
      if (found >= 0) pickIdx = found;
    }
  }
  const pick = computed[pickIdx];
  activeLabel = pick.label;
  status = '';
  render();
}

function fmtGenome(g: DisaGeneticCode): string {
  return `L=${fmtSet(g.L)}  R=${fmtNimber(g.R)}  D=${fmtNimber(g.D)}  T'=${fmtSet(g.Tprime)}`;
}

/** Bumped on every hide/re-show so a genome fetch that resolves after the pointer has moved on
 * doesn't overwrite a newer (or absent) tooltip. */
let tooltipGen = 0;

function hideTTooltip(): void {
  tooltipGen++;
  const tip = document.getElementById('collect-t-tooltip');
  if (tip) tip.classList.remove('visible');
}

function showTTooltip(row: HTMLElement, t: TEntry): void {
  const myGen = ++tooltipGen;
  const tip = document.getElementById('collect-t-tooltip');
  const dialog = document.getElementById('collect-dialog');
  if (!tip || !dialog) return;

  const rowRect = row.getBoundingClientRect();
  const dialogRect = dialog.getBoundingClientRect();
  tip.style.left = `${rowRect.left - dialogRect.left}px`;
  tip.style.top = `${rowRect.bottom - dialogRect.top + 4}px`;
  tip.textContent = t.genome ? fmtGenome(t.genome) : 'computing…';
  tip.classList.add('visible');

  if (!t.genome) {
    void computeTEntryGenome(t).then(genome => {
      if (myGen !== tooltipGen || !genome) return;
      tip.textContent = fmtGenome(genome);
    });
  }
}

/** Render one T/T' cell's rows as real DOM nodes (not an HTML string) so entries whose tracked
 * point is still a genuine DisaPoint (enc/dpIndex set -- see TEntry) can be hovered for their own
 * (L,R,D) genome and clicked to open/add them as a variation in their own right. */
function renderTCell(container: HTMLElement, list: TEntry[]): void {
  container.innerHTML = '';
  if (list.length === 0) {
    container.textContent = '(none)';
    return;
  }
  for (const t of list) {
    const row = document.createElement('div');
    row.className = 'collect-t-row';

    const label = document.createElement('span');
    label.className = 'collect-t-label';
    label.innerHTML = t.label + (t.bypass ? ' <span class="collect-bypass">?</span>' : '');

    const nimber = document.createElement('span');
    nimber.className = 'collect-t-nimber';
    nimber.textContent = String(t.nimber);

    row.appendChild(label);
    row.appendChild(nimber);

    if (t.enc !== undefined && t.dpIndex !== undefined) {
      row.classList.add('collect-t-clickable');
      row.addEventListener('mouseenter', () => showTTooltip(row, t));
      row.addEventListener('mouseleave', hideTTooltip);
      row.addEventListener('click', () => void selectTEntry(t));
    }

    container.appendChild(row);
  }
}

function renderDetail(): void {
  const detailEl = document.getElementById('collect-detail') as HTMLDivElement;
  const entry = history.find(h => h.label === activeLabel) ?? null;
  if (!entry) {
    detailEl.innerHTML =
      '<div class="collect-empty">Type a position encoding above and press Enter to search — mark a specific DisaPoint as α (e.g. 23A|Aα,13738) — or type a genome like ({0},1,1) to load every matching position.</div>';
    return;
  }

  if (!entry.tComputed) {
    void fillDetail(entry).then(() => {
      if (activeLabel === entry.label) renderDetail();
    });
  }

  // L/R/D/T' are known immediately for both search-computed and genome-loaded entries (the genome
  // IS L,R,D,T' -- see buildGenomeEntry); only their witnessing-position expand rows (and T/T'
  // children) are lazy for a genome-loaded entry, hence the separate "computing…" only on the
  // dropdown rows below, not the gene summaries themselves.
  const pending = entry.tComputed ? '' : '<span class="collect-t-pending">computing…</span>';

  detailEl.innerHTML = `
    <div class="collect-detail-enc">${entry.label}</div>
    <table class="collect-code-table">
      <tr><th>Move</th><th>Genome / witnessing positions</th></tr>
      <tr><td>L</td><td class="collect-t-cell"><div class="nimset">${fmtSet(entry.L)}</div><div id="collect-l-rows">${pending}</div></td></tr>
      <tr><td>R</td><td class="collect-t-cell"><div class="nimset">${fmtNimber(entry.R)}</div><div id="collect-r-rows">${pending}</div></td></tr>
      <tr><td>D</td><td class="collect-t-cell"><div class="nimset">${fmtNimber(entry.D)}</div><div id="collect-d-rows">${pending}</div></td></tr>
      <tr><td>T'</td><td class="collect-t-cell"><div class="nimset">${fmtSet(entry.Tprime)}</div><div id="collect-tprime-rows">${pending}</div></td></tr>
      <tr><td>T</td><td class="collect-t-cell" id="collect-t-cell">${pending}</td></tr>
    </table>
  `;

  if (entry.tComputed) {
    const lEl = document.getElementById('collect-l-rows');
    const rEl = document.getElementById('collect-r-rows');
    const dEl = document.getElementById('collect-d-rows');
    const tpEl = document.getElementById('collect-tprime-rows');
    const tEl = document.getElementById('collect-t-cell');
    if (lEl) renderTCell(lEl, entry.lRows);
    if (rEl) renderTCell(rEl, entry.rRow ? [entry.rRow] : []);
    if (dEl) renderTCell(dEl, entry.dRow ? [entry.dRow] : []);
    if (tpEl) renderTCell(tpEl, entry.TprimeChildren);
    if (tEl) renderTCell(tEl, entry.T);
  }
}

function render(): void {
  const listEl = document.getElementById('collect-list') as HTMLDivElement;
  const statusEl = document.getElementById('collect-status') as HTMLDivElement;

  // Any full re-render invalidates the row a shown tooltip is anchored to.
  hideTTooltip();

  statusEl.textContent = status;
  statusEl.classList.toggle('error', statusIsError);

  listEl.innerHTML = '';
  // Ordered by life count ascending, not insertion order -- see the module header.
  const ordered = [...history].sort((a, b) => a.lives - b.lives);
  ordered.forEach(entry => {
    const btn = document.createElement('button');
    btn.className = 'collect-entry' + (entry.label === activeLabel ? ' active' : '');
    btn.innerHTML =
      `<span class="collect-entry-label">${entry.label}${entry.bypass ? ' <span class="collect-bypass">?</span>' : ''}</span>` +
      `<span class="collect-entry-nimber">${entry.lives}</span>`;
    btn.addEventListener('click', () => {
      activeLabel = entry.label;
      render();
    });
    listEl.appendChild(btn);
  });

  renderDetail();
}

/** Wire the search input once; safe to call multiple times (each open just re-renders). */
export function initCollect(): void {
  if (wired) { render(); return; }
  wired = true;
  loadHistory();

  const input = document.getElementById('collect-search-input') as HTMLInputElement;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = input.value.trim();
      if (trimmed.startsWith('(')) {
        loadGenome(trimmed);
      } else {
        void runSearch(input.value);
      }
    }
  });

  render();
}
