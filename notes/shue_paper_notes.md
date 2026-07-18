# Notes on Sprouts_ShuePairings paper (read once 2026-07-04; refer here, not the paper)

Per author instruction: no commentary on the paper itself; these are working notes for the
analysis-engine rewrite.

## Terminology (paper = authoritative for the rewrite)

- **Position** = game state (planar graph). **n-spot position** `P_n` = no edges.
- **Region** = face (AJS/LV sense). **Boundary** = one region's side of a connected edge-set
  (or an isolated vertex). Boundaries are per-region; the same curve gives two boundaries.
- **Subposition** = set of regions with no adjacency outside the set (nim heap when minimal).
  **Minimal subposition** = LV's "land".
- Vertex types (living): **Spot** (deg 0, 3 lives), **Appendage** (deg 1, 2 lives),
  **Membrane** (deg 2, sides in two living regions, 1 life), **Joint** (deg 2, both sides
  same region, appears twice on one boundary with points between; 1 life),
  **Scab** = **decayed point** (deg 2, one side dead) or **distal** (deg 2, one region,
  adjacent to itself on the walk); 1 life. **Isolated vertex** = deg 2 but unusable (all
  region-mates full). Dead = deg 3 or isolated.
- **Body** = boundary + interior regions. **Body part** = body segment after removing
  joints. **Cell** = body that is a single point/pseudo-point. **Organ** = for a membrane
  on a boundary, all regions reachable via its other side without recrossing the boundary's
  membranes. "Organized/disorganized under {membranes}".
- **Pseudo-points** (compressed organs): **DisaPoint** (membrane whose other side is only
  that membrane + one scab; (29) or (2,9) — isomorphic trees, Eq. disapointEqualEquation),
  **Hollow point** (two adjacent membranes, other sides alone in one shared region),
  **Split point** (two adjacent membranes whose other sides are in a region with exactly one
  more membrane connecting those regions), **Triplet** (three consecutive membranes, other
  sides alone in one shared region).
- **Lives**; **adjusted lives** = lives − #subpositions; **extra-adjusted lives** L_e =
  lives − #subpositions − #DisaPoints − #splitPoints (each forces one isolation).
- Named transformations: **generation**, **disappear** (membrane/joint connected on other
  side → its encoding removed), **decay** (membrane's other region empties → decayed scab),
  **chop** (joint→distal when its interior collapses), **transmute** (enclosure turns joint
  into membrane), **isolate**. **Enclosure** (both endpoints same boundary → splits region),
  **Join** (two boundaries in same region → merge), merge = join in old-code terms.
- Vertex trivia (deg-3 taxonomy): pinwheel (1 region), socket (2), sutural (3). Edge types:
  bone (both sides same region), plate/shell (separates regions). Louse, lousy move (hollow
  cell connected internally). IRP, UIR.

## Encoding spec (the target encoding for the rewrite)

Base ("decompressed") encoding — digits 0,1,2,7,8,9,A–Z only:
- `0` spot, `1` appendage, `2` scab, `7` joint first visit, `8` joint second visit,
  `9` membrane (membrane-agnostic), `A–Z` membrane-specific (letter appears exactly twice,
  once per side, never twice in one region), `φ` dead subposition.
- (Author 2026-07-05: the dotted scab/DisaPoint subtype notations from the draft are
  dropped entirely — do not implement them anywhere.)
- Boundary = walk from arbitrary start, consistent rotational direction per-region
  (region's perspective).

Compression encoding (default) adds pseudo-point digits, removing their interiors:
- `3` DisaPoint (decompresses as interior (29) by convention), `4` hollow point,
  `5` split point, `6` triplet.
- e.g. [2A|BC|1A,2BC] compresses to [13,24]. Partial decompression is legal.

Delimiters: `|` between regions, `,` between boundaries in a region, `[ ]` subposition
(bracket group may hold several minimal subpositions), `⊕` between subpositions
(chosen because G(p1⊕p2)=G(p1)⊕G(p2)), `/` left/right divider (replaces one `|` or a
bracket), `( )` lone region. Letters may be reused across separate ⊕ components.
Boundary duplication: `0*10` etc. (use sparingly).

Organ delimiters (for partial positions only): `⟨` before an organ-entry membrane, `⟩`
after an organ-exit membrane; processed like 7/8 in the Dyck-stack algorithm; redundant
right after a 7 / before an 8; pseudo-points implicitly organ-encoded.

Move notation: underline the two endpoints (twice for self-connections); single underline
on 3/4/5/6 = move in its interior with fixed rewrites: (3̲q*)=(q*), (4̲q*)=(q*),
(5̲q*)=(2q*), (6̲q*)=(3q*). Join reordering algorithm (order of operations, 6 steps) puts
the connected boundary first in the last region and uses `||` to split off the boundaries
sent to the new region. Self-connection: boundaries before `||` go with the new membrane's
region.

Validity rules for encodings: each letter exactly twice, never twice in one region; per
boundary #7s == #8s and prefix-balanced; body-part/organ reachability rule (membrane hops
from one body part must never lead back to the same region on a different body part).
Connecting a joint to its own other side is not a valid move.

## Dyck path machinery (joint encoding correctness + body-part extraction)

Joints as 7/8 = up/down of a Dyck path over the ordered rooted tree whose nodes are body
parts and edges are joints (glove bijection). A body's joint graph is always a tree
(a cycle would make the "joint" appear once → not a joint).
**Stacked Dyck Path algorithm**: scan boundary; `7` → push (move up a row, write `(`),
`8` → write `)` and move down after; other tokens written at current row; close with final
`)`. Reading each row left-to-right groups points into body parts (drop empty `()`).
Same algorithm with ⟨/⟩ yields organs.

## Canonization

Definition (ordering rules): split into minimal subpositions, each starting letters at A;
subpositions ordered by region count; within, regions ordered by boundary count then
integer value of boundaries (letters = digits in a high base); tie-break = labeling giving
lowest concatenated integer (NP-intermediate step). Canon example:
[177187288]⊕[0,A|0,124,17237A828].

Algorithm (canonAlgo.tex, 12 steps — per subposition):
1. Compress pseudo-points ([29|2,9] canon-compresses as [23], never [2,3]).
2. Membrane-agnostic (9s) minimal rotation per boundary (track ties/reversals as variants).
3. Order boundaries within region; try full reversal (mirror) of the region; keep lesser
   tuple; note ambiguous orders.
4. Order regions by (#boundaries, values); note identical regions.
5. Boundary→tuple-of-digits + enumeration suffix.
6. Replace each cut(=membrane) digit with the tuple of the *region it connects to*
   (maintaining direction); other digits become singleton tuples. (Region-reference
   refinement, like WL-coloring.)
7. Re-sort boundary-tuples; symmetric regions: try both, keep lesser. Prune dominated
   variants.
8. Lock: for boundaries in definite order in a unique region, assign lower-case letters to
   cuts in first-seen order; mirror the letter onto the other side.
9. Propagate: locked letters force rotations/orders elsewhere; repeat 4–8 until stable.
10. Residue: brute-force remaining permutations (special case: boundary made entirely of
    cuts whose other side is otherwise empty → label from arbitrary start, mirror order).
11. Re-letter with capitals A,B,C,… in first-occurrence order left-to-right.
12. Repeat 7–11 if still ambiguous; NP-hard tail, but N is small in practice.

Quick-canon: swap regions with known nimber-equivalent regions (Advanced Collections),
possibly changing lives; append `⊕a` (usually ⊕0, sometimes ⊕1 via Pairing Theorem) to the
encoding. Requires storing nimbers alongside positions.

## Left/right framework (future "left side analysis" feature)

- Left/Right position: removing chosen **critical membranes (crits)** splits position;
  encode with `/` divider; crits get Greek letters α, β (non-crit letters start at C).
  n-crit. Left side x, right side y; X, Y sets; [x/ and /y] side encodings.
- Single-crit movetypes: L (crit↔left point), R (crit↔right), D (right move decaying crit
  to left), E (right move, no decay), T (left move keeping crit connectable), T′ (left move
  decaying crit to right). Separating moves S = {L, LL, R, RR, D, DD, RD, T′}.
- Double-crit: T, E, Lψ, LL, Rψ, RR, Dψ, DD, Rψ1Dψ2 (+ unused T′ψ etc. for >1 crit; R′ψ
  special for [βα/ left side).
- Commutation table (Lemma commutativeMovesSingle): e.g. E/T commute, D/T, etc.
- ω notation: ω(p) child nimbers, ω_M(p) per movetype; G(p)=mex(ω). Cross-distributed nim
  addition ⊛ for separated sides: ω_S = ω_Sy ⊛ ω_Sx. Full mex-union equations for 1-crit
  and 2-crit positions (fullUnion1/fullUnion2).
- Compatibility: partial right sides y^Ψ organized under crit-sets; x ≅ y^Ψ validity;
  forced transformations let tables ignore invalid combos.
- **E-skip Theorem**: if ω_~E([x1/y]) = ω_~E([x2/y]) for all y then nimbers equal; E moves
  handled by recursion over Ŷ_n (right sides n E-steps from E-free: Ŷ0 =
  {/α2], /α,2], /α3], /α,3]}).
- **Grandchild Bypass Theorem**: x2 ∈ T(T(x1)), all ~E moves of [x2/y] parallel in [x1/y],
  and every unparalleled move of [x1/y] has [x2/y] as a child ⇒ same nimber. "Parallel
  moves" defined via same movetype/crits/right-side + same-nimber (separating) or
  same-collection (non-separating) left sides. Lowest-order element s_{n↓}: all ~E moves
  parallel in every element (lowest-order set of a collection is a simple collection).

## Collections (the nimber-swap library for quick-canon)

- **Collection** = set of left sides X (same crit count) s.t. for any compatible y all
  [x/y] share a nimber. **Simple** = same extra-adjusted lives; **Advanced** = not.
- DEFINITIVE ROSTERS (Theorem 1 tables, provided by author 2026-07-05; all "..." = open,
  more elements exist via extension theorems):
  **S1(y)** = { [2α/y], [2,α/y], [0,α/y], [2,2,2,α/y],
                [12,α/y], [5,2α/y], [23,2α/y], [2,2,3,α/y],
                [13α/y], [23,3α/y], [22,2α/y], [2,3,3,α/y],
                [1,3α/y], [3,23,α/y], [22,3α/y], [17α8/y], ... }
    Lowest-order: [2α/ (a DisaPoint!).
  **S2(y)** = { [1α/y], [1,α/y], [5α/y], [5,α/y],
                [2,2α/y], [22α/y], [2,2,α/y], [27α8/y],
                [2,3α/y], [23α/y], [2,3,α/y], [37α8/y],
                [3,2α/y], [0,2α/y], [0,3α/y], ... }
    (Author 2026-07-06: the draft's duplicate [3,2α/y] (its listed 16th entry) is DROPPED — the
    15 explicit elements above are correct and there is no separate intended 16th; the rest of the
    collection is open via the extension theorems. Registry is unblocked.)
  **S3(y)** = { [0,βα/y], [β7α8/y], [2βα/y], [2,βα/y], [β,2α/y], [2,β,α/y], ... }
  **S4(y)** = { [1,βα/y], [22,βα/y], [5,βα/y], [23,βα/y], [3β,2α/y], ... } (simple, but
    treated as Advanced due to Pairing linkage with S3)
  Also C5={[2α/],[2,α/]}, C6={[4α/],[4,α/]} (simple).
- NOT in collections: [12α/], and the separate simple collection {[2,1α/],[1,2,α/]};
  {[3α/],[3,α/]} its own simple collection.
- Other simple collections: hollow cell C_[αβ/ = {[αβ/y],[α,β/y]} (exactly 2 elements,
  proven closed); C_[αβγ/ = {[αβγ/],[α,βγ/],[α,β,γ/]} (closure unproven);
  boundary 22 ≡ boundary 1 (interchangeable, same game tree effect).
- **Fixed-Left Extension Theorem**: single-crit [x̌/y] with x(R) and x(D) fixed-move
  positions, μD = μR+1, no T′: μR even ⇒ S1, odd ⇒ S2. Double-crit: Rψ∈S1(y_Rψ) and
  Dψ∈S2(y_Dψ) ⇒ S3; swapped ⇒ S4. Examples: [23,3α/], [33,2α/] ∈ S1.
- **Semi-simple**: position = single region of scab cells (b) + DisaPoint cells (d), b≥1:
  fixed-move, μ = b+d−1, G = parity. Left sides 2*b,3*d,9*a: a=1 odd(b+d)→S1,
  even→S2; a=2 odd→S3, even→S4; extends inductively to a>2.
- **Pairing Theorem**: G(s1(y)) = G(s2(y)) ⊕ 1 and G(s3(y)) = G(s4(y)) ⊕ 1. (Complementary
  pairs W(h)={2h,2h+1} machinery.) This is the source of ⊕1 in quick-canon.
- **DisaPointing constructions**: any DisaPoint inside a left side is itself a crit with
  right side [2β/...]; recursively replace DisaPoints with S1 (nimber unchanged) or S2
  (⊕1) left sides → arbitrarily large positions with known nimbers. Often special cases of
  S3/S4 via /y^α|2β] right sides.
- **Unnecessary Moves Theorem**: for non-lowest-order S1/S3 positions, T moves never needed
  for optimal play; for S2, specific spot→hollow-cell T moves ([0̲̲,2A||/y], [0̲̲,3A||/y])
  are never the sole winning move. NOT general: 4 counterexamples incl. [1227A8|0,1A].
- Triple-crit {[0,γβα/],[2,γβα/]} is NOT a collection (counterexample y=/αD|2βDγ]; 45
  confounding right sides under P6, all organized under all three crits — organ
  compatibility is the discriminator).

## Computational facts

- Old Python program: full canonized tree + metadata under P6 = 12 GB RAM, ~1 hr; file
  < 1 GB compressed. P7 est. 250 GB / ~1 day in Python. Rewrite goal: make P7 plausible.
- LV pseudo-canon counts vs true canon counts vs simple quick-canon counts table exists
  (figure omitted; in-notebook stats cell has game counts: 2:20/18, 3:176/169/147,
  4:1863/1757/1483, 5:22470/20972/17175, 6:301529/279500/223154).
- **Lemoine & Viennot OLD BASELINE (author 2026-07-07, hardcoded in testQuickNimber `lvBaseline`):**
  2:18, 3:157, 4:1796, 5:24784, 6:393103. Printed alongside our structural + quick counts (each
  with its 1-subposition breakdown) so the reduction rate is checkable against L&V. NOTE it is a
  DIFFERENT metric from our structural canon (e.g. LV 3=157 < structural 175; LV 2=18 < 20), so it
  is not a sub/superset of our counts -- displayed as its own column, no forced ratio.
- Boundary lives: 2L(b) = 6·#spots + 4·#appendages + 2·#scabs + 2·#joints(count 7s only)
  + #membranes. Unique-boundary counts by 2L(b) computed (table omitted).
- Mirroring can change nimber/winability: G([3A|23A,223425])=3 vs G([3A|2A3,223425])=8;
  add [44] (smallest G=3) to flip winability. So chirality matters — canon must compare
  mirror images (old code's lesserOrder/flipReversedRegions).
- Optimal P6 games can last 12, 14, or 16 moves (counterexample to Morbidity Equation).
- AJS conjecture; Lam's theorem m ≤ floor(7n/3); parity connection theorem.

## Design implications for the rewrite

1. Canonization should follow canonAlgo (constraint-propagation + residual brute force),
   replacing the old brute-force allPointReorders product. "Slack off" toggle = stop after
   step 9 (locked prefix) and accept a deterministic-but-unproven-minimal labeling; flag it.
2. Encoding layer needs: base vs compressed mode, membrane-agnostic (9s) vs
   membrane-specific (letters), ⊕-splitting, optional dotted variants (2̇/2̈, 3̇/3̈) for
   counting studies. ASCII-safe alternatives needed for file format (e.g. 3'/3" or flags).
3. Pseudo-point handling must be general (not only own-component like old HOLL/TRIP);
   detection = organ analysis via Dyck stack, not region-shape special cases.
4. Quick-canon needs: collection registry (S1..S4 + simple collections + extension-theorem
   predicates: fixed-move left sides, semi-simple parity rule), nimber stored per position,
   ⊕a tag in encodings/records.
5. Left/right future work needs: movetype classification (L/R/D/E/T/T′ + double-crit),
   ω_M sets per movetype, ⊛ cross-distribution, compatibility (organ encoding ⟨⟩).
   Design child generation so each child edge is tagged with (side, movetype, crits
   touched) when a crit-set is designated — this makes the later features additive.
6. Partial trees (frontier expansion): position records must tolerate unknown nimber /
   unexpanded children (old topDown/recurseDepth idea, done properly).
