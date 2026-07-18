/**
 * Presentation-layer "vertex label" system.
 *
 * Every spot (degree-0 vertex) starts out symmetric with every other spot, so
 * rather than eagerly guessing a specific compact label (which would bake in
 * an arbitrary, implementation-detail tie-break), each live spot carries a
 * RANGE of still-possible final labels: {lo, hi}, both negative, lo <= hi,
 * hi being the "best" (closest to -1) end. All spots sharing an identical
 * range are a "block" — mutually symmetric, indistinguishable until a real
 * game event breaks the tie.
 *
 * A spot's range only narrows via two kinds of real information:
 *   - Departure: when a spot connects (to another spot or a non-spot, or
 *     self-loops), it is IMMEDIATELY fixed to a single number — the best (hi)
 *     value currently available in its block — and every other spot still in
 *     that block has its range's hi decremented by one (that slot is taken).
 *     Once fixed, the value is permanent — shown forever, even after the
 *     vertex is no longer a spot (that's what makes it "certain").
 *   - Enclosure: a split between two non-spot vertices that separates a
 *     block's live members into "enclosed" vs "outer" groups reassigns each
 *     group its own sub-range via intersection: enclosed gets the low
 *     (best/lowest-magnitude) end, outer gets the remainder.
 *
 * When a block shrinks to exactly one live member, its range naturally
 * becomes a single value (lo === hi) — already displayable as "certain"
 * without any special-casing.
 *
 * Two spots joined together in the same move are processed in raw-vertex-id
 * order (lower id first) — a deterministic, but otherwise meaningless,
 * tie-break for the one remaining ambiguity: which of two still-fully-
 * symmetric spots gets the better of the two consecutive slots.
 */

import type { GameState, VertexId, SpotLabel, SpotGroupInfo } from './types';
import { findMoveRegion, findEnclosedSideRegion } from './moveCode';

export function isSpotLabelRange(l: SpotLabel): l is { lo: number; hi: number } {
  return typeof l !== 'number';
}

/** Human-readable form: "-3" when certain, "-5..-3" when still an open range. */
export function formatSpotLabel(l: SpotLabel): string {
  if (typeof l === 'number') return String(l);
  return l.lo === l.hi ? String(l.lo) : `${l.lo}..${l.hi}`;
}

/** Game-start labelling: all n spots are mutually symmetric — one shared block. */
export function initialSpotLabels(state: GameState): Map<VertexId, SpotLabel> {
  const spots = [...state.vertices.values()].filter(v => v.degree === 0 && !v.isPseudo);
  const labels = new Map<VertexId, SpotLabel>();
  for (const v of spots) labels.set(v.id, { lo: -spots.length, hi: -1 });
  return labels;
}

function isSpotIn(state: GameState, vid: VertexId): boolean {
  const v = state.vertices.get(vid);
  return !!v && v.degree === 0 && !v.isPseudo;
}

/**
 * Recompute spot labels after a single committed move. Takes the previous
 * label map plus the pre/post-move states and returns the new map (a fresh
 * copy — the input is never mutated). Must be called after EVERY move
 * (including moves that don't touch spots) so label state stays in lockstep
 * with the game.
 */
export function recomputeSpotLabels(
  prevLabels: Map<VertexId, SpotLabel>,
  before: GameState,
  after: GameState,
  v1: VertexId,
  v2: VertexId,
): Map<VertexId, SpotLabel> {
  const labels = new Map<VertexId, SpotLabel>(
    [...prevLabels].map(([vid, l]) => [vid, isSpotLabelRange(l) ? { ...l } : l]),
  );

  /** Fix `vid` (a live spot) to the best slot in its block; shrink the rest of the block. */
  function departSpot(vid: VertexId): void {
    const l = labels.get(vid);
    if (!l || !isSpotLabelRange(l)) return;
    const fixed = l.hi;
    for (const [ovid, ol] of labels) {
      if (ovid === vid) continue;
      if (isSpotLabelRange(ol) && ol.lo === l.lo && ol.hi === l.hi) {
        labels.set(ovid, { lo: ol.lo, hi: ol.hi - 1 });
      }
    }
    labels.set(vid, fixed);
  }

  const survivingSpots = new Set<VertexId>();
  for (const v of after.vertices.values())
    if (v.degree === 0 && !v.isPseudo) survivingSpots.add(v.id);

  // Departures: v1 and/or v2, if they were live spots that are no longer
  // degree-0 afterward (ordinary join, single-spot join, or a self-loop on a
  // lone spot). Process in raw-id order — the only remaining tie-break needed
  // when both are still fully symmetric with each other.
  const candidates = v1 === v2 ? [v1] : (v1 < v2 ? [v1, v2] : [v2, v1]);
  for (const vid of candidates) {
    if (isSpotIn(before, vid) && !survivingSpots.has(vid)) departSpot(vid);
  }

  // Check for an enclosure that splits a block's live members into "enclosed"
  // vs "outer" groups. Most moves that fix a departure are pure merges (never
  // simultaneously a split) — EXCEPT a self-loop on a lone spot, which both
  // consumes that one spot AND divides the surrounding region, so this must
  // run unconditionally rather than only when nothing departed.
  const isSplit = after.regions.size > before.regions.size;
  if (isSplit) {
    const enclosed = findEnclosedSpots(before, after, v1, v2, survivingSpots);
    if (enclosed && enclosed.size > 0 && enclosed.size < survivingSpots.size) {
      // Group surviving spots by their current block (identical range).
      const byBlock = new Map<string, VertexId[]>();
      for (const vid of survivingSpots) {
        const l = labels.get(vid);
        if (!l || !isSpotLabelRange(l)) continue;
        const key = `${l.lo}:${l.hi}`;
        const arr = byBlock.get(key);
        if (arr) arr.push(vid); else byBlock.set(key, [vid]);
      }
      for (const members of byBlock.values()) {
        const range = labels.get(members[0]) as { lo: number; hi: number };
        const encInBlock = members.filter(v => enclosed.has(v));
        const outInBlock = members.filter(v => !enclosed.has(v));
        if (encInBlock.length === 0 || outInBlock.length === 0) continue; // whole block on one side
        // Enclosed spots take the "lowest available label range" per spec —
        // i.e. the BEST (closest-to -1, hi) end of the block's remaining pool;
        // outer spots take the rest (the more-negative, later-numbered end).
        const e = encInBlock.length;
        for (const vid of encInBlock) labels.set(vid, { lo: range.hi - e + 1, hi: range.hi });
        for (const vid of outInBlock) labels.set(vid, { lo: range.lo, hi: range.hi - e });
      }
    }
  }

  return labels;
}

/**
 * For a split move between two non-spot vertices, find which surviving spots
 * ended up on the "enclosed" (lo→hi arc) side of the new region, reusing the
 * same region-finding machinery as the move-code bracket builder so labels and
 * move-code brackets can never disagree about what's enclosed.
 */
function findEnclosedSpots(
  before: GameState,
  after: GameState,
  v1: VertexId,
  v2: VertexId,
  survivingSpots: Set<VertexId>,
): Set<VertexId> | null {
  const lo = Math.min(v1, v2);
  const hi = Math.max(v1, v2);
  const found = findMoveRegion(before, after, lo, hi);
  if (!found) return null;
  const { regionR, mainComp } = found;
  // Joint subscripts aren't needed for identifying the enclosed side by spot
  // membership (spots are never joints — degree 0), so pass null/null; the
  // fallback forward-arc scoring in findEnclosedSideRegion still applies.
  const loToHiReg = findEnclosedSideRegion(regionR, mainComp, lo, hi, before, after, null, null);
  if (!loToHiReg) return null;

  const enclosed = new Set<VertexId>();
  for (const b of loToHiReg.boundaries)
    for (const e of b.entries)
      if (survivingSpots.has(e.vertexId)) enclosed.add(e.vertexId);
  return enclosed;
}

/**
 * Reverse lookup for Recreate replay: given a label value that appeared in a
 * recorded token, find a live spot that could carry it now — i.e. a spot
 * whose current range's best (hi) slot equals that label (the slot it would
 * be fixed to if it departed right now). Ties (multiple candidates in the
 * same block) are genuinely symmetric — any is topologically equivalent —
 * broken deterministically by lowest raw vertex ID.
 */
export function resolveLabelToVertexId(label: number, spotLabels: Map<VertexId, SpotLabel>): VertexId | undefined {
  const candidates: VertexId[] = [];
  for (const [vid, l] of spotLabels) {
    if (typeof l === 'number' && l === label) return vid; // already-fixed exact match (defensive)
    if (isSpotLabelRange(l) && l.hi === label) candidates.push(vid);
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a - b);
  return candidates[0];
}

/** Shrink every OTHER live member of `departedVid`'s block by one slot, as departSpot would. */
function shrinkBlockAfterDeparture(spotLabels: Map<VertexId, SpotLabel>, departedVid: VertexId): Map<VertexId, SpotLabel> {
  const l = spotLabels.get(departedVid);
  if (!l || !isSpotLabelRange(l)) return spotLabels;
  const copy = new Map(spotLabels);
  for (const [vid, ol] of copy) {
    if (vid === departedVid) continue;
    if (isSpotLabelRange(ol) && ol.lo === l.lo && ol.hi === l.hi) {
      copy.set(vid, { lo: ol.lo, hi: ol.hi - 1 });
    }
  }
  return copy;
}

/**
 * Resolve a move token's lo/hi labels to raw vertex IDs for Recreate replay.
 * Resolving lo and hi independently breaks for a two-spot join between still-
 * fully-symmetric spots: the label that is numerically greater (closer to
 * -1) has no live candidate until the OTHER one's hypothetical departure has
 * shrunk the rest of the block — exactly mirroring what recomputeSpotLabels'
 * departSpot does during forward play, where the best (highest, closest to
 * -1) slot is always claimed first. So whichever of loLabel/hiLabel is
 * numerically greater is resolved first (it's the one that can match a
 * still-undivided block's current hi), its departure simulated, then the
 * other is resolved against the shrunk map — regardless of which one the
 * token calls "lo" and which it calls "hi". Harmless no-op when neither
 * label is actually live (single-spot-join / non-spot endpoints resolve
 * exactly as before). A self-loop (loLabel === hiLabel) is a SINGLE
 * departure — hi is just lo.
 *
 * Also returns `contextLabels`: the label map as it stands immediately after
 * this move's own departure(s), BEFORE any enclosure split. Any bracket
 * entries on this same token describe the post-split state, which is a split
 * of THIS shrunk block (see buildBrackets/recomputeSpotLabels case C) — so
 * bracket resolution must use contextLabels, not the original pre-move map,
 * or a still-undivided block won't match a bracket's already-narrowed range.
 */
export function resolveMoveEndpoints(
  loLabel: VertexId,
  hiLabel: VertexId,
  spotLabels: Map<VertexId, SpotLabel>,
): { lo: VertexId; hi: VertexId; contextLabels: Map<VertexId, SpotLabel> } {
  if (loLabel === hiLabel) {
    // Self-loop: exactly one physical vertex departs.
    const resolved = resolveLabelToVertexId(loLabel, spotLabels);
    const v = resolved ?? loLabel;
    const working = resolved !== undefined ? shrinkBlockAfterDeparture(spotLabels, resolved) : spotLabels;
    return { lo: v, hi: v, contextLabels: working };
  }

  const [firstLabel, secondLabel] = loLabel > hiLabel ? [loLabel, hiLabel] : [hiLabel, loLabel];
  const firstResolved = resolveLabelToVertexId(firstLabel, spotLabels);
  const firstVid = firstResolved ?? firstLabel;
  let working = firstResolved !== undefined ? shrinkBlockAfterDeparture(spotLabels, firstResolved) : spotLabels;

  const secondResolved = resolveLabelToVertexId(secondLabel, working);
  const secondVid = secondResolved ?? secondLabel;
  if (secondResolved !== undefined) working = shrinkBlockAfterDeparture(working, secondResolved);

  const lo = loLabel === firstLabel ? firstVid : secondVid;
  const hi = hiLabel === firstLabel ? firstVid : secondVid;
  return { lo, hi, contextLabels: working };
}

/**
 * Resolve a parsed bracket entry (see BracketEntry in moveCodeParse.ts) to the
 * raw vertex ID(s) it names, for Recreate replay:
 *   - a plain number resolves like a single lo/hi label (see
 *     resolveLabelToVertexId), falling back to the number itself when it's
 *     actually a raw non-spot id, not a label.
 *   - a {lo,hi} range names an entire block of ENCLOSED spots. Brackets always
 *     list the enclosed side, which per recomputeSpotLabels' case C always
 *     takes the BEST (highest, closest to -1) e = hi-lo+1 slots of whatever
 *     block it splits from — i.e. entry.hi always equals that block's current
 *     hi, but the split itself hasn't happened yet at resolution time, so an
 *     EXACT {lo,hi} match won't exist. Instead: find the still-undivided
 *     block whose hi matches entry.hi, and take any e of its members (order
 *     doesn't matter — they're mutually symmetric, so any choice among them
 *     is topologically equivalent). Callers must pass `contextLabels` from
 *     resolveMoveEndpoints (the state after this move's own departure(s),
 *     before its enclosure split), not the raw pre-move map.
 */
export function resolveBracketEntry(
  entry: number | { lo: number; hi: number },
  spotLabels: Map<VertexId, SpotLabel>,
): VertexId[] {
  if (typeof entry === 'number') {
    return [resolveLabelToVertexId(entry, spotLabels) ?? entry];
  }
  const e = entry.hi - entry.lo + 1;
  const members: VertexId[] = [];
  for (const [vid, l] of spotLabels) {
    if (isSpotLabelRange(l) && l.hi === entry.hi) members.push(vid);
  }
  members.sort((a, b) => a - b);
  return members.slice(0, e);
}

/**
 * Resolve a parsed `(m)` disambiguator to a raw vertex ID for Recreate replay.
 * Mirrors resolveBracketEntry: a plain number resolves like a single label
 * (falling back to the number itself for a raw non-spot id); a {lo,hi} range
 * names a still-live, still-symmetric spot by its shared block — any live
 * member matching that range is topologically equivalent, so the lowest is
 * picked deterministically. `null`/`'empty'` pass through unchanged.
 */
export function resolveParensEntry(
  entry: VertexId | { lo: number; hi: number } | 'empty' | null,
  spotLabels: Map<VertexId, SpotLabel>,
): VertexId | 'empty' | null {
  if (entry === null || entry === 'empty') return entry;
  if (typeof entry === 'number') return resolveLabelToVertexId(entry, spotLabels) ?? entry;
  const members: VertexId[] = [];
  for (const [vid, l] of spotLabels) {
    if (isSpotLabelRange(l) && l.hi === entry.hi) members.push(vid);
  }
  members.sort((a, b) => a - b);
  return members[0] ?? entry.lo;
}

/** Build a computeMoveCode `labelFor` resolver from a post-move label map. */
export function labelForFromMap(spotLabels: Map<VertexId, SpotLabel>): (vid: VertexId) => VertexId {
  return (vid: VertexId) => {
    const l = spotLabels.get(vid);
    return typeof l === 'number' ? l : vid;
  };
}

/**
 * Grouping info for a spot vertex, used by computeMoveCode's enclosure
 * bracket builder to collapse a run of enclosed/outer spots sharing the same
 * block into a single compact "lo..hi" entry instead of listing each one
 * individually — non-spot boundary vertices still list their own specific
 * minimum id, unaffected. `key` distinguishes blocks (and already-fixed
 * singletons) so multiple distinct groups among the same bracket side each
 * still get their own entry; `sortKey` orders entries alongside raw ids.
 */
export function spotGroupInfo(vid: VertexId, spotLabels: Map<VertexId, SpotLabel>): SpotGroupInfo | null {
  const label = spotLabels.get(vid);
  if (label === undefined) return null;
  if (typeof label === 'number') return { key: `f${label}`, sortKey: label, text: String(label) };
  return { key: `r${label.lo}:${label.hi}`, sortKey: label.hi, text: formatSpotLabel(label) };
}

/** Build a computeMoveCode `spotGroupFor` resolver from a post-move label map. */
export function spotGroupForFromMap(spotLabels: Map<VertexId, SpotLabel>): (vid: VertexId) => SpotGroupInfo | null {
  return (vid: VertexId) => spotGroupInfo(vid, spotLabels);
}
