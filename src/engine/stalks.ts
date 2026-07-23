/**
 * Frontend wrapper around the Stalks engine compiled to WebAssembly (stalks/build_wasm.bat →
 * ./stalks.js). The generated module is loaded lazily and once; if it hasn't been built yet the
 * dynamic import fails and we degrade gracefully to an `engine-unavailable` result so the rest of
 * the app keeps working.
 */
import type { StalksModule } from './stalksWasm.js';

// --- Result shapes: a typed mirror of analyze.cpp's JSON ------------------------------------

/** How a child edge was reached (mirrors stalks::MoveKind: 0=Enclosure, 1=Join, 2=InteriorPseudo). */
export enum MoveKind {
  Enclosure = 0,
  Join = 1,
  InteriorPseudo = 2,
}

/**
 * Identifies which move on the parent position reaches a given child, in the engine's abstract
 * component/region/boundary index space (not live game VertexIds — see moves.hpp MoveTag).
 * boundary/mask are enclosure-only; b1/b2 are join-only; i/j are used by both. InteriorPseudo
 * moves only populate component/region/boundary/i (the pseudo token's position).
 */
export interface MoveInfo {
  kind: MoveKind;
  component: number;
  region: number;
  boundary: number;
  mask: number;
  b1: number;
  b2: number;
  i: number;
  j: number;
}

/**
 * A play-child of a position. nimber/minMoves/maxMoves are the UNKNOWN_VALUE sentinel (-1) when
 * the child hasn't been valued -- see AnalysisErr.children, populated for oversized ('too-large')
 * positions where valuing every child is too expensive; render -1 as "?". `quickCanon` (the
 * child's own quick-canon representative) is only populated in that same unvalued case.
 */
export interface ChildInfo {
  enc: string;
  nimber: number;
  subposCount: number;
  minMoves: number;
  maxMoves: number;
  move?: MoveInfo;
  quickCanon?: QuickCanon;
}

/** Sentinel for "not yet computed" in ChildInfo/GraphNodeMeta fields -- mirrors the engine's Node
 * placeholder sentinel (see stalks/src/graph.hpp). Real nimber/minMoves/maxMoves are always >= 0. */
export const UNKNOWN_VALUE = -1;

/** Quick-canon (Advanced Collections) representative of a position: rep encoding + nimber offset. */
export interface QuickCanon {
  enc: string;
  offset: number; // 0 or 1; nimber(position) === nimber(rep) ^ offset
}

/** A play-child reduced by quickCanon, deduped by (enc, offset). nimber is the child's true value. */
export interface QuickChildInfo {
  enc: string;
  offset: number;
  nimber: number;
  subposCount: number;
}

export interface GraphNodeMeta {
  enc: string;
  nimber: number;
  minMoves: number;
  maxMoves: number;
  subposCount: number;
  children: string[];
}

export interface AnalysisOk {
  ok: true;
  canon: string;
  nimber: number;
  minMoves: number;
  maxMoves: number;
  subposCount: number;
  nimberBreakdown: number[];
  children: ChildInfo[];
  quickCanon: QuickCanon;
  quickChildren: QuickChildInfo[];
  graphMeta: GraphNodeMeta[];
}

export interface AnalysisErr {
  ok: false;
  reason: 'parse-error' | 'too-large' | 'needs-calculation' | 'engine-unavailable';
  message?: string;
  canon?: string;
  maxLives2?: number;
  quickCanon?: QuickCanon; // present on 'needs-calculation' so the two-button page can show the rep
  children?: ChildInfo[]; // present on 'too-large' -- cheap to enumerate; values are UNKNOWN_VALUE
}

export type AnalysisResult = AnalysisOk | AnalysisErr;

/**
 * Result of an on-demand quick-canon nimber calculation (the "Calculate Nimber" button). Only the
 * nimber is exact; move-length bounds are not meaningful in quick-canon and are omitted.
 */
export interface QuickAnalysisOk {
  ok: true;
  reason: 'quick';
  canon: string;
  nimber: number;
  quickCanon: QuickCanon;
  quickChildren: QuickChildInfo[];
}

export type QuickAnalysisResult = QuickAnalysisOk | AnalysisErr;

// --- Lazy module loading --------------------------------------------------------------------

let modPromise: Promise<StalksModule> | null = null;
/** Set once modPromise resolves — lets callers that can tolerate "not ready yet" go sync. */
let resolvedMod: StalksModule | null = null;

function getModule(): Promise<StalksModule> {
  if (!modPromise) {
    modPromise = import('./stalksWasm.js')
      .then(m => m.default())
      .then(mod => { resolvedMod = mod; return mod; })
      .catch(err => {
        modPromise = null; // allow a later retry (e.g. after the wasm is built)
        throw err;
      });
  }
  return modPromise;
}

/**
 * Kick off the WASM module load without waiting on it. Safe to call multiple times
 * (idempotent — getModule caches the promise). Call once at app startup so canonSync
 * has a chance to be ready by the time gates that need it fire.
 */
export function preloadModule(): void {
  void getModule().catch(() => {});
}

/**
 * Synchronous canon(), available only once the module has finished loading (see
 * preloadModule). Returns null if not yet loaded/unavailable — callers must have a
 * fallback for that case (e.g. the pre-canon TS string compare) since load timing
 * isn't guaranteed, especially on the very first moves of a session.
 */
export function canonSync(enc: string): string | null {
  if (!resolvedMod) return null;
  try {
    return resolvedMod.canon(enc);
  } catch {
    return null;
  }
}

/** Canonicalization result carrying per-character provenance — see canonicalizeTrackedProvenanceSync. */
export interface TrackedProvenanceResult {
  enc: string;
  /** src[m] = index into the INPUT string's char/charInfo array that the m-th output char descends from. */
  src: number[];
}

/**
 * Synchronous canonicalization of an already-decompressed encoding (see
 * encodePositionDecompressed in encoding.ts — no pseudo-points), with provenance mapping each
 * canonical character back to the index of the input character it descends from. Lets a caller with
 * its own per-input-char vertex binding (e.g. EncodingResult.charInfo) build a canonical-string ->
 * live-vertex binding without the engine ever seeing a live VertexId. Only available once the module
 * has finished loading (see preloadModule); returns null if not yet loaded or on any parse/engine
 * error — callers must have a fallback (e.g. showing the uncanonicalized text).
 */
export function canonicalizeTrackedProvenanceSync(enc: string): TrackedProvenanceResult | null {
  if (!resolvedMod) return null;
  try {
    const raw = JSON.parse(resolvedMod.canonicalizeTrackedProvenance(enc)) as
      | { ok: true; enc: string; src: number[] }
      | { ok: false; reason: string; message?: string };
    if (!raw.ok) return null;
    return { enc: raw.enc, src: raw.src };
  } catch {
    return null;
  }
}

/** Analyze an encoding. Never rejects — engine/parse problems come back as an `ok:false` result. */
export async function analyze(enc: string): Promise<AnalysisResult> {
  let mod: StalksModule;
  try {
    mod = await getModule();
  } catch {
    return {
      ok: false,
      reason: 'engine-unavailable',
      message: 'Stalks engine not built yet — run stalks\\build_wasm.bat.',
    };
  }
  try {
    return JSON.parse(mod.analyze(enc)) as AnalysisResult;
  } catch (e) {
    return { ok: false, reason: 'parse-error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of childrenTracked: same per-child shape (and real values) as analyze(). */
export type ChildrenTrackedResult =
  | { ok: true; children: ChildInfo[] }
  | { ok: false; reason: 'parse-error' | 'too-large' | 'engine-unavailable'; message?: string };

/**
 * Children of `enc`'s LITERAL parsed structure, with move (region/boundary/i/j) indices guaranteed
 * to match that same literal structure -- unlike analyze(), which canonicalizes `enc` first and can
 * silently recompress a Hollow/Split/Triplet organ, shifting region/boundary numbering out from
 * under a caller retracing moves against the original decompressed text (see applyMoveTracked and
 * collectGenetics.ts's analyzeTEntry, the reason this exists: analyzeTEntry must enumerate a tracked
 * T-child's own children in the SAME coordinate space as its decompressed enc + parallel provenance,
 * which analyze() cannot guarantee once a compressible organ is present). `enc` must already be
 * decompressed (no pseudo-points). Children are fully valued (real nimbers), same as analyze()'s.
 * Never rejects (an oversized `enc` comes back as an ordinary 'too-large' ok:false, not a throw).
 */
export async function childrenTracked(enc: string): Promise<ChildrenTrackedResult> {
  let mod: StalksModule;
  try {
    mod = await getModule();
  } catch {
    return { ok: false, reason: 'engine-unavailable', message: 'Stalks engine not built yet.' };
  }
  try {
    return JSON.parse(mod.childrenTracked(enc)) as ChildrenTrackedResult;
  } catch (e) {
    return { ok: false, reason: 'parse-error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of regionMovesTracked: same per-child shape (and real values) as childrenTracked. */
export type RegionMovesResult =
  | { ok: true; children: ChildInfo[] }
  | { ok: false; reason: 'bad-move' | 'engine-error' | 'too-large' | 'parse-error' | 'engine-unavailable'; message?: string };

/**
 * Every legal move of `enc`'s component `component` touching the token at (region, boundary,
 * token) -- e.g. a DisaPoint's own occurrence -- valued the same way childrenTracked's children
 * are. `enc` must already be decompressed (no pseudo-points), same convention as childrenTracked.
 *
 * This is the ground-truth replacement for collectGenetics.ts's old "L-move" detection, which
 * guessed by transplanting a MoveTag analyze()'s own (deduped) children list happened to keep onto
 * the target's region and hoping the boundary indices lined up -- unsound whenever a real L-move's
 * result coincided with a differently-shaped-but-isomorphic move elsewhere in the position (only
 * one MoveTag survives analyze()'s dedup-by-result either way, so the transplant had nothing to
 * find). Enumerating the target's own legal moves directly here needs no such correspondence.
 * Never rejects.
 */
export async function regionMovesTracked(
  enc: string,
  component: number,
  region: number,
  boundary: number,
  token: number,
): Promise<RegionMovesResult> {
  let mod: StalksModule;
  try {
    mod = await getModule();
  } catch {
    return { ok: false, reason: 'engine-unavailable', message: 'Stalks engine not built yet.' };
  }
  try {
    return JSON.parse(mod.regionMovesTracked(enc, component, region, boundary, token)) as RegionMovesResult;
  } catch (e) {
    return { ok: false, reason: 'parse-error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of allMovesTracked: same per-child shape (and real values) as childrenTracked. */
export type AllMovesResult =
  | { ok: true; children: ChildInfo[] }
  | { ok: false; reason: 'engine-error' | 'too-large' | 'parse-error' | 'engine-unavailable'; message?: string };

/**
 * Every legal move of `enc`'s ENTIRE position, across every component, valued the same way
 * childrenTracked's children are -- but, unlike childrenTracked, NOT deduped by canonical result.
 * `enc` must already be decompressed (no pseudo-points), same convention as childrenTracked.
 *
 * childrenTracked/analyze() dedupe children by canonical-result (`seen.insert(serialize(child))`
 * in childrenAllWithMoveTag), keeping only the first move reaching any given canonical outcome.
 * That's correct for "list this position's children" but wrong for a Grandparent Bypass grandchild
 * retrace: when two moves are canonically identical because of a genuine structural symmetry (e.g.
 * two isomorphic detached-pair regions, each self-enclosable to the same canonical result), only
 * one survives dedup, and if that one doesn't happen to be the move preserving the caller's tracked
 * token, the retrace wrongly concludes "target didn't survive" -- even though the OTHER
 * (deduped-away) move preserves it and, by the same symmetry, matches just as well. See
 * collectGenetics.ts's analyzeTEntry, the caller this exists for. Never rejects.
 */
export async function allMovesTracked(enc: string): Promise<AllMovesResult> {
  let mod: StalksModule;
  try {
    mod = await getModule();
  } catch {
    return { ok: false, reason: 'engine-unavailable', message: 'Stalks engine not built yet.' };
  }
  try {
    return JSON.parse(mod.allMovesTracked(enc)) as AllMovesResult;
  } catch (e) {
    return { ok: false, reason: 'parse-error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Engine-unavailable error, shared by the on-demand entry points. */
function unavailable(): AnalysisErr {
  return {
    ok: false,
    reason: 'engine-unavailable',
    message: 'Stalks engine not built yet — run stalks\\build_wasm.bat.',
  };
}

/**
 * On-demand full (exact) game-tree analysis, up to 16 lives — the "Calculate Game Tree" button.
 * Same result shape as analyze(); may take a few moments for large positions. Never rejects.
 */
export async function analyzeFull(enc: string): Promise<AnalysisResult> {
  let mod: StalksModule;
  try {
    mod = await getModule();
  } catch {
    return unavailable();
  }
  try {
    return JSON.parse(mod.analyzeFull(enc)) as AnalysisResult;
  } catch (e) {
    return { ok: false, reason: 'parse-error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * On-demand quick-canon nimber, up to 16 lives — the "Calculate Nimber" button. Returns the exact
 * Grundy value plus the quick-canon representative and children. Never rejects.
 */
export async function analyzeNimber(enc: string): Promise<QuickAnalysisResult> {
  let mod: StalksModule;
  try {
    mod = await getModule();
  } catch {
    return unavailable();
  }
  try {
    return JSON.parse(mod.analyzeNimber(enc)) as QuickAnalysisResult;
  } catch (e) {
    return { ok: false, reason: 'parse-error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Canonicalize an encoding to its bracketless canon form. Returns '' if unavailable/invalid. */
export async function canon(enc: string): Promise<string> {
  try {
    const mod = await getModule();
    return mod.canon(enc);
  } catch {
    return '';
  }
}

// --- Tracked move application (M2: engine computes the child from a move) --------------------
//
// The engine takes a decompressed parent encoding plus per-token provenance and a move descriptor,
// applies the move, cleans up + canonicalizes, and returns the decompressed-canonical child
// encoding with provenance carried through. This replaces deriving the child encoding from live
// geometry: geometry becomes a checker, not the source of truth. See project_encoding_canon_rework.

/** Provenance sentinels (mirror stalks::GEN_SRC / the untracked default in position.hpp). */
export const GEN_SRC = -2; // token GENERATED by the move (the new midpoint vertex); no parent
export const UNTRACKED = -1; // provenance not maintained for this token

/**
 * Per-token provenance parallel to a Position's serialization: src[component][region][boundary][k]
 * is the srcId of the k-th token of that boundary. serialize() emits exactly one character per
 * token (a letter/'9' for a membrane, a digit otherwise), so PosSrc zips against the encoding by
 * walking both in the same component/region/boundary/token order. A srcId is GEN_SRC, UNTRACKED, or
 * the caller's parent live VertexId.
 */
export type PosSrc = number[][][][];

/** TS mirror of stalks::TrackedCanon: the decompressed-canonical child + parallel provenance. */
export interface TrackedChild {
  enc: string;
  src: PosSrc;
}

/**
 * Which move to apply, in the PARENT's decompressed-canonical index space (component/region/
 * boundary/endpoint indices, NOT live VertexIds — the forward-translation layer maps a drawn move
 * into these indices via the maintained parent map). Enclosure connects two endpoints on one
 * boundary of one region (i === j is a self-connection, legal for spots/appendages) and splits the
 * region; `mask` distributes the region's other boundaries between the two arc sides (bit k set =>
 * the k-th other boundary, skipping `boundary`, goes with the appended side). Join connects two
 * endpoints on two DIFFERENT boundaries b1, b2 of one region and fuses them (no mask).
 */
export type MoveDescriptor =
  | {
      kind: MoveKind.Enclosure;
      component: number;
      region: number;
      boundary: number;
      i: number;
      j: number;
      mask: number;
    }
  | {
      kind: MoveKind.Join;
      component: number;
      region: number;
      b1: number;
      b2: number;
      i: number;
      j: number;
    };

type TrackedResultRaw =
  | { ok: true; enc: string; src: PosSrc }
  | { ok: false; reason: string; message?: string };

export type TrackedResult =
  | { ok: true; child: TrackedChild }
  | { ok: false; reason: string; message?: string };

/**
 * Apply one move to a decompressed parent, returning the decompressed-canonical child encoding and
 * provenance. `parentEnc` MUST be the decompressed encoding whose token walk `parentSrc` is
 * parallel to (the frontend maintains that decompressed form + map). Never rejects — engine/parse
 * problems come back as an `ok:false` result.
 */
export async function applyMoveTracked(
  parentEnc: string,
  parentSrc: PosSrc,
  move: MoveDescriptor,
): Promise<TrackedResult> {
  let mod: StalksModule;
  try {
    mod = await getModule();
  } catch {
    return { ok: false, reason: 'engine-unavailable', message: 'Stalks engine not built yet.' };
  }
  // a/b carry (boundary, unused) for enclosure and (b1, b2) for join; mask is enclosure-only.
  const a = move.kind === MoveKind.Enclosure ? move.boundary : move.b1;
  const b = move.kind === MoveKind.Enclosure ? 0 : move.b2;
  const mask = move.kind === MoveKind.Enclosure ? move.mask : 0;
  try {
    const raw = JSON.parse(
      mod.applyMoveTracked(
        parentEnc,
        JSON.stringify(parentSrc),
        move.kind,
        move.component,
        move.region,
        a,
        b,
        move.i,
        move.j,
        mask,
      ),
    ) as TrackedResultRaw;
    if (!raw.ok) return { ok: false, reason: raw.reason, message: raw.message };
    return { ok: true, child: { enc: raw.enc, src: raw.src } };
  } catch (e) {
    return { ok: false, reason: 'parse-error', message: e instanceof Error ? e.message : String(e) };
  }
}
