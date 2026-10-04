/**
 * Headless stroke-synthesis coverage harness (Node, bundled with esbuild). Plays random games and,
 * at every position along the way, asks: for each engine child (the Position Browser's move list),
 * can a synthesizer draw a stroke whose result canonicalizes to exactly that child? The oracle is
 * main.ts's synthesizeVerifiedMove's: WASM canon of the trial's DECOMPRESSED encoding vs
 * canon(child.enc) (minus its cross-hit cache).
 *
 * Synthesizers (4th arg, comma-separated):
 *   pipeline — candidateStrokes (what the app runs: router + legacy candidates)
 *   new      — moveRouter's routedCandidates alone
 *   enum     — every router reading of every face, matched against the children by canon:
 *              measures what the router can draw at all, independent of resolveMoveVertices
 * Children whose resolved endpoints have no free valence are counted separately (translation
 * problems, not drawing problems).
 *
 * Run (from the repo root, so npx uses the project's esbuild):
 *   npx esbuild scripts/route/routeHarness.ts --bundle --platform=node --format=esm --outfile=<tmp>/h.mjs
 *   node <tmp>/h.mjs [games=20] [maxSpots=6] [seed=1] [synths=pipeline,new]
 * Env: MAXFAIL=n (failures listed), VERBOSE=1, DUMP="g0 m3 c7" DUMP_FILE=x.json (one child's
 * state for routeDebug.ts), DUMP_POS="g0 m3" (a whole position).
 */
import type { GameState } from '../../src/model/types';
import type { SpherePoint } from '../../src/math/sphere';
import { createInitialState, cloneState } from '../../src/model/gameState';
import { applyMove } from '../../src/model/moves';
import { encodePositionDecompressed, resolveMoveVertices } from '../../src/model/encoding';
import { analyze, canon, MoveKind } from '../../src/engine/stalks';
import type { ChildInfo } from '../../src/engine/stalks';
import { candidateStrokeStream, strokeCrossesEdges } from '../../src/model/strokeSynthesis';
import type { ResolvedMove } from '../../src/model/moveCodeParse';
import { smoothStep, resampleAllEdges, resetActivityTimer } from '../../src/model/smooth';
import { routedCandidates, allRoutedMoves } from '../../src/model/moveRouter';

// Deterministic Math.random so a failing (game, move, child) can be replayed exactly.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Synth = (state: GameState, parsed: ResolvedMove, targetCanon: string) => Promise<SpherePoint[] | null>;

async function verifies(state: GameState, parsed: ResolvedMove, stroke: SpherePoint[], targetCanon: string): Promise<boolean> {
  if (strokeCrossesEdges(state, stroke, undefined, parsed.lo, parsed.hi)) return false;
  const trial = cloneState(state);
  try {
    applyMove(trial, { v1: parsed.lo, v2: parsed.hi, stroke });
  } catch {
    return false;
  }
  const text = encodePositionDecompressed(trial).text;
  return (text === '' ? 'N' : await canon(text)) === targetCanon;
}

const oldSynth: Synth = async (state, parsed, targetCanon) => {
  for (const stroke of candidateStrokeStream(state, parsed)) {
    if (await verifies(state, parsed, stroke, targetCanon)) return stroke;
  }
  return null;
};

const newSynth: Synth = async (state, parsed, targetCanon) => {
  for (const stroke of routedCandidates(state, parsed)) {
    if (await verifies(state, parsed, stroke, targetCanon)) return stroke;
  }
  return null;
};

const SYNTHS: Record<string, Synth> = { pipeline: oldSynth, new: newSynth };

/** Resulting canon -> one stroke reaching it, over moveRouter's allRoutedMoves (router alone). */
export async function enumerateAll(state: GameState): Promise<Map<string, { v1: number; v2: number; stroke: SpherePoint[] }>> {
  const reach = new Map<string, { v1: number; v2: number; stroke: SpherePoint[] }>();
  for (const mv of allRoutedMoves(state, 9)) {
    if (strokeCrossesEdges(state, mv.stroke, undefined, mv.v1, mv.v2)) continue;
    const trial = cloneState(state);
    try { applyMove(trial, mv); } catch { continue; }
    const text = encodePositionDecompressed(trial).text;
    const c = text === '' ? 'N' : await canon(text);
    if (!reach.has(c)) reach.set(c, mv);
  }
  return reach;
}

/** Let the layout physics settle the way the live render loop would after a commit. */
export function relax(state: GameState): void {
  resampleAllEdges(state);
  resetActivityTimer();
  for (let i = 0; i < 300; i++) if (!smoothStep(state)) break;
  resampleAllEdges(state);
}

/** Plain-JSON snapshot of a GameState (Maps flattened) for replaying one failing case. */
export function dumpState(state: GameState): unknown {
  return { ...state, vertices: [...state.vertices.values()], edges: [...state.edges.values()],
    regions: [...state.regions.values()], spotLabels: [...state.spotLabels.entries()] };
}

export function loadState(raw: any): GameState {
  return { ...raw, vertices: new Map(raw.vertices.map((v: any) => [v.id, v])), edges: new Map(raw.edges.map((e: any) => [e.id, e])),
    regions: new Map(raw.regions.map((r: any) => [r.id, r])), spotLabels: new Map(raw.spotLabels) };
}

export function parsedFor(state: GameState, child: ChildInfo): ResolvedMove | null {
  if (!child.move || child.move.kind === MoveKind.InteriorPseudo) return null;
  const r = resolveMoveVertices(state, child.move);
  if (!r) return null;
  return {
    token: '', checkEncoding: null, lo: r.v1, hi: r.v2, loSub: null, hiSub: null,
    parallel: false, parens: null, brackets: r.brackets ?? null,
  };
}

async function main(): Promise<void> {
  const [gamesArg, maxSpotsArg, seedArg, synthArg] = process.argv.slice(2);
  const games = Number(gamesArg ?? 20);
  const maxSpots = Number(maxSpotsArg ?? 6);
  const seed = Number(seedArg ?? 1);
  const synthNames = (synthArg ?? Object.keys(SYNTHS).join(',')).split(',');
  Math.random = mulberry32(seed);

  const stats = new Map<string, { ok: number; total: number; ms: number }>();
  for (const n of synthNames) stats.set(n, { ok: 0, total: 0, ms: 0 });
  const failures: string[] = [];
  const badResolve: string[] = [];

  for (let g = 0; g < games; g++) {
    const spots = 2 + Math.floor(Math.random() * (maxSpots - 1));
    const state = createInitialState(spots);
    for (let m = 0; m < 3 * spots; m++) {
      const enc = encodePositionDecompressed(state).text;
      const res = await analyze(enc);
      const children = res.children ?? [];
      if (children.length === 0) break;
      if (process.env.DUMP_POS === `g${g} m${m}`) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(process.env.DUMP_FILE ?? 'dump.json', JSON.stringify({ state: dumpState(state), children: await Promise.all(children.map(async c => ({ enc: c.enc, canon: await canon(c.enc), move: c.move }))) }));
        console.log('dumped position');
        process.exit(0);
      }
      if (synthNames.includes('enum')) {
        const t0 = performance.now();
        const reach = await enumerateAll(state);
        const st = stats.get('enum')!;
        st.ms += performance.now() - t0;
        const seen = new Set<string>();
        for (const child of children) {
          if (!child.move || child.move.kind === MoveKind.InteriorPseudo) continue;
          const tc = await canon(child.enc);
          if (seen.has(tc)) continue;
          seen.add(tc);
          st.total++;
          if (reach.has(tc)) st.ok++;
          else failures.push(`enum g${g} m${m} ${enc} -> ${child.enc} (move=${JSON.stringify(child.move)})`);
        }
      }
      const playable: { stroke: SpherePoint[]; parsed: ResolvedMove }[] = [];
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci];
        const parsed = parsedFor(state, child);
        if (!parsed) continue;
        // A resolution that names an endpoint with no free valence can't be drawn by anything —
        // that's a resolveMoveVertices translation problem, counted apart from the synthesizers.
        const deg = (v: number): number => state.vertices.get(v)?.degree ?? 9;
        if (parsed.lo === parsed.hi ? deg(parsed.lo) > 1 : deg(parsed.lo) > 2 || deg(parsed.hi) > 2) {
          badResolve.push(`g${g} m${m} c${ci} ${enc} -> ${child.enc} (lo=${parsed.lo} hi=${parsed.hi} move=${JSON.stringify(child.move)})`);
          continue;
        }
        const targetCanon = await canon(child.enc);
        for (const name of synthNames) {
          if (name === 'enum') continue;
          const st = stats.get(name)!;
          const t0 = performance.now();
          if (process.env.DUMP === `g${g} m${m} c${ci}`) {
            const { writeFileSync } = await import('node:fs');
            writeFileSync(process.env.DUMP_FILE ?? 'dump.json', JSON.stringify({ state: dumpState(state), parsed, targetCanon }));
            console.log('dumped');
            process.exit(0);
          }
          if (process.env.VERBOSE) console.log(`  ${name} g${g} m${m} c${ci} ${enc} -> ${child.enc} lo=${parsed.lo} hi=${parsed.hi} br=${JSON.stringify(parsed.brackets)}`);
          const stroke = await SYNTHS[name](state, parsed, targetCanon);
          st.ms += performance.now() - t0;
          st.total++;
          if (stroke) { st.ok++; playable.push({ stroke, parsed }); }
          else failures.push(`${name} g${g} m${m} c${ci} ${enc} -> ${child.enc} (lo=${parsed.lo} hi=${parsed.hi} br=${JSON.stringify(parsed.brackets)})`);
        }
      }
      if (playable.length === 0) break;
      const pick = playable[Math.floor(Math.random() * playable.length)];
      applyMove(state, { v1: pick.parsed.lo, v2: pick.parsed.hi, stroke: pick.stroke });
      relax(state);
    }
  }

  for (const [name, st] of stats) {
    console.log(`${name}: ${st.ok}/${st.total} (${(100 * st.ok / Math.max(1, st.total)).toFixed(1)}%)  avg ${(st.ms / Math.max(1, st.total)).toFixed(1)} ms/child`);
  }
  console.log(`illegal resolutions (skipped): ${badResolve.length}`);
  for (const f of badResolve.slice(0, 10)) console.log('  ' + f);
  console.log(`failures (${failures.length}):`);
  for (const f of failures.slice(0, Number(process.env.MAXFAIL ?? 40))) console.log('  ' + f);
}

if (!process.env.NO_MAIN) void main();
