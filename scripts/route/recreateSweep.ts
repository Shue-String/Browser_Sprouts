/**
 * Record/replay sweep: plays random games (router moves), records each move code exactly as live
 * play does, replays the sequence through Recreate (synthesizeMove, crossing-checked) and compares
 * the CANON after every move — a token can match while the position diverges. Prints per-game
 * outcome (faithful / DIVERGED at n / stuck at n, with the move kind) and a tally.
 *
 *   npx esbuild scripts/route/recreateSweep.ts --bundle --platform=node --format=esm --outfile=<tmp>/w.mjs
 *   NO_MAIN=1 [LABELS=1] [SHOW=1] [DUMP=<game>:<move>] node <tmp>/w.mjs <games> <maxSpots> <seed>
 *
 * LABELS=1 records/replays labelled ("nL:") codes like the app; SHOW=1 prints recorded vs replayed
 * regions at the first divergence; DUMP prints the move-region analysis for one recorded move.
 */
import type { GameState } from '../../src/model/types';
import { createInitialState, cloneState } from '../../src/model/gameState';
import { applyMove } from '../../src/model/moves';
import { encodePositionDecompressed } from '../../src/model/encoding';
import { canon } from '../../src/engine/stalks';
import { computeMoveCode, findMoveRegion, findEnclosedSideRegion } from '../../src/model/moveCode';
import { parseMoveSequence } from '../../src/model/moveCodeParse';
import type { ResolvedMove } from '../../src/model/moveCodeParse';
import { synthesizeMove } from '../../src/model/recreate';
import { strokeCrossesEdges } from '../../src/model/strokeSynthesis';
import { allRoutedMoves } from '../../src/model/moveRouter';
import { recomputeSpotLabels, labelForFromMap, spotGroupForFromMap, resolveMoveEndpoints, resolveBracketEntry, resolveParensEntry } from '../../src/model/vertexLabels';
import { relax } from './routeHarness';
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const tc = async (s: GameState) => { const t = encodePositionDecompressed(s).text; return t === '' ? 'N' : canon(t); };
const kind = (before: GameState, v1: number, v2: number) => v1 !== v2 ? 'join/split' : `self-loop deg${before.vertices.get(v1)!.degree}`;
const [games, maxSpots, seed] = process.argv.slice(2).map(Number);
const LBL = !!process.env.LABELS;
const rnd = mulberry32(seed);
const tally: Record<string, number> = {};
const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
for (let g = 0; g < games; g++) {
  const spots = 2 + Math.floor(rnd() * (maxSpots - 1));
  const st = createInitialState(spots);
  const tokens: string[] = [], canons: string[] = [], kinds: string[] = [], states: GameState[] = [];
  for (let m = 0; m < 3 * spots; m++) {
    const opts = [...allRoutedMoves(st, 4)].filter(mv => !strokeCrossesEdges(st, mv.stroke, undefined, mv.v1, mv.v2));
    if (opts.length === 0) break;
    const pick = opts[Math.floor(rnd() * opts.length)];
    const before = cloneState(st);
    try { applyMove(st, { v1: pick.v1, v2: pick.v2, stroke: pick.stroke.map(q => ({ ...q })) }); } catch { break; }
    if (process.env.DUMP === `${g}:${m + 1}`) {
      const showB = (x: GameState, r: any) => r.boundaries.map((b: any) => b.entries.map((e: any) => e.vertexId).join(' ')).join(' | ');
      const nv = [...st.vertices.keys()].filter(v => !before.vertices.has(v) && !st.vertices.get(v)!.isPseudo);
      console.log('DUMP move', pick.v1, pick.v2, 'deg before', before.vertices.get(pick.v1)?.degree, 'new verts', nv, 'raw code', computeMoveCode(before, pick.v1, pick.v2, st));
      for (const r of before.regions.values()) if (!r.isDead) console.log('  before R' + r.id, showB(before, r));
      for (const r of st.regions.values()) if (!r.isDead) console.log('  after  R' + r.id, showB(st, r));
      const f = findMoveRegion(before, st, pick.v1, pick.v2, nv[0] ?? null);
      console.log('  regionR', f && 'R' + f.regionR.id, f && showB(before, f.regionR), 'mainComp', f && f.mainComp.entries.map(e => e.vertexId).join(' '));
      if (f) { const r = findEnclosedSideRegion(f.regionR, f.mainComp, pick.v1, pick.v1, before, st, null, null); console.log('  enclosed side', r && 'R' + r.id); }
    }
    if (LBL) { st.spotLabels = recomputeSpotLabels(before.spotLabels, before, st, pick.v1, pick.v2); tokens.push(computeMoveCode(before, pick.v1, pick.v2, st, labelForFromMap(st.spotLabels), spotGroupForFromMap(st.spotLabels))); }
    else tokens.push(computeMoveCode(before, pick.v1, pick.v2, st)); kinds.push(kind(before, pick.v1, pick.v2));
    canons.push(await tc(st)); states.push(cloneState(st));
    relax(st);
  }
  for (const k of kinds) bump(`played ${k}`);
  // Replay.
  const seq = parseMoveSequence(`${spots}${LBL ? 'L' : ''}:${tokens.join('/')}`);
  const rp = createInitialState(spots);
  let result = 'faithful';
  for (let i = 0; i < seq.moves.length; i++) {
    const mv = seq.moves[i];
    let parsed: ResolvedMove;
    if (LBL) {
      const { lo, hi, contextLabels } = resolveMoveEndpoints(mv.lo, mv.hi, rp.spotLabels);
      parsed = { ...mv, lo, hi, brackets: mv.brackets ? mv.brackets.flatMap(e => resolveBracketEntry(e, contextLabels)) : null, parens: resolveParensEntry(mv.parens, contextLabels) };
    } else parsed = { ...mv, brackets: mv.brackets as number[] | null, parens: mv.parens as ResolvedMove['parens'] };
    const stroke = synthesizeMove(rp, parsed, true, LBL);
    const rpBefore = LBL ? cloneState(rp) : null;
    if (!stroke) { result = `stuck at ${i + 1} (${kinds[i]}) ${tokens[i]}`; break; }
    applyMove(rp, { v1: parsed.lo, v2: parsed.hi, stroke });
    if (rpBefore) rp.spotLabels = recomputeSpotLabels(rpBefore.spotLabels, rpBefore, rp, parsed.lo, parsed.hi);
    if ((await tc(rp)) !== canons[i]) { if (process.env.SHOW && result === 'faithful') { const show = (n: string, x: GameState) => { console.log('   ' + n); for (const r of x.regions.values()) if (!r.isDead) console.log('     R' + r.id, r.boundaries.map(b => b.entries.filter(e => !x.vertices.get(e.vertexId)?.isPseudo).map(e => e.vertexId).join(' ')).join(' | ')); }; show('recorded', states[i]); show('replay ' + await tc(rp) + ' vs ' + canons[i], rp); } result = `DIVERGED at ${i + 1} (${kinds[i]}) ${tokens[i]}`; break; }
    relax(rp);
  }
  bump(result.startsWith('faithful') ? 'faithful' : result.split(' at ')[0] + ' ' + result.match(/\((.*?)\)/)![1]);
  console.log(`g${g} ${spots} spots, ${tokens.length} moves: ${result}`);
}
console.log(JSON.stringify(tally, null, 1));
