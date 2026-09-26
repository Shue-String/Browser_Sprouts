# Notes on Sprouts_ShuePairings paper (reworked 2026-09-24 against Sprouts_ShuePairings_20260921.tex;
# original read 2026-07-04 against the 2026-06-22 draft — refer here, not the paper)

Per author instruction: no commentary on the paper itself; these are working notes for the
analysis-engine rewrite. **This file was fully reworked 2026-09-24** against a much later paper
draft (title now "Related Classes of Positions in the Game of Sprouts"). The definitions/encoding
material below is largely carried over from the original July notes since the author cut those
sections from the paper purely for length, not because they changed; everything from Left/Right
Methodology onward is new — the paper had only a stub "future work" description of that machinery
in July, and now the whole Genomes/Collections apparatus is built out and proven.

## Notation: paper vs. our sessions/code (deliberate, permanent differences)

- **Collections**: paper writes `S_n^o` (superscript offset); we write `S_n⊕o` in code/sessions.
  Author has decided to keep this difference (⊕ reads better in our context); do not "fix" one to
  match the other.
- **Double-crit collections**: paper writes `_2S_n` (leading subscript 2, e.g. `_2S_1`); we use
  `Z_n` in code/sessions (`Z` was free since it's no longer a movetype letter — see below). Also a
  deliberate, permanent difference — `Z` is genuinely taken in the paper's own notation (it's now a
  single-crit movetype letter), so the author can't switch to it there.
- **Genome vs. collection**: the paper now distinguishes these as two different objects with two
  different letters — `g_N` is a *genome* (the literal tuple of nimber-sets), `S_N` is a
  *collection* (the set of left sides that produce that genome for every compatible right side). We
  have been using `S` for both in the registry/UI. **Worth syncing the code to this distinction
  later** (not done this session) — likely means introducing an explicit genome-tuple identity
  separate from the collection/family name, which is close to already true structurally
  (`genomeDefs.json` holds genome tuples, `collectionElements.json` holds collection membership) but
  isn't named that way anywhere in code/UI yet.
- **`T'` → `Z`**: the paper's old single-crit movetype `T'` (a left-side move that decays the crit
  to the right) has been renamed to `Z` in this draft. **Synced into the engine/UI 2026-09-26** —
  the `Tprime`/`T'` field, struct-slot, and display naming across `alpha_genome.{hpp,cpp}`,
  `double_crit_genome.{hpp,cpp}`, `double_crit_probe.cpp`, `collect_alpha_genetics.cpp`,
  `genome_for_reps.cpp`, `genomeDefs.json`/`genome_defs.generated.hpp`, `collectAlpha.ts`, and
  `collect.ts` (including the Collect pane's own genome-table row label) is now `Z`/`Zc` throughout.
  One frozen exception: the committed `src/data/collectAlphaGenomes.json` snapshot still stores the
  old `Tprime` key on disk (its exact original generation inputs aren't reliably reproducible, so it
  was left as-is rather than regenerated with a smaller position count) — `collect.ts`'s
  `ByEncHit`/`byEncGenome` bridges that one raw key into the live `Z` name on read; a future proper
  regeneration of that file can drop the bridge.
- **"Simple" / "Advanced" collections**: this distinction is **gone**. The paper no longer
  classifies collections by whether extra-adjusted lives are constant across elements; a collection
  is just a collection now, of any size. Do not use "Simple Collection" or "Advanced Collection" as
  formal terms going forward (informally the paper's own prose still uses "Advanced Collection" a
  few times as a leftover turn of phrase in the extended-logic/canonization sections, not as a
  defined term — don't read anything into that). **Synced out of the code's own prose 2026-09-26** —
  every "Advanced Collection(s)"/"Advanced-Collection" comment across the engine, tools, and TS
  mirrors was trimmed to plain "Collection(s)" (the already-removed `isInAdvancedCollection`
  function name is left as a historical reference in a couple of comments describing why it was
  removed). File/memory names (`notes/advanced_collections_plan.md`,
  `[[project_advanced_collections]]`) and the project's own established name for this feature are
  untouched — only the paper-facing prose term was in scope.
- **"Pair" → "offset"**: the old "Pairing Theorem" (⊕1 relationship between two collections) has
  been fully generalized and renamed. There is no more special "pairing" relationship between two
  named collections; instead, any collection can have an *offset* variant `S_N^q` for any natural
  number `q`, and the mechanism that produces it is just nim-addition of a genome, not a
  theorem-specific pairing. See Offsets below.

## Terminology

- **Point** = living vertex (the term implies only living vertices are under discussion).
  **Region**s are *adjacent* if they share a point (not an edge). **Connected** = reachable via
  adjacent regions. **Subposition** = set of living regions with no adjacency to any region outside
  the set. **Minimal subposition** = all regions in the subposition are connected to each other
  (LV's "land"); minimal subpositions function as nim heaps.
- Vertex types (living), each 1:1 with an LV-encoding digit/letter:
  - **Spot**: degree 0. 3 lives. Encoded `0`.
  - **Appendage**: degree 1. 2 lives. Encoded `1`.
  - **Scab**: degree 2, neither a joint nor a membrane. 1 life. Encoded `2`. (Decayed scab = one
    side dead; distal scab = one region, self-adjacent on the walk — both still just `2`.)
  - **Joint**: degree 2, both sides in the *same* region (occurs twice on that region's boundary
    walk, with a point between the two occurrences). 1 life. Called "cut vertex" in Focardi &
    Luccio; the paper deliberately deviates to an anatomical name. Encoded `7` on first visit along
    the boundary, `8` on the second.
  - **Membrane**: degree 2, each side in a *living* region. 1 life. Encoded with a capital Latin
    letter (each letter occurs exactly twice, once per side, never twice in the same region), or a
    lower-case Greek letter (`α`, `β`, ...) specifically when the membrane is *critical* — see
    Left/Right below.
  - **Dead** = degree 3, or isolated (degree 2 but both region-mates full/dead).
- **Pseudo-points** (compressed multi-point structures, each collapsing a small sub-region into one
  encoding digit):
  - **DisaPoint** (`3`): a membrane whose one side contains exclusively that membrane plus one scab
    (the scab may be on the same boundary as the membrane or a different one — both forms are
    interchangeable, proven via genome sequencing in the new Genomes section). Name = shortening of
    "Disappearing Point" (a move in its interior makes the membrane disappear from its boundary).
  - **Hollow Point** (`4`): two adjacent membranes on a boundary whose other sides are alone
    together in one shared region.
  - **Split Point** (`5`): two adjacent membranes on a boundary whose other sides are in a region
    with exactly one other membrane, and that membrane connects the two regions.
  - **Triplet** (`6`): three consecutive membranes on a boundary whose other sides are alone
    together in one shared region.
  - The dotted-scab/DisaPoint-subtype notations from an earlier draft remain dropped.
- **Body** / **Body part** / **Cell** / **Organ** / **Adjusted lives**: these definitions were cut
  from the current paper draft purely for space (the section is commented out in the `.tex` source,
  not deleted from the author's understanding) but the concepts are still used informally
  throughout (e.g. "organ-encoded" positions in the extended-logic section, "the organ containing
  α"). Carried forward from the original July notes as still-valid working definitions:
  - **Body** = boundary + interior regions. **Body part** = a body segment after removing joints.
  - **Cell** = a boundary composed of a single point or pseudo-point.
  - **Organ** = for a membrane on a boundary, all regions reachable via its other side without
    recrossing that boundary's membranes ("organized/disorganized under {membranes}").
  - **Adjusted lives** = total lives − #subpositions. **Extra-adjusted lives** = adjusted lives −
    #DisaPoints − #splitPoints (each of those forces one isolation). This was the metric the old
    Simple/Advanced split was based on; it's still a true structural fact, just no longer used to
    split collections into two classes.
- **Position notation**: `p` = an arbitrary position (lower-case, unlike most other Sprouts papers —
  upper-case is reserved for sets). `p_n` = a specific position when several are being discussed.
  `P` = a set of positions.
- **Transformations**: a move-triggered change of a position. The added point is *generated*. A
  membrane connected on one side *disappears* from the other side's boundary (a DisaPoint/hollow
  point may disappear entirely from an internal move). A membrane that becomes the only living point
  in one region *decays* to the other region. A membrane/scab no longer in any living region is
  *isolated*.

## Encoding spec (unchanged from the original notes; the paper's own description is largely the same)

Base ("decompressed") encoding — digits `0,1,2,7,8,9,A`–`Z` plus Greek letters for crits:
- `0` spot, `1` appendage, `2` scab, `7`/`8` joint first/second visit, capital Latin letter =
  membrane (specific letter, occurs exactly twice, once per side, never twice in one region), lower
  Greek letter = critical membrane (same occurrence rule, but appears once on the left side and once
  on the right — see Left/Right below), `φ` = a subposition with no living points (end state).
- Footnote worth keeping: the AI-generated C++ refactor (our Stalks engine) uses this exact digit
  scheme; the author's *original* hand-crafted Python code instead used `3` for a nonspecific
  membrane and `8`/`9` for first/second joint visits — a different, now-superseded scheme. If an old
  script or dataset uses `8`/`9` for joints, it's the old Python scheme, not ours.
- Order of points along boundaries/regions follows the same rules as LV-encoding; the base encoding
  itself does not enforce canonical ordering.

Compression encoding (default) adds pseudo-point digits `3`(DisaPoint)/`4`(hollow point)/`5`(split
point)/`6`(triplet), removing their interiors from the encoding. e.g. `[2A|BC|1A,2BC]` compresses to
`[13,24]`. Partial decompression is legal and used routinely in proofs when only part of a
pseudo-point's interior matters to the discussion at hand.

Delimiters: `|` between regions, `,` between boundaries in a region, `[ ]` around a subposition
(not necessarily minimal — several minimal subpositions may share one bracket pair when convenient),
`⊕` between subpositions (also the nim-addition operator, giving the convenient identity
`G(p1⊕p2) = G(p1)⊕G(p2)`), `/` in place of one `|`, splitting a position into **left** and **right**
sides for Left/Right analysis (see below) — a membrane appearing on both sides under this split is a
*critical membrane* / *crit*. `[φ]` = a subposition with no living points.

## Validity rules

- **Valid position**: drawable as a planar graph (default assumption whenever a position is
  referenced in the paper).
- **Valid encoding**: (1) each specific membrane occurs exactly twice; (2) no specific membrane
  occurs twice in one region; (3) each boundary's encoding has equal counts of `7`s and `8`s, with a
  `7`-count ≥ `8`-count prefix-balance at every point along the walk; (4) body-part/organ
  reachability rule — starting from a region `r1` and body part `b1` within it, repeatedly hop
  "choose a membrane on the current body part → its other side → a membrane on *that* body part" any
  number of times; if this ever reaches a membrane back in `r1` but on a *different* body part, the
  encoding is invalid. Holds for organs too when organ-encoding is in use.
- **Valid move**: for a generated point in region `r1`, both endpoints must be in `r1`; endpoints may
  coincide only for an appendage or a spot; generated edges must not cross any point or edge
  (including themselves or each other). Connecting a joint to its own other side is never valid.

## Left/Right Methodology (previously a "future work" stub — now the paper's core machinery)

A Left/Right position is separated by a chosen set of **critical membranes (crits)**; removing them
splits the position into **left** and **right** sides (some resulting subpositions may die on
separation). The `/` delimiter marks the split in the encoding. `n-crit position` = a left/right
position with `n` crits (informally "single-crit", "double-crit", "triple-crit", ...). With more
than one crit, a **partial right side** is the part of the right side reachable only from *some*
(not all) crits.

**Goal of the whole paper**: establish **collections** — sets of left sides which, paired with any
compatible right side, all produce positions of the same nimber.

### Left/Right encoding vocabulary

- Crits use lower-case Greek letters (`α` first, then `β`, ...); non-crit membranes in a left/right
  encoding start at `C` (not `A`/`B`) to avoid visual confusion with crit letters.
- `ψ`: an arbitrary crit (subscripted `ψ_1`, `ψ_2` when more than one is in play; `ψ_2` informally
  means "the crit that isn't `ψ_1`"). `2_ψ`: a critical scab (a decayed crit `ψ`; `2_α` for a
  specific one).
- `x` / `y`: the left / right side of a position (as regions, or as a function returning them). `X`
  / `Y`: sets of left/right sides. `x_n`/`y_n`: the left/right side of a specific position `p_n`.
  `x^n`/`y^n`/`p^n`: superscript `n` marks an object as having `n` crits (context-dependent, not
  always needed).
- `[x/` : a position with left side `x` and an arbitrary (unconstrained) right side — only valid
  notation when the right side doesn't need to stay fixed. `/y]` : the mirror, arbitrary left side.
- `N` (calligraphic): an integer enumerator for a collection/genome. `S_N(y)`: the complete
  collection for right side `y`. `s_N(y)`: an arbitrary position within `S_N(y)`. `S_x`: the
  collection containing left side `x`. Non-integer subscripts are allowed too (a position standing
  in for its whole collection, conventionally a lowest-order element) when a collection hasn't been
  given a number.
- **Side Encoding**: an encoding capturing only one side, `[x/` (Left-Side Encoded) or `/y]`
  (Right-Side Encoded) — only ever refers to positions where the unspecified side happens to result
  in something valid.
- Crit names persist across children (a move on `α` never silently relabels `β`); left/right region
  membership persists across children (nothing moves sides, and a new region from an enclosure joins
  the side where the move was made).
- `(2α)`/`(2,α)`-shaped sides are deliberately **not** relabeled as DisaPoints, so critical-membrane
  encoding stays consistent everywhere.
- Canonical ordering is deliberately **not** enforced for a full `[x/y]` write-up — instead crits on
  the left are written in reverse-alphabetical order, and crits on the right in alphabetical order as
  close to the front as possible, purely so a reader can spot which side is which at a glance.
- Diagrams are drawn from the perspective of the region on the *right* side containing crit `α`.

### Movesets

Moves partition by **movetype** (the location of the move's endpoints); movetypes available depend
on crit count.

**Single-crit** (`[x/y]`), six movetypes:
| Movetype | Meaning |
|---|---|
| `R` | connect the crit to a right-side point |
| `D` | connect two non-crit right-side points, causing the crit to decay *left* |
| `L` | connect the crit to a left-side point |
| `Z` | connect two non-crit left-side points, causing the crit to decay *right* (**this is the old `T'`**) |
| `E` | connect two non-crit right-side points, without decaying the crit |
| `T` | connect two non-crit left-side points, keeping the crit connectable on the left |

`L` and `R` moves always exist; others may not (e.g. `[2α/y]` has no `T` move — not enough
non-crit left-side lives). `Z`/`D` only arise when the crit's immediate left/right neighbor is
either a single membrane (possibly a DisaPoint) or two same-boundary membranes whose other sides
share one region (possibly a hollow point). If parent/child point-tracking separates left and right,
what would have been a `Z`/`D` move in the parent becomes a `T`/`E` move in the child respectively
(no boundary left to decay).

**Double-crit** (`[x/y]`), `T`/`E` unchanged in meaning (identical to single-crit); `Z` no longer
possible at all (removing a hollow point's internal connection still leaves the left region alive
via the other crit). Remaining movetypes all specify *which* crit(s) are affected and how:
`Rψ`, `RR`, `Dψ`, `DD`, `RψDψ'` (connect `ψ` right, decaying `ψ'` left), `Lψ`, `LL`, `Zψ`, `ZZ`,
`LψZψ'` (connect `ψ` left, decaying `ψ'` right), and `R'ψ` — a rare movetype unique to the left sides
`[αβ/` and `[α,β/` (see Special Collections below), connecting `ψ` right while decaying the *other*
crit right (not left).

**General movetype vocabulary**: `M` (calligraphic) = an arbitrary movetype, `M` (plain) = the set of
all movetypes. **Separating moves** `S`= `{R, RR, D, DD, RD, L, LL, Z}` — moves that split a position
into left/right subpositions (careful: `S` always means *one* separating movetype at a time, never
their union). `~M` (negation) = "every move not of movetype `M`".

**Movetypes as functions**: `M(p)` = the moveset of movetype `M` on position `p` (accepts a position,
a left side `[x/`, or a right side `/y]`). `X(M(p))`/`Y(M(p))` = the set of left/right sides
resulting. `x(M(p))`/`y(M(p))` = an arbitrary element of those sets. Shorthand `x_M = x(M(p))`,
`y_M = y(M(p))`. Since `E` moves never change the left side and `T` moves never change the right
side, `x(E([x/y])) = [x/` and `y(T([x/y])) = /y]` always — used to skip ever writing `[x_E/y]` or
`[x/y_T]`.

**ψ-distribution**: `[ψ_1,2ψ_2/y]` denotes the *set* of positions for both possible assignments of
`ψ_1`/`ψ_2` to `α`/`β`. `Rψ(p) = Rα(p) ∪ Rβ(p)`, and likewise for `Dψ`, `Lψ`, `Zψ`, `RψDψ'`,
`LψZψ'`. Using `ψ_1`/`ψ_2` subscript notation (rather than always naming `α`/`β`) is legal exactly
when the two named-crit versions are provably identical up to boundary rotation/reversal — a
convenience for compacting tables, not a structural claim on its own.

### Nim functions

Standard `G(p)` (nimber) / `⊕` (nim-addition) notation, following LV; no leading `*` on nimbers to
save table space (a bare integer is a nimber only when it's in a `G(...)` equation, next to `⊕`/`⊛`,
or explicitly called out as one).

- **Cross-distributed nim addition `⊛`**: for nimber sets `J`, `K`: `J ⊛ K` = the set of all
  `j⊕k` pairwise sums (a set, not a matrix, despite the grid layout used to define it) — commutative.
  A single known-value set like `{0}` or `{1}` is written bare (`1 ⊛ J` means `{1} ⊛ J`).
- **Child nimber sets**: `ω(p)` = nimbers of all children of `p`, so `G(p) = mex(ω(p))`.
  `ω_M(p)` = nimbers of children under movetype `M` only; `ω_Sx(p)`/`ω_Sy(p)` = nimbers of the
  *constant-side* subposition from a separating movetype `S` (the side where the move *wasn't*
  made). Since a separating move always leaves one side constant, `ω_S(p) = ω_Sy(p) ⊛ ω_Sx(p)`.
  Full single-crit nimber equation:
  `G(p) = mex(ω_Rx⊛ω_Ry ∪ ω_Dx⊛ω_Dy ∪ ω_Lx⊛ω_Ly ∪ ω_Zx⊛ω_Zy ∪ ω_T ∪ ω_E)`
  (double-crit is the identical structure over the larger movetype set).
- **Incompatible movetypes / forced transformations**: `RR`, `DD`, `R ψ_1 D ψ_2` are mutually
  exclusive (only one can be possible for a given right side). A **forced transformation** is an
  encoding transformation applied per a right-side move even though the corresponding left side may
  not actually be realizable — vacuously true since a position that can't exist can't be a
  counterexample. This is why *validity* (Remark: only compare positions that are both valid) has to
  be stated explicitly before relying on this trick.

### E-move Recursion / the E-skip Theorem

Since almost all the paper's logic fixes `y` and varies `x`, `E` moves (which vary `y`, not `x`) are
a wrinkle. Fix: any chain of `E` moves is finite (Lemma — Sprouts games have finite lives, ≥1 lost
per move), so nimbers of `^~E`-move-free right sides can be computed directly, then propagated
upward.

- `Ŷ_0` = right sides with zero `E` moves at all: `{/α2]; /α,2]; /α3]; /α,3]}`.
- `Ŷ_n` = right sides with ≥1 child in `Ŷ_{n-1}` and none in any `Ŷ_N`, `N≥n`.
- **E-skip Theorem**: for any fixed right side `y`, if `ω_~E([x_1/y]) = ω_~E([x_2/y])` then
  `G([x_1/y]) = G([x_2/y])`. Proved by induction over `Ŷ_n`: `G([x/ŷ_0]) = mex(ω_~E([x/ŷ_0]))`
  directly (no `E` moves exist to worry about), and every `G([x/ŷ_n])` reduces to a `mex` over
  `ω_~E` sets plus already-known `G([x/ŷ_{n-1}])` values, recursively bottoming out at `Ŷ_0`.

### Parallel moves and the Grandchild Bypass Theorem

**Parallel moves** `m_1([x_1/y])`, `m_2([x_2/y])`: same movetype; if either move has a given crit as
an endpoint, so does the other; both results have the same right side; if the moves are separating,
the resulting left sides have the same nimber; if non-separating, the resulting left sides are in
the same collection.

**Grandchild Bypass Theorem**: let `[x_2/y] ∈ T(T([x_1/y]))` be a grandchild of `[x_1/y]` (two `T`
moves down). If every `~E` move from `[x_2/y]` has a parallel move in `[x_1/y]`, *and* every move in
`[x_1/y]` **without** a parallel move in `[x_2/y]` has `[x_2/y]` itself as a child, then
`G([x_1/y]) = G([x_2/y])`. Proof leans on a small mex lemma (adding elements to a set that are
already excludants, or aren't the *minimal* excludant, never changes the mex) plus the E-skip
Theorem. This is the actual mechanism behind every "these two left sides share a genome" proof in
the paper — matches what's already implemented in the engine as "bypass-witness grandchildren" (see
[[project_advanced_collections]]).

## Genomes and Collections

A **genome** `g(p)` is the tuple of values needed to compute `G([x/y])` for a *fixed* right side `y`
(i.e. all `ω_Sy` known). Two left sides with the same genome necessarily have the same nimber for
every shared-compatible `y` — a **collection** `S_N` is the set of left sides sharing a genome
`g_N`. **This genome/collection split is the terminology change our code hasn't picked up yet** — we
call both "S" (see Notation section above).

Single-crit genome (5 **genes**):
```
g(p) = (ω_Rx(p), ω_Dx(p), ω_Lx(p), ω_Zx(p), [T(x/)])
```
where `T([x/)` is the genome of every *non-bypassed* T-child (bypassed = excused via the Grandchild
Bypass Theorem). `ω_Rx`/`ω_Dx` always have exactly one element, so braces are dropped for those two
genes in genome notation; `ω_Lx`/`ω_Zx` may be empty (`{}`, kept distinct from `φ`/end-state).
Written `g_N = (a, b, {c1,c2,...}, {d1,d2,...}, [...])`.

Proof mechanism = a **Genome Sequencing Table**: one row per `~E` movetype, columns
`Movetype | Child | Left Nimber | T-move child | Relevancy` (Relevancy = a sub-genome, or a
grandchild that provides a bypass per the Grandchild Bypass Theorem), with the resolved genome tuple
in a footer row. Two positions with matching genome-sequencing-table footers are in the same
collection by the E-skip + Grandchild Bypass argument.

### Offsets (replaces the old "Pairing Theorem")

Since `G(S_N(y))` is constant for fixed `y`, so is `G(S_N(y)) ⊕ q` for any natural `q`. The genome of
the `⊕q`-shifted collection can be computed directly, giving a collection notation with a superscript
nimber offset: `S_N^q ⟹ G(s_N^q(y)) = G(s_N(y)) ⊕ q` (superscript omitted when `q=0`). For a
minimal-subposition left side `q` rarely exceeds 1, but single-subposition (non-minimal) left sides
can have larger offsets — e.g. `[6,2C|2Cα/ ∈ S_1^2` and `[4,2C|2Cα/ ∈ S_1^3` (both worked in the
paper's genome sequencing tables).

**Vestigial T genes**: a genome `g_N^q` (any `q`, including 0) can have T-genes `g_N^{q'}` for any
`q' > q` — because `S_N^{q'}` necessarily has `S_N^q` as a child, making that T-gene a bypass rather
than new information. Example: `[0,4]⊕[2α/`'s genome has a `g_1^3` T-gene purely because `[4,4]` (a
child of `[0,4]`) has a *higher* nimber than `[0,4]` itself.

**Nested left sides / core left side**: a left side can itself contain (as an internal sub-region) a
smaller left side belonging to a known collection — e.g.
`[4,2A|2AB|B7C8|2728C]`'s first two regions are `S_1^3`, letting the whole thing reduce
`⊕3` then further reduce via a nested `S_1^1` DisaPoint, down to a directly-computable nimber. Nested
left sides are legitimate left sides in their own right, but tracking them explicitly has no
practical value (their count explodes exponentially up the game tree with no further quick-canon
compression benefit). **If a left side has exactly one minimal subposition and contains no other
non-rep left-side element, it's called a *core* left side** — this is the new formal term for what
our registry already calls "the family's `rep`".

### Double-crit genomes

16-gene tuple (paper presents it as a 4×4 grid, or equivalently this flattened tuple):
```
g(p) = (ω_RR, ω_DD, ω_LL, ω_ZZ, ω_RαDβ, ω_RβDα, ω_LαZβ, ω_LβZα,
        g(Rα), g(Rβ), g(Lα), g(Lβ), g(Dα), g(Dβ), g(Zα), g(Zβ), T([x/))
```
`LL`/`ZZ`/`LαZβ`/`LβZα` are mutually exclusive (existence of any one precludes the other three), so
at least 3 of those 4 grid cells are always empty. Double-crit collections use the same `^q` offset
notation, applied to every gene (including single-crit sub-genes like `g(Rα)`, where the offset
nim-adds over the whole single-crit collection). **Double-crit collection notation is `_2S_N`** (a
leading subscript 2) — our code's `Z_n` naming is the deliberate divergence noted above.

### Notable collections (from the paper's own summary table; counts are "among positions we have
calculated", core left sides only — cross-check against `collectionElements.json` before quoting)

| Name | Count (offset 0) | Count (offset 1) | Rep | Genome |
|---|---|---|---|---|
| `S_1` | >1500 | >1600 | `[2α/` | `(0,1,{0},{},[])` |
| `S_2` | 2 | 0 | `[3α/` | `(1,1,{0},{0},[])` |
| `S_3` | 3 | 0 | `[4α/` | `(1,2,{1},{0},[S_1])` |
| `S_4` | 1 | 0 | `[33α/` | `(2,0,{1},{},[S_1,S_2])` |
| `S_8` | 10 | 0 | `[4,2α/` | `(2,3,{0,2},{},[S_1,S_1^1])` |
| `S_9` | 9 | 8 | `[1,2,α/` | `(0,2,{0},{},[S_1^1,S_2])` |
| `S_12` | 7 | 5 | `[2,1α/` | `(0,3,{0,2},{},[S_1^1,S_2])` |
| `S_20` | 7 | 5 | `[12α/` | `(0,1,{0,2},{},[S_1^1,S_3])` |
| `S_22` | 7 | 5 | `[12,α/` | `(0,3,{0},{},[S_1^1,S_2,S_3])` |
| `S_25` | 7 | 5 | `[34α/` | `(0,3,{0,2},{},[S_1^1,S_2,S_3])` |
| `_2S_1` | 6 | 4 | `[2αβ/` | (double-crit grid; see above) |

**Worth telling the user**: this numbering (`S_1`..`S_4`, then `S_8`/`S_9`/`S_12`/`S_20`/`S_22`/
`S_25`) is *exactly* the kind of scheme our own `genomeDefs.json` renumbering (S_1–S_32 renumbered
by T-gene dominance, 2026-09-20, [[project_genome_renaming_tool]]) was aiming to match — worth a
direct side-by-side check that our `S_1`–`S_4` genome tuples agree with the paper's before trusting
the alignment; not verified this session.

### Special collections (don't fit the standard genome shape — left sides that are *only* crits)

- **`_2S_0`** — the empty double-crit collection, `{[βα/y], [β,α/y]}`. The only left sides (of any
  size) needing the special `R'ψ` gene instead of ordinary `Rψ` (because `/y_{R'ψ_2}]` ≠
  `/y_{Rψ_2}]` for these — not cosmetic). Proven to have exactly these two elements, no offsets, no
  further extension — the constraint is tight because `R'` can only exist for a left side that is
  *exclusively* two membranes.
- **`_3S_0`** — the empty triple-crit collection, `{[αβγ/y], [α,βγ/y], [α,β,γ/y]}`. The only known
  triple-crit collection at all in this draft.
- **Boundary `22` ≡ boundary `1`**: a boundary of exactly two scabs is interchangeable with a
  boundary of exactly one appendage — proven via the same E-skip-theorem machinery, treating the two
  boundary shapes as a right side with an empty left side. (An `R` merge on either always produces a
  scab beside the generated joint; an `RR` enclosure always produces a one-membrane, or decayed,
  boundary.)

## Triple-crit collections don't generalize (the obvious next guess fails)

Given `S_1 = {[0,α/y], [2,α/y]}` and `_2S_1 = {[0,βα/y], [2,βα/y]}`, the natural next guess —
`{[0,γβα/y], [2,γβα/y]}` is also a collection — is **false**. Smallest counterexample:
`y = /αD|2βDγ]` gives `G([0,γβα/y]) = 2` but `G([2,γβα/y]) = 4`; the contradiction traces to an `Lα`
move where the two children have nimbers 3 and 2 respectively.

Empirically, though, the two sides mostly *do* agree: of 3612 minimal-subposition `[0,γβα/y]`
positions in the `P_6` game tree, only 45 have a `[2,γβα/y]` counterpart with a different nimber (the
paper lists all 45 confounding right sides explicitly). The discriminator: every confounding `y` has
**all** of its regions organized under **all three** crits simultaneously (no organ split possible),
which is exactly the condition that also makes the "obviously equivalent" alternate encodings
(`[0,A⟨BC⟩/` vs `[0,γβα/`, etc., using organ-delimiter notation `⟨⟩`) actually *invalid* positions —
so the apparent equivalence breaks down precisely where the two encodings stop being interchangeable
representations of the same thing. (The formal organ-delimiter section this leans on was cut from
this draft for space, same as the Body/Organ definitions above — the notation `⟨⟩` is used but not
re-defined here.)

## Complete canonization / quick-canonization results (now extends to n=7, was n≤6 in the old notes)

| n | Lemoine & Viennot | True Canon | Quick-Canon |
|---|---|---|---|
| 0 | | 1 | 1 |
| 1 | | 4 | 4 |
| 2 | 18 | 20 | 19 |
| 3 | 157 | 151 | 118 |
| 4 | 1796 | 1476 | 949 |
| 5 | 24784 | 17252 | 10231 |
| 6 | 393103 | 229522 | 117545 |
| 7 | | 3347476 | 1834768 |

Counts include the end state `φ`; DisaPoints were **not** compressed for this table (compressing
them would collapse two genuinely different positions onto the same canon encoding). L&V's own
2-spot count (18) is smaller than True Canon's (20) because they used a more aggressive
small-position compression than this paper's math alone provides (`[22]=[1]` is the only compression
used here) — L&V is its own column, not a sub/superset of either of the other two. This table is
now the **authoritative source** for these counts (supersedes the old hardcoded `lvBaseline` note
below, which was a manually-copied version of the same L&V column for n≤6 only).

## Computational facts (unrelated to this paper's revision; still true, kept from the original notes)

- Old Python program: full canonized tree + metadata under `P6` = 12 GB RAM, ~1 hr; file < 1 GB
  compressed. `P7` was estimated at 250 GB / ~1 day in Python — the rewrite's whole point was making
  `P7` plausible, and per the table above it now is (True Canon count for n=7 computed and reported).
- Boundary lives: `2L(b) = 6·#spots + 4·#appendages + 2·#scabs + 2·#joints(count 7s only) +
  #membranes`.
- Mirroring can change nimber/winability: `G([3A|23A,223425])=3` vs `G([3A|2A3,223425])=8`; adding
  `[44]` (smallest G=3) flips winability — so canon must compare mirror images, not just one
  orientation.
- Optimal `P6` games can last 12, 14, or 16 moves (a counterexample to the "Morbidity Equation").
- AJS conjecture; Lam's theorem `m ≤ floor(7n/3)`; parity connection theorem — all still cited,
  unaffected by this revision.
- **Canonization algorithm** (12-step, constraint-propagation + residual brute force) lives in a
  separate document (`canonAlgo.tex`), not this paper — unaffected by this revision, not re-read this
  session.

## What got cut from this draft (readers of the old notes should know these are gone, not disproven)

The author cut several sections purely to shorten the paper; none of the following appear in the
current draft, so treat any of it as **unconfirmed against the current framework** rather than
carrying it forward as established fact (per [[feedback_no_unsourced_theory_claims]] — don't restate
these as "the paper says" going forward):
- **Fixed-Left Extension Theorem** and the **Semi-simple** parity-rule collections (both keyed off
  the now-retired Simple/Advanced split — may need a genuinely different formulation to survive
  under general offsets rather than being restatable as-is).
- **DisaPointing constructions** as a named theorem — its content lives on in spirit as the "Nested
  Left Sides" section above, but the recursive-replacement machinery isn't spelled out as its own
  theorem anymore.
- **Unnecessary Moves Theorem** (T-moves never needed for optimal play on non-lowest-order `S1`/`S3`
  positions, with known counterexamples) — **relevant to the paused T-gene minimality question in
  [[project_advanced_collections]]**: this was one of two candidate mechanisms flagged there before
  this paper was read; it is not present in this draft, so don't reach for it as a minimality
  argument without the user re-confirming it's still intended. The other candidate, the Grandchild
  Bypass Theorem, **is** present (see above) and already matches the engine's existing
  bypass-witness-grandchild logic.
- **Organ delimiter (`⟨⟩`) formal section** and **conjoined/partial-right-side (`y^Ψ`) notation
  section** — both referenced by `\ref` in the current draft (so the author still intends to use the
  concepts) but their defining sections aren't present in this `.tex` file. The notation appears
  informally in the triple-crit extended-logic section; don't rely on it beyond what's shown there.
- The old-style "Pairing Theorem" (⊕1 only, tied to specific named-collection pairs) — fully
  subsumed by the general Offsets section above; there's no longer a separate theorem to cite for
  the ⊕1 case specifically.

## Design implications for the rewrite (updated)

1. Quick-canon's collection registry should eventually track genome (`g`) and collection (`S`)
   identity separately, matching the paper's own distinction — not urgent, but worth keeping in mind
   for any future registry schema change (see Notation section above).
2. `T'`/`Z` naming synced 2026-09-26 (see Notation section above); `S`/`g` naming (genome vs.
   collection identity) is still deferred by the author — don't do that one without being asked.
3. Simple/Advanced is gone as a concept; nothing in the current engine ever branched on it
   structurally (quick-canon's registry never special-cased by extra-adjusted-lives-constancy). The
   "Advanced Collection(s)" wording itself was trimmed out of the code's own comments 2026-09-26 (see
   Notation section above); the project/feature's own established name (memory file, plan doc) is
   untouched.
4. Offset (`^q`/`⊕q`) is already modeled correctly in the engine as an accumulated XOR, not a
   `{0,1}`-only field (confirmed sound per [[project_advanced_collections]]'s own gotchas) — this
   matches the paper's general `S_N^q` machinery exactly, no change needed.
5. The Grandchild Bypass Theorem is already implemented (`check_ttree_extras.cpp`'s whole-T-tree
   audit); nothing new to build there.
6. "Core left side" is a new formal term for what the registry already calls a family's `rep` — no
   code change implied, just useful shared vocabulary going forward.
