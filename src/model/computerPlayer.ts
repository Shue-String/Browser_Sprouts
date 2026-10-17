import { analyze, UNKNOWN_VALUE, type ChildInfo } from '../engine/stalks';
import { record } from './positionCache';

/**
 * The computer player's move choice, over the engine's children of the live position (the same
 * list the Position Browser shows). It only orders children; main.ts plays them, drawn in, in this
 * order until one draws — a child whose stroke can't be synthesized is skipped, not fatal.
 *
 *   random — an immediately winning child (one that ends the game) if any, else any child.
 *   smart  — a nimber-0 child if one is known, else any child. Children the cache doesn't value
 *            are valued on demand when the engine's automatic size gate allows it (largest
 *            minimal subposition ≤ 10 lives, analyze.cpp kAutoLives2); bigger ones stay unknown.
 *
 * Each tier is shuffled, and later tiers repeat nothing already offered.
 */
export type ComputerStrength = 'random' | 'smart';

/** A child with no moves left: making it wins on the spot. */
function endsGame(c: ChildInfo): boolean {
  return c.maxMoves === 0 || c.enc.split('+').every(p => p === 'N');
}

function shuffled<T>(xs: readonly T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The child's nimber, valuing it now if the engine analyzes it automatically; null if too big. */
async function nimberOf(c: ChildInfo): Promise<number | null> {
  if (c.nimber !== UNKNOWN_VALUE) return c.nimber;
  // analyze() is synchronous WASM behind a promise: give the frame loop a turn between children.
  await new Promise(r => setTimeout(r, 0));
  const result = await analyze(c.enc);
  if (!result.ok) return null;
  record(result);
  return result.nimber;
}

/**
 * The children to try, best first. Lazy, so Smart values only as many unknown children as it
 * takes to reach one that draws.
 */
export async function* computerMoveOrder(children: ChildInfo[], strength: ComputerStrength): AsyncGenerator<ChildInfo> {
  const playable = children.filter(c => c.move);
  const offered = new Set<ChildInfo>();
  const offer = function* (tier: ChildInfo[]): Generator<ChildInfo> {
    for (const c of tier) if (!offered.has(c)) { offered.add(c); yield c; }
  };
  if (strength === 'random') {
    yield* offer(shuffled(playable.filter(endsGame)));
  } else {
    // Known zeros first (no engine work), then the rest valued one at a time.
    yield* offer(shuffled(playable.filter(c => c.nimber === 0)));
    for (const c of shuffled(playable.filter(c => c.nimber === UNKNOWN_VALUE))) {
      if ((await nimberOf(c)) === 0) yield* offer([c]);
    }
  }
  yield* offer(shuffled(playable));
}
