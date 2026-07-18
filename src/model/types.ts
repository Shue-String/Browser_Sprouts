/**
 * Core data model for a Sprouts game.
 *
 * Two parallel layers are maintained:
 *   Geometric  - sphere coordinates and sampled curve points, used for rendering
 *   Combinatorial - regions, boundaries, vertex types, used for game logic
 *
 * IDs are plain numbers assigned sequentially.
 */

import type { SpherePoint } from '../math/sphere';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type VertexId = number;
export type EdgeId   = number;
export type RegionId = number;

/**
 * Presentation-layer spot label: a fixed, certain number once a spot has
 * departed (connected) or its range has narrowed to one, or a still-open
 * range {lo, hi} (lo <= hi, both negative, hi = best/closest to -1) while
 * still symmetric with other spots. See src/model/vertexLabels.ts.
 */
export type SpotLabel = number | { lo: number; hi: number };

/** Grouping info for a spot vertex — see spotGroupInfo in vertexLabels.ts. */
export interface SpotGroupInfo { key: string; sortKey: number; text: string }

// ---------------------------------------------------------------------------
// Vertex types (matching the paper's encoding)
// ---------------------------------------------------------------------------

export enum VertexType {
  Spot       = 'spot',        // degree 0,  encoding: 0
  Appendage  = 'appendage',   // degree 1,  encoding: 1
  Scab       = 'scab',        // degree 2, only one living region side; encoding: 2
  Membrane   = 'membrane',    // degree 2, two distinct living regions; encoding: A-Z
  Joint      = 'joint',       // degree 2, same region on both sides; encoding: 7/8
  Dead       = 'dead',        // degree 3, or isolated degree-2
}

// ---------------------------------------------------------------------------
// Visual state (independent of game-logic type)
// ---------------------------------------------------------------------------

export enum VertexVisualState {
  Active    = 'active',     // full size, selectable
  Saturated = 'saturated',  // small/faded; data still present, blocks connections
}

// ---------------------------------------------------------------------------
// Geometric layer
// ---------------------------------------------------------------------------

export interface Vertex {
  id: VertexId;
  pos: SpherePoint;           // position on unit sphere
  type: VertexType;
  degree: number;             // 0, 1, 2, or 3
  visual: VertexVisualState;
  /** True only for the midpoint vertex W created at the centre of each move. */
  isMidpoint?: boolean;
  /**
   * True for pseudo-vertices inserted at parallel-edge arc midpoints.
   * IDs are large negatives (-9999, -9998, …); they live only in state.vertices
   * and are rebuilt from scratch on each recomputeRegions call.  They participate
   * in the rotation-system dart-building for reliable face-cycle orientation but
   * are excluded from encoding, rendering, and game input.
   */
  isPseudo?: boolean;
  /** For pseudo-vertices: the edge whose arc midpoint this vertex tracks. */
  pseudoEdgeId?: EdgeId;
}

export interface Edge {
  id: EdgeId;
  v1: VertexId;
  v2: VertexId;
  points: SpherePoint[];      // sampled curve; points[0] ≈ v1.pos, points[last] ≈ v2.pos
  leftRegion: RegionId;
  rightRegion: RegionId;
}

// ---------------------------------------------------------------------------
// Combinatorial layer
// ---------------------------------------------------------------------------

/**
 * A BoundaryEntry is one vertex as it appears in a boundary walk.
 * Joints appear twice (firstVisit / secondVisit); all others once.
 */
export interface BoundaryEntry {
  vertexId: VertexId;
  side: 'only' | 'firstVisit' | 'secondVisit';
  /**
   * The physical edge traversed when stepping from this entry to the next in the
   * boundary walk. Recorded by the rotation-system face tracer so consumers
   * (renderer) need not guess between parallel edges. Absent for degenerate
   * single-vertex boundaries (isolated spots).
   */
  edgeId?: EdgeId;
  /**
   * Set when a pseudo-vertex splits this edge into two boundary steps.
   *   'first-fwd'  — real vertex at e.v1 end, covers the first half forward (v1→pseudo)
   *   'second-fwd' — pseudo-vertex origin, covers the second half forward (pseudo→v2)
   *   'first-rev'  — real vertex at e.v2 end, covers the first half reversed (v2→pseudo)
   *   'second-rev' — pseudo-vertex origin, covers the second half reversed (pseudo→v1)
   * Absent for entries on non-parallel edges (full edge, direction from vertexId==e.v1).
   */
  pseudoHalf?: 'first-fwd' | 'first-rev' | 'second-fwd' | 'second-rev';
}

export interface Boundary {
  entries: BoundaryEntry[];
}

export interface Region {
  id: RegionId;
  boundaries: Boundary[];
  isDead: boolean;
  /** True for the unique region that covers the back hemisphere (outer disk ring). */
  isOuter: boolean;
}

export interface Subposition {
  regionIds: RegionId[];
}

// ---------------------------------------------------------------------------
// Full game state
// ---------------------------------------------------------------------------

export interface GameState {
  // Geometric
  vertices: Map<VertexId, Vertex>;
  edges:    Map<EdgeId,   Edge>;
  // Combinatorial
  regions:      Map<RegionId, Region>;
  subpositions: Subposition[];

  // Counters for ID generation
  nextVertexId: VertexId;
  nextEdgeId:   EdgeId;
  nextRegionId: RegionId;

  // Number of moves played so far. The single source of truth for turn/winner
  // parity — NOT derived from the vertex set, so removing vertices/edges (e.g.
  // dead-region elimination) can never corrupt whose turn it is.
  moveCount: number;

  /**
   * Presentation-layer label for each spot (degree-0 vertex), updated after
   * every move. See src/model/vertexLabels.ts. Purely cosmetic — never used
   * by game logic, only by move-sequence and canvas display.
   */
  spotLabels: Map<VertexId, SpotLabel>;
}
