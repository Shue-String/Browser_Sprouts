/**
 * Automated soundness sweep for the tracked-encoding path (M6 confidence item, see
 * project_encoding_canon_rework). Plays many independent random games end-to-end and checks, after
 * EVERY move, that the tracked map (engine-computed child, face-checked against live geometry) and
 * the live geometry's own encoder agree once both are pushed through the engine's canon() — i.e. a
 * second, independent proof beyond the per-move face-set check already baked into
 * TrackedGame.onMoveSettled (which only compares face structure, not the string).
 *
 * KNOWN NOT TRUSTWORTHY (as of 2026-07-16/17 sessions) — do not treat a pass or fail from this as
 * validated without re-diagnosing first. This harness drives `applyMove` standalone, bypassing the
 * real commit pipeline (no `resampleEdge`, no `commitMove`'s history/afterMoveCommitted wiring), and
 * `candidateStrokes`/`strokeCrossesEdges` here can propose self-crossing strokes that produce
 * unintended extra vertices/edges from what should be a simple move — both gaps were confirmed to
 * dominate the mismatch rate (~90%+) in prior runs, drowning out any real product-code signal. A
 * pipeline-driven rewrite (via `window.__sprouts.commitMove`) surfaced further harness races and,
 * even after fixing those, hung/stalled without completing. Fixing this harness for real is a
 * separate, open-ended undertaking, not yet attempted to completion. Confidence in the tracked path
 * instead currently rests on repeated MANUAL verification through the real UI/commitMove pipeline
 * across many distinct real move types (joins, self-loops, enclosures, nested regions, scabs, undo,
 * load) — see the M6 session notes in project_encoding_canon_rework for the specific cases checked.
 *
 * Dev-only diagnostic; not wired into any UI. Run from the browser console via a dynamic import,
 * e.g.:
 *   const { runSoundnessSweep } = await import('/src/dev/soundnessSweep.ts');
 *   await runSoundnessSweep({ games: 30, maxMovesPerGame: 12 });
 */
import type { GameState, VertexId } from '../model/types';
import { createInitialState, cloneState } from '../model/gameState';
import { applyMove } from '../model/moves';
import { candidateStrokes, strokeCrossesEdges } from '../model/strokeSynthesis';
import type { ResolvedMove } from '../model/moveCodeParse';
import { encodePosition } from '../model/encoding';
import { canon } from '../engine/stalks';
import { TrackedGame } from '../engine/trackedGame';

export interface SweepMismatch {
  game: number;
  move: number;
  reason: string;
  liveCanon?: string;
  trackedCanon?: string;
}

export interface SweepResult {
  gamesPlayed: number;
  movesPlayed: number;
  mismatches: SweepMismatch[];
}

/** Vertices with room for one more edge endpoint (join legality: degree stays <= 3). */
function eligibleVertexIds(state: GameState): VertexId[] {
  const out: VertexId[] = [];
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue;
    if (v.degree <= 2) out.push(v.id);
  }
  return out;
}

/** Vertices with room for TWO more endpoints (self-loop legality: degree stays <= 3, both
 *  stroke ends land on the same vertex). Stricter than eligibleVertexIds — degree<=2 alone
 *  would let a degree-2 vertex self-loop to degree 4, an illegal state the real UI never
 *  produces and the engine's degree<=3 model never anticipates. */
function selfLoopEligibleVertexIds(state: GameState): VertexId[] {
  const out: VertexId[] = [];
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue;
    if (v.degree <= 1) out.push(v.id);
  }
  return out;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Find a random legal (v1, v2, stroke) triple, or null if the position has no legal move left. */
function findRandomLegalMoveImpl(
  state: GameState,
): { v1: VertexId; v2: VertexId; stroke: import('../math/sphere').SpherePoint[] } | null {
  const ids = eligibleVertexIds(state);
  const selfIds = new Set(selfLoopEligibleVertexIds(state));
  const pairs: [VertexId, VertexId][] = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a < b) pairs.push([a, b]);
      else if (a === b && selfIds.has(a)) pairs.push([a, b]);
    }
  }
  for (const [v1, v2] of shuffle(pairs)) {
    const parsed: ResolvedMove = {
      token: '', checkEncoding: null, lo: v1, hi: v2, loSub: null, hiSub: null,
      parallel: false, parens: null, brackets: null,
    };
    for (const stroke of shuffle(candidateStrokes(state, parsed))) {
      if (!strokeCrossesEdges(state, stroke, undefined, v1, v2)) return { v1, v2, stroke };
    }
  }
  return null;
}

/**
 * Play `games` independent random games (each starting with a random spot count in
 * [minSpots, maxSpots]), up to `maxMovesPerGame` moves each (fewer if the position dies first),
 * checking tracked-vs-live canon agreement after every move. Returns every mismatch found (empty
 * array = fully sound over the sweep). Never throws — a mismatch is recorded, not fatal, so the
 * sweep always finishes and reports its full findings.
 */
export async function runSoundnessSweep(opts: {
  games?: number;
  maxMovesPerGame?: number;
  minSpots?: number;
  maxSpots?: number;
} = {}): Promise<SweepResult> {
  const {
    games = 20,
    maxMovesPerGame = 10,
    minSpots = 2,
    maxSpots = 5,
  } = opts;

  const mismatches: SweepMismatch[] = [];
  let movesPlayed = 0;

  for (let g = 0; g < games; g++) {
    const spots = minSpots + Math.floor(Math.random() * (maxSpots - minSpots + 1));
    const state = createInitialState(spots);
    const tracked = new TrackedGame();
    tracked.reset([...state.vertices.keys()]);

    for (let m = 0; m < maxMovesPerGame; m++) {
      const found = findRandomLegalMoveImpl(state);
      if (!found) break; // dead position — end this game early
      const { v1, v2, stroke } = found;

      const before = cloneState(state);
      try {
        applyMove(state, { v1, v2, stroke });
      } catch (e) {
        mismatches.push({ game: g, move: m, reason: `applyMove threw: ${e instanceof Error ? e.message : String(e)}` });
        break;
      }
      movesPlayed++;

      const newVertexIds = new Set<VertexId>();
      for (const [vid, v] of state.vertices) {
        if (!before.vertices.has(vid) && !v.isPseudo) newVertexIds.add(vid);
      }

      const res = await tracked.onMoveSettled(state, v1, v2, newVertexIds);
      const liveEnc = encodePosition(state).text;
      const liveCanon = await canon(liveEnc);

      if (res.status !== 'match') {
        mismatches.push({
          game: g, move: m,
          reason: `tracked status=${res.status} (engine=${res.engineKey ?? ''} geometry=${res.geometryKey ?? ''})`,
          liveCanon,
          trackedCanon: res.enc ?? undefined,
        });
        break; // desynced — no point continuing this game
      }

      const trackedCanon = await canon(res.enc ?? '');
      if (!liveCanon || !trackedCanon || liveCanon !== trackedCanon) {
        mismatches.push({ game: g, move: m, reason: 'canon(live) !== canon(tracked)', liveCanon, trackedCanon });
        break;
      }
    }
  }

  return { gamesPlayed: games, movesPlayed, mismatches };
}
