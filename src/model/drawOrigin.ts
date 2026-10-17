import { classifyVertexFull, encodePosition } from './encoding';
import { VertexType } from './types';
import type { GameState, VertexId } from './types';

/**
 * Which end an automatically-made move's edge is animated from. Lower rank draws first:
 * appendage, spot, decayed scab, membrane, joint, distal scab. Every vertex inside a compressed
 * notation (3/4/5/6, ~5) counts as a membrane except a DisaPoint's interior scab (~3), which ranks
 * as whichever scab it is. Ties keep v1.
 */
enum DrawRank { Appendage, Spot, DecayedScab, Membrane, Joint, DistalScab, Other }

/** The endpoint to start the draw from (`v1` or `v2`). */
export function drawOriginVertex(state: GameState, v1: VertexId, v2: VertexId): VertexId {
  if (v1 === v2) return v1;
  const syms = encodePosition(state).vertexSymbols;
  const s1 = syms.get(v1), s2 = syms.get(v2);
  // A move through a DisaPoint's interior joins its membrane to its scab: the scab's only living
  // face is that interior, so a '3' paired with a '~3' is always that case. Membrane first.
  if (s1 === '3' && s2 === '~3') return v1;
  if (s2 === '3' && s1 === '~3') return v2;
  return rankOf(state, v2, s2) < rankOf(state, v1, s1) ? v2 : v1;
}

function rankOf(state: GameState, vid: VertexId, sym: string | undefined): DrawRank {
  if (sym !== undefined && sym !== '~3' && /^~?[3-6]$/.test(sym)) return DrawRank.Membrane;
  switch (classifyVertexFull(vid, state)) {
    case VertexType.Appendage: return DrawRank.Appendage;
    case VertexType.Spot:      return DrawRank.Spot;
    case VertexType.Membrane:  return DrawRank.Membrane;
    case VertexType.Joint:     return DrawRank.Joint;
    case VertexType.Scab:      return isDistal(state, vid) ? DrawRank.DistalScab : DrawRank.DecayedScab;
    default:                   return DrawRank.Other;
  }
}

/** A distal scab is a joint-shaped scab: it appears twice in one living face's boundary walk
 *  (classifyVertexFull's joint branch). A decayed scab borders two faces, one of them dead. */
function isDistal(state: GameState, vid: VertexId): boolean {
  for (const region of state.regions.values()) {
    if (region.isDead) continue;
    for (const boundary of region.boundaries) {
      let n = 0;
      for (const e of boundary.entries) if (e.vertexId === vid && ++n >= 2) return true;
    }
  }
  return false;
}
