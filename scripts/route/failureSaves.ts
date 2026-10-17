/**
 * Writes loadable save files (Load button) for positions where some engine child can't be drawn,
 * plus <outDir>/REPORT.md listing which children fail and what gets drawn instead.
 *
 * Each position is tested exactly as the app will see it after Load: serialize -> deserialize ->
 * recomputeRegions -> layout relax. A child counts as failing when no router reading of the position reaches it
 * (moveRouter allRoutedMoves, i.e. what the Position Browser's background pass can find).
 *
 *   npx esbuild scripts/route/failureSaves.ts --bundle --platform=node --format=esm --outfile=<tmp>/f.mjs
 *   NO_MAIN=1 node <tmp>/f.mjs [games=25] [maxSpots=7] [seeds=4,5] [outDir=failureSaves]
 *
 * Each save's report entry also says whether Recreate (synthesizeMove, as the app runs it) can
 * replay the game's own move sequence back to that position.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import type { GameState } from '../../src/model/types';
import type { SpherePoint, RotationMatrix } from '../../src/math/sphere';
import { createInitialState, cloneState } from '../../src/model/gameState';
import { applyMove, recomputeRegions } from '../../src/model/moves';
import { encodePosition, encodePositionDecompressed } from '../../src/model/encoding';
import { analyze, canon, canonFull, MoveKind } from '../../src/engine/stalks';
import type { ChildInfo } from '../../src/engine/stalks';
import { recomputeSpotLabels, labelledMoveCode, resolveLabelledMove } from '../../src/model/vertexLabels';
import { parseMoveSequence } from '../../src/model/moveCodeParse';
import type { ResolvedMove } from '../../src/model/moveCodeParse';
import { synthesizeMove } from '../../src/model/recreate';
import { serializeGameState, deserializeGameState } from '../../src/model/saveState';
import type { HistoryStepInput } from '../../src/model/saveState';
import { strokeCrossesEdges } from '../../src/model/strokeSynthesis';
import { routeSpecsFor, faceMeshFor, routeOnMesh } from '../../src/model/moveRouter';
import type { RouteSpec } from '../../src/model/moveRouter';
import { enumerateAll, relax, parsedFor, edgeCrossings } from './routeHarness';

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as unknown as RotationMatrix;

async function trialCanon(s: GameState): Promise<string> {
  const t = encodePositionDecompressed(s).text;
  return t === '' ? 'N' : canon(t);
}

/** Exact canon, plus canonFull's compact spelling when it differs — the compact form merges
 *  positions that differ only by DisaPoint ('3') compression, so it can't show the difference. */
async function pretty(enc: string): Promise<string> {
  const exact = enc === 'N' ? 'N' : await canon(enc);
  const compact = exact === 'N' ? 'N' : await canonFull(exact);
  return compact && compact !== exact ? `${exact} (compact ${compact})` : exact;
}


function describeMove(c: ChildInfo): string {
  const mv = c.move!;
  return mv.kind === MoveKind.Enclosure
    ? `Enclosure comp ${mv.component} region ${mv.region} boundary ${mv.boundary} tokens ${mv.i}→${mv.j} mask ${mv.mask}`
    : `Join comp ${mv.component} region ${mv.region} boundary ${mv.b1} token ${mv.i} → boundary ${mv.b2} token ${mv.j}`;
}

/** Replays a labelled ("nL:") move sequence through Recreate's synthesizeMove, as the app does; the
 *  0-based index of the first move it can't reproduce, or -1 when every move replays. */
function recreateStopsAt(seqText: string): number {
  const seq = parseMoveSequence(seqText);
  const st = createInitialState(seq.spots);
  for (let i = 0; i < seq.moves.length; i++) {
    const parsed: ResolvedMove = resolveLabelledMove(seq.moves[i], st.spotLabels);
    const stroke = synthesizeMove(st, parsed, true);
    if (!stroke) return i;
    const before = cloneState(st);
    applyMove(st, { v1: parsed.lo, v2: parsed.hi, stroke });
    st.spotLabels = recomputeSpotLabels(before.spotLabels, before, st, parsed.lo, parsed.hi);
    relax(st);
  }
  return -1;
}

/** Every partition reading of the specs between one endpoint pair. */
function expandSpecs(specs: RouteSpec[], boundaryCount: number): RouteSpec[] {
  const out = new Map<string, RouteSpec>();
  for (const s of specs) {
    if (s.kind === 'join') { out.set(JSON.stringify([s.a, s.c]), s); continue; }
    const rest = [...Array(boundaryCount).keys()].filter(x => x !== s.a.b);
    if (rest.length > 7) { out.set(JSON.stringify([s.a, s.c, [...s.withArc]]), s); continue; }
    for (let mask = 0; mask < 1 << rest.length; mask++) {
      const withArc = new Set(rest.filter((_, t) => (mask >> t) & 1));
      out.set(JSON.stringify([s.a, s.c, [...withArc]]), { ...s, withArc });
    }
  }
  return [...out.values()];
}

async function main(): Promise<void> {
  const [gamesArg, maxSpotsArg, seedsArg, outArg] = process.argv.slice(2);
  const games = Number(gamesArg ?? 25);
  const maxSpots = Number(maxSpotsArg ?? 7);
  const seeds = (seedsArg ?? '4,5').split(',').map(Number);
  const outDir = outArg ?? 'failureSaves';
  mkdirSync(outDir, { recursive: true });
  const report: string[] = [];
  let saves = 0, positions = 0, childrenTotal = 0, childrenFailed = 0, brokenDrawings = 0;

  for (const seed of seeds) {
    Math.random = mulberry32(seed);
    for (let g = 0; g < games; g++) {
      const spots = 2 + Math.floor(Math.random() * (maxSpots - 1));
      const state = createInitialState(spots);
      const history: HistoryStepInput[] = [];
      const tokens: string[] = [];
      for (let m = 0; m < 3 * spots; m++) {
        // The position exactly as Load will rebuild it.
        const save = serializeGameState(state, IDENTITY, spots, tokens, null, history);
        const raw = deserializeGameState(save).state;
        recomputeRegions(raw);
        // The app lets the layout physics settle after Load before anything is hovered or routed, and the
        // router needs that room (on the raw geometry most children look undrawable) � so test the settled one.
        const loaded = cloneState(raw);
        relax(loaded);
        recomputeRegions(loaded);
        const res = await analyze(encodePositionDecompressed(loaded).text || 'N'); // the Position Browser's analysis text (see main.ts liveAnalysisText)
        const children = (res.children ?? []).filter(c => c.move && c.move.kind !== MoveKind.InteriorPseudo);
        if (children.length === 0) break;
        positions++;
        const reach = await enumerateAll(loaded);
        const failing: ChildInfo[] = [];
        const seen = new Set<string>();
        for (const c of children) {
          const tc = await canon(c.enc);
          if (seen.has(tc)) continue;
          seen.add(tc);
          childrenTotal++;
          if (!reach.has(tc)) failing.push(c);
        }
  
        if (failing.length > 0) {
          childrenFailed += failing.length;
          const name = `fail-s${seed}-g${g}-m${m}.json`;
          writeFileSync(`${outDir}/${name}`, JSON.stringify(save));
          saves++;
          const crossings = edgeCrossings(loaded);
          if (crossings.length) brokenDrawings++;
          report.push(`## ${name}`, '');
          report.push(`Position \`${encodePosition(loaded).text}\` — ${spots} spots, ${m} moves played  `);
          const seqText = `${spots}L:${tokens.join('/')}`;
          const stop = tokens.length ? recreateStopsAt(seqText) : -1;
          report.push(`Move sequence: \`${seqText}\` — Recreate replays it: ${stop < 0 ? 'yes, all moves' : `**no, stops at move ${stop + 1}** (\`${tokens[stop]}\`)`}`, '');
          if (crossings.length) {
            report.push(`**This drawing already has crossing edges** (layout-physics bug — no stroke near them can be legal): ${crossings.slice(0, 4).join('; ')}`, '');
          }
          for (const c of failing) {
            report.push(`- **${await pretty(c.enc)}** — engine move: ${describeMove(c)}`);
            const p = parsedFor(loaded, c);
            if (!p) { report.push('  - hover couldn\'t translate this move to live vertices'); continue; }
            const deg = (v: number): number => loaded.vertices.get(v)?.degree ?? 9;
            const legal = p.lo === p.hi ? deg(p.lo) <= 1 : deg(p.lo) <= 2 && deg(p.hi) <= 2;
            const ends = p.lo === p.hi ? `self-loop at vertex ${p.lo}` : `vertex ${p.lo} → vertex ${p.hi}`;
            const br = p.brackets ? `; bracketed (lo→hi side) boundaries containing [${p.brackets.join(', ')}]` : '';
            report.push(`  - hover's translation: ${ends}${br}${legal ? '' : ' — **illegal for those vertices, so the translation itself is wrong**'}`);
            if (!legal) continue;
            // What every router reading between those endpoints actually produces.
            const outcomes = new Map<string, number>();
            let routeFails = 0, crossing = 0;
            for (const { region, specs } of routeSpecsFor(loaded, p)) {
              const mesh = faceMeshFor(loaded, region);
              for (const s of expandSpecs(specs, region.boundaries.length)) {
                const stroke = routeOnMesh(mesh, s);
                if (!stroke) { routeFails++; continue; }
                if (strokeCrossesEdges(loaded, stroke)) { crossing++; continue; }
                const t = cloneState(loaded);
                try { applyMove(t, { v1: p.lo, v2: p.hi, stroke }); } catch { continue; }
                const got = await pretty(await trialCanon(t));
                outcomes.set(got, (outcomes.get(got) ?? 0) + 1);
              }
            }
            const got = [...outcomes.keys()].map(o => `\`${o}\``).join(', ') || '(nothing)';
            const extra = `${routeFails ? `; ${routeFails} reading(s) failed to route` : ''}${crossing ? `; ${crossing} crossed an existing edge` : ''}`;
            report.push(`  - every stroke between those endpoints gives instead: ${got}${extra}`);
          }
          report.push('');
          console.log(`${name}: ${failing.length} failing children${crossings.length ? ' (drawing has crossings)' : ''}`);
        }
  
        // Advance with a random drawable child, recording history + tokens like live play.
        // (strokes must fit `state`'s own geometry, which is the raw reload, not the settled test copy)
        const options = [...(await enumerateAll(raw)).values()];
        if (options.length === 0) break;
        const pick = options[Math.floor(Math.random() * options.length)];
        const stroke: SpherePoint[] = pick.stroke.map(q => ({ ...q }));
        const before = cloneState(state);
        applyMove(state, { v1: pick.v1, v2: pick.v2, stroke });
        // Labelled codes, as live play records them: a save's moveSequence is the labelled form.
        state.spotLabels = recomputeSpotLabels(before.spotLabels, before, state, pick.v1, pick.v2);
        tokens.push(labelledMoveCode(before, pick.v1, pick.v2, state));
        history.push({ state: before, committed: { v1: pick.v1, v2: pick.v2, rawStroke: stroke } });
        relax(state);
      }
    }
  }

  const header = [
    "# Positions where some move can't be drawn", '',
    `${saves} save files from ${positions} positions in ${games} random games per seed (seeds ${seeds.join(', ')}; ≤${maxSpots} spots). ` +
      `${childrenFailed} of ${childrenTotal} distinct children (${(100 * childrenFailed / Math.max(1, childrenTotal)).toFixed(1)}%) ` +
      `couldn't be drawn by any router reading; ${brokenDrawings} of these positions have crossing edges.`, '',
    'Load a file with the Load button. The failing children are rows in the Position Browser\'s child list: ' +
      'hovering one shows a red ring on its endpoints (with Debug → Pause Recreations on, also the strokes that were tried). ' +
      'Vertex numbers are the ids the board\'s id toggle shows. "Hover\'s translation" is how the app maps the engine\'s ' +
      'move onto live vertices — it can be wrong itself, so a failure there is a translation bug, not a drawing bug.', '',
  ];
  writeFileSync(`${outDir}/REPORT.md`, [...header, ...report].join('\n'));
  console.log(header[2]);
}

void main();
