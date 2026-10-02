// Exports a range of collections (default S_2..S_10) to a standalone, compilable LaTeX document:
// one section per collection S_n, laid out as two aligned columns -- left is the base collection,
// right is its "+1" offset collection (omitted when it has no elements, as the Collections panel
// does). Each column opens with the collection's name + genome; the base's rep (the shared
// reduction target) is the first row, in bold; elements follow in the panel's own order, row i of
// the left column sitting level with row i of the right so a collection and its offset start
// together.
//
// Everything shown is read from the same registry the Collect pane's Collections panel uses
// (KNOWN_COLLECTION_MEMBERS / KNOWN_COLLECTION_REP / the genome-text tables in
// src/model/collectAlpha.ts, ultimately src/data/collectionElements.json), and element text goes
// through the app's own shiftMembraneLetters (membrane letters shifted two forward, so A -> C, the
// paper's convention -- applied only to shapes that contain an A, since some registry entries are
// already lettered from C) and toLatexSymbols (alpha/oplus/brace escaping) -- nothing is
// re-implemented here. The TS is bundled on the fly with esbuild, so no build step is needed first.
//
// Usage: node scripts/exportCollectionsLatex.cjs [--from 2] [--to 10] [--out notes/collections_S2-S10.tex] [--pdf]
//   --pdf: also compile the result with pdflatex (cleans up its aux/log files).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const from = Number(opt('from', 2));
const to = Number(opt('to', 10));
const outPath = path.resolve(ROOT, opt('out', `notes/collections_S${from}-S${to}.tex`));
const BS = String.fromCharCode(92); // LaTeX backslash

// Bundle the real app modules (no DOM is touched at import time) into a throwaway CJS file.
const src = (rel) => JSON.stringify(path.join(ROOT, 'src', rel).split(path.sep).join('/'));
const bundleFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collex-')), 'bundle.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export * from ${src('model/collectAlpha')}; export { toLatexSymbols } from ${src('ui/collect')};`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundleFile, logLevel: 'error',
});
const m = require(bundleFile);

// Inline math; `bold` uses \boldsymbol since \textbf has no effect on math-mode text.
const math = (s, bold = false) => {
  const body = m.toLatexSymbols(s);
  return bold ? `$${BS}boldsymbol{${body}}$` : `$${body}$`;
};
// A collection's elements, shown the paper's way: membrane letters start at C. A shape still lettered
// from A is shifted two forward; one that already starts at C (the registry holds both) is left alone,
// since shifting it again would start it at E.
const element = (s, bold = false) => math(s.includes('A') ? m.shiftMembraneLetters(s) : s, bold);
const genomeOf = (name) => m.NAMED_FAMILY_GENOME_TEXT[name] ?? m.COLLECTION_GENOME_TEXT[name];

const header = (name) => `${math(name, true)}${BS}quad ${math(genomeOf(name))}`;

// One collection's column: [rep (bold), ...elements] as ready-to-print LaTeX cells.
function column(name) {
  const rep = m.KNOWN_COLLECTION_REP[name];
  const cells = (m.KNOWN_COLLECTION_MEMBERS[name] ?? []).map(e => element(e));
  return rep ? [`${element(rep, true)} ${BS}quad (rep)`, ...cells] : cells;
}

const colSpec = `>{${BS}raggedright${BS}arraybackslash}p{.47${BS}textwidth}`;
const lines = [
  String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,array,longtable}
\setlength{\parindent}{0pt}
\begin{document}`,
  `${BS}section*{Collections ${math(`S_${from}`)} through ${math(`S_${to}`)}}`,
  String.raw`Each collection's name is followed by its genome $(R,D,\{L\},\{Z\},[T])$; its elements are listed below, with the shared rep (bold) first. The left column is the collection itself; the right column is its $\oplus 1$ offset (superscript $1$) when that has elements, started level with the left. A superscript on a T-gene name is likewise its $\oplus$ offset. Membrane letters begin at C.
`,
];

for (let n = from; n <= to; n++) {
  const base = `S_${n}`;
  const offset = `${base}⊕1`;
  const left = column(base);
  const right = (m.KNOWN_COLLECTION_MEMBERS[offset] ?? []).length > 0 ? column(offset) : [];
  lines.push(`${BS}begin{longtable}{@{}${colSpec}@{${BS}hspace{2em}}${colSpec}@{}}`);
  // "\\*" forbids a page break after the header row.
  lines.push(`${header(base)} & ${right.length ? header(offset) : ''} ${BS}${BS}*[4pt]`);
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) lines.push(`${left[i] ?? ''} & ${right[i] ?? ''} ${BS}${BS}`);
  lines.push(`${BS}end{longtable}`, '');
}
lines.push(`${BS}end{document}`, '');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'));
fs.rmSync(path.dirname(bundleFile), { recursive: true, force: true });
console.log(`wrote ${path.relative(ROOT, outPath)}`);

if (args.includes('--pdf')) {
  const dir = path.dirname(outPath);
  const stem = path.basename(outPath, '.tex');
  // longtable needs two passes to settle its column widths.
  for (let pass = 0; pass < 2; pass++) {
    execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', path.basename(outPath)], { cwd: dir, stdio: 'ignore' });
  }
  for (const ext of ['aux', 'log']) fs.rmSync(path.join(dir, `${stem}.${ext}`), { force: true });
  console.log(`wrote ${path.relative(ROOT, path.join(dir, `${stem}.pdf`))}`);
}
