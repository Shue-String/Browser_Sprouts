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

  // --- src/main.ts: Recreate playback timing ---
  settleMs: number;
  extraSettleStableFrames: number;
  extraSettleTimeoutMs: number;
  recreateSettleThreshold: number;
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

  settleMs: 1500,
  extraSettleStableFrames: 6,
  extraSettleTimeoutMs: 8000,
  recreateSettleThreshold: 0.004,
};

export const tunables: Tunables = { ...DEFAULT_TUNABLES };

export interface TunableSpec {
  key: keyof Tunables;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
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

  { key: 'settleMs',                label: 'Settle dwell (ms)',           group: 'Recreate', min: 0, max: 5000,  step: 50 },
  { key: 'extraSettleStableFrames', label: 'Extra-settle stable frames',  group: 'Recreate', min: 1, max: 30,    step: 1 },
  { key: 'extraSettleTimeoutMs',    label: 'Extra-settle timeout (ms)',   group: 'Recreate', min: 0, max: 30000, step: 500 },
  { key: 'recreateSettleThreshold', label: 'Recreate settle threshold',   group: 'Recreate', min: 0, max: 0.05,  step: 0.0005 },
];

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
