/**
 * Position Browser: a web-browser-style tool for inspecting Stalks analysis data about a position.
 *
 * Opens on the live gameplay position by default. For any position whose minimal subpositions each
 * have <= 12 lives, the engine runs automatically (WASM) and the result is displayed. Positions with
 * 13-16 lives are not analyzed automatically -- they show two "Calculate" buttons (full game tree /
 * quick-canon nimber) that run the engine on demand. Anything larger shows a "can't show this" notice.
 * Results are cached (see positionCache) for instant recall and to accumulate metadata / known-parent
 * links about other positions in the game tree.
 *
 * The address bar + back/forward arrows navigate a session history of exactly what the user looked
 * up (the input text they used, not just its canon), like browser history. Double-clicking a child
 * or a known parent navigates there.
 *
 * Hovering a child row (that carries move identity, i.e. exact/canon children, not quick-canon
 * reps) previews the move as a dashed line on the live playfield via setMoveCallbacks' onPreview
 * — but only makes sense when the browsed position is also the game's current live state; main.ts
 * is responsible for checking isShowingLive() before resolving/drawing anything. Clicking a row
 * locks the preview (hover on other rows has no effect until unlocked via Escape or clicking the
 * locked row again).
 *
 * The "Sync to game" toggle (#pb-tog-sync) switches the panel between two modes:
 *   - Sync OFF (free browse): the address bar accepts manual entry, back/forward walk the session
 *     visit-history, double-clicking a child or known parent just navigates the browser there, and
 *     the panel does NOT auto-follow the live game.
 *   - Sync ON (default): the panel is locked to the live game. The address bar is disabled (no
 *     manual entry), back/forward drive the live game's undo/redo (via setSyncCallbacks — main.ts
 *     owns the game history), double-clicking a move-bearing child plays that move on the live board
 *     via onConfirm (the panel then follows automatically, since main.ts's live-follow calls
 *     notifyLivePosition after every render), and Known Parents / non-move rows are not navigable.
 */
import {
  analyze,
  analyzeFull,
  analyzeNimber,
  canon,
  type AnalysisOk,
  type AnalysisResult,
  type AnalysisErr,
  type ChildInfo,
  type MoveInfo,
  type QuickAnalysisOk,
  type QuickCanon,
  type QuickChildInfo,
  UNKNOWN_VALUE,
} from '../engine/stalks';
import { getFull, getMeta, getParents, record, type LightMeta } from '../model/positionCache';

/** A result built purely from cached metadata (e.g. the preloaded master-save seed) for a position
 * too large for the WASM engine's on-demand size gate — no children/quickCanon available. */
interface MetaOnlyOk {
  ok: true;
  reason: 'meta-only';
  canon: string;
  nimber: number;
  minMoves: number;
  maxMoves: number;
}

/** A rendered view: either a standard analysis result or an on-demand quick-canon nimber result. */
type View = AnalysisResult | QuickAnalysisOk | MetaOnlyOk;

// --- move hover/lock preview (see file header) -----------------------------------------------

/** A move paired with the canon encoding it's supposed to reach — main.ts verifies candidate
 * strokes against `targetEnc` (not just the endpoint pair) so it can reject strokes that cross
 * existing geometry or land on the wrong enclosure/mask variant. */
export interface MovePreviewTarget {
  move: MoveInfo;
  targetEnc: string;
}

let onPreviewCb: ((target: MovePreviewTarget | null) => void) | null = null;
let onConfirmCb: ((target: MovePreviewTarget) => void) | null = null;
let onChildrenBatchCb: ((targets: MovePreviewTarget[]) => void) | null = null;

/** Wire the hover-preview / Enter-to-confirm callbacks (main.ts owns live-state resolution).
 * `onChildrenBatch` (optional) fires once per render with every move-bearing child row on the
 * live position's list, so main.ts can precompute+cross-check all of them up front rather than
 * only whichever single row is currently hovered — see strokeSynthesis's "misidentified sibling"
 * cross-check in synthesizeVerifiedMove. */
export function setMoveCallbacks(cbs: {
  onPreview: (target: MovePreviewTarget | null) => void;
  onConfirm: (target: MovePreviewTarget) => void;
  onChildrenBatch?: (targets: MovePreviewTarget[]) => void;
}): void {
  onPreviewCb = cbs.onPreview;
  onConfirmCb = cbs.onConfirm;
  onChildrenBatchCb = cbs.onChildrenBatch ?? null;
}

// --- sync mode (see file header) -------------------------------------------------------------
// In sync mode the panel is locked to the live game. The undo/redo actions and their availability
// live in main.ts (which owns the game history), so they're injected via setSyncCallbacks; the
// browser only decides *when* to call them (its back/forward arrows) based on the toggle.
export interface SyncCallbacks {
  onBack: () => void;       // live-game undo
  onForward: () => void;    // live-game redo
  canBack: () => boolean;   // is undo available?
  canForward: () => boolean; // is redo available?
}
let syncCbs: SyncCallbacks | null = null;
let syncModeListener: (() => void) | null = null;

export function setSyncCallbacks(cbs: SyncCallbacks): void { syncCbs = cbs; }
/** Notified whenever the Sync toggle flips — lets main.ts jump the panel to live / wake its loop. */
export function onSyncModeChange(cb: () => void): void { syncModeListener = cb; }
/** Whether the panel is currently locked to the live game (Sync toggle on). */
export function isSyncMode(): boolean { return syncToggle?.checked ?? false; }

/** Programmatically flip the Sync toggle (e.g. when the player hits Play) — mirrors a real
 *  user click, including the onSyncToggleChange side effects (address-bar lock, nav-button
 *  refresh, live-position snap via the onSyncModeChange listener). No-op if already at `on`. */
export function setSyncMode(on: boolean): void {
  ensureWired();
  if (syncToggle.checked === on) return;
  syncToggle.checked = on;
  onSyncToggleChange();
}

/** Enable/disable the Sync toggle itself (e.g. locked off pre-Play so a beginner can't lock the
 *  address bar before they've started a game). */
export function setSyncToggleEnabled(enabled: boolean): void {
  ensureWired();
  syncToggle.disabled = !enabled;
}

let lockedMove: MovePreviewTarget | null = null;
let lockedRowEl: HTMLDivElement | null = null;

function previewMove(target: MovePreviewTarget | null): void {
  onPreviewCb?.(target);
}

function lockMove(target: MovePreviewTarget, rowEl: HTMLDivElement): void {
  lockedRowEl?.classList.remove('locked');
  lockedMove = target;
  lockedRowEl = rowEl;
  rowEl.classList.add('locked');
  previewMove(target);
}

function clearLock(): void {
  lockedRowEl?.classList.remove('locked');
  lockedMove = null;
  lockedRowEl = null;
  previewMove(null);
}

/** Discriminate the quick-canon nimber view (ok result carrying reason:'quick'). */
function isQuick(v: View): v is QuickAnalysisOk {
  return v.ok && 'reason' in v && v.reason === 'quick';
}

/** Discriminate the meta-only view (ok result carrying reason:'meta-only'). */
function isMetaOnly(v: View): v is MetaOnlyOk {
  return v.ok && 'reason' in v && v.reason === 'meta-only';
}

/**
 * Combined metadata for a canonical encoding, direct or as a disjoint sum of parts already in the
 * cache (nimbers XOR, move bounds add) — mirrors the engine's own allComponentsKnown/valueOf combine
 * rule. Lets a large sum bypass the size gate as soon as every one of its parts is individually
 * known (e.g. from the preloaded master-save seed), even if the whole sum was never stored as one row.
 */
function metaOfCanon(canonEnc: string): LightMeta | undefined {
  const direct = getMeta(canonEnc);
  if (direct) return direct;
  const parts = canonEnc.split('+');
  if (parts.length < 2) return undefined;
  let nimber = 0;
  let minMoves = 0;
  let maxMoves = 0;
  let subposCount = 0;
  for (const part of parts) {
    if (part === 'N') continue; // the dead subposition contributes nothing
    const m = getMeta(part);
    if (!m) return undefined;
    nimber ^= m.nimber;
    minMoves += m.minMoves;
    maxMoves += m.maxMoves;
    subposCount += m.subposCount;
  }
  return { nimber, minMoves, maxMoves, subposCount };
}

/** Backfill any UNKNOWN_VALUE child nimbers from cached metadata (e.g. the preloaded master-save
 * seed) — the child encodings from unvaluedChildren() are already canonical, so metaOfCanon can be
 * looked up directly with no extra canon() call. */
function backfillChildren(children: ChildInfo[]): ChildInfo[] {
  return children.map(c => {
    if (c.nimber !== UNKNOWN_VALUE) return c;
    const m = metaOfCanon(c.enc);
    return m ? { ...c, nimber: m.nimber, minMoves: m.minMoves, maxMoves: m.maxMoves } : c;
  });
}

/**
 * Reconstruct a full AnalysisOk purely from cached metadata (the preloaded master-save seed) plus
 * the cheap, size-gate-free child enumeration the engine already returned for a 'needs-calculation'
 * or 'too-large' result — no on-demand WASM valuation (analyzeFull) needed at all. This is what
 * makes "Calculate Game Tree" (and the auto-open page) instant for positions the master save already
 * fully covers: for n<=6 spots, master_meta.json holds every reachable node's value, so "solving" is
 * just a cache lookup instead of a real recursive game-tree search.
 *
 * quickChildren/graphMeta are necessarily a shallower approximation than a real analyzeFull() would
 * give (quickChildren dedups only the immediate play-children we already have on hand; graphMeta is
 * left empty since we don't walk beyond one level) — acceptable since record() below still derives
 * root+immediate-child metadata/parent-edges from `children` directly, independent of graphMeta.
 */
function buildMasterBackedOk(
  canonEnc: string,
  rootMeta: LightMeta,
  quickCanonRoot: QuickCanon | undefined,
  rawChildren: ChildInfo[],
): AnalysisOk {
  const children = backfillChildren(rawChildren);

  const parts = canonEnc.split('+').filter(p => p !== 'N');
  const nimberBreakdown = parts.length > 1
    ? parts.map(p => metaOfCanon(p)?.nimber ?? 0)
    : [rootMeta.nimber];

  const quickChildren: QuickChildInfo[] = [];
  const seen = new Set<string>();
  for (const c of children) {
    const qc = c.quickCanon ?? { enc: c.enc, offset: 0 };
    const key = `${qc.enc}|${qc.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quickChildren.push({ enc: qc.enc, offset: qc.offset, nimber: c.nimber, subposCount: c.subposCount });
  }

  return {
    ok: true,
    canon: canonEnc,
    nimber: rootMeta.nimber,
    minMoves: rootMeta.minMoves,
    maxMoves: rootMeta.maxMoves,
    subposCount: rootMeta.subposCount,
    nimberBreakdown,
    children,
    quickCanon: quickCanonRoot ?? { enc: canonEnc, offset: 0 },
    quickChildren,
    graphMeta: [],
  };
}

interface HistEntry {
  inputText: string; // the exact text the user navigated with
  canonEnc: string; // canonical encoding (may be '' if unparseable / engine unavailable)
}

// --- module state ---------------------------------------------------------------------------

let overlay: HTMLDivElement;
let addressInput: HTMLInputElement;
let backBtn: HTMLButtonElement;
let forwardBtn: HTMLButtonElement;
let body: HTMLDivElement;
let notifyMessages: HTMLDivElement; // top-justified area for transient notes/errors (see notify())
let calculatingEl: HTMLDivElement; // "Calculating…" banner, centered in the space left below notifyMessages
let togglesEl: HTMLDivElement; // the toggles row, relocated into #pb-body just above the lists
let quickToggle: HTMLInputElement; // Quick-Canon: children list is quick-canon vs standard canon
let winningToggle: HTMLInputElement; // Highlight Winning: green winning moves (canon mode only)
let nimbersToggle: HTMLInputElement; // Nimbers: show the per-move nimber column
let syncToggle: HTMLInputElement; // Sync to game: panel locked to the live game (back/forward = undo/redo, dblclick commits, no manual entry / parent nav)

let history: HistEntry[] = [];
let index = -1;
let navToken = 0; // guards against out-of-order async renders
let lastResult: View | null = null; // last rendered result, for re-render on toggle change

// Session-only cache of on-demand quick-canon nimber results, keyed by canon. Full (exact) results
// are cached in positionCache (localStorage); quick results are cheap-ish and kept in memory only,
// so navigating back to a quick-calculated big position restores it without re-computing this run.
const quickCache = new Map<string, QuickAnalysisOk>();

/** Current toggle state. Winning highlight is meaningful only in canon mode (needs exact nimbers). */
function toggles(): { quick: boolean; winning: boolean; nimbers: boolean } {
  const quick = quickToggle.checked;
  return { quick, winning: winningToggle.checked && !quick, nimbers: nimbersToggle.checked };
}

// --- display helpers ------------------------------------------------------------------------

/** Re-add display brackets: components are '+'-separated; wrap each (a dead 'N' stays bare). */
export function display(enc: string): string {
  if (!enc) return '(none)';
  return enc
    .split('+')
    .map(c => (c === 'N' ? 'N' : `[${c}]`))
    .join(' ⊕ ');
}

/** Quick-canon display: the rep in bracket form, tagged with its ⊕1 offset when the offset is 1. */
function displayQuick(enc: string, offset: number): string {
  return display(enc) + (offset ? ' ⊕ 1' : '');
}

function cmpChildren(a: ChildInfo, b: ChildInfo): number {
  return a.nimber - b.nimber || a.subposCount - b.subposCount || a.enc.localeCompare(b.enc);
}

function cmpQuickChildren(a: QuickChildInfo, b: QuickChildInfo): number {
  return (
    a.nimber - b.nimber ||
    a.subposCount - b.subposCount ||
    a.enc.localeCompare(b.enc) ||
    a.offset - b.offset
  );
}

// --- analysis with cache --------------------------------------------------------------------

async function analyzeCached(inputText: string): Promise<{ result: View; canonEnc: string }> {
  const canonEnc = await canon(inputText);
  if (canonEnc) {
    const cached = getFull(canonEnc);
    if (cached) return { result: cached, canonEnc };
    const quick = quickCache.get(canonEnc);
    if (quick) return { result: quick, canonEnc };
  }
  const result = await analyze(inputText);
  if (result.ok) {
    record(result);
    return { result, canonEnc: result.canon };
  }
  // The engine declined to auto-analyze this (needs-calculation or too-large), but it always
  // returns the cheap, size-gate-free immediate-children enumeration for both -- if the root's own
  // value is ALSO already sitting in cached metadata (e.g. the preloaded master-save seed, which
  // covers every reachable node up to 6 spots), we can skip the WASM engine's real (potentially
  // slow) game-tree search entirely and reconstruct a full result straight from the cache. This is
  // what makes "Calculate Game Tree" (and the auto-open page) instant for e.g. the 4/5-spot
  // starting positions instead of forcing an on-demand recompute that master save already made
  // redundant.
  if (result.children && canonEnc) {
    const rootMeta = metaOfCanon(canonEnc);
    if (rootMeta) {
      const masterResult = buildMasterBackedOk(canonEnc, rootMeta, result.quickCanon, result.children);
      record(masterResult);
      return { result: masterResult, canonEnc };
    }
  }
  // Above, but with no children returned either (too-large, above even the cheap-children cap) --
  // if every part of the already-canonicalized position is covered by cached metadata, we still
  // know its value even with nothing else to show. See renderError's too-large branch for how
  // cached meta is still surfaced alongside a children list when available.
  if (result.reason === 'too-large' && !result.children && canonEnc) {
    const meta = metaOfCanon(canonEnc);
    if (meta) {
      const metaResult: MetaOnlyOk = {
        ok: true,
        reason: 'meta-only',
        canon: canonEnc,
        nimber: meta.nimber,
        minMoves: meta.minMoves,
        maxMoves: meta.maxMoves,
      };
      return { result: metaResult, canonEnc };
    }
  }
  return { result, canonEnc };
}

// --- rendering ------------------------------------------------------------------------------

/**
 * Whether the Canon Encoding field would just duplicate the panel's own "live position
 * encoding" row (see main.ts) directly above #pb-body. That row always tracks the live game
 * position — not necessarily whatever's browsed — so this is only true in the wide panel
 * while showing the live position; navigating away (or the narrow modal) still needs the
 * field since nothing else displays the browsed position's canon there.
 */
function canonFieldRedundant(): boolean {
  const inPanel = document.getElementById('position-browser-panel')?.classList.contains('wide') ?? false;
  return inPanel && isShowingLive();
}

/** Clear the notification area (called at the start of every render). */
function clearNotify(): void {
  notifyMessages.innerHTML = '';
  calculatingEl.classList.remove('visible');
}

/** Post a transient note/error into the notification area instead of inline in the body. */
function notify(text: string, kind: 'note' | 'error' = 'note'): void {
  const el = document.createElement('div');
  el.className = kind === 'error' ? 'pb-error' : 'pb-note';
  el.textContent = text;
  notifyMessages.appendChild(el);
}

/** Unique-child count and winning-move count for the top stats row. `winning` is '?' when any
 * child's nimber isn't known yet (e.g. immediate children of a too-large position). */
function childStats(children: { enc: string; nimber?: number }[] | undefined): {
  count: number;
  winning: string;
} {
  if (!children || children.length === 0) return { count: 0, winning: '0' };
  const count = new Set(children.map(c => c.enc)).size;
  const hasUnknown = children.some(c => c.nimber === undefined || c.nimber === UNKNOWN_VALUE);
  const winning = hasUnknown ? '?' : String(children.filter(c => c.nimber === 0).length);
  return { count, winning };
}

function field(label: string, valueEl: HTMLElement | string, placeholder = false): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'pb-field';
  const l = document.createElement('div');
  l.className = 'pb-label';
  l.textContent = label;
  row.appendChild(l);
  if (typeof valueEl === 'string') {
    const v = document.createElement('div');
    v.className = 'pb-value' + (placeholder ? ' placeholder' : '');
    v.textContent = valueEl;
    row.appendChild(v);
  } else {
    valueEl.classList.add('pb-value');
    row.appendChild(valueEl);
  }
  return row;
}

interface ListEntry {
  enc: string; // navigated (in display form) on double-click
  label?: string; // shown main text; defaults to display(enc) — used for the ⊕1 quick-canon tag
  nimber?: number; // value for the right-justified Nimber column (when opts.showNimber)
  winning?: boolean; // green-highlight this row (when opts.highlightWinning)
  move?: MoveInfo; // which move on the parent reaches this child (engine index space; undefined for quick-canon children)
}

/**
 * A full-width scrollable list (5 rows visible via CSS) with a column-header row. The `label`
 * becomes the left header of the encodings column; the right header slot reads "Nimber" when
 * `opts.showNimber` (and is otherwise blank, so toggling nimbers fills the header in place rather
 * than inserting one and shifting the layout). Each entry double-clicks to open `enc` (navigated
 * in its `display` form). When `highlightWinning`, winning rows get a green background.
 */
function listField(
  label: string,
  entries: ListEntry[],
  emptyText: string,
  opts: { showNimber: boolean; highlightWinning: boolean },
): HTMLDivElement {
  const field = document.createElement('div');
  field.className = 'pb-list-field';

  const head = document.createElement('div');
  head.className = 'pb-list-head';
  const headMain = document.createElement('span');
  headMain.className = 'pb-head-main';
  headMain.textContent = label;
  head.appendChild(headMain);
  const headNim = document.createElement('span');
  headNim.className = 'pb-head-nim';
  headNim.textContent = opts.showNimber ? 'Nimber' : '';
  head.appendChild(headNim);
  field.appendChild(head);

  // Notify main.ts of every move-bearing row in this list in one shot (only meaningful while
  // showing the live position, since main.ts resolves moves against the live GameState) — lets it
  // precompute+cross-check every child's candidate strokes up front instead of one hover at a time.
  const moveTargets = entries.filter((e): e is ListEntry & { move: NonNullable<ListEntry['move']> } => !!e.move);
  if (moveTargets.length > 0 && isShowingLive()) {
    onChildrenBatchCb?.(moveTargets.map(e => ({ move: e.move, targetEnc: e.enc })));
  }

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pb-list empty';
    empty.textContent = emptyText;
    field.appendChild(empty);
    return field;
  }

  const list = document.createElement('div');
  list.className = 'pb-list';
  for (const e of entries) {
    const r = document.createElement('div');
    r.className = 'pb-list-row' + (opts.highlightWinning && e.winning ? ' winning' : '');
    r.title = 'Double-click to open';
    const main = document.createElement('span');
    main.className = 'pb-row-main';
    main.textContent = e.label ?? display(e.enc);
    r.appendChild(main);
    if (opts.showNimber) {
      const nim = document.createElement('span');
      nim.className = 'pb-row-nim';
      nim.textContent =
        e.nimber === undefined ? '' : e.nimber === UNKNOWN_VALUE ? '?' : String(e.nimber);
      r.appendChild(nim);
    }
    if (e.move) {
      const target: MovePreviewTarget = { move: e.move, targetEnc: e.enc };
      r.title = isSyncMode()
        ? 'Hover to preview, click to lock, double-click to play this move'
        : 'Hover to preview, click to lock, double-click to open';
      r.addEventListener('mouseenter', () => { if (!lockedMove) previewMove(target); });
      r.addEventListener('mouseleave', () => { if (!lockedMove) previewMove(null); });
      r.addEventListener('click', () => {
        if (lockedMove?.move === target.move) clearLock();
        else lockMove(target, r);
      });
      r.addEventListener('dblclick', () => {
        if (isSyncMode()) {
          // Sync mode: double-click plays the move on the live board (the panel then follows). The
          // panel is normally showing live in sync mode; guard anyway so a transient off-live state
          // just does nothing rather than committing against the wrong position.
          if (isShowingLive() && onConfirmCb) {
            lockMove(target, r);
            onConfirmCb(target);
          }
          return;
        }
        // Free-browse: double-click just navigates the browser to the child.
        lockMove(target, r);
        void navigate(display(e.enc));
      });
    } else if (!isSyncMode()) {
      // Non-move rows (quick-canon reps, Known Parents) navigate on double-click — but not in sync
      // mode, which locks the panel to the live game (no parent/rep navigation).
      r.addEventListener('dblclick', () => void navigate(display(e.enc)));
    } else {
      r.title = '';
    }
    list.appendChild(r);
  }
  field.appendChild(list);
  return field;
}

/** Known Parents list (shared by every render path). */
function parentsField(canonEnc: string): HTMLDivElement {
  const t = toggles();
  const parents = getParents(canonEnc)
    .map(enc => ({ enc, meta: getMeta(enc) }))
    .sort(
      (a, b) =>
        (a.meta?.nimber ?? Infinity) - (b.meta?.nimber ?? Infinity) ||
        (a.meta?.subposCount ?? Infinity) - (b.meta?.subposCount ?? Infinity) ||
        a.enc.localeCompare(b.enc),
    );
  const field = listField(
    'Known Parents',
    parents.map(p => ({ enc: p.enc, nimber: p.meta?.nimber })),
    'none known',
    { showNimber: t.nimbers, highlightWinning: false },
  );
  field.classList.add('pb-gap-above'); // substantial gap separating it from the Children list above
  return field;
}

/**
 * The two-button "not calculated automatically" page for 13-16 life positions. Shows the canon and
 * (cheap) quick-canon encodings, a warning, and buttons to run the full game tree or just the
 * quick-canon nimber on demand. The buttons drive calcFull / calcNimber for the current input.
 */
function renderNeedsCalculation(result: AnalysisErr & { reason: 'needs-calculation' }): void {
  body.innerHTML = '';
  const t = toggles();
  if (result.canon && !canonFieldRedundant()) body.appendChild(field('Canon Encoding', display(result.canon)));
  if (result.quickCanon)
    body.appendChild(
      field('Quick-canon Encoding', displayQuick(result.quickCanon.enc, result.quickCanon.offset)),
    );

  // By the time a result reaches this page, analyzeCached() has already tried (and failed) to
  // reconstruct a full master-save-backed result for the ROOT (see buildMasterBackedOk) — so the
  // root's own nimber is genuinely unknown here. Individual CHILDREN may still be independently
  // covered by cached metadata even so; backfill those before rendering.
  const children = result.children ? backfillChildren(result.children) : undefined;

  if (children) {
    const stats = childStats(children);
    body.appendChild(field('#Children', String(stats.count)));
    body.appendChild(field('#Winning', stats.winning));
  }

  const lives = result.maxLives2 !== undefined ? Math.round(result.maxLives2 / 2) : undefined;
  notify(
    `This position is large${lives !== undefined ? ` (largest subposition has ${lives} lives)` : ''}` +
      ' and is not calculated automatically. Calculating may take a few moments.' +
      (result.children
        ? ' Showing immediate children only; their values (shown as "?") are not calculated.'
        : ''),
  );

  const row = document.createElement('div');
  row.className = 'pb-calc-buttons';
  const treeBtn = document.createElement('button');
  treeBtn.className = 'pb-calc-btn';
  treeBtn.textContent = 'Calculate\nGame Tree';
  treeBtn.addEventListener('click', () => void calcFull());
  const nimBtn = document.createElement('button');
  nimBtn.className = 'pb-calc-btn';
  nimBtn.textContent = 'Calculate\nNimber';
  nimBtn.addEventListener('click', () => void calcNimber());
  row.appendChild(treeBtn);
  row.appendChild(nimBtn);
  body.appendChild(row);

  if (children) {
    body.appendChild(togglesEl);
    const sorted = [...children].sort(cmpChildren);
    body.appendChild(
      listField(
        'Child encodings',
        t.quick
          ? sorted.map(c => ({
              enc: c.enc,
              label: c.quickCanon ? displayQuick(c.quickCanon.enc, c.quickCanon.offset) : display(c.enc),
              nimber: c.nimber,
            }))
          : sorted.map(c => ({ enc: c.enc, nimber: c.nimber, move: c.move })),
        'no children',
        { showNimber: t.nimbers, highlightWinning: t.winning },
      ),
    );
  }

  if (result.canon) body.appendChild(parentsField(result.canon));
}

/** The quick-canon nimber view (result of the "Calculate Nimber" button). */
function renderQuick(result: QuickAnalysisOk): void {
  body.innerHTML = '';
  const t = toggles();

  if (!canonFieldRedundant()) body.appendChild(field('Canon Encoding', display(result.canon)));
  body.appendChild(
    field('Quick-canon Encoding', displayQuick(result.quickCanon.enc, result.quickCanon.offset)),
  );
  body.appendChild(field('Nimber', String(result.nimber)));
  const stats = childStats(result.quickChildren);
  body.appendChild(field('#Children', String(stats.count)));
  body.appendChild(field('#Winning', stats.winning));

  // Offer to upgrade to the full (exact) game tree, which also yields move-length bounds.
  const row = document.createElement('div');
  row.className = 'pb-calc-buttons';
  const treeBtn = document.createElement('button');
  treeBtn.className = 'pb-calc-btn';
  treeBtn.textContent = 'Calculate\nGame Tree';
  treeBtn.addEventListener('click', () => void calcFull());
  row.appendChild(treeBtn);
  body.appendChild(row);

  notify('Quick-canon cannot draw moves in the play field.');

  const quick = [...result.quickChildren].sort(cmpQuickChildren);
  body.appendChild(
    listField(
      'Child encodings',
      quick.map(c => ({ enc: c.enc, label: displayQuick(c.enc, c.offset), nimber: c.nimber })),
      'no children',
      { showNimber: t.nimbers, highlightWinning: false },
    ),
  );

  body.appendChild(parentsField(result.canon));
}

/** A position too large for the engine's on-demand gate, but already known from cached metadata
 * (typically the preloaded master-save seed). No children/quickCanon available — just the value. */
function renderMetaOnly(result: MetaOnlyOk): void {
  body.innerHTML = '';
  if (!canonFieldRedundant()) body.appendChild(field('Canon Encoding', display(result.canon)));

  const split = document.createElement('div');
  split.className = 'pb-split';
  const leftCol = document.createElement('div');
  leftCol.className = 'pb-col';
  leftCol.appendChild(field('Nimber', String(result.nimber)));
  const rightCol = document.createElement('div');
  rightCol.className = 'pb-col';
  rightCol.appendChild(field('Shortest Game', `${result.minMoves} moves`));
  rightCol.appendChild(field('Longest Game', `${result.maxMoves} moves`));
  split.appendChild(leftCol);
  split.appendChild(rightCol);
  body.appendChild(split);

  notify(
    "This position is too large to analyze on demand, but its value is known from precomputed " +
      'save data — child moves are not available.',
  );

  body.appendChild(parentsField(result.canon));
}

function renderError(result: Extract<AnalysisResult, { ok: false }>): void {
  body.innerHTML = '';
  if (result.reason === 'needs-calculation') {
    renderNeedsCalculation(result as AnalysisErr & { reason: 'needs-calculation' });
    return;
  }
  if (result.reason === 'too-large') {
    const t = toggles();
    const lives = result.maxLives2 !== undefined ? Math.round(result.maxLives2 / 2) : undefined;
    if (result.canon && !canonFieldRedundant()) body.appendChild(field('Canon Encoding', display(result.canon)));

    // Cached metadata (e.g. the preloaded master-save seed) may already know this position's value
    // even though the engine can't compute the game tree on demand -- show it alongside the
    // (unvalued) children list rather than letting it eclipse the list entirely.
    const meta = result.canon ? metaOfCanon(result.canon) : undefined;
    if (meta) {
      const split = document.createElement('div');
      split.className = 'pb-split';
      const leftCol = document.createElement('div');
      leftCol.className = 'pb-col';
      leftCol.appendChild(field('Nimber', String(meta.nimber)));
      const rightCol = document.createElement('div');
      rightCol.className = 'pb-col';
      rightCol.appendChild(field('Shortest Game', `${meta.minMoves} moves`));
      rightCol.appendChild(field('Longest Game', `${meta.maxMoves} moves`));
      split.appendChild(leftCol);
      split.appendChild(rightCol);
      body.appendChild(split);
    }
    if (result.children) {
      const stats = childStats(result.children);
      body.appendChild(field('#Children', String(stats.count)));
      body.appendChild(field('#Winning', stats.winning));
    }

    notify(
      "This position is too large to fully analyze" +
        (lives !== undefined ? ` — its largest subposition has ${lives} lives (over the 16-life limit).` : '.') +
        (meta ? ' (Nimber above is from precomputed save data.)' : '') +
        (result.children
          ? ' Showing immediate children only; their values (shown as "?") are not calculated.'
          : ' Even its immediate children are too numerous to list.'),
      'error',
    );

    if (result.children) {
      body.appendChild(togglesEl);
      const children = [...result.children].sort(cmpChildren);
      body.appendChild(
        listField(
          'Child encodings',
          t.quick
            ? children.map(c => ({
                enc: c.enc,
                label: c.quickCanon ? displayQuick(c.quickCanon.enc, c.quickCanon.offset) : display(c.enc),
                nimber: c.nimber,
              }))
            : children.map(c => ({ enc: c.enc, nimber: c.nimber, move: c.move })),
          'no children',
          { showNimber: t.nimbers, highlightWinning: false },
        ),
      );
    }
    if (result.canon) body.appendChild(parentsField(result.canon));
    return;
  }
  notify(
    result.reason === 'engine-unavailable'
      ? result.message ?? 'Engine unavailable.'
      : `Couldn't read that position: ${result.message ?? 'invalid encoding'}`,
    'error',
  );
}

function renderOk(result: Extract<AnalysisResult, { ok: true }>): void {
  body.innerHTML = '';
  const t = toggles();

  // Canon values (nimbers / winning info) come from the exact game graph, which the engine currently
  // always computes for in-gate positions — so this is always true today. The branch is plumbed so a
  // future quick-canon-only path (e.g. positions past the size gate) can show a notice in canon mode
  // instead of an empty list. See the Quick-Canon toggle.
  const canonValuesCalculated = true;

  if (!canonFieldRedundant()) body.appendChild(field('Canon Encoding', display(result.canon)));
  body.appendChild(
    field('Quick-canon Encoding', displayQuick(result.quickCanon.enc, result.quickCanon.offset)),
  );

  // Nimber / breakdown on the left; move-length bounds across from them on the right.
  const split = document.createElement('div');
  split.className = 'pb-split';
  const leftCol = document.createElement('div');
  leftCol.className = 'pb-col';
  const stats = childStats(result.children);
  leftCol.appendChild(field('Nimber', String(result.nimber)));
  leftCol.appendChild(field('Nimber Breakdown', result.nimberBreakdown.join(' ⊕ ')));
  leftCol.appendChild(field('#Children', String(stats.count)));
  const rightCol = document.createElement('div');
  rightCol.className = 'pb-col';
  rightCol.appendChild(field('Shortest Game', `${result.minMoves} moves`));
  rightCol.appendChild(field('Longest Game', `${result.maxMoves} moves`));
  rightCol.appendChild(field('#Winning', stats.winning));
  split.appendChild(leftCol);
  split.appendChild(rightCol);
  body.appendChild(split);

  // Divider: whole-position info is above; the toggles below control the lists beneath them.
  const divider = document.createElement('div');
  divider.className = 'pb-divider';
  body.appendChild(divider);
  body.appendChild(togglesEl);

  // Children — a single list whose contents follow the Quick-Canon toggle. Canon mode highlights
  // winning (nimber-0) moves green when enabled; quick-canon mode shows the collections-reduced reps
  // (⊕1 tag in the label, no winning highlight). Both ordered [nimber, subposCount, lex].
  if (!t.quick && !canonValuesCalculated) {
    body.appendChild(field('Child encodings', 'canon values not calculated', true));
  } else if (t.quick) {
    const quick = [...result.quickChildren].sort(cmpQuickChildren);
    body.appendChild(
      listField(
        'Child encodings',
        quick.map(c => ({ enc: c.enc, label: displayQuick(c.enc, c.offset), nimber: c.nimber })),
        'no children',
        { showNimber: t.nimbers, highlightWinning: false },
      ),
    );
  } else {
    const children = [...result.children].sort(cmpChildren);
    body.appendChild(
      listField(
        'Child encodings',
        children.map(c => ({ enc: c.enc, nimber: c.nimber, winning: c.nimber === 0, move: c.move })),
        'no children',
        { showNimber: t.nimbers, highlightWinning: t.winning },
      ),
    );
  }

  // In quick-canon mode, note that these reps are equivalence-class representatives, not real moves.
  if (t.quick) notify('Quick-canon cannot draw moves in the play field.');

  // Known Parents: whatever we happen to know (analysis edges + gameplay). Never computed.
  body.appendChild(parentsField(result.canon));
}

/** Render just the body for a view (shared by full render and in-place toggle re-render). */
function renderBody(result: View): void {
  clearLock(); // rows are about to be rebuilt; stale row refs can't stay locked
  clearNotify(); // any pending "Calculating…" / notes from before this render are stale now
  if (isQuick(result)) renderQuick(result);
  else if (isMetaOnly(result)) renderMetaOnly(result);
  else if (result.ok) renderOk(result);
  else renderError(result);

  // Divider under the body's last list (Known Parents, in every path that reaches one) — mirrors
  // the divider above the toggle row at the bottom of the panel.
  const divider = document.createElement('div');
  divider.className = 'pb-divider';
  body.appendChild(divider);
}

// Notified after every successful navigation (navigate/goto), regardless of cause — lets
// main.ts wake its (non-continuous) render loop so e.g. the Sync button's disabled state
// gets re-checked even after a manual address-bar/child/back-forward navigation.
let navListener: (() => void) | null = null;
export function onNavigated(cb: () => void): void {
  navListener = cb;
}

function render(result: View, inputText: string): void {
  lastResult = result;
  addressInput.value = inputText;
  updateNavButtons();
  renderBody(result);
  navListener?.();
}

/**
 * Refresh the back/forward arrows' enabled state. In sync mode they mirror the live game's
 * undo/redo availability (via syncCbs); in free-browse mode they mirror the browser's own visit
 * history. Exported so main.ts can re-check it every frame while the game history changes.
 */
export function updateNavButtons(): void {
  if (!backBtn) return;
  if (isSyncMode()) {
    backBtn.disabled = !(syncCbs?.canBack() ?? false);
    forwardBtn.disabled = !(syncCbs?.canForward() ?? false);
  } else {
    backBtn.disabled = index <= 0;
    forwardBtn.disabled = index >= history.length - 1;
  }
}

/** Re-render the current result's body in place (on a toggle change) without re-analyzing. */
function rerenderBody(): void {
  if (!lastResult) return;
  renderBody(lastResult);
}

// --- on-demand calculation (the Calculate Game Tree / Nimber buttons) -----------------------

/** The input text the current view was navigated with (what the Calculate buttons should analyze). */
function currentInput(): string {
  return history[index]?.inputText ?? addressInput.value.trim();
}

/** Show the "Calculating…" banner in the notification area while an on-demand analysis runs.
 * Leaves the body's current content (the "needs calculation" page, with its Known Parents list
 * and divider) in place — the banner appears in the leftover space below it, not on a wiped page. */
function showCalculating(): void {
  clearNotify();
  calculatingEl.classList.add('visible');
}

/** Resolves after the browser has actually painted the next frame. The WASM analysis calls below
 * are async in name but run their heavy work synchronously before their first await, so without
 * this the "Calculating…" banner set just before them would never get a chance to paint — the
 * main thread would go straight from showCalculating() into the blocking computation. */
function paint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** "Calculate Game Tree": run the full exact analysis for the current position and show it. */
async function calcFull(): Promise<void> {
  const input = currentInput();
  if (!input) return;
  const token = ++navToken;
  showCalculating();
  await paint();
  const result = await analyzeFull(input);
  if (token !== navToken) return; // navigated away meanwhile
  if (result.ok) record(result);
  lastResult = result;
  renderBody(result);
}

/** "Calculate Nimber": run the quick-canon nimber for the current position and show it. */
async function calcNimber(): Promise<void> {
  const input = currentInput();
  if (!input) return;
  const token = ++navToken;
  showCalculating();
  await paint();
  const result = await analyzeNimber(input);
  if (token !== navToken) return;
  if (isQuick(result)) quickCache.set(result.canon, result);
  lastResult = result;
  renderBody(result);
}

/** Highlight Winning is disabled (greyed) in quick-canon mode — winning needs exact nimbers. */
function syncWinningToggle(): void {
  const disabled = quickToggle.checked;
  winningToggle.disabled = disabled;
  winningToggle.parentElement?.classList.toggle('disabled', disabled);
}

/** Apply sync-mode UI locks (currently: the address bar is read-only while locked to the game). */
function applySyncMode(): void {
  addressInput.disabled = isSyncMode();
}

/** React to a Sync-toggle flip: relock/unlock the address bar, refresh the nav arrows, rebuild the
 * body (row interactivity depends on the mode), and let main.ts snap the panel to live / wake. */
function onSyncToggleChange(): void {
  applySyncMode();
  updateNavButtons();
  rerenderBody();
  syncModeListener?.();
}

// --- navigation -----------------------------------------------------------------------------

async function navigate(inputText: string): Promise<void> {
  const trimmed = inputText.trim();
  if (!trimmed) return;
  const token = ++navToken;
  showCalculating();
  await paint();
  const { result, canonEnc } = await analyzeCached(trimmed);
  if (token !== navToken) return; // superseded by a newer navigation
  history = history.slice(0, index + 1);
  history.push({ inputText: trimmed, canonEnc });
  index = history.length - 1;
  render(result, trimmed);
}

async function goto(newIndex: number): Promise<void> {
  if (newIndex < 0 || newIndex >= history.length) return;
  index = newIndex;
  const entry = history[index];
  const token = ++navToken;
  showCalculating();
  await paint();
  const { result } = await analyzeCached(entry.inputText);
  if (token !== navToken) return;
  render(result, entry.inputText);
}

// --- open / close / wiring ------------------------------------------------------------------

let wired = false;
/** Wire up the browser's DOM listeners exactly once. Safe to call repeatedly (idempotent) —
 * main.ts calls this eagerly for the wide-window side panel, not just lazily on modal open. */
export function ensureWired(): void {
  if (wired) return;
  wired = true;

  overlay = document.getElementById('position-browser-overlay') as HTMLDivElement;
  addressInput = document.getElementById('pb-address') as HTMLInputElement;
  backBtn = document.getElementById('pb-back') as HTMLButtonElement;
  forwardBtn = document.getElementById('pb-forward') as HTMLButtonElement;
  body = document.getElementById('pb-body') as HTMLDivElement;
  notifyMessages = document.getElementById('pb-notify-messages') as HTMLDivElement;
  calculatingEl = document.getElementById('pb-calculating') as HTMLDivElement;
  togglesEl = document.getElementById('pb-toggles') as HTMLDivElement;
  quickToggle = document.getElementById('pb-tog-quick') as HTMLInputElement;
  winningToggle = document.getElementById('pb-tog-winning') as HTMLInputElement;
  nimbersToggle = document.getElementById('pb-tog-nimbers') as HTMLInputElement;
  syncToggle = document.getElementById('pb-tog-sync') as HTMLInputElement;
  togglesEl.remove(); // detached from its static spot; renderOk places it just above the lists
  const closeBtn = document.getElementById('pb-close') as HTMLButtonElement;

  backBtn.addEventListener('click', () => {
    if (isSyncMode()) syncCbs?.onBack();
    else void goto(index - 1);
  });
  forwardBtn.addEventListener('click', () => {
    if (isSyncMode()) syncCbs?.onForward();
    else void goto(index + 1);
  });
  closeBtn.addEventListener('click', close);

  const onToggle = (): void => {
    syncWinningToggle();
    rerenderBody();
  };
  quickToggle.addEventListener('change', onToggle);
  winningToggle.addEventListener('change', onToggle);
  nimbersToggle.addEventListener('change', onToggle);
  syncToggle.addEventListener('change', onSyncToggleChange);
  syncWinningToggle();
  applySyncMode(); // reflect the initial toggle state (address bar lock)
  addressInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void navigate(addressInput.value);
    }
  });
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (lockedMove) { clearLock(); return; }
      if (overlay.classList.contains('visible')) close();
    }
  });
}

function close(): void {
  overlay.classList.remove('visible');
  clearLock();
}

/** Open the browser, navigating to `initialInput` (default: the live position encoding). */
export function openPositionBrowser(initialInput: string): void {
  ensureWired();
  overlay.classList.add('visible');
  addressInput.value = initialInput;
  void navigate(initialInput);
  addressInput.focus();
  addressInput.select();
}

// The last input text we were asked to track live (by notifyLivePosition) — used by
// isShowingLive() to tell the Sync button whether the browser has drifted from the live game.
let lastLiveInput: string | null = null;

/**
 * Wide-panel live-follow: navigate to the current game position without touching modal
 * open/close state or focusing the address bar. A no-op if we're already showing this
 * exact input (avoids piling up redundant history entries every animation frame). Returns
 * a promise so callers can wake their render loop once the (async) navigation lands —
 * the main render loop isn't continuous, so isShowingLive() wouldn't otherwise get
 * re-checked after the navigation resolves.
 */
export function notifyLivePosition(inputText: string): Promise<void> {
  ensureWired();
  const trimmed = inputText.trim();
  if (!trimmed) return Promise.resolve();
  lastLiveInput = trimmed;
  if (history[index]?.inputText === trimmed) return Promise.resolve();
  return navigate(trimmed);
}

/** Whether the currently-browsed position is the one notifyLivePosition last reported. */
export function isShowingLive(): boolean {
  return lastLiveInput !== null && history[index]?.inputText === lastLiveInput;
}
