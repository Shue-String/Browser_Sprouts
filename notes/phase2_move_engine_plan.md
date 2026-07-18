# Phase 2 design: the move engine (written 2026-07-05, end of Phase 1 session)

Read this alongside [stalks_old_code_notes.md] and [shue_paper_notes.md]. Phase 1 is DONE:
`stalks/` builds green (54/54) via `stalks\build.bat`. Existing modules: tokens.hpp,
boundary.{hpp,cpp} (rotation/mirror with joint re-emission, canonical rotation,
automorphism shifts, bodyParts, lives2), position.{hpp,cpp} (Component/Position, MRef
pairings, validate incl. planarity rule, decompressed()), encoding.{hpp,cpp}
(parse/serialize, ⊕/φ/*n, agnostic 9s).

## Strategy decision (made deliberately — don't relitigate without reason)

Generate children **directly by walk-rewriting**, the way the paper's move notation does,
instead of porting the old three-level template precompute (Loop.connectors/enclosures/
deletions → Region templates → Game application). Rationale: direct generation is far
easier to get right; P5 (the default dev target) is tiny; the old template machinery was
an optimization for Python that C++ may never need. If P6/P7 profiling later says
otherwise, add interned-boundary template caching as Phase 2b — the old-code notes
describe that architecture fully.

## Universal pre-step

**Exterior connection to any compressed pseudo-point (3/4/5/6) ⇒ decompress it first**
(Position::decompressed already exists; do it per-pseudo-point, not globally, or globally
then recompress in cleanup — global is simpler and cleanup recompresses anyway).
Interior moves on compressed pseudo-points are direct rewrites (paper):
(3̲ q*)=(q*), (4̲ q*)=(q*), (5̲ q*)=(2 q*), (6̲ q*)=(3 q*) — i.e. delete the token
(3,4), replace with SCAB (5), replace with DISA (6). These four are their own move class;
generate them straight off the compressed form.

## Endpoint consumption table (what happens to a connected token, decompressed form)

- SPOT → APPE (stays in place on the walk).
- APPE → SCAB.
- SCAB → dead: remove from walk.
- MEMB → dead ("disappear"): remove from THIS walk *and* remove the partner occurrence
  from its boundary in the other region (pairing tells you where). Occ indices of later
  membranes shift — remap pairings, same bookkeeping style as decompressed().
- Joint half (either visit) → vertex is full: remove BOTH visits from the walk.

## Move class 1: Join (old "merge") — endpoints on two different boundaries, same region

Result: the two boundaries fuse into one; the generated vertex appears twice on the fused
walk as a new joint pair (JOINTSTART/JOINTEND wrapping one side), matching old
combineTwoLoops. Construction: walk b1 from just after p1 around back to p1, walk b2
likewise from p2; fused = J + rot(b1 after consumption) + J + rot(b2 after consumption).
Then re-normalize joints (first-seen 7/8 re-emit — boundary.cpp reemit path via
rotated()). Degenerate cases (old special cases, re-derive from the endpoint table
rather than hardcoding): if a consumed side collapses to nothing (e.g. joining scab-cell
or membrane-cell boundaries), the generated joint has nothing between its visits → it is
a distal → SCAB (paper: "instant chop"). Both sides collapse (scab+scab cells) → single
SCAB boundary.

## Move class 2: Enclosure — endpoints on the same boundary (or one endpoint twice)

Pick endpoints p1, p2 on one boundary; the walk splits into two arcs; each arc becomes a
boundary of one of two NEW regions replacing the old one. The generated vertex becomes a
MEMB pair, one occurrence appended to each arc, paired with each other. Other boundaries
of the region are distributed between the two new regions in all 2^(n-1) ways (old
binaryTreeSet; just iterate bitmasks over the other boundaries).
- Joint transmutation: a joint with one visit on each arc becomes a MEMB pair (one occ
  per new region, paired together) — the paper's "transmute". A joint with both visits on
  one arc stays a joint there. (This replaces the old enclosureSplitsToBoundaries.)
- Self-connections: SPOT to itself → the two arcs are the spot's two sides: region gets
  replaced by two regions, walks "spot' gen'" and "spot'' gen''" → both spot and gen are
  MEMB pairs: boundaries [AB / AB] plus the distributed other boundaries. APPE to itself
  → one side has only the generated vertex (single-MEMB boundary), other side keeps the
  walk with the appendage's vertex now a MEMB (old hangingToSelf). Only SPOT and APPE can
  self-connect.
- Endpoint consumption per the table above, applied per-arc (each arc sees its side of
  the endpoint). NOTE the endpoints sit at arc edges; SPOT contributes its remaining
  APPE-side to one arc — check against paper example [0̲,0̲,0]=[0,1718] and
  [0̲̲,0,0||]=[0,0,4] and get the placement right; those two examples are the unit tests.
- Membrane endpoints: consumed membrane also deletes its partner occurrence cross-region
  (may cascade decay in cleanup).

## Cleanup pipeline (run after every move; iterate to fixpoint)

1. Drop empty boundaries; drop empty regions (a region emptied of living tokens is dead).
2. **Decay**: if a membrane is the only living point in one of its two regions, that
   region dies and the OTHER occurrence becomes SCAB in place. (Old removeEmptyRegions
   degeneration, now symmetric and general.)
3. Component split: regions connect iff they share a pairing; split the pairing graph
   into ⊕ components. All-dead component → φ (only keep φ if the whole position is dead,
   i.e. position [φ] = end state; ⊕φ components are dropped otherwise — decide + test).
4. If compression toggle ON, recompress pseudo-points — GENERAL detection (the old code
   only caught these on their own component; that limitation must die):
   - DisaPoint: membrane whose other side's region contains exactly that membrane + one
     scab (same boundary "2A" or two boundaries "2","A" — both compress to 3).
   - Hollow: two membranes ADJACENT on this boundary (adjacency after dead removal, incl.
     wrap) whose other sides are alone together in one region.
   - Split point: adjacent membranes A,B; A's other side in region {A', M1}, B's in
     {B', M2}, M1↔M2 paired (both variants of boundary grouping; canon interior is the
     single-walk one, see decompressed()).
   - Triplet: three consecutive membranes, other sides alone in one region.
   Recompression changes occ indices → pairing remap. Also canon rule: [29|2,9]-style
   interiors always compress; when ambiguous ([2A|BC|1A,2BC] hollow-vs-nothing), compress
   greedily left-to-right after boundary canonical rotation for determinism.
5. Deterministic normalize (pre-canon): canonical rotation per boundary, boundaries
   sorted within regions, regions sorted (by boundary count, then values), region mirror
   flip if the mirrored region sorts lower (chirality — old lesserOrder). This is the
   "slacked" canon; full canonAlgo constraint-propagation is Phase 3.

## Move enumeration driver

For each region: all unordered endpoint pairs across its boundaries (join if different
boundaries, enclosure if same), all valid self-connections, plus interior pseudo-point
moves. Endpoint eligibility: any token with ≥1 life on this side (SPOT, APPE, SCAB, MEMB,
either joint visit; compressed 3/4/5/6 exterior = decompress first). Dedup children by
normalized serialization (Phase 3 canon tightens this later).

## Edge tags

Store per child edge, per the "paper movetype language" decision: for plain tree building
record {kind: join|enclosure|interior, endpoint token types (post-classification),
selfConnect flag}. The L/R/D/E/T/T′ classification only exists relative to designated
crits — expose a classifier function later (left/right phase) rather than baking crit
info into edges now.

## Tests / oracles for Phase 2

- Paper move examples as unit tests: [0̲,0̲,0]=[0,1718]; [0̲̲,0,0||]=[0,0,4]; the join
  order-of-operations example ([0,4,22,12AB3|0,0,0,0,AB] scab-to-C move → result in
  paper notes); interior rewrites of 3/4/5/6.
- [0] full tree by hand: [0]→[4]→φ; G([0])=0 expected, G([4])=1 (Phase 4 computes; for
  Phase 2 just check the child sets).
- [0,0] and [0,0,0] child sets small enough to hand-verify counts.
- After Phase 3 canon lands: position counts vs old stats (2-spot 20, 3-spot 176, 4-spot
  1863, 5-spot 22470 — full-encoding column; compressed variants in old-code notes), and
  5-spot as the standard dev run (user: a triple-decay-ish gotcha first appears at
  6-spot; watch for it there, not at 5).
- Every generated child must pass Position::validate() — keep that assertion on in tests.

## Phase 2 progress — session 2026-07-05: enclosures DONE

`src/moves.{hpp,cpp}` added; 71/71 checks green. Implemented: `applyEnclosure`
(component- and position-level), `enclosureMoves`, `enclosureChildren` (dedup by
serialization, validate() on every child). Internals: labeled-item walks (membrane
identity = label, joint identity = jointId; 7/8 re-derived at emission) so surgery never
remaps occ indices. Cleanup pipeline: chop (adjacent joint → distal scab, cascades),
empty drops, decay (lone membrane → region dies, partner → scab), isolation (lone scab
region dies), ⊕-split via union-find on pairings, slacked normalize (canonical boundary
rotation, boundary sort, per-region mirror-lesser, region sort by (#bnds, values)).
DECISION MADE: ⊕φ components are dropped unless the whole position is dead (then [φ]).

**CORRECTION to the endpoint consumption table above** (derived from corner geometry,
verified against [0,0]→[1718]→appe-appe = 4-membrane cycle [ABCD|0,CBAD], and hollow
interior enclosure reproducing (4̲ q*)=(q*)): the endpoint becomes whatever its remaining
corners dictate. In an ENCLOSURE, an APPE endpoint (deg 1→2) keeps one corner in each new
region → it becomes a MEMB pair between them, NOT a scab. "APPE → SCAB" can only be the
JOIN behaviour, and even there corner analysis says the appendage's two visits wrap the
cut excursion (joint), collapsing to a distal scab only when the appendage was alone on
its boundary — matching the old code's special-cased (1,) connector. RE-VERIFY against
the paper when writing joins; the general join rule to code is probably
"connected APPE → joint around the cut; distal→SCAB when nothing else on its walk".

Enclosure ordering conventions (fixed, tests depend on them): L = p1' + arc1 + p2' + gen,
R = p2'' + arc2 + p1'' + gen; L replaces the region in place, R appended (other regions
keep indices); mask bit k sends the k-th other boundary to R. SPOT self → [p,gen / p,gen]
both MEMB pairs; APPE self → inside [gen], outside = walk with gen at the appendage's
slot (appendage dead).

Next: Join (move class 1), interior pseudo-point rewrites, then the enumeration driver +
edge tags; the join order-of-operations paper example is the first oracle.

## Phase 2 progress — session 2026-07-05b: joins + interior pseudo + driver DONE

97/97 checks green. Added to `src/moves.{hpp,cpp}`:
- **`applyJoin` / `joinMoves` / `joinChildren`** (move class 1). Construction (splice model,
  matching old combineTwoLoops): `b2` is the HOST (kept split in place around `p2` so a b2
  joint wrapping p2 correctly wraps the whole splice); `b1` is the CONNECTOR (rotated to
  after p1, wrapped by the generated joint `g`). Assembly:
  `merged = before2 + e2open + g₁ + (e1open + brest1 + e1close) + g₂ + e2close + after2`.
  Endpoint consumption (join-specific, verified valid+planar across all types via the rich
  position test + probes): SPOT→single APPE in place (no wrap); connected APPE→a fresh
  joint wrapping its own boundary remnant (brest); SCAB/MEMB→vanish (MEMB also kills its
  cross-region partner via deadLabels); JOINT-half→whole joint removed (deadJoints scrub of
  merged). **All degenerate collapses are handled by the existing `chop`** (cyclic-adjacency
  = distal→SCAB): e.g. appendage-alone→scab, lone-scab bridge→scab, scab+scab→φ (the fused
  lone scab is then isolated and dies). No mask (join keeps one region). Verified oracles:
  [0,0]→[1718]; [0,0,0] join two spots→[0,1718]; [0,2]→[12]; [2,2]→φ; [0,2,2]→[0,2];
  [0,1718] spot→appendage → [17771888]; spot→joint-half → [11718].
- **`interiorPseudoChildren`** — the four paper interior rewrites on the COMPRESSED form
  directly: (3q*)=(q*) drop DISA, (4q*)=(q*) drop HOLL, (5q*)=(2q*) SPLIT→SCAB,
  (6q*)=(3q*) TRIP→DISA. Implemented by relaxing `labeled()` with an `allowPseudo` flag
  (pseudo-points ride as opaque Items; cleanup/normalize/split already ignore non-joint
  non-memb tokens), then the shared `finishComponent` tail. Verified: [0,3]→[0], [0,4]→[0],
  [0,5]→[0,2], [0,6]→[0,3].
- **`childrenAll` / `childrenAllTagged`** (enumeration driver): interior moves on the
  compressed form + enclosure & join on `p.decompressed()`, deduped by serialization.
  `EdgeTag{MoveKind, endpoint1, endpoint2, selfConnect}` recorded per first-reaching move
  (endpoint token types read pre-consumption from the decompressed component; interior
  moves tagged uniformly). Refactors: extracted `finishComponent` (cleanup→normalize→split)
  and `spliceChild` (reinsert pieces into a Position, drop dead, φ if all dead), now shared
  by enclosure/join/interior.

**Paper worked-example oracle — CONFIRMED (2026-07-05b, with user).** The
[0,4,22,12AB3|0,0,0,0,AB] "Move Notation Order of Operations" example is an **ENCLOSURE,
not a join** (both endpoints — the scab and the DisaPoint — sit on the ONE boundary 12AB3;
the region splits, hence the `||`). The Phase-1 note that filed it under "join" was a
mislabel, and the paper's *old* section (the one the user pasted) called the boundary-
distribution behaviour a "join" — that terminology was SWAPPED vs where the paper landed
after the shortening. Current/authoritative terminology (matches the engine): ENCLOSURE =
both endpoints one boundary → region splits + distribute other boundaries via `||`; JOIN
(= old-code "merge") = two boundaries fuse. The user's canon result is
[0,1A|4,22,ABC|0,0,0,0,BC] (A = generated point; the old `AB` membranes relabel to `BC`).
`applyEnclosure` reproduces it EXACTLY (unique structural match among the enclosure
children), verified via a label-agnostic fingerprint since our output stays decompressed
(untouched hollow `4`) + slack-labelled until Phase 3. Now a regression test
(`fingerprint` helper in test_main.cpp). Notably validated: DisaPoint endpoint
decompress→membrane→consume with its interior `[2C]` scab region isolating and dying (the
"DisaPoints can be skipped" behaviour, reached the long way), a hollow riding along
untouched, and correct boundary distribution.

**Remaining OPEN items:**
1. JOIN (two-boundary fuse) still has no independent paper oracle — results are verified
   valid & self-consistent (planar, canonical, chop-collapsing) across all endpoint types
   via the rich-position `validate()` sweep, but no worked paper example was matched. Fine
   for now; revisit if a definitive join example surfaces.
2. `childrenAll` dedups compressed (interior) and decompressed (exterior) children by raw
   serialization, so the same game can appear in two forms until Phase 3 canon/recompression
   unifies them. Expected for Phase 2; child-COUNT comparisons to old stats must wait for
   Phase 3.

## Known open items

- S2 roster: [3,2α/y] duplicated in the user's Theorem-1 table; ask for the intended
  16th element when building the collection registry (not needed for Phase 2).
- Dead-component convention (φ handling in ⊕ splits) — pick in Phase 2, document.

## Note (not a TODO): membrane-lettering cap

`encoding.cpp` throws past 26 membranes in one connected component (single-letter A-Z
scheme only). Not worth building an extended-lettering scheme until positions actually
need it — revisit if/when working with positions larger than ~8 spots.
