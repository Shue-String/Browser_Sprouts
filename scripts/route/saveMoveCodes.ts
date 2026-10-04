/** Re-derives each saved move's code (and, for self-loops, the other face's code) from the save's own history.
 *  NO_MAIN=1 node <tmp>/s.mjs failureSaves/fail-g19-m10.json */
import { readFileSync } from 'node:fs';
import { deserializeGameState } from '../../src/model/saveState';
import { recomputeRegions } from '../../src/model/moves';
import { computeMoveCode, computeEnclosureSideColoring } from '../../src/model/moveCode';

const save = deserializeGameState(JSON.parse(readFileSync(process.argv[2], 'utf8')));
save.history.forEach((h, i) => {
  const before = h.state;
  const after = i + 1 < save.history.length ? save.history[i + 1].state : save.state;
  if (!process.env.NORECOMP) { recomputeRegions(before); recomputeRegions(after); }
  const { v1, v2 } = h.committed;
  const col = computeEnclosureSideColoring(before, after, v1, v2);
  console.log(`move ${i + 1}: recorded ${save.moveSequence[i]} | now ${computeMoveCode(before, v1, v2, after)} | other side ${computeMoveCode(before, v1, v2, after, undefined, undefined, true)} | arc side [${col ? [...col.arcSideVertexIds].filter(v => v > -9000).join(' ') : ''}] other [${col ? [...col.otherSideVertexIds].filter(v => v > -9000).join(' ') : ''}]`);
});
