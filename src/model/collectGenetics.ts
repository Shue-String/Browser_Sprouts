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
  canonicalizeTrackedProvenanceSync,
  decompress,
  disaPointRMove,
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

/** Delete component `index` outright and reserialize -- used for the T' gene (see
 * computeTprimeGene): "drop the [22] entirely, and just give the nimber of the rest of the
 * position" -- the rest may itself be a multi-component ⊕-sum, which analyze() handles correctly
 * on its own (no manual XOR needed here). */
export function deleteComponent(enc: string, index: number): string {
  const parsed = parseEncoding(enc);
  parsed.splice(index, 1);
  return serializeComponents(parsed);
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
 * R: the ground-truth position reached by the paper's InteriorPseudo rewrite (3q*)=(q*) on this
 * DisaPoint's own membrane -- computed by the real engine (moves.hpp's disaPointRMove, called
 * through stalks.ts's disaPointRMove wrapper), not a hand-spliced text edit. An earlier version of
 * this function hand-simulated the splice (erase the token + its detached partner region, patch up
 * straddled joints); stalks/tools/collect_genetics.cpp's header comment records the case that
 * proved it wrong: removing a DisaPoint's membrane can MERGE two regions together (finishComponent's
 * real region-merge/decay logic), which a text splice cannot replicate. `components` must have this
 * DisaPoint still decompressed as a membrane pair, matching `target`'s own coordinates. Returns null
 * on any engine failure (should not happen for a well-formed target).
 */
export async function computeR(components: ParsedComponent[], target: DisaPointRef): Promise<string | null> {
  const res = await disaPointRMove(
    serializeComponents(components),
    target.component,
    target.region,
    target.boundary,
    target.token,
  );
  return res.ok ? res.enc : null;
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

/** Flat sequential index of `ref`'s own token among EVERY token of `parsed`, walking components
 * then regions then boundaries then tokens, ignoring separator punctuation ('+'/'|'/',') -- the same
 * order/convention canonicalizeTrackedProvenanceSync's `src` array indexes into (it tracks per-TOKEN
 * provenance, not raw string character offsets). Null if `ref` doesn't resolve inside `parsed`. */
function flatTokenIndex(parsed: ParsedComponent[], ref: DisaPointRef): number | null {
  let idx = 0;
  for (let c = 0; c < parsed.length; c++) {
    for (let r = 0; r < parsed[c].length; r++) {
      for (let b = 0; b < parsed[c][r].length; b++) {
        const boundary = parsed[c][r][b];
        if (c === ref.component && r === ref.region && b === ref.boundary) {
          return ref.token < boundary.length ? idx + ref.token : null;
        }
        idx += boundary.length;
      }
    }
  }
  return null;
}

/** Inverse of flatTokenIndex: which (component,region,boundary,token) tuple sits at flat token
 * index `flatIdx` of `parsed`. Null if out of range. */
function componentAtFlatIndex(
  parsed: ParsedComponent[],
  flatIdx: number,
): { component: number; region: number; boundary: number; token: number } | null {
  let idx = 0;
  for (let c = 0; c < parsed.length; c++) {
    for (let r = 0; r < parsed[c].length; r++) {
      for (let b = 0; b < parsed[c][r].length; b++) {
        const boundary = parsed[c][r][b];
        if (flatIdx >= idx && flatIdx < idx + boundary.length) {
          return { component: c, region: r, boundary: b, token: flatIdx - idx };
        }
        idx += boundary.length;
      }
    }
  }
  return null;
}

/**
 * Relocate `target` into `otherText` -- any other serialization of the SAME position, whether that's
 * a full decompression of `originalParsed` (every Hollow/Split/Triplet/DisaPoint pseudo-point
 * elsewhere expanded to raw tokens, not just `target`'s own DisaPoint) or an independently
 * re-canonicalized/re-analyzed text for what should be the identical structure (e.g. re-running
 * analyze() on a stored genome-DB encoding, or the raw text a user typed before the engine
 * canonicalizes it). Either kind of re-derivation can insert/reorder regions, so `target`'s own
 * (region,boundary,token) coordinates can shift even though its local structure (its own token +
 * detached partner) is untouched.
 *
 * Three-step strategy, most to least precise:
 *  1. Exact per-token provenance via canonicalizeTrackedProvenanceSync, when `otherText` happens to
 *     be exactly canonicalize(serializeComponents(originalParsed)) (verified by comparing its own
 *     output text against `otherText` -- cheap and safe to attempt unconditionally, since it silently
 *     returns null/no-match whenever that's not the relationship between the two texts, e.g. when
 *     `otherText` came from a mere decompression step instead of a full canonicalization, or when
 *     `originalParsed` itself still has other pseudo-points canonicalizeTrackedProvenanceSync can't
 *     accept). This is the ONLY step that can correctly resolve a target that is one of several
 *     structurally SYMMETRIC DisaPoints (the position has an automorphism permuting them): no
 *     invariant computed independently on each side (R's nimber, R's canon text, ...) can ever tell
 *     two truly-symmetric points apart, since by definition nothing distinguishes them -- but
 *     canonicalizeTrackedProvenanceSync doesn't need to distinguish them by an invariant, it follows
 *     the literal token through the transform. Confirmed necessary: for "1,3,3" (decompressing to
 *     "1,A,B|2A|2B", where A and B are fully interchangeable), step 2's direct-coordinate match
 *     misses (canonicalization moves the shared region to a different index) and step 3's R-fingerprint
 *     match is genuinely ambiguous (A and B's R results are identical), silently resolving to
 *     whichever candidate happens to be found first regardless of which one `target` actually was.
 *  2. `target`'s own coordinates directly (the common case when no symmetry is involved -- e.g.
 *     decompressing a pseudo-point that comes AFTER target in the walk doesn't move target at all).
 *  3. R-encoding fingerprint (removing the SAME DisaPoint from two canon-equivalent starting texts
 *     must land on canon-equivalent results) -- kept only as a last-resort fallback for whenever step
 *     1 isn't applicable; ambiguous under symmetry as explained above, so steps 1/2 are tried first.
 * Returns null if no candidate matches (shouldn't happen in practice).
 *
 * Callers MUST use this (never raw ordinal-index lookup, and never invariant-only matching) whenever
 * a DisaPointRef computed against one text needs to be found again in a DIFFERENT text of the same
 * position -- see collect.ts's runSearch and fillDetail, which both used to look up
 * disaPoints[someIndex] directly against a freshly re-analyzed/re-canonicalized text and could
 * silently resolve to the WRONG DisaPoint whenever the engine's own canonicalization reordered
 * regions differently than the index's source (and, before step 1 was added here, still could when
 * two-or-more DisaPoints were symmetric, since only R-fingerprint matching was available).
 */
export async function relocateDisaPoint(
  originalParsed: ParsedComponent[],
  target: DisaPointRef,
  otherText: string,
): Promise<DisaPointRef | null> {
  const tracked = canonicalizeTrackedProvenanceSync(serializeComponents(originalParsed));
  if (tracked && tracked.enc === otherText) {
    const srcFlatIdx = flatTokenIndex(originalParsed, target);
    if (srcFlatIdx !== null) {
      const dstFlatIdx = tracked.src.indexOf(srcFlatIdx);
      if (dstFlatIdx !== -1) {
        const otherParsed = parseEncoding(otherText);
        const coords = componentAtFlatIndex(otherParsed, dstFlatIdx);
        if (coords) {
          const hit = findDisaPoints(otherParsed).find(
            d => d.component === coords.component && d.region === coords.region && d.boundary === coords.boundary && d.token === coords.token,
          );
          if (hit) return hit;
        }
      }
    }
  }

  const otherParsed = parseEncoding(otherText);
  const candidates = findDisaPoints(otherParsed);

  const direct = candidates.find(
    d => d.component === target.component && d.region === target.region && d.boundary === target.boundary && d.token === target.token,
  );
  if (direct) return direct;

  const targetRCanon = await computeR(originalParsed, target);
  if (targetRCanon === null) return null;
  for (const candidate of candidates) {
    if ((await computeR(otherParsed, candidate)) === targetRCanon) return candidate;
  }
  return null;
}

/**
 * Ground-truth L: every legal move (Enclosure or Join) of `target`'s own component that touches
 * its own token, directly enumerated by the engine (regionMovesTracked) rather than guessed by
 * transplanting a MoveTag analyze()'s children list happened to keep. `canonSet` (each result's own
 * canon() text) lets a caller classify an ARBITRARY child as an L-move by membership, independent
 * of which specific move reached it -- see classifyChildrenByDisaPoint, which needs exactly that.
 * `nimbers` is deduped (L is a SET of reachable nimbers, per the genetic-code spec -- distinct legal
 * moves landing on the same nimber, or even the same exact position, are common and shouldn't inflate
 * it into a multiset).
 *
 * `canonText` need NOT be fully decompressed -- analyze()'s own `canon` field only decompresses
 * DisaPoints, leaving Hollow/Split/Triplet elsewhere compressed, which is what callers actually
 * have. regionMovesTracked requires full decompression (no pseudo-points anywhere), so this
 * decompresses `canonText` itself first and relocates `target` into that fully-decompressed text --
 * skipping that step previously left moves that only become expressible once some OTHER pseudo-point
 * is expanded silently unenumerated (e.g. connecting straight to the critical membrane from inside a
 * Split point's own interior), which under-populated `canonSet` and let real L-moves get
 * misclassified as T by classifyChildrenByDisaPoint.
 */
export async function computeLReachable(
  canonText: string,
  target: DisaPointRef,
): Promise<{ nimbers: number[]; canonSet: Set<string> }> {
  const decompressedRes = await decompress(canonText);
  if (!decompressedRes.ok) return { nimbers: [], canonSet: new Set() };
  const relocated = await relocateDisaPoint(parseEncoding(canonText), target, decompressedRes.enc);
  if (!relocated) return { nimbers: [], canonSet: new Set() };

  const res = await regionMovesTracked(
    decompressedRes.enc,
    relocated.component,
    relocated.region,
    relocated.boundary,
    relocated.token,
  );
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

// NOTE on quickChildren (Advanced Collections quick-canon dedup): classification here deliberately
// stays on `children` (ChildInfo[]), NOT `quickChildren` (QuickChildInfo[]). QuickChildInfo carries
// no `move: MoveInfo` at all, and its `enc` is the quick-canon REP (a representative shared by every
// child in that quick-canon class), not that specific child's own canon() -- there is no `move` or
// per-child `enc` to bridge back to lMoveNimbersRobust/classifyChildrenByDisaPoint's
// canon-equality/index-based matching, which needs both. Separately, `children` already dedupes by
// exact canonical-result equality (childrenAllWithMoveTag's `seen.insert(serialize(child))` on the
// C++ side -- see computeLReachable's doc comment), which is the FINER equivalence (game-tree-exact,
// not quick-canon-coarse); quick-canon deliberately collapses MORE positions together than "same
// canonical result" (it doesn't distinguish some nimber-irrelevant structural variants), so a T-row
// "near duplicate" the user is trying to declutter is very likely a set of children that already
// share one canonical result-class here (fine) but sit in DIFFERENT canon() classes that only
// coincide once quick-canonicalized. Merging on quickChildren, given it drops move info, could not
// preserve the L-vs-T structural boundary this classification depends on -- unsafe to do without an
// engine change exposing `move`/per-child `enc` on QuickChildInfo, which is out of scope here (see
// project notes on this Collect redesign pass for the punted decision).
// R deliberately does NOT get the same "search `children` for a canon match" treatment as L: R is
// the InteriorPseudo move on this DisaPoint's own (already-decompressed-in-canonical-form) membrane
// -- see computeR/disaPointRMove -- and canonical text (canonicalize()'s BASE form; see canon.hpp)
// keeps every DisaPoint decompressed by construction. That means R's result is structurally NEVER a
// member of a canonical position's ordinary `children` (Enclosure/Join, plus InteriorPseudo only for
// any OTHER still-compressed Hollow/Split/Triplet) -- there is no live '3' token left to interior-
// move on. Matching `rCanon` against `children` below is kept only as a defensive fallback for the
// rare coincidence where some genuine other move's result happens to land on the same canonical
// text (then reusing that real ChildInfo is nicer than a synthesized one); callers must NOT rely on
// it firing -- see collect.ts's computeRowsAndGenes, which builds R's witness row directly from
// `rCanon` whenever this comes back null.
export interface ClassifiedChildren {
  lChildren: ChildInfo[];
  rChild: ChildInfo | null;
  tChildren: ChildInfo[];
}

/**
 * Classify every legal move of the position relative to one DisaPoint: L (touches target's own
 * token), R (matches `rCanon`), T (everything else).
 *
 * Deliberately does NOT classify against analyze()'s `children` list (as an earlier version did):
 * that list is deduped by canonical RESULT (childrenAllWithMoveTag's `seen.insert(serialize(child))`
 * on the C++ side), which is target-agnostic. Whenever the position has a structural automorphism
 * that maps target's own DisaPoint onto some OTHER point (e.g. two-or-more symmetric DisaPoints
 * sharing an isomorphic role, like "2A|2B|2C|7A8BC"), a genuine T move (say, connecting A to C, not
 * touching target B at all) can produce a canonical result IDENTICAL to some L move that DOES touch
 * B (say, connecting A to B) -- only one of the two survives analyze()'s dedup, and if the survivor
 * happens to be the L one, the T move silently vanishes from the input list entirely, undercounting
 * T (in the worst case, to empty) with no per-child fix possible since there was nothing left to
 * classify. See allMovesTracked's own doc comment for the general form of this dedup pitfall.
 *
 * Fixed by enumerating every legal move directly via allMovesTracked (NOT deduped by result) on the
 * fully decompressed text, exactly like computeLReachable already does for L's own nimber set, then
 * classifying each individual move by whether it touches target's own (region,boundary,i/j)
 * coordinates -- so an L move and a coincidentally-identical-result T move are never conflated, even
 * though they land on the same canonical position. L/T lists are each deduped by canon() internally
 * (one row per distinct reachable position within that classification), matching the previous
 * one-row-per-canonical-child display convention.
 */
export async function classifyChildrenByDisaPoint(
  canonText: string,
  target: DisaPointRef,
  rCanon: string | null,
): Promise<ClassifiedChildren> {
  const empty: ClassifiedChildren = { lChildren: [], rChild: null, tChildren: [] };
  const decompressedRes = await decompress(canonText);
  if (!decompressedRes.ok) return empty;
  const relocated = await relocateDisaPoint(parseEncoding(canonText), target, decompressedRes.enc);
  if (!relocated) return empty;

  const res = await allMovesTracked(decompressedRes.enc);
  if (!res.ok) return empty;

  const lChildren: ChildInfo[] = [];
  let rChild: ChildInfo | null = null;
  const tChildren: ChildInfo[] = [];
  const seenL = new Set<string>();
  const seenT = new Set<string>();

  for (const child of res.children) {
    const move = child.move;
    const touchesTarget =
      !!move &&
      move.kind !== MoveKind.InteriorPseudo &&
      move.region === relocated.region &&
      move.component === relocated.component &&
      (move.kind === MoveKind.Enclosure
        ? move.boundary === relocated.boundary && (move.i === relocated.token || move.j === relocated.token)
        : (move.b1 === relocated.boundary && move.i === relocated.token) ||
          (move.b2 === relocated.boundary && move.j === relocated.token));

    if (touchesTarget) {
      const childCanon = await canon(child.enc);
      if (!seenL.has(childCanon)) {
        seenL.add(childCanon);
        lChildren.push(child);
      }
      continue;
    }

    const childCanon = await canon(child.enc);
    if (rCanon !== null && rChild === null && childCanon === rCanon) {
      rChild = child;
      continue;
    }
    if (!seenT.has(childCanon)) {
      seenT.add(childCanon);
      tChildren.push(child);
    }
  }

  return { lChildren, rChild, tChildren };
}

export interface DisaGeneticCode {
  L: number[];
  R: number | null;
  D: number | null;
  Tprime: number[];
}

function sameNumberSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort((x, y) => x - y);
  const bs = [...b].sort((x, y) => x - y);
  return as.every((v, i) => v === bs[i]);
}

function codesEqual(a: DisaGeneticCode, b: DisaGeneticCode): boolean {
  if (a.R !== b.R || a.D !== b.D) return false;
  return sameNumberSet(a.L, b.L) && sameNumberSet(a.Tprime, b.Tprime);
}

/**
 * T' gene: the deduped set of nimbers reached by literally deleting each T'-move child's isolated
 * [22] summand and calling analyze() on what's left (analyze() handles a multi-component ⊕-sum's
 * XOR on its own -- no manual combination needed here). `tChildren` should be the ALREADY-classified
 * T children of `target` (see classifyChildrenByDisaPoint) -- this only re-checks each one's shape
 * against `canonText`'s own trivial-dead-pair count to find which ones are actually T' (an isolated
 * pair not already present in the parent), the same untracked structural signal
 * analyzeTEntry's fallback path uses (a T move never touches target's own token, so a freshly-
 * appearing [22] pair can only be its decayed branch).
 *
 * When the [22] summand IS the whole child (e.g. [α,3]/[3,α]/[α3]/[3α] -- a bare DisaPoint pair
 * with nothing else in the position), deleting it leaves no subposition at all: the terminal
 * (no-moves-left) position, whose nimber is 0 by definition (mex of the empty option set) -- not a
 * lookup miss to silently drop. analyze('') would just fail to parse, so that case is handled
 * directly rather than falling into the general deleteComponent+analyze path below.
 */
export async function computeTprimeGeneFromChildren(canonText: string, tChildren: ChildInfo[], target: DisaPointRef): Promise<number[]> {
  // Use provenance-based mark (traceTMove) to detect which T children are genuinely T' (i.e. the
  // DisaPoint decayed into an isolated [22] summand). A purely structural count of new [22]
  // components is incorrect: a T move can produce [22] by an unrelated mechanism (e.g. connecting
  // two 2-life vertices that share a boundary letter), which has nothing to do with the DisaPoint.
  const nimbers = new Set<number>();
  for (const tc of tChildren) {
    const traced = await traceTMove(canonText, target, tc);
    if (!traced || traced.mark.kind !== 'isolated') continue;
    const childParsed = parseEncoding(tc.enc);
    if (childParsed.length === 1) {
      nimbers.add(0);
      continue;
    }
    const remainder = deleteComponent(tc.enc, traced.mark.index);
    const res = await analyze(remainder);
    if (res.ok) nimbers.add(res.nimber);
  }
  return [...nimbers].sort((a, b) => a - b);
}

/** Full (L,R,D,T') genetic code of one DisaPoint. */
export async function computeGeneticCode(canonText: string, target: DisaPointRef): Promise<DisaGeneticCode> {
  const parsed = parseEncoding(canonText);
  const [L, rEnc, dRes] = await Promise.all([
    lMoveNimbersRobust(canonText, target),
    computeR(parsed, target),
    analyze(buildReplaceEncoding(parsed, target)),
  ]);
  const rRes = rEnc !== null ? await analyze(rEnc) : null;
  const R = rRes && rRes.ok ? rRes.nimber : null;
  const D = dRes.ok ? dRes.nimber : null;
  const { tChildren } = await classifyChildrenByDisaPoint(canonText, target, rEnc);
  const Tprime = await computeTprimeGeneFromChildren(canonText, tChildren, target);
  return { L, R, D, Tprime };
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
export function isTrivialDeadPair(component: ParsedComponent): boolean {
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
 *   (computeR(...)) -- removing the SAME DisaPoint from two canon-equivalent
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

    const targetRemove = await computeR(srcParsed, target);
    if (targetRemove !== null) {
      for (let i = 0; i < dstDps.length; i++) {
        if ((await computeR(dstParsed, dstDps[i])) === targetRemove) {
          return { enc: compressed, mark: { kind: 'disapoint', index: i } };
        }
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
 * Trace one T move (identified by matching `tChild`'s canon against the decompressed root's
 * children) through provenance to determine where `target` ends up: still a DisaPoint, decayed into
 * an isolated [22] summand, or gone. Shared by computeTprimeGeneFromChildren (needs only the mark)
 * and analyzeTEntry (also needs step1's tracked encoding for the Grandparent Bypass check). Returns
 * null if the move can't be matched or traced.
 */
async function traceTMove(
  rootEnc: string,
  target: DisaPointRef,
  tChild: ChildInfo,
): Promise<{ step1: { enc: string; src: PosSrc }; mark: TPositionMark; decompRootParsed: ParsedComponent[] } | null> {
  // `tChild` always comes from classifyChildrenByDisaPoint's tChildren, which itself calls
  // allMovesTracked(decompress(rootEnc).enc) -- so `tChild.move`'s indices are ALREADY relative to
  // that same decompressed text (decompress() is a pure function of rootEnc, so re-decompressing it
  // here reproduces the identical text). Earlier this instead re-matched tChild by CANON EQUALITY
  // against a freshly (deduped) childrenTracked(decompRes.enc) list, which broke as soon as
  // classifyChildrenByDisaPoint started surfacing every raw move separately (see its own doc
  // comment): whenever two or more DISTINCT moves shared a canonical result (the same structural-
  // automorphism case that caused the "empty T" bug), canon-matching could only ever find ONE
  // representative move and silently applied ITS trace to every tChild sharing that canon --
  // producing the same (possibly wrong, possibly un-α-markable) mark for children that actually
  // came from different moves relative to `target`. Using tChild.move directly removes the
  // ambiguity: each tChild is traced through the move that actually produced it.
  const decompRes = await decompress(rootEnc);
  if (!decompRes.ok) return null;
  const rootParsed = parseEncoding(rootEnc);
  const relocatedTarget = await relocateDisaPoint(rootParsed, target, decompRes.enc);
  if (!relocatedTarget) return null;
  if (!tChild.move) return null;

  const decompRootParsed = parseEncoding(decompRes.enc);
  const rootSrc = srcWithTarget(decompRootParsed, relocatedTarget);
  const step1 = await traceMove(decompRes.enc, rootSrc, tChild.move);
  if (!step1) return null;
  const [step1Canon, tChildCanon] = await Promise.all([canon(step1.enc), canon(tChild.enc)]);
  if (step1Canon !== tChildCanon) return null;

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
    const rootTrivialCount = decompRootParsed.filter(isTrivialDeadPair).length;
    const childTrivialIndices = childParsed.reduce<number[]>((acc, c, i) => {
      if (isTrivialDeadPair(c)) acc.push(i);
      return acc;
    }, []);
    if (childTrivialIndices.length > rootTrivialCount) {
      mark = { kind: 'isolated', index: childTrivialIndices[childTrivialIndices.length - 1] };
    }
  }

  return { step1, mark, decompRootParsed };
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

  const traced = await traceTMove(rootEnc, target, tChild);
  if (!traced) return none;
  const { step1, mark } = traced;

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
