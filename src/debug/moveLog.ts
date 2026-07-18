/**
 * Debug instrumentation for region determination.
 *
 * applyMove() records a structured entry per move: a snapshot of the region
 * structure before and after, plus a trace of the recomputation (region /
 * subposition / face-cycle counts from the rotation-system pass).
 *
 * The log is exposed on `window.__sprouts.moveLog` for inspection via the
 * console or the preview eval tool. It is a pure debugging aid with no effect
 * on game logic.
 */

import type { GameState } from '../model/types';

export interface RegionSnapshot {
  id: number;
  isOuter: boolean;
  isDead: boolean;
  /** Each boundary component as "vid:side" entries. */
  boundaries: string[][];
}

/** Full graph snapshot for diffing "good" vs "bad" outcomes of nominally the same move. */
export interface GraphSnapshot {
  edges: { id: number; v1: number; v2: number; leftRegion: number; rightRegion: number }[];
  vertices: { id: number; isPseudo: boolean; degree: number }[];
  subpositions: number[][];    // each entry: the region ids in that subposition
  encoding: string;
}

export interface MoveLogEntry {
  index: number;
  move: { v1: number; v2: number; isLoop: boolean };
  path: string;                 // code path tag; always 'recompute' under the rotation-system model
  trace: string[];              // ordered decision log
  before: RegionSnapshot[];     // living regions before the move
  after: RegionSnapshot[];      // living regions after the move
  graphAfter?: GraphSnapshot;   // full post-move graph, for cross-run diffing
}

export const moveLog: MoveLogEntry[] = [];

let activeTrace: string[] = [];

/** Append a line to the trace of the move currently being applied. */
export function trace(msg: string): void {
  activeTrace.push(msg);
}

/** Begin a fresh trace buffer (called at the start of applyMove). */
export function beginTrace(): void {
  activeTrace = [];
}

/** Snapshot all living regions in a serializable form. */
export function snapshotRegions(state: GameState): RegionSnapshot[] {
  const out: RegionSnapshot[] = [];
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    out.push({
      id: r.id,
      isOuter: r.isOuter,
      isDead: r.isDead,
      boundaries: r.boundaries.map(b => b.entries.map(e => `${e.vertexId}:${e.side}`)),
    });
  }
  return out;
}

/** Snapshot the full post-move graph — edges, vertices, subpositions, encoding. */
export function snapshotGraph(state: GameState, encoding: string): GraphSnapshot {
  return {
    edges: [...state.edges.values()].map(e => ({
      id: e.id, v1: e.v1, v2: e.v2, leftRegion: e.leftRegion, rightRegion: e.rightRegion,
    })),
    vertices: [...state.vertices.values()].map(v => ({
      id: v.id, isPseudo: !!v.isPseudo, degree: v.degree,
    })),
    subpositions: state.subpositions.map(s => [...s.regionIds]),
    encoding,
  };
}

/** Record a completed move. */
export function recordMove(
  state: GameState,
  move: { v1: number; v2: number; isLoop: boolean },
  path: string,
  before: RegionSnapshot[],
  encoding?: string,
): void {
  moveLog.push({
    index: moveLog.length,
    move,
    path,
    trace: activeTrace,
    before,
    after: snapshotRegions(state),
    graphAfter: encoding !== undefined ? snapshotGraph(state, encoding) : undefined,
  });
}
