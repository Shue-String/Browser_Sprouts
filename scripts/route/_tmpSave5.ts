import { readFileSync } from 'node:fs';
import { deserializeGameState } from '../../src/model/saveState';
import { recomputeRegions, applyMove } from '../../src/model/moves';
import { encodePosition } from '../../src/model/encoding';
import { canon } from '../../src/engine/stalks';
import { allRoutedMoves } from '../../src/model/moveRouter';
import { strokeCrossesEdges } from '../../src/model/strokeSynthesis';
import { cloneState } from '../../src/model/gameState';
import { smoothStep, resampleAllEdges, resetActivityTimer } from '../../src/model/smooth';
import * as D from '../../src/model/deadRegions';
await canon('0');
const st0 = deserializeGameState(JSON.parse(readFileSync('testSave-5.json', 'utf8'))).state;
recomputeRegions(st0);
const mv = [...allRoutedMoves(st0, 9)].filter(m => new Set([m.v1, m.v2]).has(5) && new Set([m.v1, m.v2]).has(-4) && !strokeCrossesEdges(st0, m.stroke, undefined, m.v1, m.v2))
  .find(m => { const t = cloneState(st0); applyMove(t, m); return encodePosition(t).text === '[0,2]'; })!;
const st = st0; applyMove(st, mv);
const real = (s: any) => [...s.vertices.values()].filter((v: any) => !v.isPseudo).map((v: any) => v.id).sort((a: number, b: number) => a - b).join(',');
let last = real(st);
const log = (where: string) => { const r = real(st); if (r !== last) { console.log(`${where}: [${last}] -> [${r}]`); last = r; } };
console.log('after move', last, encodePosition(st).text);
resampleAllEdges(st);
const louse0 = D.detectLouse(st);
D.scabAloneCollapse(st, louse0 ? new Set(louse0.outer) : undefined); log('commit/scabAlone');
while (D.eliminateIsolatedVertex(st) !== null) log('commit/eliminateIsolated');
let MAXC = 0;
const det = () => D.detectLouse(st) ?? D.detectParallelDead(st) ?? D.detectTripleParallelDead(st) ?? D.detectTriangleDead(st) ?? D.detectEnclosedTriangle(st) ?? D.detectQuadDead(st) ?? D.detectBigonTip(st) ?? D.detectSelfConnectedDead(st);
let pending: any = det();
console.log('pending', pending?.kind, JSON.stringify(pending, (k, v) => k === 'deflate' ? undefined : v));
const verts = (c: any): Set<number> => c.kind === 'louse' ? new Set([...c.outer, c.inner]) : c.kind === 'parallel-dead' || c.kind === 'triple-parallel-dead' ? new Set([c.p, c.q]) : c.kind === 'quad-dead' ? new Set([c.a, c.b, c.c, c.d]) : c.kind === 'bigon-tip' ? new Set([c.w, c.a]) : c.kind === 'self-connected-dead' ? new Set([c.s, c.t]) : new Set([c.a, c.b, c.c]);
const steps: any = { louse: D.louseCollapseStep, 'parallel-dead': D.parallelDeadStep, 'triple-parallel-dead': D.tripleParallelDeadStep, 'triangle-dead': D.triangleDeadStep, 'quad-dead': D.quadDeadStep, 'enclosed-triangle': D.enclosedTriangleStep, 'bigon-tip': D.bigonTipStep, 'self-connected-dead': D.selfConnectedDeadStep };
resetActivityTimer(3000);
for (let f = 0; f < 600; f++) {
  smoothStep(st, true, pending ? verts(pending) : undefined);
  const ls = process.env.SKIPALL && pending ? verts(pending) : pending?.kind === "louse" ? new Set(pending.outer as number[]) : undefined;
  if (!(process.env.NOSCAB && pending) && D.scabAloneCollapse(st, ls)) { log(`f${f} scabAloneCollapse`); if (pending?.kind === 'louse' && (!st.vertices.has(pending.outer[0]) || !st.vertices.has(pending.outer[1]))) pending = null; if (!pending) { pending = det(); if (pending) console.log(`f${f} pending`, pending.kind); } }
  const skip = pending ? verts(pending) : undefined;
  let iso = false; while (D.eliminateIsolatedVertex(st, skip) !== null) { log(`f${f} eliminateIsolated`); iso = true; }
  if (iso) { resampleAllEdges(st); if (!pending) { pending = det(); if (pending) console.log(`f${f} pending`, pending.kind); } }
  const r = D.deadRegionStep(st, skip); if (r.popped) { log(`f${f} deadRegionStep POP`); resampleAllEdges(st); if (!pending) pending = det(); }
  if (pending) { const { done } = steps[pending.kind](st, pending); log(`f${f} ${pending.kind}Step`); if (done) { console.log(`f${f} ${pending.kind} done`); resampleAllEdges(st); pending = det(); if (pending) console.log(`f${f} pending`, pending.kind); } }
}
console.log('final', real(st), encodePosition(st).text);
