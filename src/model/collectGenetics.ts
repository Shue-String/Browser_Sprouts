/**
 * Pure structural helpers for the Collect feature: parsing a decompressed canonical encoding
 * (as returned by the Stalks engine's `analyze().canon`) into components/regions/boundaries,
 * locating DisaPoints within it, and building the derived "remove" / "replace-with-scab"
 * encodings used for the R and D genetic-code entries.
 *
 * A DisaPoint is a membrane whose partner region is a single boundary of exactly two tokens:
 * a scab ('2') and the matching membrane letter — see encoding.ts's header for the display-side
 * version of this same idea. Here we re-detect it directly from the engine's own decompressed
 * canon text, since that's the coordinate space MoveInfo (region/boundary/token index) refers to.
 */

import {
  MoveKind,
  type ChildInfo,
  type MoveDescriptor,
  type MoveInfo,
  type PosSrc,
  allMovesTracked,
  analyze,
  applyMoveTracked,
  canon,
  regionMovesTracked,
} from '../engine/stalks';

export type ParsedBoundary = string[];
export type ParsedRegion = ParsedBoundary[];
export type ParsedComponent = ParsedRegion[];

export interface DisaPointRef {
  component: number;
  region: number;
  boundary: number;
  token: number;
  letter: string;
  detached: { component: number; region: number };
}

/**
 * Split "23A|A3,13738+4" (the Stalks engine's ASCII component separator is '+', not the TS
 * display layer's '⊕' — see encoding.ts's header for that Unicode convention) into components.
 * No bracket-wrapping is used in the engine's own canon/child `enc` strings, but a leading/
 * trailing `[...]` is stripped defensively in case one is present.
 */
export function parseEncoding(text: string): ParsedComponent[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed.split('+');
  return parts.map(part => {
    const inner = part.startsWith('[') && part.endsWith(']') ? part.slice(1, -1) : part;
    return inner.split('|').map(regionStr => regionStr.split(',').map(b => b.split('')));
  });
}

/** Inverse of parseEncoding. */
export function serializeComponents(components: ParsedComponent[]): string {
  return components
    .map(regions => regions.map(boundaries => boundaries.map(tokens => tokens.join('')).join(',')).join('|'))
    .join('+');
}

/** Total token count across every boundary of every region/component. */
export function countTokens(components: ParsedComponent[]): number {
  let n = 0;
  for (const regions of components) {
    for (const boundaries of regions) {
      for (const tokens of boundaries) n += tokens.length;
    }
  }
  return n;
}

/**
 * Find every DisaPoint: a region consisting of exactly one boundary of exactly two tokens
 * ('2' + an uppercase letter) is a "detached pair" for that letter; every OTHER occurrence of
 * that same letter elsewhere in the structure is a DisaPoint. Returned in a fixed deterministic
 * order (component, region, boundary, token) — the same order buildDisplayEncoding uses to place
 * '3' markers, so the Nth DisaPoint here is always the Nth '3' in that display string.
 */
export function findDisaPoints(components: ParsedComponent[]): DisaPointRef[] {
  // Membrane letters are scoped per-component (the engine reassigns A, B, ... independently
  // within each connected piece), so the lookup key must include the component index.
  const detachedByLetter = new Map<string, { component: number; region: number }>();
  for (let c = 0; c < components.length; c++) {
    for (let r = 0; r < components[c].length; r++) {
      const region = components[c][r];
      if (region.length === 1 && region[0].length === 2) {
        const [a, b] = region[0];
        const letter = a === '2' ? b : b === '2' ? a : null;
        if (letter && /^[A-Z]$/.test(letter)) detachedByLetter.set(`${c}:${letter}`, { component: c, region: r });
      }
    }
  }

  const refs: DisaPointRef[] = [];
  for (let c = 0; c < components.length; c++) {
    for (let r = 0; r < components[c].length; r++) {
      for (let b = 0; b < components[c][r].length; b++) {
        const boundary = components[c][r][b];
        for (let t = 0; t < boundary.length; t++) {
          const letter = boundary[t];
          const det = detachedByLetter.get(`${c}:${letter}`);
          if (!det) continue;
          if (det.component === c && det.region === r) continue; // the detached region itself
          refs.push({ component: c, region: r, boundary: b, token: t, letter, detached: det });
        }
      }
    }
  }
  return refs;
}

/** Compressed-form "life" count: raw tokens minus the 2 hidden tokens per DisaPoint. */
export function countLives(components: ParsedComponent[], disaPoints: DisaPointRef[]): number {
  return countTokens(components) - 2 * disaPoints.length;
}

function detachedRegionSet(disaPoints: DisaPointRef[]): Set<string> {
  return new Set(disaPoints.map(d => `${d.detached.component}:${d.detached.region}`));
}

/** Rebuild a compressed display string: detached-pair regions omitted, DisaPoint tokens shown as '3'. */
export function buildDisplayEncoding(components: ParsedComponent[], disaPoints: DisaPointRef[]): string {
  const skip = detachedRegionSet(disaPoints);
  const marked = new Set(disaPoints.map(d => `${d.component}:${d.region}:${d.boundary}:${d.token}`));
  const out: ParsedComponent[] = components.map((regions, c) =>
    regions
      .map((boundaries, r) =>
        boundaries.map((tokens, b) =>
          tokens.map((tok, t) => (marked.has(`${c}:${r}:${b}:${t}`) ? '3' : tok)),
        ),
      )
      .filter((_, r) => !skip.has(`${c}:${r}`)),
  );
  return serializeComponents(out);
}

function cloneComponents(components: ParsedComponent[]): ParsedComponent[] {
  return components.map(regions => regions.map(boundaries => boundaries.map(tokens => [...tokens])));
}

/** Drop empty boundaries/regions left behind after deleting a token. */
function pruneEmpty(components: ParsedComponent[]): ParsedComponent[] {
  return components
    .map(regions =>
      regions
        .map(boundaries => boundaries.filter(tokens => tokens.length > 0))
        .filter(boundaries => boundaries.length > 0),
    )
    .filter(regions => regions.length > 0);
}

/**
 * R: the position with the DisaPoint's dead branch (and its own token) deleted outright. If the
 * DisaPoint is the sole content between one joint's two visits (an adjacent '7'...'8' pair -- see
 * canon.cpp's joint-tagging, first visit '7', second visit '8'), just deleting it would leave the
 * joint with zero-length content between its visits, which the engine can't parse as text -- so
 * collapse the whole 7/DisaPoint/8 triple into a single scab ('2') instead. e.g. R([11738]) = [112].
 */
export function buildRemoveEncoding(components: ParsedComponent[], target: DisaPointRef): string {
  const work = cloneComponents(components);
  const boundary = work[target.component][target.region][target.boundary];
  const straddlesJoint =
    target.token > 0 &&
    target.token + 1 < boundary.length &&
    boundary[target.token - 1] === '7' &&
    boundary[target.token + 1] === '8';
  if (straddlesJoint) {
    boundary.splice(target.token - 1, 3, '2');
  } else {
    boundary.splice(target.token, 1);
  }
  work[target.detached.component].splice(target.detached.region, 1);
  return serializeComponents(pruneEmpty(work));
}

/**
 * L: the nimber of every child reached by a move connecting some other point in the DisaPoint's
 * own region to the DisaPoint itself. `children` must come from analyzing the SAME canon text
 * `target` was located in — MoveInfo's region/boundary/i/j indices are relative to that parent's
 * decompressed structure (see resolveMoveVertices in encoding.ts for the live-game analog).
 *
 * NOTE: raw-index matching alone is unsound when the position has structurally-duplicate regions
 * (e.g. two isomorphic branches sharing a bridge) — the engine's children list dedupes isomorphic
 * outcomes and keeps only ONE representative MoveInfo, so a DisaPoint sitting in the "other" copy
 * never matches by index even though the same move genuinely applies to it. Use lMoveNimbersRobust
 * instead, which enumerates target's own legal moves directly rather than matching against
 * analyze()'s already-deduped children list at all.
 */
export function lMoveNimbers(children: ChildInfo[], target: DisaPointRef): number[] {
  const out: number[] = [];
  for (const child of children) {
    const move = child.move;
    if (!move || move.kind === MoveKind.InteriorPseudo) continue;
    if (move.region !== target.region || move.component !== target.component) continue;
    const hit =
      move.kind === MoveKind.Enclosure
        ? move.boundary === target.boundary && (move.i === target.token || move.j === target.token)
        : (move.b1 === target.boundary && move.i === target.token) ||
          (move.b2 === target.boundary && move.j === target.token);
    if (hit) out.push(child.nimber);
  }
  return out;
}

/** All-untracked PosSrc parallel to `components`, for calls that only need the resulting encoding. */
function untrackedSrc(components: ParsedComponent[]): PosSrc {
  return components.map(regions => regions.map(boundaries => boundaries.map(tokens => tokens.map(() => -1))));
}

/**
 * Ground-truth L: every legal move (Enclosure or Join) of `target`'s own component that touches
 * its own token, directly enumerated by the engine (regionMovesTracked) rather than guessed by
 * transplanting a MoveTag analyze()'s children list happened to keep. `canonSet` (each result's own
 * canon() text) lets a caller classify an ARBITRARY child as an L-move by membership, independent
 * of which specific move reached it -- see classifyChildrenByDisaPoint, which needs exactly that.
 * `nimbers` is deduped (L is a SET of reachable nimbers, per the genetic-code spec -- distinct legal
 * moves landing on the same nimber, or even the same exact position, are common and shouldn't inflate
 * it into a multiset). `canonText` must be decompressed, matching `target`'s (component,region,
 * boundary,token) coordinates.
 */
export async function computeLReachable(
  canonText: string,
  target: DisaPointRef,
): Promise<{ nimbers: number[]; canonSet: Set<string> }> {
  const res = await regionMovesTracked(canonText, target.component, target.region, target.boundary, target.token);
  if (!res.ok) return { nimbers: [], canonSet: new Set() };
  const canons = await Promise.all(res.children.map(c => canon(c.enc)));
  return { nimbers: [...new Set(res.children.map(c => c.nimber))], canonSet: new Set(canons) };
}

/** L nimbers only -- see computeLReachable for the ground-truth enumeration this wraps. */
export async function lMoveNimbersRobust(canonText: string, target: DisaPointRef): Promise<number[]> {
  return (await computeLReachable(canonText, target)).nimbers;
}

/** D: the position with the DisaPoint capped off as a scab in place, dead branch deleted. */
export function buildReplaceEncoding(components: ParsedComponent[], target: DisaPointRef): string {
  const work = cloneComponents(components);
  work[target.component][target.region][target.boundary][target.token] = '2';
  work[target.detached.component].splice(target.detached.region, 1);
  return serializeComponents(pruneEmpty(work));
}

// ---- T moves + Grandparent Bypass Theorem -----------------------------------------------------
//
// L (region-internal moves touching the DisaPoint) and R (the self-connect that makes its branch
// disappear) are the DisaPoint's own move types; every other legal move of the position is a T
// move (T' is treated as an ordinary T move here, per the user's spec). Classification reuses
// computeLReachable's ground-truth canon set (matching by canon equality, not raw indices or a
// per-move guess -- see computeLReachable's doc comment).

export interface ClassifiedChildren {
  lChildren: ChildInfo[];
  rChild: ChildInfo | null;
  tChildren: ChildInfo[];
}

/**
 * Classify every child of the position relative to one DisaPoint: L (membership in
 * computeLReachable's canon set -- ground truth, not a per-move guess), R (matches `rCanon` if
 * given), T (everything else).
 */
export async function classifyChildrenByDisaPoint(
  canonText: string,
  children: ChildInfo[],
  target: DisaPointRef,
  rCanon: string | null,
): Promise<ClassifiedChildren> {
  const { canonSet: lCanonSet } = await computeLReachable(canonText, target);

  const lChildren: ChildInfo[] = [];
  let rChild: ChildInfo | null = null;
  const tChildren: ChildInfo[] = [];

  for (const child of children) {
    const childCanon = await canon(child.enc);
    if (lCanonSet.has(childCanon)) {
      lChildren.push(child);
      continue;
    }
    if (rCanon !== null && rChild === null && childCanon === rCanon) {
      rChild = child;
      continue;
    }
    tChildren.push(child);
  }

  return { lChildren, rChild, tChildren };
}

export interface DisaGeneticCode {
  L: number[];
  R: number | null;
  D: number | null;
}

function codesEqual(a: DisaGeneticCode, b: DisaGeneticCode): boolean {
  if (a.R !== b.R || a.D !== b.D || a.L.length !== b.L.length) return false;
  const as = [...a.L].sort((x, y) => x - y);
  const bs = [...b.L].sort((x, y) => x - y);
  return as.every((v, i) => v === bs[i]);
}

/** Full (L,R,D) genetic code of one DisaPoint. */
export async function computeGeneticCode(canonText: string, target: DisaPointRef): Promise<DisaGeneticCode> {
  const parsed = parseEncoding(canonText);
  const [L, rRes, dRes] = await Promise.all([
    lMoveNimbersRobust(canonText, target),
    analyze(buildRemoveEncoding(parsed, target)),
    analyze(buildReplaceEncoding(parsed, target)),
  ]);
  return { L, R: rRes.ok ? rRes.nimber : null, D: dRes.ok ? dRes.nimber : null };
}

// Caller-assigned provenance id used only to trace one specific DisaPoint's token through a chain
// of tracked move applications (see checkGrandparentBypass) -- distinct from GEN_SRC/UNTRACKED.
const TRACK_ID = 1;

function srcWithTarget(components: ParsedComponent[], target: DisaPointRef): PosSrc {
  const src = untrackedSrc(components);
  src[target.component][target.region][target.boundary][target.token] = TRACK_ID;
  return src;
}

function locateTrackId(src: PosSrc, trackId: number): { component: number; region: number; boundary: number; token: number } | null {
  for (let c = 0; c < src.length; c++) {
    for (let r = 0; r < src[c].length; r++) {
      for (let b = 0; b < src[c][r].length; b++) {
        for (let t = 0; t < src[c][r][b].length; t++) {
          if (src[c][r][b][t] === trackId) return { component: c, region: r, boundary: b, token: t };
        }
      }
    }
  }
  return null;
}

/**
 * If `comp[region]` is one half of a "trivial isolated 2-life dumbbell" -- two lone `2X`-shaped
 * regions paired only to each other, nothing else referencing that letter -- returns the OTHER
 * region's index (its dumbbell partner); otherwise null. Both halves are structurally identical, so
 * findDisaPoints necessarily treats one arbitrarily as "the DisaPoint" and the other as "detached"
 * (there's no principled way to tell them apart). By symmetry this doesn't change the resulting
 * genetic code -- connecting either copy to the other reaches the same dead end -- so a
 * tracked-provenance token landing on the copy findDisaPoints DIDN'T pick as its representative
 * would otherwise be wrongly reported as "not a DisaPoint here", purely from an index mismatch, not
 * a real one. See findTrackedDisaPoint and analyzeTEntry's mark computation, the two places this
 * matters: T (and Grandparent Bypass) can land a tracked DisaPoint's token on exactly this shape.
 */
function dumbbellPartnerRegion(comp: ParsedComponent, region: number): number | null {
  const shape = (r: ParsedRegion) => r.length === 1 && r[0].length === 2;
  const letterOf = (r: ParsedRegion): string | null => {
    const [t0, t1] = r[0];
    if (t0 === '2' && /^[A-Z]$/.test(t1)) return t1;
    if (t1 === '2' && /^[A-Z]$/.test(t0)) return t0;
    return null;
  };
  if (!shape(comp[region])) return null;
  const letter = letterOf(comp[region]);
  if (!letter) return null;
  for (let r = 0; r < comp.length; r++) {
    if (r !== region && shape(comp[r]) && letterOf(comp[r]) === letter) return r;
  }
  return null;
}

function findTrackedDisaPoint(enc: string, src: PosSrc, trackId: number): DisaPointRef | null {
  const loc = locateTrackId(src, trackId);
  if (!loc) return null;
  const parsed = parseEncoding(enc);
  const direct = findDisaPoints(parsed).find(
    d => d.component === loc.component && d.region === loc.region && d.boundary === loc.boundary && d.token === loc.token,
  );
  if (direct) return direct;

  const comp = parsed[loc.component];
  const partnerRegion = comp ? dumbbellPartnerRegion(comp, loc.region) : null;
  if (partnerRegion === null || !comp) return null;
  const letter = comp[loc.region][loc.boundary][loc.token];
  return {
    component: loc.component,
    region: loc.region,
    boundary: loc.boundary,
    token: loc.token,
    letter,
    detached: { component: loc.component, region: partnerRegion },
  };
}

async function traceMove(parentEnc: string, parentSrc: PosSrc, move: MoveInfo): Promise<{ enc: string; src: PosSrc } | null> {
  if (move.kind === MoveKind.InteriorPseudo) return null;
  const moveDesc: MoveDescriptor =
    move.kind === MoveKind.Enclosure
      ? { kind: MoveKind.Enclosure, component: move.component, region: move.region, boundary: move.boundary, i: move.i, j: move.j, mask: move.mask }
      : { kind: MoveKind.Join, component: move.component, region: move.region, b1: move.b1, b2: move.b2, i: move.i, j: move.j };
  const res = await applyMoveTracked(parentEnc, parentSrc, moveDesc);
  if (!res.ok) return null;
  return { enc: res.child.enc, src: res.child.src };
}

/** A component consisting of exactly one region, one boundary, two plain (letterless) '2' tokens
 * -- what a DisaPoint + its detached partner decay into once the engine splits them off into their
 * own ⊕-summand with nothing else attached (see applyEnclosure/applyJoin's "split into
 * pairing-connected components" cleanup step). This is the "T'" shape: the DisaPoint hasn't been
 * destroyed by the move, but it's no longer a DisaPoint either -- it's inert. */
function isTrivialDeadPair(component: ParsedComponent): boolean {
  if (component.length !== 1 || component[0].length !== 1) return false;
  const boundary = component[0][0];
  return boundary.length === 2 && boundary[0] === '2' && boundary[1] === '2';
}

/**
 * Where `target` (a DisaPoint of the root position) ends up after one T move, tracked by
 * provenance (not just any DisaPoint the child happens to contain):
 * - 'disapoint': still a genuine DisaPoint -- `index` is its ordinal position in the child's own
 *   findDisaPoints() list (the same order buildDisplayEncoding places '3' markers in).
 * - 'isolated': decayed into its own trivial [22] ⊕-summand (the T' case) -- `index` is that
 *   summand's component index. Detected either directly (provenance survived) or, since the
 *   engine's decay cleanup doesn't carry a live token's provenance through its collapse into a
 *   dead scab, by a structural fallback (a T move never touches target's own token, so a freshly-
 *   appearing [22] pair can only be target's).
 * - 'none': didn't survive the move, or ended up somewhere not cleanly classifiable as either.
 */
export type TPositionMark =
  | { kind: 'disapoint'; index: number }
  | { kind: 'isolated'; index: number }
  | { kind: 'none' };

export interface TEntryResult {
  /** The T-child's decompressed encoding AS SEEN by the tracked-apply path -- `mark`'s indices
   * are relative to THIS text, not `tChild.enc` (canon-equivalent, but component/region order can
   * differ between the tracked-apply path's canonicalization and the untracked children list's). */
  enc: string;
  mark: TPositionMark;
  bypass: boolean;
}

/**
 * Recompress a T/T' entry's tracked-apply text for display: `analyzeTEntry` deliberately keeps
 * `enc` fully decompressed (that's the coordinate space `mark` and the bypass retrace need), but
 * that means any Hollow/Split/Triplet organ elsewhere in the position shows as raw membrane pairs
 * (e.g. "BC|...BC") instead of its compressed pseudo-point ("4") -- the same compact form
 * analyze()'s own canon field would show. `canon()` (canonicalize(parsePosition(x))) recompresses
 * Hollow/Split/Triplet but, by design, never touches DisaPoints -- so `target`'s own token/detached
 * pair survive unchanged, just possibly at a different region/component index once everything else
 * gets re-sorted. Relocate it by structural identity rather than trusting index continuity:
 * - 'disapoint': try the SAME (component,region,boundary,token) coordinates first -- recompression
 *   (Hollow/Split/Triplet only) never touches DisaPoints, so whenever it doesn't reorder components/
 *   regions either (the common case), `target`'s coordinates are already correct and nothing needs
 *   relocating. Only if that direct check fails, fall back to matching by R-encoding fingerprint
 *   (canon(buildRemoveEncoding(...))) -- removing the SAME DisaPoint from two canon-equivalent
 *   starting texts must land on canon-equivalent results. The direct check must come first: when a
 *   position has two structurally-symmetric DisaPoints (an actual automorphism swaps them, e.g. two
 *   interchangeable branches), removing EITHER one gives the identical canonical result -- the
 *   fingerprint alone can't tell them apart and would always resolve to whichever tied candidate
 *   happens to come first, silently mislabeling the untracked one's entry as if it were the tracked
 *   one whenever no relocation was actually needed.
 * - 'isolated': the target's own component is already a bare [22] pair, which recompression can't
 *   touch (nothing to compress) -- ties among multiple identical [22] summands are genuinely
 *   interchangeable for display, so position-among-ties is enough to relocate.
 * Falls back to the decompressed form (better an uncompressed but correct display than a mismarked
 * compressed one) if relocation can't find a match -- should not happen in practice, but the R-
 * fingerprint match is a heuristic, not a proof.
 */
export async function toDisplayForm(
  decompressedEnc: string,
  mark: TPositionMark,
): Promise<{ enc: string; mark: TPositionMark }> {
  const compressed = await canon(decompressedEnc);
  if (!compressed) return { enc: decompressedEnc, mark };
  if (mark.kind === 'none') return { enc: compressed, mark };

  const srcParsed = parseEncoding(decompressedEnc);
  const dstParsed = parseEncoding(compressed);

  if (mark.kind === 'disapoint') {
    const target = findDisaPoints(srcParsed)[mark.index];
    if (!target) return { enc: decompressedEnc, mark };
    const dstDps = findDisaPoints(dstParsed);

    const directIdx = dstDps.findIndex(
      d =>
        d.component === target.component &&
        d.region === target.region &&
        d.boundary === target.boundary &&
        d.token === target.token,
    );
    if (directIdx !== -1) return { enc: compressed, mark: { kind: 'disapoint', index: directIdx } };

    const targetRemove = await canon(buildRemoveEncoding(srcParsed, target));
    for (let i = 0; i < dstDps.length; i++) {
      if ((await canon(buildRemoveEncoding(dstParsed, dstDps[i]))) === targetRemove) {
        return { enc: compressed, mark: { kind: 'disapoint', index: i } };
      }
    }
    return { enc: decompressedEnc, mark };
  }

  // 'isolated'
  const srcTrivial = srcParsed.reduce<number[]>((acc, c, i) => {
    if (isTrivialDeadPair(c)) acc.push(i);
    return acc;
  }, []);
  const dstTrivial = dstParsed.reduce<number[]>((acc, c, i) => {
    if (isTrivialDeadPair(c)) acc.push(i);
    return acc;
  }, []);
  const tieRank = srcTrivial.indexOf(mark.index);
  const dstIndex = tieRank !== -1 && tieRank < dstTrivial.length ? dstTrivial[tieRank] : dstTrivial[dstTrivial.length - 1];
  if (dstIndex === undefined) return { enc: decompressedEnc, mark };
  return { enc: compressed, mark: { kind: 'isolated', index: dstIndex } };
}

/**
 * Combined per-T-move analysis: where the tracked DisaPoint ends up (see TPositionMark) and
 * whether the Grandparent Bypass Theorem applies (does `target`, tracked through this move AND one
 * grandchild move, have some grandchild-level descendant whose own (L,R,D) genetic code exactly
 * matches `rootCode`?). Both share the same first tracked-apply step, so this only traces it once.
 */
export async function analyzeTEntry(
  rootEnc: string,
  target: DisaPointRef,
  tChild: ChildInfo,
  rootCode: DisaGeneticCode,
): Promise<TEntryResult> {
  const none: TEntryResult = { enc: tChild.enc, mark: { kind: 'none' }, bypass: false };
  if (!tChild.move) return none;

  const rootParsed = parseEncoding(rootEnc);
  const rootSrc = srcWithTarget(rootParsed, target);
  const step1 = await traceMove(rootEnc, rootSrc, tChild.move);
  if (!step1) return none;
  const [step1Canon, tChildCanon] = await Promise.all([canon(step1.enc), canon(tChild.enc)]);
  if (step1Canon !== tChildCanon) return none;

  const childParsed = parseEncoding(step1.enc);
  const loc = locateTrackId(step1.src, TRACK_ID);

  let mark: TPositionMark = { kind: 'none' };
  if (loc) {
    const childDps = findDisaPoints(childParsed);
    let idx = childDps.findIndex(
      d => d.component === loc.component && d.region === loc.region && d.boundary === loc.boundary && d.token === loc.token,
    );
    if (idx === -1) {
      // Symmetric "isolated dumbbell" fallback -- see dumbbellPartnerRegion's doc. The tracked token
      // may have landed on the copy findDisaPoints didn't pick as its representative; by symmetry the
      // OTHER copy (already in childDps, at the known partner region) is equally valid to mark -- the
      // resulting compact display is identical either way, since the "detached" side is dropped
      // regardless of which copy plays that role.
      const comp = childParsed[loc.component];
      const partnerRegion = comp ? dumbbellPartnerRegion(comp, loc.region) : null;
      if (partnerRegion !== null) idx = childDps.findIndex(d => d.component === loc.component && d.region === partnerRegion);
    }
    if (idx !== -1) mark = { kind: 'disapoint', index: idx };
    else if (isTrivialDeadPair(childParsed[loc.component])) mark = { kind: 'isolated', index: loc.component };
  } else {
    // The engine's own decay cleanup (a live token consuming down into a plain dead scab) doesn't
    // carry provenance forward -- it isn't treated as "surviving" the move, even though the token
    // conceptually does. Fall back to a structural inference: a T move never touches target's own
    // token directly (that's what distinguishes it from L/R), so if a [22] dead pair appears that
    // wasn't already present in the root, it can only be target's branch that decayed into it.
    const rootTrivialCount = rootParsed.filter(isTrivialDeadPair).length;
    const childTrivialIndices = childParsed.reduce<number[]>((acc, c, i) => {
      if (isTrivialDeadPair(c)) acc.push(i);
      return acc;
    }, []);
    if (childTrivialIndices.length > rootTrivialCount) {
      mark = { kind: 'isolated', index: childTrivialIndices[childTrivialIndices.length - 1] };
    }
  }

  // allMovesTracked, not analyze/childrenTracked: analyze() canonicalizes its input first, which can
  // silently recompress a Hollow/Split/Triplet organ and shift region/boundary numbering out from
  // under step1.src (see childrenTracked's doc comment in stalks.ts -- found via a real T-move whose
  // Grandparent Bypass never triggered because of exactly this mismatch). childrenTracked fixes that
  // but still dedupes canonically-identical grandchildren (childrenAllWithMoveTag's `seen`), which
  // hides a real bug: when target's own retrace needs a move that's canonically identical to ANOTHER
  // move elsewhere (e.g. a structurally-symmetric DisaPoint's own analogous move) and that other move
  // happens to be enumerated first, dedup drops the one that would have preserved target's token --
  // producing a false "target didn't survive" and silently missing a real bypass match. Confirmed via
  // [13*3] vs [133*] on 2A|2B|1AB: both DisaPoints are symmetric (swap A<->B), so both MUST get the
  // same bypass verdict, but childrenTracked's dedup kept only "enclose region0" (equivalent to
  // "enclose region1"), which happens to preserve B's token but not A's -- allMovesTracked keeps both.
  const analysis1 = await allMovesTracked(step1.enc);
  if (!analysis1.ok) return { enc: step1.enc, mark, bypass: false };

  const matches = await Promise.all(
    analysis1.children.map(async gc => {
      if (!gc.move) return false;
      const step2 = await traceMove(step1.enc, step1.src, gc.move);
      if (!step2) return false;
      const [step2Canon, gcCanon] = await Promise.all([canon(step2.enc), canon(gc.enc)]);
      if (step2Canon !== gcCanon) return false;
      const dp2 = findTrackedDisaPoint(step2.enc, step2.src, TRACK_ID);
      if (!dp2) return false; // survived but isn't (currently) a DisaPoint here -- nothing to compare
      const code2 = await computeGeneticCode(step2.enc, dp2);
      return codesEqual(code2, rootCode);
    }),
  );
  return { enc: step1.enc, mark, bypass: matches.some(Boolean) };
}
