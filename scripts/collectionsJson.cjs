// Shared reader/writer for src/data/collectionElements.json -- the single hand-maintained source
// of every registered Collection (its name, its genome, and its single-/double-/multi-region
// left-side elements). Schema:
//
//   { "maxShift": 3, "maxFoldDepth": 2,
//     "collections": [ {
//         "name": "S_1",
//         "rep": "2a",                              // the collection's ONE shared reduction target
//         "genome": { "R", "D", "L": [...], "Z": [...], "T": [ {"name","shift"?} | <nested genome> ],
//                     "derived"?: true },          // omitted for double-crit (Z_n) collections
//         "offsets": [ {
//             "offset": 0,
//             "single"?: { "notes"?, "elements": [ {encoding,minSpots} ] },
//             "double"?: { ...same shape... },
//             "multi"?:  { ...same shape... } } ] } ] }
//
// `rep` lives once, on the collection -- never per section. An offset's display name is never
// stored: it is `name` for offset 0 and `name⊕offset` otherwise.
// genome.derived marks a genome computed by stalks/tools/genome_for_reps (a snapshot of the
// engine's answer, regenerable) rather than hand-authored -- only hand-authored genomes feed the
// native genome_defs header (declaration order among those is load-bearing, see
// scripts/genGenomeDefsHeader.cjs).
const fs = require('fs');
const path = require('path');

const JSON_PATH = path.resolve(__dirname, '..', 'src', 'data', 'collectionElements.json');
const SECTIONS = ['single', 'double', 'multi'];

function groupName(collectionName, offset) {
  return offset === 0 ? collectionName : `${collectionName}⊕${offset}`;
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

module.exports = { JSON_PATH, SECTIONS, groupName, read, write, serialize, flatFamilies };
