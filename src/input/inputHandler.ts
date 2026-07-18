/**
 * Input state machine for Sprouts.
 *
 * Three states:
 *   IDLE      — no pointer down
 *   ROTATING  — pointer down on empty space, dragging rotates the sphere
 *   DRAWING   — pointer down on a vertex, dragging draws a curve
 *
 * Crossing detection: each new stroke segment is checked against all existing
 * edges and the earlier portion of the active stroke. A crossing shows a red
 * circle (poison point); dragging back to the last safe position trims the
 * stroke and clears it.
 */

import type { GameState, VertexId } from '../model/types';
import type { DragTarget } from '../model/smooth';
import { resetActivityTimer } from '../model/smooth';
import type { RotationMatrix, CanvasPoint, SpherePoint } from '../math/sphere';
import { unproject, unprojectRect, unrotateSpherePoint, segCrossesPolylineSphere } from '../math/sphere';
import { dist, signedArea } from '../math/intersect';
import type { Renderer } from '../render/renderer';
import { applyMove, bearingFrom, stablePt } from '../model/moves';

const HIT_RADIUS     = 22;   // px — how close to a vertex center to pick it up
const RETRACT_RADIUS = 18;   // px — how close to safe tip to clear a poison point
const SAMPLE_SPACING = 4;    // px — minimum gap between recorded stroke samples
const MIN_LOOP_AREA  = 500;  // px² — minimum signed area for a valid loop move


type InputState = 'idle' | 'rotating' | 'drawing' | 'dragging';

export class InputHandler {
  private state: InputState = 'idle';

  // Rotation
  private lastX = 0;
  private lastY = 0;
  private onRotate: (dx: number, dy: number) => void;
  private onRotateEnd: () => void;

  // Drawing
  private startVertex: VertexId = -1;
  private canvasStroke: CanvasPoint[] = [];
  private sphereStroke: SpherePoint[] = [];
  private safeLength = 0;
  private poisonPoint: CanvasPoint | null = null;
  private grayedVertices: Set<VertexId> = new Set();
  // Vertex zone tracking: maps vertex ID → canvas point where the stroke entered
  // its hit-radius zone.  Poisoned only when we *exit* a zone we entered.
  private vertexZonesEntered: Map<VertexId, CanvasPoint> = new Map();

  // Vertex dragging
  private dragVertexId: VertexId = -1;
  private dragTarget: SpherePoint | null = null;

  // Reject animation
  private rejectTimer = 0;
  private rejectStroke: CanvasPoint[] = [];

  private gameState: GameState;
  private renderer: Renderer;
  private getCameraRef: () => RotationMatrix;
  private onMoveCommitted: (v1: VertexId, v2: VertexId) => void;
  private onBeforeMove: () => void;

  constructor(opts: {
    gameState: GameState;
    renderer: Renderer;
    getCameraRef: () => RotationMatrix;
    onRotate: (dx: number, dy: number) => void;
    onRotateEnd: () => void;
    onMoveCommitted: (v1: VertexId, v2: VertexId) => void;
    /** Fires immediately before a move mutates state (for undo snapshots). */
    onBeforeMove?: () => void;
  }) {
    this.gameState       = opts.gameState;
    this.renderer        = opts.renderer;
    this.getCameraRef    = opts.getCameraRef;
    this.onRotate        = opts.onRotate;
    this.onRotateEnd     = opts.onRotateEnd;
    this.onMoveCommitted = opts.onMoveCommitted;
    this.onBeforeMove    = opts.onBeforeMove ?? (() => {});
  }

  // ---------------------------------------------------------------------------
  // Public: pointer events
  // ---------------------------------------------------------------------------

  pointerDownRight(px: number, py: number): void {
    if (this.state === 'drawing') return;
    const hit = this.vertexAt(px, py);
if (hit === null) return;
    this.state        = 'dragging';
    this.dragVertexId = hit;
    this.dragTarget   = this.toSpherePoint(px, py);
    // Moving a point counts as fresh activity — restart the winddown countdown
    // with a shorter hold so repeated nudges feel responsive rather than each
    // one re-arming the full post-move hold.
    resetActivityTimer(1500);
  }

  pointerDown(px: number, py: number): void {
    const hit = this.vertexAt(px, py);
    if (hit !== null && this.canStartFrom(hit)) {
      this.state        = 'drawing';
      this.startVertex  = hit;
      // Snap stroke origin to exact vertex position so the committed edge
      // always starts from the vertex center, not wherever the pointer landed.
      const startVert   = this.gameState.vertices.get(hit)!;
      const startCanvas = this.renderer.toCanvas(startVert.pos, this.getCameraRef());
      this.canvasStroke   = [startCanvas];
      this.sphereStroke   = [startVert.pos];
      this.safeLength     = 1;
      this.poisonPoint    = null;
      this.grayedVertices = this.computeGrayed(hit);
    } else {
      this.state = 'rotating';
      this.lastX = px;
      this.lastY = py;
    }
  }

  pointerMove(px: number, py: number): void {
    if (this.state === 'dragging') {
      this.dragTarget = this.toSpherePoint(px, py);
      resetActivityTimer(1500); // keep forces at full strength while actively dragging
      return;
    }
    if (this.state === 'rotating') {
      this.onRotate(px - this.lastX, py - this.lastY);
      this.lastX = px;
      this.lastY = py;
      return;
    }
    if (this.state !== 'drawing') return;

    const cur: CanvasPoint = { px, py };
    const last = this.canvasStroke[this.canvasStroke.length - 1];
    if (dist(cur, last) < SAMPLE_SPACING) return;

    // Retract detection: if poisoned and pointer returns near the safe tip, trim
    if (this.poisonPoint !== null && this.safeLength > 0) {
      const safeTip = this.canvasStroke[this.safeLength - 1];
      if (dist(cur, safeTip) < RETRACT_RADIUS) {
        this.canvasStroke = this.canvasStroke.slice(0, this.safeLength);
        this.sphereStroke = this.sphereStroke.slice(0, this.safeLength);
        this.poisonPoint  = null;
        return;
      }
    }

    this.canvasStroke.push(cur);
    this.sphereStroke.push(this.toSpherePoint(px, py));

    if (this.poisonPoint === null) {
      const crossing = this.checkCrossing();
      if (crossing) {
        this.poisonPoint = crossing;
      } else {
        this.safeLength = this.canvasStroke.length;
      }
    }
  }

  pointerUp(px: number, py: number): void {
    if (this.state === 'dragging') { this.state = 'idle'; this.dragVertexId = -1; this.dragTarget = null; return; }
    if (this.state === 'rotating') { this.state = 'idle'; this.onRotateEnd(); return; }
    if (this.state !== 'drawing')  return;
    this.state = 'idle';

    if (this.poisonPoint !== null || this.canvasStroke.length < 2) {
      this.startReject(); return;
    }

    const target = this.vertexAt(px, py);
    if (target === null || !this.canEndAt(target)) {
      this.startReject(); return;
    }

    // Snap final stroke point to target vertex's sphere position
    const targetVert = this.gameState.vertices.get(target)!;
    const camera = this.getCameraRef();
    const targetCanvas = this.renderer.toCanvas(targetVert.pos, camera);
    this.canvasStroke.push(targetCanvas);
    this.sphereStroke.push(targetVert.pos);

    const isLoop = this.startVertex === target;

    // Reject degenerate loop moves that don't enclose meaningful area.
    if (isLoop && Math.abs(signedArea(this.canvasStroke)) < MIN_LOOP_AREA) {
      this.startReject(); return;
    }

    const moveV1 = this.startVertex;
    const moveV2 = target;

    this.onBeforeMove(); // snapshot for undo, before the move mutates anything

    applyMove(this.gameState, {
      v1:     moveV1,
      v2:     moveV2,
      stroke: this.sphereStroke,
    });

    this.clearDrawState();
    this.onMoveCommitted(moveV1, moveV2);
  }

  pointerCancel(): void {
    if (this.state === 'rotating') this.onRotateEnd();
    if (this.state === 'drawing')  this.startReject();
    if (this.state === 'dragging') { this.dragVertexId = -1; this.dragTarget = null; }
    this.state = 'idle';
  }

  // ---------------------------------------------------------------------------
  // Public: render state
  // ---------------------------------------------------------------------------

  /** Toggle for the splice-angle debug overlay (Debug menu). */
  showSpliceAngles = false;

  getRenderExtras(): {
    grayedVertexIds: Set<VertexId>;
    activeStroke: CanvasPoint[] | undefined;
    poisonPoint: CanvasPoint | null;
    spliceAngleDebug: { vertexId: VertexId; newAngle: number; clockwiseNextEdge: { edgeId: number; angle: number } | null; counterclockwiseNextEdge: { edgeId: number; angle: number } | null }[];
  } {
    if (this.state === 'drawing') {
      return {
        grayedVertexIds: this.grayedVertices,
        activeStroke:    this.canvasStroke.length > 1 ? this.canvasStroke : undefined,
        poisonPoint:     this.poisonPoint,
        spliceAngleDebug: this.showSpliceAngles ? this.computeSpliceAngleDebug() : [],
      };
    }
    if (this.rejectTimer > 0) {
      return { grayedVertexIds: new Set(), activeStroke: this.rejectStroke, poisonPoint: null, spliceAngleDebug: [] };
    }
    return { grayedVertexIds: new Set(), activeStroke: undefined, poisonPoint: null, spliceAngleDebug: [] };
  }

  /**
   * Debug: for the vertex a stroke is departing from (and, if the tip is
   * currently hovering inside a candidate end vertex, that vertex too), when
   * that vertex has degree 2 (about to become 3 — the case with a real
   * insertion ambiguity), compute the live stroke's current departure bearing
   * at that vertex and its immediate clockwise/counterclockwise neighbors in
   * that vertex's existing two-edge ring. Uses the exact same
   * bearingFrom/stablePt convention as recomputeRegions' ring sort in
   * model/moves.ts, so this is a literal picture of that data, not a guess.
   */
  private computeSpliceAngleDebug(): { vertexId: VertexId; newAngle: number; clockwiseNextEdge: { edgeId: number; angle: number } | null; counterclockwiseNextEdge: { edgeId: number; angle: number } | null }[] {
    if (this.sphereStroke.length < 2) return [];
    const out: { vertexId: VertexId; newAngle: number; clockwiseNextEdge: { edgeId: number; angle: number } | null; counterclockwiseNextEdge: { edgeId: number; angle: number } | null }[] = [];

    const addFor = (vid: VertexId, liveAngle: number): void => {
      const v = this.gameState.vertices.get(vid);
      if (!v || v.degree !== 2) return;
      const existing: { edgeId: number; angle: number }[] = [];
      for (const e of this.gameState.edges.values()) {
        if (e.v1 !== vid && e.v2 !== vid) continue;
        const neighbor = e.v1 === vid ? stablePt(e.points, 0, 1) : stablePt(e.points, e.points.length - 1, -1);
        existing.push({ edgeId: e.id, angle: bearingFrom(v.pos, neighbor) });
      }
      if (existing.length !== 2) return;
      // Clockwise = smallest positive step walking in the decreasing-angle
      // direction from liveAngle; counterclockwise = same but increasing-angle.
      // Mirrors nextDart's ring convention in model/moves.ts.
      let cw: { edgeId: number; angle: number } | null = null, bestCw = Infinity;
      let ccw: { edgeId: number; angle: number } | null = null, bestCcw = Infinity;
      for (const ex of existing) {
        let dCw = liveAngle - ex.angle;
        dCw = ((dCw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (dCw > 1e-9 && dCw < bestCw) { bestCw = dCw; cw = ex; }
        let dCcw = ex.angle - liveAngle;
        dCcw = ((dCcw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (dCcw > 1e-9 && dCcw < bestCcw) { bestCcw = dCcw; ccw = ex; }
      }
      out.push({ vertexId: vid, newAngle: liveAngle, clockwiseNextEdge: cw, counterclockwiseNextEdge: ccw });
    };

    const startV = this.gameState.vertices.get(this.startVertex);
    if (startV) addFor(this.startVertex, bearingFrom(startV.pos, stablePt(this.sphereStroke, 0, 1)));

    const camera = this.getCameraRef();
    const tipCanvas = this.canvasStroke[this.canvasStroke.length - 1];
    for (const v of this.gameState.vertices.values()) {
      if (v.isPseudo || v.id === this.startVertex) continue;
      const vc = this.renderer.toCanvas(v.pos, camera);
      if (dist(tipCanvas, vc) < HIT_RADIUS) {
        addFor(v.id, bearingFrom(v.pos, stablePt(this.sphereStroke, this.sphereStroke.length - 1, -1)));
        break;
      }
    }
    return out;
  }

  isDrawing():   boolean { return this.state === 'drawing'; }
  isRotating():  boolean { return this.state === 'rotating'; }
  isRejecting(): boolean { return this.rejectTimer > 0; }
  isDragging():  boolean { return this.state === 'dragging'; }

  cancelDrag(): void {
    if (this.state !== 'dragging') return;
    this.state        = 'idle';
    this.dragVertexId = -1;
    this.dragTarget   = null;
  }

  getDragTarget(): DragTarget | null {
    if (this.state !== 'dragging' || this.dragTarget === null) return null;
    return { vertexId: this.dragVertexId, target: this.dragTarget };
  }

  tick(dt: number): void {
    if (this.rejectTimer > 0) this.rejectTimer = Math.max(0, this.rejectTimer - dt);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private vertexAt(px: number, py: number): VertexId | null {
    const camera = this.getCameraRef();
    let best: VertexId | null = null;
    let bestDist = HIT_RADIUS;
    for (const v of this.gameState.vertices.values()) {
      if (v.isPseudo) continue;
      const d = dist({ px, py }, this.renderer.toCanvas(v.pos, camera));
      if (d < bestDist) { bestDist = d; best = v.id; }
    }
    return best;
  }

  private canStartFrom(vid: VertexId): boolean {
    const v = this.gameState.vertices.get(vid);
    return !!v && v.degree < 3;
  }

  private canEndAt(vid: VertexId): boolean {
    if (this.grayedVertices.has(vid)) return false;
    const v = this.gameState.vertices.get(vid);
    if (!v || v.degree >= 3) return false;
    if (vid === this.startVertex && v.degree >= 2) return false;
    return true;
  }

  private computeGrayed(startVid: VertexId): Set<VertexId> {
    const grayed = new Set<VertexId>();
    const startV = this.gameState.vertices.get(startVid);
    if (startV && startV.degree >= 2) grayed.add(startVid);
    return grayed;
  }

  private checkCrossing(): CanvasPoint | null {
    if (this.canvasStroke.length < 2) return null;
    const camera = this.getCameraRef();
    // Test the tip segment spherically (great-circle arc vs great-circle arc) so
    // crossing detection is camera-independent — a far-side edge that only
    // overlaps the stroke in screen projection is no longer a false positive.
    // sphereStroke runs parallel to canvasStroke; the poison marker is cosmetic,
    // so on a hit we return the current tip canvas point (within one sample of
    // the true crossing) rather than solving for the exact intersection.
    const n = this.sphereStroke.length;
    const sa = this.sphereStroke[n - 2], sb = this.sphereStroke[n - 1];
    const tipCanvas = this.canvasStroke[this.canvasStroke.length - 1];

    for (const edge of this.gameState.edges.values()) {
      // Edges already incident to the stroke's start vertex share a point with
      // it exactly, so the tip segment's own departure samples can register a
      // false crossing right at that shared endpoint. Skip the one polyline
      // segment touching each such end (mirrors the nearStart/skipFirst
      // exclusion the self-stroke check below already has).
      const skipFirst = edge.v1 === this.startVertex ? 1 : 0;
      const skipLast  = edge.v2 === this.startVertex ? 1 : 0;
      if (segCrossesPolylineSphere(sa, sb, edge.points, skipLast, skipFirst)) {
        return tipCanvas;
      }
    }

    // When the stroke tip is near the start vertex the player may be closing a
    // loop move.  The returning segment will naturally cross the departing
    // segment right at the vertex — not a real crossing.  Skip the early stroke
    // segments (those still in the departure zone around the vertex) so that
    // loop moves can close cleanly.
    const startPos  = this.canvasStroke[0];
    const nearStart = dist(tipCanvas, startPos) < HIT_RADIUS * 2;
    const skipFirst = nearStart ? Math.ceil(HIT_RADIUS / SAMPLE_SPACING) + 1 : 0;

    if (segCrossesPolylineSphere(sa, sb, this.sphereStroke, 3, skipFirst)) {
      return tipCanvas;
    }

    // Detect strokes that pass *through* a vertex (other than the start vertex).
    // Enter/exit zone tracking: flag on first entry into a vertex's hit radius,
    // poison only when the tip exits that radius again (true pass-through).
    // Approaching and releasing inside the zone is fine — that's a valid endpoint.
    for (const v of this.gameState.vertices.values()) {
      if (v.isPseudo || v.id === this.startVertex) continue;
      const vc      = this.renderer.toCanvas(v.pos, camera);
      const inside  = dist(tipCanvas, vc) < HIT_RADIUS;
      const entered = this.vertexZonesEntered.has(v.id);
      if (inside && !entered) {
        this.vertexZonesEntered.set(v.id, tipCanvas);
      } else if (!inside && entered) {
        return vc;
      }
    }

    return null;
  }

  toSpherePoint(px: number, py: number): SpherePoint {
    // Unproject gives a point in camera space; rotate back to world space.
    const camera = this.getCameraRef();
    const camPt = this.renderer.projection === 'rect'
      ? unprojectRect(px, py, this.renderer.canvasWidth, this.renderer.canvasHeight)
      : unproject(px, py, this.renderer.projectionDiskRadius, this.renderer.centerX, this.renderer.centerY);
    return unrotateSpherePoint(camPt, camera);
  }

  private startReject(): void {
    this.rejectStroke = [...this.canvasStroke];
    this.rejectTimer  = 600;
    this.clearDrawState();
  }

  private clearDrawState(): void {
    this.canvasStroke       = [];
    this.sphereStroke       = [];
    this.safeLength         = 0;
    this.poisonPoint        = null;
    this.grayedVertices     = new Set();
    this.startVertex        = -1;
    this.vertexZonesEntered = new Map();
  }
}
