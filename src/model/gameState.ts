/**
 * Factory and mutation helpers for GameState.
 *
 * createInitialState(n) builds an n-spot starting position.
 * Spots are placed on one or two latitude rings (see initialSpotPositions),
 * giving an evenly-spaced spread that avoids the projection poles.
 */

import type { GameState, Vertex, Edge, Region } from './types';
import { VertexType, VertexVisualState } from './types';
import { normalize } from '../math/sphere';
import { initialSpotLabels } from './vertexLabels';

/**
 * Place n spots for the initial position.
 *
 * The Lambert projection expands the region near the north pole (z→1), so we
 * keep initial spots away from the poles for an even on-screen layout.
 *
 * For n <= 6: a single ring at a fixed latitude (z = -0.2, slightly south of
 * equator) gives a clean, evenly-spaced layout that projects well on screen.
 *
 * For n > 6: two rings at different latitudes to avoid crowding.
 */
function initialSpotPositions(n: number) {
  if (n === 1) {
    return [normalize({ x: 0, y: 0, z: -1 })]; // south pole = screen center
  }

  if (n <= 6) {
    const z = -0.2;
    const r = Math.sqrt(1 - z * z);
    return Array.from({ length: n }, (_, i) => {
      const angle = (2 * Math.PI * i) / n;
      return normalize({ x: r * Math.cos(angle), y: r * Math.sin(angle), z });
    });
  }

  // Two rings: inner (fewer spots) and outer, at different latitudes
  const inner = Math.floor(n / 2);
  const outer = n - inner;
  const rings: ReturnType<typeof normalize>[] = [];

  for (let i = 0; i < inner; i++) {
    const angle = (2 * Math.PI * i) / inner + Math.PI / inner; // offset for visual separation
    const z = 0.3, r = Math.sqrt(1 - z * z);
    rings.push(normalize({ x: r * Math.cos(angle), y: r * Math.sin(angle), z }));
  }
  for (let i = 0; i < outer; i++) {
    const angle = (2 * Math.PI * i) / outer;
    const z = -0.4, r = Math.sqrt(1 - z * z);
    rings.push(normalize({ x: r * Math.cos(angle), y: r * Math.sin(angle), z }));
  }
  return rings;
}

/**
 * Build the starting GameState for an n-spot game.
 * There are no edges yet; the one region is the whole sphere (boundary-less).
 */
export function createInitialState(n: number): GameState {
  const positions = initialSpotPositions(n);

  const vertices = new Map<number, Vertex>();
  const regions  = new Map<number, Region>();

  // The whole sphere is one region. With no edges yet, each spot is an isolated
  // vertex and therefore its OWN boundary component (a degenerate single-entry
  // walk), not one shared boundary. This is what makes the first edge between
  // two spots a MERGE of two components (region count unchanged) rather than a
  // SPLIT.
  // Original spots get negative IDs (-1, -2, ..., -n); generated midpoint
  // vertices get positive IDs (1, 2, 3, ...). Zero is never used.
  const initialRegion: Region = {
    id: 0,
    boundaries: positions.map((_, i) => ({
      entries: [{ vertexId: -(i + 1), side: 'only' as const }],
    })),
    isDead: false,
    isOuter: true,
  };
  regions.set(0, initialRegion);

  for (let i = 0; i < n; i++) {
    const vid = -(i + 1);
    vertices.set(vid, {
      id:     vid,
      pos:    positions[i],
      type:   VertexType.Spot,
      degree: 0,
      visual: VertexVisualState.Active,
    });
  }

  const initial: GameState = {
    vertices,
    edges:           new Map(),
    regions,
    subpositions:    [{ regionIds: [0] }],
    nextVertexId:    1,
    nextEdgeId:      0,
    nextRegionId:    1,
    moveCount:       0,
    spotLabels:      new Map(),
  };
  initial.spotLabels = initialSpotLabels(initial);
  return initial;
}

/** Convenience: allocate a fresh vertex ID. */
export function allocVertexId(state: GameState): number {
  return state.nextVertexId++;
}

/** Convenience: allocate a fresh edge ID. */
export function allocEdgeId(state: GameState): number {
  return state.nextEdgeId++;
}

/**
 * Deep-clone a GameState. Every Map, array, vertex, edge (incl. its sampled
 * points), region and boundary is copied, so the clone shares no mutable
 * structure with the original. Used as a rollback snapshot: a transform that
 * must preserve an invariant (e.g. dead-region elimination preserving the
 * canonical encoding) can clone first and restore via Object.assign if the
 * invariant breaks.
 */
export function cloneState(s: GameState): GameState {
  const vertices = new Map<number, Vertex>();
  for (const [id, v] of s.vertices) vertices.set(id, { ...v, pos: { ...v.pos } });

  const edges = new Map<number, Edge>();
  for (const [id, e] of s.edges) edges.set(id, { ...e, points: e.points.map(p => ({ ...p })) });

  const regions = new Map<number, Region>();
  for (const [id, r] of s.regions) {
    regions.set(id, {
      ...r,
      boundaries: r.boundaries.map(b => ({ entries: b.entries.map(en => ({ ...en })) })),
    });
  }

  return {
    vertices,
    edges,
    regions,
    subpositions: s.subpositions.map(sp => ({ regionIds: [...sp.regionIds] })),
    nextVertexId: s.nextVertexId,
    nextEdgeId:   s.nextEdgeId,
    nextRegionId: s.nextRegionId,
    moveCount:    s.moveCount,
    // recomputeSpotLabels never mutates range objects in place (always
    // replaces via .set with a fresh object), so a shallow copy is safe in
    // practice — but copy the range objects too, defensively.
    spotLabels:   new Map([...s.spotLabels].map(([k, v]) => [k, typeof v === 'number' ? v : { ...v }])),
  };
}
