/**
 * Collect: type a position encoding containing exactly one alpha ('a') token to see its genome --
 * (R, D, {L}, {T'}, [T]) -- computed directly from the engine's own movetype classification (see
 * src/model/collectAlpha.ts). R and D are single nimbers (the "vanish"/"become a scab" moves,
 * movetypes 1/2); {L} and {T'} are deduped nimber sets (moves that connect within the position, or
 * isolate-and-decay it, movetypes 3/4); [T] is the list of positions reached by every move that
 * leaves alpha untouched (movetype 5), each shown in canon (bracket/⊕) form and clickable to open
 * as its own entry.
 *
 * The detail view's own T-gene table (renderTList) always shows two columns -- Position and Genome
 * -- plus a third, Bypass, that appears only once the search bar's own query resolves to a named
 * genome (see searchedGenomeName). Genome is a T-child's own genome: the named genome outright if
 * its full nested genome folds to one (see isNamedGenome), else its bare four genes with its own
 * T-gene members individually name-folded or shown as a bare '+' placeholder -- never fully
 * expanded, that's what the header/detail area's own genome string is for (see formatGenomeCell).
 * Bypass lists the DISTINCT genome names (not positions -- see BypassMatch) among a row's OWN T-gene
 * members that EXACTLY match the searched genome, offset included -- e.g. searching S_1⊕2 and
 * finding another S_1⊕2 inside some T-child X's own T-gene shows a bypass straight through X (see
 * findBypassMatches) -- the manual verification step this was built for; the point is only to know
 * such a bypass exists, so repeat witnesses of the same name are deduped down to one. Critically,
 * this is an EXACT match, not "any shift of the same base family" -- S_1, S_1⊕1, and S_1⊕2 are
 * genuinely distinct genomes, so a T-gene member folding to S_1 is never a bypass for a search of
 * S_1⊕2, only one folding to S_1⊕2 itself is.
 *
 * Every displayed position (the active entry itself, and each T-child) is shown in its
 * quick-canon (Advanced Collections) form -- more compact than the raw structural encoding, same
 * convention Position Browser's own Quick-Canon toggle uses (⊕1 suffix when the nimber offset is
 * 1). The quick-canon rep is display-only, never the identity used to re-derive a genome (clicking
 * a T row re-analyzes its real encoding, not its quick-canon stand-in) -- see collectAlpha.ts's
 * PositionRef doc comment for why.
 *
 * Typing a genome instead of a position -- "(R,D,{L},{T'})", e.g. "(0,1,{0},{})", OR the newer
 * 5-value form with an explicit (but unparsed/ignored -- see collectAlpha.ts's GENOME_QUERY_RE)
 * [T] portion, e.g. "(0,1,{0},{},[])" -- looks it up in GENOME_DB (see
 * src/data/collectAlphaGenomes.json, built by stalks/tools/collect_alpha_genetics.cpp from the
 * .spec save files) and loads every matching single-alpha position into the list on the left; no
 * engine call needed since the genome (and each T-child, quick-canon form included) is already
 * known from the data file. Named shorthands (S_1, S_2, ...; see collectAlpha.ts's
 * GENOME_SHORTHANDS) expand to their full genome-query text before this lookup.
 *
 * Restricted, for now, to positions with exactly one alpha and no other special-point symbol -- see
 * collectAlpha.ts's isSingleAlpha.
 */

import { display as bracketDisplay } from './positionBrowser';
import {
  type AlphaGenome,
  type FourGeneGenome,
  type NamedFamily,
  type NamedFamilyGroup,
  type PositionRef,
  type ResolveChild,
  type TChild,
  type TChildClassification,
  COLLECTION_ROSTER_FOLDER_NAMES,
  GENOME_NAMES,
  KNOWN_COLLECTION_MEMBERS,
  NAMED_FAMILIES,
  NAMED_FAMILY_GENOME_TEXT,
  NAMED_FAMILY_GROUPS,
  bypassOnlyFoldName,
  classifyTChildren,
  computeAlphaGenome,
  expandGenomeShorthand,
  familyForCore,
  fmtNimber,
  genomeKey,
  isFullGenome,
  nameForShorthand,
  parseGenomeQuery,
  resolvedFoldName,
  shiftMembraneLetters,
} from '../model/collectAlpha';
import genomeDbJson from '../data/collectAlphaGenomes.json';

interface GenomeHit extends PositionRef {
  lives: number;
  T: (PositionRef & { nimber: number })[];
}

/** A single-alpha position's own (R,D,{L},{T'},[T]) as computed offline by
 * stalks/tools/collect_alpha_genetics.cpp -- one entry per position, keyed by its real (non-quick-
 * canon) encoding. Used purely as a fast local lookup (see collect.ts's byEncGenome) so
 * resolvedGenomeName/foldedPlainOfTChild never need a fresh engine call for any position already
 * covered by this data file -- see the module doc comment on GENOME_DB below for why this exists as
 * a SEPARATE section from the genome-bucket data rather than embedded per-T-child. */
interface ByEncHit {
  R: number;
  D: number;
  L: number[];
  Tprime: number[];
  lives: number;
  T: (PositionRef & { nimber: number })[];
}

/** Offline-computed genome data (see stalks/tools/collect_alpha_genetics.cpp) for single-alpha
 * positions reachable from the game's early boards. `genomes` buckets positions by their (R,D,{L},
 * {T'}) tuple -- what typing a genome/shorthand into the search bar looks up (see loadGenome).
 * `byEnc` is the SAME underlying position set, flat-indexed by real encoding instead -- a pure
 * local-lookup fast path for resolvedGenomeName/foldedPlainOfTChild so a position's own genome
 * (and its T-children') doesn't need a fresh engine call whenever it's already covered by this
 * file. (An earlier version tried embedding each T-child's
 * own genome data recursively INLINE inside `genomes` instead of as a separate flat section --
 * with heavy fan-in among common low-order T-children that blew the file up ~1000x, since the same
 * T-child's data got duplicated everywhere it was referenced; `byEnc` avoids that by storing each
 * position's data exactly once.) Both sections cover the SAME position set (the C++ tool's own
 * `_1spot`/`_2spot` .spec inputs -- deliberately NOT the full multi-hundred-MB `.spec` file, which
 * would blow the position count from ~1000 to ~264000 and the file size well past what's
 * reasonable to bundle); a T-child outside that set falls back to computeAlphaGenome as before. */
interface GenomeDbJson {
  genomes: Record<string, GenomeHit[]>;
  byEnc: Record<string, ByEncHit>;
}

const GENOME_DB_FILE = genomeDbJson as unknown as GenomeDbJson;
const GENOME_DB = GENOME_DB_FILE.genomes;
const BY_ENC = GENOME_DB_FILE.byEnc;

interface Entry {
  /** Quick-canon bracket-displayed form, with alpha shown as 'α' and a '⊕ 1' suffix when the
   * position's quickOffset is 1. Doubles as the dedup key. */
  label: string;
  position: PositionRef;
  /** Life count, when known (genome-DB-loaded entries only -- see GenomeHit.lives). */
  lives: number | null;
  genome: AlphaGenome;
  /** False for GENOME_DB-loaded entries (see buildGenomeEntry): the DB predates quick-canon-split
   * handling (oplus) and nested [T] genomes, so its stored genome is stale relative to what a fresh
   * computeAlphaGenome() call would produce. selectEntry() recomputes it in place the first time
   * such an entry is actually selected -- eagerly recomputing for the WHOLE list (which can be 70+
   * entries for a common genome) would be needlessly expensive when only one is being looked at. */
  genomeFresh: boolean;
}

let wired = false;
let status = '';
let statusIsError = false;
let history: Entry[] = [];
let activeLabel: string | null = null;
let searchGen = 0;
/** The name (e.g. "S_1⊕1"), OFFSET INCLUDED, the search bar's own query resolved to, when it did --
 * set by loadGenome, cleared by runSearch -- since only a genome/shorthand search at the top
 * ("searched a named genome", per the user's own phrasing) is meaningful for the T-gene table's
 * Bypass column; a plain position search isn't, even if that position happens to itself be named.
 * What findBypassMatches tests each T-gene member against directly (see its own doc comment for why
 * this must be an exact match, not any shift of the same base family) -- also the header title, and
 * the empty-vs-shown decision for the Bypass column. */
let searchedGenomeName: string | null = null;
/** Quick-Genome toggle: when on, a genome-string node whose exact plain-text tuple matches a
 * known GENOME_SHORTHANDS entry (see GENOME_NAMES) is folded down to its name, at any nesting
 * depth. Defaults on (checkbox in index.html is checked by default). */
let quickGenome = true;

// v2->v3 2026-08-27: computeAlphaGenomeAt reworked (away-component moves now enumerated as real
// T-children, oplus folded directly into R/D/L/T' instead of a display suffix) -- old cached
// genomes for any split T-child are stale/wrong-shaped.
const HISTORY_STORAGE_KEY = 'sprouts-collect-alpha-v3';

/** Coalesces render() calls triggered by async completions (lookupGenome resolving) --
 * NOT for direct user-triggered calls (search, toggle, select), which still call render()
 * immediately. Without this, a genome search with N hits whose classification isn't cached yet
 * (e.g. S_1's 1000+-entry bucket) fires up to N separate completions, EACH doing a full history-
 * list DOM rebuild (render() calls innerHTML='' + rebuilds every row) -- O(N^2) DOM work that hangs
 * the tab. A plain microtask (queueMicrotask) under-batches here: each completion is itself the
 * end of its own await chain, so consecutive completions land in different microtask turns, not
 * the same one. A macrotask (setTimeout 0) waits for the CURRENT burst of already-settled promise
 * callbacks to fully drain first, coalescing far more of them into each render. Deliberately NOT
 * requestAnimationFrame -- rAF never fires in an off-screen/non-compositing tab (see
 * reference_browser_preview_verification memory), which would hang this exact code path during
 * headless verification even though it'd work fine in a real, visible browser window. */
let renderScheduled = false;
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    render();
  }, 0);
}

function saveHistory(): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* ignore quota/availability errors */
  }
}

function isEntry(x: unknown): x is Entry {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.label !== 'string') return false;
  if (o.lives !== null && typeof o.lives !== 'number') return false;
  const p = o.position as Record<string, unknown> | undefined;
  if (!p || typeof p.enc !== 'string' || typeof p.quickEnc !== 'string') return false;
  const g = o.genome as Record<string, unknown> | undefined;
  return !!g && Array.isArray(g.L) && Array.isArray(g.Tprime) && Array.isArray(g.T);
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
    /* fall through to empty */
  }
  history = [];
}

/** Record a variation at the front of history (most-recent-first, deduped by label). `persist`
 * false skips the localStorage write -- for loadGenome's bulk-load loop, which would otherwise
 * call saveHistory() (a full JSON.stringify + localStorage.setItem of the WHOLE list) once per
 * hit, making an N-hit genome load O(N^2) -- fine at the old ~150-hit scale, but genuinely hangs
 * the tab now that a bucket can have 1000+ hits (confirmed: S_1 went 138->1439 after adding the
 * 3-spot .spec source). Callers doing a single add still default to persist=true. */
function addToHistory(entry: Entry, persist = true): void {
  history = [entry, ...history.filter(h => h.label !== entry.label)];
  if (persist) saveHistory();
}

/** Exported (2026-09-03) so ttree.ts can build the same "paper display" node labels Collect uses,
 * without re-deriving this convention a second time. */
export function markAlpha(enc: string): string {
  return enc.replace('a', 'α');
}

/** positionBrowser's own bracketDisplay ("[...]" per '+'-separated component), except any
 * component that still contains an alpha marker ('α', post-markAlpha) closes with '/' instead of
 * ']' -- matching stalks/src/collections.hpp's own left-side notation ("the text between '[' and
 * '/'"): the alpha-marked point stands in as the open crit this whole feature classifies movetypes
 * relative to, so it's a "left side" in the paper's sense even when it's also a complete, playable
 * position. A component with no alpha left in it (e.g. an R/D child where THAT move vanished or
 * scabbed the alpha point away, or the non-alpha side of a split/separating move) has no such open
 * crit and keeps the ordinary ']'. Exported (2026-09-03) for ttree.ts -- see markAlpha. */
export function bracketDisplaySlash(enc: string): string {
  return bracketDisplay(enc).replace(/\[([^[\]]*)\]/g, (whole, inner: string) =>
    inner.includes('α') ? `[${inner}/` : whole,
  );
}

/** Quick-canon display label for a position reference -- see the module header. Membrane letters
 * are shifted per the paper's own left/right pairing convention (see shiftMembraneLetters) so
 * every on-screen label (history list, detail header, T rows, relevancy column, ...) matches the
 * LaTeX export instead of only the export showing the paper's convention. */
function quickLabel(ref: PositionRef): string {
  return bracketDisplaySlash(markAlpha(shiftMembraneLetters(ref.quickEnc))) + (ref.quickOffset ? ' ⊕ 1' : '');
}

function fmtSet(vals: number[]): string {
  return vals.length === 0 ? '{}' : '{' + vals.join(', ') + '}';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** CSS class for a genome-string segment at nesting `depth` -- 0 (the position's own R/D/L/T') is
 * left uncolored (black), 1 (one step down, inside [T]) is blue, 2+ (two steps down and beyond,
 * though truncation means nothing goes past 2 -- see collectAlpha.ts's MAX_GENOME_DEPTH) is red,
 * per the user's request to tell nesting depth apart at a glance. */
function depthClass(depth: number): string {
  if (depth <= 0) return 'gs-d0';
  if (depth === 1) return 'gs-d1';
  return 'gs-d2';
}

/** Hard ceiling on how far genomeParts' own recursive descent (see its `lookupGenome` call below)
 * will trigger a fresh computeAlphaGenome() fetch to resolve an otherwise-truncated T-child --
 * without this, a resolved position's own (possibly truncated) grandchildren could keep triggering
 * further fetches indefinitely, each one settling and re-rendering into yet another truncated layer
 * one level deeper. Set a couple of levels past MAX_GENOME_DEPTH (collectAlpha.ts's own embedding
 * cap, =2): that's enough slack to resolve the one-level-further ambiguity a truncated core-collision
 * grandchild needs (see lookupGenome's own doc comment), without opening the door to unbounded
 * cascading fetches over a large position's whole reachable subtree. */
const MAX_LOOKUP_FETCH_DEPTH = 4;

/** Plain-text and colored-HTML renderings of a genome string "(R,D,{L},{T'},[T])", built together
 * so [T] can be deduped by its PLAIN-text representation (two T-children whose genomes print
 * identically are the same gene, even if they're different positions) while still producing
 * depth-colored HTML for display. A T-child with no computed nested genome (over the lives cap --
 * see classifyByMovetype) falls back to its own quick-canon label instead of a tuple. */
function genomeParts(g: AlphaGenome | FourGeneGenome, depth: number): { plain: string; html: string } {
  const head = `(${fmtNimber(g.R)},${fmtNimber(g.D)},{${g.L.join(',')}},{${g.Tprime.join(',')}}`;
  const cls = depthClass(depth);
  if (!isFullGenome(g)) {
    const plain = head + ')';
    return foldToName(g, plain, `<span class="${cls}">${escapeHtml(plain)}</span>`, cls);
  }

  const seen = new Set<string>();
  const children: { plain: string; html: string }[] = [];
  for (const t of g.T) {
    // Routed through lookupGenome (not a bare `t.genome ?? byEncGenome(t.enc)`, per a 2026-09-02
    // fix -- see lookupGenome's own doc comment) so a T-child whose only embedded `.genome` is a
    // TRUNCATED bare tuple (MAX_GENOME_DEPTH/MAX_NESTED_GENOME_LIVES cut it off) doesn't get folded
    // on that ambiguous stand-in: two different named families can share the exact same bare core
    // (e.g. S_12/S_25), and folding a truncated grandchild on core alone can silently mislabel it.
    // lookupGenome also triggers (and re-renders on) a background fresh computeAlphaGenome() call
    // when even byEnc misses, instead of giving up forever -- still synchronous/non-blocking here,
    // same as the old byEnc-only fallback: returns undefined (falls through to quickLabel below)
    // while better data is pending, and a later render picks up the resolved value once it lands.
    const childGenome = lookupGenome(t.enc, t.genome, depth < MAX_LOOKUP_FETCH_DEPTH);
    const child = childGenome
      ? genomeParts(childGenome, depth + 1)
      : { plain: quickLabel(t), html: `<span class="${depthClass(depth + 1)}">${escapeHtml(quickLabel(t))}</span>` };
    if (seen.has(child.plain)) continue;
    seen.add(child.plain);
    children.push(child);
  }
  // Sorted lexicographically by plain text -- [T] order otherwise reflects arbitrary move-search
  // order from the engine, so without a fixed order the same genome could print (and fold to a
  // GENOME_NAMES entry) differently across two runs that found the same T-children in a different
  // sequence.
  children.sort((a, b) => (a.plain < b.plain ? -1 : a.plain > b.plain ? 1 : 0));
  const childPlains = children.map(c => c.plain);
  const childHtmls = children.map(c => c.html);

  const plain = `${head},[${childPlains.join(',')}])`;
  const html =
    `<span class="${cls}">${escapeHtml(head)},[</span>` +
    childHtmls.join(`<span class="${cls}">,</span>`) +
    `<span class="${cls}">])</span>`;
  return foldToName(g, plain, html, cls);
}

/** When the Quick-Genome toggle is on, fold a genome node whose exact plain-text tuple matches a
 * known shorthand (see GENOME_NAMES) down to its name, replacing the full tuple rendering -- or,
 * failing that, whose bare core matches a bypass-only family (see bypassOnlyFoldName), since a
 * finite hand-authored GENOME_NAMES table can never enumerate every real T-list such a family's
 * members can have. */
function foldToName(
  g: { R: number | null; D: number | null; L: number[]; Tprime: number[] },
  plain: string,
  html: string,
  cls: string,
): { plain: string; html: string } {
  if (!quickGenome) return { plain, html };
  const name = GENOME_NAMES[plain] ?? bypassOnlyFoldName(g);
  if (!name) return { plain, html };
  return { plain: name, html: `<span class="${cls}">${escapeHtml(name)}</span>` };
}

/** genomeParts(g, depth).plain, but forcing the fold as if the Quick-Genome toggle were on --
 * used anywhere a genome needs to be compared against a GENOME_NAMES/NAMED_FAMILIES entry (both
 * defined in already-folded form), independent of what the user currently has the toggle set to.
 * Safe across the module-level `quickGenome` flag because every call here is synchronous end to
 * end (genomeParts never awaits), so the save/restore always brackets cleanly even when called
 * from inside an async function like computeRelevancy. */
function foldedPlainOf(g: AlphaGenome | FourGeneGenome, depth: number): string {
  const wasQuick = quickGenome;
  quickGenome = true;
  const plain = genomeParts(g, depth).plain;
  quickGenome = wasQuick;
  return plain;
}

/** True when a genome's own top-level plain-text rendering folds entirely to a name (see
 * GENOME_NAMES/foldToName) -- i.e. this genome IS a named one, not just containing one as a T
 * T-child. Ignores the Quick-Genome toggle (checked as if it were on) since this is used to flag
 * list entries, which should still surface the match even with the toggle off. */
/** Memoized on the genome object itself: `history` only grows across a session (and is persisted
 * across sessions via HISTORY_STORAGE_KEY, see loadHistory), but render() re-evaluates isNamedGenome
 * for EVERY history entry (and every active-entry T-row, see renderTList) on every single re-render
 * -- and a re-render fires once per settled relevancy/AC check, not once per search. Without this
 * cache, foldedPlainOf's full recursive tree walk re-runs for every already-classified entry every
 * time, so the per-render cost (and hence the visible lag between typing a search and seeing its
 * result) grows without bound as more positions accumulate in history. A genome object is only ever
 * replaced wholesale (selectEntry's stand-in-to-fresh upgrade creates a new object), never mutated in
 * place, so keying on identity needs no invalidation. */
const isNamedGenomeCache = new WeakMap<AlphaGenome | FourGeneGenome, boolean>();
function isNamedGenome(genome: AlphaGenome | FourGeneGenome): boolean {
  const cached = isNamedGenomeCache.get(genome);
  if (cached !== undefined) return cached;
  const result = !foldedPlainOf(genome, 0).startsWith('(');
  isNamedGenomeCache.set(genome, result);
  return result;
}

/** `enc`'s own genome, straight from the offline BY_ENC index (see GenomeDbJson doc comment) --
 * undefined if `enc` isn't one of the positions that data file covers. A pure O(1) lookup, no
 * engine call, and (unlike a T-child's own possibly-truncated `.genome`) always has a full T list
 * when present. */
function byEncGenome(enc: string): AlphaGenome | undefined {
  const hit = BY_ENC[enc];
  return hit ? { R: hit.R, D: hit.D, L: hit.L, Tprime: hit.Tprime, T: hit.T } : undefined;
}

const genomeLookupCache = new Map<string, AlphaGenome | FourGeneGenome | null>();
const genomeLookupPending = new Set<string>();

/** `enc`'s own genome, for use by the T-gene table's Genome/Bypass columns (see formatGenomeCell/
 * findBypassMatches) -- prefers, in order, an already-loaded FULL nested genome, the offline BY_ENC
 * lookup, and a permanent per-session cache of prior fresh computeAlphaGenome() calls; triggers
 * (and caches, then re-renders on completion) exactly one such call for any `enc` not covered by any
 * of those. Returns undefined while a first-time fetch for `enc` is still pending.
 *
 * `known` is trusted immediately ONLY when it's already a FULL genome (has its own real `.T`) --
 * a TRUNCATED `known` (the bare 4-tuple computeAlphaGenomeAt hands back once MAX_GENOME_DEPTH/
 * MAX_NESTED_GENOME_LIVES caps recursion, see collectAlpha.ts) is deliberately treated the SAME as
 * "not known yet", falling through to byEncGenome/a fresh call instead of being handed back as-is.
 * Reason (found 2026-09-02 via a live false-positive bug report): several distinct named families
 * share the EXACT SAME bare (R,D,{L},{T'}) core and differ only in their required T-gene list --
 * e.g. S_12 and S_25 both key to (0,3,{0,2},{}) (also S_1/S_15, S_6/S_8/S_17/S_20, S_7/S_10,
 * S_14/S_26, S_21/S_24, at every shift). A bare, T-less truncated genome can't tell which family in
 * a collision group it really is, so `foldedPlainOf`'s own compact-key fallback just guesses
 * "whichever family registered first" -- a fine best-effort DISPLAY label when nothing better is
 * available, but findBypassMatches was trusting that guess as verified fact when deciding whether a
 * bypass is legitimate, letting a genuine S_25 grandchild get silently credited as an S_12 bypass.
 * Falling through here means a truncated grandchild resolves for real (usually for free via the
 * offline BY_ENC table, which "always has a full T list when present"; only rarely needs an actual
 * fresh engine call) instead of asserting a name that might be wrong -- callers already handle the
 * transient `undefined` as "pending, don't flag yet" (see TRowInfo.pending), so this only delays an
 * uncertain answer rather than ever asserting a wrong one.
 *
 * `allowFetch` (default true) gates ONLY the last-resort fresh computeAlphaGenome() call, not the
 * free byEnc/cache lookups above it -- genomeParts passes false past MAX_LOOKUP_FETCH_DEPTH so its
 * OWN recursive descent (each resolved position potentially handing back more real T-children, each
 * possibly ALSO truncated) can't cascade into an unbounded chain of fresh engine calls. Every other
 * call site (formatGenomeCell, findBypassMatches) checks a single, non-recursive level, where that
 * risk doesn't apply, so they keep the default. */
function lookupGenome(
  enc: string,
  known?: AlphaGenome | FourGeneGenome,
  allowFetch = true,
): AlphaGenome | FourGeneGenome | undefined {
  if (known && isFullGenome(known)) return known;
  const direct = byEncGenome(enc);
  if (direct) return direct;
  const cached = genomeLookupCache.get(enc);
  if (cached !== undefined) return cached ?? undefined;
  if (!allowFetch) return known;
  if (!genomeLookupPending.has(enc)) {
    genomeLookupPending.add(enc);
    void computeAlphaGenome(enc).then(result => {
      genomeLookupPending.delete(enc);
      genomeLookupCache.set(enc, result ? result.genome : null);
      scheduleRender();
    });
  }
  return undefined;
}

/** `lookupGenome` wrapped as a collectAlpha.ts `ResolveChild` -- the depth parameter is ignored
 * (every call site sharing this instance historically used lookupGenome's own default
 * `allowFetch=true`, never the depth-capped variant genomeParts uses internally for its own,
 * still-local recursive HTML rendering -- see MAX_LOOKUP_FETCH_DEPTH). */
const resolveChild: ResolveChild = (enc, known) => lookupGenome(enc, known);

/** `g`'s own display name for the Genome column: its exact fold if it has one (every T-child
 * accounted for, recursively), else null (falls through to the raw tuple/'+' placeholder in
 * formatGenomeCell). `foldedPlainOf` already applies the bypass-only fallback too (see
 * bypassOnlyFoldName/foldToName, both shared with the main genome header) -- e.g. S_1/S_2, whose
 * NAMED_FAMILIES entry has an empty `tChildPlains`, fold by bare core alone regardless of their
 * real T-list, since a finite hand-authored GENOME_NAMES table can never enumerate every T-list
 * such a family's members can actually have (added 2026-08-31 after the user reported [1212a/,
 * core (0,1,{0},{}), failing to register as S_1). This is NOT a reintroduction of the old
 * Advanced-Collection fallback removed 2026-08-30 (matching on bare core + "every extra T-child is
 * itself in SOME Advanced Collection", which let unrelated named genomes excuse an extra T-child
 * regardless of relevance to the family actually being searched -- the exact gap the Yellow-Line's
 * own family-scoped satisfiesRequired/hasBypass logic, computeRowInfos/findBypassMatches, is built
 * to avoid): the rule here never excuses anything via an unrelated genome, and only ever fires for
 * a family whose OWN tChildPlains is empty, i.e. that family itself asserts no T-child requirement
 * exists. Synchronous, no engine call. Moved to collectAlpha.ts as `resolvedFoldName` (2026-09-03,
 * shared with ttree.ts); this file now just supplies `resolveChild` as the fetch strategy. */

/** "Genome" column text for a T-gene table row: `g`'s own exact fold (see resolvedFoldName) if it
 * has one, else its bare four genes followed by its own T-gene members, each shown by name if THAT
 * one has an exact fold, else a bare '+' placeholder (covers both "genuinely not named" and "not
 * loaded yet" -- a still-pending grandchild just shows '+' for now and corrects itself on the next
 * render once lookupGenome settles) -- never a fully-expanded nested tuple (that's what genomeParts'
 * unbounded recursive rendering is for, and it gets messy fast for anything more than one level, per
 * the user's own request). */
function formatGenomeCell(g: AlphaGenome | FourGeneGenome): string {
  const resolved = resolvedFoldName(g, resolveChild);
  if (resolved !== null) return resolved;
  const head = `(${fmtNimber(g.R)},${fmtNimber(g.D)},{${g.L.join(',')}},{${g.Tprime.join(',')}}`;
  if (!isFullGenome(g)) return head + ')';
  const parts = g.T.map(child => {
    const childKnown = lookupGenome(child.enc, child.genome);
    return (childKnown && resolvedFoldName(childKnown, resolveChild)) || '+';
  });
  return `${head},[${parts.join(', ')}])`;
}

/** A T-child's own folded-plain identity, used the same way GENOME_NAMES/NAMED_FAMILIES text
 * does. Prefers, in order: an already-loaded nested genome, the offline BY_ENC lookup, and only
 * then a fresh engine call (a T-child beyond MAX_NESTED_GENOME_LIVES carries no `.genome` at all --
 * see collectAlpha.ts) -- falling back to its quick-canon label only if that fetch itself fails. */
async function foldedPlainOfTChild(t: TChild): Promise<string> {
  const known = t.genome ?? byEncGenome(t.enc);
  if (known) return foldedPlainOf(known, 1);
  const fresh = await computeAlphaGenome(t.enc);
  return fresh ? foldedPlainOf(fresh.genome, 1) : quickLabel(t);
}

/** A T row's "Relevancy" verdict, matching the paper's genome sequencing table format (see the
 * module header): either (1) `name` -- the T-child is ITSELF a recognized named genome (its own
 * plain folds entirely to a name -- same test as isNamedGenome) --
 * covering both a root family's own required lowest-order T-children (whose plains are always
 * names themselves, see NAMED_FAMILIES) and any other directly-named T-child regardless of the
 * root's family -- or (2) `position` -- an "extra" T-child whose own T-children (one level down
 * only -- a Grandparent Bypass check, not open recursion) contain one that itself folds entirely to
 * a name (cited by ITS OWN position, not by name again, matching the paper's own convention), or
 * (3) `none` -- no such one-level bypass was found (this is a shallow, paper-matching check only,
 * not a claim about Advanced-Collection membership more broadly). Used only by buildExportLatex now
 * (for the shifted-letter LaTeX form's own
 * Relevancy column, matching the paper's table format) -- the in-app T-gene table shows a plain
 * Genome column instead (see formatGenomeCell), a different, non-paper-matching view. */
type RelevancyVerdict = { kind: 'name'; name: string } | { kind: 'position'; ref: TChild } | { kind: 'none' };

async function computeRelevancy(rootGenome: AlphaGenome | FourGeneGenome, t: TChild): Promise<RelevancyVerdict> {
  const plain = await foldedPlainOfTChild(t);
  if (!plain.startsWith('(')) return { kind: 'name', name: plain };

  const family = familyForCore(rootGenome);
  if (family && family.tChildPlains.includes(plain)) return { kind: 'name', name: family.name };

  const tGenome = t.genome ?? byEncGenome(t.enc) ?? (await computeAlphaGenome(t.enc))?.genome;
  if (tGenome && isFullGenome(tGenome)) {
    for (const g of tGenome.T) {
      const gGenome = g.genome ?? byEncGenome(g.enc) ?? (await computeAlphaGenome(g.enc))?.genome;
      if (gGenome && isNamedGenome(gGenome)) return { kind: 'position', ref: g };
    }
  }
  return { kind: 'none' };
}

function buildEntry(position: PositionRef, genome: AlphaGenome, lives: number | null): Entry {
  return { label: quickLabel(position), position, lives, genome, genomeFresh: true };
}

/** Build an Entry from a GENOME_DB hit -- no engine call needed up front, since the genome is
 * implied by the bucket key and each T-child already carries its own quick-canon form + nimber
 * (see collect_alpha_genetics.cpp). `genomeFresh` is false here: the DB predates quick-canon-split
 * handling (see collectAlpha.ts's quickAlphaSplitOf) and nested [T] genomes, so this is a stand-in,
 * upgraded to a real computeAlphaGenome() result the first time this entry is actually selected --
 * see selectEntry. */
function buildGenomeEntry(hit: GenomeHit, R: number, D: number, L: number[], Tprime: number[]): Entry {
  return { label: quickLabel(hit), position: hit, lives: hit.lives, genomeFresh: false,
    genome: { R, D, L, Tprime, T: hit.T } };
}

/** Make `label` the active entry and, if its genome is still the GENOME_DB stand-in (see
 * buildGenomeEntry), recompute it for real via one computeAlphaGenome() call and re-render once
 * that lands -- upgrading it in place so the freshly-computed (quick-canon-split-aware, nested-[T])
 * genome shows up instead of the stale flat one, without paying that cost for the whole list. */
function selectEntry(label: string | null): void {
  activeLabel = label;
  render();
  const entry = history.find(h => h.label === label);
  if (!entry || entry.genomeFresh) return;
  void computeAlphaGenome(entry.position.enc).then(result => {
    if (!result) return;
    entry.genome = result.genome;
    entry.genomeFresh = true;
    saveHistory();
    if (activeLabel === label) render();
  });
}

async function runSearch(raw: string): Promise<void> {
  const myGen = ++searchGen;
  const trimmed = raw.trim();
  // A plain position search isn't "searching a named genome" (per the user's own phrasing), even
  // when the position found happens to itself be named -- the T-gene table's Bypass column only
  // makes sense relative to a genome/shorthand query typed into the search bar (see loadGenome).
  searchedGenomeName = null;
  if (trimmed.length === 0) {
    status = '';
    statusIsError = false;
    render();
    return;
  }

  status = 'Searching…';
  statusIsError = false;
  render();

  const result = await computeAlphaGenome(trimmed);
  if (myGen !== searchGen) return;

  if (!result) {
    status = "Couldn't analyze that position — check it parses and contains exactly one α (not a membrane, and not more than one α).";
    statusIsError = true;
    render();
    return;
  }

  const entry = buildEntry(result.position, result.genome, null);
  addToHistory(entry);
  activeLabel = entry.label;
  status = '';
  statusIsError = false;
  render();
}

async function loadGenome(raw: string, explicitName?: string): Promise<void> {
  const parsed = parseGenomeQuery(raw);
  if (!parsed) {
    status = "Couldn't parse that genome — expected a form like (0,1,{0},{}).";
    statusIsError = true;
    searchedGenomeName = null;
    render();
    return;
  }

  // `explicitName` -- the exact family a shorthand search (e.g. "S_1+2") named -- always wins over
  // re-deriving a name from the bare four-gene tuple: several different named families can share
  // the exact same (R,D,{L},{T'}) core with different T-lists (e.g. S_1⊕2 and S_15 both key to
  // "(2,3,{2},{})"), so GENOME_NAMES' compact-key lookup would otherwise silently pick whichever
  // family happened to register first, not the one actually typed (see nameForShorthand's own doc
  // comment). Only a raw typed-in tuple (no name attached at all) falls back to that lookup, which
  // stays inherently ambiguous in that case -- there's no explicit name to prefer instead. Set even
  // if no hits are found (a real search attempt still happened), and left in place for a hit with no
  // name (null) -- the Bypass column just stays hidden either way.
  searchedGenomeName = explicitName ?? GENOME_NAMES[parsed.key] ?? null;

  const hits = GENOME_DB[parsed.key];
  if (!hits || hits.length === 0) {
    status = `No positions with genome ${parsed.key} found.`;
    statusIsError = true;
    render();
    return;
  }

  // A genome search replaces the list, so it's always clear every entry on screen shares this
  // exact genome (anything looked at afterward re-appends normally).
  history = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    addToHistory(buildGenomeEntry(hits[i], parsed.R, parsed.D, parsed.L, parsed.Tprime), false);
  }
  saveHistory();
  // history[0] is the most recently added, which is hits[0] (lowest lives) -- open that one.
  status = '';
  statusIsError = false;
  selectEntry(history[0]?.label ?? null);
}

/** Clicking a T row: reuse the existing history entry if this position's already in the list,
 * otherwise compute its genome fresh (one analyze() call against its REAL encoding, never its
 * quick-canon stand-in) and add it. Either way it becomes the active entry. */
async function selectTEntry(t: PositionRef): Promise<void> {
  const label = quickLabel(t);
  const existing = history.find(h => h.label === label);
  if (existing) {
    addToHistory(existing);
    activeLabel = existing.label;
    render();
    return;
  }
  const result = await computeAlphaGenome(t.enc);
  if (!result) return;
  const entry = buildEntry(result.position, result.genome, null);
  addToHistory(entry);
  activeLabel = entry.label;
  render();
}

/** Per-row classification for the T-gene table -- shared between renderRequiredLine (the header
 * line) and renderTList's own row rendering/ordering, so both agree on exactly the same notion of
 * "satisfied" and neither re-derives it independently. Moved to collectAlpha.ts as
 * `classifyTChildren`/`TChildClassification` (2026-09-03, shared with ttree.ts's own per-node
 * classification); this file just supplies `resolveChild` and `searchedGenomeName` as the target.
 * `pending` is true while any piece (the row's own genome, or its bypass matches) hasn't settled
 * yet -- see lookupGenome/findBypassMatches's own fire-once-and-settle pattern; `isExtra` is only
 * ever asserted once everything has actually settled, so a row never gets flagged (and
 * reordered/highlighted) on stale pending data, only corrected via the next scheduleRender once
 * resolution lands. */

/** Renders the required-T-gene summary line above the T-gene table: one bold entry per name in
 * `family.tChildPlains` (the search collection's own definition -- its lowest-order T-children),
 * red if that name shows up as SOME row's own resolved Genome-column name (see resolvedGenomeName)
 * anywhere in `rows`, black otherwise; plus a trailing bold "No Extras", red only if no row is
 * flagged `isExtra` -- i.e. every row is accounted for, either itself one of the required names, or
 * (per findBypassMatches) carrying its own bypass into the searched family. When EVERY entry on the
 * line (every required name plus "No Extras") is red -- the position fully satisfies the searched
 * family with nothing left unaccounted for -- the whole line gets a yellow background, flagging it
 * as complete at a glance. Only called when a named genome is actually being searched (see
 * renderTList's own caller). */
function renderRequiredLine(container: HTMLElement, family: NamedFamily, rows: TChildClassification[]): void {
  const presentNames = new Set(rows.map(r => r.resolvedName).filter((n): n is string => typeof n === 'string'));
  const noExtras = rows.every(r => !r.isExtra);
  const allPresent = family.tChildPlains.every(name => presentNames.has(name)) && noExtras;

  const line = document.createElement('div');
  line.className = 'collect-t-required-line' + (allPresent ? ' collect-t-required-complete' : '');

  const names = document.createElement('span');
  names.className = 'collect-t-required-names';
  for (const name of family.tChildPlains) {
    const span = document.createElement('span');
    span.className = presentNames.has(name) ? 'collect-t-required-present' : 'collect-t-required-missing';
    span.textContent = name;
    names.appendChild(span);
  }
  line.appendChild(names);

  const noExtrasSpan = document.createElement('span');
  noExtrasSpan.className = noExtras ? 'collect-t-required-present' : 'collect-t-required-missing';
  noExtrasSpan.textContent = 'No Extras';
  line.appendChild(noExtrasSpan);

  container.appendChild(line);
}

/** Renders the T section as a table -- see the module header for what each column shows (Position
 * always; Genome always, once resolved -- see lookupGenome/formatGenomeCell; Bypass only when a
 * named genome is currently searched -- see searchedGenomeName/findBypassMatches). Also renders the
 * required-T-gene summary line (see renderRequiredLine) above the table whenever the search bar's
 * own query resolved to a genome that's itself a recognized named family -- skipped for a plain
 * position search, or a search whose name has no NAMED_FAMILIES entry of its own to draw the
 * required list from (e.g. a bare LEGACY_FOLD_KEYS-only alias). Rows confirmed as unexplained
 * "extras" (see TChildClassification.isExtra) are pushed to the top (stable otherwise -- see the
 * sort below) and highlighted with a pale red background, so the rows still needing a bypass
 * explanation are the first thing seen rather than buried among satisfied ones. */
function renderTList(container: HTMLElement, list: TChild[]): void {
  container.innerHTML = '';
  const requiredFamily = searchedGenomeName ? NAMED_FAMILIES.find(f => f.name === searchedGenomeName) : undefined;
  const showBypass = searchedGenomeName !== null;
  const rows = classifyTChildren(list, requiredFamily, searchedGenomeName, resolveChild);
  if (requiredFamily) renderRequiredLine(container, requiredFamily, rows);
  if (list.length === 0) {
    container.appendChild(document.createTextNode('(none)'));
    return;
  }
  const ordered = requiredFamily
    ? [...rows.filter(r => r.isExtra), ...rows.filter(r => !r.isExtra)]
    : rows;
  const table = document.createElement('table');
  table.className = 'collect-t-table';
  const head = table.insertRow();
  head.innerHTML =
    '<th>Position</th><th class="collect-t-genome-head">Genome</th>' +
    (showBypass
      ? `<th class="collect-t-bypass-head" title="T-gene members bypassing into ${escapeHtml(searchedGenomeName ?? '')}">Bypass</th>`
      : '');
  for (const { t, tGenome, matches, isExtra } of ordered) {
    const row = table.insertRow();
    row.className = 'collect-t-row collect-t-clickable' + (isExtra ? ' collect-t-row-extra' : '');

    const label = row.insertCell();
    label.className = 'collect-t-label';
    label.textContent = quickLabel(t);

    const genomeCell = row.insertCell();
    genomeCell.className = 'collect-t-genome';
    if (tGenome) {
      genomeCell.textContent = formatGenomeCell(tGenome);
      genomeCell.title = genomeParts(tGenome, 0).plain;
    }

    if (showBypass) {
      const bypassCell = row.insertCell();
      if (matches === null) {
        bypassCell.className = 'collect-t-bypass';
      } else if (matches.length === 0) {
        bypassCell.className = 'collect-t-bypass collect-t-bypass-none';
        bypassCell.textContent = '—';
      } else {
        bypassCell.className = 'collect-t-bypass';
        matches.forEach((match, i) => {
          if (i > 0) bypassCell.appendChild(document.createTextNode(', '));
          const span = document.createElement('span');
          span.className = 'collect-t-bypass-match';
          span.textContent = match.name;
          span.addEventListener('click', e => {
            e.stopPropagation();
            void selectTEntry(match.witness);
          });
          bypassCell.appendChild(span);
        });
      }
    }

    row.addEventListener('click', () => void selectTEntry(t));
    row.addEventListener('mouseenter', () => renderPreview(t));
    row.addEventListener('mouseleave', () => renderPreview(null));
  }
  container.appendChild(table);
}

/** Render (or clear) the hover-preview area beneath the main genome table -- a SEPARATE element
 * from the T-list itself, updated in place rather than via a full renderDetail() call, so hovering
 * a T row never rebuilds (and thus never detaches) the very row the mouse is over; doing that would
 * make the browser's mouseleave never fire on the now-removed element, leaving the preview stuck. */
function renderPreview(t: TChild | null): void {
  const previewEl = document.getElementById('collect-preview');
  if (!previewEl) return;
  if (!t) {
    previewEl.innerHTML = '';
    return;
  }
  const livesStr = t.lives === undefined ? '' : ` — ${t.lives} lives`;
  // Just the genome STRING (same one-line, depth-colored format as the main header), not the fully
  // expanded nested table -- a hover preview is for a quick glance, not for exploring every nested
  // T-child (that's what clicking the row, or hovering ITS own T rows once opened, is for). Colored
  // starting fresh at depth 0 (this T-child's own R/D/L/T' in black), same convention as the active
  // entry's own header.
  const gs = t.genome ? genomeParts(t.genome, 0) : null;
  previewEl.innerHTML = `
    <div class="collect-detail-enc collect-preview-enc">
      <span class="collect-detail-label">${quickLabel(t)}${livesStr} (preview)</span>
      ${gs ? `<span class="collect-detail-genome" title="${escapeHtml(gs.plain)}">${gs.html}</span>` : ''}
    </div>
    ${gs ? '' : '<div class="collect-empty">No genome computed for this T-child (over the lives cap) — click it to compute one fresh.</div>'}
  `;
}

const PRETTY_INDENT = '  ';

/** Reformats a flat genome-query string "(R,D,{L},{T'},[T1,T2,...])" into an indented,
 * pseudo-JSON-ish multi-line form for the clipboard -- each "[...]" (a T-list -- the part that
 * actually nests and gets unreadable) breaks onto its own lines, one entry per line, with an extra
 * indent level for as long as it stays open, un-indenting again at its closing "]". "(...)" and
 * "{...}" (the R/D/L/T' tuple/sets, which stay short and flat even when nested) are left inline,
 * as is an empty "[]" -- only non-empty arrays are worth breaking up. Purely a text transform on
 * the already-balanced plain text genomeParts produces; doesn't re-parse or validate the genome. */
function prettyPrintGenome(plain: string): string {
  let out = '';
  let depth = 0;
  const stack: ('paren' | 'brace' | 'bracket')[] = [];
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === '[' && plain[i + 1] === ']') {
      out += '[]';
      i++;
      continue;
    }
    if (ch === '[') {
      stack.push('bracket');
      depth++;
      out += '[\n' + PRETTY_INDENT.repeat(depth);
      continue;
    }
    if (ch === ']') {
      stack.pop();
      depth--;
      out += '\n' + PRETTY_INDENT.repeat(depth) + ']';
      continue;
    }
    if (ch === '(') { stack.push('paren'); out += ch; continue; }
    if (ch === ')') { stack.pop(); out += ch; continue; }
    if (ch === '{') { stack.push('brace'); out += ch; continue; }
    if (ch === '}') { stack.pop(); out += ch; continue; }
    if (ch === ',' && stack[stack.length - 1] === 'bracket') {
      out += ',\n' + PRETTY_INDENT.repeat(depth);
      continue;
    }
    out += ch;
  }
  return out;
}

function renderDetail(): void {
  const detailEl = document.getElementById('collect-detail') as HTMLDivElement;

  const entry = history.find(h => h.label === activeLabel) ?? null;
  if (!entry) {
    detailEl.innerHTML =
      '<div class="collect-empty">Type a position encoding containing one α above and press Enter to search, or type a genome like (0,1,{0},{}) (or (0,1,{0},{},[T])) to load every matching position. Shorthand names like S_1 also work.</div>';
    return;
  }

  const { genome } = entry;
  const gs = genomeParts(genome, 0);
  detailEl.innerHTML = `
    <div class="collect-detail-enc">
      <span class="collect-detail-label collect-detail-label-copyable" title="Click to copy this position's encoding">${entry.label}</span>
      <span class="collect-detail-genome" title="${escapeHtml(gs.plain)}" data-genome="${escapeHtml(gs.plain)}">${gs.html}</span>
    </div>
    <table class="collect-code-table">
      <colgroup><col style="width: 60px" /><col /></colgroup>
      <tr><th>Move</th><th>Genome / T-child positions</th></tr>
      <tr><td>R</td><td class="collect-t-cell"><div class="nimset">${fmtNimber(genome.R)}</div></td></tr>
      <tr><td>D</td><td class="collect-t-cell"><div class="nimset">${fmtNimber(genome.D)}</div></td></tr>
      <tr><td>L</td><td class="collect-t-cell"><div class="nimset">${fmtSet(genome.L)}</div></td></tr>
      <tr><td>T'</td><td class="collect-t-cell"><div class="nimset">${fmtSet(genome.Tprime)}</div></td></tr>
      <tr><td>T</td><td class="collect-t-cell" id="collect-t-cell"></td></tr>
    </table>
    <div id="collect-preview"></div>
  `;

  const tEl = document.getElementById('collect-t-cell');
  if (tEl) renderTList(tEl, genome.T);

  const genomeEl = document.getElementById('collect-detail') as HTMLDivElement;
  const labelEl = genomeEl.querySelector<HTMLElement>('.collect-detail-label-copyable');
  labelEl?.addEventListener('click', () => {
    const statusEl = document.getElementById('collect-export-status') as HTMLSpanElement | null;
    const copyText = bracketDisplaySlash(markAlpha(shiftMembraneLetters(entry.position.enc)));
    void navigator.clipboard.writeText(copyText).then(
      () => { if (statusEl) { statusEl.textContent = 'Copied position to clipboard.'; statusEl.classList.remove('error'); } },
      () => { if (statusEl) { statusEl.textContent = "Couldn't copy to clipboard."; statusEl.classList.add('error'); } },
    );
  });

  const gsEl = genomeEl.querySelector<HTMLElement>('.collect-detail-genome');
  gsEl?.addEventListener('click', () => {
    const input = document.getElementById('collect-search-input') as HTMLInputElement;
    const plain = gsEl.dataset.genome ?? '';
    input.value = plain;
    input.focus();
    const statusEl = document.getElementById('collect-export-status') as HTMLSpanElement | null;
    void navigator.clipboard.writeText(prettyPrintGenome(plain)).then(
      () => { if (statusEl) { statusEl.textContent = 'Copied (indented) to clipboard.'; statusEl.classList.remove('error'); } },
      () => { if (statusEl) { statusEl.textContent = "Couldn't copy to clipboard."; statusEl.classList.add('error'); } },
    );
  });
}

// ---- LaTeX export (matches the paper's genome sequencing table format, see module header) -------

/** ⊕/α aren't valid outside math mode in real LaTeX (the app only uses the raw Unicode glyphs for
 * its own on-screen display) -- converts them to \oplus/\alpha, and escapes bare "{"/"}" (used
 * throughout genome tuple text, e.g. "{1,3}") to \{/\} since LaTeX treats unescaped braces as
 * grouping delimiters and would silently swallow them rather than rendering them -- so the exported
 * text is ready to paste, not just visually similar. */
function toLatexSymbols(text: string): string {
  return text.replace(/⊕/g, '\\oplus ').replace(/α/g, '\\alpha ').replace(/[{}]/g, ch => `\\${ch}`);
}

/** A real (non-quick-canon) structural encoding, formatted for the export table: membrane letters
 * shifted per the paper's own left/right pairing convention (see shiftMembraneLetters), alpha
 * marked, bracket-wrapped, and with ⊕/α converted to real LaTeX macros. */
function exportEncoding(enc: string): string {
  return toLatexSymbols(bracketDisplaySlash(markAlpha(shiftMembraneLetters(enc))));
}

/** A T-child/T-grandchild's own real (canon) structural encoding, formatted for export the same
 * way as exportEncoding -- the exact position reached, not the quick-canon rep (which is only
 * proven nimber-equivalent up to quickOffset, per PositionRef's doc comment -- see
 * feedback_prefer_quickcanon_display's caveat), per the user's request that the export table's T
 * columns show real encodings. No offset suffix is needed here: that offset describes the
 * quick-canon rep's own approximation of this position, not the position itself. */
function exportCanonLabel(ref: PositionRef): string {
  return exportEncoding(ref.enc);
}

function formatRelevancyExport(v: RelevancyVerdict): string {
  if (v.kind === 'name') return toLatexSymbols(v.name);
  if (v.kind === 'position') return exportCanonLabel(v.ref);
  return 'none';
}

const EXPORT_PAD = '\\multicolumn{1}{m{.75cm}|}{} & \\multicolumn{1}{m{.75cm}|}{}';

/** Builds the full \begin{tabular}...\end{tabular} block for `entry`, matching the paper's genome
 * sequencing table template (see the module header): left three columns are every raw R/D/L/T'
 * child (one row each, undeduped -- see MoveChildRef's doc comment), right two columns are every T
 * move's child + its Relevancy verdict (see computeRelevancy), and the two sides are padded to the
 * same row count with the template's own empty-cell placeholder. Always recomputes the genome fresh
 * (regardless of entry.genomeFresh) since only a live computeAlphaGenomeAt call populates the raw
 * Rc/Dc/Lc/TprimeC child data this needs -- GENOME_DB-loaded entries predate that field. */
async function buildExportLatex(entry: Entry): Promise<string> {
  const fresh = await computeAlphaGenome(entry.position.enc);
  if (!fresh) throw new Error("couldn't re-analyze this position for export");
  const { position, genome } = fresh;

  // TODO: the Advanced-Collection fallback label (position isn't itself exactly named, but still
  // qualifies for a family) was removed along with isInAdvancedCollection -- the Export feature
  // needs its own replacement for this case, not yet designed.
  const foldedTop = foldedPlainOf(genome, 0);
  const label = foldedTop.startsWith('(') ? 'TODO' : foldedTop;

  const leftRows: { mt: string; enc: string; nimber: number }[] = [];
  if (genome.Rc) leftRows.push({ mt: 'R', enc: genome.Rc.enc, nimber: genome.Rc.nimber });
  if (genome.Dc) leftRows.push({ mt: 'D', enc: genome.Dc.enc, nimber: genome.Dc.nimber });
  for (const c of genome.Lc ?? []) leftRows.push({ mt: 'L', enc: c.enc, nimber: c.nimber });
  for (const c of genome.TprimeC ?? []) leftRows.push({ mt: "T'", enc: c.enc, nimber: c.nimber });

  const rightRows: { child: string; relevancy: string }[] = [];
  for (const t of genome.T) {
    const verdict = await computeRelevancy(genome, t);
    rightRows.push({ child: exportCanonLabel(t), relevancy: formatRelevancyExport(verdict) });
  }

  const rowCount = Math.max(leftRows.length, rightRows.length, 1);
  const lines: string[] = [];
  lines.push('\\begin{tabular}{|c|c|c||c|c|}');
  lines.push(
    `\\hline \\multicolumn{3}{|l}{$${exportEncoding(position.enc)}$} & ` +
      `\\multicolumn{2}{r|}{${label ? `$${toLatexSymbols(label)}$` : ''}}\\\\[2pt]`,
  );
  for (let i = 0; i < rowCount; i++) {
    const l = leftRows[i];
    const r = rightRows[i];
    const leftText = l ? `$${l.mt}$ & $${exportEncoding(l.enc)}$ & $${l.nimber}$` : ' & & ';
    const rightText = r
      ? `$${r.child}$ & ${r.relevancy === 'none' ? 'none' : `$${r.relevancy}$`}`
      : EXPORT_PAD;
    lines.push(`\\hline ${leftText} & ${rightText}\\\\[2pt]`);
  }
  lines.push(`\\hline \\multicolumn{5}{|c|}{$${toLatexSymbols(foldedTop)}$} \\\\`);
  lines.push('\\hline');
  lines.push('\\end{tabular}');
  return lines.join('\n');
}

async function runExport(): Promise<void> {
  const statusEl = document.getElementById('collect-export-status') as HTMLSpanElement;
  const entry = history.find(h => h.label === activeLabel) ?? null;
  if (!entry) {
    statusEl.textContent = 'No active entry to export.';
    statusEl.classList.add('error');
    return;
  }
  statusEl.textContent = 'Exporting…';
  statusEl.classList.remove('error');
  try {
    const latex = await buildExportLatex(entry);
    await navigator.clipboard.writeText(latex);
    statusEl.textContent = 'Copied to clipboard.';
    statusEl.classList.remove('error');
  } catch {
    statusEl.textContent = "Couldn't export that position.";
    statusEl.classList.add('error');
  }
}

/** The item list (member rows + an always-present, italicized "(none)" placeholder when empty --
 * so every named family is visible in the tree even before anything's been found for it, per the
 * user's request to see "all of our named collections" at a glance, not just the nonempty ones)
 * for one family name -- shared by the top-level and nested-offset renderers below, since the
 * content logic is identical either way; only the wrapping markup differs. */
function renderCollectionItems(name: string, members: Entry[]): { itemsHtml: string; count: number } {
  // Known roster members straight from stalks/src/collections.cpp's registries (see
  // KNOWN_COLLECTION_MEMBERS's doc comment) -- schematic left-side shapes, not analyzed Collect
  // entries, so they're listed as plain, non-clickable reference text (no PositionRef behind them
  // to select). A real, analyzed Entry can legitimately fold to the EXACT same display text as one
  // of these (S_1/S_1⊕1's single-crit shapes are valid standalone positions, unlike Z_1/Z_2's,
  // so this isn't just theoretical) -- when that happens, skip the static copy rather than showing
  // the identical label twice; the real entry (clickable, backed by an actual genome) wins.
  const memberLabels = new Set(members.map(m => m.label));
  const staticLabels = (KNOWN_COLLECTION_MEMBERS[name] ?? []).filter(s => !memberLabels.has(s));
  const memberItems = members.map(
    m => `<div class="collect-coll-member${m.label === activeLabel ? ' active' : ''}" data-label="${escapeHtml(m.label)}">${escapeHtml(m.label)}</div>`,
  );
  const staticItems = staticLabels.map(
    s =>
      `<div class="collect-coll-member collect-coll-static" title="Known roster member from stalks/src/collections.cpp -- a schematic left-side shape, not an analyzed Collect entry.">${escapeHtml(s)}</div>`,
  );
  const allItems = [...memberItems, ...staticItems];
  const itemsHtml = allItems.length === 0 ? '<div class="collect-coll-empty">(none)</div>' : allItems.join('');
  return { itemsHtml, count: members.length + staticLabels.length };
}

/** The name/count/genome header row shared by both a top-level group's <summary> and a nested
 * offset block's own header -- only names in NAMED_GENOME_DEFS (S_1, S_1⊕1, S_2, S_3, S_5, S_6,
 * S_7, S_8, S_9, ...) actually stand for a real single-alpha genome tuple; Z_1/Z_2 (the roster's
 * own two-crit "S_3"/"S_4", roster-only) have no entry, so no genome text is shown for them. */
function renderCollectionHeaderRow(name: string, count: number): string {
  const genomeText = NAMED_FAMILY_GENOME_TEXT[name];
  const genomeHtml = genomeText
    ? `<span class="collect-coll-header-genome" title="${escapeHtml(genomeText)}">${escapeHtml(genomeText)}</span>`
    : '';
  return `<span class="collect-coll-header-row"><span class="collect-coll-name">${escapeHtml(name)} <span class="collect-coll-count">(${count})</span></span>${genomeHtml}</span>`;
}

/** One nested, non-collapsible sub-block for a base family's own "X⊕n" sibling -- rendered INSIDE
 * the base's own <details> (see renderCollectionGroup) so it's hidden while the base is collapsed
 * and only shown once the base is expanded, per the user's request: still its own fully labeled
 * name/genome/member list, just visually subordinate to the base rather than a separate, ~4x-as-
 * numerous set of top-level folders. */
function renderOffsetBlock(name: string, members: Entry[]): string {
  const { itemsHtml, count } = renderCollectionItems(name, members);
  return `<div class="collect-coll-offset">
    <div class="collect-coll-offset-header">${renderCollectionHeaderRow(name, count)}</div>
    ${itemsHtml}
  </div>`;
}

/** One `<details>` group for the Collections panel -- collapsed by default per the user's request,
 * with `offsets` (a base family's "X⊕n" siblings, if any -- see NAMED_FAMILY_GROUPS) nested inside
 * as renderOffsetBlock sub-sections, so expanding the base reveals its own siblings too without
 * those needing separate top-level folders. */
function renderCollectionGroup(
  name: string,
  members: Entry[],
  offsets: string[],
  byFamily: Map<string, Entry[]>,
): string {
  const { itemsHtml, count } = renderCollectionItems(name, members);
  const offsetsHtml = offsets.map(offsetName => renderOffsetBlock(offsetName, byFamily.get(offsetName) ?? [])).join('');
  return `<details class="collect-coll-group">
    <summary>${renderCollectionHeaderRow(name, count)}</summary>
    ${itemsHtml}
    ${offsetsHtml}
  </details>`;
}

/** Natural-sort key for a "PREFIX_NUMBER" family/folder name (e.g. "S_1" -> [0,"S",1], "S_26" ->
 * [0,"S",26], "Z_1" -> [0,"Z",1]) -- plain string sort would put "S_10" before "S_2". Anything that
 * doesn't fit the pattern (shouldn't happen today, but collections.cpp could register something odd
 * later) sorts after every matching name instead of crashing or silently misplacing. */
function folderSortKey(name: string): [number, string, number] {
  const m = name.match(/^([A-Za-z]+)_(\d+)$/);
  return m ? [0, m[1], Number(m[2])] : [1, name, 0];
}

/** Render the Collections side panel (see index.html's #collect-collections-panel): one folder per
 * known collection/family, pre-populated with its static roster members (KNOWN_COLLECTION_MEMBERS,
 * straight from src/data/collectionsRoster.json / genomeDefs.json). A no-op (and leaves the panel's
 * previous content alone) while the panel is closed, so building this tree doesn't run every
 * render() call for no reason.
 *
 * TOP-LEVEL folders are NAMED_FAMILY_GROUPS' bases (S_1, S_2, S_3, ...) unioned with
 * COLLECTION_ROSTER_FOLDER_NAMES (every collection currently registered in stalks/src/
 * collections.cpp, straight from src/data/collectionsRoster.json -- Z_1/Z_2 today, but also
 * whatever's added there later) MINUS anything that's actually an "X⊕n" offset of some base
 * (reachable via a roster alias, e.g. "S_5⊕1" -- see ROSTER_TO_FOLDER_NAME) -- those get nested
 * inside their own base's group instead (see renderCollectionGroup), never their own top-level
 * folder. So a brand-new Stalks-side collection still gets a folder (with its static roster
 * content, via KNOWN_COLLECTION_MEMBERS) with NO TypeScript change needed.
 *
 * Shows ONLY the static roster content per folder -- real `history` entries are no longer
 * classified into folders here (that used isInAdvancedCollection's acMarker-driven bucketing,
 * removed along with the rest of the Exclamation-logic system; it wasn't worth the false-positive
 * risk). `byFamily` stays empty on purpose -- renderCollectionGroup/renderOffsetBlock already
 * degrade cleanly to roster-only content when passed no real members. */
function renderCollections(): void {
  const dialog = document.getElementById('collect-dialog');
  const panel = document.getElementById('collect-collections-panel');
  if (!dialog || !panel || !dialog.classList.contains('collections-open')) return;

  const byFamily = new Map<string, Entry[]>();

  const offsetNames = new Set(NAMED_FAMILY_GROUPS.flatMap(g => g.offsets));
  const groupByBase = new Map<string, NamedFamilyGroup>(NAMED_FAMILY_GROUPS.map(g => [g.base, g]));
  const topLevelNames = [...new Set([...COLLECTION_ROSTER_FOLDER_NAMES, ...NAMED_FAMILIES.map(f => f.name)])].filter(
    name => !offsetNames.has(name),
  );
  topLevelNames.sort((a, b) => {
    const ak = folderSortKey(a);
    const bk = folderSortKey(b);
    return ak[0] - bk[0] || ak[1].localeCompare(bk[1]) || ak[2] - bk[2];
  });

  let html = '';
  for (const name of topLevelNames) {
    html += renderCollectionGroup(name, byFamily.get(name) ?? [], groupByBase.get(name)?.offsets ?? [], byFamily);
  }
  panel.innerHTML = html;

  panel.querySelectorAll<HTMLElement>('[data-label]').forEach(el => {
    el.addEventListener('click', () => selectEntry(el.dataset.label ?? null));
  });
}

function render(): void {
  const listEl = document.getElementById('collect-list') as HTMLDivElement;
  const statusEl = document.getElementById('collect-status') as HTMLDivElement;

  statusEl.textContent = status;
  statusEl.classList.toggle('error', statusIsError);

  listEl.innerHTML = '';
  history.forEach(entry => {
    const btn = document.createElement('button');
    btn.className = 'collect-entry' + (entry.label === activeLabel ? ' active' : '');
    btn.innerHTML =
      `<span class="collect-entry-label">${escapeHtml(entry.label)}</span>` +
      `<span class="collect-entry-nimber">${entry.lives === null ? '' : entry.lives}</span>`;
    btn.addEventListener('click', () => selectEntry(entry.label));
    listEl.appendChild(btn);
  });

  renderDetail();
  renderCollections();
}

// Referenced only to keep genomeKey linked from this module's public surface for callers that may
// want to build a query string programmatically (e.g. clicking a genome elsewhere in the app).
export { genomeKey };

/** Wire the search input once; safe to call multiple times (each open just re-renders). */
export function initCollect(): void {
  if (wired) { render(); return; }
  wired = true;
  loadHistory();

  const quickToggle = document.getElementById('collect-tog-quick') as HTMLInputElement;
  quickGenome = quickToggle.checked;
  quickToggle.addEventListener('change', () => {
    quickGenome = quickToggle.checked;
    render();
  });

  const exportBtn = document.getElementById('collect-export-btn') as HTMLButtonElement;
  exportBtn.addEventListener('click', () => void runExport());

  const collectionsBtn = document.getElementById('collect-collections-btn') as HTMLButtonElement;
  const dialog = document.getElementById('collect-dialog') as HTMLDivElement;
  collectionsBtn.addEventListener('click', () => {
    const open = dialog.classList.toggle('collections-open');
    collectionsBtn.textContent = open ? 'Collections ◀' : 'Collections ▶';
    render();
  });

  const input = document.getElementById('collect-search-input') as HTMLInputElement;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const raw = input.value.trim();
      const trimmed = expandGenomeShorthand(raw);
      if (trimmed.startsWith('(')) {
        void loadGenome(trimmed, nameForShorthand(raw));
      } else {
        void runSearch(input.value);
      }
    }
  });

  render();
}
