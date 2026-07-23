/**
 * Collect: type a position encoding into the search bar (optionally marking one DisaPoint with a
 * trailing '*', e.g. "23A|A3*,13738") to see the "genetic code" of each DisaPoint it contains: the
 * nimber sets reachable via L (region-internal) and R (self-connect, branch disappears) moves, the
 * D (hypothetical scab-replace) nimber, and the lists of T and T' positions -- every other legal
 * move of the position, shown in canon (bracket/⊕) form. Every T/T' position still contains the
 * original DisaPoint somewhere: a plain T move keeps it a genuine DisaPoint (marked '*', same
 * convention as the search result label) and is listed under "T"; a T' move instead strands it --
 * together with its detached partner -- as its own inert [22] ⊕-summand (marked '*' on that summand
 * instead; see TPositionMark) and is listed separately under "T'". Each T/T' position also gets a
 * trailing '?' when the Grandparent Bypass Theorem applies: this DisaPoint, tracked through that
 * move, has some grandchild-level descendant whose own (L,R,D) genetic code exactly matches this
 * one's.
 *
 * Typing a genome instead of a position -- anything starting with '(', e.g. "({0},1,1)" -- looks it
 * up in GENOME_DB (see src/data/collectGenomes.json, built by stalks/tools/collect_genetics.cpp)
 * and loads EVERY <=7-life position with that exact genome into the list on the left. GENOME_DB
 * only stores (enc, DisaPoint index, position nimber) per hit -- not T/T' -- so a genome-loaded
 * entry's T/T' rows are computed lazily, the first time it's actually opened (see fillDetail).
 *
 * Every DisaPoint variation ever searched or genome-loaded (or seeded as a default from the
 * ({0},1,1) and ({1},0,0) genomes, see seedDefaultHistory) is kept as a "variation" in the list on
 * the left, in quick-canon (bracket/⊕) form with '*' marking the DisaPoint, most-recently-viewed
 * first and deduped by that label. Each line also shows the variation's own nimber, right-aligned,
 * and so does every T/T' child position in the detail pane. The list persists across reloads via
 * localStorage; invalid/empty searches never get added to it.
 *
 * Limited to positions with 8 or fewer lives (counting each DisaPoint as one life) for now — see
 * the user's spec: beyond that the engine falls back to on-demand quick-canon nimber lookups,
 * which this feature doesn't attempt to handle yet.
 */

import { analyze, type ChildInfo } from '../engine/stalks';
import { display as bracketDisplay } from './positionBrowser';
import {
  parseEncoding,
  findDisaPoints,
  countLives,
  buildDisplayEncoding,
  buildRemoveEncoding,
  buildReplaceEncoding,
  lMoveNimbersRobust,
  classifyChildrenByDisaPoint,
  analyzeTEntry,
  toDisplayForm,
  computeGeneticCode,
  type DisaPointRef,
  type DisaGeneticCode,
  type TPositionMark,
} from '../model/collectGenetics';
import genomeDbJson from '../data/collectGenomes.json';

interface GenomeHit {
  enc: string;
  dp: number;
  nimber: number;
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

/** Render one T/T'-move child in canon form (brackets + ⊕), with the surviving DisaPoint (or, in
 * the T' case, the isolated [22] ⊕-summand it decayed into) marked with '*' -- see TPositionMark. */
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
  /** Quick-canon (bracket/⊕) form of the position, with '*' marking this DisaPoint. Doubles as the
   * dedup key for the variation list. */
  label: string;
  /** Nimber of the whole position this variation belongs to (same for every DisaPoint of one search). */
  nimber: number;
  L: number[];
  R: number | null;
  D: number | null;
  T: TEntry[];
  Tprime: TEntry[];
  /** False for a genome-loaded entry until fillDetail has computed its T/T' rows. Always true for
   * entries built via a normal position search (computeEntry computes everything eagerly). */
  tComputed: boolean;
  /** Only set on genome-loaded entries -- what fillDetail needs to compute T/T' lazily. */
  sourceEnc?: string;
  sourceDpIndex?: number;
}

function isEntry(x: unknown): x is Entry {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.label === 'string' &&
    typeof o.nimber === 'number' &&
    Array.isArray(o.L) &&
    Array.isArray(o.T) &&
    Array.isArray(o.Tprime) &&
    typeof o.tComputed === 'boolean'
  );
}

let wired = false;
let status = '';
let statusIsError = false;
let history: Entry[] = [];
let activeLabel: string | null = null;
let searchGen = 0;

const HISTORY_STORAGE_KEY = 'sprouts-collect-variations-v7';

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

/** Insert '*' right after the (1-indexed) nth '3' character in a display string. */
function markNth(display: string, n: number): string {
  let count = 0;
  for (let i = 0; i < display.length; i++) {
    if (display[i] === '3') {
      count++;
      if (count === n) return display.slice(0, i + 1) + '*' + display.slice(i + 1);
    }
  }
  return display;
}

/** Count '3' characters before the first '*' in raw input (1-indexed selection), and strip all '*'. */
function extractSelection(raw: string): { stripped: string; selected: number | undefined } {
  const starIdx = raw.indexOf('*');
  let selected: number | undefined;
  if (starIdx !== -1) {
    let count = 0;
    for (let i = 0; i < starIdx; i++) if (raw[i] === '3') count++;
    selected = count;
  }
  return { stripped: raw.replace(/\*/g, ''), selected };
}

// ---- genome key format: "({l1,l2,...},R,D)", L sorted ascending and deduped -- byte-identical
// to stalks/tools/collect_genetics.cpp's genomeKey, which built src/data/collectGenomes.json's keys.

function genomeKey(L: number[], R: number, D: number): string {
  const sorted = [...new Set(L)].sort((a, b) => a - b);
  return `({${sorted.join(',')}},${R},${D})`;
}

interface ParsedGenome {
  key: string;
  L: number[];
  R: number;
  D: number;
}

function parseGenomeQuery(input: string): ParsedGenome | null {
  const m = /^\(\{([0-9,\s]*)\}\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(input);
  if (!m) return null;
  const rawL = m[1].trim();
  const L = rawL.length === 0 ? [] : rawL.split(',').map(s => Number.parseInt(s.trim(), 10));
  if (L.some(n => Number.isNaN(n))) return null;
  const R = Number.parseInt(m[2], 10);
  const D = Number.parseInt(m[3], 10);
  const sorted = [...new Set(L)].sort((a, b) => a - b);
  return { key: genomeKey(sorted, R, D), L: sorted, R, D };
}

/** Build a (T/T'-pending) Entry directly from a GENOME_DB hit -- no analyze() call needed, since
 * `hit.enc` is already the decompressed canonical text and L/R/D are implied by the genome bucket. */
function buildGenomeEntry(hit: GenomeHit, L: number[], R: number, D: number): Entry {
  const parsed = parseEncoding(hit.enc);
  const disaPoints = findDisaPoints(parsed);
  const display = buildDisplayEncoding(parsed, disaPoints);
  return {
    label: bracketDisplay(markNth(display, hit.dp + 1)),
    nimber: hit.nimber,
    L,
    R,
    D,
    T: [],
    Tprime: [],
    tComputed: false,
    sourceEnc: hit.enc,
    sourceDpIndex: hit.dp,
  };
}

/** T/T' classification + formatting, shared by the eager (computeEntry) and lazy (fillDetail) paths. */
async function computeTAndTPrime(
  canonText: string,
  children: ChildInfo[],
  dp: DisaPointRef,
  rootCode: DisaGeneticCode,
  rCanon: string | null,
): Promise<{ T: TEntry[]; Tprime: TEntry[] }> {
  const { tChildren } = await classifyChildrenByDisaPoint(canonText, children, dp, rCanon);
  const classified = await Promise.all(
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
  return {
    T: classified.filter(c => c.mark.kind !== 'isolated').map(c => c.entry),
    Tprime: classified.filter(c => c.mark.kind === 'isolated').map(c => c.entry),
  };
}

/** (L,R,D) genome of a "T" entry's own surviving DisaPoint, computed on first hover/click and
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

/** Build a (T/T'-pending) Entry from a T-row's own genome, mirroring buildGenomeEntry -- same
 * lazy-T/T' shape, just sourced from a T-move child instead of a GENOME_DB hit. */
function buildEntryFromTEntry(t: TEntry, genome: DisaGeneticCode): Entry {
  return {
    label: t.label,
    nimber: t.nimber,
    L: genome.L,
    R: genome.R,
    D: genome.D,
    T: [],
    Tprime: [],
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
  children: ChildInfo[],
  rootNimber: number,
  dp: DisaPointRef,
  idx: number,
  display: string,
): Promise<Entry> {
  const parsed = parseEncoding(canonText);
  const L = await lMoveNimbersRobust(canonText, dp);
  const rEnc = buildRemoveEncoding(parsed, dp);
  const dEnc = buildReplaceEncoding(parsed, dp);
  const [rRes, dRes] = await Promise.all([analyze(rEnc), analyze(dEnc)]);
  const R = rRes.ok ? rRes.nimber : null;
  const D = dRes.ok ? dRes.nimber : null;
  const rootCode: DisaGeneticCode = { L, R, D };

  const { T, Tprime } = await computeTAndTPrime(canonText, children, dp, rootCode, rRes.ok ? rRes.canon : null);

  return {
    label: bracketDisplay(markNth(display, idx + 1)),
    nimber: rootNimber,
    L,
    R,
    D,
    T,
    Tprime,
    tComputed: true,
  };
}

/** Lazily fill in T/T' for a genome-loaded entry the first time it's actually viewed. Mutates
 * `entry` in place and persists the result so it's only ever computed once. */
async function fillDetail(entry: Entry): Promise<void> {
  if (entry.tComputed || entry.sourceEnc === undefined || entry.sourceDpIndex === undefined) return;

  const result = await analyze(entry.sourceEnc);
  if (!result.ok) {
    entry.tComputed = true;
    return;
  }
  const parsed = parseEncoding(result.canon);
  const disaPoints = findDisaPoints(parsed);
  const dp = disaPoints[entry.sourceDpIndex];
  if (!dp) {
    entry.tComputed = true;
    return;
  }

  const rRes = await analyze(buildRemoveEncoding(parsed, dp));
  const rootCode: DisaGeneticCode = { L: entry.L, R: entry.R, D: entry.D };
  const { T, Tprime } = await computeTAndTPrime(result.canon, result.children, dp, rootCode, rRes.ok ? rRes.canon : null);

  entry.T = T;
  entry.Tprime = Tprime;
  entry.tComputed = true;
  saveHistory();
}

/** Populate the persistent variation list with every position matching the ({0},1,1) and
 * ({1},0,0) genomes from GENOME_DB, as sensible defaults to browse before any search has run. */
function seedDefaultHistory(): void {
  const seen = new Set<string>();
  const seeded: Entry[] = [];
  const defaults: { L: number[]; R: number; D: number }[] = [
    { L: [0], R: 1, D: 1 },
    { L: [1], R: 0, D: 0 },
  ];
  for (const { L, R, D } of defaults) {
    const hits = GENOME_DB[genomeKey(L, R, D)] ?? [];
    for (const hit of hits) {
      const entry = buildGenomeEntry(hit, L, R, D);
      if (seen.has(entry.label)) continue;
      seen.add(entry.label);
      seeded.push(entry);
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

/** Look up a genome query and load every matching <=7-life position into history. */
function loadGenome(raw: string): void {
  const parsedGenome = parseGenomeQuery(raw);
  if (!parsedGenome) {
    status = `Couldn't parse that genome — expected a form like ({0,1},2,3).`;
    statusIsError = true;
    render();
    return;
  }

  const hits = GENOME_DB[parsedGenome.key];
  if (!hits || hits.length === 0) {
    status = `No positions with genome ${parsedGenome.key} found (8 or fewer lives).`;
    statusIsError = true;
    render();
    return;
  }

  // A genome search replaces the list rather than appending to it, so it's always clear that
  // every entry on screen shares this exact genome (anything looked at afterward re-appends normally).
  history = [];
  const entries = hits.map(hit => buildGenomeEntry(hit, parsedGenome.L, parsedGenome.R, parsedGenome.D));
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
  const children: ChildInfo[] = result.children;

  const computed = await Promise.all(disaPoints.map((dp, idx) => computeEntry(result.canon, children, result.nimber, dp, idx, display)));
  if (myGen !== searchGen) return;

  for (let i = computed.length - 1; i >= 0; i--) addToHistory(computed[i]);
  const pick = computed[Math.min(Math.max((selected ?? 1) - 1, 0), computed.length - 1)];
  activeLabel = pick.label;
  status = '';
  render();
}

function fmtGenome(g: DisaGeneticCode): string {
  return `L=${fmtSet(g.L)}  R=${fmtNimber(g.R)}  D=${fmtNimber(g.D)}`;
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
      '<div class="collect-empty">Type a position encoding above and press Enter to search — mark a specific DisaPoint with * (e.g. 23A|A3*,13738) — or type a genome like ({0},1,1) to load every matching position.</div>';
    return;
  }

  if (!entry.tComputed) {
    void fillDetail(entry).then(() => {
      if (activeLabel === entry.label) renderDetail();
    });
  }

  const tCell = entry.tComputed ? '' : '<span class="collect-t-pending">computing…</span>';
  const tpCell = entry.tComputed ? '' : '<span class="collect-t-pending">computing…</span>';

  detailEl.innerHTML = `
    <div class="collect-detail-enc">${entry.label}</div>
    <table class="collect-code-table">
      <tr><th>Move</th><th>Child nimbers / positions</th></tr>
      <tr><td>L</td><td class="nimset">${fmtSet(entry.L)}</td></tr>
      <tr><td>R</td><td class="nimset">${fmtNimber(entry.R)}</td></tr>
      <tr><td>D</td><td class="nimset">${fmtNimber(entry.D)}</td></tr>
      <tr><td>T</td><td class="collect-t-cell" id="collect-t-cell">${tCell}</td></tr>
      <tr><td>T'</td><td class="collect-t-cell" id="collect-tprime-cell">${tpCell}</td></tr>
    </table>
  `;

  if (entry.tComputed) {
    const tEl = document.getElementById('collect-t-cell');
    const tpEl = document.getElementById('collect-tprime-cell');
    if (tEl) renderTCell(tEl, entry.T);
    if (tpEl) renderTCell(tpEl, entry.Tprime);
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
  history.forEach(entry => {
    const btn = document.createElement('button');
    btn.className = 'collect-entry' + (entry.label === activeLabel ? ' active' : '');
    btn.innerHTML = `<span class="collect-entry-label">${entry.label}</span><span class="collect-entry-nimber">${entry.nimber}</span>`;
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
