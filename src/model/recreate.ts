/**
 * Recreate orchestrator: turn a parsed target move into an actual stroke.
 *
 * Strategy (synthesize → verify): ask strokeSynthesis for ordered candidate
 * strokes, then for each one apply it to a CLONE of the live state and compare
 * the resulting computeMoveCode against the target token. The first candidate
 * that reproduces the token byte-for-byte is returned; if none do, return null
 * and let the caller fall back to manual draw.
 *
 * This keeps the geometry honest without trusting it: the move code is the same
 * canonical oracle the live game emits, so a match guarantees the recreated move
 * is topologically identical to the original.
 */

import type { GameState, VertexId, EdgeId, RegionId } from './types';
import type { SpherePoint } from '../math/sphere';
import { cloneState } from './gameState';
import { applyMove } from './moves';
import { computeMoveCode } from './moveCode';
import { recomputeSpotLabels, labelForFromMap, spotGroupForFromMap } from './vertexLabels';
import { candidateStrokes, strokeCrossesEdges } from './strokeSynthesis';
import type { ResolvedMove } from './moveCodeParse';

/**
 * Find a stroke that reproduces `parsed` in the live `state`, or null.
 * `state` is never mutated — every trial runs on a clone.
 *
 * If `checkCrossings` is set, candidates that cross existing edges (tested
 * spherically) are skipped before the (more expensive) topological verify step.
 */
export function synthesizeMove(
  state: GameState,
  parsed: ResolvedMove,
  checkCrossings = false,
  useLabels = false,
): SpherePoint[] | null {
  for (const stroke of candidateStrokes(state, parsed)) {
    if (checkCrossings && strokeCrossesEdges(state, stroke, undefined, parsed.lo, parsed.hi)) continue;
    if (strokeReproduces(state, parsed, stroke, useLabels)) return stroke;
  }
  return null;
}

/**
 * True if applying `stroke` to a clone of `state` yields exactly the target
 * token. `parsed.lo`/`parsed.hi` must already be raw vertex IDs (resolve
 * labels via resolveLabelToVertexId before calling this, when useLabels).
 * When useLabels is set, the oracle comparison re-derives the move code using
 * the label state as it would be immediately AFTER this trial move (a
 * departing spot endpoint is only fixed to a concrete number post-move) — the
 * same computation live play performs — so labelled tokens compare correctly.
 */
export function strokeReproduces(state: GameState, parsed: ResolvedMove, stroke: SpherePoint[], useLabels = false): boolean {
  const before = cloneState(state);
  const work = cloneState(state);
  try {
    applyMove(work, { v1: parsed.lo, v2: parsed.hi, stroke });
  } catch {
    return false;
  }
  let code: string;
  try {
    let labelFor: ((vid: VertexId) => VertexId) | undefined;
    let spotGroupFor: ReturnType<typeof spotGroupForFromMap> | undefined;
    if (useLabels) {
      const afterLabels = recomputeSpotLabels(before.spotLabels, before, work, parsed.lo, parsed.hi);
      labelFor = labelForFromMap(afterLabels);
      spotGroupFor = spotGroupForFromMap(afterLabels);
    }
    code = computeMoveCode(before, parsed.lo, parsed.hi, work, labelFor, spotGroupFor);
  } catch {
    return false;
  }
  return code === parsed.token;
}

// ---------------------------------------------------------------------------
// Manual-draw visual hints
// ---------------------------------------------------------------------------

/**
 * Visual overlay data for a manual-draw prompt. Consumed by the renderer to
 * draw red rings on the target vertices and blue highlights on the bracket
 * components (and the outer-boundary arc that wraps them).
 */
export interface RecreateHints {
  loId: VertexId;
  hiId: VertexId;
  /**
   * If lo is a joint in the outer boundary, the [inEdgeId, outEdgeId] for
   * the relevant visit — used to draw a partial arc instead of a full circle.
   */
  loJointEdges?: [EdgeId, EdgeId];
  /** Same for hi. */
  hiJointEdges?: [EdgeId, EdgeId];
  /** Vertices belonging to bracket sub-boundaries (blue dots). */
  bracketVertexIds: Set<VertexId>;
  /** Edges belonging to bracket sub-boundaries (blue lines). */
  bracketEdgeIds: Set<EdgeId>;
  /**
   * Edges of the outer boundary component that lie on the same arc as the
   * bracket components — i.e. the arc from lo to hi that the stroke should
   * bow toward. Blue lines, same shade as bracket edges.
   */
  arcEdgeIds: Set<EdgeId>;
  /** Region that the arc edges bound on the bracket side — used to offset the highlight to the correct side. */
  arcRegionId?: RegionId;
}

/**
 * Compute visual hints for a manual-draw prompt. Always identifies whether
 * lo/hi are joints and records the boundary-walk edges for arc rendering.
 * For enclosure moves also computes bracket sub-boundary geometry and the
 * relevant outer-boundary arc.
 */
export function computeRecreateHints(state: GameState, parsed: ResolvedMove): RecreateHints {
  const hints: RecreateHints = {
    loId: parsed.lo,
    hiId: parsed.hi,
    bracketVertexIds: new Set(),
    bracketEdgeIds: new Set(),
    arcEdgeIds: new Set(),
  };

  // Find the living region whose boundary component contains both lo and hi.
  let outerComp: { entries: { vertexId: VertexId; side: string; edgeId?: EdgeId }[] } | null = null;
  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    for (const b of r.boundaries) {
      const ids = new Set(b.entries.map(e => e.vertexId));
      if (parsed.lo === parsed.hi ? ids.has(parsed.lo) : ids.has(parsed.lo) && ids.has(parsed.hi)) {
        outerComp = b;
        break;
      }
    }
    if (outerComp) break;
  }

  if (!outerComp) return hints;

  const entries = outerComp.entries;
  const N = entries.length;
  const iLo = findOccurrence(entries, parsed.lo, parsed.loSub, N);
  const iHi = parsed.lo === parsed.hi ? -1 : findOccurrence(entries, parsed.hi, parsed.hiSub, N);

  // Joint check: if side !== 'only', record the in/out edge pair for that visit.
  if (iLo >= 0 && entries[iLo].side !== 'only') {
    const inEid  = entries[(iLo - 1 + N) % N].edgeId;
    const outEid = entries[iLo].edgeId;
    if (inEid != null && outEid != null) hints.loJointEdges = [inEid, outEid];
  }
  if (iHi >= 0 && entries[iHi].side !== 'only') {
    const inEid  = entries[(iHi - 1 + N) % N].edgeId;
    const outEid = entries[iHi].edgeId;
    if (inEid != null && outEid != null) hints.hiJointEdges = [inEid, outEid];
  }

  // Bracket geometry (enclosure moves only).
  if (!parsed.brackets || parsed.brackets.length === 0) return hints;

  const bracketMins = new Set(parsed.brackets);

  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    // Re-find this region's outer component to attach bracket subs to it.
    let comp: typeof r.boundaries[0] | null = null;
    for (const b of r.boundaries) {
      const ids = new Set(b.entries.map(e => e.vertexId));
      if (parsed.lo === parsed.hi ? ids.has(parsed.lo) : ids.has(parsed.lo) && ids.has(parsed.hi)) {
        comp = b; break;
      }
    }
    if (!comp) continue;

    const localVertexIds = new Set<VertexId>();
    const localEdgeIds = new Set<EdgeId>();
    for (const sub of r.boundaries) {
      if (sub === comp) continue;
      const minId = Math.min(...sub.entries.map(e => e.vertexId));
      if (!bracketMins.has(minId)) continue;
      for (const e of sub.entries) {
        localVertexIds.add(e.vertexId);
        if (e.edgeId != null) localEdgeIds.add(e.edgeId);
      }
    }
    // lo/hi border two regions (one on each side of the connecting arc); the
    // bracket components only live as sub-boundaries in one of them. If this
    // region doesn't have them, try the region on the other side.
    if (localVertexIds.size === 0) continue;
    hints.bracketVertexIds = localVertexIds;
    hints.bracketEdgeIds = localEdgeIds;

    // Split outer boundary at lo/hi: highlight the canonical lo→hi arc (the
    // same direction used for the move-code brackets, walking forward from
    // the lower vertex ID to the higher one — even if that's the long way
    // around), not whichever side happens to sit nearer the bracket centroid.
    if (iLo >= 0 && iHi >= 0 && iLo !== iHi) {
      const compEntries = comp.entries;
      const M = compEntries.length;
      const cLo = findOccurrence(compEntries, parsed.lo, parsed.loSub, M);
      const cHi = findOccurrence(compEntries, parsed.hi, parsed.hiSub, M);
      if (cLo >= 0 && cHi >= 0 && cLo !== cHi) {
        const arc = new Set<EdgeId>();
        for (let i = cLo; i !== cHi; i = (i + 1) % M) {
          const e = compEntries[i];
          if (e.edgeId != null) arc.add(e.edgeId);
        }
        hints.arcEdgeIds = arc;
        hints.arcRegionId = r.id;
      }
    }
    break;
  }

  return hints;
}

/**
 * Find the index of `vid` in `entries` using the subscript to pick the correct
 * occurrence for joint vertices. The subscript `sub` means "the occurrence where
 * the next entry has vertexId === sub." Falls back to findIndex when sub is null
 * or no subscript match is found.
 */
function findOccurrence(
  entries: { vertexId: VertexId }[],
  vid: VertexId,
  sub: VertexId | null,
  n: number,
): number {
  if (sub !== null) {
    for (let i = 0; i < n; i++) {
      if (entries[i].vertexId === vid && entries[(i + 1) % n].vertexId === sub) return i;
    }
  }
  return entries.findIndex(e => e.vertexId === vid);
}

/**
 * Verify a move that has ALREADY been applied (e.g. drawn by hand during the
 * manual-draw fallback). `before` is the pre-move snapshot, `after` the live
 * post-move state. Returns whether it matches the target token.
 */
export function appliedMoveMatches(
  before: GameState,
  after: GameState,
  v1: VertexId,
  v2: VertexId,
  token: string,
  useLabels = false,
): boolean {
  try {
    let labelFor: ((vid: VertexId) => VertexId) | undefined;
    let spotGroupFor: ReturnType<typeof spotGroupForFromMap> | undefined;
    if (useLabels) {
      const afterLabels = recomputeSpotLabels(before.spotLabels, before, after, v1, v2);
      labelFor = labelForFromMap(afterLabels);
      spotGroupFor = spotGroupForFromMap(afterLabels);
    }
    return computeMoveCode(before, v1, v2, after, labelFor, spotGroupFor) === token;
  } catch {
    return false;
  }
}
