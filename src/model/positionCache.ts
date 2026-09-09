/**
 * Persistent cache for Position Browser data, backed by localStorage so lookups survive across
 * app opens. Three stores, all keyed by a position's bracketless canonical encoding:
 *
 *   full    — the complete analysis of positions the user has actually looked up (quick recall).
 *   meta    — light metadata {nimber, min/maxMoves, subposCount} for EVERY position seen, whether
 *             looked up directly or encountered as a tree node / child while analyzing something
 *             else ("metadata about other positions in the game tree if calculated on the fly").
 *   parents — reverse index childCanon -> parentCanon[]: unioned from every analysis's edges and
 *             from live gameplay transitions. We never compute parents; this is "as available".
 */
import type { AnalysisOk, GraphNodeMeta } from '../engine/stalks';

export interface LightMeta {
  nimber: number;
  minMoves: number;
  maxMoves: number;
  subposCount: number;
}

// v2: added quickCanon / quickChildren to the cached AnalysisOk shape. Bumping invalidates old
// full-cache entries (re-analyzed cheaply on demand) so renderOk never sees a missing field.
// v3: added `move` to ChildInfo (move-preview hover feature). Entries cached before that shape
// change silently lack it, breaking hover-preview with no console error for whatever position
// happened to already be cached (commonly the game root, since it's looked up first/most often).
// v4: added `movetype` to MoveInfo (Alpha movetype feature, Phase 5). Same stale-entry risk as v3.
// v5: added minMoves/maxMoves to QuickCanon (quick-canon move-bound display). Old entries have a
// bounds-less quickCanon, which the toggle would then silently show as the exact numbers relabeled
// with no way to tell -- worse than a plain missing field, so bump rather than let it slide.
const FULL_KEY = 'sprouts.posCache.v5';
const META_KEY = 'sprouts.posMeta.v1';
const PARENTS_KEY = 'sprouts.posParents.v1';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const full: Record<string, AnalysisOk> = load(FULL_KEY, {});
const meta: Record<string, LightMeta> = load(META_KEY, {});
const parents: Record<string, string[]> = load(PARENTS_KEY, {});

// Quick-canon counterpart of `meta`, keyed by quick-canon REPRESENTATIVE encoding rather than
// structural canon (see stalks/tools/dump_master_meta.cpp) -- in-memory only, never persisted (same
// rationale as the exact seed below: static, cheap to refetch, would blow the localStorage quota).
// `nimber` on an entry is the representative's own value (offset 0); callers XOR in a specific
// position's own quick-canon offset themselves.
const quickMeta: Record<string, LightMeta> = {};

// Batched write-through: many records fold in during one analysis; flush once on a microtask.
let dirty = new Set<string>();
let flushQueued = false;
function markDirty(key: string): void {
  dirty.add(key);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const keys = dirty;
    dirty = new Set();
    try {
      if (keys.has(FULL_KEY)) localStorage.setItem(FULL_KEY, JSON.stringify(full));
      if (keys.has(META_KEY)) localStorage.setItem(META_KEY, JSON.stringify(meta));
      if (keys.has(PARENTS_KEY)) localStorage.setItem(PARENTS_KEY, JSON.stringify(parents));
    } catch {
      /* quota exceeded or storage disabled — cache silently becomes session-only */
    }
  });
}

function metaOfFull(a: AnalysisOk): LightMeta {
  return { nimber: a.nimber, minMoves: a.minMoves, maxMoves: a.maxMoves, subposCount: a.subposCount };
}

function metaEqual(a: LightMeta, b: LightMeta): boolean {
  return (
    a.nimber === b.nimber &&
    a.minMoves === b.minMoves &&
    a.maxMoves === b.maxMoves &&
    a.subposCount === b.subposCount
  );
}

function fmtMeta(m: LightMeta): string {
  return `{nimber:${m.nimber},minMoves:${m.minMoves},maxMoves:${m.maxMoves},subposCount:${m.subposCount}}`;
}

// `full` and `meta` disagreeing about the SAME encoding is always a real bug (e.g. two different
// analysis paths computing different values for what should be one canonical position) -- distinct
// from the two stores' differing COVERAGE (see header comment), which is by design. Checked whenever
// a value lands in `meta`, against both whatever `full` already knows and whatever `meta` already
// held, so a mismatch from either direction surfaces immediately instead of silently overwriting.
function checkMetaConsistency(enc: string, incoming: LightMeta): void {
  const existingFull = full[enc];
  if (existingFull) {
    const derived = metaOfFull(existingFull);
    if (!metaEqual(derived, incoming)) {
      console.warn(
        `[positionCache] MISMATCH for ${enc}: meta ${fmtMeta(incoming)} vs full-derived ${fmtMeta(derived)}`,
      );
    }
  }
  const existingMeta = meta[enc];
  if (existingMeta && !metaEqual(existingMeta, incoming)) {
    console.warn(
      `[positionCache] MISMATCH for ${enc}: new meta ${fmtMeta(incoming)} vs previously cached ${fmtMeta(existingMeta)}`,
    );
  }
}

function setMeta(enc: string, m: LightMeta): void {
  checkMetaConsistency(enc, m);
  meta[enc] = m;
  markDirty(META_KEY);
}

function addParent(child: string, parent: string): void {
  if (child === parent) return;
  const list = parents[child] ?? (parents[child] = []);
  if (!list.includes(parent)) {
    list.push(parent);
    markDirty(PARENTS_KEY);
  }
}

function metaOfNode(n: GraphNodeMeta): LightMeta {
  return { nimber: n.nimber, minMoves: n.minMoves, maxMoves: n.maxMoves, subposCount: n.subposCount };
}

/** Fold a full analysis into all three stores. */
export function record(result: AnalysisOk): void {
  full[result.canon] = result;
  markDirty(FULL_KEY);

  setMeta(result.canon, {
    nimber: result.nimber,
    minMoves: result.minMoves,
    maxMoves: result.maxMoves,
    subposCount: result.subposCount,
  });

  // Every graph node's metadata + its (minimal-subposition) child edges.
  for (const n of result.graphMeta) {
    setMeta(n.enc, metaOfNode(n));
    for (const c of n.children) addParent(c, n.enc);
  }

  // The root's real play-children: record their metadata and that the root is their parent.
  for (const c of result.children) {
    setMeta(c.enc, {
      nimber: c.nimber,
      minMoves: c.minMoves,
      maxMoves: c.maxMoves,
      subposCount: c.subposCount,
    });
    addParent(c.enc, result.canon);
  }
}

/** Record a single live-gameplay transition (both encodings already canonical). */
export function recordEdge(parentCanon: string, childCanon: string): void {
  if (!parentCanon || !childCanon) return;
  addParent(childCanon, parentCanon);
}

// One-time seed from the offline-computed master save dump (see stalks/tools/dump_master_meta.cpp
// and stalks/saves/master_meta.json) so large positions the masters cover skip on-demand
// recomputation entirely. Seed entries never overwrite real cache entries, and — being static and
// cheap to refetch — are kept in-memory only (not written back to localStorage).
let seedLoaded = false;
export async function loadMasterSeed(url = '/master_meta.json'): Promise<void> {
  if (seedLoaded) return;
  seedLoaded = true;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const seed = (await res.json()) as Record<string, LightMeta>;
    for (const enc in seed) {
      if (!(enc in meta)) meta[enc] = seed[enc];
    }
  } catch {
    /* seed unavailable (not built, or offline) — falls back to on-demand analysis as before */
  }
}

// As loadMasterSeed, but for the quick-canon meta dump (stalks/tools/dump_master_meta.cpp's second
// output). Kept separate from `meta`/`seedLoaded` since it's keyed by a different scheme (quick-canon
// rep, not structural canon) and is only needed once a caller actually asks for quick-canon bounds.
let quickSeedLoaded = false;
export async function loadQuickMasterSeed(url = '/master_meta_quick.json'): Promise<void> {
  if (quickSeedLoaded) return;
  quickSeedLoaded = true;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const seed = (await res.json()) as Record<string, LightMeta>;
    for (const enc in seed) {
      if (!(enc in quickMeta)) quickMeta[enc] = seed[enc];
    }
  } catch {
    /* seed unavailable (not built, or offline) -- quick-canon move bounds just stay unknown */
  }
}

export function getFull(canon: string): AnalysisOk | undefined {
  return full[canon];
}

export function getMeta(canon: string): LightMeta | undefined {
  return meta[canon];
}

export function getQuickMeta(repEnc: string): LightMeta | undefined {
  return quickMeta[repEnc];
}

export function getParents(canon: string): string[] {
  return parents[canon] ?? [];
}
