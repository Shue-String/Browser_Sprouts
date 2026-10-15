import { createInitialState, cloneState } from './model/gameState';
import { applyMove, recomputeRegions } from './model/moves';
import { encodePosition, encodePositionDecompressed, canonicalEncoding, resolveMoveVertices, classifyVertexFull, trackedLayout } from './model/encoding';
import type { ResolvedMoveVertices } from './model/encoding';
import { VertexType } from './model/types';
import type { EncodingResult } from './model/encoding';
import { computeMoveCode, computeEnclosureSideColoring, computeEnclosureCoverage } from './model/moveCode';
import { recomputeSpotLabels, initialSpotLabels, labelForFromMap, spotGroupForFromMap, formatSpotLabel } from './model/vertexLabels';
import { parseMoveSequence } from './model/moveCodeParse';
import type { ResolvedMove } from './model/moveCodeParse';
import { synthesizeMove, appliedMoveMatches, computeRecreateHints, strokeReproduces, applyTrial } from './model/recreate';
import type { RecreateHints } from './model/recreate';
import { resolveLabelledMove } from './model/vertexLabels';
import { rawRouteOf } from './model/moveRouter';
import { strokeCrossesEdges, candidateStrokes, candidateStrokeStream } from './model/strokeSynthesis';
import { allRoutedMoves } from './model/moveRouter';
import { moveLog } from './debug/moveLog';
import { DEBUG } from './debug/flags';
import { smoothStep, smoothStepDrag, resampleAllEdges, lastMaxMovement, resetActivityTimer } from './model/smooth';
import { tunables, TUNABLE_SPECS, loadTunables, saveTunables, resetTunables } from './model/tunables';
import { deadRegionStep, eliminateIsolatedVertex, detectLouse, scabAloneCollapse, detectSpecialCollapse, specialCollapseVertices, stepSpecialCollapse, takeEncodingGateRefusal } from './model/deadRegions';
import type { SpecialCollapse } from './model/deadRegions';
import { Renderer } from './render/renderer';
import type { SubregionHighlight } from './render/renderer';
import { InputHandler } from './input/inputHandler';
import { identityRotation, rotationX, rotationY, composeRotations, rotateSpherePoint, axisAngleRotation, fibonacciSphere } from './math/sphere';
import type { RotationMatrix, SpherePoint } from './math/sphere';
import type { GameState, VertexId } from './model/types';
import { buildVoronoiGraph } from './model/voronoiGraph';
import { computeJunctionVoronoiPath } from './model/voronoiJunctionPath';
import { buildSubregionHighlight } from './model/subregionHighlight';
import { serializeGameState, deserializeGameState } from './model/saveState';
import type { SaveFileV2, HistoryStepInput } from './model/saveState';
import { openPositionBrowser, ensureWired as ensureBrowserWired, notifyLivePosition, isShowingLive, currentBrowsedCanon, onNavigated, setMoveCallbacks, setSyncCallbacks, onSyncModeChange, isSyncMode, setSyncMode, setSyncToggleEnabled, updateNavButtons, PB_PANEL_ID, PB_BODY_ID } from './ui/positionBrowser';
import { TrackedGame } from './engine/trackedGame';
import type { MovePreviewTarget } from './ui/positionBrowser';
import { openGuide, closeGuide, isGuideOpen } from './ui/guide';
import { initCollect } from './ui/collect';
import { initTTree } from './ui/ttree';
import { initGenomes } from './ui/genomes';
import { canon as canonEncoding, preloadModule, canonSync } from './engine/stalks';
import { recordEdge, loadMasterSeed, loadQuickMasterSeed } from './model/positionCache';

// Kick off the WASM module load immediately (independent of the Tracked Encoding toggle) so
// canonSync()-backed gates (e.g. deadRegions' commitIfEncodingPreserved) have a real chance of
// being engine-backed rather than falling back to the plain string compare. See M6 in
// project_encoding_canon_rework.
preloadModule();

// Fire-and-forget: seeds positionCache.meta from the precomputed master-save dump so the Position
// Browser doesn't have to recompute large, already-solved positions from scratch. The quick-canon
// counterpart seeds the Position Browser's quick-canon move-bound display for the same size range.
loadMasterSeed();
loadQuickMasterSeed();

const INITIAL_SPOTS    = 6;
const DRAG_SENSITIVITY = 0.005;
const TOP_BAR_H        = 40;
const BOTTOM_BAR_H     = 44;
const WIDE_BREAKPOINT  = 1200; // window width at which the Position Browser becomes a side panel
const PANEL_WIDTH      = 440;

// Whether the wide side-panel layout is currently active. Set by syncLayoutMode().
let isWide = false;
// The last live-position encoding the panel was auto-navigated to — used to only re-navigate
// when the game position actually changes, rather than every animation frame (which would
// stomp on manual browsing/typing in the address bar).
/**
 * The live position as the Position Browser should analyse it: the DECOMPRESSED encoding. A
 * compressed DisaPoint ('3') re-expands inside the engine one of two ways, and the board may hold
 * the other twin — the engine's move list would then describe a sibling position, whose children
 * no stroke on this drawing can reach. The decompressed text pins the exact twin, so move indices
 * and the hover oracle line up with the board (resolveMoveVertices already assumes this form).
 */
function liveAnalysisText(s: GameState): string { return encodePositionDecompressed(s).text || 'N'; } // '' = no live spots; the engine spells that 'N'
let lastNotifiedLiveEnc: string | null = null;

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------

const canvas    = document.getElementById('game-canvas') as HTMLCanvasElement;
const bottomBar     = document.getElementById('bottom-bar')      as HTMLDivElement;
const bottomBarText = document.getElementById('bottom-bar-text') as HTMLSpanElement;
const bottomBarCopy = document.getElementById('bottom-bar-copy') as HTMLButtonElement;
const voronoiPathBar  = document.getElementById('voronoi-path-bar')  as HTMLDivElement;
const voronoiPathText = document.getElementById('voronoi-path-text') as HTMLSpanElement;
const voronoiPathCopy = document.getElementById('voronoi-path-copy') as HTMLButtonElement;
voronoiPathCopy.addEventListener('click', () => navigator.clipboard.writeText(voronoiPathText.textContent ?? ''));
const moveSeqBar  = document.getElementById('move-seq-bar')  as HTMLDivElement;
const moveSeqText = document.getElementById('move-seq-text') as HTMLSpanElement;
const moveSeqCopy = document.getElementById('move-seq-copy') as HTMLButtonElement;
moveSeqCopy.addEventListener('click', () => navigator.clipboard.writeText(moveSeqCopyText()));

// Position Browser panel's own move-sequence bar: mirrors moveSeqText's content whenever Sync
// mode is on (regardless of Debug unlock), pinned to the bottom of #pb-panel-extra. The text
// truncates with an ellipsis via .bottom-bar-text's overflow CSS; Copy always grabs the full
// (untruncated) sequence out of textContent, not whatever's visually clipped.
const pbMoveSeqBar  = document.getElementById('pb-move-seq-bar')  as HTMLDivElement;
const pbMoveSeqText = document.getElementById('pb-move-seq-text') as HTMLSpanElement;
const pbMoveSeqCopy = document.getElementById('pb-move-seq-copy') as HTMLButtonElement;
pbMoveSeqCopy.addEventListener('click', () => navigator.clipboard.writeText(moveSeqCopyText()));

let showPosition = false;
// Move-sequence display mode: labels (default) vs raw vertex IDs.
let useRawVertexIds = false;
// Move Check: annotate each move-sequence token with the {encoding} of the position it produced.
let moveCheckMode = false;
// The raw (non-canonical) encoding of the position right after the most recently committed move —
// recorded unconditionally so Recreate can verify "C"-tagged sequences regardless of this
// session's Move Check toggle state.
let lastCommittedEncoding: string | null = null;
/** Strips a trailing `{encoding}` Move Check tag off a move token, if present. */
function stripMoveCheckTag(token: string): string {
  const i = token.indexOf('{');
  return i === -1 ? token : token.slice(0, i);
}
/** The trailing `{encoding}` Move Check tag off a move token (including braces), or '' if none. */
function moveCheckTagOf(token: string): string {
  const i = token.indexOf('{');
  return i === -1 ? '' : token.slice(i);
}
// True once a Recreate replay has halted on a Move Check mismatch — forces the disk-ring
// background to dark maroon (see renderer.ts) until the next New Game / Recreate run.
let recreateCheckFailed = false;
// On-canvas spot-label overlay.
let showSpotLabels = false;

// Position-encoding-bar hover highlight: which character (and its vertex/edge
// provenance) the mouse is currently over, so the canvas can draw a red
// wedge/circle on the corresponding point.
let lastCharInfo: EncodingResult['charInfo'] = [];
let hoverCharInfo: { vertexIds: number[]; edgeId?: number } | null = null;
// Same idea, for the wide Position Browser's live-encoding row (see render loop below).
let lastLiveCharInfo: EncodingResult['charInfo'] = [];

/** Hovering a character of `el` (filled by renderCharSpans) highlights the board vertex/edge that
 * character came from, per `infoOf()`'s current per-character provenance. */
function wireCharHover(el: HTMLElement, infoOf: () => { vertexIds: number[]; edgeId?: number }[]): void {
  el.addEventListener('mousemove', e => {
    const idxAttr = (e.target as HTMLElement)?.dataset?.idx;
    const idx = idxAttr !== undefined ? Number(idxAttr) : NaN;
    const info = !Number.isNaN(idx) ? infoOf()[idx] : undefined;
    const next = info && info.vertexIds.length > 0 ? info : null;
    if (next !== hoverCharInfo) { hoverCharInfo = next; wake(); }
  });
  el.addEventListener('mouseleave', () => {
    if (hoverCharInfo !== null) { hoverCharInfo = null; wake(); }
  });
}

/** Replace `el`'s content with one span per character of `text`, indexed for wireCharHover. */
function renderCharSpans(el: HTMLElement, text: string): void {
  el.innerHTML = '';
  text.split('').forEach((ch, idx) => {
    const span = document.createElement('span');
    span.textContent = ch;
    span.dataset.idx = String(idx);
    el.appendChild(span);
  });
}

wireCharHover(bottomBarText, () => lastCharInfo);

// Position Browser move hover/lock preview: a dashed arc on the playfield for whatever child
// move the browser is currently hovering/locking, resolved from the engine's abstract MoveInfo
// against the live state (only meaningful while the browser is showing the live position).
let movePreviewArc: SpherePoint[] | null = null;
let movePreviewStroke: { v1: number; v2: number; stroke: SpherePoint[] } | null = null;
let movePreviewFailRing: number[] | null = null;
let movePreviewFailCandidates: { stroke: SpherePoint[]; legal: boolean }[] | null = null;
let movePreviewToken = 0;

// Background stroke cache for the Position Browser's children, keyed by the canon each stroke
// actually reaches (first stroke wins). Two passes per position: each child's own resolved
// candidates (stopping once its own target is reached), then — for children still uncovered,
// e.g. ones resolveMoveVertices can't translate, or that land on a sibling's target — every
// reading the topological router can draw (moveRouter.ts allRoutedMoves), until each child has a
// stroke. Published as it fills; synthesizeVerifiedMove checks it before computing anything.
//
// The pass only runs while the board is STILL (see layoutQuiet): routing builds face meshes that
// are cached per exact drawing, so running it while physics moves the board rebuilt them for every
// child and starved the frame loop (~4 fps, multi-second freezes during Recreate). While the board
// moves, a hover computes its own child on demand instead. A new position's children wait in
// pendingChildTargets until the layout has come to rest (friction stops it a few seconds after a
// move); a disturbance mid-pass parks the rest of the batch until the next rest.
let childrenBatchGen = 0;
let pendingChildTargets: MovePreviewTarget[] | null = null;

/** Nothing on the board is moving or about to: no Recreate playback, no collapse animation, no
 *  vertex drag (smoothStepDrag doesn't report movement), and the last physics step moved less than
 *  the settle threshold. */
function layoutQuiet(): boolean {
  return !recreateActive && !collapseActive() && !input.isDragging() && lastMaxMovement <= tunables.settleEpsilon;
}

/** Start (or resume) the parked children pass if the board is at rest. Called every frame. */
function maybeStartPrecompute(): void {
  if (!pendingChildTargets || !layoutQuiet()) return;
  const targets = pendingChildTargets;
  pendingChildTargets = null;
  void precomputeChildrenMoves(targets);
}

/**
 * Canonical identity of a trial position, comparable with canon() of an engine child's enc. Uses
 * the DECOMPRESSED encoding (see synthesizeVerifiedMove), and maps the encoder's empty string for
 * a fully dead position to the engine's own spelling of it, "N".
 */
async function trialCanonOf(trial: GameState): Promise<string> {
  const text = encodePositionDecompressed(trial).text;
  return text === '' ? 'N' : canonEncoding(text);
}
let attemptedResultCanons = new Map<string, { v1: number; v2: number; stroke: SpherePoint[] }>();

async function precomputeChildrenMoves(targets: MovePreviewTarget[]): Promise<void> {
  const myGen = ++childrenBatchGen;
  // Same map across a parked/resumed pass for one position (onChildrenBatch starts a fresh one):
  // a stroke found before a disturbance is still re-checked for crossings when used.
  const results = attemptedResultCanons;
  // Each verification routes/applies real strokes, and the canon awaits resolve as microtasks,
  // which alone never let input or a newer batch in — so yield a macrotask between steps. A newer
  // batch ends this one; the board starting to move again parks it until the next rest.
  const yieldOk = async (): Promise<boolean> => {
    await new Promise(r => setTimeout(r, 0));
    if (myGen !== childrenBatchGen) return false;
    if (!layoutQuiet()) { pendingChildTargets = targets; return false; }
    return true;
  };
  const wanted = new Set<string>();
  for (const t of targets) wanted.add(await canonEncoding(t.targetEnc));
  for (const t of targets) {
    if (!(await yieldOk())) return;
    const resolved = resolveMoveVertices(state, t.move);
    if (!resolved) continue;
    const target = await canonEncoding(t.targetEnc);
    if (results.has(target)) continue;
    for (const stroke of candidateStrokeStream(state, parsedFromResolved(resolved))) {
      if (!(await yieldOk())) return;
      if ((await tryStroke(resolved.v1, resolved.v2, stroke, results)) === target) break;
    }
  }
  const covered = (): boolean => [...wanted].every(c => results.has(c));
  for (const mv of allRoutedMoves(state)) {
    if (covered() || !(await yieldOk())) return;
    await tryStroke(mv.v1, mv.v2, mv.stroke, results);
  }
}

/**
 * Try one stroke on the live board (applyTrial: legal and applied on a clone) and return the canon
 * it reaches — recorded in `cache` as a stroke for that child, first stroke wins — or null when the
 * stroke is illegal. Shared by the background children pass and hover verification.
 */
async function tryStroke(v1: number, v2: number, stroke: SpherePoint[], cache: Map<string, { v1: number; v2: number; stroke: SpherePoint[] }>): Promise<string | null> {
  const trial = applyTrial(state, v1, v2, stroke);
  if (!trial) return null;
  const reached = await trialCanonOf(trial);
  if (!cache.has(reached)) cache.set(reached, { v1, v2, stroke });
  return reached;
}

/** A ResolvedMove for candidate synthesis from an engine move translated to live vertices. */
function parsedFromResolved(resolved: ResolvedMoveVertices): ResolvedMove {
  return {
    token: '', checkEncoding: null, lo: resolved.v1, hi: resolved.v2, loSub: null, hiSub: null,
    parallel: false, parens: null, brackets: resolved.brackets ?? null,
  };
}

setMoveCallbacks({
  onChildrenBatch(targets: MovePreviewTarget[]) {
    childrenBatchGen++; // ends any pass still running for the previous position
    attemptedResultCanons = new Map();
    pendingChildTargets = targets;
    maybeStartPrecompute();
  },
  onPreview(target: MovePreviewTarget | null) {
    const myToken = ++movePreviewToken;
    if (!target || !isShowingLive()) {
      movePreviewStroke = null;
      movePreviewArc = null;
      movePreviewFailRing = null;
      movePreviewFailCandidates = null;
      wake();
      return;
    }
    void synthesizeVerifiedMove(target).then(result => {
      if (myToken !== movePreviewToken) return; // superseded by a later hover
      movePreviewStroke = result.kind === 'found' ? result : null;
      movePreviewArc = result.kind === 'found' ? result.stroke : null;
      movePreviewFailRing = result.kind === 'unreachable' && showBroken ? [result.v1, result.v2] : null;
      // Only surface the auto-checked candidate strokes ("what did we try and
      // reject") when Pause Recreations is on — same debug-oriented gate the
      // manual-draw fallback's own candidate overlay uses, so this doesn't
      // clutter normal play.
      movePreviewFailCandidates = result.kind === 'unreachable' && pauseRecreations ? result.candidates : null;
      wake();
    });
  },
  onConfirm(target: MovePreviewTarget) {
    if (!isShowingLive()) return;
    void (async () => {
      const resolved = movePreviewStroke ?? await synthesizeVerifiedMove(target).then(r => r.kind === 'found' ? r : null);
      if (!resolved) return;
      pushHistorySnapshot();
      applyMove(state, { v1: resolved.v1, v2: resolved.v2, stroke: resolved.stroke });
      afterMoveCommitted(resolved.v1, resolved.v2, resolved.stroke);
      movePreviewArc = null;
      movePreviewStroke = null;
      movePreviewFailRing = null;
      movePreviewFailCandidates = null;
      wake();
    })();
  },
});

type SynthesizeResult =
  | { kind: 'found'; v1: number; v2: number; stroke: SpherePoint[] }
  | { kind: 'unreachable'; v1: number; v2: number; candidates: { stroke: SpherePoint[]; legal: boolean }[] }
  | { kind: 'unresolved' };

/**
 * Synthesize→verify, same discipline as recreate.ts's synthesizeMove: try every candidate
 * stroke strokeSynthesis proposes (multiple bow directions / enclosure routings), skip any
 * that cross existing geometry, and accept the first whose resulting position's canon encoding
 * exactly matches the target child — so an enclosure that needs to route around/away from an
 * existing edge doesn't just get drawn on top of it, and we never commit a topologically wrong
 * move just because it was the first candidate offered. Verification goes through the WASM
 * canon() (not a raw string compare against encodePosition().text) because the engine's child
 * `enc` is ASCII/bracketless while the live encoder's text is bracketed/unicode-⊕ — canon() is
 * the one function both sides already agree parses to the same canonical identity. The trial
 * side must be the DECOMPRESSED encoding: encodePosition's DisaPoint compression ('3') is lossy
 * (e.g. "2,A|0,0,A" and "2A|0,0,A" both compress to "0,0,3" and canon re-expands it one way),
 * so a child on the other side of that ambiguity could never verify.
 *
 * When the endpoints resolve but no candidate verifies (e.g. the mask/bracket-set requires a
 * routing candidateStrokes can't propose), the caller still knows *which* two vertices the move
 * should connect — reported as 'unreachable' so the UI can ring them instead of drawing nothing —
 * plus every candidate stroke that was tried, tagged `legal` (didn't cross existing geometry) or
 * not, so the caller can optionally show what was auto-checked and rejected.
 */
async function synthesizeVerifiedMove(target: MovePreviewTarget): Promise<SynthesizeResult> {
  // A stroke from the background cache (see precomputeChildrenMoves) — re-checked against the
  // current drawing, since layout physics may have moved things since it was verified. Checked
  // first: when the pass has covered this child, the hover is instant.
  const cached = async (): Promise<SynthesizeResult | null> => {
    const hit = attemptedResultCanons.get(await canonEncoding(target.targetEnc));
    return hit && !strokeCrossesEdges(state, hit.stroke) ? { kind: 'found', ...hit } : null;
  };
  const early = await cached();
  if (early) return early;
  const resolved = resolveMoveVertices(state, target.move);
  if (!resolved) return (await cached()) ?? { kind: 'unresolved' };
  const parsed = parsedFromResolved(resolved);
  // target.targetEnc comes straight from the WASM engine's analyze() child
  // list, which is not guaranteed to already be in the same bracketless/
  // DisaPoint-compressed form that canonEncoding() below produces for the
  // trial position (e.g. a two-vertex "(29)"/"(2,9)" region vs. its
  // compressed "3" token for the same equivalence class) — normalize both
  // sides through canonEncoding() so the comparison isn't representation-
  // sensitive.
  const targetCanon = await canonEncoding(target.targetEnc);
  const candidates: { stroke: SpherePoint[]; legal: boolean }[] = [];
  for (const stroke of candidateStrokeStream(state, parsed)) {
    const reached = await tryStroke(resolved.v1, resolved.v2, stroke, attemptedResultCanons);
    candidates.push({ stroke, legal: reached !== null });
    if (reached === targetCanon) return { kind: 'found', v1: resolved.v1, v2: resolved.v2, stroke };
  }
  // None of this move's own candidates reach it directly — the background pass may have found a
  // stroke for it anyway (see precomputeChildrenMoves above).
  return (await cached()) ?? { kind: 'unreachable', v1: resolved.v1, v2: resolved.v2, candidates };
}

function fitCanvas(): void {
  canvas.width  = window.innerWidth - (isWide ? PANEL_WIDTH : 0);
  // In wide mode the position bar lives in the side panel, not the bottom stack.
  const bottomBars = isWide ? 0 : (showPosition ? 1 : 0);
  canvas.height = window.innerHeight - TOP_BAR_H - bottomBars * BOTTOM_BAR_H;
}
fitCanvas();

const state    = createInitialState(INITIAL_SPOTS);
const renderer = new Renderer(canvas);

// Shadow encoding via the Stalks engine (M2–M4 wiring). Runs entirely parallel to the existing
// encoding path; only outward effect is the maroon on a face-check mismatch (opt-in toggle below).
let trackedCheckEnabled = false;
const tracked = new TrackedGame();
tracked.reset([...state.vertices.keys()]);
/** Captured at move commit; fired once the position settles (all pops quiescent). */
let pendingTrackedCheck: { v1: VertexId; v2: VertexId; parentVertexIds: Set<VertexId> } | null = null;
let   camera: RotationMatrix = identityRotation();

// Dev aid: expose state + move log for console/preview inspection.
(window as unknown as { __sprouts: unknown }).__sprouts = {
  state,
  moveLog,
  renderer,
  tracked,
  get trackedEnabled() { return trackedCheckEnabled; },
  get pendingTracked() { return pendingTrackedCheck; },
  runTrackedCheck: () => runPendingTrackedCheck(),
  /** Dev aid: force the tracked believed-encoding panel into a given state (M5 diagnostics). */
  showTrackedPanel: (o: { mismatch: boolean; engineKey?: string; geometryKey?: string } | null) =>
    updateTrackedPanel(o),
  get camera() { return camera; },
  /** The collapse animating right now (at most one; see collapseActive). */
  get collapse() {
    return { special: pendingCollapse?.kind ?? null, general: generalCollapseFocus ? [...generalCollapseFocus] : null, detail: pendingCollapse };
  },
  /** The canonical position string — the invariant dead-region surgery must preserve. */
  encode() { return canonicalEncoding(state); },
  applyMove: (v1: number, v2: number, stroke: unknown[]) => applyMove(state, { v1, v2, stroke: stroke as SpherePoint[] }),
  /** Dev aid: full commit pipeline (history snapshot + applyMove + afterMoveCommitted), so a
   *  console-driven move behaves like a real one (tracked-check scheduling, committedMoves, etc). */
  commitMove(v1: number, v2: number, stroke: unknown[]) {
    pushHistorySnapshot();
    const sphereStroke = stroke as SpherePoint[];
    applyMove(state, { v1, v2, stroke: sphereStroke });
    afterMoveCommitted(v1, v2, sphereStroke);
  },
  undoLast: () => undoLast(),
  get committedMoves() {
    return history.flatMap(h => h.committed ? [h.committed] : []);
  },
  resetGame: (spots: number) => resetGame(spots),
  /** Dev aid: load a save file (parsed SaveFileV2 object) without going through the file input. */
  loadFromJson: (save: SaveFileV2) => loadGameState(save),
  get trackedCheckEnabled() { return trackedCheckEnabled; },
  /** "ID-based Sequencing" debug toggle — which form (label vs raw vertex id) Save/Recreate-style
   *  tooling should read out of moveSeqLog's moveSeq/moveSeqRaw fields. */
  get useRawVertexIds() { return useRawVertexIds; },
  setTrackedCheckEnabled(v: boolean) { trackedCheckEnabled = v; },
  get pendingTrackedCheck() { return pendingTrackedCheck; },
  dumpLog(n = 5) {
    for (const e of moveLog.slice(-n)) {
      console.log(`\n--- move #${e.index}: v${e.move.v1}→v${e.move.v2}${e.move.isLoop ? ' (loop)' : ''} [${e.path}] ---`);
      for (const line of e.trace) console.log(line);
    }
  },
  /** Dev aid: full graph/encoding snapshot for the last n moves, for diffing a
   *  "good" run against a "bad" run of the same nominal move sequence. */
  dumpGraph(n = 2) {
    return moveLog.slice(-n).map(e => ({
      index: e.index,
      move: e.move,
      ...e.graphAfter,
    }));
  },
  // Recreate test harness (dev aid for round-trip verification).
  test: {
    createInitialState,
    cloneState,
    applyMove,
    computeMoveCode,
    canonicalEncoding,
    parseMoveSequence,
    synthesizeMove,
  },
};

// ---------------------------------------------------------------------------
// Turn indicator
// ---------------------------------------------------------------------------

const turnIndicator = document.getElementById('turn-indicator') as HTMLSpanElement;
const topBar        = document.getElementById('top-bar')        as HTMLDivElement;

function isGameOver(): boolean {
  // The region layer already marks a region dead when no legal move can be made
  // within it (see recomputeRegions). The game is over exactly when every region
  // is dead — no need to re-derive move availability from the vertex set here.
  for (const r of state.regions.values()) {
    if (!r.isDead) return false;
  }
  return true;
}

// Turn indicator stays blank until the player has actually started a game (New Game / Load),
// rather than showing "Player 1's turn" for the default position that's up before any action.
let gameStarted = false;

function updateTurnIndicator(): void {
  if (!gameStarted) { turnIndicator.textContent = ''; topBar.classList.remove('game-over'); return; }
  const movesMade = state.moveCount;
  if (isGameOver()) {
    // The player to move (movesMade % 2) can't, so they lose; the other wins.
    const winner = ((movesMade + 1) % 2) + 1;
    turnIndicator.textContent = `Player ${winner} wins!`;
    turnIndicator.style.color = '#8b0000';
    topBar.classList.add('game-over');
  } else {
    turnIndicator.textContent = `Player ${(movesMade % 2) + 1}'s turn`;
    turnIndicator.style.color = '';
    topBar.classList.remove('game-over');
  }
}
updateTurnIndicator();

// ---------------------------------------------------------------------------
// Auto-recentering
// ---------------------------------------------------------------------------

const BOUNDARY_Z_THRESHOLD = 0.80;
const RECENTER_SPEED = Math.PI / 0.5;

let recenterAxis: SpherePoint | null = null;
let recenterAngleLeft = 0;

function startRecenter(): void {
  let maxZ = -Infinity;
  let worstCamPos: SpherePoint | null = null;

  for (const v of state.vertices.values()) {
    if (v.isPseudo || v.degree >= 3) continue;
    const cp = rotateSpherePoint(v.pos, camera);
    if (cp.z > maxZ) { maxZ = cp.z; worstCamPos = cp; }
  }

  if (!worstCamPos || maxZ <= BOUNDARY_Z_THRESHOLD) return;

  const xyLen = Math.sqrt(worstCamPos.x ** 2 + worstCamPos.y ** 2);
  if (xyLen < 1e-9) return;

  recenterAxis      = { x: -worstCamPos.y / xyLen, y: worstCamPos.x / xyLen, z: 0 };
  recenterAngleLeft = Math.acos(BOUNDARY_Z_THRESHOLD) - Math.acos(Math.min(1, maxZ));
}

// Resize listener + initial layout sync are wired later, once the wide-panel toggle
// elements exist (see syncLayoutMode near the end of the Math-menu toggle section).

// ---------------------------------------------------------------------------
// Undo history
// ---------------------------------------------------------------------------
// Each committed move pushes a deep clone of the pre-move state. Undo restores
// the latest snapshot, rolling back the move AND any shrink/pop it triggered.

const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
// One pre-move state snapshot + the (v1,v2) move committed from it, kept as a single unit so undo
// (or the candidate-preview cancel path below) can never pop `state` without also popping the
// matching move, or vice versa. `committed` starts null the instant pushHistorySnapshot() fires
// (the move hasn't resolved yet) and is filled in by afterMoveCommitted() once it has -- a cancelled
// stroke (onMoveCommitted's candidatePreviewList branch) pops a still-null entry via undoLast()
// instead. Was six independently push/pop'd parallel arrays (`history`, `moveSequence`,
// `moveSequenceRaw`, `moveSequenceTagged`, `moveSequenceRawTagged`, `committedMoves`) before the
// project_parallel_structure_refactor_backlog.md item 1 cleanup, which also fixed a real latent bug
// that split shape enabled: undoLast() used to pop moveSequence*/committedMoves unconditionally,
// so cancelling a candidate-preview stroke (which never pushes to those four/one, only to `history`)
// silently deleted the PRIOR real move's log entry instead. Structurally impossible now.
type HistoryEntry = HistoryStepInput;
const history: HistoryEntry[] = [];
// Move sequence, stored in both label form (default display) and raw-vertex-ID form, computed once
// per move at commit time -- the "Use vertex ID" toggle is then a pure display swap, never a
// retroactive recompute. `*Tagged` are the sequence-verifier-on variants (same tokens, always with
// the {encoding} suffix, regardless of the current Move Check toggle) kept so the Copy button can
// hand out a verifiable sequence even when the toggle is off (see updateMoveSeq / moveSeqCopyText).
// Kept as its OWN array (not folded into HistoryEntry) because it does NOT stay 1:1 with `history`:
// loadGameState only has a save's final geometry, not its intermediate per-move states, so it
// rebuilds moveSeqLog straight from the save's recorded tokens while leaving `history` empty
// (Undo is correctly unavailable for a loaded game; the move-sequence display/Recreate log is not).
interface MoveSeqEntry {
  moveSeq: string;
  moveSeqRaw: string;
  moveSeqTagged: string;
  moveSeqRawTagged: string;
}
const moveSeqLog: MoveSeqEntry[] = [];
// Redo stack for the Position Browser's Sync-mode forward arrow (undo/redo of the live game). Each
// entry captures everything undoLast() throws away, so redoLast() can re-apply it. Cleared whenever
// a genuinely new move is committed (afterMoveCommitted) or the game is reset/loaded — a new branch
// off an undone position invalidates the redo tail.
interface RedoEntry {
  postState: GameState;          // the state we were at before this undo — restored on redo
  historyEntry: HistoryEntry;    // the pre-move snapshot + committed move undo popped off `history`
  moveLogEntry: MoveSeqEntry;    // the matching moveSeqLog entry
}
const redoStack: RedoEntry[] = [];
// Starting spot count of the current game; prefixed onto the Move Sequence
// string (e.g. "3:0X-1/...") so Recreate can rebuild untouched starting spots.
let currentSpotCount = INITIAL_SPOTS;

// Recreate playback state. `recreateActive` blocks live input while moves auto-
// play; `manualAwait` is set while paused for a hand-drawn move that couldn't be
// synthesized, holding the pre-move snapshot + the resolver that resumes playback.
let recreateActive = false;
// True while replaying a sequence recorded with spot labels ("nL:..." prefix) —
// all ResolvedMove.lo/hi in `seq.moves` are labels, resolved to raw vertex IDs
// (via resolveLabelToVertexId against the live state.spotLabels, which stays
// in lockstep with the original recording) at the top of each loop iteration
// in runRecreate. Downstream oracle comparisons (strokeReproduces,
// appliedMoveMatches) then re-derive the label-based token for comparison.
let recreateUseLabels = false;
let recreatePaused = false;
let manualAwait: { parsed: ResolvedMove; before: GameState; resolve: (ok: boolean) => void } | null = null;
let manualHints: RecreateHints | null = null;

// Voronoi subregion visualization — shown during Recreate manual-draw fallback for enclosure moves.
let subregionHighlight: SubregionHighlight | null = null;

// Blue hint arc shown during manual-draw fallback (the best Voronoi candidate, even if it didn't verify).
let proposedArc: SpherePoint[] | null = null;
let lastVoronoiGraph: import('./model/voronoiGraph').VoronoiGraph | null = null;
let lastVoronoiCCs: import('./math/sphere').SpherePoint[] | null = null;
let lastVoronoiExtraSeeds: { pos: import('./math/sphere').SpherePoint; hue: number }[] | null = null;
let lastVoronoiFullNodes: import('./model/voronoiGraph').VoronoiNodeData[] | null = null;
let lastVoronoiSurvivingIds: number[] | null = null;
let lastVoronoiFakeCgrId: number | null = null;

// When true, pause on every automated Recreate move to show candidates before committing.
let pauseRecreations = false;

// Debug menu: Position Browser fail-ring fallback (unreachable child, no stroke synthesized) is
// hidden from normal play by default — a known stroke-synthesis coverage gap, not a player-facing
// signal. Off unless a developer flips it on.
let showBroken = false;
let showRawMovePlan = false;

// Arc-preview state: set while the user inspects candidate arcs before committing.
let candidatePreviewList: { stroke: SpherePoint[]; legal: boolean }[] | null = null;
let candidateResolve: ((go: boolean) => void) | null = null;

function updateUndoButton(): void {
  undoBtn.disabled = history.length === 0 || recreateActive;
}

function updateSaveButton(): void {
  saveGameBtn.disabled = !gameStarted;
}

// The move-sequence bar (bottom of screen, Debug mode only) mirrors `moveSeqLog`, which is
// recorded unconditionally for Save/Recreate regardless of whether Debug mode is unlocked yet.
// All four vertex-ID x sequence-verifier variants live on every entry (see moveSeqLog's own doc
// comment); this just picks which one to show based on the current toggles.
/**
 * The full Move Sequence string: `n` + markers + ':' + tokens. The markers tell Recreate how to read
 * the tokens — `L` when they're spot labels (parseMoveSequence otherwise reads every number as a raw
 * vertex id, and label ranges like "[-3..-2]" can't replay), `C` when they carry {encoding} tags to
 * verify. `tagged` picks the Move Check variant of each token.
 */
function formatMoveSequence(tagged: boolean): string {
  const tokens = moveSeqLog.map(m => useRawVertexIds
    ? (tagged ? m.moveSeqRawTagged : m.moveSeqRaw)
    : (tagged ? m.moveSeqTagged : m.moveSeq));
  return `${currentSpotCount}${useRawVertexIds ? '' : 'L'}${tagged ? 'C' : ''}:${tokens.join('/')}`;
}
/** Copy always hands out the sequence-verifier-on ({encoding}-tagged) variant, matching the
 * current vertex-ID/label toggle, regardless of whether Move Check is currently switched on —
 * so the copied sequence is verifiable even if the user just wants to look at plain move text. */
function moveSeqCopyText(): string {
  return formatMoveSequence(true);
}
function updateMoveSeq(): void {
  const text = formatMoveSequence(moveCheckMode);

  if (debugUnlocked) {
    moveSeqText.textContent = text;
    moveSeqBar.classList.add('visible');
  } else {
    moveSeqBar.classList.remove('visible');
  }

  if (isSyncMode()) {
    pbMoveSeqText.textContent = text;
    pbMoveSeqBar.classList.add('visible');
  } else {
    pbMoveSeqBar.classList.remove('visible');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (!recreateActive) undoBtn.click();
  }
  if (e.key === ' ' && recreateActive && !manualAwait && !candidatePreviewList) {
    e.preventDefault();
    setPaused(!recreatePaused);
  }
  if (e.key === 'Enter' && candidatePreviewList && candidateResolve) {
    e.preventDefault();
    const resolve = candidateResolve;
    candidatePreviewList = null;
    candidateResolve = null;
    hideBanner();
    wake();
    resolve(true);
  }
  // Escape closes the Guide, else whichever overlay dialog is open (the Position Browser handles
  // its own Escape — unlock a locked preview first).
  if (e.key === 'Escape') {
    if (isGuideOpen()) { closeGuide(); return; }
    const open = overlayClosers.find(o => o.overlay.classList.contains('visible'));
    if (open) { open.close(); return; }
  }
  // In manual-draw mode with a proposed arc, Enter force-commits that arc as a
  // proper edge without token verification (best-effort for blocked enclosures).
  if (e.key === 'Enter' && manualAwait && proposedArc) {
    e.preventDefault();
    const arc = proposedArc;
    proposedArc = null; // consume immediately so rapid Enter presses are no-ops
    const await_ = manualAwait;
    try {
      pushHistorySnapshot();
      applyMove(state, { v1: await_.parsed.lo, v2: await_.parsed.hi, stroke: arc });
      afterMoveCommitted(await_.parsed.lo, await_.parsed.hi, arc);
      clearManualPause();
      wake();
      await_.resolve(true);
    } catch (err) {
      console.error('[Enter force-commit] threw:', err);
      undoLast();
    }
  }
});

/** Roll back the latest committed move (and anything it triggered). When `recordRedo` (a genuine
 * user undo — the toolbar button, Ctrl+Z, or the Sync-mode back arrow), the undone move is pushed
 * onto the redo stack so it can be replayed; internal cancel-style undos (candidate-preview discard,
 * Recreate rollback) pass false so they don't create bogus redo entries. */
function undoLast(recordRedo = false): void {
  if (history.length === 0) return;
  const top = history[history.length - 1];
  if (recordRedo) {
    // Real user-initiated undo only ever runs between a fully-completed pushHistorySnapshot() +
    // afterMoveCommitted() pair (both synchronous, no await between them at any call site), so by
    // the time a user can click Undo the top entry's move has always resolved -- `top.committed`
    // and the matching moveSeqLog entry are guaranteed non-null/present here.
    redoStack.push({
      postState: cloneState(state),
      historyEntry: top,
      moveLogEntry: moveSeqLog[moveSeqLog.length - 1],
    });
  }
  Object.assign(state, history.pop()!.state);
  // Cancelled candidate-preview strokes push a `history` entry (still-null `committed`) but never
  // reach afterMoveCommitted, so they never push a moveSeqLog entry either -- only pop the log for
  // an entry that actually completed (see HistoryEntry's own doc comment for the bug this avoids).
  if (top.committed) moveSeqLog.pop();
  pendingCollapse = null;
  generalCollapseFocus = null;
  // The forward-only tracked map can't rewind in place, but it CAN be rebuilt from scratch
  // by replaying every still-committed move (Catch D, project_encoding_canon_rework M6):
  // mark desynced immediately (safe default while the replay is in flight), then let
  // resyncTrackedFromHistory() un-desync it if the replay fully matches. If it doesn't
  // (or the module isn't loaded / toggle is off), it just stays desynced as before.
  pendingTrackedCheck = null;
  tracked.markDesynced();
  updateTrackedPanel(null);
  void resyncTrackedFromHistory();
  input.pointerCancel();
  updateTurnIndicator();
  updateUndoButton();
  updateMoveSeq();
  wake();
}

/** Replay the most recently undone move (the Sync-mode forward arrow). Mirrors undoLast in reverse:
 * pushes the pre-move snapshot back onto `history`, restores the matching moveSeqLog entry, and
 * jumps `state` to the captured post-move geometry. Blocked during Recreate playback. */
function redoLast(): void {
  if (redoStack.length === 0 || recreateActive) return;
  const entry = redoStack.pop()!;
  history.push(entry.historyEntry);
  moveSeqLog.push(entry.moveLogEntry);
  Object.assign(state, entry.postState);
  pendingCollapse = null;
  generalCollapseFocus = null;
  // Same forward-only-tracked-map rebuild as undo: mark desynced, then replay from scratch.
  pendingTrackedCheck = null;
  tracked.markDesynced();
  updateTrackedPanel(null);
  void resyncTrackedFromHistory();
  input.pointerCancel();
  updateTurnIndicator();
  updateUndoButton();
  updateMoveSeq();
  wake();
}

/**
 * Rebuild the tracked map from a fresh seed by replaying every currently-committed move (each
 * `history` entry's own `committed`) through the same onMoveSettled path a live move uses. Fully
 * reuses the already-verified match/carryForward/face-check machinery — no new matching algorithm.
 * Snapshots `history` at the start so a new move made while this is still in flight (a handful of
 * awaited WASM calls) can't pull the rug out from under it; if that race does happen, the newer
 * move's own onMoveSettled call simply supersedes whatever this leaves behind (tracked.map is
 * always "last write wins"). NOT built for load (Catch D remains open there): a loaded save has
 * only its final geometry, not the intermediate per-move states this replay needs to derive each
 * move's generated-midpoint vertex — reconstructing those would mean re-deriving the whole game
 * via move synthesis (Recreate-style), a separate, heavier undertaking.
 */
async function resyncTrackedFromHistory(): Promise<void> {
  if (!trackedCheckEnabled) return;
  const entries = history.slice();
  const finalState = cloneState(state);
  const seedSpotIds = entries.length > 0 ? [...entries[0].state.vertices.keys()] : [...finalState.vertices.keys()];

  tracked.reset(seedSpotIds);
  for (let k = 0; k < entries.length; k++) {
    const entry = entries[k];
    if (!entry.committed) { tracked.markDesynced(); return; }
    const settledState = k + 1 < entries.length ? entries[k + 1].state : finalState;
    const newVertexIds = new Set<VertexId>();
    for (const [vid, v] of settledState.vertices) {
      if (!entry.state.vertices.has(vid) && !v.isPseudo) newVertexIds.add(vid);
    }
    const res = await tracked.onMoveSettled(settledState, entry.committed.v1, entry.committed.v2, newVertexIds);
    if (res.status !== 'match') { tracked.markDesynced(); return; }
  }
  updateTrackedPanel(null);
}

undoBtn.addEventListener('click', () => undoLast(true));

bottomBarCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(bottomBarText.textContent ?? '');
});

// ---------------------------------------------------------------------------
// Collapse queue (one at a time)
// ---------------------------------------------------------------------------
//
// Only one collapse animates at once — a special collapse (pendingCollapse) or one
// fully-dead component shrinking under deadRegionStep (generalCollapseFocus) — and
// it runs to its pop before the next is picked up. The instant surgeries
// (scabAloneCollapse, eliminateIsolatedVertex) have no animation and still run as
// soon as they apply.

let pendingCollapse: SpecialCollapse | null = null;
/** Vertex ids of the fully-dead component deadRegionStep is shrinking, null when none. */
let generalCollapseFocus: Set<VertexId> | null = null;

function collapseActive(): boolean {
  return pendingCollapse !== null || generalCollapseFocus !== null;
}

/** Pick up the next special collapse, if none is running. Called again when the
 * current general shrink finishes, so a check suppressed during it isn't lost. */
function checkForCollapses(): void {
  if (collapseActive()) return;
  if (collapseCountThisMove >= MAX_COLLAPSES_PER_MOVE) return;
  pendingCollapse = detectSpecialCollapse(state);
  collapseSnapshot = pendingCollapse ? { of: pendingCollapse, state: cloneState(state) } : null;
}

/** The board as it stood when the current special collapse was detected — what a refused one
 * reverts to (its animation has moved geometry outside the encoding gate's rollback). */
let collapseSnapshot: { of: SpecialCollapse; state: GameState } | null = null;

const collapseOffNote = document.getElementById('collapse-off-note') as HTMLDivElement;

/**
 * Handle a dead-region surgery the encoding gate refused (takeEncodingGateRefusal): a collapse
 * bug. The refused surgery itself is already rolled back; when it was the special collapse
 * `finished`, whose animation has also moved geometry, the board goes back to how it stood when
 * that collapse was detected. Either way collapsing is switched off (the next attempt would hit the
 * same bug) and the playfield says so. Returns whether a refusal was handled.
 */
function revertIfCollapseRefused(finished?: SpecialCollapse): boolean {
  if (!takeEncodingGateRefusal()) return false;
  if (finished && collapseSnapshot?.of === finished) Object.assign(state, collapseSnapshot.state);
  console.warn(`[collapse] encoding check refused ${finished ? finished.kind : 'a surgery'} — ${finished ? 'reverted; ' : ''}collapsing turned off`);
  logCollapse(`${finished?.kind ?? 'surgery'} REFUSED — collapsing off`);
  collapseSnapshot = null;
  pendingCollapse = null;
  generalCollapseFocus = null;
  shrinkCheckbox.checked = false;
  collapseOffNote.classList.add('visible');
  resampleAllEdges(state);
  wake();
  return true;
}

// ---------------------------------------------------------------------------
// Input handler
// ---------------------------------------------------------------------------

/** Snapshot the pre-move state for undo. (InputHandler.onBeforeMove) */
function pushHistorySnapshot(): void {
  history.push({ state: cloneState(state), committed: null });
  updateUndoButton();
}

/**
 * The post-move commit pipeline: resample edges, record the move code, advance
 * the turn indicator, and run dead-region collapses. Shared by live play and
 * the Recreate controller so both paths behave identically.
 */
function afterMoveCommitted(v1: number, v2: number, stroke: SpherePoint[]): void {
  // A genuinely new move branches off wherever we are now — any redo tail is no longer reachable.
  redoStack.length = 0;
  // Resample all edges so point counts reflect current geometry
  resampleAllEdges(state);
  // Record move code (pre-move state is the last history snapshot)
  const top = history[history.length - 1];
  const prevState = top?.state;
  if (top && prevState) {
    state.spotLabels = recomputeSpotLabels(prevState.spotLabels, prevState, state, v1, v2);
    // A departing spot endpoint is fixed by the recompute above, so lo/hi
    // resolve correctly off the POST-move map; a non-spot endpoint (or one
    // that was already fixed in an earlier move) also resolves correctly
    // since fixed entries persist in the map forever.
    const entry = moveSeqEntryOf(prevState, state, v1, v2);
    const raw = entry.moveSeqRaw;
    // Debug-unlock detection: only live play counts (not Recreate playback), and only from a
    // fresh 4-spot game — any move off the target sequence's prefix resets the streak.
    if (!recreateActive && !debugUnlocked && currentSpotCount === DEBUG_UNLOCK_SPOTS) {
      const idx = liveUnlockTokens.length;
      if (idx < DEBUG_UNLOCK_SEQUENCE.length && raw === DEBUG_UNLOCK_SEQUENCE[idx]) {
        liveUnlockTokens.push(raw);
        if (liveUnlockTokens.length === DEBUG_UNLOCK_SEQUENCE.length) unlockDebugMode();
      } else {
        liveUnlockTokens.length = 0;
      }
    }
    if (showEnclosureSides) {
      const sides = computeEnclosureSideColoring(prevState, state, v1, v2);
      if (sides) {
        lastEnclosureSideColors = new Map();
        for (const vid of sides.arcSideVertexIds) lastEnclosureSideColors.set(vid, 'red');
        for (const vid of sides.otherSideVertexIds) lastEnclosureSideColors.set(vid, 'blue');
      } else {
        lastEnclosureSideColors = undefined;
      }
      const coverage = computeEnclosureCoverage(prevState, state, v1, v2, ENCLOSURE_COVERAGE_SAMPLE);
      lastEnclosureCoverage = coverage
        ? coverage.map((side, i) => ({ pos: ENCLOSURE_COVERAGE_SAMPLE[i], side }))
        : undefined;
    }
    // Recorded regardless of moveCheckMode so Recreate can verify a "C"-tagged
    // sequence even if this session's toggle happens to be off during replay.
    lastCommittedEncoding = encodePosition(state).text;
    top.committed = { v1, v2, rawStroke: stroke };
    moveSeqLog.push(entry);
    updateMoveSeq();
  }
  updateTurnIndicator();
  if (shrinkCheckbox.checked) {
    // Collapse dead-region scabs first so their vertex lands in livingVertexSet
    // before eliminateIsolatedVertex runs — otherwise the scab is wrongly spliced out.
    // Pass louse outer vertices as skip set (they are degree-3 and never scab candidates,
    // but passing them is harmless and future-proof).
    const louseOnMove = detectLouse(state);
    scabAloneCollapse(state, louseOnMove ? new Set([...louseOnMove.outer]) : undefined);
    // Eliminate fresh isolated midpoints synchronously before collapse detection,
    // so detectTriangleDead etc. see the final topology (not a transient degree-2 midpoint).
    while (eliminateIsolatedVertex(state) !== null) {}
    if (!revertIfCollapseRefused()) checkForCollapses();
  }
  // Record the (canonical) game-tree edge for the Position Browser's "Known Parents". The
  // position has now settled (post-collapse); prevState is the settled pre-move position.
  if (prevState) recordGameplayEdge(prevState, state);
  // Stash the tracked-encoding check; it fires once the position's TOPOLOGY has settled (all pops
  // and collapses done). The engine child is fully cleaned, so it only matches geometry after the
  // pops have popped — but we can't wait for strict render idle, since smoothing may jitter
  // indefinitely. Instead poll for topology quiescence (no pending collapse + stable vertex/edge
  // counts), which ignores cosmetic smoothing.
  if (trackedCheckEnabled && prevState) {
    pendingTrackedCheck = { v1, v2, parentVertexIds: new Set(prevState.vertices.keys()) };
    scheduleTrackedCheck();
  }
  // Start the force winddown countdown now — all the synchronous freeze work
  // above (region recompute, collapse detection) is done, so the countdown
  // reflects animation time only, not calculation time.
  resetActivityTimer(3000);
  wake();
}

/**
 * A committed move's four recorded token forms (label / raw-id, plain / {encoding}-tagged), from
 * the boards immediately before and after it. `after.spotLabels` must already be the post-move
 * labels (a departing spot endpoint is only fixed once the move is made). Used at commit time and
 * to rebuild a loaded game's log from its saved history.
 */
function moveSeqEntryOf(before: GameState, after: GameState, v1: VertexId, v2: VertexId): MoveSeqEntry {
  const labeled = computeMoveCode(before, v1, v2, after, labelForFromMap(after.spotLabels), spotGroupForFromMap(after.spotLabels));
  const raw = computeMoveCode(before, v1, v2, after);
  const tag = `{${encodePosition(after).text}}`;
  return { moveSeq: labeled, moveSeqRaw: raw, moveSeqTagged: labeled + tag, moveSeqRawTagged: raw + tag };
}

/** Fire the pending tracked check once topology is quiescent. Polls itself until no special
 *  collapse is pending and the graph size has held steady for one interval (or a timeout). */
let trackedPollLast: { nV: number; nE: number } | null = null;
let trackedPollDeadline = 0;
function scheduleTrackedCheck(): void {
  trackedPollLast = null;
  trackedPollDeadline = performance.now() + 12000; // hard cap so a stuck collapse can't wedge it (collapses run one at a time, so a chain can take a while)
  const poll = (): void => {
    if (pendingTrackedCheck === null) return; // consumed/cancelled (undo, reset, newer move)
    const nV = state.vertices.size, nE = state.edges.size;
    const quiescent = !collapseActive() && trackedPollLast !== null &&
      trackedPollLast.nV === nV && trackedPollLast.nE === nE;
    if (quiescent || performance.now() > trackedPollDeadline) { runPendingTrackedCheck(); return; }
    trackedPollLast = { nV, nE };
    setTimeout(poll, 150);
  };
  setTimeout(poll, 150);
}

/** Run the stashed tracked-encoding check against the now-settled geometry. Fire-and-forget. */
function runPendingTrackedCheck(): void {
  const p = pendingTrackedCheck;
  if (p === null) return;
  pendingTrackedCheck = null;
  // The move's one generated vertex is the midpoint. Exclude pseudo-vertices (rebuilt each
  // recomputeRegions for parallel edges, large-negative ids) so a loop/parallel move doesn't make
  // this look like several new vertices.
  const newVertexIds = new Set<VertexId>();
  for (const [vid, v] of state.vertices) {
    if (!p.parentVertexIds.has(vid) && !v.isPseudo) newVertexIds.add(vid);
  }
  void tracked.onMoveSettled(state, p.v1, p.v2, newVertexIds).then(res => {
    if (res.status === 'match') {
      if (DEBUG.tracked) console.log(`[tracked] match: ${res.enc}${res.matchCount && res.matchCount > 1 ? ` (${res.matchCount} automorphic)` : ''}`);
      updateTrackedPanel({ mismatch: false });
    } else if (res.status === 'mismatch') {
      console.warn(`[tracked] MISMATCH — engine=${res.engineKey} geometry=${res.geometryKey}`);
      // Only maroon when geometry is actually cleaned (shrink on); with shrink off, un-popped dead
      // structure legitimately differs from the engine's cleaned child, so a mismatch is expected.
      if (shrinkCheckbox.checked) { recreateCheckFailed = true; wake(); }
      updateTrackedPanel({ mismatch: true, engineKey: res.engineKey, geometryKey: res.geometryKey, enc: res.enc ?? undefined, charInfo: res.charInfo });
    } else {
      if (DEBUG.tracked) console.log(`[tracked] ${res.status}`);
      updateTrackedPanel(null);
    }
  });
}

/**
 * Fire-and-forget: canonicalize the pre/post-move positions via the engine and record the edge in
 * the position cache so the Position Browser can surface real gameplay parents. Silently no-ops if
 * the engine isn't built yet (canon() returns '').
 */
function recordGameplayEdge(prev: GameState, next: GameState): void {
  const prevEnc = liveAnalysisText(prev); // same decompressed form the Position Browser keys on
  const nextEnc = liveAnalysisText(next);
  void Promise.all([canonEncoding(prevEnc), canonEncoding(nextEnc)]).then(([p, n]) => {
    if (p && n && p !== n) recordEdge(p, n);
  });
}

const input = new InputHandler({
  gameState:    state,
  renderer,
  getCameraRef: () => camera,
  onRotate: (dx, dy) => {
    camera = composeRotations(
      rotationX(dy * DRAG_SENSITIVITY),
      composeRotations(rotationY(dx * DRAG_SENSITIVITY), camera),
    );
  },
  onRotateEnd: () => { startRecenter(); wake(); },
  onBeforeMove: () => { pushHistorySnapshot(); },
  onMoveCommitted: (v1, v2, stroke) => {
    // Discard strokes drawn during candidate preview (only rotation is intended).
    if (candidatePreviewList) { undoLast(); return; }
    afterMoveCommitted(v1, v2, stroke);
    // During the Recreate manual-draw fallback, validate the hand-drawn move
    // against the target token before letting playback resume.
    if (manualAwait) verifyManualMove(v1, v2);
  },
});

// ---------------------------------------------------------------------------
// Manual recenter (double-click / double-right-click)
// ---------------------------------------------------------------------------

let manualRecenterTarget: SpherePoint | null = null;

function startManualRecenter(worldTarget: SpherePoint): void {
  manualRecenterTarget = worldTarget;
  recenterAxis = null;
  recenterAngleLeft = 0;
  wake();
}

canvas.addEventListener('dblclick', e => {
  const px = e.clientX;
  const py = e.clientY - TOP_BAR_H;
  input.pointerCancel();
  const p = input.toSpherePoint(px, py);
  startManualRecenter({ x: -p.x, y: -p.y, z: -p.z });
});

let lastRightClickTime = 0;
let lastRightClickX = 0;
let lastRightClickY = 0;

/** True while Recreate is auto-playing (not paused for a manual draw). */
function inputBlocked(): boolean { return recreateActive && !manualAwait; }

// Mouse events
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown',  e => {
  if (inputBlocked() && !candidatePreviewList) return;
  if (e.button === 2) {
    const px = e.clientX;
    const py = e.clientY - TOP_BAR_H;
    const now = performance.now();
    if (now - lastRightClickTime < 400 && Math.hypot(px - lastRightClickX, py - lastRightClickY) < 30) {
      lastRightClickTime = 0;
      input.pointerCancel();
      // Offset slightly so a click exactly on a vertex doesn't send it to the back pole (z=-1).
      startManualRecenter(input.toSpherePoint(px + 20, py + 20));
    } else {
      lastRightClickTime = now;
      lastRightClickX = px;
      lastRightClickY = py;
      input.pointerDownRight(px, py);
      wake();
    }
  } else {
    input.pointerDown(e.clientX, e.clientY - TOP_BAR_H);
    wake();
  }
});
canvas.addEventListener('mousemove',  e => { input.pointerMove(e.clientX, e.clientY - TOP_BAR_H); wake(); });
canvas.addEventListener('mouseup',    e => { input.pointerUp(e.clientX, e.clientY - TOP_BAR_H);   wake(); });
canvas.addEventListener('mouseleave', () => { input.pointerCancel(); wake(); });

// Touch events
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (inputBlocked()) return;
  input.pointerDown(e.touches[0].clientX, e.touches[0].clientY - TOP_BAR_H);
  wake();
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  input.pointerMove(e.touches[0].clientX, e.touches[0].clientY - TOP_BAR_H);
  wake();
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  const t = e.changedTouches[0];
  input.pointerUp(t.clientX, t.clientY - TOP_BAR_H);
  wake();
}, { passive: false });

canvas.addEventListener('touchcancel', () => { input.pointerCancel(); wake(); });

// ---------------------------------------------------------------------------
// Debug dropdown
// ---------------------------------------------------------------------------

const debugBtn      = document.getElementById('debug-btn')      as HTMLButtonElement;
const debugPanel    = document.getElementById('debug-panel')    as HTMLDivElement;
const debugMenuWrap = document.getElementById('debug-menu-wrap') as HTMLDivElement;

debugBtn.addEventListener('click', e => {
  e.stopPropagation();
  debugPanel.classList.toggle('open');
});

// ---------------------------------------------------------------------------
// Debug mode unlock: the Debug menu and Recreate button are hidden until either the secret
// move sequence below is played live (from a fresh 4-spot game) or the off-screen "AI Mode"
// button is clicked. Once unlocked, stays unlocked for the rest of this browser session
// (surviving New Game / Load) — there's no re-lock.
// ---------------------------------------------------------------------------

const DEBUG_UNLOCK_SPOTS = 4;
// Vertex-ID move tokens: up-loop, up-loop, down-loop, down-loop, left-right, left-right.
const DEBUG_UNLOCK_SEQUENCE = ['-4X-4[]', '-2X-2[]', '-3X-1', '-3X-1[]'];

let debugUnlocked = false;
// Raw (untagged) vertex-ID tokens for the CURRENT live game, used only to detect the unlock
// sequence — kept separate from moveSeqLog's moveSeqRaw field because that field may carry the
// Sequence Verifier's {encoding} suffix, which would break an exact string match here.
let liveUnlockTokens: string[] = [];

function unlockDebugMode(): void {
  if (debugUnlocked) return;
  debugUnlocked = true;
  debugMenuWrap.style.display = '';
  recreateBtn.style.display = '';
  updateMoveSeq();
}

const aiModeBtn = document.getElementById('ai-mode-btn') as HTMLButtonElement;
aiModeBtn.addEventListener('click', () => unlockDebugMode());

// Guide (top bar).
const guideBtn      = document.getElementById('guide-btn')       as HTMLButtonElement;
const guideOverlay  = document.getElementById('guide-overlay')   as HTMLDivElement;
const guideClose    = document.getElementById('guide-close')     as HTMLButtonElement;
const browserBtn    = document.getElementById('browser-btn')      as HTMLButtonElement;

guideBtn.addEventListener('click', e => {
  e.stopPropagation();
  openGuide();
});
guideClose.addEventListener('click', () => closeGuide());
guideOverlay.addEventListener('click', e => {
  if (e.target === guideOverlay) closeGuide();
});

document.querySelectorAll<HTMLButtonElement>('.guide-hint').forEach(btn => {
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openGuide(btn.dataset.guideTopic);
  });
});

/** Every modal overlay dialog, for Escape (see the keydown handler). */
const overlayClosers: { overlay: HTMLElement; close: () => void }[] = [];

/** Wire a modal overlay: its close button, a click on the backdrop, and Escape all close it. */
function wireOverlay(overlay: HTMLElement, closeBtn: HTMLElement, onClose?: () => void): void {
  const close = (): void => { overlay.classList.remove('visible'); onClose?.(); };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlayClosers.push({ overlay, close });
}

/** A top-bar panel: its button builds the panel (first time) and opens the overlay. */
function wirePanel(name: string, init: () => void): void {
  const overlay = document.getElementById(`${name}-overlay`) as HTMLDivElement;
  (document.getElementById(`${name}-btn`) as HTMLButtonElement).addEventListener('click', e => {
    e.stopPropagation();
    init();
    overlay.classList.add('visible');
  });
  wireOverlay(overlay, document.getElementById(`${name}-close`) as HTMLButtonElement);
}

wirePanel('collect', initCollect);
wirePanel('ttree', initTTree);
wirePanel('genomes', initGenomes);

// Only shown (below the wide-panel breakpoint) as a way to open the same Position Browser
// the wide layout would otherwise show as a persistent side panel.
browserBtn.addEventListener('click', e => {
  e.stopPropagation();
  openPositionBrowser(liveAnalysisText(state));
});

// ---------------------------------------------------------------------------
// Save / Load game state
// ---------------------------------------------------------------------------

const saveGameBtn  = document.getElementById('save-game-btn')  as HTMLButtonElement;
const loadGameBtn  = document.getElementById('load-game-btn')  as HTMLButtonElement;
const loadGameInput = document.getElementById('load-game-input') as HTMLInputElement;

saveGameBtn.addEventListener('click', e => {
  e.stopPropagation();
  const save = serializeGameState(state, camera, currentSpotCount, moveSeqLog.map(m => moveCheckMode ? m.moveSeqTagged : m.moveSeq), manualAwait?.parsed.token ?? null, history);
  const json = JSON.stringify(save, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sprouts-save-${Date.now()}.json`; a.click();
  URL.revokeObjectURL(url);
  debugPanel.classList.remove('open');
});

loadGameBtn.addEventListener('click', e => {
  e.stopPropagation();
  loadGameInput.click();
});

loadGameInput.addEventListener('change', () => {
  const file = loadGameInput.files?.[0] ?? null;
  loadGameInput.value = ''; // allow re-selecting the same file later
  if (!file) return;
  debugPanel.classList.remove('open');
  void file.text().then(text => {
    let save: SaveFileV2;
    try {
      save = JSON.parse(text);
    } catch (err) {
      alert(`Invalid save file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      loadGameState(save);
    } catch (err) {
      alert(`Failed to load save: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
});

/** Restore `state`/`camera`/move history from a save file, resuming a paused move if one was saved. */
function loadGameState(save: SaveFileV2): void {
  abortRecreate();

  const deserialized = deserializeGameState(save);
  Object.assign(state, deserialized.state);
  recomputeRegions(state);

  // Rebuild `history` from the save's per-move steps: each step's board gets regions
  // recomputed (same as the final state above) so it's immediately usable the instant the
  // user undoes back into it -- a save now round-trips the full undo stack, all the way back
  // to the start of the game, not just the final position. Spot labels are then chained
  // forward move by move via recomputeSpotLabels, exactly mirroring what afterMoveCommitted
  // does during live play (no longer a lossy "cosmetic renumbering" on load).
  history.length = 0;
  redoStack.length = 0;
  for (const step of deserialized.history) {
    recomputeRegions(step.state);
    history.push(step);
  }
  let replayLabels = initialSpotLabels(history.length > 0 ? history[0].state : state);
  if (history.length > 0) history[0].state.spotLabels = replayLabels;
  for (let i = 0; i < history.length; i++) {
    const committed = history[i].committed!;
    const after = i + 1 < history.length ? history[i + 1].state : state;
    replayLabels = recomputeSpotLabels(replayLabels, history[i].state, after, committed.v1, committed.v2);
    after.spotLabels = replayLabels;
  }
  state.spotLabels = replayLabels;

  // Rebuild every move's four token forms the way afterMoveCommitted recorded them: replay each
  // saved stroke on its saved pre-move board. A save only stores the label form (with or without
  // its {encoding} tag), so this is the only source of the raw-id and tagged forms. If a step can't
  // be replayed, or replays to a different label token than the save recorded, the saved token
  // stands in for all four forms.
  moveSeqLog.length = 0;
  deserialized.moveSequence.forEach((token, i) => {
    const base = stripMoveCheckTag(token);
    const step = history[i];
    if (step?.committed) {
      try {
        const { v1, v2, rawStroke } = step.committed;
        const after = cloneState(step.state);
        applyMove(after, { v1, v2, stroke: rawStroke.map(p => ({ ...p })) });
        resampleAllEdges(after);
        after.spotLabels = recomputeSpotLabels(step.state.spotLabels, step.state, after, v1, v2);
        const entry = moveSeqEntryOf(step.state, after, v1, v2);
        if (entry.moveSeq === base) { moveSeqLog.push(entry); return; }
        console.warn(`[load] move ${i + 1}: saved token ${base} but the replay records ${entry.moveSeq}; keeping the saved one`);
      } catch (err) {
        console.warn(`[load] move ${i + 1}: could not replay the saved stroke`, err);
      }
    }
    const tagged = base + moveCheckTagOf(token);
    moveSeqLog.push({ moveSeq: base, moveSeqRaw: base, moveSeqTagged: tagged, moveSeqRawTagged: tagged });
  });
  moveLog.length = 0; // the debug region-trace log starts over with the loaded game
  liveUnlockTokens.length = 0;
  currentSpotCount = deserialized.currentSpotCount;
  camera = deserialized.camera;
  pendingCollapse = null;
  generalCollapseFocus = null;
  subregionHighlight = null;
  proposedArc = null;
  recenterAxis = null;
  recenterAngleLeft = 0;
  // A save now carries full per-move history, so it can be verified the same way undo does:
  // mark desynced immediately (safe default while the replay is in flight), then let
  // resyncTrackedFromHistory() walk `history` through the WASM engine and un-desync it if the
  // whole replay matches (falls back to staying desynced if the module isn't loaded yet).
  pendingTrackedCheck = null;
  tracked.markDesynced();
  updateTrackedPanel(null);
  void resyncTrackedFromHistory();
  input.pointerCancel();
  renderer.resetRegionColors();
  updateMoveSeq();
  updateUndoButton();
  gameStarted = true;
  updateSaveButton();
  hidePlayGate();
  updateTurnIndicator();
  fitCanvas();
  renderer.resize();
  // A loaded board settles like a freshly committed move: full forces for the hold, then the
  // friction fade to a stop. Without this the winddown timer kept whatever state it was in —
  // never armed in a fresh session (full forces forever), or long expired (no settling at all).
  resetActivityTimer(3000);
  wake();

  // Saved pending moves predate range-brackets support (a mid-recreate save
  // always resumes in raw-id terms) — brackets are already plain vertex ids.
  if (deserialized.pendingMove) {
    resumePausedMove({
      ...deserialized.pendingMove,
      brackets: deserialized.pendingMove.brackets as number[] | null,
      parens: deserialized.pendingMove.parens as VertexId | 'empty' | null,
    });
  }
}
document.addEventListener('click', () => {
  debugPanel.classList.remove('open');
});

// ---------------------------------------------------------------------------
// Tuning panel — live-editable constants (src/model/tunables.ts)
// ---------------------------------------------------------------------------

loadTunables();

const tuningBtn     = document.getElementById('tuning-btn')     as HTMLButtonElement;
const tuningOverlay = document.getElementById('tuning-overlay') as HTMLDivElement;
const tuningBody    = document.getElementById('tuning-body')    as HTMLDivElement;
const tuningReset   = document.getElementById('tuning-reset')   as HTMLButtonElement;
const tuningClose   = document.getElementById('tuning-close')   as HTMLButtonElement;

/** (Re)build the tuning panel rows from TUNABLE_SPECS, reflecting current values. */
function renderTuningPanel(): void {
  tuningBody.innerHTML = '';
  const columns: HTMLDivElement[] = [];
  const columnFor = (i: number): HTMLDivElement => {
    while (columns.length <= i) {
      const col = document.createElement('div');
      col.className = 'tuning-col';
      tuningBody.appendChild(col);
      columns.push(col);
    }
    return columns[i];
  };
  let lastGroup = '';
  for (const spec of TUNABLE_SPECS) {
    const col = columnFor(spec.column ?? 0);
    if (spec.group !== lastGroup) {
      lastGroup = spec.group;
      const h = document.createElement('h4');
      h.textContent = spec.group;
      col.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'tuning-row';

    const label = document.createElement('label');
    label.textContent = spec.label;

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(spec.min);
    range.max = String(spec.max);
    range.step = String(spec.step);
    range.value = String(tunables[spec.key]);

    const num = document.createElement('input');
    num.type = 'number';
    num.min = String(spec.min);
    num.max = String(spec.max);
    num.step = String(spec.step);
    num.value = String(tunables[spec.key]);

    const apply = (v: number) => {
      tunables[spec.key] = v;
      saveTunables();
      wake();
    };
    range.addEventListener('input', () => {
      const v = Number(range.value);
      num.value = String(v);
      apply(v);
    });
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (Number.isNaN(v)) return;
      range.value = String(v);
      apply(v);
    });

    row.append(label, range, num);
    col.appendChild(row);
  }
}

tuningBtn.addEventListener('click', e => {
  e.stopPropagation();
  debugPanel.classList.remove('open');
  renderTuningPanel();
  tuningOverlay.classList.add('visible');
});
// Closing the panel needs its own wake(): apply() already wakes the loop on every
// edit, but if the sim re-settles (animating -> false) while the dialog is still
// open — e.g. the user pauses to look at a value — the underlying geometry never
// gets a chance to react to the new constants until something else wakes it up.
// Without this, closing the panel could silently leave stale geometry on screen
// until the user drags a vertex.
wireOverlay(tuningOverlay, tuningClose, wake);
tuningReset.addEventListener('click', () => {
  resetTunables();
  renderTuningPanel();
  wake();
});

// ---------------------------------------------------------------------------
// Toggle listeners
// ---------------------------------------------------------------------------

// Projection
const projCheckbox = document.getElementById('proj-checkbox') as HTMLInputElement;
projCheckbox.addEventListener('change', () => {
  renderer.projection = projCheckbox.checked ? 'rect' : 'lambert';
  wake();
});

// Shrink dead regions (default on)
const shrinkCheckbox = document.getElementById('shrink-checkbox') as HTMLInputElement;
shrinkCheckbox.addEventListener('change', () => {
  if (shrinkCheckbox.checked) { collapseOffNote.classList.remove('visible'); checkForCollapses(); }
  wake();
});

// Region colors
const rgnCheckbox = document.getElementById('rgn-checkbox') as HTMLInputElement;
let showRegions   = false;
rgnCheckbox.addEventListener('change', () => { showRegions = rgnCheckbox.checked; wake(); });

// Midpoints
const midCheckbox = document.getElementById('mid-checkbox') as HTMLInputElement;
let showMidpoints = false;
midCheckbox.addEventListener('change', () => { showMidpoints = midCheckbox.checked; wake(); });

// Vertex IDs
const labelCheckbox = document.getElementById('label-checkbox') as HTMLInputElement;
let showVertexIds   = false;
labelCheckbox.addEventListener('change', () => { showVertexIds = labelCheckbox.checked; wake(); });

// Splice angle debug: live blue/green/red departure-bearing rays while drawing into/out of a degree-2 vertex
const spliceAngleCheckbox = document.getElementById('splice-angle-checkbox') as HTMLInputElement;
spliceAngleCheckbox.addEventListener('change', () => { input.showSpliceAngles = spliceAngleCheckbox.checked; wake(); });

// Enclosure side coloring: after a split move, ring the two new regions' vertices red/blue
const enclosureSidesCheckbox = document.getElementById('enclosure-sides-checkbox') as HTMLInputElement;
let showEnclosureSides = false;
let lastEnclosureSideColors: Map<VertexId, 'red' | 'blue'> | undefined;
let lastEnclosureCoverage: { pos: SpherePoint; side: 'arc' | 'other' | 'none' }[] | undefined;
enclosureSidesCheckbox.addEventListener('change', () => {
  showEnclosureSides = enclosureSidesCheckbox.checked;
  if (!showEnclosureSides) { lastEnclosureSideColors = undefined; lastEnclosureCoverage = undefined; }
  wake();
});

// Region diagnostic: color-coded boundary edges + per-vertex wedge rings
const regionDiagnosticCheckbox = document.getElementById('region-diagnostic-checkbox') as HTMLInputElement;
let showRegionDiagnostic = false;
regionDiagnosticCheckbox.addEventListener('change', () => {
  showRegionDiagnostic = regionDiagnosticCheckbox.checked;
  wake();
});

// Invisible (pseudo/Dead) vertices shown as lowercase letters in the Position Browser's boundary listing
const invisibleLettersCheckbox = document.getElementById('invisible-letters-checkbox') as HTMLInputElement;
let showInvisibleAsLetters = false;
invisibleLettersCheckbox.addEventListener('change', () => {
  showInvisibleAsLetters = invisibleLettersCheckbox.checked;
  if (!showInvisibleAsLetters) pbInvisibleBoundaryListing.classList.remove('visible');
  wake();
});

// Dense Fibonacci-sphere sample for the "enclosure sides" coverage overlay — fixed,
// generated once, reused across every move (only its classification changes).
const ENCLOSURE_COVERAGE_SAMPLE: SpherePoint[] = fibonacciSphere(900);

// Boundary arrows
const arrowCheckbox    = document.getElementById('arrow-checkbox') as HTMLInputElement;
let showBoundaryArrows = false;
arrowCheckbox.addEventListener('change', () => { showBoundaryArrows = arrowCheckbox.checked; wake(); });

// Region adjacency (dual) graph
const netCheckbox     = document.getElementById('net-checkbox') as HTMLInputElement;
let showRegionNetwork = false;
netCheckbox.addEventListener('change', () => { showRegionNetwork = netCheckbox.checked; wake(); });

// Boundary listing
const pauseRecreateCheckbox = document.getElementById('pause-recreate-checkbox') as HTMLInputElement;
pauseRecreations = pauseRecreateCheckbox.checked; // sync on (re)load — survives HMR
pauseRecreateCheckbox.addEventListener('change', () => { pauseRecreations = pauseRecreateCheckbox.checked; });

const showBrokenCheckbox = document.getElementById('show-broken-checkbox') as HTMLInputElement;
showBroken = showBrokenCheckbox.checked; // sync on (re)load — survives HMR
showBrokenCheckbox.addEventListener('change', () => { showBroken = showBrokenCheckbox.checked; wake(); });

const rawMovePlanCheckbox = document.getElementById('raw-move-plan-checkbox') as HTMLInputElement;
showRawMovePlan = rawMovePlanCheckbox.checked; // sync on (re)load — survives HMR
rawMovePlanCheckbox.addEventListener('change', () => { showRawMovePlan = rawMovePlanCheckbox.checked; wake(); });

const encCheckbox = document.getElementById('enc-checkbox') as HTMLInputElement;
const encPanel    = document.getElementById('encoding-panel') as HTMLDivElement;
let showEncoding  = false;
encCheckbox.addEventListener('change', () => {
  showEncoding = encCheckbox.checked;
  if (!showEncoding) { encPanel.classList.remove('visible'); encPanel.textContent = ''; }
  wake();
});

// Move sequence display mode: labels (default) vs raw vertex IDs — a pure
// display swap over the already-recorded moveSeqLog entries.
const rawIdCheckbox = document.getElementById('raw-id-checkbox') as HTMLInputElement;
rawIdCheckbox.addEventListener('change', () => {
  useRawVertexIds = rawIdCheckbox.checked;
  updateMoveSeq();
  wake();
});

// Move Check ("Sequence verifier"): every move's {encoding}-tagged token is always recorded
// in the background (see afterMoveCommitted / moveSeqLog's moveSeqTagged field); this toggle only controls
// which variant updateMoveSeq() displays. Checked by default, so sync the mode on (re)load too.
const moveCheckCheckbox = document.getElementById('move-check-checkbox') as HTMLInputElement;
moveCheckMode = moveCheckCheckbox.checked;
moveCheckCheckbox.addEventListener('change', () => {
  moveCheckMode = moveCheckCheckbox.checked;
  updateMoveSeq();
  wake();
});

// Tracked Encoding (M2–M4 shadow path): apply each move through the engine and face-check the
// child against geometry. Re-seeds from the current fresh position when switched on.
const trackedCheckCheckbox = document.getElementById('tracked-check-checkbox') as HTMLInputElement;
trackedCheckCheckbox.addEventListener('change', () => {
  trackedCheckEnabled = trackedCheckCheckbox.checked;
  if (trackedCheckEnabled && state.moveCount === 0) tracked.reset([...state.vertices.keys()]);
  updateTrackedPanel(trackedCheckEnabled ? { mismatch: tracked.isDesynced } : null);
});

// On-canvas spot-label overlay (parallel to the raw vertex-ID overlay above).
const spotLabelCheckbox = document.getElementById('spot-label-checkbox') as HTMLInputElement;
spotLabelCheckbox.addEventListener('change', () => {
  showSpotLabels = spotLabelCheckbox.checked;
  wake();
});

// Position encoding (bottom bar)
const posCheckbox = document.getElementById('pos-checkbox') as HTMLInputElement;
posCheckbox.addEventListener('change', () => {
  showPosition = posCheckbox.checked;
  if (!showPosition) { bottomBar.classList.remove('visible'); bottomBarText.textContent = ''; lastCharInfo = []; hoverCharInfo = null; }
  fitCanvas();
  renderer.resize();
  wake();
});

// On-canvas per-point encoding characters — decoupled from the boundary/position encoding
// bar so it can be toggled independently (off by default).
const pointEncCheckbox = document.getElementById('point-enc-checkbox') as HTMLInputElement;
let showPointEncodings = false;
pointEncCheckbox.addEventListener('change', () => {
  showPointEncodings = pointEncCheckbox.checked;
  wake();
});

// ---------------------------------------------------------------------------
// Wide-window layout: Position Browser side panel
// ---------------------------------------------------------------------------
// Above WIDE_BREAKPOINT, the Position Browser lives as a persistent right-hand panel
// instead of a manually-opened modal, and the Math dropdown (now redundant — Guide moved
// into the panel, the rest of its toggles relocated too) is hidden. Rather than forking
// the Position Browser's rendering, the existing #pb-chrome/#pb-body DOM (and a handful of
// Math-menu toggle rows + the move-seq bar) are physically reparented between their modal/
// dropdown homes and the panel — same elements, same listeners, so content can't diverge.

const pbPanel          = document.getElementById(PB_PANEL_ID)               as HTMLDivElement;
const pbPanelExtra     = document.getElementById('pb-panel-extra')          as HTMLDivElement;
const pbPanelToggleRow = document.getElementById('pb-panel-toggle-row')     as HTMLDivElement;
const pbLiveEncoding   = document.getElementById('pb-live-encoding')        as HTMLDivElement;
const pbInvisibleBoundaryListing = document.getElementById('pb-invisible-boundary-listing') as HTMLDivElement;
const pbTrackedPanel   = document.getElementById('pb-tracked-panel')        as HTMLDivElement;
const pbChrome         = document.getElementById('pb-chrome')               as HTMLDivElement;
const pbBody           = document.getElementById(PB_BODY_ID)                as HTMLDivElement;
const pbNotifyArea     = document.getElementById('pb-notify-area')          as HTMLDivElement;
const pbOverlay        = document.getElementById('position-browser-overlay') as HTMLDivElement;

// Vertex IDs / Point labels / Use vertex ID live permanently in the Debug menu now (never
// hidden, so they don't need to move between layouts). Only these two toggle rows relocate
// between the modal's #pb-modal-toggle-row (narrow) and the side panel's #pb-panel-toggle-row (wide).
const arrowRow      = arrowCheckbox.closest('.toggle-row')     as HTMLLabelElement;
const pointEncRow   = pointEncCheckbox.closest('.toggle-row')  as HTMLLabelElement;

// ensureWired() permanently detaches #pb-toggles from #pb-chrome's next sibling (moved into
// #pb-body at render time) the first time it runs — must happen before capturing pbChrome's
// "home" below, or a stale reference to the detached node breaks the wide→narrow restore.
ensureBrowserWired();

/** Snapshot an element's current position so it can be moved away and later restored exactly. */
function captureHome(el: Element): { parent: Element; next: Element | null } {
  return { parent: el.parentElement!, next: el.nextElementSibling };
}
function restoreHome(el: Element, home: { parent: Element; next: Element | null }): void {
  // The anchor may itself be another reparented element that hasn't been restored yet (if
  // restore order is wrong) — fall back to appending rather than throwing, so one mis-ordered
  // call can't abort the rest of the restore (and leave e.g. topBar sizing/canvas stale).
  const next = home.next && home.next.parentElement === home.parent ? home.next : null;
  home.parent.insertBefore(el, next);
}

const pbChromeHome     = captureHome(pbChrome);
const pbBodyHome       = captureHome(pbBody);
const pbNotifyAreaHome = captureHome(pbNotifyArea);
const arrowRowHome     = captureHome(arrowRow);
const pointEncRowHome  = captureHome(pointEncRow);

onNavigated(() => wake());

// Position Browser Sync mode: the panel's back/forward arrows drive the live game's undo/redo (the
// game history lives here, not in the browser). canBack/canForward gate the arrows; Recreate
// playback blocks both.
wireCharHover(pbLiveEncoding, () => lastLiveCharInfo);
setSyncCallbacks({
  onBack: () => undoLast(true),
  onForward: () => redoLast(),
  canBack: () => history.length > 0 && !recreateActive,
  canForward: () => redoStack.length > 0 && !recreateActive,
});
// When Sync is switched on, snap the panel to the current live position; either way, wake the loop
// so the arrows' enabled state and the panel content refresh immediately.
onSyncModeChange(() => {
  if (isSyncMode()) {
    lastNotifiedLiveEnc = liveAnalysisText(state);
    void notifyLivePosition(lastNotifiedLiveEnc);
  }
  updateMoveSeq();
  wake();
});

// M5: the tracked (shadow-check) believed-encoding panel. Its per-character binding comes straight
// from the occurrence map's vertexOf (Catch F) — no face match needed — so hovering a digit of the
// believed encoding highlights the live vertex the engine thinks that token belongs to. On a
// mismatch this contrasts the engine's belief against the diverged board.
let trackedCharInfo: { vertexIds: number[] }[] = [];
wireCharHover(pbTrackedPanel, () => trackedCharInfo);

/**
 * Refresh the tracked believed-encoding panel from the latest shadow-check outcome. Shown only in
 * the wide side panel while the Tracked Encoding toggle is on; `mismatch` paints it maroon and
 * appends the engine-vs-geometry face-key diagnostic. `null` clears it.
 */
function updateTrackedPanel(
  outcome:
    | {
        mismatch: boolean;
        engineKey?: string;
        geometryKey?: string;
        /** Believed-child overrides (mismatch): the panel shows these instead of the live map, so
         *  its encoding, hover binding, and face-keys all describe the same believed position. */
        enc?: string;
        charInfo?: { vertexIds: number[] }[];
      }
    | null,
): void {
  const encStr = outcome?.enc ?? tracked.encoding;
  if (!isWide || !trackedCheckEnabled || outcome === null || encStr === null) {
    pbTrackedPanel.classList.remove('visible', 'mismatch');
    pbTrackedPanel.innerHTML = '';
    trackedCharInfo = [];
    return;
  }
  trackedCharInfo = outcome.charInfo ?? tracked.charInfo();
  pbTrackedPanel.innerHTML = '';
  pbTrackedPanel.classList.add('visible');
  pbTrackedPanel.classList.toggle('mismatch', outcome.mismatch);

  const label = document.createElement('div');
  label.className = 'pb-tracked-label';
  label.textContent = outcome.mismatch ? 'Tracked encoding — MISMATCH' : 'Tracked encoding';
  pbTrackedPanel.appendChild(label);

  const enc = document.createElement('div');
  enc.className = 'pb-tracked-enc';
  renderCharSpans(enc, encStr);
  pbTrackedPanel.appendChild(enc);

  if (outcome.mismatch) {
    const keys = document.createElement('div');
    keys.className = 'pb-tracked-keys';
    keys.innerHTML =
      `<span class="k">engine faces:</span> ${escapeHtml(outcome.engineKey ?? '')}<br>` +
      `<span class="k">geometry faces:</span> ${escapeHtml(outcome.geometryKey ?? '')}`;
    pbTrackedPanel.appendChild(keys);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function syncLayoutMode(): void {
  const wide = window.innerWidth >= WIDE_BREAKPOINT;
  if (wide !== isWide) {
    isWide = wide;
    if (wide) {
      pbPanel.classList.add('wide');
      pbOverlay.classList.remove('visible'); // the modal is redundant once the panel is live
      pbChrome.classList.add('in-panel');
      pbPanel.appendChild(pbChrome);
      pbPanel.appendChild(pbLiveEncoding);
      pbPanel.appendChild(pbTrackedPanel);
      pbPanel.appendChild(pbBody);
      pbPanel.appendChild(pbNotifyArea);
      pbPanel.appendChild(pbPanelExtra);
      pbPanelToggleRow.appendChild(arrowRow);
      pbPanelToggleRow.appendChild(pointEncRow);
      bottomBar.classList.remove('visible');
      bottomBarText.textContent = '';
      ensureBrowserWired();
      lastNotifiedLiveEnc = liveAnalysisText(state);
      void notifyLivePosition(lastNotifiedLiveEnc);
      // Re-populate the tracked panel now that it has a home again.
      updateTrackedPanel(trackedCheckEnabled ? { mismatch: tracked.isDesynced } : null);
    } else {
      pbPanel.classList.remove('wide');
      pbChrome.classList.remove('in-panel');
      // pbBody must go back before pbChrome — pbChrome's "home" is anchored on pbBody as its
      // next sibling, which only works once pbBody is actually back in the dialog.
      // pbNotifyArea's captured "next" is null (it was the modal's last child), so it can restore
      // unconditionally; pbBody's captured "next" is pbNotifyArea, so pbBody must go back after it.
      restoreHome(pbNotifyArea, pbNotifyAreaHome);
      restoreHome(pbBody, pbBodyHome);
      restoreHome(pbChrome, pbChromeHome);
      // Likewise, each toggle row's captured "next" may be a sibling row that's also being
      // restored — arrowRow is anchored on pointEncRow (its next sibling in the Math panel),
      // so pointEncRow must go back first.
      restoreHome(pointEncRow, pointEncRowHome);
      restoreHome(arrowRow, arrowRowHome);
      pbLiveEncoding.textContent = '';
      updateTrackedPanel(null); // no side panel to host it below the breakpoint
    }
    updatePlayGateWarningText();
  }
  // The top bar spans only the play area, leaving room for the panel on the right (which
  // reaches all the way to the top, taking over that visual strip with its own chrome).
  topBar.style.right = isWide ? `${PANEL_WIDTH}px` : '';
  // The play gate covers the same play-area strip as the canvas, not the whole viewport —
  // otherwise it visibly recenters off the game field once the side panel claims the right edge.
  playGate.style.right = isWide ? `${PANEL_WIDTH}px` : '';
  collapseOffNote.style.right = `${(isWide ? PANEL_WIDTH : 0) + 8}px`; // the playfield's upper right
  // The Browser button is only needed as a way to open the Position Browser when the window
  // is too small for the always-visible side panel.
  browserBtn.style.display = isWide ? 'none' : '';
  fitCanvas();
  renderer.resize();
  wake();
}

window.addEventListener('resize', syncLayoutMode);
// Initial call deferred to the end of the file (see bottom) — wake() touches `animating` /
// `needsInitialRender`, which are declared later and would be in their temporal dead zone here.

// ---------------------------------------------------------------------------
// New Game button + confirmation dialog
// ---------------------------------------------------------------------------

const newGameBtn     = document.getElementById('new-game-btn')    as HTMLButtonElement;
const confirmOverlay = document.getElementById('confirm-overlay') as HTMLDivElement;
const confirmYes     = document.getElementById('confirm-yes')     as HTMLButtonElement;
const confirmNo      = document.getElementById('confirm-no')      as HTMLButtonElement;
const spotCountInput = document.getElementById('spot-count')      as HTMLInputElement;

newGameBtn.addEventListener('click', () => { confirmOverlay.classList.add('visible'); });
wireOverlay(confirmOverlay, confirmNo);
/** Reset to a fresh n-spot game and re-sync all UI from current toggle state. */
function resetGame(spots: number): void {
  currentSpotCount = spots;
  Object.assign(state, createInitialState(spots));
  history.length = 0;
  moveSeqLog.length = 0;
  moveLog.length = 0; // the debug region-trace log (src/debug/moveLog.ts) starts over with the game
  liveUnlockTokens.length = 0;
  redoStack.length = 0;
  pendingCollapse = null;
  generalCollapseFocus = null;
  collapseSnapshot = null;
  subregionHighlight = null;
  proposedArc = null;
  recreateCheckFailed = false;
  lastCommittedEncoding = null;
  pendingTrackedCheck = null;
  tracked.reset([...state.vertices.keys()]);
  updateTrackedPanel(null);
  updateUndoButton();
  updateMoveSeq();
  renderer.resetRegionColors();
  camera = identityRotation();
  recenterAxis = null;
  recenterAngleLeft = 0;
  input.pointerCancel();

  // Re-sync all toggle-driven state from checkbox positions
  renderer.projection  = projCheckbox.checked ? 'rect' : 'lambert';
  showRegions          = rgnCheckbox.checked;
  showMidpoints        = midCheckbox.checked;
  showVertexIds        = labelCheckbox.checked;
  showBoundaryArrows   = arrowCheckbox.checked;
  showRegionNetwork    = netCheckbox.checked;
  showEncoding         = encCheckbox.checked;
  showPosition         = posCheckbox.checked;
  useRawVertexIds      = rawIdCheckbox.checked;
  showSpotLabels       = spotLabelCheckbox.checked;
  showPointEncodings   = pointEncCheckbox.checked;
  if (!showEncoding) { encPanel.classList.remove('visible'); encPanel.textContent = ''; }
  if (!showPosition && !isWide) { bottomBar.classList.remove('visible'); bottomBarText.textContent = ''; lastCharInfo = []; hoverCharInfo = null; }
  fitCanvas();
  renderer.resize();

  gameStarted = true;
  updateSaveButton();
  updateTurnIndicator();
  wake();
}

confirmYes.addEventListener('click', () => {
  confirmOverlay.classList.remove('visible');
  abortRecreate();
  const spots = Math.max(1, Math.min(20, parseInt(spotCountInput.value, 10) || INITIAL_SPOTS));
  resetGame(spots);
  hidePlayGate();
});

// ---------------------------------------------------------------------------
// Play gate: the game field starts greyed-out behind a "Play" button and an
// experimental-game warning, until the player hits Play or starts/loads a game.
// ---------------------------------------------------------------------------

const playGate        = document.getElementById('play-gate')         as HTMLDivElement;
const playGateWarning = document.getElementById('play-gate-warning') as HTMLDivElement;
const playGateBtn     = document.getElementById('play-gate-btn')     as HTMLButtonElement;

// Wide layout has the browser as a permanent right-hand panel; narrow doesn't, so it's reached
// via the "Browser" button on the top bar instead. Re-run whenever the layout mode changes.
function updatePlayGateWarningText(): void {
  playGateWarning.textContent = isWide
    ? 'The playable game is currently experimental, and is prone to errors. If you are here for ' +
      'mathematical rigor, just use the position browser to the right. If you\'re ok with potential ' +
      'bugs, hit "Play" below.'
    : 'The playable game is currently experimental, and is prone to errors. If you are here for ' +
      'mathematical rigor, you may use the position browser with the "Browser" button on the top ' +
      'bar. If you\'re ok with potential bugs, hit "Play" below.';
}
updatePlayGateWarningText();

function showPlayGate(): void {
  playGate.classList.add('visible');
  // Sync locks the address bar to the live game — keep it off-and-unreachable until the player
  // has actually started playing, so a beginner can't lock themselves out of free-browsing.
  setSyncMode(false);
  setSyncToggleEnabled(false);
  // Mirror hidePlayGate's gameStarted flip so a stale "true" from a prior session/bfcache restore
  // can't leave Save enabled behind the warning screen.
  gameStarted = false;
  updateSaveButton();
}

function hidePlayGate(): void {
  playGate.classList.remove('visible');
  setSyncToggleEnabled(true);
  // The player has started playing — lock the browser panel onto the live game and jump it
  // there right away (rather than leaving it wherever it was last free-browsing).
  setSyncMode(true);
}

playGateBtn.addEventListener('click', () => {
  // Plain "Play" (no New Game/Load) starts the already-initialized default board, so it must
  // flip gameStarted itself — resetGame/loadGameState do this for their own paths.
  gameStarted = true;
  updateSaveButton();
  hidePlayGate();
});

// ---------------------------------------------------------------------------
// Recreate Game (replay a Move Sequence string)
// ---------------------------------------------------------------------------

const recreateBtn     = document.getElementById('recreate-btn')     as HTMLButtonElement;
const recreateOverlay = document.getElementById('recreate-overlay') as HTMLDivElement;
const recreateInput   = document.getElementById('recreate-input')   as HTMLTextAreaElement;
const recreateError   = document.getElementById('recreate-error')   as HTMLParagraphElement;
const recreateGo      = document.getElementById('recreate-go')      as HTMLButtonElement;
const recreateCancel  = document.getElementById('recreate-cancel')  as HTMLButtonElement;
const recreateBanner  = document.getElementById('recreate-banner')  as HTMLDivElement;
const recreatePauseEl = document.getElementById('recreate-pause')   as HTMLDivElement;

recreateBtn.addEventListener('click', () => {
  abortRecreate();
  recreateError.textContent = '';
  recreateOverlay.classList.add('visible');
  recreateInput.focus();
});
wireOverlay(recreateOverlay, recreateCancel);
recreateGo.addEventListener('click', () => {
  let parsed;
  try {
    parsed = parseMoveSequence(recreateInput.value);
  } catch (err) {
    recreateError.textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  recreateOverlay.classList.remove('visible');
  void runRecreate(parsed);
});

function showBanner(text: string): void {
  recreateBanner.textContent = text;
  recreateBanner.classList.add('visible');
}
function hideBanner(): void {
  recreateBanner.classList.remove('visible');
}

/** Leave a hand-drawn-move pause: drop its hints, Voronoi overlay + path bar and proposed arc, and
 * the banner. (Resolving the pause's promise is the caller's business.) */
function clearManualPause(): void {
  manualAwait = null;
  manualHints = null;
  subregionHighlight = null;
  proposedArc = null;
  voronoiPathBar.classList.remove('visible');
  hideBanner();
}

/** Stop a running Recreate (or a paused move resumed from a save): any pending manual pause or
 * candidate preview resolves as cancelled, and every Recreate overlay is cleared. */
function abortRecreate(): void {
  if (!recreateActive) return;
  manualAwait?.resolve(false);
  if (candidateResolve) { candidateResolve(false); candidateResolve = null; candidatePreviewList = null; }
  recreateActive = false;
  clearManualPause();
  setPaused(false);
}

function setPaused(paused: boolean): void {
  recreatePaused = paused;
  recreatePauseEl.classList.toggle('visible', paused);
  wake();
}

/** Resolves once recreatePaused is false; keeps the render loop alive while waiting. */
function waitForUnpause(): Promise<void> {
  if (!recreatePaused) return Promise.resolve();
  return new Promise(resolve => {
    const check = () => {
      if (!recreatePaused) { resolve(); return; }
      wake(); // keep render loop ticking so debug overlays stay visible
      setTimeout(check, 100);
    };
    setTimeout(check, 100);
  });
}

/** Resolve after `ms`, keeping the render loop awake so animations advance. */
function settle(ms: number): Promise<void> {
  wake();
  return new Promise(res => setTimeout(res, ms));
}

// tunables.extraSettleStableFrames/extraSettleTimeoutMs/recreateSettleThreshold
// govern this. smoothStep's own tunables.settleEpsilon (1e-4 rad default) is tuned
// for the render loop's "can I stop repainting" question, which chases geometry all
// the way down to imperceptible asymptotic jitter. That tail can drag on for seconds
// after the position is already perfectly fine to move on, so recreateSettleThreshold
// is deliberately much looser: "basically stopped nudging things around," not
// "byte-for-byte settled."

/**
 * Resolves once the sim has gone quiet: `tunables.extraSettleStableFrames` frames
 * in a row where smoothing moved everything by less than
 * `tunables.recreateSettleThreshold`. Complex moves (mostly enclosures) can keep
 * nudging geometry well past the fixed settle dwell, and starting the next move on
 * top of an unsettled position causes crossing checks and candidate matching to
 * misbehave — but the last leg of that nudging is imperceptible micro-jitter
 * that's already safe to build on, so we don't wait for smoothStep's much
 * stricter render-loop-sleep threshold. Falls back to a timeout so a position
 * that never perfectly quiets doesn't stall playback.
 */
function waitForFullSettle(): Promise<void> {
  return new Promise(resolve => {
    let stableFrames = 0;
    const deadline = performance.now() + tunables.extraSettleTimeoutMs;
    const check = () => {
      wake(); // keep the render loop ticking so smoothStep keeps advancing
      stableFrames = lastMaxMovement > tunables.recreateSettleThreshold ? 0 : stableFrames + 1;
      if (stableFrames >= tunables.extraSettleStableFrames || performance.now() > deadline) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/** Resolve once all collapse animations have finished (see collapseActive). */
function waitForCollapseDone(): Promise<void> {
  if (!collapseActive()) return Promise.resolve();
  return new Promise(resolve => {
    const check = () => {
      if (!collapseActive()) { resolve(); return; }
      wake();
      setTimeout(check, 50);
    };
    setTimeout(check, 50);
  });
}

/**
 * Synchronous setup for a hand-drawn-move pause: builds hint markers, the
 * Voronoi cell diagram for enclosure moves, and shows the banner. Shared by
 * promptManual (mid-replay pause) and resumePausedMove (re-entering a pause
 * after Load restores a saved position).
 *
 * `forceVoronoi` bypasses the pauseRecreations gate below — used when
 * resuming a saved pause, where there's no ongoing auto-play pacing to
 * respect and the entire point of resuming is to see the diagram.
 */
function setupManualPause(
  parsed: ResolvedMove,
  moveNum: number,
  before: GameState,
  resolve: (ok: boolean) => void,
  forceVoronoi = false,
): void {
  manualAwait = { parsed, before, resolve };
  manualHints = computeRecreateHints(state, parsed);
  const showVoronoi = forceVoronoi || pauseRecreations;
  // Voronoi cell coloring for enclosure moves — pause mode only; in
  // no-pause mode it just occludes the red/blue recreate-hint markers.
  subregionHighlight = (showVoronoi && parsed.brackets && parsed.brackets.length > 0)
    ? buildSubregionHighlight(state, parsed.lo, parsed.hi, parsed.brackets ?? [])
    : null;
  if (subregionHighlight && showVoronoi) {
    const vData = buildVoronoiGraph(state, subregionHighlight, parsed.lo, parsed.hi);
    const { graph: vGraph, circumcenters, extraSeeds, fullNodes, survivingNodeIds } = vData;
    lastVoronoiGraph = vGraph;
    lastVoronoiCCs = circumcenters;
    lastVoronoiExtraSeeds = extraSeeds.length > 0 ? extraSeeds : null;
    lastVoronoiFullNodes = fullNodes;
    lastVoronoiSurvivingIds = survivingNodeIds;
    if (DEBUG.recreate) console.log('[VoronoiGraph]', JSON.stringify(vGraph, null, 2));
    const v1Pos = state.vertices.get(parsed.lo)?.pos;
    const v2Pos = state.vertices.get(parsed.hi)?.pos;
    const voronoiResult = computeJunctionVoronoiPath(vData, v1Pos, v2Pos);
    lastVoronoiFakeCgrId = voronoiResult?.fakeCgrNodeId ?? null;
    proposedArc = voronoiResult ? voronoiResult.pts : (candidateStrokeStream(state, parsed).next().value ?? null);
    if (voronoiResult) {
      const { nodeIds, seg2Start, seg3Start } = voronoiResult;
      const parts = nodeIds.map((id, i) => {
        const label = i === seg2Start ? '[P2] ' : i === seg3Start ? '[P3] ' : '';
        return label + id;
      });
      voronoiPathText.textContent = `Voronoi path: ${parts.join(' → ')}`;
    } else {
      voronoiPathText.textContent = 'Voronoi path: (no path found)';
    }
    voronoiPathBar.classList.add('visible');
  } else {
    voronoiPathBar.classList.remove('visible');
    // Blue hint arc: first Voronoi-guided candidate (may not verify, still useful visually).
    proposedArc = pauseRecreations ? (candidateStrokeStream(state, parsed).next().value ?? null) : null;
  }
  wake();
  showBanner(`Move ${moveNum}: connect the circled vertices`);
}

/** Pause playback for a hand-drawn move; resolves true on a matching move. */
function promptManual(parsed: ResolvedMove, moveNum: number): Promise<boolean> {
  return new Promise(resolve => {
    setupManualPause(parsed, moveNum, cloneState(state), resolve);
  });
}

/** Re-enter a hand-drawn-move pause after Load restores a saved paused position. */
function resumePausedMove(parsed: ResolvedMove): void {
  recreateActive = true;
  setupManualPause(parsed, moveSeqLog.length + 1, cloneState(state), () => {
    recreateActive = false;
    clearManualPause();
    setPaused(false);
    updateUndoButton();
    wake();
  }, true);
}

/**
 * Draw all candidate arcs for `parsed` (legal=orange, illegal=red) and wait
 * for the user to press Enter. Returns the first legal stroke, or null if none.
 */
function promptCandidates(parsed: ResolvedMove, moveNum: number): Promise<SpherePoint[] | null> {
  // The one test every candidate faces: legal (crosses nothing) and reproduces the token.
  const reproduces = (stroke: SpherePoint[]): boolean => strokeReproduces(state, parsed, stroke, recreateUseLabels);

  // When not pausing, auto-commit the first candidate that reproduces, with no display. Walk the
  // LAZY stream: most moves verify on the plain geodesic / small loop at its front, and stopping
  // there means the router's face meshes and the Voronoi fallbacks (last in the stream) are never
  // built for them. A crossing stroke is never committed — with nothing legal, the move goes to
  // manual drawing.
  if (!pauseRecreations) {
    for (const stroke of candidateStrokeStream(state, parsed)) {
      if (reproduces(stroke)) return Promise.resolve(stroke);
    }
    if (DEBUG.recreate) {
      const all = candidateStrokes(state, parsed);
      const crossing = all.filter(s => strokeCrossesEdges(state, s)).length;
      console.log(`[Move ${moveNum}] token="${parsed.token}" lo=${parsed.lo} hi=${parsed.hi} brackets=${JSON.stringify(parsed.brackets)}: ${all.length} candidates (${crossing} cross an edge), none reproduces → manual draw`);
    }
    return Promise.resolve(null);
  }

  // Pause mode: show all candidates and wait for Enter.
  const all = candidateStrokes(state, parsed);
  if (all.length === 0) return Promise.resolve(null);
  let firstLegal: SpherePoint[] | null = null;
  let legalCount = 0;
  const evaluated = all.map(stroke => {
    const legal = reproduces(stroke);
    if (legal && !firstLegal) firstLegal = stroke;
    if (legal) legalCount++;
    return { stroke, legal };
  });
  candidatePreviewList = evaluated;
  wake();
  const total = all.length;
  const suffix = firstLegal ? 'Enter to commit' : 'Enter to draw manually';
  showBanner(`Move ${moveNum}: ${legalCount} legal (orange) / ${total - legalCount} illegal (red) — ${suffix}`);

  const chosen = firstLegal;
  return new Promise(resolve => {
    candidateResolve = (go: boolean) => {
      candidatePreviewList = null;
      resolve(go ? chosen : null);
    };
  });
}

/** Called from onMoveCommitted while paused: accept a correct hand-drawn move. */
function verifyManualMove(v1: number, v2: number): void {
  if (!manualAwait) return;
  const ok = appliedMoveMatches(manualAwait.before, state, v1, v2, manualAwait.parsed.token, recreateUseLabels);
  if (ok) {
    const resolve = manualAwait.resolve;
    clearManualPause();
    resolve(true);
  } else {
    // Wrong move: roll it back and ask again.
    undoLast();
    const loop = manualAwait.parsed.lo === manualAwait.parsed.hi ? ' (self-loop)' : '';
    showBanner(`That move didn't match. Draw ${manualAwait.parsed.lo} → ${manualAwait.parsed.hi}${loop} again`);
  }
}

/** Do two position strings (encodePosition text, as Move Check tags record it) name the same
 * position? Compared by WASM canon: the TS encoder's text isn't canonical (layOutSubposition), so
 * a different drawing of the same position can spell it differently. Falls back to the strings. */
function sameEncodedPosition(a: string | null, b: string): boolean {
  if (a === b) return true;
  if (a === null) return false;
  const ca = canonSync(a || 'N'), cb = canonSync(b || 'N');
  return ca !== null && ca === cb;
}

/** Drive the whole sequence move by move. */
async function runRecreate(seq: ReturnType<typeof parseMoveSequence>): Promise<void> {
  resetGame(seq.spots);
  recreateActive = true;
  recreateUseLabels = seq.useLabels;
  try {
    for (let i = 0; i < seq.moves.length; i++) {
      const rawMove = seq.moves[i];
      // Labelled sequences carry spot LABELS in lo/hi/subscripts/brackets/parens;
      // resolve to raw vertex IDs against the live label state (in lockstep with
      // the recording) before anything downstream touches state.vertices by ID.
      let parsed: ResolvedMove;
      if (recreateUseLabels) {
        parsed = resolveLabelledMove(rawMove, state.spotLabels);
      } else {
        parsed = {
          ...rawMove,
          brackets: rawMove.brackets as number[] | null,
          parens: rawMove.parens as VertexId | 'empty' | null,
        };
      }
      // Ensure any collapse chain from the previous move finishes before we
      // freeze the frame loop with the candidate preview.
      await waitForCollapseDone();
      if (!recreateActive) return;
      // Let the user pick from verified candidates before committing.
      let stroke = await promptCandidates(parsed, i + 1);
      if (!recreateActive) return; // aborted during candidate selection
      // Nothing reproduces: the board may just be under-smoothed (playback waits are wall-clock,
      // so a slow frame rate settles less, and friction can freeze it mid-relax). Re-arm the
      // forces, let it relax, and try again before falling back to manual drawing. Auto mode
      // only — in pause mode the user already chose to go manual.
      for (let retry = 0; !stroke && !pauseRecreations && retry < tunables.recreateRetries; retry++) {
        resetActivityTimer(tunables.recreateRetrySettleMs);
        await settle(tunables.recreateRetrySettleMs);
        if (!recreateActive) return;
        stroke = await promptCandidates(parsed, i + 1);
        if (!recreateActive) return;
        if (DEBUG.recreate) console.log(`[Move ${i + 1}] retry ${retry + 1} after re-settling: ${stroke ? 'found a candidate' : 'still none'}`);
      }
      if (stroke) {
        pushHistorySnapshot();
        applyMove(state, { v1: parsed.lo, v2: parsed.hi, stroke });
        // Double-check: neither half of the committed move (the last two edges made) crosses an edge.
        for (const eid of [state.nextEdgeId - 2, state.nextEdgeId - 1]) {
          const e = state.edges.get(eid);
          if (e && strokeCrossesEdges(state, e.points, eid)) console.warn(`Recreate move ${i + 1}: committed edge ${eid} crosses existing geometry`);
        }
        afterMoveCommitted(parsed.lo, parsed.hi, stroke);
        await settle(tunables.settleMs);
        await waitForFullSettle();
        await waitForUnpause();
      } else {
        const accepted = await promptManual(parsed, i + 1);
        if (!accepted) return; // cancelled
        await settle(tunables.settleMs);
        await waitForFullSettle();
        await waitForUnpause();
      }
      // Move Check ("C"-tagged sequences): verify the committed move actually landed on
      // the recorded position. lastCommittedEncoding was set inside afterMoveCommitted,
      // reached via either branch above, so it always reflects this move's outcome.
      if (seq.useCheck && rawMove.checkEncoding !== null && !sameEncodedPosition(lastCommittedEncoding, rawMove.checkEncoding)) {
        console.error(`[Move Check] Move ${i + 1} mismatch: expected ${rawMove.checkEncoding}, got ${lastCommittedEncoding}`);
        recreateCheckFailed = true;
        return;
      }
    }
  } finally {
    recreateActive = false;
    clearManualPause();
    candidatePreviewList = null;
    candidateResolve = null;
    setPaused(false);
    updateUndoButton();
    wake();
  }
}

// ---------------------------------------------------------------------------
// Boundary listing
// ---------------------------------------------------------------------------

/**
 * The WASM engine's serialize() (canon.cpp / encoding.cpp) emits components '+'-joined with no
 * brackets (see project_position_browser memory, "Stalks bracket cleanup") — display brackets and
 * the ⊕ separator are re-added by the app, not the engine. positionBrowser.ts's display() does this
 * for plain text; this variant does the same split/wrap/join but also carries a parallel per-char
 * charInfo array through so hover-highlight indices still line up with the bracketed output
 * (bracket/⊕/space chars get an empty vertexIds entry).
 */
function wrapCanonDisplay(text: string, charInfo: EncodingResult['charInfo']): { text: string; charInfo: EncodingResult['charInfo'] } {
  const comps = text.split('+');
  let ci = 0;
  const outChars: string[] = [];
  const outInfo: EncodingResult['charInfo'] = [];
  const pushPunct = (ch: string) => { outChars.push(ch); outInfo.push({ vertexIds: [] }); };
  comps.forEach((c, i) => {
    if (i > 0) { ci++; ' ⊕ '.split('').forEach(pushPunct); } // charInfo has an entry for the '+' too
    if (c === 'N') {
      outChars.push('N');
      outInfo.push(charInfo[ci++] ?? { vertexIds: [] });
    } else {
      pushPunct('[');
      for (const ch of c) {
        outChars.push(ch);
        outInfo.push(charInfo[ci++] ?? { vertexIds: [] });
      }
      pushPunct(']');
    }
  });
  return { text: outChars.join(''), charInfo: outInfo };
}

/**
 * Compute the display text + per-character hover provenance for a live-position canon-encoding
 * view (the bottom bar's #bottom-bar-text and the wide Position Browser's #pb-live-encoding both
 * want this). Prefers the WASM engine's true COMPACT canonical form (canonSync -> canon.cpp's
 * canonicalize(), with Hollow/Split/Triplet pseudo-point compression applied) so e.g. a hollow
 * point "AB" collapses to a single numbered token instead of showing as two membrane letters. We
 * separately compute the *decompressed* canonical form with per-character vertex provenance
 * (canonicalizeTrackedProvenanceSync) so mouseover can highlight the corresponding board point —
 * that provenance lines up with `compact` as-is only when compact happens to equal the
 * decompressed form (no compression fired this frame). When compression collapses/reorders
 * characters there's no clean 1:1 mapping from the *decompressed* provenance any more, but
 * encodePosition() (`enc`) already computes its own compressed form with full per-character
 * provenance -- built for the on-canvas point-encoding hover -- from the live boundary-walk
 * order rather than the true symmetry-minimal one. When that live-order compressed text happens
 * to match `compact` once bracket-wrapped, its provenance is exactly as good, so hover doesn't
 * need to be dropped for the *entire* render just because compression fired somewhere in it.
 * Only when neither lines up (both a differing canonical relabeling AND a compression choice
 * `enc`'s own local pass didn't make) do we fall back further, to the always-fully-provenanced
 * decompressed form -- still correct, just without the compressed notation. Falls back to the
 * raw (non-canonical, but always-available) encodePosition() text when the module isn't loaded
 * yet (see canonSync's "load timing isn't guaranteed" note) or canonicalization fails entirely.
 */
function computeLiveEncodingDisplay(state: GameState, enc: EncodingResult): { text: string; charInfo: EncodingResult['charInfo'] } {
  // The engine's decompressed canonical spelling, every character traced to its live vertex.
  const layout = trackedLayout(state);
  const decompLiveText = layout ? layout.enc : enc.text;
  const decompLiveCharInfo: EncodingResult['charInfo'] = layout ? layout.charInfo : enc.charInfo;
  const compact = canonSync(enc.text);
  if (compact === null) {
    return layout ? wrapCanonDisplay(decompLiveText, decompLiveCharInfo) : { text: decompLiveText, charInfo: decompLiveCharInfo };
  }
  if (compact === decompLiveText) {
    return wrapCanonDisplay(compact, decompLiveCharInfo);
  }
  // enc.text/enc.charInfo are already bracket-wrapped (encodePosition() always wraps), so compare
  // against a wrapped `compact` rather than trying to align the two at the raw-token level.
  const wrappedCompactText = wrapCanonDisplay(compact, compact.split('').map(() => ({ vertexIds: [] }))).text;
  if (wrappedCompactText === enc.text) {
    return { text: enc.text, charInfo: enc.charInfo };
  }
  return wrapCanonDisplay(decompLiveText, decompLiveCharInfo);
}

function boundaryListing(state: { regions: Map<number, { id: number; isDead: boolean; isOuter: boolean; boundaries: { entries: { vertexId: number; side: string }[] }[] }> }): string {
  const lines: string[] = [];
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    const tag = `R${r.id}${r.isOuter ? '*' : ''}`;
    r.boundaries.forEach((b, i) => {
      const walk = b.entries
        .map(e => e.side === 'firstVisit' ? `${e.vertexId}a`
                 : e.side === 'secondVisit' ? `${e.vertexId}b`
                 : `${e.vertexId}`)
        .join(' ');
      lines.push(`${i === 0 ? tag : ' '.repeat(tag.length)}  ${walk}`);
    });
  }
  return lines.join('\n');
}

/**
 * Debug: an EXPANDED position encoding — same [region|region] / boundary-
 * comma / subposition-⊕ structure as the real encoding, but with every
 * compression pass skipped and every otherwise-invisible vertex still given
 * a token instead of being omitted:
 *   - Spot/Appendage/Scab/Joint print their normal digit (0/1/2/7-8).
 *   - Membrane vertices get a real letter, but from the BACK of the alphabet
 *     (Z, Y, X, …) so they can't be confused with invisible tokens.
 *   - Every INVISIBLE vertex — isPseudo (synthetic parallel-edge midpoint) or
 *     classifyVertexFull === Dead (a real vertex the real encoder omits
 *     entirely, e.g. a HollowPoint's hidden interior) — gets a lowercase
 *     letter from the FRONT of the alphabet (a, b, c, …) instead of being
 *     dropped. Same vertex always gets the same letter everywhere it recurs.
 * This is purely diagnostic — it does not feed into canon()/Stalks or the
 * real move-notation pipeline, only this debug display.
 */
function buildExpandedEncoding(state: GameState): { text: string; vertexLabels: Map<VertexId, string> } {
  const invisibleLetterFor = new Map<VertexId, string>();
  const membraneLetterFor = new Map<VertexId, string>();
  const vertexLabels = new Map<VertexId, string>();
  const nextInvisible = (): string => String.fromCharCode(97 + (invisibleLetterFor.size % 26));
  const nextMembrane = (): string => String.fromCharCode(90 - (membraneLetterFor.size % 26));

  const tokenFor = (vid: VertexId, side: 'only' | 'firstVisit' | 'secondVisit'): string => {
    const v = state.vertices.get(vid);
    if (!v) return '?';
    if (v.isPseudo) {
      let l = invisibleLetterFor.get(vid);
      if (l === undefined) { l = nextInvisible(); invisibleLetterFor.set(vid, l); vertexLabels.set(vid, l); }
      return l;
    }
    const type = classifyVertexFull(vid, state);
    switch (type) {
      case VertexType.Spot:      vertexLabels.set(vid, '0'); return '0';
      case VertexType.Appendage: vertexLabels.set(vid, '1'); return '1';
      case VertexType.Scab:      vertexLabels.set(vid, '2'); return '2';
      case VertexType.Joint: {
        const tok = side === 'secondVisit' ? '8' : '7';
        if (!vertexLabels.has(vid)) vertexLabels.set(vid, tok);
        return tok;
      }
      case VertexType.Membrane: {
        let l = membraneLetterFor.get(vid);
        if (l === undefined) { l = nextMembrane(); membraneLetterFor.set(vid, l); vertexLabels.set(vid, l); }
        return l;
      }
      case VertexType.Dead: {
        let l = invisibleLetterFor.get(vid);
        if (l === undefined) { l = nextInvisible(); invisibleLetterFor.set(vid, l); vertexLabels.set(vid, l); }
        return l;
      }
    }
  };

  const parts = state.subpositions.map(sub => {
    const regionStrs = sub.regionIds.map(rid => {
      const r = state.regions.get(rid);
      if (!r || r.isDead) return '';
      return r.boundaries
        .map(b => b.entries.map(e => tokenFor(e.vertexId, e.side)).join(''))
        .join(',');
    }).filter(s => s !== '');
    return `[${regionStrs.join('|')}]`;
  });
  return { text: parts.join(' ⊕ '), vertexLabels };
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastTime = performance.now();
let animating = true;
let needsInitialRender = true;

// Transient "pop" bursts spawned when a dead component vanishes.
const POP_DURATION = 420; // ms
const popAnims: { pos: SpherePoint; start: number }[] = [];

// DEBUG: on-screen log of which collapse function fired, in order, since the
// last committed move — see index.html #collapse-trace. Gated by the
// "Collapse List" toggle, off by default; shown with a maroon background when on,
// to make it easy to spot while tracking runaway-retry-loop-style collapse bugs.
const collapseTraceEl = document.getElementById('collapse-trace') as HTMLDivElement | null;
const collapseListCheckbox = document.getElementById('collapse-list-checkbox') as HTMLInputElement;
let showCollapseList = collapseListCheckbox.checked; // sync on (re)load — survives HMR
if (collapseTraceEl) {
  collapseTraceEl.style.background = 'maroon';
  collapseTraceEl.style.display = showCollapseList ? 'block' : 'none';
}
collapseListCheckbox.addEventListener('change', () => {
  showCollapseList = collapseListCheckbox.checked;
  if (collapseTraceEl) collapseTraceEl.style.display = showCollapseList ? 'block' : 'none';
});
const collapseTraceLines: string[] = [];
let lastTraceMoveCount = state.moveCount;
// Runaway-retry guard: a collapse whose commit gets rolled back (encoding mismatch,
// engine not ready) still reports done:true, so checkForCollapses() can immediately
// re-detect and re-attempt the same doomed collapse every frame forever. Cap how many
// collapse attempts (successful or rolled-back) a single move may rack up.
const MAX_COLLAPSES_PER_MOVE = 25;
let collapseCountThisMove = 0;
function logCollapse(kind: string): void {
  collapseCountThisMove++;
  collapseTraceLines.push(collapseCountThisMove > MAX_COLLAPSES_PER_MOVE ? `${kind} (HALTED — retry cap hit)` : kind);
  if (collapseTraceEl) collapseTraceEl.textContent = collapseTraceLines.map((k, i) => `${i + 1}. ${k}`).join('\n');
}
function clearCollapseTrace(): void {
  collapseTraceLines.length = 0;
  collapseCountThisMove = 0;
  if (collapseTraceEl) collapseTraceEl.textContent = '';
}

function wake(): void {
  needsInitialRender = true;
  if (!animating) {
    animating = true;
    requestAnimationFrame(frame);
  }
}

function frame(now: number): void {
  try {
    frameBody(now);
  } catch (err) {
    console.error('Frame loop error:', err);
    // Log and clean up any edges whose endpoints were deleted mid-surgery.
    for (const [eid, e] of [...state.edges]) {
      const v1ok = state.vertices.has(e.v1), v2ok = state.vertices.has(e.v2);
      if (!v1ok || !v2ok) {
        console.error(`  orphaned edge ${eid}: v1=${e.v1}(${v1ok?'ok':'DEAD'}) v2=${e.v2}(${v2ok?'ok':'DEAD'})`);
        state.edges.delete(eid);
      }
    }
    // Log pending collapse context.
    if (pendingCollapse) {
      console.error('  pendingCollapse:', JSON.stringify(pendingCollapse, (k, v) => (k === 'deflate' ? '(mesh)' : v)));
    }
    animating = false;
  }
}

function frameBody(now: number): void {
  const dt = now - lastTime;
  lastTime = now;

  if (state.moveCount !== lastTraceMoveCount) {
    lastTraceMoveCount = state.moveCount;
    clearCollapseTrace();
  }

  let needsRender = false;

  if (recenterAxis && recenterAngleLeft > 0) {
    let maxZ = -Infinity;
    let worstCamPos: SpherePoint | null = null;
    for (const v of state.vertices.values()) {
      if (v.isPseudo || v.degree >= 3) continue;
      const cp = rotateSpherePoint(v.pos, camera);
      if (cp.z > maxZ) { maxZ = cp.z; worstCamPos = cp; }
    }
    if (worstCamPos && maxZ > BOUNDARY_Z_THRESHOLD) {
      const xyLen = Math.sqrt(worstCamPos.x ** 2 + worstCamPos.y ** 2);
      if (xyLen > 1e-9) {
        const axis: SpherePoint = { x: -worstCamPos.y / xyLen, y: worstCamPos.x / xyLen, z: 0 };
        const step = Math.min(recenterAngleLeft, RECENTER_SPEED * dt / 1000);
        camera = composeRotations(axisAngleRotation(axis, step), camera);
        recenterAngleLeft -= step;
      }
    } else {
      recenterAngleLeft = 0;
    }
    if (recenterAngleLeft <= 0) recenterAxis = null;
    needsRender = true;
  }

  if (manualRecenterTarget) {
    const t = rotateSpherePoint(manualRecenterTarget, camera);
    const xyLen = Math.sqrt(t.x ** 2 + t.y ** 2);
    if (xyLen < 1e-9 || t.z > 0.9999) {
      manualRecenterTarget = null;
    } else {
      const axis: SpherePoint = { x: t.y / xyLen, y: -t.x / xyLen, z: 0 };
      const angle = Math.acos(Math.min(1, t.z));
      const step = Math.min(angle, RECENTER_SPEED * dt / 1000);
      camera = composeRotations(axisAngleRotation(axis, step), camera);
      if (angle - step < 0.001) { manualRecenterTarget = null; startRecenter(); }
    }
    needsRender = true;
  }

  input.tick(dt);

  if (input.isDrawing() || input.isRotating() || input.isRejecting()) {
    needsRender = true;
  } else if (input.isDragging()) {
    const drag = input.getDragTarget()!;
    if (smoothStepDrag(state, drag)) input.cancelDrag();
    needsRender = true;
  } else if (!recreatePaused && !candidatePreviewList && !manualAwait) {
    let anyMoving = false;

    // Smooth runs first so the collapse step can override vertex positions last.
    // Pass collapseSkip so smooth doesn't repel or redistribute the collapsing vertices.
    const collapseSkip = pendingCollapse ? specialCollapseVertices(pendingCollapse) : undefined;
    if (smoothStep(state, shrinkCheckbox.checked, collapseSkip)) anyMoving = true;
    maybeStartPrecompute(); // the Position Browser's children pass waits for the board to come to rest

    // Collapse dead-region scabs before eliminateIsolatedVertex so the scab vertex
    // is in livingVertexSet (protected) when the isolation check runs.
    // Skip the outer (degree-3) louse vertices only. The inner vertex is allowed to
    // self-connect if it borders a living region (true scab); louse-inner-only vertices
    // are filtered out by the bordersLiving check in scabAloneCollapse.
    // Any other pending collapse owns all its vertices: the scab surgery is instant, so
    // letting it delete them would skip that collapse's animation.
    // Like every other collapse, only while Collapsing is on.
    const scabSkip = pendingCollapse?.kind === 'louse'
      ? new Set([...pendingCollapse.outer])
      : collapseSkip;
    if (shrinkCheckbox.checked && scabAloneCollapse(state, scabSkip)) {
      anyMoving = true;
      // If the scab collapse deleted louse outer vertices, cancel the stale louse.
      if (pendingCollapse?.kind === 'louse') {
        const lc = pendingCollapse;
        if (!state.vertices.has(lc.outer[0]) || !state.vertices.has(lc.outer[1])) {
          pendingCollapse = null;
        }
      }
      // scabAloneCollapse may have created a self-loop on a vertex whose external
      // neighbour is already dead — check for a self-connected-dead collapse now.
      if (!pendingCollapse) checkForCollapses();
    }

    if (shrinkCheckbox.checked) {
      const skipVerts = pendingCollapse ? specialCollapseVertices(pendingCollapse) : undefined;

      // Immediately splice out any isolated degree-2 vertices (no slerp needed).
      let isoPopAt: SpherePoint | null;
      let anyIsoElim = false;
      while ((isoPopAt = eliminateIsolatedVertex(state, skipVerts)) !== null) {
        popAnims.push({ pos: isoPopAt, start: now });
        anyMoving = true;
        anyIsoElim = true;
      }
      // Splicing may have created new collapse opportunities (e.g. parallel edges).
      if (anyIsoElim) {
        resampleAllEdges(state);
        checkForCollapses();
      }

      // General dead components shrink one at a time, and only while no special
      // collapse is running (see collapseActive).
      if (!pendingCollapse) {
        const wasShrinking = generalCollapseFocus !== null;
        const { moving: deadMoving, popped, popCentroids, focus } = deadRegionStep(state, undefined, generalCollapseFocus);
        generalCollapseFocus = focus;
        if (deadMoving) anyMoving = true;
        if (popped) {
          logCollapse('deadRegionStep (general)');
          resampleAllEdges(state);
          for (const c of popCentroids) popAnims.push({ pos: c, start: now });
        }
        if (popped || (wasShrinking && !focus)) checkForCollapses();
      }
    }

    // Run any in-progress special collapse to completion even if shrink is now off.
    if (pendingCollapse) {
      anyMoving = true;
      const pc = pendingCollapse;
      const { done, popAt, label } = stepSpecialCollapse(state, pc);
      if (done && !revertIfCollapseRefused(pc)) {
        logCollapse(label);
        if (popAt) popAnims.push({ pos: popAt, start: now });
        resampleAllEdges(state);
        pendingCollapse = null;
        checkForCollapses();
      }
    }
    // A refusal from any other surgery this frame (instant scab/isolated-vertex splices, a general
    // pop) was already rolled back exactly; it still means a collapse bug, so collapsing stops.
    revertIfCollapseRefused();

    if (anyMoving) needsRender = true;
  }

  // Advance + prune pop bursts; keep rendering while any are alive. Frozen
  // while Recreate is paused (or showing the candidate-preview/manual-draw
  // overlay): shift each burst's start time forward by the frozen duration so
  // its remaining progress is preserved instead of the burst silently aging —
  // or even finishing — off-screen and then jumping on resume.
  let activePops: { pos: SpherePoint; age: number }[] | undefined;
  if (recreatePaused || candidatePreviewList || manualAwait) {
    for (const p of popAnims) p.start += dt;
  } else if (popAnims.length > 0) {
    for (let i = popAnims.length - 1; i >= 0; i--) {
      if (now - popAnims[i].start >= POP_DURATION) popAnims.splice(i, 1);
    }
    if (popAnims.length > 0) {
      activePops = popAnims.map(p => ({ pos: p.pos, age: (now - p.start) / POP_DURATION }));
      needsRender = true;
    }
  }

  if (needsRender || needsInitialRender) {
    needsInitialRender = false;
    const extras = input.getRenderExtras();
    if (showEncoding) {
      encPanel.textContent = boundaryListing(state);
      encPanel.classList.add('visible');
    }
    let spotLabelsDisplay: Map<number, string> | undefined;
    if (showSpotLabels) {
      spotLabelsDisplay = new Map();
      for (const [vid, lbl] of state.spotLabels) {
        if (!state.vertices.has(vid)) continue;
        // Fixed (certain) labels are shown forever, even once the vertex is
        // no longer a spot. Open ranges only make sense while still live.
        if (typeof lbl === 'number' || state.vertices.get(vid)?.degree === 0) {
          spotLabelsDisplay.set(vid, formatSpotLabel(lbl));
        }
      }
      // Vertices that were never a spot (e.g. move midpoints) have no entry
      // in state.spotLabels — show their raw vertex ID instead.
      for (const v of state.vertices.values()) {
        if (v.isPseudo || spotLabelsDisplay.has(v.id)) continue;
        spotLabelsDisplay.set(v.id, String(v.id));
      }
    }
    let vertexLabels: Map<number, string> | undefined;
    // "Hidden letters" owns the buildExpandedEncoding letter labels (what "Vertex IDs" used to
    // show by mistake); "Vertex IDs" now shows each vertex's actual, permanent id number.
    let canvasVertexLabels: Map<VertexId, string> | undefined;
    if (showVertexIds) {
      const rawIdLabels = new Map<VertexId, string>();
      for (const v of state.vertices.values()) {
        if (v.isPseudo) continue;
        rawIdLabels.set(v.id, String(v.id));
      }
      canvasVertexLabels = rawIdLabels;
    }
    if (isWide && showInvisibleAsLetters) {
      const expanded = buildExpandedEncoding(state);
      if (!showVertexIds) canvasVertexLabels = expanded.vertexLabels;
      pbInvisibleBoundaryListing.textContent = expanded.text;
      pbInvisibleBoundaryListing.classList.add('visible');
    } else {
      pbInvisibleBoundaryListing.classList.remove('visible');
    }
    if (showEncoding || showPosition || isWide || showPointEncodings) {
      const enc = encodePosition(state);
      if (showPointEncodings) vertexLabels = enc.vertexSymbols;
      if (isWide) {
        // This row tracks whatever's actually on screen in the panel: the live game position
        // while synced/showing live (full hover-to-canvas provenance, via computeLiveEncodingDisplay),
        // or — once free-browsing away from it — the browsed position's own canon encoding. The
        // browsed position is a bare encoding string with no backing GameState, so there's no
        // geometry to hover-highlight against; it renders as plain (unhoverable) text instead.
        const browsedCanon = isShowingLive() ? null : currentBrowsedCanon();
        const { text: liveText, charInfo: liveCharInfo } = browsedCanon === null
          ? computeLiveEncodingDisplay(state, enc)
          : browsedCanon
            ? wrapCanonDisplay(browsedCanon, browsedCanon.split('').map(() => ({ vertexIds: [] })))
            : { text: '(none)', charInfo: [] };
        lastLiveCharInfo = liveCharInfo;
        renderCharSpans(pbLiveEncoding, liveText);
        // Auto-follow the live game only in Sync mode; free-browse leaves the panel where the user
        // navigated. Only re-navigate when the live position actually changed (not every frame).
        if (isSyncMode()) {
          const analysisText = liveAnalysisText(state);
          if (analysisText !== lastNotifiedLiveEnc) {
            lastNotifiedLiveEnc = analysisText;
            void notifyLivePosition(analysisText);
          }
        }
        // Keep the back/forward arrows' enabled state in step with the game's undo/redo stacks.
        updateNavButtons();
      } else if (showPosition) {
        const { text: liveText, charInfo: liveCharInfo } = computeLiveEncodingDisplay(state, enc);
        lastCharInfo = liveCharInfo;
        renderCharSpans(bottomBarText, liveText);
        bottomBar.classList.add('visible');
      }
    }
    const playerTurn = (state.moveCount % 2 === 0 ? 1 : 2) as 1 | 2;
    renderer.render(state, camera, { ...extras, showMidpoints, showRegions, showVertexIds, showBoundaryArrows, showRegionDiagnostic, showRegionNetwork, vertexLabels, spotLabels: spotLabelsDisplay, popAnimations: activePops, gameOver: isGameOver(), playerTurn, checkFailed: recreateCheckFailed, recreateHints: manualHints ?? undefined, candidatePreviewStrokes: candidatePreviewList ?? movePreviewFailCandidates ?? undefined, subregionHighlight: subregionHighlight ?? undefined, proposedArc: proposedArc ?? undefined, movePreviewArc: movePreviewArc ?? undefined, movePreviewRawArc: showRawMovePlan && movePreviewArc ? rawRouteOf(movePreviewArc) : undefined, movePreviewFailRing: movePreviewFailRing ?? undefined, voronoiGraph: lastVoronoiGraph ?? undefined, voronoiCircumcenters: lastVoronoiCCs ?? undefined, voronoiExtraSeeds: lastVoronoiExtraSeeds ?? undefined, voronoiFullNodes: lastVoronoiFullNodes ?? undefined, voronoiSurvivingIds: lastVoronoiSurvivingIds ?? undefined, voronoiFakeCgrId: lastVoronoiFakeCgrId ?? undefined, hoverHighlight: hoverCharInfo ?? undefined, enclosureSideColors: showEnclosureSides ? lastEnclosureSideColors : undefined, enclosureCoverage: showEnclosureSides ? lastEnclosureCoverage : undefined, vertexIdLabels: canvasVertexLabels });
  }

  if (needsRender) {
    requestAnimationFrame(frame);
  } else {
    animating = false;
  }
}
requestAnimationFrame(frame);
syncLayoutMode();

showPlayGate();
