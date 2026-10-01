// Recomputes every engine-derived genome (collections whose genome has `derived: true` in
// src/data/collectionElements.json -- S_33 onward) by running stalks/tools/genome_for_reps on each
// collection's rep, and rewrites those genomes in place. Hand-authored genomes are never touched.
//
// Derived genomes are a SNAPSHOT of the engine's answer, named in terms of the registry as it stood
// when the native tool was built -- so after ANY registry change (a collection added/merged/renamed,
// an element added) rebuild the native engine first, then run this, then regenerate the headers
// (`npm run gen:headers`).
//
// Usage: node scripts/refreshDerivedGenomes.cjs [path/to/genome_for_reps.exe] [--check]
//   --check: report differences and exit 1 if any, without writing (for verifying a fresh build).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { read, write } = require('./collectionsJson.cjs');

const args = process.argv.slice(2);
const check = args.includes('--check');
const exe = path.resolve(args.find(a => !a.startsWith('--')) ?? path.join(__dirname, '..', 'stalks', 'build', 'genome_for_reps.exe'));

function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}

const nums = s => { const inner = s.trim().slice(1, -1); return inner === '' ? [] : inner.split(',').map(Number); };

// "(R,D,{L},{Z},[T...])" -> structured genome; a T entry is "S_n" / "S_n⊕k" or a nested tuple.
function parseGenome(text) {
  const t = text.trim();
  if (!t.startsWith('(')) throw new Error(`unparseable genome: ${t}`);
  const p = splitTop(t.slice(1, -1));
  if (p.length !== 5) throw new Error(`expected 5 genome parts, got ${p.length}: ${t}`);
  const T = splitTop(p[4].trim().slice(1, -1)).map(x => {
    x = x.trim();
    if (x.startsWith('(')) return parseGenome(x);
    const m = x.match(/^(.+?)(?:⊕(\d+))?$/);
    return m[2] ? { name: m[1], shift: Number(m[2]) } : { name: m[1] };
  });
  return { R: Number(p[0]), D: Number(p[1]), L: nums(p[2]), Z: nums(p[3]), T };
}

const data = read();
const derived = data.collections.filter(c => c.genome && c.genome.derived);
const repOf = c => c.rep;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-genomes-'));
const targets = path.join(tmp, 'targets.txt');
const out = path.join(tmp, 'out.tsv');
fs.writeFileSync(targets, derived.map(repOf).join('\n') + '\n');
execFileSync(exe, [targets, out], { stdio: ['ignore', 'ignore', 'inherit'] });

const byRep = new Map(fs.readFileSync(out, 'utf8').trim().split('\n').slice(1).map(l => l.split('\t')));
let changed = 0;
for (const c of derived) {
  const text = byRep.get(repOf(c));
  if (text === undefined) throw new Error(`no genome computed for ${c.name} (rep ${repOf(c)})`);
  if (text.includes('UNCLASSIFIABLE') || text.includes('TOO LARGE')) throw new Error(`${c.name}: ${text}`);
  const fresh = { ...parseGenome(text), derived: true };
  if (JSON.stringify(fresh) !== JSON.stringify(c.genome)) {
    changed++;
    if (!check) c.genome = fresh;
  }
}
console.log(`refreshDerivedGenomes: ${derived.length} derived genomes, ${changed} ${check ? 'differ from' : 'updated in'} collectionElements.json.`);
if (check) process.exit(changed ? 1 : 0);
if (changed) {
  write(data);
  console.log('Now run `npm run gen:headers` to regenerate collectionGenomes.generated.json.');
}
