/**
 * Collect: type a position encoding containing exactly one alpha ('a') token to see its genome --
 * (R, D, {L}, {T'}, [T]) -- computed directly from the engine's own movetype classification (see
 * src/model/collectAlpha.ts). R and D are single nimbers (the "vanish"/"become a scab" moves,
 * movetypes 1/2); {L} and {T'} are deduped nimber sets (moves that connect within the position, or
 * isolate-and-decay it, movetypes 3/4); [T] is the list of positions reached by every move that
 * leaves alpha untouched (movetype 5), each shown in canon (bracket/⊕) form and clickable to open
 * as its own entry.
 *
 * Every displayed position (the active entry itself, and each T witness) is shown in its
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
 * engine call needed since the genome (and each T witness, quick-canon form included) is already
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
  type PositionRef,
  type TWitness,
  computeAlphaGenome,
  expandGenomeShorthand,
  genomeKey,
  parseGenomeQuery,
} from '../model/collectAlpha';
import genomeDbJson from '../data/collectAlphaGenomes.json';

interface GenomeHit extends PositionRef {
  lives: number;
  T: (PositionRef & { nimber: number })[];
}

const GENOME_DB = genomeDbJson as unknown as Record<string, GenomeHit[]>;

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

const HISTORY_STORAGE_KEY = 'sprouts-collect-alpha-v2';

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

/** Record a variation at the front of history (most-recent-first, deduped by label). */
function addToHistory(entry: Entry): void {
  history = [entry, ...history.filter(h => h.label !== entry.label)];
  saveHistory();
}

function markAlpha(enc: string): string {
  return enc.replace('a', 'α');
}

/** Quick-canon display label for a position reference -- see the module header. */
function quickLabel(ref: PositionRef): string {
  return bracketDisplay(markAlpha(ref.quickEnc)) + (ref.quickOffset ? ' ⊕ 1' : '');
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
 * so [T] can be deduped by its PLAIN-text representation (two witnesses whose genomes print
 * identically are the same gene, even if they're different positions) while still producing
 * depth-colored HTML for display. A witness with no computed nested genome (over the lives cap --
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
    return { plain, html: `<span class="${cls}">${escapeHtml(plain)}</span>` };
  }

  const seen = new Set<string>();
  const childPlains: string[] = [];
  const childHtmls: string[] = [];
  for (const t of g.T) {
    const child = t.genome
      ? genomeParts(t.genome, depth + 1)
      : { plain: quickLabel(t), html: `<span class="${depthClass(depth + 1)}">${escapeHtml(quickLabel(t))}</span>` };
    if (seen.has(child.plain)) continue;
    seen.add(child.plain);
    childPlains.push(child.plain);
    childHtmls.push(child.html);
  }

  const plain = `${head},[${childPlains.join(',')}])${oplusSuffix}`;
  const html =
    `<span class="${cls}">${escapeHtml(head)},[</span>` +
    childHtmls.join(`<span class="${cls}">,</span>`) +
    `<span class="${cls}">])${escapeHtml(oplusSuffix)}</span>`;
  return { plain, html };
}

function buildEntry(position: PositionRef, genome: AlphaGenome, lives: number | null): Entry {
  return { label: quickLabel(position), position, lives, genome, genomeFresh: true };
}

/** Build an Entry from a GENOME_DB hit -- no engine call needed up front, since the genome is
 * implied by the bucket key and each T witness already carries its own quick-canon form + nimber
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
    addToHistory(buildGenomeEntry(hits[i], parsed.R, parsed.D, parsed.L, parsed.Tprime));
  }
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

function renderTList(container: HTMLElement, list: TWitness[]): void {
  container.innerHTML = '';
  if (list.length === 0) {
    container.textContent = '(none)';
    return;
  }
  for (const t of list) {
    const row = document.createElement('div');
    row.className = 'collect-t-row collect-t-clickable';

    const label = document.createElement('span');
    label.className = 'collect-t-label';
    label.textContent = quickLabel(t);

    const nimber = document.createElement('span');
    nimber.className = 'collect-t-nimber';
    nimber.textContent = String(t.nimber);

    row.appendChild(label);
    row.appendChild(nimber);
    row.addEventListener('click', () => void selectTEntry(t));
    row.addEventListener('mouseenter', () => renderPreview(t));
    row.addEventListener('mouseleave', () => renderPreview(null));

    container.appendChild(row);
  }
}

/** Render (or clear) the hover-preview area beneath the main genome table -- a SEPARATE element
 * from the T-list itself, updated in place rather than via a full renderDetail() call, so hovering
 * a T row never rebuilds (and thus never detaches) the very row the mouse is over; doing that would
 * make the browser's mouseleave never fire on the now-removed element, leaving the preview stuck. */
function renderPreview(t: TWitness | null): void {
  const previewEl = document.getElementById('collect-preview');
  if (!previewEl) return;
  if (!t) {
    previewEl.innerHTML = '';
    return;
  }
  const livesStr = t.lives === undefined ? '' : ` — ${t.lives} lives`;
  // Just the genome STRING (same one-line, depth-colored format as the main header), not the fully
  // expanded nested table -- a hover preview is for a quick glance, not for exploring every nested
  // witness (that's what clicking the row, or hovering ITS own T rows once opened, is for). Colored
  // starting fresh at depth 0 (this witness's own R/D/L/T' in black), same convention as the active
  // entry's own header.
  const gs = t.genome ? genomeParts(t.genome, 0) : null;
  previewEl.innerHTML = `
    <div class="collect-detail-enc collect-preview-enc">
      <span class="collect-detail-label">${quickLabel(t)}${livesStr} (preview)</span>
      ${gs ? `<span class="collect-detail-genome" title="${escapeHtml(gs.plain)}">${gs.html}</span>` : ''}
    </div>
    ${gs ? '' : '<div class="collect-empty">No genome computed for this witness (over the lives cap) — click it to compute one fresh.</div>'}
  `;
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
      <tr><th>Move</th><th>Genome / witnessing positions</th></tr>
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
  const gsEl = genomeEl.querySelector<HTMLElement>('.collect-detail-genome');
  gsEl?.addEventListener('click', () => {
    const input = document.getElementById('collect-search-input') as HTMLInputElement;
    input.value = gsEl.dataset.genome ?? '';
    input.focus();
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
      `<span class="collect-entry-label">${entry.label}</span>` +
      `<span class="collect-entry-nimber">${entry.lives === null ? '' : entry.lives}</span>`;
    btn.addEventListener('click', () => selectEntry(entry.label));
    listEl.appendChild(btn);
  });

  renderDetail();
}

// Referenced only to keep genomeKey linked from this module's public surface for callers that may
// want to build a query string programmatically (e.g. clicking a genome elsewhere in the app).
export { genomeKey };

/** Wire the search input once; safe to call multiple times (each open just re-renders). */
export function initCollect(): void {
  if (wired) { render(); return; }
  wired = true;
  loadHistory();

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
