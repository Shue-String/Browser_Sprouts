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
import { computeMoveCode, compWithBoth, findOccurrence, inBrackets } from './moveCode';
import { recomputeSpotLabels, labelForFromMap, spotGroupForFromMap } from './vertexLabels';
import { candidateStrokeStream, strokeCrossesEdges } from './strokeSynthesis';
import type { ResolvedMove } from './moveCodeParse';

/**
 * Try a stroke: the position it produces, on a clone of `state` — or null when the stroke crosses
 * an existing edge (never a legal move) or the move fails to apply. `state` is never mutated. The
 * one primitive behind every "try a stroke, check the result" loop (strokeReproduces here, the
 * Position Browser's canon checks in main.ts).
 */
export function applyTrial(state: GameState, v1: VertexId, v2: VertexId, stroke: SpherePoint[]): GameState | null {
  if (strokeCrossesEdges(state, stroke)) return null;
  const trial = cloneState(state);
  try {
    applyMove(trial, { v1, v2, stroke });
  } catch {
    return null;
  }
  return trial;
}

/** The first candidate stroke that reproduces `parsed` in `state` (see strokeReproduces), or null. */
export function synthesizeMove(state: GameState, parsed: ResolvedMove, useLabels = false): SpherePoint[] | null {
  for (const stroke of candidateStrokeStream(state, parsed)) {
    if (strokeReproduces(state, parsed, stroke, useLabels)) return stroke;
  }
  return null;
}

/**
 * True if `stroke` is legal (applyTrial) and the move it makes records exactly as the target
 * token (appliedMoveMatches). `parsed.lo`/`parsed.hi` must already be raw vertex IDs (resolve
 * labels via resolveLabelToVertexId before calling this, when useLabels).
 */
export function strokeReproduces(state: GameState, parsed: ResolvedMove, stroke: SpherePoint[], useLabels = false): boolean {
  const trial = applyTrial(state, parsed.lo, parsed.hi, stroke);
  return trial !== null && appliedMoveMatches(state, trial, parsed.lo, parsed.hi, parsed.token, useLabels);
}

/**
 * True if the move (before -> after) records as `token`. A self-loop at a bare spot splits its
 * face into two interchangeable faces and the recorded bracket depends on which one the region
 * ordering lists first (stroke direction), so it matches if EITHER side's bracket does. Not at an
 * appendage tip: there the tail sits in one face, the two sides are different positions, and the
 * bracket always names the face bounded by the loop alone (see findEnclosedSideRegion).
 */
function moveCodeMatches(
  before: GameState,
  after: GameState,
  lo: VertexId,
  hi: VertexId,
  token: string,
  labelFor?: (vid: VertexId) => VertexId,
  spotGroupFor?: ReturnType<typeof spotGroupForFromMap>,
): boolean {
  if (computeMoveCode(before, lo, hi, after, labelFor, spotGroupFor) === token) return true;
  return lo === hi && (before.vertices.get(lo)?.degree ?? 0) === 0
    && computeMoveCode(before, lo, hi, after, labelFor, spotGroupFor, true) === token;
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

  // The living region whose boundary component contains both lo and hi.
  let outerComp: { entries: { vertexId: VertexId; side: string; edgeId?: EdgeId }[] } | null = null;
  for (const r of state.regions.values()) {
    if (!r.isDead && (outerComp = compWithBoth(r, parsed.lo, parsed.hi))) break;
  }

  if (!outerComp) return hints;

  const entries = outerComp.entries;
  const N = entries.length;
  const iLo = findOccurrence(entries, parsed.lo, parsed.loSub);
  const iHi = parsed.lo === parsed.hi ? -1 : findOccurrence(entries, parsed.hi, parsed.hiSub);

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

  const bracketSet = new Set(parsed.brackets);

  for (const r of state.regions.values()) {
    if (r.isDead) continue;
    // Re-find this region's outer component to attach bracket subs to it.
    const comp = compWithBoth(r, parsed.lo, parsed.hi);
    if (!comp) continue;

    const localVertexIds = new Set<VertexId>();
    const localEdgeIds = new Set<EdgeId>();
    for (const sub of r.boundaries) {
      if (sub === comp || !inBrackets(sub, state, bracketSet)) continue;
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
      const cLo = findOccurrence(compEntries, parsed.lo, parsed.loSub);
      const cHi = findOccurrence(compEntries, parsed.hi, parsed.hiSub);
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
    return moveCodeMatches(before, after, v1, v2, token, labelFor, spotGroupFor);
  } catch {
    return false;
  }
}
