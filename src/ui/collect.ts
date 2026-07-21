/**
 * Collect: type a position encoding into the search bar (optionally marking one DisaPoint with a
 * trailing '*', e.g. "23A|A3*,13738") to see the "genetic code" of each DisaPoint it contains: the
 * nimber sets reachable via L (region-internal) and R (self-connect, branch disappears) moves, the
 * D (hypothetical scab-replace) nimber, and the list of T positions -- every other legal move of
 * the position, shown in canon (bracket/⊕) form. Every T position still contains the original
 * DisaPoint somewhere: a plain T keeps it a genuine DisaPoint (marked '*', same convention as the
 * search result label); a T' move instead strands it -- together with its detached partner -- as
 * its own inert [22] ⊕-summand (marked '*' on that summand instead; see TPositionMark). Each T
 * position also gets a trailing '?' when the Grandparent Bypass Theorem applies: this DisaPoint,
 * tracked through that move, has some grandchild-level descendant whose own (L,R,D) genetic code
 * exactly matches this one's.
 *
 * Limited to positions with 8 or fewer lives (counting each DisaPoint as one life) for now — see
 * the user's spec: beyond that the engine falls back to on-demand quick-canon nimber lookups,
 * which this feature doesn't attempt to handle yet.
 *
 * Known gap: when a search position has multiple structurally-identical components, the engine's
 * children list dedupes isomorphic results, which can make one DisaPoint's L-set look emptier
 * than a symmetric sibling DisaPoint's — see collectGenetics.ts's lMoveNimbers doc.
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
  type DisaPointRef,
  type DisaGeneticCode,
  type TPositionMark,
} from '../model/collectGenetics';

interface TEntry {
  formatted: string;
  bypass: boolean;
}

/** Render one T-move child in canon form (brackets + ⊕), with the surviving DisaPoint (or, in the
 * T' case, the isolated [22] ⊕-summand it decayed into) marked with '*' -- see TPositionMark. */
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
  dp: DisaPointRef;
  label: string;
  L: number[];
  R: number | null;
  D: number | null;
  T: TEntry[];
}

let wired = false;
let status = '';
let statusIsError = false;
let entries: Entry[] = [];
let activeIndex = 0;
let searchGen = 0;

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

async function runSearch(raw: string): Promise<void> {
  const myGen = ++searchGen;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    entries = [];
    status = '';
    statusIsError = false;
    render();
    return;
  }

  status = 'Searching…';
  statusIsError = false;
  entries = [];
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

  const computed = await Promise.all(
    disaPoints.map(async (dp, idx) => {
      const L = await lMoveNimbersRobust(result.canon, children, dp);
      const rEnc = buildRemoveEncoding(parsed, dp);
      const dEnc = buildReplaceEncoding(parsed, dp);
      const [rRes, dRes] = await Promise.all([analyze(rEnc), analyze(dEnc)]);
      const R = rRes.ok ? rRes.nimber : null;
      const D = dRes.ok ? dRes.nimber : null;
      const rootCode: DisaGeneticCode = { L, R, D };

      const { tChildren } = await classifyChildrenByDisaPoint(result.canon, children, dp, rRes.ok ? rRes.canon : null);
      const T = await Promise.all(
        tChildren.map(async child => {
          const { enc, mark, bypass } = await analyzeTEntry(result.canon, dp, child, rootCode);
          return { formatted: formatTPosition(enc, mark), bypass };
        }),
      );

      return {
        dp,
        label: markNth(display, idx + 1),
        L,
        R,
        D,
        T,
      };
    }),
  );
  if (myGen !== searchGen) return;

  entries = computed;
  activeIndex = Math.min(Math.max((selected ?? 1) - 1, 0), entries.length - 1);
  status = '';
  render();
}

function renderDetail(): void {
  const detailEl = document.getElementById('collect-detail') as HTMLDivElement;
  const entry = entries[activeIndex];
  if (!entry) {
    detailEl.innerHTML =
      '<div class="collect-empty">Type a position encoding above and press Enter to search — mark a specific DisaPoint with * (e.g. 23A|A3*,13738), or leave it unmarked to list every DisaPoint found.</div>';
    return;
  }
  const tCell =
    entry.T.length === 0
      ? '(none)'
      : entry.T.map(t => `<div class="collect-t-pos">${t.formatted}${t.bypass ? ' <span class="collect-bypass">?</span>' : ''}</div>`).join('');

  detailEl.innerHTML = `
    <div class="collect-detail-enc">${entry.label}</div>
    <table class="collect-code-table">
      <tr><th>Move</th><th>Child nimbers / positions</th></tr>
      <tr><td>L</td><td class="nimset">${fmtSet(entry.L)}</td></tr>
      <tr><td>R</td><td class="nimset">${fmtNimber(entry.R)}</td></tr>
      <tr><td>D</td><td class="nimset">${fmtNimber(entry.D)}</td></tr>
      <tr><td>T</td><td class="collect-t-cell">${tCell}</td></tr>
    </table>
  `;
}

function render(): void {
  const listEl = document.getElementById('collect-list') as HTMLDivElement;
  const statusEl = document.getElementById('collect-status') as HTMLDivElement;

  statusEl.textContent = status;
  statusEl.classList.toggle('error', statusIsError);

  listEl.innerHTML = '';
  entries.forEach((entry, idx) => {
    const btn = document.createElement('button');
    btn.className = 'collect-entry' + (idx === activeIndex ? ' active' : '');
    btn.textContent = entry.label;
    btn.addEventListener('click', () => {
      activeIndex = idx;
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

  const input = document.getElementById('collect-search-input') as HTMLInputElement;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runSearch(input.value);
    }
  });

  render();
}
