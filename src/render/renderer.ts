/**
 * Canvas renderer for a Sprouts game state.
 *
 * Supports two projections (switchable at runtime):
 *   'lambert' — Lambert azimuthal equal-area, renders to a disk
 *   'rect'    — Equirectangular, fills the full rectangle
 */

import type { GameState, Edge, Region, RegionId, VertexId } from '../model/types';
import type { RecreateHints } from '../model/recreate';
import { VertexVisualState } from '../model/types';
import type { RotationMatrix, CanvasPoint, SpherePoint } from '../math/sphere';
import { rotateSpherePoint, unrotateSpherePoint, normalize, project, projectRect, slerp } from '../math/sphere';
import { chaikin } from '../math/chaikin';
import { pointInPolygon } from '../math/intersect';
import { edgeRepellers } from '../model/smooth';
import { edgePtsForEntry, pointAtBearing, bearingFrom } from '../model/moves';

export type ProjectionType = 'lambert' | 'rect';

/**
 * Voronoi-cell coloring for the subregions debug view.
 * Each vertex in the enclosure region R gets a hue sentinel:
 *   -1 = grey (lo vertex), -2 = red (bracket component), -3 = green (free region)
 * (rendered neutral grey).  The renderer rasterizes a geodesic Voronoi diagram
 * clipped to region R's boundary.
 */
export interface SubregionHighlight {
  cells: { vertexId: number; hue: number }[];
  regionId: number;
  /** Index into region.boundaries of the outer (enclosing) loop — only this is used for clipping. */
  outerBoundaryIdx: number;
  /** The two move endpoints — their Voronoi cells get blue arcs to each corner. */
  originV1?: number;
  originV2?: number;
}

// Visual constants
const VERTEX_RADIUS_ACTIVE    = 8;
const VERTEX_RADIUS_SATURATED = 4;
const EDGE_LINE_WIDTH         = 2;
const EDGE_COLOR              = '#333333';
const VERTEX_COLOR_ACTIVE     = '#111111';
const VERTEX_COLOR_SATURATED  = '#cccccc';
const VERTEX_COLOR_GRAYED     = '#cccccc';
const BACKGROUND_COLOR        = '#f9f9f6';
const DISK_BORDER_COLOR       = '#cccccc';

export interface RenderOptions {
  grayedVertexIds?: Set<number>;
  activeStroke?: CanvasPoint[];
  poisonPoint?: CanvasPoint | null;
  /** Pre-compression symbol to draw next to each vertex (encoding debug mode). */
  vertexLabels?: Map<number, string>;
  /** Debug: draw each spot's compact presentation label (-1..-k) below it. */
  spotLabels?: Map<number, string>;
  /** Debug: draw a small red dot on every isMidpoint vertex. */
  showMidpoints?: boolean;
  /** Debug: fill each living region with a unique pale color. */
  showRegions?: boolean;
  /** Debug: draw each vertex's numeric id next to it. */
  showVertexIds?: boolean;
  /** Labels to draw per-vertex when set — from either "Vertex IDs" (raw ids) or "Hidden
   * letters" (debug lettering). Drawn whenever this map is present, independent of
   * showVertexIds, so the two toggles can drive the on-canvas labels independently. */
  vertexIdLabels?: Map<VertexId, string>;
  /** Debug: draw a direction arrow for each edge from each region-boundary side. */
  showBoundaryArrows?: boolean;
  /** Debug: draw the region adjacency (dual) graph — nodes at region centroids. */
  showRegionNetwork?: boolean;
  /** Fill the lambert disk grey to indicate game over. */
  gameOver?: boolean;
  /** Visual hints for manual-draw prompts in Recreate mode. */
  recreateHints?: RecreateHints;
  /** All candidate arcs for Recreate preview: legal=true drawn orange, false drawn red. */
  candidatePreviewStrokes?: { stroke: SpherePoint[]; legal: boolean }[];
  /** Suggested arc for manual-draw prompt — drawn solid blue as a hint. */
  proposedArc?: SpherePoint[];
  /** Position Browser hover/lock preview of a child move — drawn dashed purple. */
  movePreviewArc?: SpherePoint[];
  /** Position Browser hover/lock preview when the target endpoints are known but no
   *  non-crossing stroke could be synthesized to reach it — drawn as red rings around
   *  the vertex(es) that should be connected instead of a (wrong) arc. */
  movePreviewFailRing?: VertexId[];
  /** Sub-boundary components of an intercepted enclosure move, each with a hue (0–360). */
  subregionHighlight?: SubregionHighlight;
  /** Voronoi graph for debug overlays (CW/CCW circles, V1/V2 labels). */
  voronoiGraph?: import('../model/voronoiGraph').VoronoiGraph;
  /** Merged circumcenter positions indexed by node id, from buildVoronoiGraph. */
  voronoiCircumcenters?: SpherePoint[];
  /** Synthetic seeds inserted at crowded-junction centroids, for cell rasterization. */
  voronoiExtraSeeds?: { pos: SpherePoint; hue: number }[];
  /** Every Voronoi junction (unfiltered), for the "id name" node label text. */
  voronoiFullNodes?: import('../model/voronoiGraph').VoronoiNodeData[];
  /** Node ids to keep (path exists to a C-bordering node) — others are skipped entirely. */
  voronoiSurvivingIds?: number[];
  /** Mono-boundary case: node id treated as a "fake" CGR — drawn with the same purple circle as a real CW/CGR node. */
  voronoiFakeCgrId?: number;
  /** Transient "pop" bursts where dead components vanished; age is 0→1. */
  popAnimations?: { pos: SpherePoint; age: number }[];
  /** Whose turn it is — tints the outer ring in lambert mode. */
  playerTurn?: 1 | 2;
  /** A Recreate replay halted on a Move Check mismatch — overrides the ring to dark maroon. */
  checkFailed?: boolean;
  /**
   * Position-encoding-bar hover: highlight the vertex/vertices for the
   * hovered character. A single vertex with edgeId set gets a scab-style
   * half-point wedge (the side that occurrence refers to); anything else
   * (multi-vertex compressed symbols, or no edge info) gets a full-circle
   * highlight on every listed vertex.
   */
  hoverHighlight?: { vertexIds: number[]; edgeId?: number };
  /**
   * Debug: while drawing a stroke into/out of a degree-2 vertex, show the new
   * stroke's live departure angle (blue), its immediate clockwise ring
   * neighbor (green), and its immediate counterclockwise ring neighbor (red)
   * — the exact bearingFrom/tangentAngle convention used by recomputeRegions'
   * ring sort, so this is a literal picture of the rotation-order data, not
   * an approximation.
   */
  spliceAngleDebug?: {
    vertexId: VertexId;
    newAngle: number;
    clockwiseNextEdge: { edgeId: number; angle: number } | null;
    counterclockwiseNextEdge: { edgeId: number; angle: number } | null;
  }[];
  /** Debug: color vertices by which side of a just-committed enclosure split they fell on. */
  enclosureSideColors?: Map<VertexId, 'red' | 'blue'>;
  /** Debug: dense sphere-wide sample points classified against the same split, light-colored, no ring. */
  enclosureCoverage?: { pos: SpherePoint; side: 'arc' | 'other' | 'none' }[];
}

const HOVER_COLOR  = '#dd2222';
const HOVER_GROW   = 3; // px added to the vertex's normal radius when hovered

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private diskRadius: number = 1;
  private cx: number = 0;
  private cy: number = 0;
  projection: ProjectionType = 'lambert';

  private regionHueMap = new Map<string, number>(); // edge-fingerprint → hue
  private hueCounter   = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    this.cx         = this.canvas.width  / 2;
    this.cy         = this.canvas.height / 2;
    this.diskRadius = Math.min(this.canvas.width, this.canvas.height) * 0.45;
  }

  /**
   * Highlight one vertex as a half-point wedge — the same angle math the scab
   * arc above uses, but the side is chosen by matching `edgeId` (the outgoing
   * edge of the hovered occurrence) against one of the vertex's two incident
   * edges, rather than by which side is "living". Falls back to a full-circle
   * highlight if the vertex isn't a clean degree-2 point (e.g. self-loop).
   */
  private drawHoverWedge(state: GameState, camera: RotationMatrix, vid: number, edgeId: number): void {
    const ctx = this.ctx;
    const v = state.vertices.get(vid);
    if (!v) return;
    const { px, py } = this.toCanvas(v.pos, camera);

    const incEdges: Edge[] = [];
    for (const e of state.edges.values()) {
      if (e.v1 === vid) incEdges.push(e);
      if (e.v2 === vid) incEdges.push(e);
    }
    if (incEdges.length !== 2) {
      this.drawHoverCircle(state, camera, vid);
      return;
    }

    const [e1, e2] = incEdges;
    let a1: number, a2: number, anticlockwise: boolean;
    // A scab vertex (bordering exactly one living region, or a real self-loop)
    // has a well-defined "living side" independent of which edge occurrence was
    // hovered — so defer entirely to the same geometry the scab arc itself
    // uses, rather than re-deriving a side from `edgeId`. That edge-matching
    // scheme only makes sense for an ordinary joint (both incident edges lead
    // to different neighbours and share one region, so "which edge continues
    // the walk" IS the distinguishing information); for a scab it doesn't
    // apply and previously left the wedge on the wrong (dead) side.
    const scab = this.computeScabArc(state, camera, v, (VERTEX_RADIUS_ACTIVE + HOVER_GROW) * 4);
    if (scab) {
      ({ a1, a2, anticlockwise } = scab);
    } else if (e1.id === e2.id) {
      // Degenerate self-loop that computeScabArc declined (e.g. both sides
      // living) — no edge-matching side to fall back to either.
      this.drawHoverCircle(state, camera, vid);
      return;
    } else {
      const p1 = e1.v1 === vid ? e1.points[1] : e1.points[e1.points.length - 2];
      const p2 = e2.v1 === vid ? e2.points[1] : e2.points[e2.points.length - 2];
      const c1 = this.toCanvas(p1 ?? v.pos, camera);
      const c2 = this.toCanvas(p2 ?? v.pos, camera);
      a1 = Math.atan2(c1.py - py, c1.px - px);
      a2 = Math.atan2(c2.py - py, c2.px - px);
      anticlockwise = edgeId === e1.id;
    }

    ctx.fillStyle = HOVER_COLOR;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, VERTEX_RADIUS_ACTIVE + HOVER_GROW, a1, a2, anticlockwise);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Shared geometry for a scab vertex (degree-2, bordering exactly one living
   * region — or a real self-loop, which the face classifier can't reliably
   * classify at all). Returns the two edge-stub angles and which sweep
   * (anticlockwise from a1 to a2) covers the living side, verified against the
   * dead region's actual boundary polygon rather than trusted from edge
   * left/right bookkeeping (which breaks down for a bigon/self-loop lens).
   * Returns null when `v` isn't a scab, so callers can fall back to whatever
   * they'd otherwise draw (a full circle, or edge-matching for an ordinary
   * joint highlight).
   */
  private computeScabArc(
    state: GameState,
    camera: RotationMatrix,
    v: { id: number; pos: SpherePoint },
    probeRadius: number,
  ): { a1: number; a2: number; anticlockwise: boolean } | null {
    if (state.vertices.get(v.id)?.degree !== 2) return null;
    const { px, py } = this.toCanvas(v.pos, camera);

    const incEdges: Edge[] = [];
    for (const e of state.edges.values()) {
      // Push self-loops twice (once for v1, once for v2) so the arc code below sees length=2.
      if (e.v1 === v.id) incEdges.push(e);
      if (e.v2 === v.id) incEdges.push(e);
    }
    if (incEdges.length !== 2) return null;

    const [e1, e2] = incEdges;
    // For a self-loop (e1===e2), use opposite ends of the same edge so the two
    // reference angles span the loop opening rather than both pointing to the
    // same point.
    const isSelfLoop = e1.id === e2.id;
    // Collect the (up to) two distinct adjacent regions.
    const regionIds = new Set([e1.leftRegion, e1.rightRegion, e2.leftRegion, e2.rightRegion]);
    const adjRegions = [...regionIds].map(id => state.regions.get(id));
    const deadCount = adjRegions.filter(r => r?.isDead).length;
    const liveCount = adjRegions.filter(r => r && !r.isDead).length;
    // Only a true scab if exactly one side is living. Exception: self-loops —
    // the face classifier often mis-routes both self-loop darts to the same
    // region (deadCount=0), but the arc is still correct and needed to show
    // the self-connection.
    if (!(liveCount === 1 && deadCount >= 1) && !isSelfLoop) return null;

    const p1 = e1.v1 === v.id ? e1.points[1] : e1.points[e1.points.length - 2];
    const p2 = isSelfLoop
      ? (e1.v1 === v.id ? e1.points[e1.points.length - 2] : e1.points[1])
      : (e2.v1 === v.id ? e2.points[1] : e2.points[e2.points.length - 2]);
    const c1 = this.toCanvas(p1 ?? v.pos, camera);
    const c2 = this.toCanvas(p2 ?? v.pos, camera);
    const a1 = Math.atan2(c1.py - py, c1.px - px);
    const a2 = Math.atan2(c2.py - py, c2.px - px);
    // leftRegion is CCW from dart (v1→v2) in the tangent plane; in canvas
    // coords (y-down, CCW = increasing angle) this is anticlockwise=false.
    // Swap if v2=S (reverse dart).
    // leftOfOutgoing: the region on the CCW (anticlockwise=true) side when
    // leaving v. For forward dart (v1=v) this is e1.leftRegion; for reverse
    // dart (v2=v) it is e1.rightRegion (left of the reversed direction).
    const leftOfOutgoing = e1.v1 === v.id ? e1.leftRegion : e1.rightRegion;
    let livingIsLeft = !state.regions.get(leftOfOutgoing)?.isDead;
    // The sign convention above assumes the two edge-stubs bound the SAME two
    // regions consistently, which fails for a bigon/self-loop lens (the face
    // classifier can mis-route both darts, or e1's forward/reverse convention
    // doesn't line up with the mixed e1/e2 angle pair). Verify geometrically:
    // probe just off each candidate sweep and test against the dead region's
    // actual boundary polygon; trust that over the sign math whenever they
    // disagree.
    const deadRegion = adjRegions.find(r => r?.isDead);
    if (deadRegion) {
      const deadPolys = deadRegion.boundaries.map(b => this.boundaryPolygon(b.entries, state, camera));
      const inDeadRegion = (pt: CanvasPoint): boolean => {
        let inside = false;
        for (const poly of deadPolys) if (poly.length >= 3 && pointInPolygon(poly, pt)) inside = !inside;
        return inside;
      };
      const delta = ((a2 - a1) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const midFalse = a1 + delta / 2; // bisector of the anticlockwise=false sweep
      const probeFalse: CanvasPoint = { px: px + Math.cos(midFalse) * probeRadius, py: py + Math.sin(midFalse) * probeRadius };
      livingIsLeft = inDeadRegion(probeFalse);
    }
    return { a1, a2, anticlockwise: livingIsLeft };
  }

  /** Full-circle hover highlight — used for compressed multi-vertex symbols. */
  private drawHoverCircle(state: GameState, camera: RotationMatrix, vid: number): void {
    const v = state.vertices.get(vid);
    if (!v) return;
    const { px, py } = this.toCanvas(v.pos, camera);
    const ctx = this.ctx;
    ctx.fillStyle = HOVER_COLOR;
    ctx.beginPath();
    ctx.arc(px, py, VERTEX_RADIUS_ACTIVE + HOVER_GROW, 0, Math.PI * 2);
    ctx.fill();
  }

  toCanvas(p: SpherePoint, camera: RotationMatrix): CanvasPoint {
    const rotated = rotateSpherePoint(p, camera);
    if (this.projection === 'rect') {
      return projectRect(rotated, this.canvas.width, this.canvas.height);
    }
    return project(rotated, this.diskRadius, this.cx, this.cy);
  }

  render(state: GameState, camera: RotationMatrix, opts: RenderOptions = {}): void {
    const ctx  = this.ctx;
    const gray = opts.grayedVertexIds ?? new Set<number>();

    const isLambert = this.projection === 'lambert';
    const ringColor = opts.checkFailed
      ? '#4a0e0e'
      : isLambert && !opts.gameOver
      ? (opts.playerTurn === 2 ? '#f7dada' : '#daedf7')
      : (opts.gameOver && isLambert ? '#cccccc' : BACKGROUND_COLOR);

    ctx.fillStyle = ringColor;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Restore normal background inside the disk (ring tint stays outside)
    if (isLambert) {
      ctx.fillStyle = BACKGROUND_COLOR;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.diskRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sphere boundary
    ctx.strokeStyle = DISK_BORDER_COLOR;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    if (this.projection === 'lambert') {
      ctx.arc(this.cx, this.cy, this.diskRadius, 0, Math.PI * 2);
    } else {
      // Squircle boundary: sample the sphere's north-pole limit from all directions.
      // Approaching z=1 from angle θ: x=cos(θ)·√(2ε), y=sin(θ)·√(2ε), z=1-ε
      // This maps through Lambert → unit disk boundary → Shirley-Chiu → squircle corners.
      const N   = 120;
      const eps = 1e-6;
      const rxy = Math.sqrt(2 * eps);
      for (let i = 0; i <= N; i++) {
        const theta = (2 * Math.PI * i) / N;
        const sp = { x: Math.cos(theta) * rxy, y: Math.sin(theta) * rxy, z: 1 - eps };
        const { px, py } = projectRect(sp, this.canvas.width, this.canvas.height);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.stroke();

    // --- Region fills ---
    if (opts.showRegions) {
      this.renderRegionFills(state, camera);
    }

    // --- Edges ---
    // Render chains: half-edge pairs joined at their shared midpoint vertex W are
    // drawn as one path so Chaikin smoothing passes through W naturally.
    ctx.strokeStyle = EDGE_COLOR;
    ctx.lineWidth   = EDGE_LINE_WIDTH;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    // Build per-vertex in/out edge maps and counts.
    const adjOut   = new Map<number, Edge>();
    const adjIn    = new Map<number, Edge>();
    const outCount = new Map<number, number>();
    const inCount  = new Map<number, number>();
    for (const e of state.edges.values()) {
      adjOut.set(e.v1, e);
      adjIn.set(e.v2, e);
      outCount.set(e.v1, (outCount.get(e.v1) ?? 0) + 1);
      inCount.set(e.v2,  (inCount.get(e.v2)  ?? 0) + 1);
    }

    // A vertex is a chain interior (midpoint W) when it has exactly one distinct
    // incoming and one distinct outgoing edge (excludes self-loop vertices).
    const isChainInterior = (vid: number): boolean => {
      if ((inCount.get(vid) ?? 0) !== 1) return false;
      if ((outCount.get(vid) ?? 0) !== 1) return false;
      const eIn  = adjIn.get(vid);
      const eOut = adjOut.get(vid);
      return !!eIn && !!eOut && eIn.id !== eOut.id;
    };

    const rendered = new Set<number>();

    // Self-loop edges (v1 === v2): render as sphere curves using their points array.
    for (const e of state.edges.values()) {
      if (e.v1 !== e.v2) continue;
      rendered.add(e.id);
      if (e.points.length < 2) continue;
      const projected = this.projectAdaptive(e.points, camera);
      const smoothed  = chaikin(projected, 3);
      if (smoothed.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(smoothed[0].px, smoothed[0].py);
      for (let i = 1; i < smoothed.length; i++) ctx.lineTo(smoothed[i].px, smoothed[i].py);
      ctx.stroke();
    }

    for (const startEdge of state.edges.values()) {
      if (rendered.has(startEdge.id)) continue;

      // Walk backward to find the true chain head (guarded by visited set).
      let head: Edge = startEdge;
      const bVisited = new Set<number>([startEdge.id]);
      while (isChainInterior(head.v1)) {
        const prev = adjIn.get(head.v1);
        if (!prev || bVisited.has(prev.id)) break;
        bVisited.add(prev.id);
        head = prev;
      }

      // Walk forward, concatenating sphere points (dedup shared W endpoint).
      const chainPoints: SpherePoint[] = [...head.points];
      rendered.add(head.id);
      let cur: Edge = head;
      while (isChainInterior(cur.v2)) {
        const next = adjOut.get(cur.v2);
        if (!next || rendered.has(next.id)) break;
        chainPoints.push(...next.points.slice(1));
        rendered.add(next.id);
        cur = next;
      }

      if (chainPoints.length < 2) continue;
      const projected = this.projectAdaptive(chainPoints, camera);
      const smoothed  = chaikin(projected, 3);
      if (smoothed.length < 1) continue;
      ctx.beginPath();
      ctx.moveTo(smoothed[0].px, smoothed[0].py);
      for (let i = 1; i < smoothed.length; i++) ctx.lineTo(smoothed[i].px, smoothed[i].py);
      ctx.stroke();
    }

    // --- Boundary traversal arrows (debug) ---
    if (opts.showBoundaryArrows) this.renderBoundaryArrows(state, camera);

    // --- Active stroke ---
    if (opts.activeStroke && opts.activeStroke.length > 1) {
      ctx.strokeStyle = '#555555';
      ctx.lineWidth   = EDGE_LINE_WIDTH;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(opts.activeStroke[0].px, opts.activeStroke[0].py);
      for (let i = 1; i < opts.activeStroke.length; i++) {
        ctx.lineTo(opts.activeStroke[i].px, opts.activeStroke[i].py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- Poison point ---
    if (opts.poisonPoint) {
      const { px, py } = opts.poisonPoint;
      ctx.strokeStyle = '#cc2222';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- Vertices ---
    // Vertices that border no living region are trapped in dead space and rendered
    // like saturated vertices even if their degree is still < 3.
    const inLivingRegion = new Set<number>();
    for (const r of state.regions.values()) {
      if (r.isDead) continue;
      for (const b of r.boundaries)
        for (const e of b.entries)
          inLivingRegion.add(e.vertexId);
    }
    for (const v of state.vertices.values()) {
      if (v.isPseudo) continue;
      const { px, py } = this.toCanvas(v.pos, camera);
      const isGrayed   = gray.has(v.id);
      const isSat      = v.visual === VertexVisualState.Saturated || !inLivingRegion.has(v.id);
      const radius     = isSat ? VERTEX_RADIUS_SATURATED : VERTEX_RADIUS_ACTIVE;
      const color      = isGrayed ? VERTEX_COLOR_GRAYED
                       : isSat    ? VERTEX_COLOR_SATURATED
                                  : VERTEX_COLOR_ACTIVE;

      // Scabs (degree-2 vertices touching exactly one living region) are drawn as
      // arcs spanning only the living region rather than a full circle.
      // Self-loop scabs bypass isSat: the degenerate single-dart face polygons
      // produced by a self-loop confuse the outer/inner face classifier, which
      // can leave S absent from inLivingRegion even when the outer face is alive.
      const hasSelfLoop = v.degree === 2 &&
        [...state.edges.values()].some(e => e.v1 === v.id && e.v2 === v.id);
      if (v.degree === 2 && (!isSat || hasSelfLoop) && !isGrayed) {
        const scab = this.computeScabArc(state, camera, v, radius * 4);
        if (scab) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.arc(px, py, radius, scab.a1, scab.a2, scab.anticlockwise);
          ctx.closePath();
          ctx.fill();
          continue;
        }
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Position-encoding-bar hover highlight ---
    if (opts.hoverHighlight && opts.hoverHighlight.vertexIds.length > 0) {
      const { vertexIds, edgeId } = opts.hoverHighlight;
      if (vertexIds.length === 1 && edgeId !== undefined) {
        this.drawHoverWedge(state, camera, vertexIds[0], edgeId);
      } else {
        for (const vid of vertexIds) this.drawHoverCircle(state, camera, vid);
      }
    }

    // --- Debug dots ---
    if (opts.showMidpoints) {
      // Edge interior sample points — red
      ctx.fillStyle = '#cc2222';
      for (const e of state.edges.values()) {
        for (let i = 1; i < e.points.length - 1; i++) {
          const { px, py } = this.toCanvas(e.points[i], camera);
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Parallel-edge locked midpoints — blue
      ctx.fillStyle = '#2255cc';
      for (const { point } of edgeRepellers(state)) {
        const { px, py } = this.toCanvas(point, camera);
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- Vertex labels (encoding debug mode) ---
    if (opts.vertexLabels && opts.vertexLabels.size > 0) {
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      for (const v of state.vertices.values()) {
        if (v.isPseudo) continue;
        const raw = opts.vertexLabels.get(v.id);
        if (!raw) continue;
        const struck  = raw.startsWith('~');
        const label   = struck ? raw.slice(1) : raw;
        const { px, py } = this.toCanvas(v.pos, camera);
        const tx = px + 10, ty = py - 4;
        ctx.strokeStyle = 'rgba(249,249,246,0.85)';
        ctx.lineWidth = 3;
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = struck ? '#7777cc' : '#1155cc';
        ctx.fillText(label, tx, ty);
        if (struck) {
          // Draw a line through the middle of the glyph.
          // textBaseline='bottom', so the cap-height midpoint is roughly -0.55em up.
          const w = ctx.measureText(label).width;
          const mid = ty - 5; // ~half cap-height for 11px bold monospace
          ctx.strokeStyle = '#7777cc';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(tx, mid);
          ctx.lineTo(tx + w, mid);
          ctx.stroke();
        }
      }
    }

    // --- Vertex id labels (debug) ---
    if (opts.showVertexIds || opts.vertexIdLabels) {
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const v of state.vertices.values()) {
        const { px, py } = this.toCanvas(v.pos, camera);
        const text = opts.vertexIdLabels?.get(v.id) ?? String(v.id);
        ctx.strokeStyle = 'rgba(249,249,246,0.9)';
        ctx.lineWidth = 3;
        ctx.strokeText(text, px + 8, py + 6);
        ctx.fillStyle = v.isPseudo ? '#2255cc' : '#cc3300';
        ctx.fillText(text, px + 8, py + 6);
        if (v.isPseudo) {
          ctx.fillStyle = '#2255cc';
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // --- Spot presentation labels (debug) ---
    if (opts.spotLabels && opts.spotLabels.size > 0) {
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const [vid, text] of opts.spotLabels) {
        const v = state.vertices.get(vid);
        if (!v) continue;
        const { px, py } = this.toCanvas(v.pos, camera);
        ctx.strokeStyle = 'rgba(249,249,246,0.9)';
        ctx.lineWidth = 3;
        ctx.strokeText(text, px + 8, py + 18);
        ctx.fillStyle = '#118844';
        ctx.fillText(text, px + 8, py + 18);
      }
    }

    // --- Region adjacency (dual) graph (debug) ---
    if (opts.showRegionNetwork) this.renderRegionNetwork(state, camera);

    // --- Recreate manual-draw hints ---
    if (opts.recreateHints) {
      this.renderRecreateHints(state, camera, opts.recreateHints);
    }

    // --- Subregion component fills (debug) ---
    if (opts.subregionHighlight) {
      this.renderSubregionHighlight(state, camera, opts.subregionHighlight, opts.voronoiGraph, opts.voronoiCircumcenters, opts.voronoiExtraSeeds, opts.voronoiFullNodes, opts.voronoiSurvivingIds, opts.voronoiFakeCgrId);
    }

    // --- Candidate arc preview (all candidates, legal=orange illegal=red) ---
    if (opts.candidatePreviewStrokes && opts.candidatePreviewStrokes.length > 0) {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const { stroke, legal } of opts.candidatePreviewStrokes) {
        if (stroke.length < 2) continue;
        const pts = stroke.map(p => this.toCanvas(p, camera));
        ctx.strokeStyle = legal ? 'rgba(255, 150, 0, 0.75)' : 'rgba(200, 30, 30, 0.45)';
        ctx.beginPath();
        ctx.moveTo(pts[0].px, pts[0].py);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- Proposed arc (blue hint for manual-draw prompts) ---
    if (opts.proposedArc && opts.proposedArc.length >= 2) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(40, 120, 255, 0.80)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = opts.proposedArc.map(p => this.toCanvas(p, camera));
      const arcOffset = 5;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const iP = Math.max(0, i - 1), iN = Math.min(pts.length - 1, i + 1);
        let tx = pts[iN].px - pts[iP].px, ty = pts[iN].py - pts[iP].py;
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const ox = pts[i].px + ty * arcOffset;
        const oy = pts[i].py - tx * arcOffset;
        if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
      }
      ctx.stroke();
      ctx.restore();
    }

    // --- Splice angle debug (new stroke's departure angle vs. its ring neighbors) ---
    if (opts.spliceAngleDebug && opts.spliceAngleDebug.length > 0) {
      const ctx = this.ctx;
      const RAY_DIST = 0.22; // radians along the great circle
      for (const entry of opts.spliceAngleDebug) {
        const v = state.vertices.get(entry.vertexId);
        if (!v) continue;
        const origin = this.toCanvas(v.pos, camera);
        const drawRay = (angle: number, color: string, width: number, label?: string) => {
          const tip = this.toCanvas(pointAtBearing(v.pos, angle, RAY_DIST), camera);
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(origin.px, origin.py);
          ctx.lineTo(tip.px, tip.py);
          ctx.stroke();
          if (label) {
            ctx.fillStyle = color;
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText(label, tip.px + 4, tip.py - 4);
          }
          ctx.restore();
        };
        // New stroke's live departure angle: blue.
        drawRay(entry.newAngle, '#1a5fff', 3, 'new');
        // Immediate clockwise ring neighbor: green.
        if (entry.clockwiseNextEdge) drawRay(entry.clockwiseNextEdge.angle, '#22aa22', 3, `e${entry.clockwiseNextEdge.edgeId} (CW)`);
        // Immediate counterclockwise ring neighbor: red.
        if (entry.counterclockwiseNextEdge) drawRay(entry.counterclockwiseNextEdge.angle, '#dd2222', 3, `e${entry.counterclockwiseNextEdge.edgeId} (CCW)`);
      }
    }

    // --- Enclosure coverage (dense sphere sample, light-colored, no ring) ---
    if (opts.enclosureCoverage && opts.enclosureCoverage.length > 0) {
      const ctx = this.ctx;
      ctx.save();
      for (const { pos, side } of opts.enclosureCoverage) {
        const pt = this.toCanvas(pos, camera);
        ctx.fillStyle = side === 'arc' ? '#aad4ff' : side === 'other' ? '#ffb3b3' : '#b3f0b3';
        ctx.beginPath();
        ctx.arc(pt.px, pt.py, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // --- Enclosure side coloring (which vertices fell on which side of a split) ---
    if (opts.enclosureSideColors && opts.enclosureSideColors.size > 0) {
      const ctx = this.ctx;
      for (const [vid, color] of opts.enclosureSideColors) {
        const v = state.vertices.get(vid);
        if (!v || v.isPseudo) continue;
        const pt = this.toCanvas(v.pos, camera);
        ctx.save();
        ctx.strokeStyle = color === 'red' ? '#dd2222' : '#1a5fff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(pt.px, pt.py, VERTEX_RADIUS_ACTIVE + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // --- Move preview arc (Position Browser hover/lock) ---
    if (opts.movePreviewArc && opts.movePreviewArc.length >= 2) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(190, 60, 230, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 5]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = opts.movePreviewArc.map(p => this.toCanvas(p, camera));
      ctx.beginPath();
      ctx.moveTo(pts[0].px, pts[0].py);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
      ctx.stroke();
      ctx.restore();
    }

    // --- Move preview fail rings (Position Browser: target known, no path found) ---
    if (opts.movePreviewFailRing && opts.movePreviewFailRing.length > 0) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(220, 30, 30, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      const seen = new Set<VertexId>();
      for (const vid of opts.movePreviewFailRing) {
        if (seen.has(vid)) continue; // self-loop: same vertex twice
        seen.add(vid);
        const v = state.vertices.get(vid);
        if (!v) continue;
        const pt = this.toCanvas(v.pos, camera);
        ctx.beginPath();
        ctx.arc(pt.px, pt.py, VERTEX_RADIUS_ACTIVE + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- Pop bursts (dead components vanishing) ---
    if (opts.popAnimations) {
      for (const pop of opts.popAnimations) {
        this.renderPop(this.toCanvas(pop.pos, camera), pop.age);
      }
    }

  }

  private renderRecreateHints(state: GameState, camera: RotationMatrix, hints: RecreateHints): void {
    const ctx = this.ctx;

    // Blue: bracket-component edges — center-line highlight.
    if (hints.bracketEdgeIds.size > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(30, 100, 220, 0.55)';
      ctx.lineWidth   = 5;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      for (const edge of state.edges.values()) {
        if (!hints.bracketEdgeIds.has(edge.id)) continue;
        const pts = edge.points.map(p => this.toCanvas(p, camera));
        if (pts.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0].px, pts[0].py);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Blue: arc edges — side-offset highlight toward the bracket region.
    if (hints.arcEdgeIds.size > 0 && hints.arcRegionId != null) {
      this.renderEdgeSideHighlight(state, camera, hints.arcEdgeIds, hints.arcRegionId, 'rgba(30, 100, 220, 0.65)');
    }

    // Blue: bracket-component vertex dots, with an outer ring (same style as
    // the red endpoint rings) so they read clearly against the background.
    if (hints.bracketVertexIds.size > 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(30, 100, 220, 0.7)';
      ctx.strokeStyle = 'rgba(30, 100, 220, 0.9)';
      ctx.lineWidth = 3;
      for (const vid of hints.bracketVertexIds) {
        const v = state.vertices.get(vid);
        if (!v) continue;
        const { px, py } = this.toCanvas(v.pos, camera);
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Red rings: lo and hi target vertices. Joints get a partial arc spanning
    // only the face opening at the relevant boundary visit.
    ctx.save();
    ctx.strokeStyle = '#dd2222';
    ctx.lineWidth   = 3;
    for (const [vid, jointEdges] of [
      [hints.loId, hints.loJointEdges],
      [hints.hiId, hints.hiJointEdges],
    ] as [number, [number, number] | undefined][]) {
      const v = state.vertices.get(vid);
      if (!v) continue;
      const { px, py } = this.toCanvas(v.pos, camera);
      ctx.beginPath();
      if (jointEdges) {
        const [inEid, outEid] = jointEdges;
        const inEdge  = state.edges.get(inEid);
        const outEdge = state.edges.get(outEid);
        if (inEdge && outEdge && inEdge.points.length >= 2 && outEdge.points.length >= 2) {
          // Near-vertex sample on each edge, pointing away from v.
          const pIn  = inEdge.v2  === vid ? inEdge.points[inEdge.points.length - 2]   : inEdge.points[1];
          const pOut = outEdge.v1 === vid ? outEdge.points[1] : outEdge.points[outEdge.points.length - 2];
          const cIn  = this.toCanvas(pIn,  camera);
          const cOut = this.toCanvas(pOut, camera);
          const aIn  = Math.atan2(cIn.py  - py, cIn.px  - px);
          const aOut = Math.atan2(cOut.py - py, cOut.px - px);
          // The face is to the LEFT of the walk (outEdge departing from v).
          // Mirror the scab convention: anticlockwise = face is on left of outEdge.
          const leftRegionId  = outEdge.v1 === vid ? outEdge.leftRegion : outEdge.rightRegion;
          const anticlockwise = !!state.regions.get(leftRegionId)?.isDead;
          ctx.arc(px, py, 13, aIn, aOut, anticlockwise);
        } else {
          ctx.arc(px, py, 13, 0, Math.PI * 2);
        }
      } else {
        ctx.arc(px, py, 13, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Render the region adjacency (dual) graph: a node at each region's centroid,
   * edges between regions that share a game edge (from edge.left/rightRegion).
   * Green = living region, grey = dead, red outline = the model's outer region
   * (pinned near the top so "outside" reads clearly). Pure debug overlay.
   */
  private renderRegionNetwork(state: GameState, camera: RotationMatrix): void {
    const ctx = this.ctx;

    // Region centroids (average of projected boundary points; outer pinned to top).
    const centroids = new Map<RegionId, CanvasPoint>();
    for (const r of state.regions.values()) {
      if (r.isOuter) {
        centroids.set(r.id, { px: this.cx, py: this.cy - this.diskRadius * 0.92 });
        continue;
      }
      let sx = 0, sy = 0, n = 0;
      for (const b of r.boundaries) {
        for (const p of this.boundaryPolygon(b.entries, state, camera)) { sx += p.px; sy += p.py; n++; }
      }
      if (n > 0) centroids.set(r.id, { px: sx / n, py: sy / n });
    }

    // Dual edges: connect adjacent regions (dedup pairs, skip same-region edges).
    const drawn = new Set<string>();
    ctx.strokeStyle = 'rgba(50,50,50,0.45)';
    ctx.lineWidth   = 1.5;
    for (const e of state.edges.values()) {
      const a = e.leftRegion, b = e.rightRegion;
      if (a < 0 || b < 0 || a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const ca = centroids.get(a), cb = centroids.get(b);
      if (!ca || !cb) continue;
      ctx.beginPath();
      ctx.moveTo(ca.px, ca.py);
      ctx.lineTo(cb.px, cb.py);
      ctx.stroke();
    }

    // Nodes.
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of state.regions.values()) {
      const c = centroids.get(r.id);
      if (!c) continue;
      ctx.beginPath();
      ctx.arc(c.px, c.py, 9, 0, Math.PI * 2);
      ctx.fillStyle = r.isDead ? '#9a9a9a' : '#1ba37a';
      ctx.fill();
      ctx.strokeStyle = r.isOuter ? '#cc3300' : 'rgba(0,0,0,0.4)';
      ctx.lineWidth   = r.isOuter ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(r.id), c.px, c.py);
    }
  }

  /** An expanding amber ring + radial sparks. age 0→1 over the burst's life. */
  private renderPop({ px, py }: CanvasPoint, age: number): void {
    const ctx  = this.ctx;
    const ease = 1 - (1 - age) * (1 - age); // ease-out so it springs then eases
    const fade = 1 - age;

    // Expanding ring
    ctx.strokeStyle = `hsla(38, 90%, 48%, ${fade})`;
    ctx.lineWidth   = 2.5 * fade + 0.5;
    ctx.beginPath();
    ctx.arc(px, py, 3 + ease * 26, 0, Math.PI * 2);
    ctx.stroke();

    // Radial sparks
    ctx.fillStyle = `hsla(40, 95%, 52%, ${fade})`;
    const SPARKS = 8;
    for (let k = 0; k < SPARKS; k++) {
      const ang = (2 * Math.PI * k) / SPARKS;
      const d   = 5 + ease * 28;
      ctx.beginPath();
      ctx.arc(px + Math.cos(ang) * d, py + Math.sin(ang) * d, 2.4 * fade + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Clear stored region colors — call when starting a new game. */
  resetRegionColors(): void {
    this.regionHueMap.clear();
    this.hueCounter = 0;
    this.lastScreenOuter = null;
    this.lastScreenOuterVersion = -1;
  }

  /**
   * Return a stable hue for every living region, persisted across renders via
   * an edge-fingerprint map.  When a region is split into two:
   *   - the outer region (isOuter) inherits the parent's hue if it's new
   *   - otherwise the first new region inherits
   *   - the other new region gets a fresh golden-angle hue
   */
  private computeRegionHues(state: GameState): { hues: Map<RegionId, number>; sat: number } {
    const all    = [...state.regions.values()];
    const living = all.filter(r => !r.isDead);
    const sat    = living.length <= 4 ? 45 : living.length <= 8 ? 60 : 75;

    // Fingerprint = sorted dart signatures (vertexId:edgeId) for each boundary entry.
    // Using darts (directed edges) rather than bare edge IDs ensures that the two
    // regions on either side of a split always get distinct fingerprints — they share
    // the same edge IDs but traverse them from different origin vertices.
    const fpOf = (r: Region): string => {
      const parts: string[] = [];
      for (const b of r.boundaries)
        for (const e of b.entries)
          parts.push(e.edgeId !== undefined ? `${e.vertexId}:${e.edgeId}` : `v${e.vertexId}`);
      return parts.sort().join(',');
    };

    // Current fingerprint set across ALL regions (living + dead) so we can tell
    // a region death (fingerprint still present as dead) from a split (fingerprint gone).
    const allFps = new Set(all.map(fpOf));

    // Identify orphaned hues: in the map but no longer any region has that fingerprint.
    const orphanedHues: number[] = [];
    for (const [fp, hue] of this.regionHueMap) {
      if (!allFps.has(fp)) {
        orphanedHues.push(hue);
        this.regionHueMap.delete(fp);
      }
    }

    // Assign hues to living regions.
    const hues = new Map<RegionId, number>();
    const newRegions: Region[] = [];

    for (const r of living) {
      const fp = fpOf(r);
      if (this.regionHueMap.has(fp)) {
        hues.set(r.id, this.regionHueMap.get(fp)!);
      } else {
        newRegions.push(r);
      }
    }

    // When distributing orphaned hues, give priority to the outer region so it
    // keeps the same color after an enclosure is drawn inside it.
    const outerFirst = [...newRegions].sort((a, b) => (b.isOuter ? 1 : 0) - (a.isOuter ? 1 : 0));
    for (const r of outerFirst) {
      const fp  = fpOf(r);
      const hue = orphanedHues.length > 0
        ? orphanedHues.shift()!
        : Math.round((this.hueCounter++ * 137.508) % 360);
      hues.set(r.id, hue);
      this.regionHueMap.set(fp, hue);
    }

    return { hues, sat };
  }

  private renderRegionFills(
    state: GameState,
    camera: RotationMatrix,
  ): void {
    const all = [...state.regions.values()];
    if (all.length === 0) return;
    const living = all.filter(r => !r.isDead);

    const { hues, sat } = this.computeRegionHues(state);
    const colorMap = new Map<RegionId, string>(
      living.map(r => [r.id, `hsla(${hues.get(r.id)!}, ${sat}%, 86%, 0.55)`]),
    );
    const DEAD_COLOR = 'hsla(0, 0%, 62%, 0.40)';

    const ctx = this.ctx;

    // Which region is the OUTER one FOR THE CURRENT VIEW — the face containing the
    // camera's back-pole. This is camera-dependent (twisting changes which face
    // wraps the disk), unlike the model's fixed isOuter flag. Its area on screen
    // is the disk MINUS every other region, so it's filled as the background.
    const outerId = this.screenOuterRegion(state, camera);

    const diskSubpath = () => {
      if (this.projection === 'lambert') ctx.arc(this.cx, this.cy, this.diskRadius, 0, Math.PI * 2);
      else ctx.rect(0, 0, this.canvas.width, this.canvas.height);
    };
    const addRegionSubpaths = (region: Region) => {
      for (const boundary of region.boundaries) {
        const poly = this.boundaryPolygon(boundary.entries, state, camera);
        if (poly.length === 0) continue;
        ctx.moveTo(poly[0].px, poly[0].py);
        for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j].px, poly[j].py);
        ctx.closePath();
      }
    };

    // Background = the screen-outer region's color or grey if dead.
    const outerR = all.find(r => r.id === outerId);
    if (outerR) {
      ctx.fillStyle = outerR.isDead ? DEAD_COLOR : (colorMap.get(outerR.id) ?? DEAD_COLOR);
      ctx.beginPath(); diskSubpath(); ctx.fill();
    }

    // Every inner region, filled with its color or grey if dead.
    for (const region of all) {
      if (region.id === outerId) continue;
      ctx.beginPath(); addRegionSubpaths(region);
      ctx.fillStyle = region.isDead ? DEAD_COLOR : (colorMap.get(region.id) ?? DEAD_COLOR);
      ctx.fill('evenodd');
    }
  }

  /**
   * The region that is "outer" for the CURRENT camera — the face containing the
   * back-pole (camera +z, which Lambert sends to the disk rim). Found by spherical
   * winding of each region's boundary loops around that world point; the face that
   * winds ±1 around it contains it. Camera-dependent by design.
   */
  private screenOuterRegion(state: GameState, camera: RotationMatrix): RegionId | null {
    // Region IDs are reassigned from scratch after every move. Discard the
    // cached outer ID the moment nextRegionId changes so hysteresis never
    // latches onto a stale ID that now belongs to a different (possibly dead) face.
    if (state.nextRegionId !== this.lastScreenOuterVersion) {
      this.lastScreenOuter = null;
      this.lastScreenOuterVersion = state.nextRegionId;
    }
    const n = normalize(unrotateSpherePoint({ x: 0, y: 0, z: 1 }, camera));
    const ang = (p: SpherePoint) => bearingFrom(n, p);
    const winding = new Map<RegionId, number>();
    let bestId: RegionId | null = null, bestW = 0;
    for (const r of state.regions.values()) {
      let total = 0;
      for (const b of r.boundaries) {
        const loop = this.boundarySphereLoop(b.entries, state);
        if (loop.length < 2) continue;
        let prev = ang(loop[loop.length - 1]);
        for (const p of loop) {
          const a = ang(p);
          let da = a - prev;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          total += da; prev = a;
        }
      }
      const wn = Math.abs(total) / (2 * Math.PI);
      winding.set(r.id, wn);
      if (wn > bestW) { bestW = wn; bestId = r.id; }
    }

    // Hysteresis: when the back-pole sits near a boundary two faces can have
    // near-equal winding, and tiny numerical differences would otherwise toggle
    // the choice (and thus the background colour) every frame. Keep the previous
    // outer region unless a different one wins by a clear margin.
    const HYSTERESIS = 0.2;
    if (this.lastScreenOuter !== null) {
      const prevW = winding.get(this.lastScreenOuter);
      if (prevW !== undefined && bestW - prevW < HYSTERESIS) {
        bestId = this.lastScreenOuter;
        bestW = prevW;
      }
    }

    // A bounded face that winds ±1 around the back-pole contains it → it's the
    // screen-outer. Otherwise the back-pole lies in the model's outer face (whose
    // components are all holes, winding 0), so fall back to that.
    let result: RegionId | null = null;
    if (bestW > 0.5) {
      result = bestId;
    } else {
      for (const r of state.regions.values()) if (r.isOuter) { result = r.id; break; }
    }
    this.lastScreenOuter = result;
    return result;
  }

  /** Last chosen screen-outer region, for hysteresis (see screenOuterRegion). */
  private lastScreenOuter: RegionId | null = null;
  /** nextRegionId value when lastScreenOuter was set — used to detect stale IDs after a move. */
  private lastScreenOuterVersion = -1;
  /** Reusable offscreen canvas for Voronoi rasterization (subregions debug). */
  private voronoiOffscreen: HTMLCanvasElement | null = null;

  /** A region boundary as an ordered list of sphere points (following edgeId). */
  private boundarySphereLoop(
    entries: import('../model/types').BoundaryEntry[],
    state: GameState,
  ): SpherePoint[] {
    const loop: SpherePoint[] = [];
    for (const e of entries) {
      const edge = e.edgeId !== undefined ? state.edges.get(e.edgeId) : undefined;
      if (edge) {
        const pts = edgePtsForEntry(e, edge);
        for (let j = 0; j < pts.length - 1; j++) loop.push(pts[j]);
      } else {
        const v = state.vertices.get(e.vertexId);
        if (v) loop.push(v.pos);
      }
    }
    return loop;
  }

  /**
   * Project a boundary walk to a canvas polygon, following the exact physical
   * edge each entry records (`edgeId`). Falls back to the vertex position for
   * degenerate single-vertex boundaries (isolated spots).
   */
  private boundaryPolygon(
    entries: import('../model/types').BoundaryEntry[],
    state: GameState,
    camera: RotationMatrix,
  ): CanvasPoint[] {
    const poly: CanvasPoint[] = [];
    for (const e of entries) {
      const edge = e.edgeId !== undefined ? state.edges.get(e.edgeId) : undefined;
      if (edge) {
        const pts = edgePtsForEntry(e, edge);
        const pr = this.projectAdaptive(pts, camera);
        for (let j = 0; j < pr.length - 1; j++) poly.push(pr[j]);
      } else {
        const v = state.vertices.get(e.vertexId);
        if (v) poly.push(this.toCanvas(v.pos, camera));
      }
    }
    return poly;
  }

  /**
   * Draw one direction arrow per boundary step. Each entry records the exact edge
   * it traverses (`edgeId`) and the walk direction, so there is no parallel-edge
   * guessing. The arrowhead points along the walk; it is offset onto the side
   * interior to its region (point-in-region test, disambiguated by the edge's
   * other face) and colored a darker variant of the region's fill hue.
   */
  private renderBoundaryArrows(state: GameState, camera: RotationMatrix): void {
    const living = [...state.regions.values()].filter(r => !r.isDead);
    if (living.length === 0) return;

    const { hues, sat } = this.computeRegionHues(state);
    // Region polygons (exact, via each entry's edgeId) for the interior-side test.
    const regionPolys = new Map<RegionId, CanvasPoint[][]>();
    for (const r of living) {
      regionPolys.set(r.id, r.boundaries.map(b => this.boundaryPolygon(b.entries, state, camera)));
    }
    const innerRegions = living.filter(r => !r.isOuter);
    const evenOddIn = (comps: CanvasPoint[][], pt: CanvasPoint): boolean => {
      let inside = false;
      for (const c of comps) if (c.length >= 3 && pointInPolygon(c, pt)) inside = !inside;
      return inside;
    };
    const contains = (region: Region, pt: CanvasPoint): boolean => {
      if (!region.isOuter) return evenOddIn(regionPolys.get(region.id)!, pt);
      for (const ir of innerRegions) if (evenOddIn(regionPolys.get(ir.id)!, pt)) return false;
      return true;
    };

    const ctx = this.ctx;
    const OFFSET = 7, PROBE = 6, HEAD = 9;

    for (const region of living) {
      const hue = hues.get(region.id)!;
      ctx.fillStyle = `hsla(${hue}, ${Math.min(100, sat + 25)}%, 38%, 0.95)`;

      for (const boundary of region.boundaries) {
        for (const entry of boundary.entries) {
          if (entry.edgeId === undefined) continue;       // isolated spot — no edge
          const edge = state.edges.get(entry.edgeId);
          if (!edge) continue;

          // The entry records the edge AND the walk direction (from this vertex).
          const pts = edgePtsForEntry(entry, edge);
          const pr = this.projectAdaptive(pts, camera);
          if (pr.length < 2) continue;
          const mi = Math.floor(pr.length / 2);
          const m = pr[mi], p0 = pr[Math.max(0, mi - 1)], p1 = pr[Math.min(pr.length - 1, mi + 1)];
          let tx = p1.px - p0.px, ty = p1.py - p0.py;
          const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
          const nx = ty, ny = -tx; // left-normal (screen y-down)

          // Offset onto the side interior to this region. Score each side as
          // inside(thisRegion) − inside(neighbour); the neighbour is the edge's
          // OTHER face (known exactly now), which cancels any spurious self-
          // containment when this region traces only one arc of a loop.
          const otherId = edge.leftRegion === region.id ? edge.rightRegion : edge.leftRegion;
          const other = state.regions.get(otherId);
          const score = (px: number, py: number): number => {
            const pt = { px, py };
            let s = contains(region, pt) ? 1 : 0;
            if (other && !other.isDead && contains(other, pt)) s -= 1;
            return s;
          };
          const sPlus  = score(m.px + nx * PROBE, m.py + ny * PROBE);
          const sMinus = score(m.px - nx * PROBE, m.py - ny * PROBE);
          let sx = nx, sy = ny;
          if (sMinus > sPlus) { sx = -nx; sy = -ny; }

          const cxp = m.px + sx * OFFSET, cyp = m.py + sy * OFFSET;
          const tipx = cxp + tx * HEAD * 0.5, tipy = cyp + ty * HEAD * 0.5;
          const bx   = cxp - tx * HEAD * 0.5, by   = cyp - ty * HEAD * 0.5;
          ctx.beginPath();
          ctx.moveTo(tipx, tipy);
          ctx.lineTo(bx + sx * HEAD * 0.45, by + sy * HEAD * 0.45);
          ctx.lineTo(bx - sx * HEAD * 0.45, by - sy * HEAD * 0.45);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }

  /**
   * Project edge sphere points to canvas with adaptive subdivision.
   * If two consecutive projected points are more than MAX_GAP pixels apart,
   * inserts slerped midpoints recursively until all gaps are small.
   * Prevents long chords across the disk when a rotated edge passes near the
   * north pole (where the Lambert scale factor expands small sphere angles into
   * large canvas distances).
   */
  private projectAdaptive(points: SpherePoint[], camera: RotationMatrix): CanvasPoint[] {
    const MAX_GAP_SQ = 20 * 20;
    const result: CanvasPoint[] = [];

    const divide = (
      a: SpherePoint, b: SpherePoint,
      pa: CanvasPoint, pb: CanvasPoint,
      depth: number,
    ): void => {
      const dx = pa.px - pb.px, dy = pa.py - pb.py;
      if (depth >= 8 || dx * dx + dy * dy <= MAX_GAP_SQ) {
        result.push(pa);
        return;
      }
      const mid = slerp(a, b, 0.5);
      const pm  = this.toCanvas(mid, camera);
      divide(a, mid, pa, pm, depth + 1);
      divide(mid, b, pm, pb, depth + 1);
    };

    if (points.length === 0) return result;
    const proj = points.map(p => this.toCanvas(p, camera));
    for (let i = 0; i < points.length - 1; i++) {
      divide(points[i], points[i + 1], proj[i], proj[i + 1], 0);
    }
    result.push(proj[proj.length - 1]);
    return result;
  }

  /**
   * Rasterize a geodesic Voronoi diagram for the subregions debug view.
   *
   * Every vertex in region R is a Voronoi seed colored by its sub-boundary
   * component (outer-boundary vertices are grey). For each pixel we compute the
   * nearest seed by dot product (≡ geodesic distance on the unit sphere), sample
   * at 1/3 resolution for performance, then scale up via drawImage (which
   * respects the canvas clip path set to region R's boundary).
   */
  private renderSubregionHighlight(state: GameState, camera: RotationMatrix, hl: SubregionHighlight, vGraph?: import('../model/voronoiGraph').VoronoiGraph, passedCCs?: SpherePoint[], extraSeeds?: { pos: SpherePoint; hue: number }[], fullNodes?: import('../model/voronoiGraph').VoronoiNodeData[], survivingNodeIds?: number[], fakeCgrId?: number): void {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const STEP = 3; // sample every 3rd pixel; 3×3 blocks when scaled up

    // HSL → RGB (integers 0–255).
    const hslRgb = (h: number, s: number, l: number): [number, number, number] => {
      const c = (1 - Math.abs(2*l - 1)) * s;
      const hp = h / 60;
      const x = c * (1 - Math.abs(hp % 2 - 1));
      const m = l - c / 2;
      let r = 0, g = 0, b = 0;
      if      (hp < 1) { r = c; g = x; }
      else if (hp < 2) { r = x; g = c; }
      else if (hp < 3) {        g = c; b = x; }
      else if (hp < 4) {        g = x; b = c; }
      else if (hp < 5) { r = x;        b = c; }
      else             { r = c;        b = x; }
      return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
    };

    // Pre-rotate seeds into camera space so they can be compared directly against
    // inverse-projected canvas pixels (which are also in camera space).
    const seeds: { x: number; y: number; z: number; r: number; g: number; b: number }[] = [];
    for (const cell of hl.cells) {
      const v = state.vertices.get(cell.vertexId);
      if (!v) continue;
      const cam = rotateSpherePoint(v.pos, camera);
      const [r, g, b] =
        cell.hue === -1 ? [160, 160, 160]        // lo vertex: neutral grey
        : cell.hue === -2 ? hslRgb(0, 0.75, 0.52)    // bracket component: red
        : cell.hue === -3 ? hslRgb(120, 0.60, 0.42)  // free region: green
        : hslRgb(cell.hue, 0.75, 0.58);  // colorful (origin component); hue is pre-clamped
                                          // away from the red/green bands above, see toSafeHue
      seeds.push({ x: cam.x, y: cam.y, z: cam.z, r, g, b });
    }
    // Append any synthetic seeds inserted during Voronoi clustering (crowded
    // junctions). Rendered as a desaturated/lightened version of the same cell
    // type — recognizable as belonging to that color, but visually flagged as
    // synthesized rather than a real vertex seed. A colorful ("C") cluster has
    // no single hue to preserve, so it falls back to plain light grey.
    if (extraSeeds) {
      for (const es of extraSeeds) {
        const cam = rotateSpherePoint(es.pos, camera);
        const [r, g, b] =
          es.hue === -2 ? hslRgb(0, 0.35, 0.72)     // bracket component: pale red
          : es.hue === -3 ? hslRgb(120, 0.28, 0.68)   // free region: pale green
          : hslRgb(0, 0, 0.80);                       // colorful: light grey
        seeds.push({ x: cam.x, y: cam.y, z: cam.z, r, g, b });
      }
    }
    if (seeds.length === 0) return;

    // Rasterize at reduced resolution.
    const imgW = Math.ceil(W / STEP), imgH = Math.ceil(H / STEP);
    const data = new Uint8ClampedArray(imgW * imgH * 4);
    const half = this.diskRadius / 2; // Lambert half-scale: disk_radius/2 per unit

    for (let iy = 0; iy < imgH; iy++) {
      for (let ix = 0; ix < imgW; ix++) {
        const u  = (ix * STEP - this.cx) / half;
        const v  = (iy * STEP - this.cy) / half;
        const r2 = u*u + v*v;
        if (r2 >= 4) continue; // outside disk
        // Camera-space sphere point via inverse Lambert.
        const f  = Math.sqrt(1 - r2 / 4);
        const cpx = u*f, cpy = v*f, cpz = r2/2 - 1;

        // Nearest seed = max dot product (cosine of geodesic angle).
        let bestDot = -2, bestIdx = -1;
        for (let i = 0; i < seeds.length; i++) {
          const s = seeds[i];
          const dot = s.x*cpx + s.y*cpy + s.z*cpz;
          if (dot > bestDot) { bestDot = dot; bestIdx = i; }
        }
        if (bestIdx < 0) continue;

        const s = seeds[bestIdx];
        const base = (iy * imgW + ix) * 4;
        data[base]   = s.r;
        data[base+1] = s.g;
        data[base+2] = s.b;
        data[base+3] = 150;
      }
    }

    // Paint raster to reusable offscreen canvas, then stamp it onto the main canvas
    // clipped to region R's boundary (drawImage respects clip paths; putImageData does not).
    if (!this.voronoiOffscreen || this.voronoiOffscreen.width !== imgW || this.voronoiOffscreen.height !== imgH) {
      this.voronoiOffscreen = document.createElement('canvas');
      this.voronoiOffscreen.width  = imgW;
      this.voronoiOffscreen.height = imgH;
    }
    this.voronoiOffscreen.getContext('2d')!.putImageData(new ImageData(data, imgW, imgH), 0, 0);

    const region = state.regions.get(hl.regionId);
    ctx.save();
    // For non-outer regions, clip to the outer boundary polygon so the Voronoi
    // only fills inside the face.  For the outer region the "main boundary"
    // is just the cluster contour — a tiny polygon that hides everything — so
    // skip clipping and let the Lambert-disk cutoff handle containment.
    if (region && !region.isOuter) {
      const outerBoundary = region.boundaries[hl.outerBoundaryIdx];
      if (outerBoundary) {
        const poly = this.boundaryPolygon(outerBoundary.entries, state, camera);
        if (poly.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(poly[0].px, poly[0].py);
          for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j].px, poly[j].py);
          ctx.closePath();
          ctx.clip();
        }
      }
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.voronoiOffscreen, 0, 0, W, H);

    // --- Voronoi node index labels at circumcenters ---
    {
      const circumcenters: SpherePoint[] = passedCCs ?? [];
      if (circumcenters.length > 0) {
        // Build node lookup from vGraph if available.
        const nodeMap = new Map<number, import('../model/voronoiGraph').VoronoiNodeData>();
        if (vGraph) for (const nd of vGraph.nodes) nodeMap.set(nd.id, nd);
        const survivingSet = survivingNodeIds ? new Set(survivingNodeIds) : undefined;

        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let ti = 0; ti < circumcenters.length; ti++) {
          if (survivingSet && !survivingSet.has(ti)) continue; // pruned: no path to a C-bordering node
          const { px, py } = this.toCanvas(circumcenters[ti], camera);
          const nd = nodeMap.get(ti);
          const name = fullNodes?.[ti]?.name;

          // Draw circle for CW (purple) or CCW (white) nodes — or the
          // mono-boundary "fake" CGR node, drawn identically in purple.
          if (nd?.CW || nd?.CCW || ti === fakeCgrId) {
            ctx.beginPath();
            ctx.arc(px, py, 8, 0, Math.PI * 2);
            ctx.fillStyle = (nd?.CW || ti === fakeCgrId) ? '#9933cc' : '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }

          ctx.fillStyle = '#000000';
          ctx.fillText(name ? `${ti} ${name}` : String(ti), px, py);

          // V1 / V2 labels above the node number.
          if (nd?.linksToV1) {
            ctx.fillStyle = '#0055ff';
            ctx.fillText('V1', px, py - 14);
          }
          if (nd?.linksToV2) {
            ctx.fillStyle = '#cc5500';
            ctx.fillText('V2', px, py - 14);
          }
        }
      }
    }

    ctx.restore();
  }

  /**
   * Draw a side-offset highlight stripe along a set of edges, placed a few
   * pixels to the side facing `regionId`. Uses `edge.leftRegion` /
   * `edge.rightRegion` to determine which side that is — no geometric probe
   * needed. The offset direction is derived from the per-point tangent so the
   * stripe stays parallel to the edge even on curves.
   *
   * General utility: can be called from outside renderRecreateHints for any
   * feature that needs to indicate "this side" of an edge set.
   */
  renderEdgeSideHighlight(
    state: GameState,
    camera: RotationMatrix,
    edgeIds: Set<number>,
    regionId: number,
    color: string,
    offset = 6,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 3;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (const edgeId of edgeIds) {
      const edge = state.edges.get(edgeId);
      if (!edge) continue;
      const pr = this.projectAdaptive(edge.points, camera);
      if (pr.length < 2) continue;

      // +1 → offset toward left-normal of v1→v2, −1 → toward right-normal.
      // A bridge edge (same region on both sides, e.g. a tree edge the
      // boundary walk traverses once each direction) needs the stripe on
      // both sides — one side alone would miss half of what the walk covers.
      const sideSigns = edge.leftRegion === edge.rightRegion ? [1, -1] : [edge.leftRegion === regionId ? 1 : -1];

      for (const sideSign of sideSigns) {
        ctx.beginPath();
        for (let i = 0; i < pr.length; i++) {
          const iP = Math.max(0, i - 1);
          const iN = Math.min(pr.length - 1, i + 1);
          let tx = pr[iN].px - pr[iP].px, ty = pr[iN].py - pr[iP].py;
          const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
          // Left-normal in canvas coords (y-down): perpendicular to tangent, pointing left of travel.
          const nx = ty, ny = -tx;
          const ox = pr[i].px + sideSign * nx * offset;
          const oy = pr[i].py + sideSign * ny * offset;
          if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  get projectionDiskRadius(): number { return this.diskRadius; }
  get centerX(): number { return this.cx; }
  get centerY(): number { return this.cy; }
  get canvasWidth():  number { return this.canvas.width; }
  get canvasHeight(): number { return this.canvas.height; }
}
