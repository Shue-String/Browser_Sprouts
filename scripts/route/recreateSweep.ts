/**
 * Record/replay sweep: plays random games (router moves), records each move code exactly as live
 * play does, replays the sequence through Recreate (synthesizeMove, crossing-checked) and compares
 * the CANON after every move — a token can match while the position diverges. Prints per-game
 * outcome (faithful / DIVERGED at n / stuck at n, with the move kind) and a tally.
 *
 *   npx esbuild scripts/route/recreateSweep.ts --bundle --platform=node --format=esm --outfile=<tmp>/w.mjs
 *   NO_MAIN=1 [LABELS=1] [SHOW=1] [DUMP=<game>:<move>] node <tmp>/w.mjs <games> <maxSpots> <seed>
 *
 * SAVE_DIR=<dir> writes each game that is not faithful as a loadable save (the recorded game, as played
 * live) named sweep-s<seed>-g<game>-<stuck|diverged>-m<move>.json, plus a -before.json of the recorded
 * position just before that move.
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
import { recomputeSpotLabels, labelForFromMap, spotGroupForFromMap, resolveLabelledMove } from '../../src/model/vertexLabels';
import { relax } from './routeHarness';
import { smoothStep, resampleAllEdges, resetActivityTimer } from '../../src/model/smooth';
import { tunables } from '../../src/model/tunables';
import { writeFileSync, mkdirSync } from 'node:fs';
import { serializeGameState } from '../../src/model/saveState';
import type { HistoryStepInput } from '../../src/model/saveState';
import type { RotationMatrix } from '../../src/math/sphere';
const IDENTITY: RotationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
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
  const history: HistoryStepInput[] = [];
  for (let m = 0; m < 3 * spots; m++) {
    const opts = [...allRoutedMoves(st, 4)].filter(mv => !strokeCrossesEdges(st, mv.stroke));
    if (opts.length === 0) break;
    const pick = opts[Math.floor(rnd() * opts.length)];
    const before = cloneState(st);
    try { applyMove(st, { v1: pick.v1, v2: pick.v2, stroke: pick.stroke.map(q => ({ ...q })) }); } catch { break; }
    history.push({ state: before, committed: { v1: pick.v1, v2: pick.v2, rawStroke: pick.stroke.map(q => ({ ...q })) } });
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
    if (LBL) parsed = resolveLabelledMove(mv, rp.spotLabels);
    else parsed = { ...mv, brackets: mv.brackets as number[] | null, parens: mv.parens as ResolvedMove['parens'] };
    let stroke = synthesizeMove(rp, parsed, LBL);
    // Mirror runRecreate's no-candidate retry: re-arm the forces and relax ~recreateRetrySettleMs
    // of 60 fps frames before giving up.
    for (let retry = 0; !stroke && retry < tunables.recreateRetries; retry++) {
      resetActivityTimer(tunables.recreateRetrySettleMs);
      for (let k = 0; k < Math.round(tunables.recreateRetrySettleMs * 0.06); k++) if (!smoothStep(rp)) break;
      resampleAllEdges(rp);
      stroke = synthesizeMove(rp, parsed, LBL);
      if (stroke) bump('rescued by retry');
    }
    const rpBefore = LBL ? cloneState(rp) : null;
    if (!stroke) { result = `stuck at ${i + 1} (${kinds[i]}) ${tokens[i]}`; break; }
    applyMove(rp, { v1: parsed.lo, v2: parsed.hi, stroke });
    if (rpBefore) rp.spotLabels = recomputeSpotLabels(rpBefore.spotLabels, rpBefore, rp, parsed.lo, parsed.hi);
    if ((await tc(rp)) !== canons[i]) { if (process.env.SHOW && result === 'faithful') { const show = (n: string, x: GameState) => { console.log('   ' + n); for (const r of x.regions.values()) if (!r.isDead) console.log('     R' + r.id, r.boundaries.map(b => b.entries.filter(e => !x.vertices.get(e.vertexId)?.isPseudo).map(e => e.vertexId).join(' ')).join(' | ')); }; show('recorded', states[i]); show('replay ' + await tc(rp) + ' vs ' + canons[i], rp); } result = `DIVERGED at ${i + 1} (${kinds[i]}) ${tokens[i]}`; break; }
    relax(rp);
  }
  bump(result.startsWith('faithful') ? 'faithful' : result.split(' at ')[0] + ' ' + result.match(/\((.*?)\)/)![1]);
  if (process.env.SAVE_DIR && result !== 'faithful') {
    mkdirSync(process.env.SAVE_DIR, { recursive: true });
    const m = result.match(/^(stuck|DIVERGED) at (\d+)/)!;
    writeFileSync(`${process.env.SAVE_DIR}/sweep-s${seed}-g${g}-${m[1].toLowerCase()}-m${m[2]}.json`, JSON.stringify(serializeGameState(st, IDENTITY, spots, tokens, null, history)));
    // The recorded game as it stood just before the failing move: the position Recreate had to reproduce
    // from, with the history trimmed to match (load it and play the failing move yourself).
    const n = Number(m[2]) - 1;
    writeFileSync(`${process.env.SAVE_DIR}/sweep-s${seed}-g${g}-${m[1].toLowerCase()}-m${m[2]}-before.json`, JSON.stringify(serializeGameState(history[n].state, IDENTITY, spots, tokens.slice(0, n), null, history.slice(0, n))));
  }
  console.log(`g${g} ${spots} spots, ${tokens.length} moves: ${result}`);
}
console.log(JSON.stringify(tally, null, 1));
