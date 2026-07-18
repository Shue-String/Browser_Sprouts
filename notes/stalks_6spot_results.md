# Stalks — 6-spot GameGraph results

Recorded 2026-07-06. Run: `STALKS_GRAPH=6 stalks_tests.exe` (native MSVC Release-ish build,
structural canonical form with the exact prefix-pruned `canonMinimal` search as default).

## Headline

| Metric | Value |
|---|---|
| **Total positions (nodes)** | **300661** — exact match to the historical 6-spot baseline ✓ |
| Sums (≥2 minimal subpositions) | 71139 |
| **Single-subposition positions** | **229522** (= 300661 − 71139) |
| Child-edges | 5,066,188 (parent-link check: equal ✓) |
| **Build time** | **351.8 s** (pure GameGraph construction, harness `t1−t0`); wall 352.5 s |
| **Peak working set** | **356 MB** |

## Root value

```
root 0,0,0,0,0,0   G=0   minMoves=12   maxMoves=17
```

G(6-spot start) = **0** → the 6-spot opening is a **second-player win** (P-position). Consistent
with the Sprouts result that the first player loses when n ≡ 0,1,2 (mod 6); 6 ≡ 0.

## Nimber distribution (subposition-pruned node set)

```
G0:68590  G1:67042  G2:67600  G3:68992  G4:10446  G5:10145
G6:3743   G7:2965   G8:878    G9:234    G10:25    G11:1
```
(Sum = 300661.)

## Notes
- Counts now fully closed for 2/3/4/5/6-spot: 20 / 175 / 1855 / 22389 / 300661.
- This is the subposition-pruned "solver-minimal" node set (sum nodes link their parts rather than
  being expanded), which is why it matches the corrected historical master counts.
