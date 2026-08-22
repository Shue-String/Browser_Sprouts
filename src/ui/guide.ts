/**
 * In-game Guide: a searchable topic list on the left, the selected topic's notes on the right.
 * `openGuide(topicId?)` is the entry point other UI code should call for deep-linking (e.g. a
 * "?" button next to a toggle) — it owns opening the overlay itself, not just picking a topic.
 */

interface GuideTopic {
  id: string;
  title: string;
  /** Lowercased title + plain-text content, precomputed once for search filtering. */
  searchText: string;
  html: string;
}

/** Small inline cross-reference: jumps the guide to another topic without leaving the dialog. */
function jumpLink(topicId: string, label: string): string {
  return `<button class="guide-jump" data-topic="${topicId}">${label}</button>`;
}

const RAW_TOPICS: Array<{ id: string; title: string; html: string }> = [
  {
    id: 'how-to-play',
    title: 'How to Play?',
    html: `
      <h3>How to Play?</h3>
      <p>Click <b>New Game</b> in the top right to start with anywhere from 1 to 20 spots (or
      just start with the default 6 to get a feel for it).</p>
      <p>Players alternate turns. On your turn, click-and-drag from one point to draw a line
      to a second point — or back to the same point, to make a loop. As soon as the line is
      drawn, a new point is added somewhere along it.</p>
      <svg class="guide-diagram" viewBox="0 0 320 110" xmlns="http://www.w3.org/2000/svg">
        <path d="M 50 70 Q 160 10 270 70" fill="none" stroke="#4a90d9" stroke-width="2.5" />
        <circle cx="50" cy="70" r="6" fill="#333" />
        <circle cx="270" cy="70" r="6" fill="#333" />
        <circle cx="160" cy="38" r="5" fill="#cc4444" />
        <text x="50" y="94" font-size="11" text-anchor="middle" fill="#555">start point</text>
        <text x="270" y="94" font-size="11" text-anchor="middle" fill="#555">end point</text>
        <text x="160" y="24" font-size="11" text-anchor="middle" fill="#cc4444">new point (added automatically)</text>
      </svg>
      <p>Every drawn line has to follow two rules:</p>
      <ul>
        <li>It can never cross itself, cross another line, or pass through another point.</li>
        <li>No point may ever end up with more than three line-ends touching it. (A loop from a
        point back to itself counts as <i>two</i> line-ends at that point, not one.)</li>
      </ul>
      <svg class="guide-diagram" viewBox="0 0 320 100" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(70,50)">
          <line x1="0" y1="0" x2="-45" y2="-28" stroke="#888" stroke-width="2" />
          <line x1="0" y1="0" x2="45" y2="-28" stroke="#888" stroke-width="2" />
          <line x1="0" y1="0" x2="0" y2="45" stroke="#888" stroke-width="2" />
          <circle cx="0" cy="0" r="6" fill="#333" />
          <text x="0" y="70" font-size="11" text-anchor="middle" fill="#555">3 lines: full, can't be used again</text>
        </g>
        <g transform="translate(230,50)">
          <path d="M 0 0 C -30 -35, 30 -35, 0 0" fill="none" stroke="#888" stroke-width="2" />
          <line x1="0" y1="0" x2="0" y2="45" stroke="#888" stroke-width="2" />
          <circle cx="0" cy="0" r="6" fill="#333" />
          <text x="0" y="70" font-size="11" text-anchor="middle" fill="#555">loop = 2 lines, + 1 more allowed</text>
        </g>
      </svg>
      <p>A point with three lines (or an untouched spot with none yet drawn from it) is "dead" —
      no more moves can start or end there. The last player who is still able to make a legal
      move wins; if you can't move on your turn, you lose.</p>
      <p>Everything above is the paper-and-pencil game. This app additionally lets you undo
      moves, save/load a board, and inspect the underlying math — see
      ${jumpLink('controls', 'Controls')} and ${jumpLink('position-browser', 'Position Browser')}.</p>
    `,
  },
  {
    id: 'what-is-sprouts',
    title: 'What is Sprouts?',
    html: `
      <h3>What is Sprouts?</h3>
      <p>Sprouts is a pencil-and-paper game for two players, invented in 1967 by John Conway and
      Michael Paterson. The rules are small enough to explain in a minute (see
      ${jumpLink('how-to-play', 'How to Play?')}), but the game is notoriously resistant to
      analysis — despite decades of attention, nobody has found a general strategy for who wins
      a given starting position, or even a formula for how long a game can run.</p>
      <p>The classic game is played flat on paper, but its rules only ever care about which
      lines and points touch which others — never about distances or angles. That means the
      game is exactly as well-defined on the surface of a sphere as on a flat sheet, and this
      app uses that freedom: positions are stored and analyzed on a sphere, which turns out to
      make some of the game's structure easier to see and avoids the flat page's edge acting as
      an artificial boundary.</p>
      <p>This app is a companion to an in-progress math paper analyzing the game's structure
      (see the project's <code>README.md</code> for background). Use <b>Play</b> to draw moves
      by hand exactly like the paper-and-pencil game, or open the ${jumpLink('position-browser', 'Position Browser')}
      to explore the underlying game tree analytically — look up any position, see its
      children, and check who wins it, without drawing anything out by hand.</p>
    `,
  },
  {
    id: 'controls',
    title: 'Controls',
    html: `
      <h3>Mouse Controls</h3>
      <table>
        <tr><td><code>Left-click + drag, on a point</code></td><td>Draw a move — drag to a second point, or back to the start for a self-loop.</td></tr>
        <tr><td><code>Right-click + drag, on a point</code></td><td>Reposition the point (cosmetic only — doesn't change the game).</td></tr>
        <tr><td><code>Left-click + drag, empty space</code></td><td>Rotate the sphere.</td></tr>
        <tr><td><code>Double-left-click, anywhere</code></td><td>Re-center the view on that spot.</td></tr>
        <tr><td><code>Double-right-click, anywhere</code></td><td>Re-center the view on the <i>antipode</i> (opposite side of the sphere) of that spot.</td></tr>
      </table>

      <h3>Keyboard Commands</h3>
      <table>
        <tr><td><code>Ctrl/Cmd + Z</code></td><td>Undo the last move (disabled while Recreate is playing back).</td></tr>
        <tr><td><code>Escape</code></td><td>Close whichever dialog is open (${jumpLink('position-browser', 'Position Browser')},
          Guide, Collect). In the Position Browser, if a hovered preview is locked, the first
          Escape unlocks it instead of closing the panel.</td></tr>
        <tr><td><code>Space</code></td><td>Pause/resume playback while Recreate is running a move sequence.</td></tr>
        <tr><td><code>Enter</code></td><td>Confirm the current step of a Recreate candidate preview, or force-commit a manually-drawn move that couldn't be auto-verified.</td></tr>
      </table>

      <h3>Top Bar</h3>
      <table>
        <tr><td><b>New Game</b></td><td>Start a fresh board with 1–20 spots.</td></tr>
        <tr><td><b>Save / Load</b></td><td>Save the current board, camera angle, and any in-progress move to a file, or load one back in.</td></tr>
        <tr><td><b>Undo</b></td><td>Same as Ctrl/Cmd+Z.</td></tr>
        <tr><td><b>Recreate</b></td><td>Replay a game from a Move Sequence string, one move at a time (only shown while a sequence is being replayed).</td></tr>
        <tr><td><b>Collapsing</b></td><td>When on (the default), dead regions — parts of the board that can no longer affect the outcome — automatically shrink and disappear as they're created. Turn it off to leave them visible in place instead.</td></tr>
        <tr><td><b>Browser</b></td><td>Opens the ${jumpLink('position-browser', 'Position Browser')} as a dialog (only shown on narrow windows; on wide windows it's docked as a side panel instead).</td></tr>
        <tr><td><b>Collect</b></td><td>A research tool for browsing genetic codes / matched paper collections — mainly useful if you're cross-referencing the companion math paper.</td></tr>
        <tr><td><b>Guide</b></td><td>This window.</td></tr>
      </table>
    `,
  },
  {
    id: 'position-browser',
    title: 'Position Browser',
    html: `
      <h3>Position Browser</h3>
      <p>The Position Browser looks up any position by its ${jumpLink('encodings', 'encoding')}
      and shows its children, nimber, and winner — without needing to draw anything out by
      hand. On wide windows it's docked as a permanent side panel; on narrow windows, open it
      with the <b>Browser</b> button.</p>
      <h4>Navigating</h4>
      <ul>
        <li><b>Hover</b> a child row to preview that move on the board.</li>
        <li><b>Double-click</b> a row to commit that move (in Sync mode) or navigate into that
          child position (out of Sync mode).</li>
        <li><b>Escape</b> clears a locked preview first, then closes the panel on a second
          press.</li>
        <li>Type an encoding into the address bar and press <b>Enter</b> to jump straight to
          it.</li>
        <li><b>◀ / ▶</b> step back and forward through your browsing history.</li>
      </ul>
      <h4>Sync to game</h4>
      <p>This toggle switches what the panel is <i>for</i>:</p>
      <ul>
        <li><b>On</b> — the panel is locked to the live game. The ◀/▶ buttons become
          undo/redo, double-clicking a child actually plays that move on the board, and the
          address bar / free parent-navigation are disabled (you can't browse away from the
          live position).</li>
        <li><b>Off</b> — the panel is a free-standing explorer. Type any encoding, click
          through children, and go anywhere in the position tree without touching the live
          game at all.</li>
      </ul>
      <h4>Display toggles</h4>
      <ul>
        <li><b>Quick-Canon</b> — groups positions that are equivalent under known
          nimber-preserving "collections," shrinking the tree. Each grouped position shows a
          <code>⊕0</code>/<code>⊕1</code> offset from the collection's representative. Off by
          default, which shows the exact structural canonical form with no grouping.</li>
        <li><b>Highlight Winning</b> — marks, in green, the child move(s) that leave the
          opponent in a losing position.</li>
        <li><b>Nimbers</b> — shows each position's Grundy value. See
          ${jumpLink('nimbers', 'What are Nimbers?')} for what that number means.</li>
      </ul>
    `,
  },
  {
    id: 'encodings',
    title: 'Position encodings',
    html: `
      <h3>Reading a position encoding</h3>
      <p>Every position has a canonical text encoding — shown in the Position Browser, and on
      the board itself via the "Position encoding" debug toggle. It's built from a handful of
      delimiters plus one character per meaningful point on the board:</p>
      <svg class="guide-diagram" viewBox="0 0 400 60" xmlns="http://www.w3.org/2000/svg">
        <text x="10" y="36" font-family="monospace" font-size="20" fill="#333">[</text>
        <text x="24" y="36" font-family="monospace" font-size="20" fill="#118844">0AB</text>
        <text x="80" y="36" font-family="monospace" font-size="20" fill="#cc7a00">|</text>
        <text x="92" y="36" font-family="monospace" font-size="20" fill="#118844">1</text>
        <text x="103" y="36" font-family="monospace" font-size="20" fill="#888">,</text>
        <text x="114" y="36" font-family="monospace" font-size="20" fill="#118844">A</text>
        <text x="126" y="36" font-family="monospace" font-size="20" fill="#cc7a00">|</text>
        <text x="138" y="36" font-family="monospace" font-size="20" fill="#118844">1</text>
        <text x="149" y="36" font-family="monospace" font-size="20" fill="#888">,</text>
        <text x="160" y="36" font-family="monospace" font-size="20" fill="#118844">B</text>
        <text x="172" y="36" font-family="monospace" font-size="20" fill="#333">]</text>
        <text x="10" y="54" font-size="10" fill="#333">[ ] subposition</text>
        <text x="205" y="54" font-size="10" fill="#cc7a00">| region</text>
        <text x="285" y="54" font-size="10" fill="#888">, boundary</text>
      </svg>
      <p><code>[ ]</code> wraps one connected, independently-playable chunk of the board (a
      "subposition"). <code>|</code> separates the regions inside it; <code>,</code> separates
      multiple boundary loops within the same region (a region can border more than one loop of
      points — e.g. a ring with an island inside it). Several independent subpositions are
      joined with <code>⊕</code> (the same symbol used for XOR — see
      ${jumpLink('nimbers', 'What are Nimbers?')} for why that's not a coincidence).</p>
      <p>Within a boundary, each point gets one token, read in order around the walk:</p>
      <table>
        <tr><th>Token</th><th>Meaning</th></tr>
        <tr><td><code>0</code></td><td>Spot — an untouched starting point, degree 0.</td></tr>
        <tr><td><code>1</code></td><td>Appendage — a loose dangling end, degree 1.</td></tr>
        <tr><td><code>2</code></td><td>Scab — a degree-2 point sitting where the other side has
          no other usable point left.</td></tr>
        <tr><td><code>7</code> / <code>8</code></td><td>Joint — a degree-2 point visited twice
          by the same boundary walk (both times still having usable points on each side).
          <code>7</code> marks the first visit, <code>8</code> the second.</td></tr>
        <tr><td><code>A–Z</code></td><td>Membrane — a degree-2 point shared between two
          different regions, both still having other usable points. The same letter marks its
          appearance on both sides.</td></tr>
        <tr><td><code>3, 4, 5, 6</code></td><td>Shorthand for small recurring clusters
          (DisaPoint, HollowPoint, SplitPoint, Triplet respectively) that would otherwise take
          several tokens to spell out. A struck-through <code>~3</code>/<code>~5</code> marks
          the point absorbed into the shorthand, shown on the board for reference but not
          written into the encoding text itself.</td></tr>
      </table>
      <p>Hovering a character in an encoding string highlights the matching point on the
      board, and vice versa — handy for matching an unfamiliar cluster of letters back to an
      actual spot on the sphere.</p>
    `,
  },
  {
    id: 'nimbers',
    title: 'What are Nimbers?',
    html: `
      <h3>What are Nimbers?</h3>
      <p>A nimber (or Grundy value) is a single non-negative integer that summarizes who wins a
      position and how, under normal-play combinatorial game theory. Sprouts is an
      <i>impartial</i> game — both players have exactly the same moves available from any given
      position, unlike e.g. chess where the pieces differ by side — so every position's outcome
      can be captured by one such number, computed recursively from its children:</p>
      <p style="text-align:center"><code>G(position) = mex { G(child) : child reachable by one move }</code></p>
      <p>"mex" is the <b>m</b>inimum <b>ex</b>cludant — the smallest non-negative integer that
      does <i>not</i> appear in the set. For example, if a position's children have nimbers
      <code>{0, 1, 3}</code>, then <code>mex{0,1,3} = 2</code> (0 and 1 are taken, 2 is the
      first gap), so the position's own nimber is 2. A position with a starting-set mex of 0
      (no moves at all, or every child already has nimber 0 excluded from... well, an empty set
      also mexes to 0) has <code>G = 0</code>, and is a loss for whoever's about to move — a
      "P-position." Any nonzero nimber means the player about to move can win.</p>
      <p>Nimbers are what make sums of independent pieces tractable: the nimber of a position
      made of several disconnected subpositions (the <code>⊕</code>-joined chunks in an
      ${jumpLink('encodings', 'encoding')}) is just the bitwise XOR of each piece's own nimber —
      the same <code>⊕</code> operation, not a coincidence of notation. That's why the Position
      Browser can report one nimber for an entire board even when the board has broken up into
      several separate pieces that could, in principle, be analyzed one at a time.</p>
    `,
  },
  {
    id: 'large-positions',
    title: 'Working with large positions',
    html: `
      <h3>A note on very large positions</h3>
      <p>The analysis engine names each membrane point with a single letter (<code>A</code>–<code>Z</code>),
      which caps it at 26 membranes within one connected piece of the board. This isn't expected
      to matter for normal play or alpha testing — reaching it would take a considerably larger
      and more tangled position than typical games produce, well beyond 8 starting spots. If you
      do somehow hit it, the engine reports an error rather than silently producing a wrong
      answer.</p>
    `,
  },
];

const TOPICS: GuideTopic[] = RAW_TOPICS.map(t => ({
  ...t,
  searchText: (t.title + ' ' + t.html.replace(/<[^>]+>/g, ' ')).toLowerCase(),
}));

let wired = false;
let activeId = TOPICS[0].id;
let query = '';

function matchesQuery(t: GuideTopic): boolean {
  return query === '' || t.searchText.includes(query);
}

function render(): void {
  const topicsEl = document.getElementById('guide-topics') as HTMLDivElement;
  const contentEl = document.getElementById('guide-content') as HTMLDivElement;

  const visible = TOPICS.filter(matchesQuery);

  topicsEl.innerHTML = '';
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'guide-no-results';
    empty.textContent = 'No topics match.';
    topicsEl.appendChild(empty);
  }
  for (const t of visible) {
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

/** Delegated so cross-reference links (`jumpLink`) work no matter which topic rendered them. */
function onContentClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const jump = target.closest<HTMLElement>('.guide-jump');
  if (!jump) return;
  const topicId = jump.dataset.topic;
  if (topicId && TOPICS.some(t => t.id === topicId)) {
    activeId = topicId;
    query = '';
    const searchEl = document.getElementById('guide-search') as HTMLInputElement | null;
    if (searchEl) searchEl.value = '';
    render();
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  const searchEl = document.getElementById('guide-search') as HTMLInputElement;
  searchEl.addEventListener('input', () => {
    query = searchEl.value.trim().toLowerCase();
    render();
  });
  const contentEl = document.getElementById('guide-content') as HTMLDivElement;
  contentEl.addEventListener('click', onContentClick);
}

/** Wire the topic list once; safe to call multiple times (each open just re-renders). */
export function initGuide(): void {
  wire();
  render();
}

/**
 * Open the Guide, optionally deep-linking straight to a topic. Other UI (e.g. a "?" hint button
 * next to a toggle) should call this rather than reaching into the overlay element directly.
 */
export function openGuide(topicId?: string): void {
  if (topicId && TOPICS.some(t => t.id === topicId)) {
    activeId = topicId;
    query = '';
  }
  initGuide();
  const overlay = document.getElementById('guide-overlay') as HTMLDivElement;
  overlay.classList.add('visible');
}

export function closeGuide(): void {
  const overlay = document.getElementById('guide-overlay') as HTMLDivElement;
  overlay.classList.remove('visible');
}

export function isGuideOpen(): boolean {
  const overlay = document.getElementById('guide-overlay') as HTMLDivElement;
  return overlay.classList.contains('visible');
}
