/**
 * Derives the string encoding of a Sprouts position from the combinatorial layer.
 *
 * The encoding is always computed fresh — it is never stored as ground truth.
 *
 * Symbol key (pre-compression):
 *   0  spot (degree 0)
 *   1  appendage (degree 1)
 *   2  scab (degree 2, one region has no other available vertex)
 *   7  joint first visit  (degree 2, both sides same region, Dyck push)
 *   8  joint second visit (degree 2, both sides same region, Dyck pop)
 *   A–Z membrane (degree 2, both regions have other available vertices;
 *                 same letter marks both appearances)
 *
 * Compression symbols (applied in passes until stable):
 *   3  DisaPoint  — replaces a membrane whose partner region is [2,M]
 *   4  HollowPoint — replaces two adjacent membranes whose partner region
 *                    is [MM] (two membranes, no other living vertices)
 *   5  SplitPoint  — replaces two adjacent membranes M1,M2 whose partner
 *                    regions are [M1 X] and [M2 X] for the same shared X
 *   6  Triplet    — like HollowPoint but with three membranes
 *
 * Delimiters:  , between boundaries within a region
 *              | between regions within a subposition
 *              [] wraps a subposition
 *              ⊕ between subpositions
 */

import type { GameState, VertexId, RegionId, EdgeId } from './types';
import { VertexType } from './types';
import { MoveKind, type MoveInfo } from '../engine/stalks';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EncodingResult {
  /** Full position string, e.g. "[0AB|1,A|1,B]" */
  text: string;
  /**
   * Pre-compression symbol for each vertex (for on-canvas display).
   * Dead vertices are omitted.  Joints map to '7' (first-visit symbol).
   */
  vertexSymbols: Map<VertexId, string>;
  /**
   * Per-character provenance for `text`, same length as `text`. Punctuation
   * (brackets, commas, pipes, ⊕, spaces) carries an empty vertexIds array.
   * Used to drive hover highlighting: which vertex/vertices a hovered
   * character refers to, and (for a single-vertex, two-sided token) which
   * outgoing edge that occurrence walks — enough to compute a scab-style
   * half-point wedge for the correct side.
   */
  charInfo: Array<{ vertexIds: VertexId[]; edgeId?: EdgeId }>;
}

/**
 * A VALID position string for the current game state — deterministic for a given live
 * state, but NOT a canonical invariant (see layOutSubposition for why). True canonical
 * identity comes from the WASM engine's canon(state's text) (M6, project_encoding_canon_rework);
 * this is a thin wrapper over encodePosition for callers that only need the string, not
 * the vertex-symbol map — e.g. as input to canon(), or for a same-state before/after
 * determinism check (deadRegions.ts's commitIfEncodingPreserved).
 */
export function canonicalEncoding(state: GameState): string {
  return encodePosition(state).text;
}

export function encodePosition(state: GameState): EncodingResult {
  return buildEncoding(state, true);
}

/**
 * As encodePosition, but skips the compression passes (step 5) — every live vertex keeps its own
 * token, no pseudo-point compression (3/4/5/6). This is the "decompressed" form the WASM engine's
 * tracked canonicalizer (canonicalizeTrackedProvenanceSync) requires as input, since provenance is
 * seeded per input token and pseudo-point compression is lossy for that purpose.
 */
export function encodePositionDecompressed(state: GameState): EncodingResult {
  return buildEncoding(state, false);
}

function buildEncoding(state: GameState, compress: boolean): EncodingResult {
  // 1. Classify every vertex using full region-aware logic (pseudo-vertices excluded)
  const types = new Map<VertexId, VertexType>();
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue;
    types.set(v.id, classifyVertexFull(v.id, state));
  }

  // 2. Assign A–Z letters to membrane vertices in traversal order
  const membraneLetters = assignMembraneLetters(state, types);

  // 3. Build pre-compression vertex symbol map (for canvas labels)
  const vertexSymbols = buildVertexSymbols(types, membraneLetters);

  // 4. Build mutable intermediate region structure
  const reprs = buildRegionReprs(state, types, membraneLetters);

  // 5. Apply all compression passes until stable (skipped for the decompressed form)
  if (compress) applyAllCompressions(reprs, vertexSymbols);

  // 6. Serialize to string (also normalizes membrane letters in reading order)
  const { text, charInfo } = serialize(state, reprs, vertexSymbols);

  return { text, vertexSymbols, charInfo };
}

// ---------------------------------------------------------------------------
// Vertex classification
// ---------------------------------------------------------------------------

/** Count vertices in a region that could be used as move endpoints. */
function availableCount(regionId: RegionId, excludeVid: VertexId, state: GameState): number {
  const region = state.regions.get(regionId);
  if (!region) return 0;
  const seen = new Set<VertexId>();
  let count = 0;
  for (const boundary of region.boundaries) {
    for (const entry of boundary.entries) {
      if (state.vertices.get(entry.vertexId)?.isPseudo) continue;
      const vid = entry.vertexId;
      if (vid === excludeVid || seen.has(vid)) continue;
      seen.add(vid);
      const v = state.vertices.get(vid);
      if (v && v.degree < 3) count++;
    }
  }
  return count;
}

/**
 * Fully classify a vertex, using region data for degree-2 vertices.
 * This is the authoritative classification used during encoding; the stored
 * v.type is only a cached approximation updated after each move.
 */
export function classifyVertexFull(vid: VertexId, state: GameState): VertexType {
  const v = state.vertices.get(vid);
  if (!v) return VertexType.Dead;

  if (v.degree === 0) return VertexType.Spot;
  if (v.degree === 1) return VertexType.Appendage;
  if (v.degree >= 3) return VertexType.Dead;

  // degree === 2: check for joint (appears twice in the same boundary walk)
  for (const region of state.regions.values()) {
    if (region.isDead) continue;
    for (const boundary of region.boundaries) {
      const indices: number[] = [];
      for (let i = 0; i < boundary.entries.length; i++) {
        if (boundary.entries[i].vertexId === vid) indices.push(i);
      }
      if (indices.length < 2) continue;

      // Split boundary into two arcs and check each for available vertices.
      const [i0, i1] = indices;
      const entries = boundary.entries;
      const hasAvail = (start: number, end: number): boolean => {
        for (let k = start; k < end; k++) {
          const e = entries[k];
          if (state.vertices.get(e.vertexId)?.isPseudo || e.vertexId === vid) continue;
          const u = state.vertices.get(e.vertexId);
          if (u && u.degree < 3) return true;
        }
        return false;
      };
      // Arc A: entries between i0 and i1 (exclusive)
      const arcAHas = hasAvail(i0 + 1, i1);
      // Arc B: entries after i1 + before i0 (wrapping)
      const arcBHas = hasAvail(i1 + 1, entries.length) || hasAvail(0, i0);

      if (arcAHas && arcBHas) return VertexType.Joint;
      if (arcAHas || arcBHas) return VertexType.Scab;
      return VertexType.Dead;
    }
  }

  // Not a joint — find the two regions (dead or alive) this vertex borders
  const allRegionIds: RegionId[] = [];
  for (const region of state.regions.values()) {
    for (const boundary of region.boundaries) {
      if (boundary.entries.some(e => !state.vertices.get(e.vertexId)?.isPseudo && e.vertexId === vid)) {
        allRegionIds.push(region.id);
        break;
      }
    }
  }

  if (allRegionIds.length < 2) return VertexType.Dead;

  // Dead regions contribute 0 available count — moves can't be made through them.
  const avail = allRegionIds.map(rid => {
    const r = state.regions.get(rid);
    return r && !r.isDead ? availableCount(rid, vid, state) : 0;
  });

  if (avail[0] > 0 && avail[1] > 0) return VertexType.Membrane;
  if (avail[0] > 0 || avail[1] > 0) return VertexType.Scab;
  return VertexType.Dead;
}

// ---------------------------------------------------------------------------
// Membrane letter assignment
// ---------------------------------------------------------------------------

function assignMembraneLetters(
  state: GameState,
  types: Map<VertexId, VertexType>,
): Map<VertexId, string> {
  const letters = new Map<VertexId, string>();
  let next = 0;

  for (const region of state.regions.values()) {
    if (region.isDead) continue;
    for (const boundary of region.boundaries) {
      for (const entry of boundary.entries) {
        const vid = entry.vertexId;
        if (types.get(vid) === VertexType.Membrane && !letters.has(vid)) {
          letters.set(vid, String.fromCharCode(65 + next++));
        }
      }
    }
  }
  return letters;
}

// ---------------------------------------------------------------------------
// Vertex symbol map (pre-compression, for display)
// ---------------------------------------------------------------------------

function buildVertexSymbols(
  types: Map<VertexId, VertexType>,
  membraneLetters: Map<VertexId, string>,
): Map<VertexId, string> {
  const symbols = new Map<VertexId, string>();
  for (const [vid, vtype] of types) {
    switch (vtype) {
      case VertexType.Spot:      symbols.set(vid, '0'); break;
      case VertexType.Appendage: symbols.set(vid, '1'); break;
      case VertexType.Scab:      symbols.set(vid, '2'); break;
      case VertexType.Joint:     symbols.set(vid, '7'); break;
      case VertexType.Membrane:  symbols.set(vid, membraneLetters.get(vid) ?? '?'); break;
      case VertexType.Dead:      break;
    }
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Intermediate mutable region structure
// ---------------------------------------------------------------------------

interface Token {
  symbol: string;
  /**
   * The vertex/vertices this character represents. Usually one; synthesized
   * compression tokens (3/4/5/6) carry all the vertices they merged, so a
   * hover can highlight each of them (as a full point — the merged side info
   * isn't preserved).
   */
  vertexIds: VertexId[];
  /**
   * The physical edge traversed leaving this occurrence in the boundary walk
   * (BoundaryEntry.edgeId). Only meaningful when vertexIds.length === 1; lets
   * a hover on a two-sided token (membrane letter, joint 7/8) compute which
   * of the vertex's two angular wedges this specific occurrence belongs to.
   */
  edgeId?: EdgeId;
}

interface RegionRepr {
  originalId: RegionId;
  subposIdx: number;
  boundaries: Token[][];
  deleted: boolean;
}

function buildRegionReprs(
  state: GameState,
  types: Map<VertexId, VertexType>,
  membraneLetters: Map<VertexId, string>,
): RegionRepr[] {
  const regionToSubpos = new Map<RegionId, number>();
  state.subpositions.forEach((sub, idx) => {
    for (const rid of sub.regionIds) regionToSubpos.set(rid, idx);
  });

  const reprs: RegionRepr[] = [];

  for (const region of state.regions.values()) {
    if (region.isDead) continue;

    const boundaries: Token[][] = [];
    // Distals are reclassified as Scab but appear twice in the boundary walk
    // (firstVisit + secondVisit). Only emit '2' on the first encounter.
    const emittedScabs = new Set<VertexId>();

    for (const boundary of region.boundaries) {
      const tokens: Token[] = [];

      for (const entry of boundary.entries) {
        const vid = entry.vertexId;
        const vtype = types.get(vid) ?? VertexType.Dead;
        let symbol: string | null = null;

        switch (vtype) {
          case VertexType.Spot:      symbol = '0'; break;
          case VertexType.Appendage: symbol = '1'; break;
          case VertexType.Scab:
            if (!emittedScabs.has(vid)) { emittedScabs.add(vid); symbol = '2'; }
            break;
          case VertexType.Joint:
            symbol = entry.side === 'firstVisit' ? '7' : '8';
            break;
          case VertexType.Membrane:
            symbol = membraneLetters.get(vid) ?? '?';
            break;
          case VertexType.Dead:
            symbol = null;
            break;
        }

        if (symbol !== null) tokens.push({ symbol, vertexIds: [vid], edgeId: entry.edgeId });
      }

      if (tokens.length > 0) boundaries.push(tokens);
    }

    reprs.push({
      originalId: region.id,
      subposIdx: regionToSubpos.get(region.id) ?? 0,
      boundaries,
      deleted: false,
    });
  }

  return reprs;
}

// ---------------------------------------------------------------------------
// Compression helpers
// ---------------------------------------------------------------------------

function allTokens(repr: RegionRepr): Token[] {
  return repr.boundaries.flat();
}

const MEMBRANE_RE = /^[A-Z]$/;

/** Find all positions of a given letter, optionally excluding one region index. */
function findLetterPositions(
  letter: string,
  reprs: RegionRepr[],
  excludeRi = -1,
): Array<{ ri: number; bi: number; ti: number }> {
  const result: Array<{ ri: number; bi: number; ti: number }> = [];
  for (let ri = 0; ri < reprs.length; ri++) {
    if (ri === excludeRi || reprs[ri].deleted) continue;
    for (let bi = 0; bi < reprs[ri].boundaries.length; bi++) {
      for (let ti = 0; ti < reprs[ri].boundaries[bi].length; ti++) {
        if (reprs[ri].boundaries[bi][ti].symbol === letter) {
          result.push({ ri, bi, ti });
        }
      }
    }
  }
  return result;
}

/** True if two token-indices are adjacent in a cyclic boundary of given length. */
function cyclicAdjacent(ti1: number, ti2: number, len: number): boolean {
  const diff = Math.abs(ti1 - ti2);
  return diff === 1 || diff === len - 1;
}

/** True if three sorted token-indices are consecutive in a cyclic boundary. */
function cyclicConsecutive(tis: number[], len: number): boolean {
  const s = [...tis].sort((a, b) => a - b);
  const linear = s[1] - s[0] === 1 && s[2] - s[1] === 1;
  const wrap   = s[0] === 0 && s[1] === 1 && s[2] === len - 1;
  return linear || wrap;
}

// ---------------------------------------------------------------------------
// DisaPoint (3): region with exactly one scab '2' and one membrane A–Z
//   → delete that region, replace the membrane's partner with '3'
// ---------------------------------------------------------------------------

function applyDisaPoints(reprs: RegionRepr[], syms: Map<VertexId, string>): boolean {
  for (let ri = 0; ri < reprs.length; ri++) {
    if (reprs[ri].deleted) continue;
    const tokens = allTokens(reprs[ri]);
    if (tokens.length !== 2) continue;
    if (!tokens.some(t => t.symbol === '2')) continue;
    const mToken = tokens.find(t => MEMBRANE_RE.test(t.symbol));
    if (!mToken) continue;

    const [other] = findLetterPositions(mToken.symbol, reprs, ri);
    if (!other) continue;

    // Update canvas label: membrane vertex → '3'
    const mVid = mToken.vertexIds[0];
    if (mVid !== undefined) syms.set(mVid, '3');

    reprs[other.ri].boundaries[other.bi][other.ti] =
      { symbol: '3', vertexIds: mVid !== undefined ? [mVid] : [] };

    // The scab vertex borders BOTH the deleted region and the surviving region.
    // Remove its token from every surviving region so it doesn't appear as an
    // orphan '2' after the DisaPoint region is deleted.
    // On the canvas, label the scab as struck-through '3' (prefix '~') so it's
    // visually associated with the DisaPoint without appearing in the encoding.
    const scabToken = tokens.find(t => t.symbol === '2');
    const scabVid = scabToken?.vertexIds[0];
    if (scabVid !== undefined) {
      syms.set(scabVid, '~3');
      for (let i = 0; i < reprs.length; i++) {
        if (i === ri || reprs[i].deleted) continue;
        for (let bi = 0; bi < reprs[i].boundaries.length; bi++) {
          reprs[i].boundaries[bi] = reprs[i].boundaries[bi].filter(t => t.vertexIds[0] !== scabVid);
        }
      }
    }

    reprs[ri].deleted = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HollowPoint (4): region with exactly two membranes whose partners are
//   cyclically adjacent in the same boundary
//   → delete that region, replace both partners with a single '4'
// ---------------------------------------------------------------------------

function applyHollowPoints(reprs: RegionRepr[], syms: Map<VertexId, string>): boolean {
  for (let ri = 0; ri < reprs.length; ri++) {
    if (reprs[ri].deleted) continue;
    const tokens = allTokens(reprs[ri]);
    if (tokens.length !== 2) continue;
    if (!tokens.every(t => MEMBRANE_RE.test(t.symbol))) continue;

    const [l1, l2] = [tokens[0].symbol, tokens[1].symbol];
    const [p1] = findLetterPositions(l1, reprs, ri);
    const [p2] = findLetterPositions(l2, reprs, ri);
    if (!p1 || !p2) continue;
    if (p1.ri !== p2.ri || p1.bi !== p2.bi) continue;

    const bLen = reprs[p1.ri].boundaries[p1.bi].length;
    if (!cyclicAdjacent(p1.ti, p2.ti, bLen)) continue;

    // Update canvas labels for both membrane vertices → '4'
    for (const tok of tokens) { for (const vid of tok.vertexIds) syms.set(vid, '4'); }
    const mergedVids = tokens.flatMap(t => t.vertexIds);

    // Remove the two tokens and insert a single '4'
    const minTi = Math.min(p1.ti, p2.ti);
    if (Math.abs(p1.ti - p2.ti) === bLen - 1) {
      // Wrap case: remove last token, then remove first token, insert '4' at start
      reprs[p1.ri].boundaries[p1.bi].splice(bLen - 1, 1);
      reprs[p1.ri].boundaries[p1.bi].splice(0, 1, { symbol: '4', vertexIds: mergedVids });
    } else {
      reprs[p1.ri].boundaries[p1.bi].splice(minTi, 2, { symbol: '4', vertexIds: mergedVids });
    }

    reprs[ri].deleted = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Triplet (6): like HollowPoint but with exactly three membranes that are
//   cyclically consecutive in the same boundary
//   → delete region, replace all three partners with a single '6'
// ---------------------------------------------------------------------------

function applyTriplets(reprs: RegionRepr[], syms: Map<VertexId, string>): boolean {
  for (let ri = 0; ri < reprs.length; ri++) {
    if (reprs[ri].deleted) continue;
    const tokens = allTokens(reprs[ri]);
    if (tokens.length !== 3) continue;
    if (!tokens.every(t => MEMBRANE_RE.test(t.symbol))) continue;

    const letters = tokens.map(t => t.symbol);
    const positions = letters.map(l => findLetterPositions(l, reprs, ri)[0]);
    if (positions.some(p => !p)) continue;

    const [p0, p1, p2] = positions as Array<{ ri: number; bi: number; ti: number }>;
    if (p0.ri !== p1.ri || p1.ri !== p2.ri) continue;
    if (p0.bi !== p1.bi || p1.bi !== p2.bi) continue;

    const bLen = reprs[p0.ri].boundaries[p0.bi].length;
    if (!cyclicConsecutive([p0.ti, p1.ti, p2.ti], bLen)) continue;

    // Update canvas labels for all three membrane vertices → '6'
    for (const tok of tokens) { for (const vid of tok.vertexIds) syms.set(vid, '6'); }
    const mergedVids = tokens.flatMap(t => t.vertexIds);

    // Replace all three with a single '6'
    const tis = [p0.ti, p1.ti, p2.ti].sort((a, b) => a - b);
    const boundary = reprs[p0.ri].boundaries[p0.bi];
    const wrapCase = tis[0] === 0 && tis[1] === 1 && tis[2] === bLen - 1;
    if (wrapCase) {
      boundary.splice(bLen - 1, 1);
      boundary.splice(0, 2, { symbol: '6', vertexIds: mergedVids });
    } else {
      boundary.splice(tis[0], 3, { symbol: '6', vertexIds: mergedVids });
    }

    reprs[ri].deleted = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// SplitPoint (5): two cyclically adjacent membranes M1, M2 on a boundary
//   whose partner regions are each [Mi, X] for the same shared letter X
//   → delete both partner regions, replace (M1, M2) with a single '5'
// ---------------------------------------------------------------------------

function applySplitPoints(reprs: RegionRepr[], syms: Map<VertexId, string>): boolean {
  for (let ri = 0; ri < reprs.length; ri++) {
    if (reprs[ri].deleted) continue;
    for (let bi = 0; bi < reprs[ri].boundaries.length; bi++) {
      const boundary = reprs[ri].boundaries[bi];
      const len = boundary.length;

      for (let ti = 0; ti < len; ti++) {
        const ti2 = (ti + 1) % len;
        const t1 = boundary[ti];
        const t2 = boundary[ti2];
        if (!MEMBRANE_RE.test(t1.symbol) || !MEMBRANE_RE.test(t2.symbol)) continue;

        const [pos1] = findLetterPositions(t1.symbol, reprs, ri);
        const [pos2] = findLetterPositions(t2.symbol, reprs, ri);
        if (!pos1 || !pos2) continue;
        if (pos1.ri === pos2.ri) continue; // must be in different partner regions

        const partnerTokens1 = allTokens(reprs[pos1.ri]);
        const partnerTokens2 = allTokens(reprs[pos2.ri]);
        if (partnerTokens1.length !== 2 || !partnerTokens1.every(t => MEMBRANE_RE.test(t.symbol))) continue;
        if (partnerTokens2.length !== 2 || !partnerTokens2.every(t => MEMBRANE_RE.test(t.symbol))) continue;

        const xToken = partnerTokens1.find(t => t.symbol !== t1.symbol)!;
        const x2    = partnerTokens2.find(t => t.symbol !== t2.symbol)!.symbol;
        if (xToken.symbol !== x2) continue;

        // Update canvas labels: M1, M2 → '5'; shared X membrane → '~5' (struck)
        for (const vid of t1.vertexIds) syms.set(vid, '5');
        for (const vid of t2.vertexIds) syms.set(vid, '5');
        for (const vid of xToken.vertexIds) syms.set(vid, '~5');
        const mergedVids = [...t1.vertexIds, ...t2.vertexIds];

        reprs[pos1.ri].deleted = true;
        reprs[pos2.ri].deleted = true;

        // Replace the two tokens with a single '5'
        if (ti2 === ti + 1) {
          boundary.splice(ti, 2, { symbol: '5', vertexIds: mergedVids });
        } else {
          // Wrap case: ti = len-1, ti2 = 0
          boundary.splice(len - 1, 1);
          boundary.splice(0, 1, { symbol: '5', vertexIds: mergedVids });
        }

        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drive all compressions until stable
// ---------------------------------------------------------------------------

function applyAllCompressions(reprs: RegionRepr[], syms: Map<VertexId, string>): void {
  let changed = true;
  while (changed) {
    changed =
      applyDisaPoints(reprs, syms)   ||
      applyHollowPoints(reprs, syms) ||
      applyTriplets(reprs, syms)     ||
      applySplitPoints(reprs, syms);
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers: canonical boundary rotation + sorting
// ---------------------------------------------------------------------------

/**
 * Sort key for a single token when ORDERING boundaries/regions: membranes collapse
 * to '9' so the relabel-arbitrary letter identities don't drive the sort (two
 * boundaries of the same shape but different membrane letters must sort together).
 * Used only by boundaryKey (the ordering key), never to pick a rotation.
 */
function tokenSortChar(t: Token): string {
  return MEMBRANE_RE.test(t.symbol) ? '9' : t.symbol;
}

/**
 * Key for CHOOSING a boundary's canonical ROTATION: the concrete symbol string,
 * membranes included as their assigned letters. Unlike the membrane-agnostic
 * boundaryKey (which ties across every rotation of an all-membrane boundary and so
 * can't distinguish them — the old bug that left rotation 0 / the traversal start
 * arbitrary), this key distinguishes every rotation. Within a single boundary each
 * membrane letter is distinct (a membrane is shared between two DISTINCT regions, so
 * it appears exactly once per boundary), so the rotations of a lettered boundary are
 * all distinct strings and their minimum is UNIQUE.
 *
 * For any boundary containing a non-membrane token this picks the SAME rotation the
 * agnostic key did: 0/1/2/7/8 all sort below both '9' and 'A'–'Z', and a membrane is
 * the largest symbol under either scheme, so the two keys only ever disagree at a
 * position where both candidate rotations have a membrane — exactly the tie the
 * agnostic key left open. So this refines only the previously-arbitrary all-membrane /
 * membrane-tie rotations and leaves every other boundary's canonical rotation
 * byte-identical to before (and boundaryKey, hence all boundary/region ORDERING,
 * is likewise unchanged: it is rotation-invariant across the tie cases).
 */
function boundaryRotationKey(tokens: Token[]): string {
  return tokens.map(t => t.symbol).join('');
}

/**
 * Reassign joint side symbols (7 = first visit, 8 = second visit) by order of
 * appearance in a LINEAR token sequence. Joint sides are frozen at build time
 * from the original walk order, but canonical rotation can move a joint's
 * second visit ahead of its first — which would emit an invalid Dyck sequence
 * (an 8 before its matching 7). Re-deriving them per rotation keeps every joint
 * pair correctly ordered. Returns a new array; original is unchanged.
 */
function normalizeJointSides(tokens: Token[]): Token[] {
  const seen = new Set<VertexId>();
  return tokens.map(t => {
    const vid = t.vertexIds[0];
    if ((t.symbol === '7' || t.symbol === '8') && vid !== undefined) {
      const symbol = seen.has(vid) ? '8' : '7';
      seen.add(vid);
      return { ...t, symbol };
    }
    return t;
  });
}

/** normalizeJointSides'd cyclic rotation of `tokens` starting at index `start`. */
function rotateTokens(tokens: Token[], start: number): Token[] {
  if (tokens.length <= 1) return normalizeJointSides([...tokens]);
  return normalizeJointSides([...tokens.slice(start), ...tokens.slice(0, start)]);
}

/** Membrane-agnostic (membranes → '9') string of the rotation starting at `start`. */
function agnosticStringAt(tokens: Token[], start: number): string {
  return rotateTokens(tokens, start).map(tokenSortChar).join('');
}

/**
 * The rotation start-offsets whose membrane-agnostic string is lexicographically
 * minimal. For a boundary with any distinguishing non-membrane token this is a
 * single offset (the agnostic key already pins the rotation); for an all-membrane /
 * rotation-symmetric boundary it is the whole set of tied offsets — the residue the
 * global lettering must resolve (an all-membrane boundary's every rotation ties on
 * '9…9', which is exactly why picking one arbitrarily broke the invariant). The
 * serializer enumerates these against the membrane lettering to pick a canonical
 * rotation; see canonicalizeSubposition.
 */
function agnosticMinShifts(tokens: Token[]): number[] {
  const n = tokens.length;
  if (n <= 1) return [0];
  let best = agnosticStringAt(tokens, 0);
  for (let i = 1; i < n; i++) {
    const s = agnosticStringAt(tokens, i);
    if (s < best) best = s;
  }
  const shifts: number[] = [];
  for (let i = 0; i < n; i++) if (agnosticStringAt(tokens, i) === best) shifts.push(i);
  return shifts;
}

/** Lexicographic sort key for a (possibly already-rotated) boundary. */
function boundaryKey(tokens: Token[]): string {
  return tokens.map(tokenSortChar).join('');
}

// ---------------------------------------------------------------------------
// Canonical serialization
//
// The position string must be a genuine invariant: two encodings of the SAME
// combinatorial position — differing only by boundary walk-start (rotation),
// boundary order, region order, or which physical membrane got which letter — must
// serialize identically. Sorting on the membrane-agnostic key pins the order wherever
// the shapes differ, but a symmetric RESIDUE survives where shapes tie: an all-membrane
// boundary (every rotation ties on '9…9'), or two structurally-tied regions whose read
// order decides the lettering (e.g. "[BE|ABCD|ADCE]" vs "[AE|ABCD|BEDC]" — same
// position, different walk). A per-boundary rotation fix alone can't resolve the second
// kind because the lettering itself depends on the (tied) region/boundary order.
//
// We resolve the whole residue the way Stalks' canon.cpp does, but bounded to only the
// tied part: enumerate the tied rotations / boundary orders / region orders of each
// subposition, letter every candidate by first occurrence, and keep the
// lexicographically-least content. A non-symmetric subposition has exactly one candidate,
// so its output is byte-identical to before. See canonicalizeSubposition.
// ---------------------------------------------------------------------------

/** An ordered, rotation-fixed layout of one subposition: regions → boundaries → tokens. */
type Layout = Token[][][];

const totalTokensLayout = (layout: Layout): number =>
  layout.reduce((s, region) => s + region.reduce((t, b) => t + b.length, 0), 0);

/** Assign A,B,C… to membranes by first occurrence in `layout` reading order and return
 *  the content string (regions '|' boundaries ',' tokens concatenated) it produces — the
 *  exact inside-the-brackets text that will be emitted for this subposition. Used only as
 *  a stable tie-break key when ordering subpositions (see serialize()). */
function layoutContent(layout: Layout): string {
  const letterOf = new Map<VertexId, number>();
  let next = 0;
  const chOf = (t: Token): string => {
    if (!MEMBRANE_RE.test(t.symbol)) return t.symbol;
    const vid = t.vertexIds[0];
    let i = vid !== undefined ? letterOf.get(vid) : undefined;
    if (i === undefined) { i = next++; if (vid !== undefined) letterOf.set(vid, i); }
    return String.fromCharCode(65 + i);
  };
  return layout
    .map(region => region.map(bnd => bnd.map(chOf).join('')).join(','))
    .join('|');
}

/**
 * Lay out one subposition: each boundary rotated to its membrane-agnostic-minimal start
 * (picking the first tied shift, no enumeration), boundaries within a region ordered by
 * boundaryKey, regions ordered by (boundaryCount, tokenCount) then boundaryKey of their
 * first boundary — all single deterministic choices, no permutation search.
 *
 * NOT a canonical form: two encodings of the same combinatorial position can, in rare
 * symmetric cases (an all-membrane boundary, or two structurally-tied regions), serialize
 * to different strings depending on which live vertex ids happened to win the walk (see
 * project_canon_rotation_bug for the history). That stopped mattering once WASM canon()
 * became the single source of canonical identity (M6, project_encoding_canon_rework):
 * every consumer that needs true identity re-canonicalizes via canon() downstream: engine
 * canon() itself, the dead-region gate (deadRegions.ts, requires canonSync), Move Check's
 * {enc} tag (only needs this function to be deterministic for the SAME live state, which
 * it trivially is), recordGameplayEdge, and Position Browser sync — none compare this
 * string directly across two independently-produced encodings.
 */
function layOutSubposition(regs: RegionRepr[]): { layout: Layout; content: string } {
  const regions = regs
    .map(r => r.boundaries.filter(b => b.length > 0))
    .filter(bs => bs.length > 0);
  if (regions.length === 0) return { layout: [], content: '' };

  const rotated = regions.map(bs => bs.map(b => rotateTokens(b, agnosticMinShifts(b)[0])));
  const ordered = rotated.map(bs => [...bs].sort((a, b) => {
    const ka = boundaryKey(a), kb = boundaryKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }));

  const regKey = (bs: Token[][]): string =>
    String(bs.length).padStart(3, '0') + ':' +
    String(bs.reduce((s, b) => s + b.length, 0)).padStart(4, '0') + ':' +
    (bs[0] ? boundaryKey(bs[0]) : '');
  const layout = [...ordered].sort((a, b) => {
    const ka = regKey(a), kb = regKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return { layout, content: layoutContent(layout) };
}

interface CharEntry {
  ch: string;
  vertexIds: VertexId[];
  edgeId?: EdgeId;
}

function serialize(
  state: GameState,
  reprs: RegionRepr[],
  syms: Map<VertexId, string>,
): { text: string; charInfo: Array<{ vertexIds: VertexId[]; edgeId?: EdgeId }> } {
  const subposCount = state.subpositions.length;

  // Group active regions by subposition index, then canonicalize each subposition
  // independently (membranes never pair across subpositions, so a subposition's canonical
  // form is self-contained).
  const bySubpos: Map<number, RegionRepr[]> = new Map();
  for (let si = 0; si < subposCount; si++) bySubpos.set(si, []);
  for (const r of reprs) {
    if (!r.deleted) bySubpos.get(r.subposIdx)?.push(r);
  }

  const subs = [...bySubpos.values()]
    .filter(rs => rs.length > 0)
    .map(rs => layOutSubposition(rs))
    .filter(s => s.layout.length > 0);

  // Order subpositions: primary region count, then total tokens (both as before), then the
  // canonical content as a stable tie-break for structurally-tied subpositions.
  subs.sort((a, b) => {
    const rc = a.layout.length - b.layout.length;
    if (rc !== 0) return rc;
    const tt = totalTokensLayout(a.layout) - totalTokensLayout(b.layout);
    if (tt !== 0) return tt;
    return a.content < b.content ? -1 : a.content > b.content ? 1 : 0;
  });

  // Global membrane relettering: A,B,C… by first occurrence across the final subposition→
  // region→boundary→token order. Applied to the (winning) tokens we emit and to the canvas
  // vertex-symbol map (whose membrane entries may carry a '~' strike prefix). Keyed by
  // vertex id so a membrane's two region-appearances always share one letter.
  const letterOf = new Map<VertexId, string>();
  let nextCode = 65; // 'A'
  const eachMembraneToken = (fn: (t: Token, vid: VertexId) => void): void => {
    for (const { layout } of subs)
      for (const region of layout)
        for (const bnd of region)
          for (const t of bnd) {
            const vid = t.vertexIds[0];
            if (vid !== undefined && MEMBRANE_RE.test(t.symbol)) fn(t, vid);
          }
  };
  eachMembraneToken((_t, vid) => {
    if (!letterOf.has(vid)) letterOf.set(vid, String.fromCharCode(nextCode++));
  });
  eachMembraneToken((t, vid) => { t.symbol = letterOf.get(vid)!; });
  for (const [vid, sym] of syms) {
    const m = /^(~?)([A-Z])$/.exec(sym);
    const nl = letterOf.get(vid);
    if (m && nl) syms.set(vid, m[1] + nl);
  }

  const out: CharEntry[] = [];
  const punct = (ch: string) => out.push({ ch, vertexIds: [] });
  const tok   = (t: Token)   => out.push({ ch: t.symbol, vertexIds: t.vertexIds, edgeId: t.edgeId });

  subs.forEach(({ layout }, si) => {
    if (si > 0) { punct(' '); punct('⊕'); punct(' '); }
    punct('[');
    layout.forEach((region, ri) => {
      if (ri > 0) punct('|');
      region.forEach((bnd, bi) => {
        if (bi > 0) punct(',');
        for (const t of bnd) tok(t);
      });
    });
    punct(']');
  });

  return {
    text: out.map(e => e.ch).join(''),
    charInfo: out.map(e => ({ vertexIds: e.vertexIds, edgeId: e.edgeId })),
  };
}

// ---------------------------------------------------------------------------
// Move resolution: engine MoveInfo (abstract component/region/boundary/i/j
// indices, on the *decompressed* canonical position) -> live VertexIds
// ---------------------------------------------------------------------------

export interface ResolvedMoveVertices {
  v1: VertexId;
  v2: VertexId;
  edgeId1?: EdgeId;
  edgeId2?: EdgeId;
  /**
   * Enclosure only: one representative vertex per "other" boundary of the
   * region that the engine's `mask` places on the lo→hi (L) side — i.e. the
   * live equivalent of moveCode.ts's buildBrackets output, so ResolvedMove.brackets
   * can be filled in and strokeSynthesis's bracket-aware candidates (which
   * need to know what must end up enclosed) can be used for move-preview.
   */
  brackets?: VertexId[];
}

/** Total token count across a region's boundaries (post-compression). */
function reprTokenCount(r: RegionRepr): number {
  return r.boundaries.reduce((s, b) => s + b.length, 0);
}

/**
 * Same grouping+ordering serialize() applies (activeSubpos filter/sort, region
 * sort within a subpos), but returning index-tagged entries instead of mutating
 * `reprs` in place, so a caller can look up "the Nth region of the Mth
 * subposition" against the *original* reprs array position.
 */
function orderedActiveRegions(
  reprs: RegionRepr[],
  subposCount: number,
): Array<Array<{ origIdx: number; repr: RegionRepr }>> {
  const bySubpos: Map<number, Array<{ origIdx: number; repr: RegionRepr }>> = new Map();
  for (let si = 0; si < subposCount; si++) bySubpos.set(si, []);
  reprs.forEach((r, origIdx) => {
    if (!r.deleted) bySubpos.get(r.subposIdx)?.push({ origIdx, repr: r });
  });

  const totalTokens = (rs: Array<{ repr: RegionRepr }>) =>
    rs.reduce((s, e) => s + reprTokenCount(e.repr), 0);

  const activeSubpos = [...bySubpos.values()]
    .filter(rs => rs.length > 0)
    .sort((a, b) => {
      const rc = a.length - b.length;
      if (rc !== 0) return rc;
      return totalTokens(a) - totalTokens(b);
    });

  return activeSubpos.map(entries => {
    const sorted = [...entries].sort((a, b) => {
      const bc = a.repr.boundaries.length - b.repr.boundaries.length;
      if (bc !== 0) return bc;
      return reprTokenCount(a.repr) - reprTokenCount(b.repr);
    });
    return sorted.filter(e => e.repr.boundaries.some(b => b.length > 0));
  });
}

/**
 * Like canonicalize(), but also returns the winning rotation's start offset. Uses
 * the same lettered boundaryRotationKey so the compressed rotation this picks (and
 * the decompressed offset resolveDecompressedRegion derives from it) lines up with
 * the rotation serialize() emits — sharing the all-membrane tie-break fix so the
 * move-code path resolves the same boundary rotation the encoding shows.
 */
function canonicalizeWithOffset(tokens: Token[]): { tokens: Token[]; start: number } {
  const n = tokens.length;
  if (n <= 1) return { tokens: normalizeJointSides([...tokens]), start: 0 };

  const rotated = (start: number): Token[] =>
    normalizeJointSides([...tokens.slice(start), ...tokens.slice(0, start)]);

  let best = rotated(0);
  let bestKey = boundaryRotationKey(best);
  let bestStart = 0;
  for (let i = 1; i < n; i++) {
    const rot = rotated(i);
    const key = boundaryRotationKey(rot);
    if (key < bestKey) { best = rot; bestKey = key; bestStart = i; }
  }
  return { tokens: best, start: bestStart };
}

/** Cyclic rotation of an array, left-shifted by `offset` (mod length). */
function rotateArray<T>(arr: T[], offset: number): T[] {
  const n = arr.length;
  if (n === 0) return [];
  const k = ((offset % n) + n) % n;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

/**
 * Resolve which live boundary (in its move-playing, pre-compression form,
 * rotated to line up with the compressed canonical rotation) corresponds to
 * region `regionFinalIdx` of subposition `component`, boundary `boundaryFinalIdx`
 * — all in the engine's canonical (post-sort, post-rotate) numbering. Returns
 * null if the position can't be resolved (bad indices, or the target boundary
 * was itself collapsed by compression down to a single pseudo-token, which
 * has no live two-endpoint identity to expand from — a rare edge case not
 * handled here).
 */
function resolveDecompressedBoundary(
  state: GameState,
  component: number,
  regionFinalIdx: number,
  boundaryFinalIdx: number,
): Token[] | null {
  const region = resolveDecompressedRegion(state, component, regionFinalIdx);
  if (!region) return null;
  return region[boundaryFinalIdx] ?? null;
}

/**
 * Like resolveDecompressedBoundary, but returns every boundary of the region
 * (in the engine's canonical final-sorted order), each already expanded to
 * its live decompressed form. Used both by resolveDecompressedBoundary (picks
 * one) and by resolveMoveVertices' Enclosure handling, which needs the whole
 * region to translate an engine `mask` into a live bracket-set (see
 * applyEnclosure's b2 loop in stalks/src/moves.cpp — mask bit order walks the
 * region's boundaries in this same final-sorted order, skipping the move's
 * own boundary).
 */
function resolveDecompressedRegion(
  state: GameState,
  component: number,
  regionFinalIdx: number,
): Token[][] | null {
  const types = new Map<VertexId, VertexType>();
  for (const v of state.vertices.values()) {
    if (v.isPseudo) continue;
    types.set(v.id, classifyVertexFull(v.id, state));
  }
  const membraneLetters = assignMembraneLetters(state, types);

  const reprsDecompressed = buildRegionReprs(state, types, membraneLetters);
  const reprsCompressed = buildRegionReprs(state, types, membraneLetters);
  applyAllCompressions(reprsCompressed, new Map());

  const subposCount = state.subpositions.length;
  const orderedSubpos = orderedActiveRegions(reprsCompressed, subposCount);
  const regions = orderedSubpos[component];
  if (!regions) return null;
  const target = regions[regionFinalIdx];
  if (!target) return null;

  const { origIdx: regionOrigIdx, repr: compressedRepr } = target;
  const decompressedRepr = reprsDecompressed[regionOrigIdx];
  if (!decompressedRepr) return null;

  // Boundaries within a region: canonicalize (rotate) each, then sort by key —
  // same as serialize(), but tracking the original boundary index + rotation start.
  const boundaryEntries = compressedRepr.boundaries.map((tokens, bi) => {
    const { tokens: rotated, start } = canonicalizeWithOffset(tokens);
    return { bi, rotated, start, key: boundaryKey(rotated) };
  });
  boundaryEntries.sort((a, b) => a.key.localeCompare(b.key));

  return boundaryEntries.map(entry => {
    const unrotatedCompressed = compressedRepr.boundaries[entry.bi];
    const decompressedOrig = decompressedRepr.boundaries[entry.bi];
    if (!unrotatedCompressed || !decompressedOrig) return [];

    // Compressed token groupSizes (pre-rotation order) map 1:1 onto contiguous
    // runs of the decompressed boundary (compression only ever collapses
    // adjacent tokens within one boundary, never reorders/merges boundaries).
    let decompressedOffset = 0;
    for (let k = 0; k < entry.start; k++) {
      decompressedOffset += unrotatedCompressed[k]?.vertexIds.length ?? 1;
    }
    return rotateArray(decompressedOrig, decompressedOffset);
  });
}

/**
 * Translate an engine MoveInfo (component/region/boundary/i/j indices, on the
 * decompressed canonical position derived from `state`'s current encoding)
 * into the live VertexIds it refers to, so the caller can synthesize/play the
 * move (see src/model/recreate.ts's stroke synthesis). Returns null when the
 * move can't be resolved (InteriorPseudo moves have no two-endpoint identity;
 * bad indices; or the boundary landed on an unhandled compression edge case).
 */
export function resolveMoveVertices(state: GameState, move: MoveInfo): ResolvedMoveVertices | null {
  if (move.kind === MoveKind.InteriorPseudo) return null; // no drawable endpoint pair

  if (move.kind === MoveKind.Enclosure) {
    const region = resolveDecompressedRegion(state, move.component, move.region);
    if (!region) return null;
    const boundary = region[move.boundary];
    if (!boundary) return null;
    const t1 = boundary[move.i];
    const t2 = boundary[move.j];
    if (!t1 || !t2) return null;
    const v1 = t1.vertexIds[0];
    const v2 = t2.vertexIds[0];
    if (v1 === undefined || v2 === undefined) return null;

    // mask bit order walks the region's other boundaries (skipping
    // move.boundary) in the same final-sorted order as `region` itself — see
    // applyEnclosure's b2 loop in stalks/src/moves.cpp. Bit clear (0) means
    // the boundary stays on the L (lo->hi arc) side, matching buildBrackets'
    // "min vertex of each sub-boundary on the lo->hi side" convention.
    const brackets: VertexId[] = [];
    let bit = 0;
    for (let bi = 0; bi < region.length; bi++) {
      if (bi === move.boundary) continue;
      const other = region[bi];
      if (other && other.length > 0 && !((move.mask >> bit) & 1)) {
        const min = Math.min(...other.flatMap(t => t.vertexIds));
        if (Number.isFinite(min)) brackets.push(min);
      }
      bit++;
    }

    return { v1, v2, edgeId1: t1.edgeId, edgeId2: t2.edgeId, brackets };
  }

  // Join: b1/b2 are boundary indices (same final-sorted numbering as `boundary`
  // above), i/j are token indices within b1/b2 respectively.
  const boundary1 = resolveDecompressedBoundary(state, move.component, move.region, move.b1);
  const boundary2 = resolveDecompressedBoundary(state, move.component, move.region, move.b2);
  if (!boundary1 || !boundary2) return null;
  const t1 = boundary1[move.i];
  const t2 = boundary2[move.j];
  if (!t1 || !t2) return null;
  const v1 = t1.vertexIds[0];
  const v2 = t2.vertexIds[0];
  if (v1 === undefined || v2 === undefined) return null;
  return { v1, v2, edgeId1: t1.edgeId, edgeId2: t2.edgeId };
}
