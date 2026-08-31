// Mechanically transcribes src/data/collectionElements.json (the single hand-authored source of
// every registered Advanced Collection element -- see collections.cpp's singleCritFamilies/
// doubleCritFamilies/multiCritFamilies doc comments) into
// stalks/src/collection_elements.generated.hpp: a compile-time C++ literal with the exact same
// shape, in the exact same order (order only matters for allCollectionRosters()'s introspection
// dump ordering -- the matching registries below key off a std::map, order-independent there).
//
// This script does NO derivation -- it only reshapes JSON into C++ struct-literal syntax (same
// role as scripts/genGenomeDefsHeader.cjs plays for src/data/genomeDefs.json). The JSON's "notes"
// fields (hand-written provenance commentary: date added, verification method, why a candidate
// was rejected/removed) are intentionally NOT transcribed here -- they document the dataset for
// humans reading the JSON, not runtime data, and this generated file is machine output.
//
// Run after editing collectionElements.json: `node scripts/genCollectionElementsHeader.cjs`

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const JSON_PATH = path.join(REPO_ROOT, 'src', 'data', 'collectionElements.json');
const OUT_PATH = path.join(REPO_ROOT, 'stalks', 'src', 'collection_elements.generated.hpp');

function cppStr(s) {
  // Left-side encodings and family/group names are plain ASCII plus U+2295 (⊕); escape only what
  // C++ needs (fs.writeFileSync below writes UTF-8, so ⊕ round-trips as-is).
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function elementsLiteral(elements) {
  return '{' + elements.map(cppStr).join(', ') + '}';
}

function groupLiteral(g) {
  return `{${cppStr(g.name)}, ${g.offset}, ${elementsLiteral(g.elements)}}`;
}

function familyLiteral(fam) {
  const groups = fam.groups.map(groupLiteral).join(', ');
  return `{${cppStr(fam.rep)}, {${groups}}}`;
}

function familiesFunction(fnName, families) {
  const entries = families.map(fam => '        ' + familyLiteral(fam) + ',').join('\n');
  return `const std::vector<CritFamily>& ${fnName}() {
    static const std::vector<CritFamily> families = {
${entries}
    };
    return families;
}`;
}

function generate() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  const sections = [
    ['single', 'singleCritFamilies'],
    ['double', 'doubleCritFamilies'],
    ['multi', 'multiCritFamilies'],
  ];

  const body = sections.map(([key, fnName]) => familiesFunction(fnName, data[key])).join('\n\n');

  const header = `// GENERATED FILE -- do not hand-edit.
// Produced by scripts/genCollectionElementsHeader.cjs from src/data/collectionElements.json (the
// single hand-authored source of every registered Advanced Collection element -- see that file's
// "notes" fields for provenance commentary not reproduced here). Re-run that script after editing
// the JSON, then rebuild any target that includes this header (it's #included directly inside
// collections.cpp's anonymous namespace, right after the RosterGroup/CritFamily definitions).

${body}
`;

  fs.writeFileSync(OUT_PATH, header, 'utf8');
  let groups = 0, elements = 0;
  for (const [key] of sections)
    for (const fam of data[key])
      for (const g of fam.groups) { groups++; elements += g.elements.length; }
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_PATH)} (${data.single.length + data.double.length + data.multi.length} families, ${groups} groups, ${elements} elements)`);
}

generate();
