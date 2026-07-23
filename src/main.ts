import { createInitialState, cloneState } from './model/gameState';
import { applyMove, recomputeRegions } from './model/moves';
import { encodePosition, encodePositionDecompressed, canonicalEncoding, resolveMoveVertices, classifyVertexFull } from './model/encoding';
import { VertexType } from './model/types';
import type { EncodingResult } from './model/encoding';
import { computeMoveCode, computeEnclosureSideColoring, computeEnclosureCoverage } from './model/moveCode';
import { recomputeSpotLabels, initialSpotLabels, labelForFromMap, spotGroupForFromMap, formatSpotLabel } from './model/vertexLabels';
import { parseMoveSequence } from './model/moveCodeParse';
import type { ResolvedMove } from './model/moveCodeParse';
import { synthesizeMove, appliedMoveMatches, computeRecreateHints, strokeReproduces } from './model/recreate';
import type { RecreateHints } from './model/recreate';
import { resolveBracketEntry, resolveMoveEndpoints, resolveParensEntry } from './model/vertexLabels';
import { strokeCrossesEdges, candidateStrokes, candidateSelfLoopArcsWithSeeds } from './model/strokeSynthesis';
import { moveLog } from './debug/moveLog';
import { DEBUG } from './debug/flags';
import { smoothStep, smoothStepDrag, resampleEdge, lastMaxMovement, resetActivityTimer } from './model/smooth';
import { tunables, TUNABLE_SPECS, loadTunables, saveTunables, resetTunables } from './model/tunables';
import { deadRegionStep, eliminateIsolatedVertex, detectLouse, louseCollapseStep, detectParallelDead, parallelDeadStep, detectTripleParallelDead, tripleParallelDeadStep, detectTriangleDead, triangleDeadStep, detectQuadDead, quadDeadStep, scabAloneCollapse, detectBigonTip, bigonTipStep, detectEnclosedTriangle, enclosedTriangleStep, detectSelfConnectedDead, selfConnectedDeadStep } from './model/deadRegions';
import type { LouseCollapse, ParallelDeadCollapse, TripleParallelDeadCollapse, TriangleDeadCollapse, QuadDeadCollapse, BigonTipCollapse, EnclosedTriangleCollapse, SelfConnectedDeadCollapse } from './model/deadRegions';

type SpecialCollapse = LouseCollapse | ParallelDeadCollapse | TripleParallelDeadCollapse | TriangleDeadCollapse | QuadDeadCollapse | BigonTipCollapse | EnclosedTriangleCollapse | SelfConnectedDeadCollapse;
import { Renderer } from './render/renderer';
import type { SubregionHighlight } from './render/renderer';
import { InputHandler } from './input/inputHandler';
import { identityRotation, rotationX, rotationY, composeRotations, rotateSpherePoint, axisAngleRotation } from './math/sphere';
import type { RotationMatrix, SpherePoint } from './math/sphere';
import type { GameState, VertexId } from './model/types';
import { buildVoronoiGraph } from './model/voronoiGraph';
import { computeJunctionVoronoiPath } from './model/voronoiJunctionPath';
import { buildSubregionHighlight } from './model/subregionHighlight';
import { serializeGameState, deserializeGameState } from './model/saveState';
import type { SaveFileV1 } from './model/saveState';
import { openPositionBrowser, ensureWired as ensureBrowserWired, notifyLivePosition, isShowingLive, currentBrowsedCanon, onNavigated, setMoveCallbacks, setSyncCallbacks, onSyncModeChange, isSyncMode, setSyncMode, setSyncToggleEnabled, updateNavButtons } from './ui/positionBrowser';
import { TrackedGame } from './engine/trackedGame';
import type { MovePreviewTarget } from './ui/positionBrowser';
import { initGuide } from './ui/guide';
import { initCollect } from './ui/collect';
import { canon as canonEncoding, preloadModule, canonicalizeTrackedProvenanceSync, canonSync } from './engine/stalks';
import { recordEdge, loadMasterSeed } from './model/positionCache';

// Kick off the WASM module load immediately (independent of the Tracked Encoding toggle) so
// canonSync()-backed gates (e.g. deadRegions' commitIfEncodingPreserved) have a real chance of
// being engine-backed rather than falling back to the plain string compare. See M6 in
// project_encoding_canon_rework.
preloadModule();

// Fire-and-forget: seeds positionCache.meta from the precomputed master-save dump so the Position
// Browser doesn't have to recompute large, already-solved positions from scratch.
loadMasterSeed();

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

bottomBarText.addEventListener('mousemove', e => {
  const target = e.target as HTMLElement;
  const idxAttr = target?.dataset?.idx;
  const idx = idxAttr !== undefined ? Number(idxAttr) : NaN;
  const info = !Number.isNaN(idx) ? lastCharInfo[idx] : undefined;
  const next = info && info.vertexIds.length > 0 ? info : null;
  if (next !== hoverCharInfo) {
    hoverCharInfo = next;
    wake();
  }
});
bottomBarText.addEventListener('mouseleave', () => {
  if (hoverCharInfo !== null) { hoverCharInfo = null; wake(); }
});

// Position Browser move hover/lock preview: a dashed arc on the playfield for whatever child
// move the browser is currently hovering/locking, resolved from the engine's abstract MoveInfo
// against the live state (only meaningful while the browser is showing the live position).
let movePreviewArc: SpherePoint[] | null = null;
let movePreviewStroke: { v1: number; v2: number; stroke: SpherePoint[] } | null = null;
let movePreviewFailRing: number[] | null = null;
let movePreviewFailCandidates: { stroke: SpherePoint[]; legal: boolean }[] | null = null;
let movePreviewToken = 0;

// Cross-check cache for the "misidentified sibling" case: some enclosure moves get drawn as a
// circled/failed ring not because no valid stroke exists, but because the candidate strokes we
// can synthesize for THAT move's own endpoints land on a different (also-listed) child instead.
// When that happens the position they DID land on is real and useful — it's some other child's
// target, just reached via the wrong-looking pair of vertices. So instead of only ever checking a
// hovered move's candidates against its own target, precomputeChildrenMoves tries every
// move-bearing child's candidates up front and records every resulting canon it actually reaches
// (first stroke wins), keyed by that resulting canon rather than by which child it was tried for.
// synthesizeVerifiedMove then falls back to this cache when a target's own candidates all miss.
let childrenBatchGen = 0;
let attemptedResultCanons = new Map<string, { v1: number; v2: number; stroke: SpherePoint[] }>();

async function precomputeChildrenMoves(targets: MovePreviewTarget[]): Promise<void> {
  const myGen = ++childrenBatchGen;
  const results = new Map<string, { v1: number; v2: number; stroke: SpherePoint[] }>();
  for (const t of targets) {
    const resolved = resolveMoveVertices(state, t.move);
    if (!resolved) continue;
    const parsed: ResolvedMove = {
      token: '', checkEncoding: null, lo: resolved.v1, hi: resolved.v2, loSub: null, hiSub: null,
      parallel: false, parens: null, brackets: resolved.brackets ?? null,
    };
    for (const stroke of candidateStrokes(state, parsed)) {
      if (myGen !== childrenBatchGen) return; // superseded by a newer batch (position changed)
      if (strokeCrossesEdges(state, stroke, undefined, resolved.v1, resolved.v2)) continue;
      const trial = cloneState(state);
      try {
        applyMove(trial, { v1: resolved.v1, v2: resolved.v2, stroke });
      } catch {
        continue;
      }
      const trialCanon = await canonEncoding(encodePosition(trial).text);
      if (!results.has(trialCanon)) results.set(trialCanon, { v1: resolved.v1, v2: resolved.v2, stroke });
    }
  }
  if (myGen !== childrenBatchGen) return;
  attemptedResultCanons = results;
}

setMoveCallbacks({
  onChildrenBatch(targets: MovePreviewTarget[]) {
    void precomputeChildrenMoves(targets);
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
      afterMoveCommitted(resolved.v1, resolved.v2);
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
 * the one function both sides already agree parses to the same canonical identity.
 *
 * When the endpoints resolve but no candidate verifies (e.g. the mask/bracket-set requires a
 * routing candidateStrokes can't propose), the caller still knows *which* two vertices the move
 * should connect — reported as 'unreachable' so the UI can ring them instead of drawing nothing —
 * plus every candidate stroke that was tried, tagged `legal` (didn't cross existing geometry) or
 * not, so the caller can optionally show what was auto-checked and rejected.
 */
async function synthesizeVerifiedMove(target: MovePreviewTarget): Promise<SynthesizeResult> {
  const resolved = resolveMoveVertices(state, target.move);
  if (!resolved) return { kind: 'unresolved' };
  const parsed: ResolvedMove = {
    token: '', checkEncoding: null, lo: resolved.v1, hi: resolved.v2, loSub: null, hiSub: null,
    parallel: false, parens: null, brackets: resolved.brackets ?? null,
  };
  // target.targetEnc comes straight from the WASM engine's analyze() child
  // list, which is not guaranteed to already be in the same bracketless/
  // DisaPoint-compressed form that canonEncoding() below produces for the
  // trial position (e.g. a two-vertex "(29)"/"(2,9)" region vs. its
  // compressed "3" token for the same equivalence class) — normalize both
  // sides through canonEncoding() so the comparison isn't representation-
  // sensitive.
  const targetCanon = await canonEncoding(target.targetEnc);
  const candidates: { stroke: SpherePoint[]; legal: boolean }[] = [];
  for (const stroke of candidateStrokes(state, parsed)) {
    const legal = !strokeCrossesEdges(state, stroke, undefined, resolved.v1, resolved.v2);
    candidates.push({ stroke, legal });
    if (!legal) continue;
    const trial = cloneState(state);
    try {
      applyMove(trial, { v1: resolved.v1, v2: resolved.v2, stroke });
    } catch {
      continue;
    }
    const trialCanon = await canonEncoding(encodePosition(trial).text);
    if (trialCanon === targetCanon) {
      return { kind: 'found', v1: resolved.v1, v2: resolved.v2, stroke };
    }
  }
  // None of this move's own candidates reach it directly — check whether some other listed
  // child's attempted stroke happened to land here anyway (see precomputeChildrenMoves above).
  const crossHit = attemptedResultCanons.get(targetCanon);
  if (crossHit) return { kind: 'found', ...crossHit };
  return { kind: 'unreachable', v1: resolved.v1, v2: resolved.v2, candidates };
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
  /** The canonical position string — the invariant dead-region surgery must preserve. */
  encode() { return canonicalEncoding(state); },
  applyMove: (v1: number, v2: number, stroke: unknown[]) => applyMove(state, { v1, v2, stroke: stroke as SpherePoint[] }),
  /** Dev aid: full commit pipeline (history snapshot + applyMove + afterMoveCommitted), so a
   *  console-driven move behaves like a real one (tracked-check scheduling, committedMoves, etc). */
  commitMove(v1: number, v2: number, stroke: unknown[]) {
    pushHistorySnapshot();
    applyMove(state, { v1, v2, stroke: stroke as SpherePoint[] });
    afterMoveCommitted(v1, v2);
  },
  undoLast: () => undoLast(),
  get committedMoves() { return committedMoves; },
  resetGame: (spots: number) => resetGame(spots),
  /** Dev aid: load a save file (parsed SaveFileV1 object) without going through the file input. */
  loadFromJson: (save: SaveFileV1) => loadGameState(save),
  get trackedCheckEnabled() { return trackedCheckEnabled; },
  /** "ID-based Sequencing" debug toggle — which form (label vs raw vertex id) Save/Recreate-style
   *  tooling should read out of moveSequence/moveSequenceRaw. */
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
const history: GameState[] = [];
// Move sequence, stored in both label form (default display) and raw-vertex-ID
// form, computed once per move at commit time — the "Use vertex ID" toggle is
// then a pure display swap, never a retroactive recompute.
const moveSequence: string[] = [];
const moveSequenceRaw: string[] = [];
// Sequence-verifier-on variants of the two arrays above: same tokens, each with the
// {encoding} suffix always appended, regardless of the current Move Check toggle — kept so
// the Copy button can hand out a verifiable sequence even when the toggle is off (see
// updateMoveSeq / moveSeqCopy).
const moveSequenceTagged: string[] = [];
const moveSequenceRawTagged: string[] = [];
// Raw (v1,v2) per committed move, aligned 1:1 with `history` (history[k] is the state
// BEFORE committedMoves[k]). Lets undo resync the tracked map by replaying from scratch
// instead of just giving up (Catch D, project_encoding_canon_rework M6) — separate from
// the debug-only `moveLog` import, which is never truncated on undo and so isn't safe to
// use for this.
const committedMoves: { v1: VertexId; v2: VertexId }[] = [];
// Redo stack for the Position Browser's Sync-mode forward arrow (undo/redo of the live game). Each
// entry captures everything undoLast() throws away, so redoLast() can re-apply it. Cleared whenever
// a genuinely new move is committed (afterMoveCommitted) or the game is reset/loaded — a new branch
// off an undone position invalidates the redo tail.
interface RedoEntry {
  postState: GameState;   // the state we were at before this undo — restored on redo
  preState: GameState;    // the pre-move snapshot undo popped off `history` — pushed back on redo
  moveSeq: string;        // the matching moveSequence / moveSequenceRaw / committedMoves entries
  moveSeqRaw: string;
  moveSeqTagged: string;
  moveSeqRawTagged: string;
  committed: { v1: VertexId; v2: VertexId };
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

// Arc-preview state: set while the user inspects candidate arcs before committing.
let candidatePreviewList: { stroke: SpherePoint[]; legal: boolean }[] | null = null;
let candidateResolve: ((go: boolean) => void) | null = null;

function updateUndoButton(): void {
  undoBtn.disabled = history.length === 0 || recreateActive;
}

function updateSaveButton(): void {
  saveGameBtn.disabled = !gameStarted;
}

// The move-sequence bar (bottom of screen, Debug mode only) mirrors the underlying
// moveSequence/moveSequenceRaw arrays, which are recorded unconditionally for Save/Recreate
// regardless of whether Debug mode is unlocked yet. All four vertex-ID x sequence-verifier
// variants are kept in sync in the background (see moveSequence/moveSequenceRaw/
// moveSequenceTagged/moveSequenceRawTagged); this just picks which one to show based on the
// current toggles.
function moveSeqTokens(): string[] {
  if (moveCheckMode) return useRawVertexIds ? moveSequenceRawTagged : moveSequenceTagged;
  return useRawVertexIds ? moveSequenceRaw : moveSequence;
}
/** Copy always hands out the sequence-verifier-on ({encoding}-tagged) variant, matching the
 * current vertex-ID/label toggle, regardless of whether Move Check is currently switched on —
 * so the copied sequence is verifiable even if the user just wants to look at plain move text. */
function moveSeqCopyText(): string {
  const tokens = useRawVertexIds ? moveSequenceRawTagged : moveSequenceTagged;
  return `${currentSpotCount}:${tokens.join('/')}`;
}
function updateMoveSeq(): void {
  const tokens = moveSeqTokens();
  const text = `${currentSpotCount}:${tokens.join('/')}`;

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
      afterMoveCommitted(await_.parsed.lo, await_.parsed.hi);
      manualAwait = null;
      manualHints = null;
      subregionHighlight = null;
      hideBanner();
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
  if (recordRedo) {
    redoStack.push({
      postState: cloneState(state),
      preState: history[history.length - 1],
      moveSeq: moveSequence[moveSequence.length - 1],
      moveSeqRaw: moveSequenceRaw[moveSequenceRaw.length - 1],
      moveSeqTagged: moveSequenceTagged[moveSequenceTagged.length - 1],
      moveSeqRawTagged: moveSequenceRawTagged[moveSequenceRawTagged.length - 1],
      committed: committedMoves[committedMoves.length - 1],
    });
  }
  Object.assign(state, history.pop()!);
  moveSequence.pop();
  moveSequenceRaw.pop();
  moveSequenceTagged.pop();
  moveSequenceRawTagged.pop();
  committedMoves.pop();
  pendingCollapse = null;
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
 * pushes the pre-move snapshot back onto `history`, restores the move-sequence/committed entries,
 * and jumps `state` to the captured post-move geometry. Blocked during Recreate playback. */
function redoLast(): void {
  if (redoStack.length === 0 || recreateActive) return;
  const entry = redoStack.pop()!;
  history.push(entry.preState);
  moveSequence.push(entry.moveSeq);
  moveSequenceRaw.push(entry.moveSeqRaw);
  moveSequenceTagged.push(entry.moveSeqTagged);
  moveSequenceRawTagged.push(entry.moveSeqRawTagged);
  committedMoves.push(entry.committed);
  Object.assign(state, entry.postState);
  pendingCollapse = null;
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
 * Rebuild the tracked map from a fresh seed by replaying every currently-committed move
 * (in `committedMoves`, aligned with `history`) through the same onMoveSettled path a live
 * move uses. Fully reuses the already-verified match/carryForward/face-check machinery —
 * no new matching algorithm. Snapshots the arrays/state it reads at the start so a new move
 * made while this is still in flight (a handful of awaited WASM calls) can't pull the rug
 * out from under it; if that race does happen, the newer move's own onMoveSettled call
 * simply supersedes whatever this leaves behind (tracked.map is always "last write wins").
 * NOT built for load (Catch D remains open there): a loaded save has only its final
 * geometry, not the intermediate per-move states this replay needs to derive each move's
 * generated-midpoint vertex — reconstructing those would mean re-deriving the whole game
 * via move synthesis (Recreate-style), a separate, heavier undertaking.
 */
async function resyncTrackedFromHistory(): Promise<void> {
  if (!trackedCheckEnabled) return;
  const moves = committedMoves.slice();
  const hist = history.slice();
  const finalState = cloneState(state);
  const seedSpotIds = hist.length > 0 ? [...hist[0].vertices.keys()] : [...finalState.vertices.keys()];

  tracked.reset(seedSpotIds);
  for (let k = 0; k < moves.length; k++) {
    const parentState = hist[k];
    if (!parentState) { tracked.markDesynced(); return; }
    const settledState = k + 1 < hist.length ? hist[k + 1] : finalState;
    const newVertexIds = new Set<VertexId>();
    for (const [vid, v] of settledState.vertices) {
      if (!parentState.vertices.has(vid) && !v.isPseudo) newVertexIds.add(vid);
    }
    const res = await tracked.onMoveSettled(settledState, moves[k].v1, moves[k].v2, newVertexIds);
    if (res.status !== 'match') { tracked.markDesynced(); return; }
  }
  updateTrackedPanel(null);
}

undoBtn.addEventListener('click', () => undoLast(true));

bottomBarCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(bottomBarText.textContent ?? '');
});

// ---------------------------------------------------------------------------
// Special-collapse queue (one at a time)
// ---------------------------------------------------------------------------

let pendingCollapse: SpecialCollapse | null = null;

function checkForCollapses(): void {
  if (pendingCollapse) return;
  if (collapseCountThisMove >= MAX_COLLAPSES_PER_MOVE) return;
  pendingCollapse = detectLouse(state) ?? detectParallelDead(state) ?? detectTripleParallelDead(state) ?? detectTriangleDead(state) ?? detectEnclosedTriangle(state) ?? detectQuadDead(state) ?? detectBigonTip(state) ?? detectSelfConnectedDead(state);
}

/** Vertex IDs that the active special collapse owns (excluded from deadRegionStep). */
function collapseVertices(c: SpecialCollapse): Set<number> {
  if (c.kind === 'louse') return new Set([...c.outer, c.inner]);
  if (c.kind === 'parallel-dead') return new Set([c.p, c.q]);
  if (c.kind === 'triple-parallel-dead') return new Set([c.p, c.q]);
  if (c.kind === 'quad-dead') return new Set([c.a, c.b, c.c, c.d]);
  if (c.kind === 'bigon-tip') return new Set([c.w, c.a]);
  if (c.kind === 'self-connected-dead') return new Set([c.s, c.t]);
  return new Set([c.a, c.b, c.c]);
}

// ---------------------------------------------------------------------------
// Input handler
// ---------------------------------------------------------------------------

/** Snapshot the pre-move state for undo. (InputHandler.onBeforeMove) */
function pushHistorySnapshot(): void {
  history.push(cloneState(state));
  updateUndoButton();
}

/**
 * The post-move commit pipeline: resample edges, record the move code, advance
 * the turn indicator, and run dead-region collapses. Shared by live play and
 * the Recreate controller so both paths behave identically.
 */
function afterMoveCommitted(v1: number, v2: number): void {
  // A genuinely new move branches off wherever we are now — any redo tail is no longer reachable.
  redoStack.length = 0;
  // Resample all edges so point counts reflect current geometry
  for (const e of state.edges.values()) resampleEdge(e);
  // Record move code (pre-move state is the last history snapshot)
  const prevState = history[history.length - 1];
  if (prevState) {
    state.spotLabels = recomputeSpotLabels(prevState.spotLabels, prevState, state, v1, v2);
    // A departing spot endpoint is fixed by the recompute above, so lo/hi
    // resolve correctly off the POST-move map; a non-spot endpoint (or one
    // that was already fixed in an earlier move) also resolves correctly
    // since fixed entries persist in the map forever.
    let labeled = computeMoveCode(
      prevState, v1, v2, state,
      labelForFromMap(state.spotLabels),
      spotGroupForFromMap(state.spotLabels),
    );
    let raw = computeMoveCode(prevState, v1, v2, state);
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
    const tag = `{${lastCommittedEncoding}}`;
    moveSequence.push(labeled);
    moveSequenceRaw.push(raw);
    moveSequenceTagged.push(labeled + tag);
    moveSequenceRawTagged.push(raw + tag);
    committedMoves.push({ v1, v2 });
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
    checkForCollapses();
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

/** Fire the pending tracked check once topology is quiescent. Polls itself until no special
 *  collapse is pending and the graph size has held steady for one interval (or a timeout). */
let trackedPollLast: { nV: number; nE: number } | null = null;
let trackedPollDeadline = 0;
function scheduleTrackedCheck(): void {
  trackedPollLast = null;
  trackedPollDeadline = performance.now() + 4000; // hard cap so a stuck collapse can't wedge it
  const poll = (): void => {
    if (pendingTrackedCheck === null) return; // consumed/cancelled (undo, reset, newer move)
    const nV = state.vertices.size, nE = state.edges.size;
    const quiescent = pendingCollapse === null && trackedPollLast !== null &&
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
      console.log(`[tracked] match: ${res.enc}${res.matchCount && res.matchCount > 1 ? ` (${res.matchCount} automorphic)` : ''}`);
      updateTrackedPanel({ mismatch: false });
    } else if (res.status === 'mismatch') {
      console.warn(`[tracked] MISMATCH — engine=${res.engineKey} geometry=${res.geometryKey}`);
      // Only maroon when geometry is actually cleaned (shrink on); with shrink off, un-popped dead
      // structure legitimately differs from the engine's cleaned child, so a mismatch is expected.
      if (shrinkCheckbox.checked) { recreateCheckFailed = true; wake(); }
      updateTrackedPanel({ mismatch: true, engineKey: res.engineKey, geometryKey: res.geometryKey, enc: res.enc ?? undefined, charInfo: res.charInfo });
    } else {
      console.log(`[tracked] ${res.status}`);
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
  const prevEnc = encodePosition(prev).text;
  const nextEnc = encodePosition(next).text;
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
  onMoveCommitted: (v1, v2) => {
    // Discard strokes drawn during candidate preview (only rotation is intended).
    if (candidatePreviewList) { undoLast(); return; }
    afterMoveCommitted(v1, v2);
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
// sequence — kept separate from moveSequenceRaw because that array may carry the Sequence
// Verifier's {encoding} suffix, which would break an exact string match here.
let liveUnlockTokens: string[] = [];

function unlockDebugMode(): void {
  if (debugUnlocked) return;
  debugUnlocked = true;
  debugMenuWrap.style.display = '';
  recreateBtn.style.display = '';
  collectBtn.style.display = '';
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
  initGuide();
  guideOverlay.classList.add('visible');
});
guideClose.addEventListener('click', () => guideOverlay.classList.remove('visible'));
guideOverlay.addEventListener('click', e => {
  if (e.target === guideOverlay) guideOverlay.classList.remove('visible');
});

// Collect (top bar).
const collectBtn     = document.getElementById('collect-btn')     as HTMLButtonElement;
const collectOverlay = document.getElementById('collect-overlay') as HTMLDivElement;
const collectClose   = document.getElementById('collect-close')   as HTMLButtonElement;

collectBtn.addEventListener('click', e => {
  e.stopPropagation();
  initCollect();
  collectOverlay.classList.add('visible');
});
collectClose.addEventListener('click', () => collectOverlay.classList.remove('visible'));
collectOverlay.addEventListener('click', e => {
  if (e.target === collectOverlay) collectOverlay.classList.remove('visible');
});

// Only shown (below the wide-panel breakpoint) as a way to open the same Position Browser
// the wide layout would otherwise show as a persistent side panel.
browserBtn.addEventListener('click', e => {
  e.stopPropagation();
  openPositionBrowser(encodePosition(state).text);
});

// ---------------------------------------------------------------------------
// Save / Load game state
// ---------------------------------------------------------------------------

const saveGameBtn  = document.getElementById('save-game-btn')  as HTMLButtonElement;
const loadGameBtn  = document.getElementById('load-game-btn')  as HTMLButtonElement;
const loadGameInput = document.getElementById('load-game-input') as HTMLInputElement;

saveGameBtn.addEventListener('click', e => {
  e.stopPropagation();
  const save = serializeGameState(state, camera, currentSpotCount, moveCheckMode ? moveSequenceTagged : moveSequence, manualAwait?.parsed.token ?? null);
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
    let save: SaveFileV1;
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
function loadGameState(save: SaveFileV1): void {
  // Abort any in-progress Recreate, mirroring the New Game confirm handler.
  if (recreateActive) {
    if (manualAwait) { manualAwait.resolve(false); manualAwait = null; }
    if (candidateResolve) { candidateResolve(false); candidateResolve = null; candidatePreviewList = null; }
    recreateActive = false;
    manualHints = null;
    setPaused(false);
    hideBanner();
  }

  const deserialized = deserializeGameState(save);
  Object.assign(state, deserialized.state);
  recomputeRegions(state);
  // Saved games don't persist label history; re-baseline current spots as a
  // fresh -1..-k numbering (cosmetic only — game state itself is unaffected).
  state.spotLabels = initialSpotLabels(state);

  history.length = 0;
  redoStack.length = 0;
  moveSequence.length = 0;
  moveSequenceRaw.length = 0;
  moveSequenceTagged.length = 0;
  moveSequenceRawTagged.length = 0;
  for (const token of deserialized.moveSequence) {
    const base = stripMoveCheckTag(token);
    const tag = moveCheckTagOf(token);
    moveSequence.push(base);
    moveSequenceRaw.push(base);
    // A loaded save's tokens carry whatever tag they were saved with (possibly none, if
    // Move Check was off during that play session) — there's no encoding to recover for an
    // untagged token, so the "tagged" variant just falls back to the untagged form.
    moveSequenceTagged.push(tag ? base + tag : base);
    moveSequenceRawTagged.push(tag ? base + tag : base);
  }
  liveUnlockTokens.length = 0;
  currentSpotCount = deserialized.currentSpotCount;
  camera = deserialized.camera;
  pendingCollapse = null;
  subregionHighlight = null;
  proposedArc = null;
  recenterAxis = null;
  recenterAngleLeft = 0;
  // A loaded save has only final geometry, no intermediate per-move states — the undo-style replay
  // resyncTrackedFromHistory uses can't apply here. Reseed the tracked map straight from that
  // geometry instead (Catch-D for load, project_encoding_canon_rework); falls back to desynced if
  // the WASM module isn't loaded yet or canonicalization fails, same as before this fix.
  pendingTrackedCheck = null;
  tracked.seedFromState(state);
  updateTrackedPanel(null);
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
  let lastGroup = '';
  for (const spec of TUNABLE_SPECS) {
    if (spec.group !== lastGroup) {
      lastGroup = spec.group;
      const h = document.createElement('h4');
      h.textContent = spec.group;
      tuningBody.appendChild(h);
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
    tuningBody.appendChild(row);
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
tuningClose.addEventListener('click', () => { tuningOverlay.classList.remove('visible'); wake(); });
tuningOverlay.addEventListener('click', e => {
  if (e.target === tuningOverlay) { tuningOverlay.classList.remove('visible'); wake(); }
});
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
  if (shrinkCheckbox.checked) checkForCollapses();
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
const ENCLOSURE_COVERAGE_SAMPLE: SpherePoint[] = (() => {
  const N = 900;
  const ga = Math.PI * (3 - Math.sqrt(5));
  const pts: SpherePoint[] = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * i + 1) / N;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r });
  }
  return pts;
})();

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

const encCheckbox = document.getElementById('enc-checkbox') as HTMLInputElement;
const encPanel    = document.getElementById('encoding-panel') as HTMLDivElement;
let showEncoding  = false;
encCheckbox.addEventListener('change', () => {
  showEncoding = encCheckbox.checked;
  if (!showEncoding) { encPanel.classList.remove('visible'); encPanel.textContent = ''; }
  wake();
});

// Move sequence display mode: labels (default) vs raw vertex IDs — a pure
// display swap over the already-recorded moveSequence/moveSequenceRaw arrays.
const rawIdCheckbox = document.getElementById('raw-id-checkbox') as HTMLInputElement;
rawIdCheckbox.addEventListener('change', () => {
  useRawVertexIds = rawIdCheckbox.checked;
  updateMoveSeq();
  wake();
});

// Move Check ("Sequence verifier"): every move's {encoding}-tagged token is always recorded
// in the background (see afterMoveCommitted / moveSequenceTagged); this toggle only controls
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

const pbPanel          = document.getElementById('position-browser-panel')  as HTMLDivElement;
const pbPanelExtra     = document.getElementById('pb-panel-extra')          as HTMLDivElement;
const pbPanelToggleRow = document.getElementById('pb-panel-toggle-row')     as HTMLDivElement;
const pbLiveEncoding   = document.getElementById('pb-live-encoding')        as HTMLDivElement;
const pbInvisibleBoundaryListing = document.getElementById('pb-invisible-boundary-listing') as HTMLDivElement;
const pbTrackedPanel   = document.getElementById('pb-tracked-panel')        as HTMLDivElement;
const pbChrome         = document.getElementById('pb-chrome')               as HTMLDivElement;
const pbBody           = document.getElementById('pb-body')                 as HTMLDivElement;
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
pbLiveEncoding.addEventListener('mousemove', e => {
  const target = e.target as HTMLElement;
  const idxAttr = target?.dataset?.idx;
  const idx = idxAttr !== undefined ? Number(idxAttr) : NaN;
  const info = !Number.isNaN(idx) ? lastLiveCharInfo[idx] : undefined;
  const next = info && info.vertexIds.length > 0 ? info : null;
  if (next !== hoverCharInfo) { hoverCharInfo = next; wake(); }
});
pbLiveEncoding.addEventListener('mouseleave', () => {
  if (hoverCharInfo !== null) { hoverCharInfo = null; wake(); }
});
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
    lastNotifiedLiveEnc = encodePosition(state).text;
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
pbTrackedPanel.addEventListener('mousemove', e => {
  const target = e.target as HTMLElement;
  const idxAttr = target?.dataset?.idx;
  const idx = idxAttr !== undefined ? Number(idxAttr) : NaN;
  const info = !Number.isNaN(idx) ? trackedCharInfo[idx] : undefined;
  const next = info && info.vertexIds.length > 0 ? info : null;
  if (next !== hoverCharInfo) { hoverCharInfo = next; wake(); }
});
pbTrackedPanel.addEventListener('mouseleave', () => {
  if (hoverCharInfo !== null) { hoverCharInfo = null; wake(); }
});

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
  encStr.split('').forEach((ch, idx) => {
    const span = document.createElement('span');
    span.textContent = ch;
    span.dataset.idx = String(idx);
    enc.appendChild(span);
  });
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
      lastNotifiedLiveEnc = encodePosition(state).text;
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
confirmNo.addEventListener('click',  () => { confirmOverlay.classList.remove('visible'); });
confirmOverlay.addEventListener('click', e => {
  if (e.target === confirmOverlay) confirmOverlay.classList.remove('visible');
});
/** Reset to a fresh n-spot game and re-sync all UI from current toggle state. */
function resetGame(spots: number): void {
  currentSpotCount = spots;
  Object.assign(state, createInitialState(spots));
  history.length = 0;
  moveSequence.length = 0;
  moveSequenceRaw.length = 0;
  moveSequenceTagged.length = 0;
  moveSequenceRawTagged.length = 0;
  liveUnlockTokens.length = 0;
  committedMoves.length = 0;
  redoStack.length = 0;
  pendingCollapse = null;
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
  // Abort any in-progress recreate (including manual-draw pause).
  if (recreateActive) {
    if (manualAwait) { manualAwait.resolve(false); manualAwait = null; }
    if (candidateResolve) { candidateResolve(false); candidateResolve = null; candidatePreviewList = null; }
    recreateActive = false;
    manualHints = null;
    subregionHighlight = null;
  proposedArc = null;
    setPaused(false);
    hideBanner();
  }
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
  if (recreateActive) {
    if (manualAwait) { manualAwait.resolve(false); manualAwait = null; }
    if (candidateResolve) { candidateResolve(false); candidateResolve = null; candidatePreviewList = null; }
    recreateActive = false;
    manualHints = null;
    setPaused(false);
    hideBanner();
  }
  recreateError.textContent = '';
  recreateOverlay.classList.add('visible');
  recreateInput.focus();
});
recreateCancel.addEventListener('click', () => recreateOverlay.classList.remove('visible'));
recreateOverlay.addEventListener('click', e => {
  if (e.target === recreateOverlay) recreateOverlay.classList.remove('visible');
});
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

/** Resolve once all collapse animations have finished (pendingCollapse === null). */
function waitForCollapseDone(): Promise<void> {
  if (!pendingCollapse) return Promise.resolve();
  return new Promise(resolve => {
    const check = () => {
      if (!pendingCollapse) { resolve(); return; }
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
    proposedArc = voronoiResult ? voronoiResult.pts : (candidateStrokes(state, parsed)[0] ?? null);
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
    proposedArc = pauseRecreations ? (candidateStrokes(state, parsed)[0] ?? null) : null;
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
  setupManualPause(parsed, moveSequence.length + 1, cloneState(state), () => {
    recreateActive = false;
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
  const all = candidateStrokes(state, parsed);
  if (all.length === 0) return Promise.resolve(null);

  let firstLegal: SpherePoint[] | null = null;
  let legalCount = 0;
  const evaluated = all.map(stroke => {
    const crosses = strokeCrossesEdges(state, stroke, undefined, parsed.lo, parsed.hi);
    const legal = !crosses && strokeReproduces(state, parsed, stroke, recreateUseLabels);
    if (legal && !firstLegal) firstLegal = stroke;
    if (legal) legalCount++;
    return { stroke, legal };
  });

  // When not pausing, auto-commit the first legal candidate with no display.
  if (!pauseRecreations) {
    if (firstLegal) return Promise.resolve(firstLegal);

    const crossResults = evaluated.map(({ stroke }) => {
      const crosses = strokeCrossesEdges(state, stroke, undefined, parsed.lo, parsed.hi);
      const reproduces = strokeReproduces(state, parsed, stroke, recreateUseLabels);
      return { crosses, reproduces };
    });
    if (DEBUG.recreate) {
      console.log(`[Move ${moveNum}] token="${parsed.token}" lo=${parsed.lo} hi=${parsed.hi} brackets=${JSON.stringify(parsed.brackets)}`);
      console.log(`[Move ${moveNum}] candidates: ${evaluated.length} total, ${crossResults.filter(r => !r.crosses).length} pass crossing, ${crossResults.filter(r => r.reproduces).length} pass strokeReproduces, ${crossResults.filter(r => !r.crosses && r.reproduces).length} pass both`);
    }

    // Retry all candidates skipping the crossing check (voronoi arcs can
    // trigger false-positive crossings near existing edges).
    for (let i = 0; i < evaluated.length; i++) {
      if (crossResults[i].reproduces) return Promise.resolve(evaluated[i].stroke);
    }

    // Final fallback for non-self-loop enclosures: try the full Voronoi path.
    if (parsed.brackets && parsed.brackets.length > 0 && parsed.lo !== parsed.hi) {
      const sh = buildSubregionHighlight(state, parsed.lo, parsed.hi, parsed.brackets);
      if (sh) {
        const vData = buildVoronoiGraph(state, sh, parsed.lo, parsed.hi);
        const v1Pos = state.vertices.get(parsed.lo)?.pos;
        const v2Pos = state.vertices.get(parsed.hi)?.pos;
        const voronoiResult = computeJunctionVoronoiPath(vData, v1Pos, v2Pos);
        const vReproduces = voronoiResult ? strokeReproduces(state, parsed, voronoiResult.pts, recreateUseLabels) : false;
        if (DEBUG.recreate) console.log(`[Move ${moveNum}] voronoi fallback: path=${!!voronoiResult} reproduces=${vReproduces}`);
        if (vReproduces) return Promise.resolve(voronoiResult!.pts);
      } else if (DEBUG.recreate) {
        console.log(`[Move ${moveNum}] voronoi fallback: buildSubregionHighlight returned null`);
      }
    }

    // Final fallback for self-loop enclosures: use findVoronoiPath with v1=v2 to
    // produce a closed loop via the full Voronoi graph (with clustering fix).
    if (parsed.brackets && parsed.brackets.length > 0 && parsed.lo === parsed.hi) {
      const sh = buildSubregionHighlight(state, parsed.lo, parsed.hi, parsed.brackets);
      if (sh) {
        const vData = buildVoronoiGraph(state, sh, parsed.lo, parsed.hi);
        const { extraSeeds } = vData;
        const vPos = state.vertices.get(parsed.lo)?.pos;
        const voronoiResult = computeJunctionVoronoiPath(vData, vPos, vPos);
        const vReproduces = voronoiResult ? strokeReproduces(state, parsed, voronoiResult.pts, recreateUseLabels) : false;
        if (DEBUG.recreate) console.log(`[Move ${moveNum}] self-loop voronoi path: path=${!!voronoiResult} extraSeeds=${extraSeeds.length} reproduces=${vReproduces}`);
        if (vReproduces) return Promise.resolve(voronoiResult!.pts);
        // Also try with extra seeds in the voronoiSelfLoopArcs.
        if (extraSeeds.length > 0) {
          const newCandidates = candidateSelfLoopArcsWithSeeds(state, parsed, extraSeeds);
          for (const stroke of newCandidates) {
            if (strokeReproduces(state, parsed, stroke, recreateUseLabels)) return Promise.resolve(stroke);
          }
          if (DEBUG.recreate) console.log(`[Move ${moveNum}] self-loop voronoi fallback: none reproduced`);
        }
      }
    }

    if (DEBUG.recreate) console.log(`[Move ${moveNum}] all fallbacks exhausted → going manual`);
    return Promise.resolve(null);
  }

  // Pause mode: show all candidates and wait for Enter.
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
    manualAwait = null;
    manualHints = null;
    subregionHighlight = null;
  proposedArc = null;
    hideBanner();
    resolve(true);
  } else {
    // Wrong move: roll it back and ask again.
    undoLast();
    const loop = manualAwait.parsed.lo === manualAwait.parsed.hi ? ' (self-loop)' : '';
    showBanner(`That move didn't match. Draw ${manualAwait.parsed.lo} → ${manualAwait.parsed.hi}${loop} again`);
  }
}

/** Drive the whole sequence move by move. */
async function runRecreate(seq: ReturnType<typeof parseMoveSequence>): Promise<void> {
  resetGame(seq.spots);
  recreateActive = true;
  recreateUseLabels = seq.useLabels;
  try {
    for (let i = 0; i < seq.moves.length; i++) {
      const rawMove = seq.moves[i];
      // Labelled sequences carry spot LABELS in lo/hi/brackets; resolve to raw
      // vertex IDs against the live label state (in lockstep with the
      // recording) before anything downstream touches state.vertices by ID.
      // A bracket range ("lo..hi") names a whole block of mutually-symmetric
      // enclosed spots — resolveBracketEntry expands it to every live member.
      // Brackets describe the label state AFTER this move's own departing
      // endpoint(s) have shrunk their block (see resolveMoveEndpoints'
      // contextLabels), not the state before the move.
      let parsed: ResolvedMove;
      if (recreateUseLabels) {
        const { lo, hi, contextLabels } = resolveMoveEndpoints(rawMove.lo, rawMove.hi, state.spotLabels);
        parsed = {
          ...rawMove,
          lo, hi,
          brackets: rawMove.brackets
            ? rawMove.brackets.flatMap(e => resolveBracketEntry(e, contextLabels))
            : null,
          parens: resolveParensEntry(rawMove.parens, contextLabels),
        };
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
      const stroke = await promptCandidates(parsed, i + 1);
      if (!recreateActive) return; // aborted during candidate selection
      if (stroke) {
        pushHistorySnapshot();
        applyMove(state, { v1: parsed.lo, v2: parsed.hi, stroke });
        // Double-check: the committed edge should not cross any other edge.
        const newEdge = [...state.edges.values()].reduce((a, b) => b.id > a.id ? b : a);
        if (strokeCrossesEdges(state, newEdge.points, newEdge.id, parsed.lo, parsed.hi)) {
          console.warn(`Recreate move ${i + 1}: committed edge ${newEdge.id} crosses existing geometry`);
        }
        afterMoveCommitted(parsed.lo, parsed.hi);
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
      if (seq.useCheck && rawMove.checkEncoding !== null && lastCommittedEncoding !== rawMove.checkEncoding) {
        console.error(`[Move Check] Move ${i + 1} mismatch: expected ${rawMove.checkEncoding}, got ${lastCommittedEncoding}`);
        recreateCheckFailed = true;
        return;
      }
    }
  } finally {
    recreateActive = false;
    manualAwait = null;
    manualHints = null;
    subregionHighlight = null;
  proposedArc = null;
    candidatePreviewList = null;
    candidateResolve = null;
    setPaused(false);
    hideBanner();
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
    if (i > 0) ' ⊕ '.split('').forEach(pushPunct);
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
 * provenance only survives when the compact form happens to equal the decompressed form (no
 * compression fired this frame); when compression collapses/reorders characters there's no clean
 * 1:1 mapping back to individual vertices any more, so hover is dropped for that render. Falls
 * back to the raw (non-canonical, but always-available) encodePosition() text when the module
 * isn't loaded yet (see canonSync's "load timing isn't guaranteed" note) or canonicalization
 * fails entirely.
 */
function computeLiveEncodingDisplay(state: GameState, enc: EncodingResult): { text: string; charInfo: EncodingResult['charInfo'] } {
  const decomposed = encodePositionDecompressed(state);
  const tracked = canonicalizeTrackedProvenanceSync(decomposed.text);
  // tracked.src indexes are TOKEN-sequential (one per real token, in the same
  // component/region/boundary/token walk order the engine parses `decomposed.text` into) —
  // both ends skip punctuation ('[',']','|',',',' ','⊕' on the input side; ','/'|'/'+' on the
  // output side), unlike decomposed.charInfo/tracked.enc which have one slot per character
  // including punctuation. Build a punctuation-free view of decomposed's tokens to index by
  // src, then re-expand per output character, inserting an empty entry for each separator.
  const decompLiveText = tracked ? tracked.enc : enc.text;
  const decompLiveCharInfo: EncodingResult['charInfo'] = tracked
    ? (() => {
        const decomposedTokens = decomposed.text
          .split('')
          .map((ch, i) => ({ ch, info: decomposed.charInfo[i] }))
          .filter(({ ch }) => !'[]|, ⊕'.includes(ch))
          .map(({ info }) => info);
        let next = 0;
        return decompLiveText.split('').map(ch =>
          ',|+'.includes(ch) ? { vertexIds: [] } : decomposedTokens[tracked.src[next++]],
        );
      })()
    : enc.charInfo;
  const compact = canonSync(enc.text);
  const rawLiveText = compact ?? decompLiveText;
  const rawLiveCharInfo: EncodingResult['charInfo'] = compact
    ? (compact === decompLiveText
        ? decompLiveCharInfo
        : compact.split('').map(() => ({ vertexIds: [] })))
    : decompLiveCharInfo;
  // rawLiveText only needs bracket-wrapping when it came from the WASM engine (compact or
  // tracked.enc), which emits brackets/⊕ neither for — the encodePosition() fallback already
  // has them (see the ⊕/[] delimiter key in encoding.ts).
  const needsWrap = compact !== null || tracked !== null;
  return needsWrap ? wrapCanonDisplay(rawLiveText, rawLiveCharInfo) : { text: rawLiveText, charInfo: rawLiveCharInfo };
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
      console.error('  pendingCollapse:', JSON.stringify(pendingCollapse, (k, v) => k === 'parallelEdges' || k === 'triangleEdges' || k === 'edges' || k === 'extraParallelEdges' ? v : (Array.isArray(v) ? v : v)));
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
    const collapseSkip = pendingCollapse ? collapseVertices(pendingCollapse) : undefined;
    if (smoothStep(state, shrinkCheckbox.checked, collapseSkip)) anyMoving = true;

    // Collapse dead-region scabs before eliminateIsolatedVertex so the scab vertex
    // is in livingVertexSet (protected) when the isolation check runs.
    // Skip the outer (degree-3) louse vertices only. The inner vertex is allowed to
    // self-connect if it borders a living region (true scab); louse-inner-only vertices
    // are filtered out by the bordersLiving check in scabAloneCollapse.
    const louseSkip = pendingCollapse?.kind === 'louse'
      ? new Set([...pendingCollapse.outer])
      : undefined;
    if (scabAloneCollapse(state, louseSkip)) {
      anyMoving = true;
      // If the scab collapse deleted louse outer vertices, cancel the stale louse.
      if (pendingCollapse?.kind === 'louse') {
        const lc = pendingCollapse as LouseCollapse;
        if (!state.vertices.has(lc.outer[0]) || !state.vertices.has(lc.outer[1])) {
          pendingCollapse = null;
        }
      }
      // scabAloneCollapse may have created a self-loop on a vertex whose external
      // neighbour is already dead — check for a self-connected-dead collapse now.
      if (!pendingCollapse) checkForCollapses();
    }

    if (shrinkCheckbox.checked) {
      const skipVerts = pendingCollapse ? collapseVertices(pendingCollapse) : undefined;

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
        for (const e of state.edges.values()) resampleEdge(e);
        checkForCollapses();
      }

      // Skip any component whose vertices are owned by a special-collapse animator,
      // so deadRegionStep doesn't also try to centroid-shrink those vertices.
      const { moving: deadMoving, popped, popCentroids } = deadRegionStep(state, skipVerts);
      if (deadMoving) anyMoving = true;
      if (popped) {
        logCollapse('deadRegionStep (general)');
        for (const e of state.edges.values()) resampleEdge(e);
        for (const c of popCentroids) popAnims.push({ pos: c, start: now });
        checkForCollapses();
      }
    }

    // Run any in-progress special collapse to completion even if shrink is now off.
    if (pendingCollapse) {
      anyMoving = true;
      const pc = pendingCollapse;
      if (pc.kind === 'louse') {
        const { done, popAt } = louseCollapseStep(state, pc);
        if (done) {
          logCollapse('louseCollapseStep');
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      } else if (pc.kind === 'parallel-dead') {
        const { done, popAt } = parallelDeadStep(state, pc);
        if (done) {
          logCollapse('parallelDeadStep');
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      } else if (pc.kind === 'triple-parallel-dead') {
        const { done, popAt } = tripleParallelDeadStep(state, pc);
        if (done) {
          logCollapse('tripleParallelDeadStep');
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      } else if (pc.kind === 'triangle-dead') {
        const { done, popAt } = triangleDeadStep(state, pc);
        if (done) {
          logCollapse('triangleDeadStep');
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      } else if (pc.kind === 'quad-dead') {
        const { done, popAt } = quadDeadStep(state, pc);
        if (done) {
          logCollapse('quadDeadStep');
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      } else if (pc.kind === 'enclosed-triangle') {
        const { done, popAt } = enclosedTriangleStep(state, pc);
        if (done) {
          logCollapse('enclosedTriangleStep');
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      } else if (pc.kind === 'bigon-tip') {
        const { done, popAt } = bigonTipStep(state, pc);
        if (done) {
          logCollapse('bigonTipStep');
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      } else {
        const { done, popAt } = selfConnectedDeadStep(state, pc);
        if (done) {
          logCollapse(`selfConnectedDeadStep (${pc.symmetric ? 'case B symmetric' : 'case A'})`);
          if (popAt) popAnims.push({ pos: popAt, start: now });
          for (const e of state.edges.values()) resampleEdge(e);
          pendingCollapse = null;
          checkForCollapses();
        }
      }
    }

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
        pbLiveEncoding.innerHTML = '';
        liveText.split('').forEach((ch, idx) => {
          const span = document.createElement('span');
          span.textContent = ch;
          span.dataset.idx = String(idx);
          pbLiveEncoding.appendChild(span);
        });
        // Auto-follow the live game only in Sync mode; free-browse leaves the panel where the user
        // navigated. Only re-navigate when the live position actually changed (not every frame).
        if (isSyncMode() && enc.text !== lastNotifiedLiveEnc) {
          lastNotifiedLiveEnc = enc.text;
          void notifyLivePosition(enc.text);
        }
        // Keep the back/forward arrows' enabled state in step with the game's undo/redo stacks.
        updateNavButtons();
      } else if (showPosition) {
        const { text: liveText, charInfo: liveCharInfo } = computeLiveEncodingDisplay(state, enc);
        lastCharInfo = liveCharInfo;
        bottomBarText.innerHTML = '';
        liveText.split('').forEach((ch, idx) => {
          const span = document.createElement('span');
          span.textContent = ch;
          span.dataset.idx = String(idx);
          bottomBarText.appendChild(span);
        });
        bottomBar.classList.add('visible');
      }
    }
    const playerTurn = (state.moveCount % 2 === 0 ? 1 : 2) as 1 | 2;
    renderer.render(state, camera, { ...extras, showMidpoints, showRegions, showVertexIds, showBoundaryArrows, showRegionNetwork, vertexLabels, spotLabels: spotLabelsDisplay, popAnimations: activePops, gameOver: isGameOver(), playerTurn, checkFailed: recreateCheckFailed, recreateHints: manualHints ?? undefined, candidatePreviewStrokes: candidatePreviewList ?? movePreviewFailCandidates ?? undefined, subregionHighlight: subregionHighlight ?? undefined, proposedArc: proposedArc ?? undefined, movePreviewArc: movePreviewArc ?? undefined, movePreviewFailRing: movePreviewFailRing ?? undefined, voronoiGraph: lastVoronoiGraph ?? undefined, voronoiCircumcenters: lastVoronoiCCs ?? undefined, voronoiExtraSeeds: lastVoronoiExtraSeeds ?? undefined, voronoiFullNodes: lastVoronoiFullNodes ?? undefined, voronoiSurvivingIds: lastVoronoiSurvivingIds ?? undefined, voronoiFakeCgrId: lastVoronoiFakeCgrId ?? undefined, hoverHighlight: hoverCharInfo ?? undefined, enclosureSideColors: showEnclosureSides ? lastEnclosureSideColors : undefined, enclosureCoverage: showEnclosureSides ? lastEnclosureCoverage : undefined, vertexIdLabels: canvasVertexLabels });
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
