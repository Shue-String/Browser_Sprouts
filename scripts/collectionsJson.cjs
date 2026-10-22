// Shared reader/writer for src/data/collectionElements.json -- the single hand-maintained source
// of every registered Collection (its name, its genome, and its single-/double-/multi-region
// left-side elements). Schema:
//
//   { "maxShift": 3, "maxFoldDepth": 2,
//     "collections": [ {
//         "name": "S_1",
//         "rep": "2a",                              // the collection's ONE shared reduction target
//         "genome": { "R", "D", "L": [...], "Z": [...], "T": [ {"name","shift"?} | <nested genome> ] },
//                                                   // omitted for double-crit (Z_n) collections
//         "offsets": [ {
//             "offset": 0,
//             "single"?: { "notes"?, "elements": [ {encoding,minSpots} ] },
//             "double"?: { ...same shape... },
//             "multi"?:  { ...same shape... },
//             "unhandled"?: { ...same shape... } } ] } ] }
//
// "unhandled" holds genuine members the engine deliberately does NOT reduce (e.g. Z_3's
// [37β8α/, which shares its rep's left-side key, so registering it would make quickCanon swap
// the region back and forth forever). The engine and the generated WASM header never read this
// section; the UI lists these elements alongside the rest, marked as unhandled.
//
// `rep` lives once, on the collection -- never per section. An offset's display name is never
// stored: it is `name` for offset 0 and `name⊕offset` otherwise.
// Every genome is the engine's answer for the collection's rep (stalks/tools/genome_for_reps,
// refreshed by scripts/refreshGenomes.cjs). A genome whose T-genes are all collection names feeds
// the fold/collision registry (collectAlpha.ts's GENOME_DEFS, and natively
// stalks/tools/genome_defs.cpp, which reads this file at runtime); one still holding a nested,
// unnamed T genome can't be expressed there and is display-only. Collection order among the
// registry genomes is load-bearing.
const fs = require('fs');
const path = require('path');

const JSON_PATH = path.resolve(__dirname, '..', 'src', 'data', 'collectionElements.json');
const SECTIONS = ['single', 'double', 'multi', 'unhandled'];

function groupName(collectionName, offset) {
  return offset === 0 ? collectionName : `${collectionName}⊕${offset}`;
}

// A genome's T is a SET of T-genes: drop repeats (first occurrence kept), recursing into nested
// genomes first so two identical nested tuples compare equal. "S_1" and "S_1⊕1" are distinct
// T-genes, never merged. Mutates and returns `genome`.
function dedupeT(genome) {
  const canon = v => JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x);
  const seen = new Set();
  genome.T = genome.T.filter(t => {
    if (!('name' in t)) dedupeT(t);
    const k = canon(t);
    return !seen.has(k) && seen.add(k);
  });
  return genome;
}

// A genome's canonical "(R,D,{L},{Z},[T])" text -- L/Z/T sorted and deduped, a named T-child as
// "S_n" / "S_n⊕k" -- the same shape stalks/tools/alpha_genome.cpp's rootGenomeText prints.
function genomeText(g) {
  const nums = a => [...new Set(a)].sort((x, y) => x - y).join(',');
  const head = `(${g.R},${g.D},{${nums(g.L)}},{${nums(g.Z)}}`;
  if (!g.T) return head + ')';
  const t = [...new Set(g.T.map(c => ('name' in c ? groupName(c.name, c.shift ?? 0) : genomeText(c))))].sort();
  return `${head},[${t.join(',')}])`;
}

// Replaces every nested T genome whose text is identical to some collection's own stored genome
// with that collection's name ({name}), then re-dedupes T. Repeats until nothing changes, since a
// substitution can make another collection's genome text match a nested tuple elsewhere. The engine
// names a T-child only when the registry reduces it to a collection's rep, so a T-child with a
// collection's exact genome can still come back as a tuple; this names it by genome instead.
// Mutates `data`; returns the number of substitutions made.
function nameKnownGenomes(data) {
  let total = 0;
  for (;;) {
    const nameByText = new Map(data.collections.filter(c => c.genome).map(c => [genomeText(c.genome), c.name]));
    let changed = 0;
    const visit = g => {
      g.T = g.T.map(t => {
        if ('name' in t) return t;
        const name = nameByText.get(genomeText(t));
        if (name) { changed++; return { name }; }
        if (t.T) visit(t);
        return t;
      });
      dedupeT(g);
    };
    for (const c of data.collections) if (c.genome) visit(c.genome);
    total += changed;
    if (!changed) return total;
  }
}

function read() {
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
}

// Pretty-printed like JSON.stringify(_, null, 2), except a genome object is kept on one line (it is
// a tuple of numbers and names, unreadable when exploded across 30 lines) and each element of an
// "elements" array gets one line (there are thousands; exploded they triple the file size).
function serialize(data) {
  const inline = [];
  const stash = v => { inline.push(v); return `@@${inline.length - 1}@@`; };
  const text = JSON.stringify(data, (key, value) => {
    if (key === 'genome' && value && typeof value === 'object') return stash(JSON.stringify(value));
    if (key === 'elements' && Array.isArray(value)) return stash(value.map(e => JSON.stringify(e)));
    return value;
  }, 2);
  const NL = '\n';
  return text.replace(/^( *)("(?:genome|elements)": )"@@(\d+)@@"/gm, (_, indent, prefix, i) => {
    const v = inline[+i];
    if (typeof v === 'string') return indent + prefix + v;
    if (!v.length) return indent + prefix + '[]';
    return indent + prefix + '[' + NL + v.map(e => indent + '  ' + e).join(',' + NL) + NL + indent + ']';
  }) + NL;
}

function write(data) {
  fs.writeFileSync(JSON_PATH, serialize(data));
}

// Flatten to the per-section family lists the native header uses: [{rep, groups:[{name,offset,elements}]}]
// -- one family per (collection, section), in collection order; a section's groups are the offsets
// that have that section.
function flatFamilies(data, section) {
  const out = [];
  for (const c of data.collections) {
    const groups = c.offsets.filter(o => o[section]).map(o => ({
      name: groupName(c.name, o.offset),
      offset: o.offset,
      elements: o[section].elements,
    }));
    if (groups.length) out.push({ rep: c.rep, groups });
  }
  return out;
}

module.exports = { JSON_PATH, SECTIONS, groupName, dedupeT, genomeText, nameKnownGenomes, read, write, serialize, flatFamilies };
