// Filters the FULL collect_alpha_genetics.exe output (every single-alpha position found in the
// input .spec files, unfiltered -- see that tool's own header) down to the subset that actually
// ships to the Collect pane's bundle (src/data/collectAlphaGenomes.json).
//
// Why a separate step instead of filtering inside the C++ tool: the user wants the full backend
// data always regenerated and available (its own lives histogram printed by the C++ tool's stderr
// output), with the "what ships to the pane" decision made independently, downstream -- so the
// full dataset never has to be regenerated just because the shipped cutoff changes.
//
// The lives cap itself is a deliberate, revisable UI scope limit, not a correctness bound: the
// Collect pane's render()/acMarker (src/ui/collect.ts) rebuild the whole history list on every
// AC-membership resolution, which is fine at the old ~150-hit bucket scale but hangs the tab once
// a bucket reaches 1000+ hits -- confirmed when the 3-spot .spec source alone pushed S_1's bucket
// 138->1439, with lives running as high as 12. 8 was picked as "no reason to go higher at this
// time" (matches where the OLD 1spot+2spot-only dataset happened to cap out anyway).
//
// A kept entry's T-children are never separately filtered: a real move strictly reduces lives
// (modulo a bounded, documented special-point-decompress exception -- see specfile.hpp), so every
// T-child of a lives<=cap parent is itself well under the cap already.
//
// Usage: node tools/filter_collect_alpha_lives.js [--max-lives=8] [in.json] [out.json]

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let maxLives = 8;
const positional = [];
for (const a of args) {
  const m = /^--max-lives=(\d+)$/.exec(a);
  if (m) maxLives = Number.parseInt(m[1], 10);
  else positional.push(a);
}
const inPath = positional[0] ?? 'collectAlphaGenomes_full.json';
const outPath = positional[1] ?? '../src/data/collectAlphaGenomes.json';

const full = JSON.parse(readFileSync(inPath, 'utf8'));

const byEnc = {};
for (const [enc, e] of Object.entries(full.byEnc)) {
  if (e.lives <= maxLives) byEnc[enc] = e;
}

const genomes = {};
for (const [key, hits] of Object.entries(full.genomes)) {
  const kept = hits.filter(h => h.lives <= maxLives);
  if (kept.length > 0) genomes[key] = kept;
}

const sortedByEnc = Object.fromEntries(Object.entries(byEnc).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const sortedGenomes = Object.fromEntries(Object.entries(genomes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

writeFileSync(outPath, JSON.stringify({ genomes: sortedGenomes, byEnc: sortedByEnc }));

console.log(`max-lives=${maxLives}: kept ${Object.keys(sortedByEnc).length}/${Object.keys(full.byEnc).length} positions, ${Object.keys(sortedGenomes).length}/${Object.keys(full.genomes).length} genome buckets -> ${outPath}`);
