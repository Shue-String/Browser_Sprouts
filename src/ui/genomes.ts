// Genomes window: a sortable, filterable table of every collection/offset group (see
// src/model/genomeCensus.ts for what each column means).
import { genomeCensus, type GenomeCensusRow } from '../model/genomeCensus';

type SortKey = 'group' | 'genome' | 'rep' | 'offset' | 'count' | 'lo' | 'hi' | 'tHolders' | 'tElements';
const COLS: { k: SortKey; label: string; num?: boolean; title?: string }[] = [
  { k: 'group', label: 'Name' },
  { k: 'genome', label: 'Genome' },
  { k: 'rep', label: 'Rep' },
  { k: 'offset', label: 'Offset', num: true },
  { k: 'count', label: 'Count', num: true, title: 'Elements in this group; the offset-0 row also counts the rep' },
  { k: 'lo', label: 'Min EAL', num: true, title: 'Lowest extra-adjusted lives, crit counted as one life' },
  { k: 'hi', label: 'Max EAL', num: true, title: 'Highest extra-adjusted lives, crit counted as one life' },
  { k: 'tHolders', label: 'Genomes', num: true, title: 'Collections with this exact group as a direct T-gene' },
  { k: 'tElements', label: 'Their elements', num: true, title: "Those collections' offset-0 elements, reps included" },
];
const TEXT_KEYS: ReadonlySet<SortKey> = new Set(['group', 'genome', 'rep']);

let sort: { k: SortKey; dir: 1 | -1 } = { k: 'group', dir: 1 };
let wired = false;

const nameKey = (r: GenomeCensusRow): [string, number, number] => {
  const m = /^([A-Z])_(\d+)/.exec(r.name);
  return m ? [m[1], +m[2], r.offset] : [r.name, 0, r.offset];
};
function byName(a: GenomeCensusRow, b: GenomeCensusRow): number {
  const x = nameKey(a), y = nameKey(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
function cmp(a: GenomeCensusRow, b: GenomeCensusRow): number {
  if (sort.k === 'group') return byName(a, b) * sort.dir;
  // A missing value sorts lowest within its own kind ('' for text columns), so the order stays total.
  const missing = TEXT_KEYS.has(sort.k) ? '' : -1;
  const x = a[sort.k] ?? missing, y = b[sort.k] ?? missing;
  return x === y ? byName(a, b) : (x < y ? -1 : 1) * sort.dir;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (v: number | null) => `<td class="num${v ? '' : ' genomes-zero'}">${v ?? '—'}</td>`;

function render(): void {
  const q = (document.getElementById('genomes-filter') as HTMLInputElement).value.trim().toLowerCase();
  const showOff = (document.getElementById('genomes-show-offsets') as HTMLInputElement).checked;
  const onlyT = (document.getElementById('genomes-only-t') as HTMLInputElement).checked;
  const all = genomeCensus();
  const rows = all
    .filter(r => (showOff || !r.offset) && (!onlyT || r.tHolders) &&
      (!q || [r.group, r.genome ?? '', r.rep].some(s => s.toLowerCase().includes(q))))
    .sort(cmp);

  (document.getElementById('genomes-head') as HTMLTableRowElement).innerHTML = COLS.map(c => {
    const arrow = sort.k === c.k ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
    return `<th class="${c.num ? 'num' : ''}"${c.title ? ` title="${esc(c.title)}"` : ''}><button data-k="${c.k}">${c.label}${arrow}</button></th>`;
  }).join('');

  (document.getElementById('genomes-body') as HTMLTableSectionElement).innerHTML = rows.map(r => {
    const off = r.offset ? `<span class="genomes-off">⊕${r.offset}</span>` : '';
    const genome = r.genome ? esc(r.genome) : '<span class="genomes-zero">none (double-crit)</span>';
    return `<tr class="${r.offset ? 'genomes-offset-row' : ''}">` +
      `<td class="genomes-name">${esc(r.name)}${off}</td>` +
      `<td class="genomes-genome">${genome}</td>` +
      `<td class="genomes-mono">${esc(r.rep)}</td>` +
      `<td class="num">${r.offset}</td><td class="num">${r.count}</td>` +
      num(r.lo) + num(r.hi) + num(r.tHolders) + num(r.tElements) + '</tr>';
  }).join('');

  const base = all.filter(r => !r.offset).length;
  (document.getElementById('genomes-status') as HTMLDivElement).textContent =
    `${rows.length} of ${all.length} rows · ${base} collections, ${all.length - base} offset groups. ` +
    'Click a column heading to sort; hover a heading for its definition.';
}

export function initGenomes(): void {
  if (wired) return;
  wired = true;
  document.getElementById('genomes-head')!.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const k = b.dataset.k as SortKey;
    sort = sort.k === k ? { k, dir: sort.dir > 0 ? -1 : 1 } : { k, dir: TEXT_KEYS.has(k) ? 1 : -1 };
    render();
  });
  for (const id of ['genomes-filter', 'genomes-show-offsets', 'genomes-only-t'])
    document.getElementById(id)!.addEventListener('input', render);
  render();
}
