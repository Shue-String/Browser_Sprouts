/**
 * Live-editable numeric constants, surfaced in the Debug → Tuning panel so
 * physics/timing knobs can be tweaked at runtime without editing source and
 * reloading. Consumers read `tunables.<key>` on every use (not just once at
 * module load) so panel edits take effect immediately.
 *
 * To add a new tunable: add a field to `Tunables`, a default in
 * `DEFAULT_TUNABLES`, a row in `TUNABLE_SPECS`, and read `tunables.<key>`
 * at its use site instead of a local constant. The panel is generated from
 * `TUNABLE_SPECS` — no UI wiring needed.
 */

export interface Tunables {
  // --- src/model/smooth.ts: smoothing / repulsion physics ---
  laplacianStrength: number;
  repulsionRadius: number;
  vertexRepulsionStep: number;
  sampleRepulsionStep: number;
  tighteningStep: number;
  dragAttractionStep: number;
  tightAngleThreshold: number;
  tightAngleStep: number;
  coRegionBoost: number;
  coRegionRadius: number;
  settleEpsilon: number;
  pointsPerRadian: number;
  overcrowdRatio: number;
  overcrowdMinExcess: number;
  edgeClearance: number;
  curveRefineAngle: number;
  curveRefineWindow: number;
  maxEdgePoints: number;

  // --- src/model/moveRouter.ts: smoothPath clearance floor ---
  keepClearRange: number;
  keepClearShare: number;
  keepClearMax: number;

  // --- src/main.ts: Recreate playback timing ---
  settleMs: number;
  extraSettleStableFrames: number;
  extraSettleTimeoutMs: number;
  recreateSettleThreshold: number;
  recreateRetries: number;
  recreateRetrySettleMs: number;

  // --- src/model/deadRegions.ts: collapse animation speed, one per step function (1 = the
  // original hard-coded speed; the animation runs that many times as fast) ---
  deadShrinkSpeed: number;
  louseSpeed: number;
  parallelDeadSpeed: number;
  tripleParallelDeadSpeed: number;
  triangleDeadSpeed: number;
  quadDeadSpeed: number;
  enclosedTriangleSpeed: number;
  bigonTipSpeed: number;
  selfConnectedDeadSpeed: number;
}

export const DEFAULT_TUNABLES: Tunables = {
  laplacianStrength: 0.5,
  repulsionRadius: 0.5,
  vertexRepulsionStep: 0.025,
  sampleRepulsionStep: 0.030,
  tighteningStep: 0.15,
  dragAttractionStep: 0.04,
  tightAngleThreshold: Math.PI / 6,
  tightAngleStep: 0.008,
  coRegionBoost: 4.0,
  coRegionRadius: 0.7,
  settleEpsilon: 1e-4,
  pointsPerRadian: 8,
  overcrowdRatio: 2.0,
  overcrowdMinExcess: 6,
  edgeClearance: 0.03,
  curveRefineAngle: 0, // off: with it on, Recreate replays 14/40 games faithfully vs 37/40 without (2026-10-05 sweep); 0.7 is the value that was tried
  curveRefineWindow: 0.1,
  maxEdgePoints: 120,

  keepClearRange: 0.3,
  keepClearShare: 0.5,
  keepClearMax: 0.1,

  settleMs: 1500,
  extraSettleStableFrames: 6,
  extraSettleTimeoutMs: 8000,
  recreateSettleThreshold: 0.004,
  // No reproducing candidate → re-arm the physics and retry before manual drawing. Playback
  // waits are wall-clock, so a slow frame rate can leave the board under-smoothed and the router
  // unable to thread a narrow wedge (sweep s5 g5 m6: stuck after relax, routes after +50 steps).
  recreateRetries: 2,
  recreateRetrySettleMs: 1000,

  deadShrinkSpeed: 0.5,
  louseSpeed: 0.5,
  parallelDeadSpeed: 0.5,
  tripleParallelDeadSpeed: 0.5,
  triangleDeadSpeed: 0.5,
  quadDeadSpeed: 0.5,
  enclosedTriangleSpeed: 0.5,
  bigonTipSpeed: 0.5,
  selfConnectedDeadSpeed: 0.5,
};

export const tunables: Tunables = { ...DEFAULT_TUNABLES };

export interface TunableSpec {
  key: keyof Tunables;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  /** Tuning-panel column (0 = left, the default). */
  column?: number;
}

export const TUNABLE_SPECS: TunableSpec[] = [
  { key: 'laplacianStrength',   label: 'Laplacian strength',          group: 'Smoothing', min: 0,    max: 1,        step: 0.01 },
  { key: 'repulsionRadius',     label: 'Repulsion radius (rad)',      group: 'Smoothing', min: 0,    max: 1.5,      step: 0.01 },
  { key: 'vertexRepulsionStep', label: 'Vertex repulsion step',       group: 'Smoothing', min: 0,    max: 0.2,      step: 0.001 },
  { key: 'sampleRepulsionStep', label: 'Sample repulsion step',       group: 'Smoothing', min: 0,    max: 0.2,      step: 0.001 },
  { key: 'tighteningStep',      label: 'Free-space tightening step',  group: 'Smoothing', min: 0,    max: 1,        step: 0.01 },
  { key: 'dragAttractionStep',  label: 'Drag attraction step',        group: 'Smoothing', min: 0,    max: 0.3,      step: 0.005 },
  { key: 'tightAngleThreshold', label: 'Tight-angle threshold (rad)', group: 'Smoothing', min: 0,    max: 1.6,      step: 0.01 },
  { key: 'tightAngleStep',      label: 'Tight-angle step',            group: 'Smoothing', min: 0,    max: 0.1,      step: 0.001 },
  { key: 'coRegionBoost',       label: 'Co-region repulsion boost',   group: 'Smoothing', min: 1,    max: 10,       step: 0.1 },
  { key: 'coRegionRadius',      label: 'Co-region repulsion radius',  group: 'Smoothing', min: 0,    max: 1.5,      step: 0.01 },
  { key: 'settleEpsilon',       label: 'Settle epsilon (rad)',        group: 'Smoothing', min: 0,    max: 0.01,     step: 0.00001 },
  { key: 'pointsPerRadian',     label: 'Points per radian',           group: 'Smoothing', min: 1,    max: 30,       step: 1 },
  { key: 'overcrowdRatio',      label: 'Overcrowd ratio',             group: 'Smoothing', min: 1,    max: 5,        step: 0.1 },
  { key: 'overcrowdMinExcess',  label: 'Overcrowd min excess',        group: 'Smoothing', min: 0,    max: 30,       step: 1 },
  { key: 'edgeClearance',       label: 'Edge clearance (rad; vertices keep 2x)', group: 'Smoothing', min: 0, max: 0.1, step: 0.001 },
  { key: 'curveRefineAngle',    label: 'Curve refine: turn (rad, 0 = off)', group: 'Smoothing', min: 0,    max: 3,        step: 0.05 },
  { key: 'curveRefineWindow',   label: 'Curve refine: window (rad)',  group: 'Smoothing', min: 0.01, max: 0.5,      step: 0.01 },
  { key: 'maxEdgePoints',       label: 'Max interior points per edge', group: 'Smoothing', min: 10,  max: 400,      step: 10 },

  { key: 'keepClearRange', label: 'Clearance range (rad)',          group: 'Routing', min: 0, max: 1,   step: 0.01 },
  { key: 'keepClearShare', label: 'Clearance kept (share of raw)',  group: 'Routing', min: 0, max: 1,   step: 0.05 },
  { key: 'keepClearMax',   label: 'Clearance kept cap (rad)',       group: 'Routing', min: 0, max: 0.3, step: 0.005 },

  { key: 'settleMs',                label: 'Settle dwell (ms)',           group: 'Recreate', min: 0, max: 5000,  step: 50 },
  { key: 'extraSettleStableFrames', label: 'Extra-settle stable frames',  group: 'Recreate', min: 1, max: 30,    step: 1 },
  { key: 'extraSettleTimeoutMs',    label: 'Extra-settle timeout (ms)',   group: 'Recreate', min: 0, max: 30000, step: 500 },
  { key: 'recreateSettleThreshold', label: 'Recreate settle threshold',   group: 'Recreate', min: 0, max: 0.05,  step: 0.0005 },
  { key: 'recreateRetries',         label: 'No-candidate retries',        group: 'Recreate', min: 0, max: 10,    step: 1 },
  { key: 'recreateRetrySettleMs',   label: 'Retry settle (ms)',           group: 'Recreate', min: 0, max: 10000, step: 250 },

  { key: 'deadShrinkSpeed',         label: 'General dead component',              group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'louseSpeed',              label: 'Louse',                               group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'parallelDeadSpeed',       label: 'Parallel dead (bigon)',               group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'tripleParallelDeadSpeed', label: 'Triple parallel dead',                group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'triangleDeadSpeed',       label: 'Triangle dead',                       group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'quadDeadSpeed',           label: 'Quad dead',                           group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'enclosedTriangleSpeed',   label: 'Enclosed triangle',                   group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'bigonTipSpeed',           label: 'Bigon tip',                           group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
  { key: 'selfConnectedDeadSpeed',  label: 'Self-connected dead',                 group: 'Collapse speed (1 = original)', min: 0.05, max: 3, step: 0.05, column: 1 },
];

// DEFAULT_TUNABLES (a Tunables) and TUNABLE_SPECS (a plain array) are two independent listings of
// the same key set -- the compiler enforces the former, not the latter, so a field added to one
// without the other compiles fine and just silently vanishes from the Debug panel. Checked once at
// module load rather than trusted to the doc comment above.
(function checkTunableSpecsComplete(): void {
  const specKeys = new Set(TUNABLE_SPECS.map(s => s.key));
  const missing = (Object.keys(DEFAULT_TUNABLES) as (keyof Tunables)[]).filter(k => !specKeys.has(k));
  if (missing.length) {
    console.error(`[tunables] missing TUNABLE_SPECS row(s) for: ${missing.join(', ')}`);
  }
})();

const STORAGE_KEY = 'sprouts-tunables-v1';

/** Load any saved overrides from localStorage on top of the defaults. */
export function loadTunables(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Tunables>;
    for (const spec of TUNABLE_SPECS) {
      const v = saved[spec.key];
      if (typeof v === 'number' && Number.isFinite(v)) tunables[spec.key] = v;
    }
  } catch {
    // corrupt or inaccessible storage — just keep defaults
  }
}

/** Persist the current tunable values so they survive a reload. */
export function saveTunables(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tunables));
  } catch {
    // storage unavailable/full — edits still work for this session
  }
}

/** Reset every tunable to its shipped default. */
export function resetTunables(): void {
  Object.assign(tunables, DEFAULT_TUNABLES);
  saveTunables();
}
