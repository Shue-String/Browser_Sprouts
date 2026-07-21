// Quick filter pass over master_meta.json: find canonical encodings whose
// "life" count (per src/model/collectGenetics.ts's countLives) is 5, 6, or 7
// AND that contain at least one DisaPoint. Pure JS port of the relevant logic
// from collectGenetics.ts (parseEncoding / findDisaPoints / countLives) —
// no WASM needed for this filtering step.

const fs = require('fs');

function parseEncoding(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed.split('+');
  return parts.map(part => {
    const inner = part.startsWith('[') && part.endsWith(']') ? part.slice(1, -1) : part;
    return inner.split('|').map(regionStr => regionStr.split(',').map(b => b.split('')));
  });
}

function countTokens(components) {
  let n = 0;
  for (const regions of components)
    for (const boundaries of regions)
      for (const tokens of boundaries) n += tokens.length;
  return n;
}

function findDisaPoints(components) {
  const detachedByLetter = new Map();
  for (let c = 0; c < components.length; c++) {
    for (let r = 0; r < components[c].length; r++) {
      const region = components[c][r];
      if (region.length === 1 && region[0].length === 2) {
        const [a, b] = region[0];
        const letter = a === '2' ? b : b === '2' ? a : null;
        if (letter && /^[A-Z]$/.test(letter)) detachedByLetter.set(`${c}:${letter}`, { component: c, region: r });
      }
    }
  }
  const refs = [];
  for (let c = 0; c < components.length; c++) {
    for (let r = 0; r < components[c].length; r++) {
      for (let b = 0; b < components[c][r].length; b++) {
        const boundary = components[c][r][b];
        for (let t = 0; t < boundary.length; t++) {
          const letter = boundary[t];
          const det = detachedByLetter.get(`${c}:${letter}`);
          if (!det) continue;
          if (det.component === c && det.region === r) continue;
          refs.push({ component: c, region: r, boundary: b, token: t, letter, detached: det });
        }
      }
    }
  }
  return refs;
}

function countLives(components, disaPoints) {
  return countTokens(components) - 2 * disaPoints.length;
}

const file = process.argv[2] || 'stalks/saves/master_meta.json';
const raw = fs.readFileSync(file, 'utf8');
console.error(`read ${raw.length} bytes, parsing...`);
const data = JSON.parse(raw);
const keys = Object.keys(data);
console.error(`parsed ${keys.length} entries, filtering...`);

const buckets = { 5: [], 6: [], 7: [] };
let checked = 0;
for (const key of keys) {
  checked++;
  if (checked % 500000 === 0) console.error(`  ...${checked}/${keys.length}`);
  let parsed;
  try {
    parsed = parseEncoding(key);
  } catch {
    continue;
  }
  const dps = findDisaPoints(parsed);
  if (dps.length === 0) continue;
  const lives = countLives(parsed, dps);
  if (buckets[lives]) buckets[lives].push(key);
}

for (const life of [5, 6, 7]) {
  console.error(`life=${life}: ${buckets[life].length} candidate positions`);
}
fs.writeFileSync('scratch_candidates.json', JSON.stringify(buckets));
console.error('wrote scratch_candidates.json');
