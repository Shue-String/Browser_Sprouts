/** Re-derives each saved move's code from the save's own history: the labelled form exactly as Load
 *  rebuilds it (labels seeded by initialSpotLabels, each saved stroke replayed on its saved board),
 *  plus the raw form, the other face's raw code for self-loops, and the arc-side coloring.
 *  WRITE=1 rewrites the save's moveSequence with the re-derived labelled codes (Move Check tags
 *  dropped), e.g. after a move-code rule change made the recorded ones stale.
 *  NO_MAIN=1 [WRITE=1] node <tmp>/s.mjs <save.json>... */
import { readFileSync, writeFileSync } from 'node:fs';
import { deserializeGameState } from '../../src/model/saveState';
import { applyMove, recomputeRegions } from '../../src/model/moves';
import { cloneState } from '../../src/model/gameState';
import { computeMoveCode, computeEnclosureSideColoring } from '../../src/model/moveCode';
import { initialSpotLabels, recomputeSpotLabels, labelledMoveCode } from '../../src/model/vertexLabels';

for (const file of process.argv.slice(2)) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const save = deserializeGameState(raw);
  if (save.history.length > 0) recomputeRegions(save.history[0].state);
  let labels = initialSpotLabels(save.history.length > 0 ? save.history[0].state : save.state);
  const derived: string[] = [];
  let changed = 0;
  save.history.forEach((h, i) => {
    const before = h.state;
    recomputeRegions(before);
    before.spotLabels = labels;
    const { v1, v2, rawStroke } = h.committed;
    const after = cloneState(before);
    applyMove(after, { v1, v2, stroke: rawStroke.map(p => ({ ...p })) });
    after.spotLabels = recomputeSpotLabels(labels, before, after, v1, v2);
    labels = after.spotLabels;
    const labelled = labelledMoveCode(before, v1, v2, after);
    derived.push(labelled);
    const recorded = String(save.moveSequence[i] ?? '').replace(/\{.*\}$/, '');
    if (recorded !== labelled) changed++;
    const col = computeEnclosureSideColoring(before, after, v1, v2);
    console.log(`${file} move ${i + 1}: recorded ${recorded} | labelled ${labelled}${recorded !== labelled ? '  (CHANGED)' : ''} | raw ${computeMoveCode(before, v1, v2, after)} | other side ${computeMoveCode(before, v1, v2, after, undefined, undefined, true)} | arc side [${col ? [...col.arcSideVertexIds].filter(v => v > -9000).join(' ') : ''}] other [${col ? [...col.otherSideVertexIds].filter(v => v > -9000).join(' ') : ''}]`);
  });
  if (process.env.WRITE && changed > 0) {
    raw.moveSequence = derived;
    writeFileSync(file, JSON.stringify(raw));
    console.log(`${file}: rewrote ${changed} token(s)`);
  }
}
