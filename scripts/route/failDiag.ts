/** Dumps one failureSaves/*.json position and why the router can't draw its failing children.
 *  npx esbuild scripts/route/failDiag.ts --bundle --platform=node --format=esm --outfile=<tmp>/d.mjs
 *  NO_MAIN=1 node <tmp>/d.mjs failureSaves/fail-g13-m5.json */
import { readFileSync } from 'node:fs';
import { deserializeGameState } from '../../src/model/saveState';
import { recomputeRegions } from '../../src/model/moves';
import { encodePosition } from '../../src/model/encoding';
import { analyze, canon, canonFull, MoveKind } from '../../src/engine/stalks';
import { routeSpecsFor, faceMeshFor, routeOnMesh } from '../../src/model/moveRouter';
import { enumerateAll, parsedFor } from './routeHarness';

const st = deserializeGameState(JSON.parse(readFileSync(process.argv[2], 'utf8'))).state;
recomputeRegions(st);
console.log('position', encodePosition(st).text);
for (const v of st.vertices.values()) console.log(`  v${v.id} deg ${v.degree}${v.isPseudo ? ' pseudo' : ''} (${v.pos.x.toFixed(3)},${v.pos.y.toFixed(3)},${v.pos.z.toFixed(3)})`);
for (const e of st.edges.values()) console.log(`  e${e.id} ${e.v1}-${e.v2} pts ${e.points.length}`);
for (const r of st.regions.values()) if (!r.isDead) console.log(`  R${r.id}${r.isOuter ? '*' : ''}`, r.boundaries.map(b => b.entries.map(e => e.vertexId + (e.side === 'firstVisit' ? 'a' : e.side === 'secondVisit' ? 'b' : '')).join(' ')).join(' | '));
const reach = await enumerateAll(st);
import { encodePositionDecompressed } from '../../src/model/encoding';
const res = await analyze(process.env.DECOMP ? encodePositionDecompressed(st).text : encodePosition(st).text);
for (const c of (res.children ?? []).filter(c => c.move && c.move.kind !== MoveKind.InteriorPseudo)) {
  const tc = await canon(c.enc);
  if (reach.has(tc)) continue;
  // DisaPoint twin: some DRAWABLE child has the same compact (compressed) canon but a different exact one.
  const compact = await canonFull(tc);
  let twin = '';
  for (const k of reach.keys()) if (k !== tc && (await canonFull(k)) === compact) { twin = k; break; }
  console.log(twin ? `TWIN child ${tc} (drawable twin: ${twin})` : `NON-TWIN child ${tc}`);
  const p = parsedFor(st, c);
  console.log('FAILING child', tc, 'move', JSON.stringify(c.move), '-> parsed', p && { lo: p.lo, hi: p.hi, brackets: p.brackets });
  if (!p) continue;
  for (const { region, specs } of routeSpecsFor(st, p)) {
    const mesh = faceMeshFor(st, region);
    console.log(` region R${region.id}: ${specs.length} specs`);
    for (const s of specs) { const r = routeOnMesh(mesh, s); console.log('   spec', JSON.stringify(s, (k, v) => v instanceof Set ? [...v] : v).slice(0, 200), '->', r ? `stroke ${r.length} pts` : 'FAILED'); }
  }
}
if (process.env.MESH) {
  const reg = [...st.regions.values()].find(r => r.id === Number(process.env.MESH))!;
  const mesh = faceMeshFor(st, reg);
  console.log('mesh.ok', mesh.ok, 'pts', mesh.pts.length);
  const tagCount = new Map<string, number>();
  mesh.tags.forEach(t => { if (t) { const k = `${t.kind} b${(t as any).b} k${(t as any).k}`; tagCount.set(k, (tagCount.get(k) ?? 0) + 1); } });
  console.log([...tagCount].map(([k, n]) => `${k}:${n}`).join('\n'));
  console.log('corners', JSON.stringify(mesh.corners.map(c => [c.b, c.k, c.vertexId])));
}
if (process.env.ENDS) {
  const ang = (a: any, b: any) => Math.acos(Math.min(1, a.x*b.x+a.y*b.y+a.z*b.z));
  for (const e of st.edges.values()) {
    const a = st.vertices.get(e.v1)!.pos, b = st.vertices.get(e.v2)!.pos;
    console.log(`e${e.id} ${e.v1}-${e.v2} start-gap ${ang(e.points[0], a).toExponential(2)} end-gap ${ang(e.points[e.points.length-1], b).toExponential(2)}`);
  }
}
