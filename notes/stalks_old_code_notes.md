# Notes on the old Python analysis code (sprouts.ipynb, "stalks")

Scope: cells 0–29 (constants through Create/Load data), plus Region-swap test cells (19/42).
These notes are the reference for the rewrite; term mapping old→new is applied inline as
`OLD→NEW`.

## Terminology mapping (per rewrite spec)

| Old code | Old const | New term | New const |
|---|---|---|---|
| Free Point | FREE=0 | Spot | SPOT |
| Hanging Point | HANG=1 | Appendage | APPE |
| Singleton | SING=2 | Scab | SCAB |
| Boundary Point | BOUN=3 | Membrane | MEMB |
| Split point | SPLITSTART=4/SPLITEND=5 | Joint | JOINTSTART/JOINTEND |
| DisaPoint | DISA(POINT) | DisaPoint | DISA |
| Double / Lonely pair | LONELYBOUNDARYPAIR=-12 | Hollow Point | HOLL |
| Triple | LONELYBOUNDARYTRIPLE=-13 | Triple | TRIP |
| (none) | (none) | Split Point | SPLIT (new concept, distinct from old "split") |
| Loop | — | Boundary | — |
| Game | — | Position | — |
| Min String / findLowestGameName | — | Canonization | — |

Watch out: old "Boundary" (BOUN) = new **Membrane** (a point), while old "Loop" = new
**Boundary** (a cycle of points). Old `boundaries` dict (the membrane pairing map) is about
membrane links between regions.

## Data model (old)

- **Loop (→Boundary)**: tuple of point digits, e.g. `(1,4,1,4)`. Digits: 0 spot (only as
  `(0,)` loop), 1 appendage, 2 scab, 3 membrane, >=4 joint pairs (each joint id appears
  twice). Canonical form = lexicographically least rotation with joints renumbered in
  first-seen order (Dyck path: SPLITSTART on first sighting, SPLITEND on second, guaranteeing
  single-digit encoding). `enum` = int of that digit string; `enumString` is the key into
  `allLoops` (all rotational variants map to the same Loop object via `variantShifts`).
- **Special loops**: EMPT=-2 (empty), LONELYBOUNDARYPAIR=-12 (→HOLL), LONELYBOUNDARYTRIPLE=-13
  (→TRIP). Encoded as '6' and '9' in cleanString. These are *negative* enums so they sort
  first in regions — old logic sometimes relies on that.
- **Region**: sorted tuple of loop enums. RegionClass precomputes every possible *move
  template* on that region.
- **Game (→Position)**: list of regions + `boundaries` dict mapping membrane coordinates
  `(regionIdx, loopIdx, pointIdx) -> (regionIdx, loopIdx, pointIdx)` (bidirectional entries),
  or `-> DISAPOINT=(-2,-2,-2)` for disappearing points.

### Game string format (old)
`fullPointString ":" boundaryString`, e.g. `23|2,3:10`.
- fullPointString: regions joined by `|`, loops within a region joined by `,`, each loop its
  digit string (special loops as negative numbers e.g. `-12`).
- boundaryString: one char per membrane in reading order; char = base62 index of the partner
  membrane (`!` = DisaPoint). So `:10` means membrane #0 pairs with #1 and vice versa.
- Compression (`compressGameString`): strips trailing SPLITENDs (5s) at loop ends; drops
  `:` + boundary string entirely when the boundary string equals the "default pairing"
  (allBoundCompress.compressionList: second half indices then first half — i.e. membrane i
  pairs with i+n/2 pattern). EMPTYGAME 'NULL' compresses to 'N'.

## Sentinels / markers (old)

- CONNECTOR=-3: placeholder head in merge connector fragments.
- DISAPOINT=(-2,-2,-2), DEADPOINT=(-1,-1,-1): boundary-map values (point-level).
- DISALOOP=(-2,-2), DEADLOOP=(-1,-1), DISABOUNDCHECKLOOP=(-3,-3): loop-level remap markers.
- LEFTAPPEARINGLOOP=-4 / RIGHTAPPEARINGLOOP=-5: keys in merge remaps for loops that *appear*
  during a merge (only in TRIP merges, which spawn a `(3,3)` loop pair `33` with fresh links).
- NOTBOUN=-1, DISABOUNCHECK=-3 (scalar variants), DEADMAP=-1.
- Move-encoding constants: ENCLOSUREENCODING=0, MERGEENCODING=1; NONMOVEENCODING=-1,
  DISADROPENCODING=-2, LONELYPAIRDROPENCODING=-3; SIDEENCODING neither/left/right/both=0..3.

## Move generation architecture (the "pristine logic")

Three-level precomputation so that per-position work is mostly dictionary lookups:

1. **Loop level** (Loop class):
   - `connectors`: for each point of the loop, the fragment `(CONNECTOR, ...)` that gets
     spliced into another loop during a merge, + boundary remap + which membrane index dies
     (when merging *onto* a membrane, it becomes a scab & partner membrane must be deleted)
     + the point type (for move encoding). Special cases for (0,), (1,), (2,), (3,) loops.
   - `enclosures`: for each unordered pair of points (i,j) connectable within the loop
     (incl. spot-to-self, appendage-to-self special-cased), the resulting left/right loop
     pair + old-membrane remaps + new left↔right membrane pairing + membranes destroyed +
     move encoding. Joints traversed once by the cut get *converted to membranes* (they now
     separate the two new regions); joints wholly inside one side stay joints. Connecting a
     joint end to something removes the joint (its other end is deleted; `removeSplit`).
   - `deletions[(i,)|(i,j)]`: the loop with 1–2 membranes physically removed (used when the
     *other side* of a membrane is consumed by a move). Loaded with ~10 special cases for
     when the removed membrane sits between the two halves of a joint (the joint merges into
     a scab, etc.). NOTE FOR REWRITE: these hardcoded cases exist because deletion happens on
     the *tuple* representation; a cleaner path is delete-then-renormalize via the Dyck rules.
   - `degenerations[(i,)|(i,j)|(i,j,k)]`: membrane→scab conversions (when the membrane's
     other-side region degenerates away, membrane stays but becomes a scab).
   - `reversedLoop` + `reversedMapping`: mirror image (loops are chiral; regions may flip).
   - `isoRotations`/`isoMappings`: rotations mapping the canonical loop to itself
     (autmorphisms) — needed for canonization of membrane links.
2. **Merge level** (loopMerges class, allMerges[leftEnum][rightEnum]): cross product of the
   two loops' connectors → combined loop. Joining two loops in the same region: the drawn
   line becomes a *new joint pair* wrapping the left connector (or a scab/direct splice for
   1-point loops). Special handling: TRIP merges (specialTripleMapping) reintroduce explicit
   membranes `(3,3)`/`(2,3,3)`/`(3,3,4,3,3,4)`-style loops with LEFTAPPEARINGLOOP markers,
   because TRIP is only encoded implicitly. SCAB+SCAB → single scab (both endpoints already
   maxed → the two loops fuse into a dead-ish singleton).
3. **Region level** (RegionClass):
   - `merges`: for each loop pair in the region, all merge templates lifted to region coords.
   - `enclosures`: for each loop and each 2-partition of the *other* loops (binaryTreeSet
     gives all 2^(n-1) left/right distributions), for each loop-level enclosure: produces
     (leftRegionObj, rightRegionObj, boundaryRemap, leftToRightPairing, moveEncoding).
     Deduped via uniqueMappings incl. the left/right-swapped variant.
   - `disaDegens`: per membrane, the region after that membrane's DisaPoint fires.
   - `generateLonelyPairDeletions`: HOLL removal template.
   - `allPointReorders`: all boundary-permutation maps induced by (a) permuting identical
     loops within the region, (b) loop rotation automorphisms, (c) region reversal (mirror)
     when self-reversable. Used by canonization.
   - `reversedRegion`, `lesserOrder`: a region is stored in whichever chirality gives the
     lexicographically lesser loop-enum tuple; games flip regions to the lesser form
     (flipReversedRegions).
4. **Game level** (GameClass): applies region templates to the whole game:
   - executeAllMerges / executeAllEnclosures / executeDisappearances /
     executeLonelyBoundaryRemovals. Each: build new region list, remap `boundaries` dict,
     delete partner membranes on the other side (using loop.deletions), add new pairings,
     then `fullGameCleanup`, then spawnNewGame (dedupe via allFullPointBounds), recurse.
   - Nimber = mex of child nimbers; minMoves/maxMoves = min/max child +1;
     totalConnections = (sum of loop connectionValues + 3 per DisaPoint)/2 - 1
     (connectionValue: spot 6, appendage 4, scab 2, membrane 1, joint-half 1, i.e. doubled
     "lives" to keep ints; membranes are half-points!).
   - Disconnected games (checkRegionUnity via membrane-link BFS): split into subGames;
     nimber = XOR of sub-nimbers, min/max/connections additive; children NOT enumerated
     (recreated on the fly by generateNonUnifiedMoves during optimal-play walks).
   - Special games: EMPTYGAME 'NULL' (nimber 0); `3:!` single membrane w/ DisaPoint
     (nimber 1, one child NULL).

## Cleanup pipeline (fullGameCleanup)

removeEmptyLoops → removeEmptyRegions (regions `(3,)`→degenerate the partner membrane to
scab; `(2,)` and `()` dropped) → flipReversedRegions → orderRegionsInGame (sort loops within
regions, then regions by (len, tuple)) → if searchForSpecialCases: simpleCompressions →
findLonelyPair → findLonelyTriple → findDisappearing → repeat cleanup once (no special
search).

- **simpleCompressions** (only when useIsoRegions): region-level nimber-preserving rewrites:
  (2,2)→(1); (1,1)→(11); (2,2,2)|(2,22)|(1,2)|(2425)→(222); (2,3)→(23); (3,3)→(33);
  (3,13)→(133); six ways→(13): (2,2,3),(2,23),(223),(2435),(1,3),(22,3); three→(233);
  two→(333); loop 22→1 anywhere. These are the seeds of "Shue Collections" / Advanced
  Collections. NOTE: these change membrane indices → boundMapping fixups.
- **findLonelyPair/Triple**: a loop `33` (resp `333`) whose partner region is exactly the
  mirror `33` (`333`) with all links internal → collapse to HOLL / TRIP loop in the outer
  region, delete inner region. OLD LIMITATION (user): HOLL/TRIP only recognized when on
  their own component — rewrite should generalize.
- **findDisappearing**: region `(23)` or `(2,3)` whose membrane partner is elsewhere →
  replace region with `(2,)` (deleted by cleanup) and mark partner membrane as DISAPOINT
  (`!` in string). OLD WEIRDNESS (user): DisaPoints predate compression encoding — rewrite
  will encode DisaPoints natively (digit 7 in new scheme, cf. cleanString using "7").

## Canonization (findLowestGameName → "Min Strings")

fullPointString is already canonical up to membrane labeling (regions/loops sorted; loop
canonical rotations). The boundary string is minimized by brute force over:
regions-with-identical-content permutations (completeRegionMapping) × per-region
allPointReorders (loop swaps × rotations × mirror). Takes lexicographic min of resulting
boundaryString. All generated variants stored in `allOrdersQuickRef` →
`allFullPointBounds[fullPointString][variant] = gameObject` so *any* encountered labeling
finds the same game without re-canonizing ("firstRotation" early-break heuristic to skip
duplicate rotation orbits — unproven but tested). This is the NP-ish hot spot; user's paper
(canonAlgo section) has a better algorithm to seed the rewrite. "Slack-off" toggle for large
positions = accept possibly-non-minimal but *consistent* labeling.

## cleanString (the human-readable/compressed encoding, closest to new format)

genCleanString: walk the game; non-membrane digits copied; each membrane gets a letter A,B,…
assigned so both partners share the letter (first side seen assigns letter to *partner*
coords); DisaPoint membranes → digit "7"; HOLL loop → "6"; TRIP loop → "9". Regions `|`,
loops `,`. This is essentially the *paper encoding*; the new engine should make this the
primary key (with the old two-part string dead).
Note: current sproutsApp encoding (see memory project_encoding_system) uses tokens 0–6,~3,~5:
0 spot, 1 appendage, 2 scab, 3 membrane(named A-Z?), etc. — must reconcile with game repo's
`src/model` encoding when building the TS-side reader.

## Persistence (old save format)

- saveData writes two text files sorted by (connections, size):
  - sproutsRegionDataX.txt: RegionClass.saveRegionLine — 9 pipe-separated fields:
    region, reversedRegion, reverseBoundMap, lesserOrder T/F, selfReversable T/F,
    merges list (`/`-sep of `region;encoding;remap`), enclosures list
    (`left;right;encoding;remap;pairing`), disaDegens list, allPointReorders list.
    Dict serialization: `src>dest` with `,` inside tuples, `_` between entries; compressed:
    `src>` when dest==src, `src>-1` for dead.
  - sproutsGameDataX.txt: GameClass.printGameAsLine —
    `gameString[XsubGame...];nimber;totalConnections;minMoves;maxMoves;child@moveEncodings/...`
- Loading replays lines in order (children before parents by the sort) and verifies
  round-trip equality line-by-line (crash on mismatch).
- Rewrite target: `.sprout` binary/compact format, unionable, deduped.

## Move encodings (metadata about *how* a child was reached)

encodeLoopMoveData packs (moveType enclosure/merge, two point types, hangToSelf,
adjacentPoints side, emptyEnclosure side) into an int via mixed-radix on (SPLITSTART+1)
and SIDEENCODING; compressEncoding maps ~45 equivalent encodings onto canonical ones.
decodeMoveData produces prose ("Enclosure: free point to self, ..."). Stored per child edge
as a list of encodings. Keep the concept; renumber cleanly in rewrite.

## Region-swap analysis functions (cells 19/42)

- addSegment(gameObj, regionIndex, added, newBoundMap): appends loops `added[0]` to a region
  plus whole new regions `added[1:]`, wires new membrane links via newBoundMap convention
  (region 0 in the map = the target region, others offset onto appended regions), cleanup,
  canonize, optionally spawn. Returns existing game object if known.
- addAndCompare(regionAndMapPairings,...): for every game (filtered by maxConnections /
  unified-only), for every region, apply each (added,map) variant, tabulate the tuple of
  resulting nimbers → counts. Used to discover nimber-equivalent region swaps.
- compareWithReplacementRegion(removeRegion, addRegion, changeBounds,...): find games
  containing an exact region, swap it, remap membranes per changeBounds, canonize, compare
  nimbers; options sameRegionOtherSide/sameLoopOtherSide restrict which links are allowed.
- Rewrite: these become a first-class "substitute subsegment & compare" analysis API
  (results printed, nothing persisted).

## Stats (old runs, base/DISA-compressed/full-compression game counts)

2-spot: 20/18; 3-spot: 176/169/147; 4-spot: 1863/1757/1483; 5-spot: 22470/20972/17175;
6-spot: 301529/279500/223154 (58m Python). Good regression targets for the rewrite.

## Known warts to fix in rewrite (user-stated + observed)

- Joint encoding assumed joints get the *highest* digit values (SPLITSTART must be > all
  other point consts; verify-constants cell enforces it). New encoding no longer guarantees
  this → Dyck-path logic must be rewritten around explicit token classes, not `>=SPLITSTART`
  comparisons (`point >= SPLITSTART` appears everywhere).
- DisaPoints bolted on (DISAPOINT tuple sentinel spread across all remap functions).
- HOLL/TRIP only recognized on their own component.
- Error handling = print + exit() → proper exceptions/Result types.
- Duplicated enclosure templates (TODO in enclosureConstruction).
- GameClass `self = allGames[...]` re-assignment hack (Python anti-pattern; objects must be
  interned via a factory instead).
- `boundaryCompressions` default-pairing trick and base62 boundary chars → replaced by new
  letter-pairing (A-Z) encoding with \oplus for disconnected sums.
