/**
 * Forward-translation: turn a live drawn move into a Stalks MoveDescriptor in the PARENT's
 * decompressed-canonical index space, so the engine can compute the child (see
 * project_encoding_canon_rework, milestone M2).
 *
 * The engine indexes a move by component/region/boundary/endpoint, not by live VertexId. This
 * module is the seam between the two: given the two endpoints already resolved to their token
 * locations in the parent's decompressed-canonical serialization (that resolution is the job of the
 * maintained parent occurrence map — milestone M3), it decides Enclosure vs Join and, for an
 * enclosure, packs the geometry-derived enclosed-boundary set into the engine's `mask`.
 *
 * The enclosed-boundary set is the ONE place geometry still feeds into a move (Catch A): which of
 * the region's other boundaries the drawn loop traps on the appended side is read from the live
 * embedding. A wrong set yields a faithfully-wrong child, which the downstream face-set check
 * catches — this layer never second-guesses it.
 */
import { MoveKind, type MoveDescriptor } from './stalks';

/** Location of one endpoint token within the parent's decompressed-canonical serialization. */
export interface TokenLoc {
  component: number;
  region: number;
  boundary: number;
  /** Index of the token within its boundary (the engine's endpoint index i/j). */
  token: number;
}

/**
 * A live move resolved against the maintained parent map. `end1`/`end2` are the two endpoints'
 * token locations; a self-connecting loop has both on the same boundary (and possibly the same
 * token). `enclosedOtherBoundaries` holds the parent-boundary indices of the move's region — other
 * than the endpoints' own boundary — that the drawn loop encloses on the appended (arc2) side.
 * Derived from geometry; ignored for a Join (the region is fused, not split).
 */
export interface LiveMoveResolved {
  end1: TokenLoc;
  end2: TokenLoc;
  enclosedOtherBoundaries: Set<number>;
}

/**
 * Pack an enclosure `mask`: bit k is set iff the k-th "other" boundary of the region (all boundary
 * indices except `boundary`, taken in ascending index order) is enclosed on the appended side. This
 * mirrors the engine's bit convention in moves.hpp `Enclosure::mask`.
 */
export function buildEnclosureMask(
  regionBoundaryCount: number,
  boundary: number,
  enclosed: Set<number>,
): number {
  let mask = 0;
  let k = 0;
  for (let bi = 0; bi < regionBoundaryCount; bi++) {
    if (bi === boundary) continue;
    if (enclosed.has(bi)) mask |= 1 << k;
    k++;
  }
  return mask;
}

/**
 * Translate a resolved live move into a MoveDescriptor. Endpoints on the same boundary of one
 * region become an Enclosure (i === j is a legal self-connection); endpoints on two different
 * boundaries of one region become a Join. `regionBoundaryCount` returns how many boundaries the
 * given region of the decompressed-canonical parent has (needed to lay out the enclosure mask
 * bits). Throws if the endpoints are not in the same region.
 */
export function translateMove(
  move: LiveMoveResolved,
  regionBoundaryCount: (component: number, region: number) => number,
): MoveDescriptor {
  const { end1, end2, enclosedOtherBoundaries } = move;

  if (end1.component !== end2.component || end1.region !== end2.region) {
    throw new Error(
      `move endpoints span different regions: ` +
        `(${end1.component},${end1.region}) vs (${end2.component},${end2.region})`,
    );
  }

  const component = end1.component;
  const region = end1.region;

  if (end1.boundary === end2.boundary) {
    const boundary = end1.boundary;
    const mask = buildEnclosureMask(
      regionBoundaryCount(component, region),
      boundary,
      enclosedOtherBoundaries,
    );
    return { kind: MoveKind.Enclosure, component, region, boundary, i: end1.token, j: end2.token, mask };
  }

  return {
    kind: MoveKind.Join,
    component,
    region,
    b1: end1.boundary,
    b2: end2.boundary,
    i: end1.token,
    j: end2.token,
  };
}
