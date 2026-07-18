/**
 * Tracked-encoding controller (wiring pass of the encoding/canon rework — see
 * project_encoding_canon_rework). Ties together the three cores: it holds the persistent
 * OccurrenceMap (M3), applies each live move through the engine (M2 applyMoveTracked), and checks
 * the result against live geometry (M4 checkTopology).
 *
 * It runs in SHADOW MODE: entirely parallel to the existing (working) encoding path, computing and
 * checking without mutating the game. Its only outward effect is the mismatch signal the caller
 * turns into the maroon freeze — and even that is opt-in until the path is trusted.
 *
 * HOW A MOVE IS RESOLVED (self-policing, Catch A). We do NOT derive the enclosure mask or the
 * endpoint sides from geometry directly (fragile). Instead we enumerate the small candidate space —
 * the parent token(s) each endpoint could be, times every enclosure mask — apply each through the
 * engine, and let the M4 face-set check pick the candidate whose tracked child matches the live
 * geometry. The correct move is the one that matches; a genuine topology error matches nothing
 * (mismatch → maroon). This both finds the move and validates the engine child against geometry in
 * one step, with no new sphere geometry code. Multiple matches mean an automorphism (Catch E) — the
 * survivors are interchangeable, so any is fine for carrying the map forward.
 */
import {
  applyMoveTracked,
  MoveKind,
  GEN_SRC,
  type MoveDescriptor,
} from './stalks';
import {
  seedFreshGame,
  seedFromGeometry,
  carryForward,
  tokenLocsForVertex,
  regionBoundaryCount,
  charInfoForMap,
  OccIdAllocator,
  type OccurrenceMap,
  type CharBinding,
} from './occurrenceMap';
import { translateMove, type LiveMoveResolved, type TokenLoc } from './moveTranslation';
import { checkTopology } from './faceCheck';
import type { GameState, VertexId } from '../model/types';

/** Guard against pathological candidate blow-up (a region with very many boundaries). Real Sprouts
 *  regions have a handful; beyond this the check is skipped rather than enumerating 2^n masks. */
const MAX_MASK_BITS = 10;

export type TrackedStatus = 'match' | 'mismatch' | 'indeterminate' | 'desynced' | 'disabled';

export interface TrackedResult {
  status: TrackedStatus;
  /** The believed child encoding (on 'match') or the last good encoding (otherwise). */
  enc: string | null;
  /** Diagnostics for the M5 error panel on a mismatch. */
  engineKey?: string;
  geometryKey?: string;
  /** Per-character binding for `enc` — on a mismatch this belongs to the believed CHILD (below), not
   *  the authoritative map, so the panel can hover it. Absent on match (caller uses the live map). */
  charInfo?: CharBinding[];
  /** Number of candidate descriptors that matched geometry (>1 ⇒ automorphism). */
  matchCount?: number;
}

export class TrackedGame {
  private alloc = new OccIdAllocator();
  private map: OccurrenceMap | null = null;
  private desynced = false;

  /** True once a move-tracked child has been computed; lets the caller show the believed encoding. */
  get encoding(): string | null {
    return this.map?.enc ?? null;
  }
  get isDesynced(): boolean {
    return this.desynced;
  }

  /**
   * Per-character vertex binding for the believed encoding (`encoding`), for the M5 error panel's
   * digit-hover→wedge highlight. Empty when there is no map yet. On a mismatch the map still holds
   * the last agreed position, so this highlights what the engine believes vs the diverged board.
   */
  charInfo(): CharBinding[] {
    return this.map ? charInfoForMap(this.map) : [];
  }

  /** Seed for a fresh n-spot game. `spotVertexIds` are the live spot ids (any order). */
  reset(spotVertexIds: VertexId[]): void {
    this.alloc = new OccIdAllocator();
    this.map = seedFreshGame(spotVertexIds, this.alloc);
    this.desynced = false;
  }

  /**
   * A move has settled (all pops quiescent). `settled` is the current GameState; `v1`/`v2` are the
   * move's live endpoints; `newVertexIds` are vertices present after the move but not before (the
   * generated midpoint — 0 or 1 of them). Resolves the move via the engine + face check, advances
   * the map on a match, and returns the outcome. Async (awaits the WASM module); safe to
   * fire-and-forget.
   */
  async onMoveSettled(
    settled: GameState,
    v1: VertexId,
    v2: VertexId,
    newVertexIds: Set<VertexId>,
  ): Promise<TrackedResult> {
    if (this.desynced || this.map === null) {
      return { status: this.map === null ? 'disabled' : 'desynced', enc: this.map?.enc ?? null };
    }
    const parent = this.map;

    const locs1 = tokenLocsForVertex(parent, v1);
    const locs2 = tokenLocsForVertex(parent, v2);
    if (locs1.length === 0 || locs2.length === 0) {
      this.desynced = true;
      return { status: 'desynced', enc: parent.enc };
    }

    // The move creates exactly one new vertex (the midpoint W); collapses only delete. If it
    // survived settling it is here, else the engine child has no generated token either.
    const midpoint: VertexId | undefined =
      newVertexIds.size === 1 ? [...newVertexIds][0] : undefined;

    const descriptors = this.enumerateDescriptors(parent, locs1, locs2);
    if (descriptors === null) {
      return { status: 'indeterminate', enc: parent.enc }; // too many masks; skip this move
    }

    let winner: OccurrenceMap | null = null;
    let winnerKeys: { engineKey: string; geometryKey: string } | null = null;
    let matchCount = 0;
    let lastEngineKey = '';
    let lastGeometryKey = '';

    for (const d of descriptors) {
      const res = await applyMoveTracked(parent.enc, parent.posSrc, d);
      if (!res.ok) continue;
      // A generated token needs the surviving midpoint; if none survived this candidate can't be it.
      if (midpoint === undefined && flatHasGen(res.child.src)) continue;
      const childMap = carryForward(parent, res.child, midpoint ?? -1, this.alloc);
      const check = checkTopology(childMap, settled);
      lastEngineKey = check.engineKey;
      lastGeometryKey = check.geometryKey;
      if (check.ok) {
        matchCount++;
        if (winner === null) {
          winner = childMap;
          winnerKeys = { engineKey: check.engineKey, geometryKey: check.geometryKey };
        }
      }
    }

    if (winner !== null) {
      this.map = winner;
      return { status: 'match', enc: winner.enc, matchCount, ...winnerKeys! };
    }

    // Nothing matched — a genuine topology divergence (or a resolution we can't express yet). For
    // the M5 error panel, compute the engine's believed CHILD for the move as geometry describes it
    // (translateMove with a geometry-derived enclosed set) so the panel's encoding, hover binding,
    // and face-key all describe the SAME position — instead of the stale parent. This is display-
    // only: the authoritative map does not advance (we stay desynced).
    this.desynced = true;
    const believed = await this.believedChild(parent, locs1, locs2, midpoint, settled);
    return {
      status: 'mismatch',
      enc: believed?.enc ?? parent.enc,
      charInfo: believed?.charInfo,
      engineKey: believed?.engineKey ?? lastEngineKey,
      geometryKey: believed?.geometryKey ?? lastGeometryKey,
      matchCount: 0,
    };
  }

  /**
   * The engine's believed child for the move as the live geometry describes it: resolve the two
   * endpoints against the parent map, derive the enclosed-boundary set from geometry (Catch A), run
   * it through translateMove + the engine, and carry the map forward — all for DISPLAY only (the
   * authoritative map is untouched). Returns the child enc, its per-character hover binding, and the
   * engine/geometry face-keys (all consistent). Null if the move can't be expressed (e.g. a
   * self-connect whose midpoint didn't survive, or an endpoint the map no longer knows).
   */
  private async believedChild(
    parent: OccurrenceMap,
    locs1: TokenLoc[],
    locs2: TokenLoc[],
    midpoint: VertexId | undefined,
    settled: GameState,
  ): Promise<{ enc: string; charInfo: CharBinding[]; engineKey: string; geometryKey: string } | null> {
    // Best-effort endpoint resolution: the first token each vertex owns. Single-token vertices
    // (spot/appendage/scab) are unambiguous; a multi-token vertex (membrane/joint) picks its first
    // occurrence, which is a reasonable guess for a diagnostic.
    const l1 = locs1[0];
    const l2 = locs2[0];
    if (l1.component !== l2.component || l1.region !== l2.region) return null;

    let move: LiveMoveResolved;
    if (l1.boundary === l2.boundary) {
      if (midpoint === undefined) return null; // self-connect with no surviving midpoint — can't express
      const enclosedOtherBoundaries = deriveEnclosedBoundaries(parent, settled, l1, midpoint);
      move = { end1: l1, end2: l2, enclosedOtherBoundaries };
    } else {
      move = { end1: l1, end2: l2, enclosedOtherBoundaries: new Set() };
    }

    let descriptor: MoveDescriptor;
    try {
      descriptor = translateMove(move, (c, r) => regionBoundaryCount(parent, c, r));
    } catch {
      return null;
    }
    const res = await applyMoveTracked(parent.enc, parent.posSrc, descriptor);
    if (!res.ok) return null;
    const map = carryForward(parent, res.child, midpoint ?? -1, this.alloc);
    const check = checkTopology(map, settled);
    return { enc: map.enc, charInfo: charInfoForMap(map), engineKey: check.engineKey, geometryKey: check.geometryKey };
  }

  /** Any subsequent-move context (undo, load, external mutation) invalidates the forward map. */
  markDesynced(): void {
    this.desynced = true;
  }

  /**
   * Catch-D for LOAD: reseed the map from whatever geometry a loaded save restored, instead of
   * giving up with `markDesynced()`. Unlike undo's `resyncTrackedFromHistory` (main.ts), this does
   * NOT replay move history — a loaded save only has final geometry, no intermediate per-move states
   * — it seeds fresh from that final geometry via `seedFromGeometry` (occurrenceMap.ts), the same
   * engine-canonicalize-and-trace pipeline the Position Browser's hover-over row already uses. A
   * subsequent real move carries forward from this seed exactly as it would from a fresh game.
   * Returns true and un-desyncs on success; on failure (module not loaded / canonicalization
   * error) marks desynced and returns false, same fallback shape as the fresh-game path elsewhere.
   */
  seedFromState(state: GameState): boolean {
    this.alloc = new OccIdAllocator();
    const map = seedFromGeometry(state, this.alloc);
    if (map === null) {
      this.map = null;
      this.desynced = true;
      return false;
    }
    this.map = map;
    this.desynced = false;
    return true;
  }

  /**
   * Candidate move descriptors for endpoints at `locs1`/`locs2`. Same boundary of one region →
   * Enclosure over every mask (and both endpoint orders); different boundaries of one region →
   * Join (both orders). Returns null if any enclosure region has too many other boundaries.
   */
  private enumerateDescriptors(
    map: OccurrenceMap,
    locs1: { component: number; region: number; boundary: number; token: number }[],
    locs2: { component: number; region: number; boundary: number; token: number }[],
  ): MoveDescriptor[] | null {
    const out: MoveDescriptor[] = [];
    for (const l1 of locs1) {
      for (const l2 of locs2) {
        if (l1.component !== l2.component || l1.region !== l2.region) continue;
        const component = l1.component;
        const region = l1.region;
        if (l1.boundary === l2.boundary) {
          const nOther = Math.max(0, regionBoundaryCount(map, component, region) - 1);
          if (nOther > MAX_MASK_BITS) return null;
          const boundary = l1.boundary;
          for (let mask = 0; mask < 1 << nOther; mask++) {
            out.push({ kind: MoveKind.Enclosure, component, region, boundary, i: l1.token, j: l2.token, mask });
            if (l1.token !== l2.token)
              out.push({ kind: MoveKind.Enclosure, component, region, boundary, i: l2.token, j: l1.token, mask });
          }
        } else {
          out.push({ kind: MoveKind.Join, component, region, b1: l1.boundary, b2: l2.boundary, i: l1.token, j: l2.token });
          out.push({ kind: MoveKind.Join, component, region, b1: l2.boundary, b2: l1.boundary, i: l2.token, j: l1.token });
        }
      }
    }
    return out;
  }
}

/** True if any token in the provenance is a generated (GEN_SRC) token. */
function flatHasGen(src: number[][][][]): boolean {
  for (const c of src) for (const r of c) for (const b of r) for (const t of b) if (t === GEN_SRC) return true;
  return false;
}

/**
 * Which of the enclosure's region — other than the endpoints' own boundary — the drawn loop traps on
 * the enclosed side, as parent-boundary indices (the input translateMove packs into the mask). Read
 * from the settled geometry: the move split the parent region into the two live regions incident to
 * the generated midpoint W; the enclosed side is the one that is not the outer region. A parent
 * boundary is enclosed iff every live vertex it owns lies on that enclosed region's boundary loops
 * (an untouched boundary bounds exactly one of the two split regions).
 *
 * This is a best-effort DIAGNOSTIC used only after a mismatch: which of the two sides is "enclosed"
 * can be off by the complementary mask when neither side is the outer region — acceptable, since the
 * position already diverged. The authoritative match path never uses this (it enumerates all masks).
 */
function deriveEnclosedBoundaries(
  parent: OccurrenceMap,
  state: GameState,
  end: TokenLoc,
  midpoint: VertexId,
): Set<number> {
  const { component: c, region: rgn, boundary: be } = end;
  const regionSrc = parent.posSrc[c]?.[rgn];
  if (!regionSrc) return new Set();

  // The two live regions on either side of the loop both include the midpoint in a boundary walk.
  const incident = [...state.regions.values()].filter(
    r => !r.isDead && r.boundaries.some(b => b.entries.some(e => e.vertexId === midpoint)),
  );
  if (incident.length === 0) return new Set();
  const enclosed = incident.find(r => !r.isOuter) ?? incident[0];

  const enclosedVerts = new Set<VertexId>();
  for (const b of enclosed.boundaries) for (const e of b.entries) enclosedVerts.add(e.vertexId);

  const out = new Set<number>();
  for (let bi = 0; bi < regionSrc.length; bi++) {
    if (bi === be) continue;
    const verts = regionSrc[bi]
      .map(occ => parent.vertexOf.get(occ))
      .filter((v): v is VertexId => v !== undefined);
    if (verts.length > 0 && verts.every(v => enclosedVerts.has(v))) out.add(bi);
  }
  return out;
}
