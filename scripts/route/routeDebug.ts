/**
 * Renders one routing attempt to PNG: walls, face mesh, per-point IN/OUT labels, mixed boundary
 * chords and the traced frontier — for seeing why moveRouter.ts failed on a case dumped by
 * routeHarness.ts (DUMP="g0 m3 c7" DUMP_FILE=case.json). Azimuthal-equidistant projection
 * centered on the move's first endpoint.
 *
 *   npx esbuild scripts/route/routeDebug.ts --bundle --platform=node --format=esm --outfile=<tmp>/d.mjs
 *   node <tmp>/d.mjs case.json <outPrefix> [viewRadiusRadians=3.2]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { SpherePoint } from '../../src/math/sphere';
import { slerp } from '../../src/math/sphere';
import { loadState } from './routeHarness';
import { buildFaceMesh, routeOnMesh, routeSpecsFor } from '../../src/model/moveRouter';
import type { RouteDiag } from '../../src/model/moveRouter';
import { Raster } from './rasterPng';
import { cloneState } from '../../src/model/gameState';
import { applyMove } from '../../src/model/moves';
import { encodePositionDecompressed } from '../../src/model/encoding';
import { canon } from '../../src/engine/stalks';
import { strokeCrossesEdges } from '../../src/model/strokeSynthesis';

type RGB = [number, number, number];
const hex = (h: string): RGB => { const v = h.length === 4 ? h.slice(1).split('').map(c => parseInt(c + c, 16)) : [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return v as RGB; };

const [file, prefix, viewArg] = process.argv.slice(2);
const view = Number(viewArg ?? 3.2);
const d = JSON.parse(readFileSync(file, 'utf8'));
const state = loadState(d.state);
const center = state.vertices.get(process.env.CENTER ? Number(process.env.CENTER) : d.parsed.lo)!.pos;

// Azimuthal equidistant around `center`.
const ref = Math.abs(center.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
const dotp = (a: SpherePoint, b: SpherePoint): number => a.x * b.x + a.y * b.y + a.z * b.z;
const crossp = (a: SpherePoint, b: SpherePoint): SpherePoint => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const e1 = (() => { const t = { x: ref.x - dotp(ref, center) * center.x, y: ref.y - dotp(ref, center) * center.y, z: ref.z - dotp(ref, center) * center.z }; const l = Math.hypot(t.x, t.y, t.z); return { x: t.x / l, y: t.y / l, z: t.z / l }; })();
const e2 = crossp(center, e1);
const SIZE = 1000;
const proj = (p: SpherePoint): [number, number] => {
  const th = Math.acos(Math.max(-1, Math.min(1, dotp(p, center))));
  const a = dotp(p, e1), b = dotp(p, e2);
  const l = Math.hypot(a, b) || 1;
  const r = (th / view) * (SIZE / 2);
  return [SIZE / 2 + (r * a) / l, SIZE / 2 - (r * b) / l];
};
const visible = (p: SpherePoint): boolean => Math.acos(Math.max(-1, Math.min(1, dotp(p, center)))) < view;
let img = new Raster(SIZE, SIZE);
const line = (a: SpherePoint, b: SpherePoint, style: string): string => {
  // Long segments: draw in pieces so a zoomed view still shows the part inside it.
  const span = Math.acos(Math.max(-1, Math.min(1, dotp(a, b))));
  if (span > view / 50) {
    const n = Math.min(400, Math.ceil(span / (view / 50)));
    for (let i = 0; i < n; i++) line(slerp(a, b, i / n), slerp(a, b, (i + 1) / n), style);
    return '';
  }
  if (!visible(a) || !visible(b)) return '';
  const [x1, y1] = proj(a), [x2, y2] = proj(b);
  const col = hex(/stroke:(#[0-9a-f]+)/.exec(style)![1]);
  const w = Number(/stroke-width:([0-9.]+)/.exec(style)![1]);
  img.line(x1, y1, x2, y2, w, col);
  return '';
};
const dotSvg = (p: SpherePoint, r: number, fill: string): string => {
  if (!visible(p)) return '';
  const [x, y] = proj(p);
  img.disc(x, y, r, hex(fill));
  return '';
};

let idx = 0;
for (const { region, specs } of routeSpecsFor(state, d.parsed)) {
  const mesh = buildFaceMesh(state, region);
  for (const spec of specs) {
    const diag: RouteDiag = {};
    const stroke = routeOnMesh(mesh, spec, diag);
    img = new Raster(SIZE, SIZE);
    const parts: string[] = [];
    const clean = !!process.env.CLEAN;
    if (!clean) for (const [u, v] of mesh.tris.flatMap(t => [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]])) parts.push(line(mesh.pts[u], mesh.pts[v], 'stroke:#ddd;stroke-width:0.5'));
    for (const e of state.edges.values()) for (let i = 0; i + 1 < e.points.length; i++) parts.push(line(e.points[i], e.points[i + 1], 'stroke:#000;stroke-width:1.5'));
    if (diag.label && !clean) {
      for (const [key, ts] of mesh.edgeTris) {
        const N = mesh.pts.length, u = Math.floor(key / N), v = key % N;
        if (ts.length === 1 && diag.label[u] !== diag.label[v]) parts.push(line(mesh.pts[u], mesh.pts[v], 'stroke:#0a0;stroke-width:4'));
      }
    }
    if (!clean) mesh.pts.forEach((p, i) => {
      const lab = diag.label ? diag.label[i] : -1;
      const col = lab === 1 ? (mesh.tags[i] ? '#d00' : '#f99') : lab === 0 ? (mesh.tags[i] ? '#00d' : '#99f') : (mesh.tags[i] ? '#555' : '#bbb');
      parts.push(dotSvg(p, mesh.tags[i] ? 2.2 : 1.5, col));
    });
    const path = stroke ?? diag.trace;
    if (path) for (let i = 0; i + 1 < path.length; i++) parts.push(line(path[i], path[i + 1], `stroke:${stroke ? '#f80' : '#a0a'};stroke-width:2.5`));
    const labels: string[] = [];
    for (const v of state.vertices.values()) if (!v.isPseudo) {
      parts.push(dotSvg(v.pos, v.id === d.parsed.lo || v.id === d.parsed.hi ? 6 : 3.5, '#000'));
      if (visible(v.pos)) labels.push(`${v.id}@${proj(v.pos).map(z => z.toFixed(0)).join(',')}`);
    }
    const title = `${spec.kind} a=${JSON.stringify(spec.a)} c=${JSON.stringify(spec.c)} ${spec.kind === 'split' ? 'withArc=' + JSON.stringify([...spec.withArc]) : ''} -> ${stroke ? 'OK' : 'FAIL: ' + (diag.failure ?? '?')}`;
    let result = '';
    if (stroke) {
      const v1 = d.parsed.lo, v2 = d.parsed.hi;
      const crosses = strokeCrossesEdges(state, stroke, undefined, v1, v2);
      const trial = cloneState(state);
      try {
        applyMove(trial, { v1, v2, stroke });
        const c = await canon(encodePositionDecompressed(trial).text);
        result = ` => ${c}${c === d.targetCanon ? ' (TARGET)' : ''}${crosses ? ' [crosses!]' : ''}`;
      } catch (e) { result = ` => applyMove threw ${e}`; }
    }
    const out = `${prefix}-${idx++}.png`;
    writeFileSync(out, img.png());
    console.log(out.split(/[\/]/).pop(), title + result, '| target', d.targetCanon, '| vertices:', labels.join(' '));
  }
}
