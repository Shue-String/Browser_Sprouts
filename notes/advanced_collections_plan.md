# Advanced Collections / quick-canon plan (design locked 2026-07-06)

Working notes for the quick-canon (Advanced Collections) layer. Terminology and rosters:
see [shue_paper_notes.md](shue_paper_notes.md) "Collections" + "Canonization > Quick-canon".

## Goal

A **toggleable** canonicalization that maps collection-equivalent positions together, shrinking
the node count (targets: 2:18, 3:147, 4:1483, 5:17175, 6:223154 vs structural 20/175/1855/...).
Because a collection swap can flip the Grundy value by one, each quick-canon'd position carries a
nimber **offset a in {0,1}** (the `+a` / oplus-a tag). Toggle OFF => exact structural canon
(current behaviour) is always still available.

## Graph model (decided this session -- NOT a separate game tree)

Quick-canon is stored as edge metadata on the existing game graph, not as its own tree.

- `quickCanon(P) -> (rep, off)`: `rep` is always an **oplus-0** canonical form; `off in {0,1}`.
  The oplus-1 variant is **never** its own node -- it is `rep` plus an edge offset.
- `Node` gains `quickChildren : vector<(Node* rep, int off)>` and `quickNimber`.
  `minMoves`/`maxMoves` are **not computed** in quick mode (dropped).
- Build recursion (quick mode): for each raw child `C` of `rep`, `(r,c) = quickCanon(C)`,
  recurse into `r`, store edge `(r,c)`. Then `quickNimber(rep) = mex{ quickNimber(r) ^ c }`.
- Toggle just selects which child array `build`/mex walks (`children` vs `quickChildren`).
- Arbitrary lookup of `Q`: `nimber(Q) = quickNimber(rep) ^ off` where `(rep,off)=quickCanon(Q)`.
  The lone `off` XOR is exact at the position level (Pairing Theorem `G(s2)=G(s1) ^ 1`).

### oplus-1 variant children (deferred to graph-wiring phase)

The oplus-1 variant's child list is generally the oplus-0 rep's children with **every offset
flipped** -- EXCEPT the enumerated **Unnecessary T / T'** moves (Unnecessary Moves Theorem;
charts to be extracted from the paper). Reason it isn't universal: `mex(S ^ 1) != mex(S) ^ 1` in
general (e.g. S={0,1}: mex 2, flipped mex 2 != 3). The paper proves every non-Unnecessary child
IS a clean flip, so the exception set is small.

Handling for exception children: (1) try a cache hit -- an Unnecessary move is often already
valued as some other parent's child; (2) else compute it independently. Design the quick-child
edge with a per-edge **"trust the flip" flag** so this drops in later without reshaping the graph.

Needed before wiring: the extracted Unnecessary-move charts.

## Collections pass = generalized `recompress`

The pass mirrors `canon.cpp`'s `recompress`/`allCompressions` fixpoint loop, but matches against
a **collection registry** instead of the fixed organ shapes, and accumulates an offset.

- A DisaPoint-rep swap is literally
  `applyCompress(host, hostBnd, critPos, len=1, DISA, {leftSideRegions})` -- the same surgery
  that compresses a literal DisaPoint, but the match test is "the detached left side belongs to
  a registered S1/S2 collection", and the swap adds the collection's offset.
- **Recursive collections** (user requirement): loop to a fixpoint. Each swap collapses a chunk
  into a `3` inside its host, which can expose a new crit whose left side now matches -- keep
  reducing until no collection applies. Worked example:
  `[0,C|C,2D|124D] -> [3,2D|124D] (S1, +0) -> [1243] (S2, +1)`, total `[1243] oplus 1`.

## Left-side extraction  (crit-count-generic representation; k=2 finder deferred)

Cut a set of **k crit membranes** simultaneously; the **left side** is the set of regions that
become disconnected from the host. `k=1`: the crit is a bridge in the region-adjacency graph
(cutting it detaches one host-free chunk). `k=2` (S3/S4): a 2-edge cut (both membranes detach the
chunk together). The chunk representation, canon, and registry are all **k-generic from the
start** so double-crit is additive. Deferred to a later increment: the `k>=2` **finder** and the
genuinely hard **"crits on different organs"** matcher (the two crit ports land on structurally
different parts of the chunk). This increment seeds/tests `k=1` (S1/S2) only, but nothing in the
plumbing assumes `k=1`.

## Left-side canonicalization -> registry key  (THE design fork)

A left side is a small **marked graph with colored, ordered ports**: the detached chunk plus its
`k` dangling crit membranes, each rendered as a **distinct** reserved sentinel. Elements are tiny
(a few regions / tokens), so canonicalize by **brute force over the chunk's symmetries** (all
rotations, region orders, both chiralities), and take the lexicographic-least serialization. That
string is the registry key. Cheap because N is small; no need to teach `canonMinimal` about marked
edges.

Port identity is part of the structure and travels *with* the geometry: a symmetry induces a
permutation of the ports, and the canonical labeling of which crit is `a` vs `b` falls out of the
same lex-min. So `[ab/` and `[ba/` collapse to one key **iff** a genuine chunk automorphism swaps
the ports (i.e. they really are the same left side); otherwise they stay distinct. This is exactly
standard colored-marked-graph canonicalization and needs no crit-count special-casing.

Registry elements are **authored as left-side encodings** (`[2a/`, `[0,a/`, `[0,ba/`, ...) parsed
by a small dedicated left-side parser (`a`,`b` = ordered crit markers, `/` = left/right divider)
into the same marked-chunk form and canonicalized identically. Match == equal canonical key.

## Registry (extensible)

Static table, easy to extend later (user: "positions beyond the ones I provided"). Each entry:
`(leftSideEncoding, collectionId)`. Per collection: `(canonicalRep, offsetWithinPair)`.

- Seed: **S1** (offset 0) and **S2** (offset 1); shared rep = the DisaPoint `3` ([2a/).
  Rosters in shue_paper_notes.md. Pairing: `G(S1)=G(S2) ^ 1`.
- Later: S3/S4 (double-crit, rep TBD, S3 offset 0 / S4 offset 1), simple collections
  (C5,C6, hollow-cell, {[3a/],[3,a/]}, etc.), extension-theorem predicates (fixed-move,
  semi-simple parity) as computed matchers rather than enumerated rows.
- NOT in any collection (must never match): `[12a/]`, `{[2,1a/],[1,2,a/]}`.

## Toggle

`STALKS_COLLECTIONS` env (matches existing `STALKS_*` convention) + an explicit bool/param on the
new entry points. Exact structural canon stays the default.

## Module surface (new: `src/collections.{hpp,cpp}`, added to `stalks_core`)

- `struct QuickCanonResult { Position rep; int offset; };`
- `QuickCanonResult quickCanon(const Position&);`   // fixpoint collections pass
- registry access + the left-side canonicalizer + crit-finder (internal).
- Entry point tie-in (`canonicalizeAdvanced`) and GameGraph wiring come in the deferred phase.

## Scope

THIS increment: machinery + tests (registry, crit-finder, left-side canon, recursive
`quickCanon`, worked-example + roster round-trip tests). GameGraph wiring + Unnecessary-move
exception handling: deferred.

## Progress

- **MACHINERY INCREMENT DONE + verified 2026-07-06** (`src/collections.{hpp,cpp}`, CMake,
  `testCollections`; 169/169 checks, warning-clean):
  - Step 1: authoring parser (`parseLeftSide`: single-region, ports = sentinel tokens
    `PORT0+i`) + marked-graph canonicalizer (`leftSideKey` = per-boundary least rotation,
    sorted boundaries, min over chirality). Full S1+S2 roster distinctness sweep (no collisions).
  - Step 2: crit-finder + extraction (`enumerateCrits`, `detachableLeftSideKeys`). A single-crit
    bridge == a LEAF region (exactly one membrane); `markedLeaf` renders its membrane as the
    port. Worked example finds exactly the 2 expected crits.
  - Step 3: registry (`registry()`): `leftSideKey -> {offset, rep=DISA}`, seeded from the S1
    (offset 0) + S2 (offset 1) rosters. Whole S1/S2 family shares the DisaPoint `3` rep, so the
    swap surgery is identical and only the offset differs.
  - Step 4: `quickCanon` fixpoint (`applySwap` = host membrane -> `3`, delete leaf, repair
    pairings). Each round canonicalizeFull, apply the lex-least matching swap, XOR its offset,
    loop until none match (recursive collections; terminates since each swap deletes a region).
    `quickCanon` ALWAYS reduces; toggle is the caller's job.
  - Step 5 tests: worked example `[0,C|C,2D|124D] -> [1243] oplus 1`; single S2 flip
    `[1A|1A24] -> [1324] oplus 1`; S1 keeps offset 0; two S2 swaps XOR to 0.
- **SOUNDNESS PROVEN 2026-07-06** (`testQuickNimber`, always-run): quick-canon preserves the
  exact Grundy value (offset included) for EVERY position in the 2- and 3-spot trees
  (exactNimber(P) == quickNimber(quickCanon(P).rep) ^ offset). 171/171. So the S1/S2 swaps +
  offsets are correct, and the deterministic lex-least choice is empirically confluent for
  correctness (no nimber depends on swap order at 2/3-spot).
- **Count reduction: 2-spot 20->19, 3-spot 175->148** (sound, 173/173), from S1/S2 swaps + 22==1:
  - **`22 == 1`** (`rewrite22`): a whole boundary of two scabs -> a lone appendage. Offset 0,
    quickCanon layer. Gives 2-spot 20->19 ([22]==[1]) and 3-spot 175->148.
  - `[2,2]` (two separate scab boundaries) does NOT merge (author: only whole-boundary 22==1).
- **COUNTS RECONCILED 2026-07-06**: the honest quick-canon counts are **2-spot 19, 3-spot 148**,
  and they are CORRECT. The old historical targets 18/147 included an unjustified ad-hoc merge
  (author collapsed distinct subpositions of equal nimber+remaining-moves to save memory);
  nimbers already handle those, so the merge is dropped. Official 2-spot = 19, asserted in
  `testQuickNimber`.
- **FLATTEN REVERTED 2026-07-06 (key-level AND position-level).** CRITICAL author correction:
  collection/congruity membership requires the left side to be EXACTLY the element -- extra points
  disqualify it, and boundary PARTITION is significant. [A,B/ == [AB/ holds ONLY for exactly two
  crits and no other points; with any extra point the crit partition changes the nimber.
  Counterexample: `[2,2,A,B|2A|2B]` = G1 vs `[2,2,AB|2A|2B]` = G2 (adjacent crits let an enclosure
  separate the scabs, finishing that region a move sooner). Consequences:
  - `regionKey` no longer flattens -- it PRESERVES partition (per-boundary canon + sort). Left
    sides match a collection ONLY by exact structural equality.
  - `applyCritFlatten` + helpers REMOVED. It was dormant on 2/3-spot (never fired), so the bug was
    never exercised -- the dangerous latent kind.
  - Hollow-cell / multi-crit-only merges must be redone as EXACT whole-region-is-only-crits
    matches, with real test coverage (ideally at a spot count where they actually fire).
- **CRIT-CELL CONGRUITY DONE + BUILT + VERIFIED 2026-07-07** (EXACT-match redo of the reverted
  flatten; k=2 and k=3). `collections.cpp`: `enumerateCritCells` detects a region whose tokens are
  EXACTLY k membranes (2<=k<=3), all crits (all MEMB, all paired to the outside with DISTINCT
  pairing indices -- the all-membrane requirement excludes the old flatten's `[2,2,A,B|..]`
  counterexample), not already a single boundary. `mergeCritCell` collapses EVERY partition to the
  SINGLE-BOUNDARY form `[9..9]`, repairing pairings. Direction is MERGE (reversed from an
  abandoned split attempt) for TWO reasons proven this session: (1) PLANARITY -- merging only
  collapses body parts so the result is always drawable, whereas splitting can emit non-planar
  positions (`[AB|1A1B]` valid but `[A,B|1A1B]` violates the body-part-connectivity rule in
  position.cpp; the two lone membranes reconnect region 0's two body parts through region 1);
  (2) ORDERING IS A NON-ISSUE -- once the cell is one boundary, canonicalizeFull unifies every
  cyclic order of the crits (rotation + global-mirror + region-reorder + first-occ relettering),
  VERIFIED via a throwaway probe: `[ABC|y]` and `[ACB|y]` are canon-equal AND nimber-equal even
  for asymmetric y. So no per-k ordering layer is needed. k=2 = hollow cell C_[ab/ (PROVEN closed);
  k=3 = C_[abc/ (PROVEN closed in the paper -- author confirmed 2026-07-07; the earlier "unproven"
  note was stale). All offset 0. Wired into the `quickCanon` fixpoint next to the S1/S2 swaps;
  merge strictly reduces boundary count so termination holds.
  - **k>=4 is EXCLUDED BY THE MATH, not just empirically.** The congruity closes for a k-crit cell
    iff canon's single-boundary symmetries reach every arrangement: rotation (k) x chirality (2) =
    2k. For k=3 that is 6 = 3!, so ALL orderings/partitions unify -> collection. For k=4 it is only
    8 < 24 = 4!, so the flip-and-turn does NOT reach all k=4 possibilities -> no collection. The
    paper has a section on exactly this. The build confirmed it: an earlier all-k>=2 version was
    UNSOUND at 5-spot on k=4/k=5 cells (`A,BCD`, `AB,CDE`); capping at `2<=k<=3` is correct and
    principled.
  - **RESULTS (stalks_tests, MSVC/Ninja, 182/182):** soundness (testQuickNimber exact==quick) GREEN
    at 2/3/4/5-spot. Counts structural->quick: 2: 20->19, 3: 175->148, 4: 1873->1385, 5: 22729->
    15397. k=3's marginal contribution over k=2-only: 4-spot 1390->1385, 5-spot 15627->15397.
    Both are already BELOW the plan's stale targets (4:1483, 5:17175) -- like 2-spot 18->19, those
    targets predate corrections; since soundness is green, below-target = more sound collapsing =
    strictly better, not over-merge.
  - Build: cmake at `...\VS\18\BuildTools\...\CMake\bin\cmake.exe`, Ninja+MSVC, needs vcvars64;
    `cmake --build build --target stalks_tests` then `build\stalks_tests.exe`.
  - k=3 is PROVEN, so NO 6-spot run needed for confidence. Guard test uses the real counterexample
    `[2,2,A,B|2A|2B]!=[2,2,AB|2A|2B]` (distinct reps). The `2-spot==19` assertion held (crit cells
    don't fire at 2-spot).
- **DOUBLE-CRIT S3/S4 DONE + BUILT + VERIFIED 2026-07-07** (single-region, k=2 scope).
  `collections.cpp`:
  - `regionKey` now minimizes over the k! PORT RELABELINGS as well as the geometric symmetries
    (factored the old geometry into `geometricKey`). The two crits are an unordered colour set --
    which physical membrane is 'a' vs 'b' is an arbitrary extraction choice -- so [.,βα/ and its
    port-swap [.,αβ/ collapse to one key. IDENTITY for k=1, so every S1/S2 key is unchanged (all
    prior tests still green). This is the operational reading of the plan's "which crit is a vs b
    falls out of lex-min"; soundness of treating the crits as interchangeable is validated below.
  - `markedRegion` marks EVERY membrane of a region as a distinct ordered port (vs `markedLeaf`'s
    one). `enumerateDoubleCrits` = the k=2 analogue of the leaf finder: a region with EXACTLY two
    membrane occurrences, both paired outward with DISTINCT pairings (a region's only links are its
    pairings, so cutting both detaches it -> valid 2-crit left side). Bare 2-membrane cells surface
    here too but are absent from the S3/S4 registry (crit-cell merge owns them).
  - `doubleCritRegistry`: S3 (off 0) `{0,ba; b7a8; 2,ba; b,2a; 2,b,a}`, S4 (off 1)
    `{1,ba; 22,ba; 5,ba; 23,ba; 3b,2a}`. Shared rep = [2βα/ = single boundary [SCAB,MEMB,MEMB].
    Rep element "2ba" is OMITTED so a region already in rep form never re-swaps (termination).
  - `applyDoubleCritSwap`: replace the chunk's whole content with [SCAB,MEMB,MEMB], re-point the two
    crit pairings at their original hosts (rep is port-symmetric -> host order immaterial, canon
    normalizes). Region keeps its index; hosts untouched. Wired into the `quickCanon` fixpoint next
    to S1/S2 + crit-cell. Every listed element has boundary>=2 or tokens>=4, so each swap strictly
    reduces (tokens, boundaries) -> fixpoint still terminates.
  - **RESULTS (stalks_tests, MSVC/Ninja, 188/188):** soundness (testQuickNimber exact==quick) GREEN
    at 2/3/4/5-spot. Counts cells-only -> +S3/S4: 3: 148->139, 4: 1385->1262, 5: 15397->13816
    (2-spot stays 19 -- double-crit doesn't fire there). Fires as early as 3-spot, so it is really
    exercised (not latent). 5-spot 13816 is below the stale plan target 17175 -- expected post-
    corrections, and soundness-green means below-target = more sound collapsing, not over-merge.
  - Targeted test: [2,AB|12A|12B] and [2AB|12A|12B] (S3 partition variants, hosts = the
    non-collection leaf [12α/ so the double-crit swap is the ONLY reduction) collapse to one rep,
    offset 0. Plus port-swap key invariance ([2ba/==[2ab/, [b,2a/==[a,2b/) and partition
    distinctness ([2,ba/ != [2ba/).
  - DEFERRED still: multi-region 2-edge-cut finder ("crits on different organs");
    `STALKS_QCDUMP=n` dump grouped by quick rep.
  - GameGraph materialization is NOT deferred — `GameGraph::Mode::Quick` shipped and is wired
    directly into `analyze.cpp`'s `quickGraph()`/`quickAnalysis` (independent of the
    `STALKS_COLLECTIONS` toggle, by design). The Unnecessary-Moves-Theorem flip-exception
    shortcut described below was abandoned in favor of just recursing `quickCanon` per child.
- Deterministic-choice / confluence ASSUMPTION: the fixpoint applies the lex-least matching swap
  for reproducibility; relies on collection-equivalence being confluent (offset path-independent).
  Empirically holds at 2/3-spot (soundness test); to prove/double-check when convenient.
- NEXT (deferred, not this increment): the multi-region 2-edge-cut finder ("crits on different
  organs") for double-crit; count validation vs 2:18/3:147/4:1483/5:17175/6:223154.
  (GameGraph wiring itself already shipped — see the S3/S4 section above.)
