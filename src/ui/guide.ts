/**
 * In-game Guide: a topic list on the left, the selected topic's notes on the right.
 * Content below is a first-draft placeholder set — meant to be extended, not final copy.
 */

interface GuideTopic {
  id: string;
  title: string;
  html: string;
}

const TOPICS: GuideTopic[] = [
  {
    id: 'how-to-play',
    title: 'How to Play?',
    html: `
      <h3>How to Play?</h3>
      <p>Click "New Game" in the top right to start a game with 1-20 spots (Or you can start
      your first game with the default 6).
      
      Players take turns clicking and dragging to draw a line between two points (or from a 
      point to itself).  Once the line is drawn, a new point will be added along that line.</p>

      <p>Each drawn line must obey two rules:</p>
      <ul>
        <li>A line may never cross itself, another line, or pass through another point.</li>
        <li>No point may ever have more than three lines coming out of it. (Connecting a point
        to itself is considered to be adding two new lines).</li>
      </ul>
      <p>The last player able to make a legal move wins.</p>
    `,
  },
  {
    id: 'what-is-sprouts',
    title: 'What is Sprouts?',
    html: `
      <h3>What is Sprouts?</h3>
      <p>Sprouts is a pencil-and-paper game for two players, invented in 1967 by John Conway
      and Michael Paterson. Despite its simple rules, the game is staggeringly hard to 
      understand using mathematics.  The last player able to make a legal move wins. Despite
      the simple rules, the game is a mathematical nightmare- nobody has managed to find any
      sort of strategy to win.</p>

      <p>Though the game is typically played on a flat surface, the rules of the game dictate
      that the game be planar, which means that its topology is the same if put on a sphere.
      This turns out to be a useful feature when studying the game, so we've implemented it
      in our app.</p>
      
      <p>This app is a companion to an in-progress math paper analyzing the game's structure
      (see <code>README.txt</code> for background). Use the Position Browser to explore the
      game tree analytically, or hit Play to draw moves by hand.</p>
    `,
  },
  {
    id: 'controls',
    title: 'Controls',
    html: `
      <h3>Mouse Controls</h3>
      <table>
        <tr><td><code>Left-Click and drag point</code></td><td>Draw a move (connect to a second point and/or back to the original).</td></tr>
        <tr><td><code>Right-Click and drag point</code></td><td>Drag the point around.</td></tr>
        <tr><td><code>Left-Click and drag (empty space)</code></td><td>Rotate the projected sphere</td></tr>
        <tr><td><code>Double-Left-Click anywhere</code></td><td>Center the projection that location.</td></tr>
        <tr><td><code>Double-Right-Click anywhere</code></td><td>Center on the antipode of that location.</td></tr>
      </table>
      
      <h3>Keyboard commands</h3>
      <table>
        <tr><td><code>Ctrl/Cmd + Z</code></td><td>Undo the last move</td></tr>
        <tr><td><code>Escape</code></td><td>Close an open
          dialog (Position Browser, Guide, etc.)</td></tr>
      </table>
    `,
  },
  {
    id: 'position-browser',
    title: 'Position Browser',
    html: `
      <h3>Position Browser</h3>
      <p>The Position Browser lets you look up any position by its encoding and see its
      children, nimber, and winner without playing it out by hand.</p>
      <ul>
        <li><b>Hover</b> a child row to preview that move on the board.</li>
        <li><b>Double-click</b> a row to commit that move (or navigate to that position, in
          Sync mode).</li>
        <li><b>Escape</b> clears a locked preview, or closes the panel.</li>
        <li><b>Enter</b> in the address bar navigates to the typed position.</li>
        <li><b>Sync to game</b> toggle: when on, the panel is locked to the live game — the
          back/forward buttons become undo/redo, double-clicking a child plays that move, and
          manual address entry / free parent navigation are disabled. Turn it off to browse
          the position tree independently of the live game.</li>
      </ul>
      <p><b>Display toggles</b> above the position list:</p>
      <ul>
        <li><b>Quick-Canon</b> — groups positions that are equivalent under known
          nimber-preserving "collections," shrinking the tree. Each grouped position carries a
          ⊕0/⊕1 offset. Off by default (exact structural canonical form).</li>
        <li><b>Highlight Winning</b> — marks the child move(s) that leave the opponent in a
          losing position.</li>
        <li><b>Nimbers</b> — shows each position's Grundy value.</li>
      </ul>
    `,
  },
  {
    id: 'encodings',
    title: 'Position encodings',
    html: `
      <h3>Reading a position encoding</h3>
      <p>Every position has a canonical text encoding, shown when the "Position encoding"
      debug toggle is on, or throughout the Position Browser. Regions are separated by
      <code>|</code>, boundaries within a region by <code>,</code>, and each boundary is a
      string of point tokens read around its walk:</p>
      <table>
        <tr><th>Token</th><th>Meaning</th></tr>
        <tr><td><code>0</code></td><td>Spot (degree 0 — an untouched starting point)</td></tr>
        <tr><td><code>1</code></td><td>Appendage (a loose dangling end)</td></tr>
        <tr><td><code>2</code></td><td>Scab (a dead-ended point on the boundary)</td></tr>
        <tr><td><code>7</code> / <code>8</code></td><td>Joint (a point visited twice by the
          same boundary walk)</td></tr>
        <tr><td><code>A–Z</code></td><td>Membrane (a point shared between two regions;
          the same letter appears on both sides)</td></tr>
        <tr><td><code>3, 4, 5, 6</code></td><td>Compressed shorthand for small recurring
          structures (DisaPoint, Hollow point, Split point, Triplet) that would otherwise take
          several tokens to write out</td></tr>
      </table>
      <p>Hovering a character in an encoding string highlights the matching point on the
      board.</p>
    `,
  },
  {
    id: 'nimbers',
    title: 'What are Nimbers?',
    html: `
      <h3>What are Nimbers?</h3>
      <p>A nimber (or Grundy value) is a single number that summarizes who wins a position and
      how, under normal-play combinatorial game theory. Sprouts is an impartial game — both
      players have the same moves available from any position — so every position's outcome
      can be captured by one non-negative integer, computed recursively:</p>
      <p><code>G(position) = mex { G(child) : child reachable by one move }</code></p>
      <p>("mex" = minimum excludant — the smallest non-negative integer not appearing in the
      set.) A position with <code>G = 0</code> is a loss for the player about to move (a
      "P-position"); any nonzero nimber is a win for the player about to move.</p>
      <p>Nimbers are what make sums of independent subpositions tractable: the nimber of a
      position made of several disconnected pieces is just the XOR of each piece's nimber.
      This is why the Position Browser can report a nimber for the whole board even when it's
      made of several separate components.</p>
    `,
  },
  {
    id: 'large-positions',
    title: 'Working with large positions',
    html: `
      <h3>A note on very large positions</h3>
      <p>The analysis engine's encoding scheme names each membrane point with a single letter
      (A–Z), which caps it at 26 membranes within one connected piece of the board. This limit
      isn't expected to matter for normal alpha testing — it would take a considerably larger
      and more tangled position than typical games reach (well beyond 8 starting spots) to hit
      it. If you do hit it, the engine will report an error rather than silently
      misbehave.</p>
    `,
  },
];

let wired = false;
let activeId = TOPICS[0].id;

function render(): void {
  const topicsEl = document.getElementById('guide-topics') as HTMLDivElement;
  const contentEl = document.getElementById('guide-content') as HTMLDivElement;

  topicsEl.innerHTML = '';
  for (const t of TOPICS) {
    const btn = document.createElement('button');
    btn.className = 'guide-topic-btn' + (t.id === activeId ? ' active' : '');
    btn.textContent = t.title;
    btn.addEventListener('click', () => {
      activeId = t.id;
      render();
    });
    topicsEl.appendChild(btn);
  }

  const active = TOPICS.find(t => t.id === activeId) ?? TOPICS[0];
  contentEl.innerHTML = active.html;
  contentEl.scrollTop = 0;
}

/** Wire the topic list once; safe to call multiple times (each open just re-renders). */
export function initGuide(): void {
  if (wired) { render(); return; }
  wired = true;
  render();
}
