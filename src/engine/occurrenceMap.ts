/**
 * Persistent occurrence map (milestone M3 of the encoding/canon rework — see
 * project_encoding_canon_rework).
 *
 * The rework stops deriving the encoding from geometry: the engine computes the decompressed-
 * canonical child from a move (applyMoveTracked), and this map is the bijection that lets the
 * frontend keep talking in live VertexIds. It is carried FORWARD move by move — never re-derived
 * from geometry — so a live vertex can always be located in the current canonical encoding, and a
 * canonical token can always be traced back to the live vertex it belongs to.
 *
 * KEY = OCCURRENCE, NOT VERTEX (Catch F). A single vertex owns a variable number of tokens: a spot
 * or appendage or scab owns one, a membrane owns two (one per region side), a joint owns two (its
 * two visits in one boundary). That count CHANGES across a move — e.g. a spot that self-connects
 * becomes a membrane, one occurrence becoming two. So identity is threaded per token via an opaque
 * OccId stamped into the engine's `src` channel: the engine carries each parent OccId onto every
 * child token that descends from it, and reports GEN_SRC for the tokens the move generated. The
 * frontend owns the OccId -> VertexId table.
 *
 * WHAT THIS MODULE OWNS vs. DEFERS. It reliably carries the VERTEX behind each token forward with no
 * geometry input at all. It does NOT bind a canonical token to its live geometric SIDE (which
 * region / outgoing edge — the `edgeId` half of charInfo); a canonical child's token ordering has no
 * inherent tie to the live embedding. That side binding is established by the M4 face-set match,
 * which zips engine regions against live-geometry faces over the shared VertexId set. Until then,
 * `tokenLocsForVertex` returns every token a vertex owns; a single-token vertex (spot/appendage/
 * scab) is unambiguous, which already covers every move whose endpoints are such vertices.
 */
import { GEN_SRC, canonicalizeTrackedProvenanceSync, type PosSrc } from './stalks';
import type { TokenLoc } from './moveTranslation';
import { encodePositionDecompressed } from '../model/encoding';
import type { GameState, VertexId } from '../model/types';

/** Opaque per-occurrence handle stamped into the engine `src` channel. Non-negative (GEN_SRC=-2,
 *  UNTRACKED=-1 are reserved), so it never collides with the sentinels. */
export type OccId = number;

/**
 * The occurrence map for one position: the decompressed-canonical encoding, the provenance channel
 * stamped with THIS position's OccIds (fed straight back into applyMoveTracked as the parent
 * `src`), and the per-occurrence bookkeeping.
 */
export interface OccurrenceMap {
  /** Decompressed-canonical encoding this map is parallel to. */
  enc: string;
  /** [component][region][boundary][token] of OccIds — the parent `src` for the next move. */
  posSrc: PosSrc;
  /** OccId -> the live vertex that token belongs to. */
  vertexOf: Map<OccId, VertexId>;
  /** OccId -> the parent OccId it descended from, or GEN_SRC for a generated token. */
  parentOf: Map<OccId, OccId>;
  /** VertexId -> the token locations it owns (one per occurrence). */
  locsOf: Map<VertexId, TokenLoc[]>;
  /** TokenLoc (as `${c}.${r}.${b}.${k}`) -> OccId, for reverse lookup. */
  occAt: Map<string, OccId>;
}

/** Allocates monotonically-increasing non-negative OccIds across a game's whole move sequence. */
export class OccIdAllocator {
  private next = 0;
  alloc(): OccId {
    return this.next++;
  }
}

const locKey = (c: number, r: number, b: number, k: number) => `${c}.${r}.${b}.${k}`;

/**
 * Build the bookkeeping (vertexOf/locsOf/occAt) for a posSrc already stamped with OccIds, given the
 * vertex behind each OccId. Shared by seeding and carry-forward.
 */
function indexPosSrc(
  enc: string,
  posSrc: PosSrc,
  vertexOf: Map<OccId, VertexId>,
  parentOf: Map<OccId, OccId>,
): OccurrenceMap {
  const locsOf = new Map<VertexId, TokenLoc[]>();
  const occAt = new Map<string, OccId>();
  for (let c = 0; c < posSrc.length; c++) {
    for (let r = 0; r < posSrc[c].length; r++) {
      for (let b = 0; b < posSrc[c][r].length; b++) {
        for (let k = 0; k < posSrc[c][r][b].length; k++) {
          const occ = posSrc[c][r][b][k];
          occAt.set(locKey(c, r, b, k), occ);
          const vid = vertexOf.get(occ);
          if (vid === undefined) continue; // GEN with no vertex yet shouldn't happen post-resolve
          const loc: TokenLoc = { component: c, region: r, boundary: b, token: k };
          (locsOf.get(vid) ?? locsOf.set(vid, []).get(vid)!).push(loc);
        }
      }
    }
  }
  return { enc, posSrc, vertexOf, parentOf, locsOf, occAt };
}

/**
 * Seed the map for a fresh n-spot game. The canonical decompressed encoding is one component, one
 * region, with one spot boundary ("0") per spot: e.g. 3 spots -> "0,0,0". Spot boundaries are laid
 * out in the given VertexId order; each spot is a single occurrence.
 */
export function seedFreshGame(spotVertexIds: VertexId[], alloc: OccIdAllocator): OccurrenceMap {
  const enc = spotVertexIds.map(() => '0').join(',');
  const boundaries: number[][] = [];
  const vertexOf = new Map<OccId, VertexId>();
  const parentOf = new Map<OccId, OccId>();
  for (const vid of spotVertexIds) {
    const occ = alloc.alloc();
    vertexOf.set(occ, vid);
    parentOf.set(occ, GEN_SRC); // no parent — original spots
    boundaries.push([occ]);
  }
  // One component (index 0), one region (index 0), with `boundaries` each a single spot token.
  const posSrc: PosSrc = [[boundaries]];
  return indexPosSrc(enc, posSrc, vertexOf, parentOf);
}

/**
 * Seed the map from ANY current live state (Catch-D for LOAD) — not just a fresh n-spot game, using
 * the same engine pipeline the Position Browser's hover-over canon row (M6, 2026-07-16) already
 * relies on: `encodePositionDecompressed` gives a valid (not necessarily canonical) decompressed
 * encoding with per-char vertex provenance; `canonicalizeTrackedProvenanceSync` canonicalizes it and
 * traces every canonical output token back to the input token it descends from — no move history
 * required. Returns null if the WASM module isn't loaded yet or canonicalization fails; the caller
 * should fall back to `markDesynced()` in that case (same fallback shape as `canonSync` elsewhere).
 */
export function seedFromGeometry(state: GameState, alloc: OccIdAllocator): OccurrenceMap | null {
  const decomposed = encodePositionDecompressed(state);
  const tracked = canonicalizeTrackedProvenanceSync(decomposed.text);
  if (!tracked) return null;

  // `tracked.src` indexes are TOKEN-sequential over the C++ parse walk, which skips punctuation
  // ('[',']','|',',',' ','⊕') — pre-filter decomposed's per-char bindings down to a punctuation-free,
  // token-sequential view before indexing by src (the same two gotchas the hover-over fix hit: see
  // project_encoding_canon_rework's M6 "CONTINUED (2026-07-16)" section).
  const decomposedTokens = decomposed.text
    .split('')
    .map((ch, i) => ({ ch, info: decomposed.charInfo[i] }))
    .filter(({ ch }) => !'[]|, ⊕'.includes(ch))
    .map(({ info }) => info);

  // Walk `tracked.enc` in the ENGINE's own separator convention (stalks::serialize: components
  // joined by '+', regions by '|', boundaries by ',', no brackets/⊕ — those are a TS display-only
  // convention parsePosition tolerates but never emits) to recover the nested
  // [component][region][boundary][token] shape posSrc must mirror, minting a fresh OccId per token.
  const vertexOf = new Map<OccId, VertexId>();
  const parentOf = new Map<OccId, OccId>();
  const posSrc: PosSrc = [];
  let srcIdx = 0;
  for (const compText of tracked.enc.split('+')) {
    if (compText === 'N') { posSrc.push([]); continue; } // fully-dead component: no tokens
    const regions: number[][][] = [];
    for (const regionText of compText.split('|')) {
      const boundaries: number[][] = [];
      for (const boundaryText of regionText.split(',')) {
        const tokens: number[] = [];
        for (let k = 0; k < boundaryText.length; k++) {
          const info = decomposedTokens[tracked.src[srcIdx++]];
          const vid = info?.vertexIds[0];
          if (vid === undefined) return null; // shouldn't happen; caller falls back to markDesynced
          const occ = alloc.alloc();
          vertexOf.set(occ, vid);
          parentOf.set(occ, GEN_SRC); // seeded fresh — no parent
          tokens.push(occ);
        }
        boundaries.push(tokens);
      }
      regions.push(boundaries);
    }
    posSrc.push(regions);
  }
  return indexPosSrc(tracked.enc, posSrc, vertexOf, parentOf);
}

/**
 * Carry the map forward across one move. `child` is the result of applyMoveTracked(parent.enc,
 * parent.posSrc, move): its `src` channel holds, per child token, the PARENT OccId it descended
 * from (or GEN_SRC for a token the move generated — the new midpoint vertex). Fresh child OccIds are
 * minted for every child token so the returned map can seed the NEXT move; each records the vertex
 * it belongs to (the parent occurrence's vertex, or `midpointVertexId` for a generated token) and
 * the parent OccId it came from.
 */
export function carryForward(
  parent: OccurrenceMap,
  child: { enc: string; src: PosSrc },
  midpointVertexId: VertexId,
  alloc: OccIdAllocator,
): OccurrenceMap {
  const vertexOf = new Map<OccId, VertexId>();
  const parentOf = new Map<OccId, OccId>();
  const childSrc = child.src;
  const newPosSrc: PosSrc = childSrc.map(comp =>
    comp.map(region =>
      region.map(boundary =>
        boundary.map(parentOcc => {
          const childOcc = alloc.alloc();
          const vid =
            parentOcc === GEN_SRC ? midpointVertexId : parent.vertexOf.get(parentOcc);
          if (vid === undefined) {
            throw new Error(
              `carryForward: child token references unknown parent occurrence ${parentOcc}`,
            );
          }
          vertexOf.set(childOcc, vid);
          parentOf.set(childOcc, parentOcc);
          return childOcc;
        }),
      ),
    ),
  );
  return indexPosSrc(child.enc, newPosSrc, vertexOf, parentOf);
}

/**
 * Token locations a live vertex owns in this position (one per occurrence). Empty if the vertex is
 * not present (e.g. consumed by a move). A single-element result is an unambiguous endpoint; a
 * multi-element result (membrane/joint) needs a side hint from the M4 face match to pick the token
 * a specific stroke leaves from.
 */
export function tokenLocsForVertex(map: OccurrenceMap, vid: VertexId): TokenLoc[] {
  return map.locsOf.get(vid) ?? [];
}

/** Boundary count of region `r` of component `c`, read straight off the provenance shape. Feeds
 *  translateMove's enclosure-mask layout. */
export function regionBoundaryCount(map: OccurrenceMap, component: number, region: number): number {
  return map.posSrc[component]?.[region]?.length ?? 0;
}

/** Per-character vertex binding, aligned to `map.enc` (the shape `charInfo` uses for hover). */
export interface CharBinding {
  /** The live vertices this character's token belongs to (one for a token, empty for a separator). */
  vertexIds: VertexId[];
}

/**
 * The occurrence->vertex binding for the believed encoding, as a per-character array parallel to
 * `map.enc` — the M5 hover channel (Catch F). Each non-separator character is exactly one canonical
 * token (the serializer emits one char per token), so we walk the tokens of `posSrc` in
 * [component][region][boundary][token] order — the same order serialize concatenates them — and pair
 * each with the next non-separator char. Separators (',' '|' '+') carry no token, so they get an
 * empty binding. This needs no face match: `vertexOf` already knows the live vertex behind every
 * occurrence, which is precisely what hover highlighting wants.
 */
export function charInfoForMap(map: OccurrenceMap): CharBinding[] {
  const flat: OccId[] = [];
  for (const comp of map.posSrc)
    for (const region of comp)
      for (const boundary of region) for (const occ of boundary) flat.push(occ);

  const out: CharBinding[] = [];
  let ti = 0;
  for (const ch of map.enc) {
    if (ch === ',' || ch === '|' || ch === '+') {
      out.push({ vertexIds: [] });
      continue;
    }
    const occ = flat[ti++];
    const vid = occ !== undefined ? map.vertexOf.get(occ) : undefined;
    out.push({ vertexIds: vid !== undefined ? [vid] : [] });
  }
  return out;
}
