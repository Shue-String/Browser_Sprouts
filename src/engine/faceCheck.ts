/**
 * Face-set topology check (milestone M4 of the encoding/canon rework — see
 * project_encoding_canon_rework).
 *
 * The rework makes the engine authoritative for the encoding and demotes live geometry to a
 * CHECKER. This module is the check: the engine's decompressed child (via the occurrence map) and
 * the live embedding (via recomputeRegions) both yield the faces of the same rotation system over
 * the SAME live VertexIds, so they can be compared directly with no graph isomorphism / relabeling
 * — a match iff the two face collections agree as cyclic vertex-sequences up to rotation and
 * reflection. It never invokes canon/compression, so it cannot reintroduce the TS-canonicalizer
 * drift the rework is retiring. On mismatch the caller freezes + paints the board maroon (reusing
 * the recreate-check maroon); it does NOT roll back — the wrong geometry stays visible for
 * inspection.
 *
 * REFLECTION IS PER-FACE, NOT GLOBAL. The engine canonicalizes each region's chirality
 * independently (moves.cpp normalizeRegion mirrors a region to its lex-least form), so the stored
 * winding of one engine face can be flipped relative to geometry while another is not. So a face
 * matches under rotation of each boundary plus an all-or-nothing reflection of that face's whole
 * boundary set together (never per-boundary independently, which would be too loose).
 *
 * CONTRACT (see Catch B). Run this only after the position has settled: after a move completes,
 * after ALL pop animation is quiescent, and after a drag ends — never mid-animation. Dead structure
 * is excluded on both sides: the engine's cleanup drops fully-dead regions from the encoding, so
 * geometry's dead regions (r.isDead) and pseudo-vertices are filtered out here to match.
 */
import type { OccurrenceMap } from './occurrenceMap';
import type { GameState, VertexId } from '../model/types';
import { VertexType } from '../model/types';
import { classifyVertexFull } from '../model/encoding';

/** One boundary walk of a face, as the cyclic sequence of VertexIds along it (a joint appears
 *  twice; pseudo-vertices are excluded). Direction as given by the source. */
export type FaceCycle = VertexId[];
/** One face (region): the multiset of its boundary cycles (a face may have several — holes). */
export type Face = FaceCycle[];

/** Lexicographically-least rotation of a cyclic sequence, direction preserved. Distinguishes the
 *  two winding directions of a boundary (reflection is applied separately, at the face level). */
function cycleKey(seq: readonly VertexId[]): string {
  const n = seq.length;
  if (n === 0) return '';
  let best: string | null = null;
  for (let s = 0; s < n; s++) {
    let rot = '';
    for (let k = 0; k < n; k++) rot += (k ? ',' : '') + seq[(s + k) % n];
    if (best === null || rot < best) best = rot;
  }
  return best!;
}

/** Canonical key for a face: the smaller of (all boundaries forward) and (all boundaries reflected
 *  together), each as the sorted multiset of per-boundary cycle keys. */
function faceKey(face: Face): string {
  const fwd = face.map(b => cycleKey(b)).sort();
  const rev = face.map(b => cycleKey([...b].reverse())).sort();
  const fk = JSON.stringify(fwd);
  const rk = JSON.stringify(rev);
  return fk < rk ? fk : rk;
}

/** Order-independent key for a whole face collection: the sorted multiset of face keys. Two face
 *  sets are topologically equal iff their keys are equal. */
export function faceSetKey(faces: Face[]): string {
  return JSON.stringify(faces.map(faceKey).sort());
}

/**
 * The faces of the engine's current position, as VertexId cycles, read off the occurrence map. Each
 * engine region is one face; each of its boundaries maps token-by-token to the live vertex that
 * token belongs to (occurrence map's OccId -> VertexId). A dead (φ) component contributes nothing.
 */
export function engineFaces(map: OccurrenceMap): Face[] {
  const faces: Face[] = [];
  for (let c = 0; c < map.posSrc.length; c++) {
    for (let r = 0; r < map.posSrc[c].length; r++) {
      const face: Face = [];
      for (let b = 0; b < map.posSrc[c][r].length; b++) {
        const cycle: FaceCycle = [];
        for (const occ of map.posSrc[c][r][b]) {
          const vid = map.vertexOf.get(occ);
          if (vid !== undefined) cycle.push(vid);
        }
        if (cycle.length > 0) face.push(cycle);
      }
      if (face.length > 0) faces.push(face);
    }
  }
  return faces;
}

/**
 * The faces of the live embedding, as VertexId cycles, from recomputed regions. This must mirror
 * the encoder's token emission exactly (encoding.ts serialize), since the engine faces are read off
 * that encoding: a boundary cycle contains one VertexId per emitted TOKEN, not per boundary entry.
 * So, like the encoder, we: skip dead regions; skip pseudo-vertices; emit no vertex for a Dead
 * vertex (a degree-3 junction or isolated degree-2 — it carries no token, e.g. a self-loop base);
 * and emit a Scab only on its first visit (a distal appears twice in the walk but is one token).
 * Spots/appendages/joints/membranes emit on every visit, so a joint contributes its VertexId twice.
 * Assumes recomputeRegions has run (state.regions is current).
 */
export function geometryFaces(state: GameState): Face[] {
  // classifyVertexFull, not the stored v.type — the latter is only a cached approximation
  // (see encoding.ts's own doc comment on classifyVertexFull) that can go stale relative to
  // the CURRENT region structure. The encoder always reclassifies fresh, so this check must
  // too, or it can double-count/drop a vertex the encoder itself handles correctly (found via
  // the M6 soundness sweep, project_encoding_canon_rework).
  const types = new Map<VertexId, VertexType>();
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue;
    types.set(v.id, classifyVertexFull(v.id, state));
  }

  const faces: Face[] = [];
  for (const region of state.regions.values()) {
    if (region.isDead) continue;
    const emittedScabs = new Set<VertexId>(); // per region, like the encoder
    const face: Face = [];
    for (const boundary of region.boundaries) {
      const cycle: FaceCycle = [];
      for (const entry of boundary.entries) {
        const v = state.vertices.get(entry.vertexId);
        if (!v || v.isPseudo) continue;
        const vtype = types.get(entry.vertexId) ?? VertexType.Dead;
        if (vtype === VertexType.Dead) continue; // no token — junction/self-loop base
        if (vtype === VertexType.Scab) {
          if (emittedScabs.has(v.id)) continue; // distal: one token for its two visits
          emittedScabs.add(v.id);
        }
        cycle.push(entry.vertexId);
      }
      if (cycle.length > 0) face.push(cycle);
    }
    if (face.length > 0) faces.push(face);
  }
  return faces;
}

export interface FaceCheckResult {
  ok: boolean;
  engineKey: string;
  geometryKey: string;
}

/**
 * Compare the engine's believed faces against the live geometry's faces. `ok` is true iff they
 * match up to rotation + per-face reflection. The two keys are returned for diagnostics (the M5
 * error panel can show believed vs actual).
 */
export function checkTopology(map: OccurrenceMap, state: GameState): FaceCheckResult {
  const engineKey = faceSetKey(engineFaces(map));
  const geometryKey = faceSetKey(geometryFaces(state));
  return { ok: engineKey === geometryKey, engineKey, geometryKey };
}
