/**
 * Headless Recreate: replays a move sequence the way main.ts runRecreate does (candidateStrokes ->
 * strokeReproduces -> applyMove -> physics relax) and, on a step with no reproducing candidate,
 * prints the move code every candidate stroke produces instead.
 *
 *   npx esbuild scripts/route/recreateReplay.ts --bundle --platform=node --format=esm --outfile=<tmp>/r.mjs
 *   NO_MAIN=1 node <tmp>/r.mjs "6:-1X-1[-2]/..."
 */
import { createInitialState, cloneState } from '../../src/model/gameState';
import { applyMove, recomputeRegions } from '../../src/model/moves';
import { parseMoveSequence, rawResolvedMove } from '../../src/model/moveCodeParse';
import { candidateStrokes, strokeCrossesEdges } from '../../src/model/strokeSynthesis';
import { strokeReproduces } from '../../src/model/recreate';
import { computeMoveCode, computeEnclosureSideColoring } from '../../src/model/moveCode';
import { routedCandidates, routeSpecsFor } from '../../src/model/moveRouter';
import { encodePosition } from '../../src/model/encoding';
import type { GameState } from '../../src/model/types';
import { smoothStep, resampleAllEdges, resetActivityTimer } from '../../src/model/smooth';
import { readFileSync } from 'node:fs';
import { deserializeGameState } from '../../src/model/saveState';
import { encodePositionDecompressed } from '../../src/model/encoding';
import { canon } from '../../src/engine/stalks';
import { relax, edgeCrossings } from './routeHarness';


// SAVE=<file>: compare each replayed position's canon with the saved game's own (catches a replay
// that matches every token yet diverges topologically).
const saved = process.env.SAVE ? deserializeGameState(JSON.parse(readFileSync(process.env.SAVE, 'utf8'))) : null;
const canonOf = async (s: GameState): Promise<string> => { const t = encodePositionDecompressed(s).text; return t === '' ? 'N' : canon(t); };

const seq = parseMoveSequence(process.argv[2]);
const state = createInitialState(seq.spots);
async function main(): Promise<void> {
for (let i = 0; i < seq.moves.length; i++) {
  const m = seq.moves[i];
  const parsed = rawResolvedMove(m);
  const cands = candidateStrokes(state, parsed);
  const rows = cands.map(s => {
    const crosses = strokeCrossesEdges(state, s);
    const ok = strokeReproduces(state, parsed, s, false);
    let code = '(apply failed)';
    try {
      const w = cloneState(state);
      applyMove(w, { v1: parsed.lo, v2: parsed.hi, stroke: s });
      code = computeMoveCode(cloneState(state), parsed.lo, parsed.hi, w);
    } catch (e) { code = `(error: ${(e as Error).message})`; }
    return { s, crosses, ok, code };
  });
  const good = rows.find(r => r.ok && !r.crosses);
  console.log(`move ${i + 1} ${m.token}: ${rows.length} candidates, ${rows.filter(r => r.ok).length} reproduce, ${rows.filter(r => r.ok && !r.crosses).length} legal (reproduce + no crossing)` +
    (good ? '' : `; codes produced: ${[...new Set(rows.map(r => r.code))].join(' | ')}`));
  if (!good) {
    const specs = routeSpecsFor(state, parsed);
    console.log('position:', encodePosition(state).text, '| route specs per region:', specs.map(x => `R${x.region.id}:${x.specs.length}`).join(' '), '| routed strokes:', routedCandidates(state, parsed).length);
    for (const st of routedCandidates(state, parsed)) {
      const w = cloneState(state); applyMove(w, { v1: parsed.lo, v2: parsed.hi, stroke: st });
      const col = computeEnclosureSideColoring(cloneState(state), w, parsed.lo, parsed.hi);
      console.log('  routed stroke -> code', computeMoveCode(cloneState(state), parsed.lo, parsed.hi, w), '| arc side', col && [...col.arcSideVertexIds].join(','), '| other side', col && [...col.otherSideVertexIds].join(','), '| regions after:', [...w.regions.values()].filter(r => !r.isDead).map(r => `R${r.id}[${r.boundaries.map(b => b.entries.map(e => e.vertexId).join(' ')).join('|')}]`).join(' '));
    }
    for (const r of state.regions.values()) if (!r.isDead) console.log(`  R${r.id}${r.isOuter ? '*' : ''}`, r.boundaries.map(b => b.entries.map(e => e.vertexId + (e.side === 'firstVisit' ? 'a' : e.side === 'secondVisit' ? 'b' : '')).join(' ')).join(' | '));
  }
  if (!good) { console.log('edges before:', [...state.edges.values()].map(e => `${e.v1}-${e.v2}`).join(' ')); break; }
  applyMove(state, { v1: parsed.lo, v2: parsed.hi, stroke: good.s });
  console.log('   right after apply: crossings', edgeCrossings(state).join('; ') || 'none');
  if (process.env.TRACE && i + 1 === Number(process.env.TRACE)) {
    // Which phase of the post-commit relax first produces a crossing.
    resampleAllEdges(state);
    console.log('   after resampleEdge:', edgeCrossings(state).join('; ') || 'none');
    resetActivityTimer();
    for (let k = 0; k < 300; k++) {
      const moved = smoothStep(state);
      const c = edgeCrossings(state);
      if (c.length) { console.log(`   smoothStep #${k + 1}: first crossings ${c.join('; ')}`); break; }
      if (!moved) { console.log('   settled with no crossing'); break; }
    }
  }
  if (saved) {
    const ws = i + 1 < saved.history.length ? saved.history[i + 1].state : saved.state; recomputeRegions(ws);
    const want = await canonOf(ws);
    const got = await canonOf(state);
    if (process.env.REGIONS && i + 1 === Number(process.env.REGIONS)) {
      const show = (nm: string, st: GameState) => { console.log(`   ${nm}:`); for (const r of st.regions.values()) if (!r.isDead) console.log(`     R${r.id}${r.isOuter ? '*' : ''}`, r.boundaries.map(b => b.entries.filter(e => e.vertexId > -9000).map(e => e.vertexId).join(' ')).join(' | ')); };
      show('replay', state); show('save', ws);
    }
    console.log(`   position vs save: ${got === want ? 'same' : `DIFFERENT — replay ${got}, save ${want}`}`);
  }
  if (!process.env.NORELAX) relax(state);
  console.log('   after relax: crossings', edgeCrossings(state).join('; ') || 'none');
}
}
if (!process.env.NO_MAIN) void main();
