/**
 * Builds the move-sequence code string for a single committed move.
 *
 * Format:
 *   loXhi             — merge OR split where v1/v2 are not membranes sharing
 *                       the same "other" region (no disambiguation needed).
 *                       [s,…] bracket is still appended for enclosures.
 *   loXhi[]           — split into a parallel-arc region with no other vertices.
 *   loXhi[s,…]        — split; v1/v2 not both same-side membranes.
 *   loXhi(m)[s,…]     — split; both v1 and v2 are membranes spanning the same
 *                       two regions.  m = lowest vertex in the move region that
 *                       is NOT also a same-side membrane; () if none exist.
 *                       s,… = min vertex of each sub-boundary on the lo→hi arc side.
 *
 * Joint subscripts:
 *   If an endpoint vertex is a joint (appears ≥2 times on a single boundary),
 *   a subscript "_n" is appended to that vertex ID in the notation, where n is
 *   the next vertex along the boundary after the connected occurrence.
 *   Example: 4_5 means "vertex 4, the occurrence after which vertex 5 follows."
 *   Self-loop joints: both subscripts are included, sorted ascending.
 *
 * lo = min(v1,v2), hi = max(v1,v2).  Moves are joined with "/" in main.ts.
 */

import type { GameState, VertexId, Region, Boundary, SpotGroupInfo } from './types';
import { VertexType } from './types';
import { classifyVertexFull } from './encoding';
import type { SpherePoint } from '../math/sphere';
import { pointInPolygon } from '../math/intersect';
import { polyFromEntries, makeSafeProjection } from './moves';

export function computeMoveCode(
  before: GameState,
  v1: VertexId,
  v2: VertexId,
  after: GameState,
  labelFor?: (vid: VertexId) => VertexId,
  spotGroupFor?: (vid: VertexId) => SpotGroupInfo | null,
): string {
  const disp = labelFor ?? ((vid: VertexId) => vid);
  // lo/hi ordering must be decided by the DISPLAYED value (label), not the raw
  // vertex id, whenever labels are in play: a spot's raw id is a creation-time
  // artifact independent of its play-order label, so two topologically-
  // equivalent replays can resolve the "same" labelled endpoint to physical
  // vertices whose raw ids sit in the opposite relative order — which would
  // flip which one prints first (and is treated as "lo" for bracket/enclosure
  // purposes) unless the ordering itself is computed from the invariant label.
  // Falls back to raw min/max when no labelFor/spotGroupFor is supplied
  // (unlabelled recording), matching the old behaviour exactly.
  const sortKeyOf = (vid: VertexId): number => spotGroupFor?.(vid)?.sortKey ?? disp(vid);
  const [lo, hi] = sortKeyOf(v1) <= sortKeyOf(v2) ? [v1, v2] : [v2, v1];

  // Find W: the new midpoint vertex created by this move (skip pseudo-vertices).
  const w = findNewVertex(before, after);

  // Compute joint subscripts. For non-self-loop: in the two new face boundaries
  // containing W, the one with sequence [W, v1, sub] gives sub1, [W, v2, sub] gives sub2.
  // For self-loop (v1===v2): both new boundaries have [W, v, sub]; collect both and sort.
  let sub1: VertexId | null = null;
  let sub2: VertexId | null = null;
  if (w !== null) {
    if (v1 === v2) {
      if (isJoint(v1, before)) {
        const subs = selfLoopJointSubs(v1, w, after);
        sub1 = subs[0];
        sub2 = subs[1];
      }
    } else {
      sub1 = isJoint(v1, before) ? jointSub(v1, w, after) : null;
      sub2 = isJoint(v2, before) ? jointSub(v2, w, after) : null;
    }
  }

  const [loSub, hiSub] = lo === v1 ? [sub1, sub2] : [sub2, sub1];
  // References to a single vertex (lo/hi/subs/m) can land on a still-live,
  // still-symmetric spot (not yet departed) as well as a formerly-spot
  // (now-fixed) vertex. Two topologically-equivalent replays of a symmetric
  // position can legitimately pick a different specific raw vertex for an
  // interchangeable spot, so the token must display something invariant to
  // that choice: the spot's group text (its range, or its fixed value) via
  // spotGroupFor, falling back to disp()/raw id for non-spot vertices.
  // Internal boundary-pattern matching below still uses the RAW loSub/hiSub.
  const dispText = (vid: VertexId): string => spotGroupFor?.(vid)?.text ?? String(disp(vid));
  const loStr = loSub !== null ? `${dispText(lo)}_${dispText(loSub)}` : `${dispText(lo)}`;
  const hiStr = hiSub !== null ? `${dispText(hi)}_${dispText(hiSub)}` : `${dispText(hi)}`;
  const base = `${loStr}X${hiStr}`;

  // A split adds exactly one region; a merge leaves the count unchanged.
  const isSplit = after.regions.size > before.regions.size;
  if (!isSplit) return base;

  const found = findMoveRegion(before, after, lo, hi, w);
  if (!found) return base;
  const { regionR, mainComp } = found;

  // All vertices in R excluding lo and hi. Pseudo-vertices are synthetic
  // rendering artifacts for curved parallel-edge geometry (see the
  // pseudo-vertex system) — not real combinatorial structure, so they must
  // never be nameable in the token (mirrors encoding.ts's availableCount,
  // which skips isPseudo for the same reason).
  const otherVerts = new Set<VertexId>();
  for (const b of regionR.boundaries)
    for (const e of b.entries)
      if (e.vertexId !== lo && e.vertexId !== hi && !before.vertices.get(e.vertexId)?.isPseudo) otherVerts.add(e.vertexId);

  // [] case: only lo and hi exist in this region (parallel-arc lens, nothing inside).
  if (otherVerts.size === 0) return `${base}[]`;

  // Always build the [s,…] bracket for enclosures.
  const brackets = buildBrackets(regionR, mainComp, lo, hi, before, after, loSub, hiSub, spotGroupFor, disp);

  // The (m) prefix is only needed when both lo and hi are membranes sharing the
  // same "other" region — i.e. they together span exactly two regions, and we
  // need m to identify which of those two regions the move was made in.
  const loOther = otherRegionId(lo, regionR, before);
  const hiOther = otherRegionId(hi, regionR, before);
  const needsParens = loOther !== null && hiOther !== null && loOther === hiOther;

  if (!needsParens) return `${base}${brackets}`;

  // Find all "same-side membranes": vertices in R that are also membranes
  // spanning exactly (regionR, loOther).
  const sameSideMems = new Set<VertexId>();
  for (const b of regionR.boundaries)
    for (const e of b.entries) {
      const other = otherRegionId(e.vertexId, regionR, before);
      if (other !== null && other === loOther) sameSideMems.add(e.vertexId);
    }

  // m = lowest vertex in R (excluding lo, hi) that is NOT a same-side membrane.
  // Invisible vertices (classified Dead — no token emitted by the encoder,
  // e.g. a degree-2 vertex whose "other side" region has no live content)
  // can satisfy the region-count test otherRegionId uses for "membrane" even
  // though they're not actually nameable; exclude them outright rather than
  // let them fall through into an ordinary (non-membrane) candidate.
  const candidates: VertexId[] = [];
  for (const vid of otherVerts)
    if (!sameSideMems.has(vid) && classifyVertexFull(vid, before) !== VertexType.Dead) candidates.push(vid);

  // Selection ("lowest") is a structural/raw-id concept; only the displayed
  // text substitutes through spotGroupFor/disp() — m can be a still-live spot
  // (range text) or a formerly-spot, now-fixed vertex (its fixed number).
  const mStr = candidates.length === 0
    ? '()'
    : `(${dispText(Math.min(...candidates))})`;

  return `${base}${mStr}${brackets}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the [s,…] bracket string for an enclosure.
 * Lists the min vertex of each non-spot sub-boundary of regionR that ended up
 * on the lo→hi arc side of the split, plus (when spotGroupFor is supplied) one
 * compact entry per distinct label block among any enclosed spot
 * sub-boundaries — e.g. "-5..-3" instead of listing three spots individually.
 */
function buildBrackets(
  regionR: Region,
  mainComp: Boundary,
  lo: VertexId,
  hi: VertexId,
  before: GameState,
  after: GameState,
  loSub: VertexId | null,
  hiSub: VertexId | null,
  spotGroupFor?: (vid: VertexId) => SpotGroupInfo | null,
  labelFor?: (vid: VertexId) => VertexId,
): string {
  const disp = labelFor ?? ((vid: VertexId) => vid);
  const subBounds = regionR.boundaries.filter(b => b !== mainComp);
  if (subBounds.length === 0) return '[]';

  const loToHiReg = findEnclosedSideRegion(regionR, mainComp, lo, hi, before, after, loSub, hiSub);
  if (!loToHiReg) return '[]';

  const loToHiVids = new Set<VertexId>();
  for (const b of loToHiReg.boundaries)
    for (const e of b.entries) loToHiVids.add(e.vertexId);

  const entries: { sortKey: number; text: string }[] = [];
  const spotGroups = new Map<string, { sortKey: number; text: string }>();
  for (const sub of subBounds) {
    if (!sub.entries.some(e => loToHiVids.has(e.vertexId))) continue;
    // A single-entry sub-boundary is always an isolated (spot) vertex — see
    // "isolated vertices" handling in recomputeRegions (moves.ts).
    if (sub.entries.length === 1 && spotGroupFor) {
      const info = spotGroupFor(sub.entries[0].vertexId);
      if (info) {
        if (!spotGroups.has(info.key)) spotGroups.set(info.key, { sortKey: info.sortKey, text: info.text });
        continue;
      }
    }
    // Selection ("lowest") is a structural/raw-id concept; only the displayed
    // text substitutes through disp() (min can be a formerly-spot, now-fixed vertex).
    // Invisible vertices (classified Dead — no token emitted by the encoder) and
    // pseudo-vertices (synthetic parallel-edge rendering artifacts, never real
    // structure) can't stand in as the sub-boundary's representative; skip them,
    // and skip the whole sub-boundary if every entry on it is invisible.
    const visibleIds = sub.entries
      .map(e => e.vertexId)
      .filter(vid => !before.vertices.get(vid)?.isPseudo && classifyVertexFull(vid, before) !== VertexType.Dead);
    if (visibleIds.length === 0) continue;
    const min = Math.min(...visibleIds);
    entries.push({ sortKey: min, text: String(disp(min)) });
  }
  entries.push(...spotGroups.values());
  entries.sort((a, b) => a.sortKey - b.sortKey);

  // Self-loop special case: a simple closed curve on a sphere has no
  // intrinsic "inside" — the two faces it creates are interchangeable, so
  // "encloses everything else in R" and "encloses nothing" describe the same
  // move. When every other component in R ended up on the recorded side,
  // normalize to the empty bracket: that's what a trivial small loop (the
  // default/easiest candidate stroke) actually produces, so recording it
  // this way keeps the token replayable by that same natural candidate.
  if (lo === hi && subBounds.length > 0 && entries.length === subBounds.length) return '[]';

  return `[${entries.map(e => e.text).join(',')}]`;
}

/**
 * Find the new midpoint vertex created by a move (skip pseudo-vertices).
 * Present in `after` but not `before`.
 */
export function findNewVertex(before: GameState, after: GameState): VertexId | null {
  for (const v of after.vertices.values())
    if (!v.isPseudo && !before.vertices.has(v.id)) return v.id;
  return null;
}

/**
 * Find the pre-move living region R whose boundary contains both lo and hi on
 * the SAME boundary component (split, not merge), plus that boundary component.
 * When multiple candidates exist, prefer the one whose boundary vertex set
 * matches the post-move region-around-W vertex set exactly (disambiguates
 * loop moves where both the inner and outer face share the same two endpoints).
 */
export function findMoveRegion(
  before: GameState,
  after: GameState,
  lo: VertexId,
  hi: VertexId,
  w: VertexId | null = findNewVertex(before, after),
): { regionR: Region; mainComp: Boundary } | null {
  let splitVertIds: Set<VertexId> | null = null;
  if (w !== null) {
    const ids = new Set<VertexId>();
    for (const r of after.regions.values())
      if (r.boundaries.some(b => b.entries.some(e => e.vertexId === w)))
        for (const b of r.boundaries)
          for (const e of b.entries)
            if (e.vertexId !== w) ids.add(e.vertexId);
    splitVertIds = ids;
  }

  let regionR: Region | null = null;
  let mainComp: Boundary | null = null;
  for (const r of before.regions.values()) {
    if (r.isDead) continue;
    const comp = compWithBoth(r, lo, hi);
    if (comp === null) continue;
    if (splitVertIds !== null) {
      const rVerts = new Set<VertexId>();
      for (const b of r.boundaries) for (const e of b.entries) rVerts.add(e.vertexId);
      const exact = rVerts.size === splitVertIds.size && [...rVerts].every(v => splitVertIds!.has(v));
      if (exact) { regionR = r; mainComp = comp; break; }
      if (!regionR) { regionR = r; mainComp = comp; } // keep as fallback
    } else {
      regionR = r; mainComp = comp; break;
    }
  }
  return regionR && mainComp ? { regionR, mainComp } : null;
}

/**
 * Identify the arc-side (lo→hi) region of a split using joint subscripts when
 * available.
 *
 * In the rotation-system split, the two new face boundaries have the patterns:
 *   Arc-side:     ... lo, W, hi, hiSub, ...   → contains [W, hi, hiSub]
 *   Non-arc-side: ... hi, W, lo, loSub, ...   → contains [W, lo, loSub]
 *
 * Subscript-based matching is exact and immune to bridge/double-traversal
 * confusion.  Falls back to fwdVerts scoring only when no subscript is present.
 */
export function findEnclosedSideRegion(
  regionR: Region,
  mainComp: Boundary,
  lo: VertexId,
  hi: VertexId,
  before: GameState,
  after: GameState,
  loSub: VertexId | null,
  hiSub: VertexId | null,
): Region | null {
  const subBounds = regionR.boundaries.filter(b => b !== mainComp);
  const w = findNewVertex(before, after);
  if (w === null) return null;

  // The two new regions that contain w on their boundary.
  const newRegsWithW = [...after.regions.values()].filter(r =>
    r.boundaries.some(b => b.entries.some(e => e.vertexId === w)),
  );

  let loToHiReg: Region | null = null;

  if (lo === hi) {
    // Self-loop: forwardArc is meaningless. The "enclosed" side is whichever new
    // region contains vertices from the original region's sub-boundaries.
    const subVerts = new Set<VertexId>();
    for (const sub of subBounds)
      for (const e of sub.entries) subVerts.add(e.vertexId);
    for (const r of newRegsWithW) {
      if (r.boundaries.some(b => b.entries.some(e => subVerts.has(e.vertexId)))) {
        loToHiReg = r; break;
      }
    }
    if (loToHiReg === null) loToHiReg = newRegsWithW[0] ?? null;
  } else {
    if (hiSub !== null) {
      for (const r of newRegsWithW) {
        if (boundaryContainsPattern(r, w, hi, hiSub)) { loToHiReg = r; break; }
      }
    }
    if (loToHiReg === null && loSub !== null && newRegsWithW.length === 2) {
      // [W, lo, loSub] is in the non-arc-side region — take the other one.
      for (const r of newRegsWithW) {
        if (boundaryContainsPattern(r, w, lo, loSub)) {
          loToHiReg = newRegsWithW.find(rr => rr !== r) ?? null;
          break;
        }
      }
    }
    if (loToHiReg === null) {
      // Fallback: pick by overlap with forward-arc vertices (handles non-joint endpoints).
      const fwdVerts = forwardArc(mainComp, lo, hi, loSub, hiSub);
      loToHiReg = pickRegion(newRegsWithW, fwdVerts);
    }
  }
  return loToHiReg;
}

/**
 * Debug helper: for a committed split move, identify which vertices ended up
 * on which of the two newly-created regions — the exact same "enclosed
 * (arc-side)" vs "outer" distinction computeMoveCode uses to decide the
 * [s,…] bracket contents, exposed directly as two vertex-id sets instead of
 * a notation string. Returns null for a merge (no split happened) or if the
 * move region/enclosed side couldn't be resolved.
 */
function resolveEnclosureRegions(
  before: GameState,
  after: GameState,
  v1: VertexId,
  v2: VertexId,
): { arcSideReg: Region; otherSideReg: Region | null } | null {
  const isSplit = after.regions.size > before.regions.size;
  if (!isSplit) return null;

  const [lo, hi] = v1 <= v2 ? [v1, v2] : [v2, v1];
  const w = findNewVertex(before, after);
  if (w === null) return null;

  let sub1: VertexId | null = null;
  let sub2: VertexId | null = null;
  if (v1 === v2) {
    if (isJoint(v1, before)) [sub1, sub2] = selfLoopJointSubs(v1, w, after);
  } else {
    sub1 = isJoint(v1, before) ? jointSub(v1, w, after) : null;
    sub2 = isJoint(v2, before) ? jointSub(v2, w, after) : null;
  }
  const [loSub, hiSub] = lo === v1 ? [sub1, sub2] : [sub2, sub1];

  const found = findMoveRegion(before, after, lo, hi, w);
  if (!found) return null;
  const { regionR, mainComp } = found;

  const arcSideReg = findEnclosedSideRegion(regionR, mainComp, lo, hi, before, after, loSub, hiSub);
  if (!arcSideReg) return null;

  const newRegsWithW = [...after.regions.values()].filter(r =>
    r.boundaries.some(b => b.entries.some(e => e.vertexId === w)),
  );
  const otherSideReg = newRegsWithW.find(r => r !== arcSideReg) ?? null;
  return { arcSideReg, otherSideReg };
}

/**
 * Debug helper: for a committed split move, identify which vertices ended up
 * on which of the two newly-created regions — the exact same "enclosed
 * (arc-side)" vs "outer" distinction computeMoveCode uses to decide the
 * [s,…] bracket contents, exposed directly as two vertex-id sets instead of
 * a notation string. Returns null for a merge (no split happened) or if the
 * move region/enclosed side couldn't be resolved.
 */
export function computeEnclosureSideColoring(
  before: GameState,
  after: GameState,
  v1: VertexId,
  v2: VertexId,
): { arcSideVertexIds: Set<VertexId>; otherSideVertexIds: Set<VertexId> } | null {
  const resolved = resolveEnclosureRegions(before, after, v1, v2);
  if (!resolved) return null;
  const { arcSideReg, otherSideReg } = resolved;

  const vertsOf = (r: Region): Set<VertexId> => {
    const ids = new Set<VertexId>();
    for (const b of r.boundaries)
      for (const e of b.entries)
        if (!after.vertices.get(e.vertexId)?.isPseudo) ids.add(e.vertexId);
    return ids;
  };

  return {
    arcSideVertexIds: vertsOf(arcSideReg),
    otherSideVertexIds: otherSideReg ? vertsOf(otherSideReg) : new Set(),
  };
}

/**
 * Debug helper: classify a set of arbitrary sphere points (not necessarily
 * real vertices) as falling inside the arc-side region, the other new
 * region, or neither — using the SAME projection + point-in-polygon test
 * recomputeRegions/computeSpliceSlots use for real geometry, so this is a
 * literal coverage picture of the two regions' actual shapes, not an
 * approximation. Each new region's PRIMARY boundary polygon is used (holes
 * from nested sub-boundaries are ignored, matching computeSpliceSlots'
 * existing region-containment test).
 */
export function computeEnclosureCoverage(
  before: GameState,
  after: GameState,
  v1: VertexId,
  v2: VertexId,
  testPoints: SpherePoint[],
): ('arc' | 'other' | 'none')[] | null {
  const resolved = resolveEnclosureRegions(before, after, v1, v2);
  if (!resolved) return null;
  const { arcSideReg, otherSideReg } = resolved;

  const proj = makeSafeProjection(after);
  const polyOf = (r: Region): { px: number; py: number }[] => {
    const b = r.boundaries[0];
    if (!b) return [];
    return polyFromEntries(b.entries, after, proj);
  };
  const arcPoly = polyOf(arcSideReg);
  const otherPoly = otherSideReg ? polyOf(otherSideReg) : [];

  return testPoints.map(p => {
    const pp = proj(p);
    if (arcPoly.length >= 3 && pointInPolygon(arcPoly, pp)) return 'arc';
    if (otherPoly.length >= 3 && pointInPolygon(otherPoly, pp)) return 'other';
    return 'none';
  });
}

/** Return the boundary component of r that contains both lo and hi. */
export function compWithBoth(r: Region, lo: VertexId, hi: VertexId): Boundary | null {
  for (const b of r.boundaries) {
    const ids = new Set(b.entries.map(e => e.vertexId));
    const ok = lo === hi ? ids.has(lo) : ids.has(lo) && ids.has(hi);
    if (ok) return b;
  }
  return null;
}

/**
 * If vid appears in exactly one region OTHER than moveRegion, return that region's id.
 * Returns null if vid appears in zero or more than one other region.
 */
function otherRegionId(vid: VertexId, moveRegion: Region, state: GameState): number | null {
  const others: number[] = [];
  for (const r of state.regions.values()) {
    if (r.id === moveRegion.id) continue;
    if (r.boundaries.some(b => b.entries.some(e => e.vertexId === vid)))
      others.push(r.id);
  }
  return others.length === 1 ? others[0] : null;
}

/**
 * Walk comp's entries forward from lo (at the loSub occurrence) until hi is reached.
 * Returns the vertex IDs encountered in between (exclusive of both endpoints).
 */
function forwardArc(
  comp: Boundary,
  lo: VertexId,
  hi: VertexId,
  loSub: VertexId | null,
  hiSub: VertexId | null,
): VertexId[] {
  if (lo === hi) return [];
  const entries = comp.entries;
  const n = entries.length;
  // Use subscript to find the correct lo occurrence for joint vertices.
  let loIdx = -1;
  if (loSub !== null) {
    for (let i = 0; i < n; i++) {
      if (entries[i].vertexId === lo && entries[(i + 1) % n].vertexId === loSub) {
        loIdx = i; break;
      }
    }
  }
  if (loIdx === -1) loIdx = entries.findIndex(e => e.vertexId === lo);
  if (loIdx === -1) return [];
  // Walk forward until we see hi at the hiSub occurrence.
  const result: VertexId[] = [];
  for (let i = 1; i < n; i++) {
    const idx = (loIdx + i) % n;
    const vid = entries[idx].vertexId;
    if (vid === hi) {
      // If hiSub is specified, keep walking if next vertex doesn't match.
      if (hiSub === null || entries[(idx + 1) % n].vertexId === hiSub) break;
    }
    result.push(vid);
  }
  return result;
}

/**
 * Check if any boundary of `r` contains the consecutive triple [w, vid, sub].
 */
function boundaryContainsPattern(r: Region, w: VertexId, vid: VertexId, sub: VertexId): boolean {
  for (const b of r.boundaries) {
    const n = b.entries.length;
    for (let i = 0; i < n; i++) {
      if (b.entries[i].vertexId === w &&
          b.entries[(i + 1) % n].vertexId === vid &&
          b.entries[(i + 2) % n].vertexId === sub) return true;
    }
  }
  return false;
}

/** Pick the region from candidates sharing the most vertices with fwdVerts. */
function pickRegion(candidates: Region[], fwdVerts: VertexId[]): Region | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const fwdSet = new Set(fwdVerts);
  const scores = candidates.map(r => {
    const vids = new Set<VertexId>();
    for (const b of r.boundaries) for (const e of b.entries) vids.add(e.vertexId);
    return [...fwdSet].filter(v => vids.has(v)).length;
  });
  return candidates[scores[0] >= scores[1] ? 0 : 1];
}

// ---------------------------------------------------------------------------
// Joint-subscript helpers
// ---------------------------------------------------------------------------

/** True if vid appears ≥ 2 times in any single boundary in state. */
export function isJoint(vid: VertexId, state: GameState): boolean {
  for (const r of state.regions.values())
    for (const b of r.boundaries)
      if (b.entries.filter(e => e.vertexId === vid).length >= 2) return true;
  return false;
}

/**
 * For a non-self-loop move, find the subscript for `vid` by searching the
 * after-state boundaries for the pattern [W, vid, subscript].
 * In the rotation-system split, one of the two new faces has this pattern:
 * W lands between the two endpoints, so the boundary walks as
 * ..., otherEndpoint, W, vid, originalNextOfVid, ...
 */
export function jointSub(vid: VertexId, w: VertexId, after: GameState): VertexId | null {
  for (const r of after.regions.values()) {
    for (const b of r.boundaries) {
      const n = b.entries.length;
      for (let i = 0; i < n; i++) {
        if (b.entries[i].vertexId !== w) continue;
        if (b.entries[(i + 1) % n].vertexId !== vid) continue;
        return b.entries[(i + 2) % n].vertexId;
      }
    }
  }
  return null;
}

/**
 * For a self-loop on `vid`, both new face boundaries have the pattern [W, vid, sub].
 * Collect both subscripts and return them sorted ascending for a deterministic encoding.
 */
export function selfLoopJointSubs(vid: VertexId, w: VertexId, after: GameState): [VertexId | null, VertexId | null] {
  const subs: VertexId[] = [];
  for (const r of after.regions.values()) {
    for (const b of r.boundaries) {
      const n = b.entries.length;
      const wPos = b.entries.findIndex(e => e.vertexId === w);
      if (wPos === -1) continue;
      if (b.entries[(wPos + 1) % n].vertexId !== vid) continue;
      subs.push(b.entries[(wPos + 2) % n].vertexId);
    }
  }
  subs.sort((a, b) => a - b);
  return [subs[0] ?? null, subs[1] ?? null];
}
