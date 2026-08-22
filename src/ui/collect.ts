/**
 * Collect: type a position encoding containing exactly one alpha ('a') token to see its genome --
 * (R, D, {L}, {T'}, [T]) -- computed directly from the engine's own movetype classification (see
 * src/model/collectAlpha.ts). R and D are single nimbers (the "vanish"/"become a scab" moves,
 * movetypes 1/2); {L} and {T'} are deduped nimber sets (moves that connect within the position, or
 * isolate-and-decay it, movetypes 3/4); [T] is the list of positions reached by every move that
 * leaves alpha untouched (movetype 5), each shown in canon (bracket/⊕) form and clickable to open
 * as its own entry.
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
  type PositionRef,
  type TChild,
  COLLECTION_ROSTER_FOLDER_NAMES,
  GENOME_NAMES,
  KNOWN_COLLECTION_MEMBERS,
  NAMED_FAMILIES,
  NAMED_FAMILY_GENOME_TEXT,
  computeAlphaGenome,
  expandGenomeShorthand,
  genomeKey,
  parseGenomeQuery,
  shiftMembraneLetters,
} from '../model/collectAlpha';
import genomeDbJson from '../data/collectAlphaGenomes.json';

interface GenomeHit extends PositionRef {
  lives: number;
  T: (PositionRef & { nimber: number })[];
}

/** A single-alpha position's own (R,D,{L},{T'},[T]) as computed offline by
 * stalks/tools/collect_alpha_genetics.cpp -- one entry per position, keyed by its real (non-quick-
 * canon) encoding. Used purely as a fast local lookup (see collect.ts's byEncLookup) so
 * isInAdvancedCollection never needs a fresh engine call for any position already covered by this
 * data file -- see the module doc comment on GENOME_DB below for why this exists as a SEPARATE
 * section from the genome-bucket data rather than embedded per-T-child. */
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
 * local-lookup fast path for isInAdvancedCollection/foldedPlainOfTChild so a position's own genome
 * (and its T-children') doesn't need a fresh engine call just because the "!!" check reaches it,
 * whenever it's already covered by this file. (An earlier version tried embedding each T-child's
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
/** Quick-Genome toggle: when on, a genome-string node whose exact plain-text tuple matches a
 * known GENOME_SHORTHANDS entry (see GENOME_NAMES) is folded down to its name, at any nesting
 * depth. Defaults on (checkbox in index.html is checked by default). */
let quickGenome = true;

const HISTORY_STORAGE_KEY = 'sprouts-collect-alpha-v2';

/** Coalesces render() calls triggered by async completions (acMarker/relevancyMarker resolving) --
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

const AC_STORAGE_KEY = 'sprouts-collect-alpha-ac-v1';

/** Persist resolved (not pending) Advanced-Collection results, keyed by position encoding -- see
 * acResult below. A position's membership never changes (it's a pure function of the position), so
 * this is a permanent cache across sessions: once a position has been checked once, ANY future
 * search that reaches it again (as a top-level entry, a T-child, or an extra-T-child's own
 * T-grandchild during someone else's check) shows its "!!" immediately with no recomputation at
 * all, instead of
 * repeating the same recursive engine calls every time the Collect pane is reopened. */
function saveAcResults(): void {
  try {
    localStorage.setItem(AC_STORAGE_KEY, JSON.stringify([...acResult.entries()]));
  } catch {
    /* ignore quota/availability errors */
  }
}

function loadAcResults(): void {
  try {
    const stored = localStorage.getItem(AC_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') {
            acResult.set(entry[0], entry[1]);
          }
        }
      }
    }
  } catch {
    /* fall through to empty */
  }
}

function markAlpha(enc: string): string {
  return enc.replace('a', 'α');
}

/** positionBrowser's own bracketDisplay ("[...]" per '+'-separated component), except any
 * component that still contains an alpha marker ('α', post-markAlpha) closes with '/' instead of
 * ']' -- matching stalks/src/collections.hpp's own left-side notation ("the text between '[' and
 * '/'"): the alpha-marked point stands in as the open crit this whole feature classifies movetypes
 * relative to, so it's a "left side" in the paper's sense even when it's also a complete, playable
 * position. A component with no alpha left in it (e.g. an R/D child where THAT move vanished or
 * scabbed the alpha point away, or the non-alpha side of a split/separating move) has no such open
 * crit and keeps the ordinary ']'. Scoped to this module only -- positionBrowser's shared
 * bracketDisplay is untouched, since outside Collect a bracketed position is never specifically
 * about an alpha-marked left side. */
function bracketDisplaySlash(enc: string): string {
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

function fmtNimber(n: number | null): string {
  return n === null ? 'error' : String(n);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isFullGenome(g: AlphaGenome | FourGeneGenome): g is AlphaGenome {
  return Array.isArray((g as AlphaGenome).T);
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

/** Plain-text and colored-HTML renderings of a genome string "(R,D,{L},{T'},[T])", built together
 * so [T] can be deduped by its PLAIN-text representation (two T-children whose genomes print
 * identically are the same gene, even if they're different positions) while still producing
 * depth-colored HTML for display. A T-child with no computed nested genome (over the lives cap --
 * see classifyByMovetype) falls back to its own quick-canon label instead of a tuple. */
function genomeParts(g: AlphaGenome | FourGeneGenome, depth: number): { plain: string; html: string } {
  const head = `(${fmtNimber(g.R)},${fmtNimber(g.D)},{${g.L.join(',')}},{${g.Tprime.join(',')}}`;
  const cls = depthClass(depth);
  // A T move can land on a split (sum) position -- only the alpha-bearing component's genome is
  // classified, so the other component(s)' nim-summed nimber (plus the quick-canon offset, since
  // this is always computed on the quick-canon rep) is appended as "⊕oplus" -- see
  // collectAlpha.ts's quickAlphaSplitOf/FourGeneGenome doc comment. Omitted when 0 (no split, no
  // offset).
  const oplusSuffix = g.oplus ? `⊕${g.oplus}` : '';
  if (!isFullGenome(g)) {
    const plain = head + ')' + oplusSuffix;
    return foldToName(plain, `<span class="${cls}">${escapeHtml(plain)}</span>`, cls);
  }

  const seen = new Set<string>();
  const children: { plain: string; html: string }[] = [];
  for (const t of g.T) {
    // Falls back to the offline byEnc index (see byEncGenome) when this T-child's own nested
    // genome wasn't loaded (either truncated by MAX_GENOME_DEPTH/MAX_NESTED_GENOME_LIVES, or
    // sourced from a GENOME_DB stand-in entry, whose T-children never carry `.genome` at all) --
    // without this, folding/isNamedGenome couldn't recognize a T-child's OWN T-child as a named
    // genome (e.g. "2,2a"'s child "2a" IS literally S_1, but with no genome and no byEnc lookup
    // it would only ever print as its bracket label, never fold, silently breaking every check
    // one level further up the tree). A lookup only, never an engine call -- byEnc doesn't cover
    // every position, so this can still legitimately miss and fall through to quickLabel.
    const childGenome = t.genome ?? byEncGenome(t.enc);
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

  const plain = `${head},[${childPlains.join(',')}])${oplusSuffix}`;
  const html =
    `<span class="${cls}">${escapeHtml(head)},[</span>` +
    childHtmls.join(`<span class="${cls}">,</span>`) +
    `<span class="${cls}">])${escapeHtml(oplusSuffix)}</span>`;
  return foldToName(plain, html, cls);
}

/** When the Quick-Genome toggle is on, fold a genome node whose exact plain-text tuple matches a
 * known shorthand (see GENOME_NAMES) down to its name, replacing the full tuple rendering. Matched
 * on the tuple with any trailing "⊕N" oplus suffix stripped first, since GENOME_NAMES's keys are
 * un-suffixed (a given tuple shape can appear at any oplus, e.g. S_1 itself split-offset by a T
 * move elsewhere) -- the suffix, if present, is reattached to the folded name unchanged. */
function foldToName(plain: string, html: string, cls: string): { plain: string; html: string } {
  if (!quickGenome) return { plain, html };
  const suffixMatch = /⊕\d+$/.exec(plain);
  const suffix = suffixMatch ? suffixMatch[0] : '';
  const core = suffix ? plain.slice(0, -suffix.length) : plain;
  const name = GENOME_NAMES[core];
  if (!name) return { plain, html };
  const folded = name + suffix;
  return { plain: folded, html: `<span class="${cls}">${escapeHtml(folded)}</span>` };
}

/** genomeParts(g, depth).plain, but forcing the fold as if the Quick-Genome toggle were on --
 * used anywhere a genome needs to be compared against a GENOME_NAMES/NAMED_FAMILIES entry (both
 * defined in already-folded form), independent of what the user currently has the toggle set to.
 * Safe across the module-level `quickGenome` flag because every call here is synchronous end to
 * end (genomeParts never awaits), so the save/restore always brackets cleanly even when called
 * from inside an async function like isInAdvancedCollection. */
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
function isNamedGenome(genome: AlphaGenome | FourGeneGenome): boolean {
  return !foldedPlainOf(genome, 0).startsWith('(');
}

/** A genome's bare (R,D,{L},{T'}) core, matching the format of NamedFamily.coreKey exactly (same
 * text collectAlpha.ts derives its families' coreKey from) -- used to find which named family (if
 * any) a candidate genome could belong to for Advanced-Collection membership. */
function coreKeyOf(g: { R: number | null; D: number | null; L: number[]; Tprime: number[] }): string {
  return `(${fmtNimber(g.R)},${fmtNimber(g.D)},{${g.L.join(',')}},{${g.Tprime.join(',')}})`;
}

/** `enc`'s own genome, straight from the offline BY_ENC index (see GenomeDbJson doc comment) --
 * undefined if `enc` isn't one of the positions that data file covers. A pure O(1) lookup, no
 * engine call, and (unlike a T-child's own possibly-truncated `.genome`) always has a full T list
 * when present. */
function byEncGenome(enc: string): AlphaGenome | undefined {
  const hit = BY_ENC[enc];
  return hit ? { R: hit.R, D: hit.D, L: hit.L, Tprime: hit.Tprime, oplus: 0, T: hit.T } : undefined;
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

/** The named family (if any) whose (R,D,{L},{T'}) core exactly matches `g` -- the "primary genome"
 * a T section's Relevancy column is checked against (see renderTTable/computeRelevancy). */
function familyForGenome(g: { R: number | null; D: number | null; L: number[]; Tprime: number[] }): NamedFamily | undefined {
  return NAMED_FAMILIES.find(f => f.coreKey === coreKeyOf(g));
}

/** A T row's "Relevancy" verdict, matching the paper's genome sequencing table format (see the
 * module header): either (1) `name` -- the T-child is ITSELF a recognized named genome (its own
 * plain folds entirely to a name -- same test as the row's own "!" marker, see renderTList) --
 * covering both a root family's own required lowest-order T-children (whose plains are always
 * names themselves, see NAMED_FAMILIES) and any other directly-named T-child regardless of the
 * root's family -- or (2) `position` -- an "extra" T-child whose own T-children (one level down
 * only -- a Grandparent Bypass check, not open recursion) contain one that itself folds entirely to
 * a name (cited by ITS OWN position, not by name again, matching the paper's own convention), or
 * (3) `none` -- no such one-level bypass was found (which does NOT necessarily mean the T-child
 * fails Advanced-Collection membership outright -- see isInAdvancedCollection's own unbounded
 * recursion, used for the "!!" marker elsewhere -- only that this shallow, paper-matching check
 * didn't find one). Split from its two callers (relevancyMarker for the in-app quick-canon display,
 * buildExportLatex for the shifted-letter LaTeX form) so the search logic is written once. */
type RelevancyVerdict = { kind: 'name'; name: string } | { kind: 'position'; ref: TChild } | { kind: 'none' };

async function computeRelevancy(rootGenome: AlphaGenome | FourGeneGenome, t: TChild): Promise<RelevancyVerdict> {
  const plain = await foldedPlainOfTChild(t);
  if (!plain.startsWith('(')) return { kind: 'name', name: plain };

  const family = familyForGenome(rootGenome);
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

const relevancyCache = new Map<string, string>();
const relevancyPending = new Set<string>();

/** Cached/lazily-triggered wrapper around computeRelevancy for use inside a synchronous render pass
 * -- same fire-once-and-re-render-on-completion pattern as acMarker below. Returns '' (blank cell)
 * while the check is still pending. Keyed by root+T-child encoding since Relevancy depends on the
 * ROOT's own family, not just the T-child in isolation. */
function formatRelevancy(v: RelevancyVerdict): string {
  return v.kind === 'name' ? v.name : v.kind === 'position' ? quickLabel(v.ref) : 'none';
}

function relevancyMarker(rootEnc: string, rootGenome: AlphaGenome | FourGeneGenome, t: TChild): string {
  const key = `${rootEnc}|${t.enc}`;
  const cached = relevancyCache.get(key);
  if (cached !== undefined) return cached;
  if (!relevancyPending.has(key)) {
    relevancyPending.add(key);
    void computeRelevancy(rootGenome, t).then(result => {
      relevancyPending.delete(key);
      relevancyCache.set(key, formatRelevancy(result));
      scheduleRender();
    });
  }
  return '';
}

/** Genome to use for a position already resolved as an Advanced-Collection member/non-member --
 * short-circuits acMarker/isInAdvancedCollection entirely for anything the permanent AC_STORAGE_KEY
 * cache (loaded at startup, see loadAcResults) or this session already settled, which is the
 * pre-computation the user asked for: a position, once checked anywhere, never triggers the
 * recursive engine-call chain again. */
const acResult = new Map<string, boolean>();
const acPending = new Set<string>();

/** Is `enc` (a single-alpha position) either itself a named genome, OR a bigger, non-lowest-order
 * position that still qualifies for the same family per the user's rule: (1) its own (R,D,{L},{T'})
 * core matches a named family's exactly; (2) its own T-children are a superset of that family's
 * lowest-order T-children; and (3) every OTHER (extra) T-child has at least one T-child of its
 * own that's already in an Advanced Collection (checked recursively). Recursion only ever proceeds
 * to strictly smaller positions (a T-grandchild has fewer lives again than its own T-child), so
 * this always
 * terminates -- "calculate from the smallest positions upward" is naturally satisfied by evaluating
 * top-down and letting the base case (an exact GENOME_NAMES match) stop the recursion, rather than
 * needing an explicit precomputed bottom-up pass.
 *
 * `known`, when given, is a genome for `enc` already sitting in memory (an Entry's own genome, or a
 * T-child's nested `.genome`, populated up to collectAlpha.ts's depth/lives caps) -- reusing it
 * skips a redundant computeAlphaGenome() round-trip whenever it's already a complete AlphaGenome
 * (has a T array), and even a depth-capped FourGeneGenome (R/D/L/T' only, no T) is enough to reject
 * outright on a coreKey mismatch, which is the overwhelmingly common case (most positions don't
 * belong to any named family at all) -- so most calls never touch the engine a second time. */
const acCache = new Map<string, Promise<boolean>>();
function isInAdvancedCollection(enc: string, known?: AlphaGenome | FourGeneGenome): Promise<boolean> {
  const resolved = acResult.get(enc);
  if (resolved !== undefined) return Promise.resolve(resolved);
  const cached = acCache.get(enc);
  if (cached) return cached;
  const promise = (async (): Promise<boolean> => {
    if (known) {
      if (isNamedGenome(known)) return true;
      if (!NAMED_FAMILIES.some(f => f.coreKey === coreKeyOf(known))) return false;
    }
    const genome = (known && isFullGenome(known) ? known : undefined) ?? byEncGenome(enc) ?? (await computeAlphaGenome(enc))?.genome;
    if (!genome) return false;
    if (isNamedGenome(genome)) return true;

    const family = NAMED_FAMILIES.find(f => f.coreKey === coreKeyOf(genome));
    if (!family) return false;

    // Dedup by folded plain (first T-child wins), same convention genomeParts uses for display.
    const byPlain = new Map<string, TChild>();
    for (const t of genome.T) {
      const plain = await foldedPlainOfTChild(t);
      if (!byPlain.has(plain)) byPlain.set(plain, t);
    }

    if (!family.tChildPlains.every(w => byPlain.has(w))) return false;

    // Every OTHER (extra) T-child -- one beyond the lowest-order's own required set -- must
    // itself be in an Advanced Collection (named outright, or recursively qualifying by this same
    // rule): "any T move that's not the lowest order's T moves must have ... a child (through a T
    // move) that's in the Advanced Collection" -- the "child (through a T move)" IS the extra
    // T-child itself (that's what a T move produces), not one further step past it. A T-child with
    // no T-children of its own (e.g. an oplus-shifted copy of a lowest-order genome, T:[]) can
    // still satisfy this by being named directly -- see isNamedGenome's own oplus-suffix handling.
    for (const [plain, extra] of byPlain) {
      if (family.tChildPlains.includes(plain)) continue;
      const extraKnown = extra.genome ?? byEncGenome(extra.enc);
      if (!(await isInAdvancedCollection(extra.enc, extraKnown))) return false;
    }
    return true;
  })();
  acCache.set(enc, promise);
  void promise.then(result => {
    acResult.set(enc, result);
    saveAcResults();
  });
  return promise;
}

/** "!!" if `enc` is a confirmed (non-lowest-order) Advanced Collection member, else "" (including
 * while the check is still pending). Call only for genomes that already failed isNamedGenome --
 * an exact match gets "!" instead, from the caller. `known`, when available (an already-loaded
 * genome), lets isInAdvancedCollection skip redundant engine calls -- see its doc comment. */
function acMarker(enc: string, known?: AlphaGenome | FourGeneGenome): string {
  if (acResult.has(enc)) return acResult.get(enc) ? '!!' : '';
  if (!acPending.has(enc)) {
    acPending.add(enc);
    void isInAdvancedCollection(enc, known).then(result => {
      acPending.delete(enc);
      if (result) scheduleRender();
    });
  }
  return '';
}

function buildEntry(position: PositionRef, genome: AlphaGenome, lives: number | null): Entry {
  return { label: quickLabel(position), position, lives, genome, genomeFresh: true };
}

/** Build an Entry from a GENOME_DB hit -- no engine call needed up front, since the genome is
 * implied by the bucket key and each T-child already carries its own quick-canon form + nimber
 * (see collect_alpha_genetics.cpp). `oplus` is always 0 and `genomeFresh` is false here: the DB
 * predates quick-canon-split handling (see collectAlpha.ts's quickAlphaSplitOf) and nested [T]
 * genomes, so this is a stand-in, upgraded to a real computeAlphaGenome() result the first time this
 * entry is actually selected -- see selectEntry. */
function buildGenomeEntry(hit: GenomeHit, R: number, D: number, L: number[], Tprime: number[]): Entry {
  return { label: quickLabel(hit), position: hit, lives: hit.lives, genomeFresh: false,
    genome: { R, D, L, Tprime, oplus: 0, T: hit.T } };
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

async function loadGenome(raw: string): Promise<void> {
  const parsed = parseGenomeQuery(raw);
  if (!parsed) {
    status = "Couldn't parse that genome — expected a form like (0,1,{0},{}).";
    statusIsError = true;
    render();
    return;
  }

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

/** Renders the T section as a table with a Relevancy column, matching the paper's genome
 * sequencing table format (see the module header): each T-child's row shows its own position and
 * nimber, plus (once computed -- see relevancyMarker) whether it's one of the current entry's
 * primary named family's required children (shown as that family's name) or an "extra" one that
 * needs its own one-level bypass check (shown as the bypass position's label, or "none"). */
function renderTList(container: HTMLElement, rootEnc: string, rootGenome: AlphaGenome | FourGeneGenome, list: TChild[]): void {
  container.innerHTML = '';
  if (list.length === 0) {
    container.textContent = '(none)';
    return;
  }
  const table = document.createElement('table');
  table.className = 'collect-t-table';
  const head = table.insertRow();
  head.innerHTML = '<th>Position</th><th class="collect-t-relevancy-head">Relevancy</th>';
  for (const t of list) {
    const row = table.insertRow();
    row.className = 'collect-t-row collect-t-clickable';

    const tKnown = t.genome ?? byEncGenome(t.enc);
    const named = tKnown ? isNamedGenome(tKnown) : false;
    const bang = named ? '!' : acMarker(t.enc, tKnown);

    const label = row.insertCell();
    label.className = 'collect-t-label';
    label.textContent = quickLabel(t) + bang;

    const relevancy = row.insertCell();
    const relText = relevancyMarker(rootEnc, rootGenome, t);
    relevancy.className = 'collect-t-relevancy' + (relText === 'none' ? ' collect-t-relevancy-none' : '');
    relevancy.textContent = relText;

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
      <span class="collect-detail-label">${entry.label}</span>
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
  if (tEl) renderTList(tEl, entry.position.enc, genome, genome.T);

  const genomeEl = document.getElementById('collect-detail') as HTMLDivElement;
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

  const foldedTop = foldedPlainOf(genome, 0);
  let label = '';
  if (!foldedTop.startsWith('(')) {
    label = foldedTop;
  } else {
    const family = familyForGenome(genome);
    if (family && (await isInAdvancedCollection(position.enc, genome))) label = family.name;
  }

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

/** One `<details>` group for the Collections panel: `name`'s members (already-resolved Entry
 * objects, in history order) plus an always-present, italicized "(none)" placeholder when empty --
 * so every named family is visible in the tree even before anything's been found for it, per the
 * user's request to see "all of our named collections" at a glance, not just the nonempty ones. */
function renderCollectionGroup(name: string, members: Entry[]): string {
  // Known roster members straight from stalks/src/collections.cpp's registries (see
  // KNOWN_COLLECTION_MEMBERS's doc comment) -- schematic left-side shapes, not analyzed Collect
  // entries, so they're listed as plain, non-clickable reference text (no PositionRef behind them
  // to select). A real, analyzed Entry can legitimately fold to the EXACT same display text as one
  // of these (S_1/S_1⊕1's single-crit shapes are valid standalone positions, unlike S_3/S_4's,
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
  const items = allItems.length === 0 ? '<div class="collect-coll-empty">(none)</div>' : allItems.join('');
  // Only names in NAMED_GENOME_DEFS (S_1, S_1⊕1, C_3, C_4, S_5, S_7) actually stand for a real
  // single-alpha genome tuple -- S_3/S_4 (roster-only, two-crit) and "Other" have no entry, so no
  // genome text is shown for them.
  const genomeText = NAMED_FAMILY_GENOME_TEXT[name];
  const genomeHtml = genomeText
    ? `<span class="collect-coll-header-genome" title="${escapeHtml(genomeText)}">${escapeHtml(genomeText)}</span>`
    : '';
  return `<details class="collect-coll-group" open>
    <summary><span class="collect-coll-header-row"><span class="collect-coll-name">${escapeHtml(name)} <span class="collect-coll-count">(${members.length + staticLabels.length})</span></span>${genomeHtml}</span></summary>
    ${items}
  </details>`;
}

/** Render the Collections side panel (see index.html's #collect-collections-panel): every position
 * currently in `history` (i.e. every partial-position the user has looked at in this pane, quick-
 * canon-reduced same as everywhere else in Collect), grouped by which NAMED_FAMILIES entry it
 * belongs to -- exact match ("!") or Advanced-Collection member ("!!"), same test collect-t-table's
 * own bang markers use -- with everything else bucketed under "Other". A no-op (and leaves the
 * panel's previous content alone) while the panel is closed, so building this tree doesn't run
 * every render() call for no reason.
 *
 * The folder LIST is NAMED_FAMILIES' names (real, computable genome shapes: S_1, S_1⊕1, C_3, C_4,
 * S_5, S_7) unioned with COLLECTION_ROSTER_FOLDER_NAMES (every collection currently registered in
 * stalks/src/collections.cpp, straight from src/data/collectionsRoster.json -- S_3/S_4 today, but
 * also whatever's added there later) -- so a brand-new Stalks-side collection gets a folder (with
 * its static roster content, via KNOWN_COLLECTION_MEMBERS) with NO TypeScript change needed, even
 * before anyone teaches this file how to classify a REAL analyzed position into it.
 *
 * Reuses isNamedGenome/acMarker/familyForGenome rather than re-deriving membership: acMarker's
 * pending-check + re-render-on-resolve pattern means a freshly-added entry can briefly show under
 * Other until its "!!" check resolves, then move into its real family on the next render() --
 * exactly the same lazy-settle behavior the main list's own bang markers already have. */
function renderCollections(): void {
  const dialog = document.getElementById('collect-dialog');
  const panel = document.getElementById('collect-collections-panel');
  if (!dialog || !panel || !dialog.classList.contains('collections-open')) return;

  const byFamily = new Map<string, Entry[]>();
  const other: Entry[] = [];
  for (const entry of history) {
    const named = isNamedGenome(entry.genome);
    const bang = named ? '!' : acMarker(entry.position.enc, entry.genome);
    const family = named || bang === '!!' ? familyForGenome(entry.genome) : undefined;
    if (family) {
      if (!byFamily.has(family.name)) byFamily.set(family.name, []);
      byFamily.get(family.name)!.push(entry);
    } else {
      other.push(entry);
    }
  }

  const folderNames = [...new Set([...COLLECTION_ROSTER_FOLDER_NAMES, ...NAMED_FAMILIES.map(f => f.name)])];
  let html = '';
  for (const name of folderNames) {
    html += renderCollectionGroup(name, byFamily.get(name) ?? []);
  }
  html += renderCollectionGroup('Other', other);
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
    // "!" flags positions whose own genome folds entirely to a named genome (see GENOME_NAMES) --
    // not just containing one as a T-child, but BEING one at the top level. "!!" flags a bigger
    // position that isn't itself named but still qualifies for the family per the Advanced
    // Collection rule (see isInAdvancedCollection).
    const bang = isNamedGenome(entry.genome) ? '!' : acMarker(entry.position.enc, entry.genome);
    btn.innerHTML =
      `<span class="collect-entry-label">${escapeHtml(entry.label)}${bang}</span>` +
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
  loadAcResults();

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
      const trimmed = expandGenomeShorthand(input.value.trim());
      if (trimmed.startsWith('(')) {
        void loadGenome(trimmed);
      } else {
        void runSearch(input.value);
      }
    }
  });

  render();
}
