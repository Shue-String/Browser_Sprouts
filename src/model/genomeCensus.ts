// Genomes pane data: one row per (collection, offset) group of src/data/collectionElements.json --
// its genome, rep, element count, extra-adjusted-lives range, and how often it is used as a
// T-gene by other collections. Pure data, computed once from the JSON; src/ui/genomes.ts renders it.
import collectionElementsJson from '../data/collectionElements.json';
import { COLLECTION_GENOME_TEXT, storedGenomeText, type StoredGenome } from './collectAlpha';
import { adjustedLivesOf } from './ttree';

type Section = 'single' | 'double' | 'multi';
interface ElementsFile {
  maxShift: number;
  collections: {
    name: string;
    rep: string;
    genome?: StoredGenome;
    offsets: ({ offset: number } & Partial<Record<Section, { elements: { encoding: string }[] }>>)[];
  }[];
}
const DATA = collectionElementsJson as unknown as ElementsFile;
const SECTIONS: Section[] = ['single', 'double', 'multi'];

export interface GenomeCensusRow {
  name: string;          // collection name, e.g. "S_1"
  offset: number;
  group: string;         // "S_1" or "S_1⊕1"
  /** Genome text with unnamed (nested) T-genes dropped and counted as a final "+n" T-gene; null for
   * double-crit (Z_n) collections. */
  genome: string | null;
  rep: string;
  /** Elements in this group; the offset-0 group also counts the rep. */
  count: number;
  /** Extra-adjusted lives range, crit included (null when the group has no elements). */
  lo: number | null;
  hi: number | null;
  /** Collections listing this exact group as a direct (top-level) T-gene. */
  tHolders: number;
  /** Sum of those collections' offset-0 counts (rep included; their offset groups excluded). */
  tElements: number;
}

/** Lives a collection's crit(s) contribute. A flat 1 for now, double-crit (Z_n) collections
 * included; revisit if those should count each crit separately. */
const CRIT_LIVES = 1;

/** Extra-adjusted lives (total lives - #subpositions - #DisaPoints - #split points) plus
 * CRIT_LIVES. adjustedLivesOf already sums leftSideLives2 (the DisaPoint/split-point discount) and
 * subtracts only (#subpositions - 1), with crit letters at 0 -- so subtract the remaining 1. */
function eal(enc: string): number {
  return adjustedLivesOf(enc) - 1 + CRIT_LIVES;
}

/** A collection's genome text for the pane: named T-genes kept, each nested unnamed T genome
 * dropped and counted as a final "+n" T-gene, e.g. "[S_1,S_5,+2]". */
function genomeDisplay(name: string, g: StoredGenome | undefined): string | null {
  if (!g) return null;
  const named = g.T.filter(t => 'name' in t);
  const unnamed = g.T.length - named.length;
  if (!unnamed) return COLLECTION_GENOME_TEXT[name];
  // storedGenomeText always ends "...])": put the count inside the T brackets, after any names.
  const text = storedGenomeText({ ...g, T: named });
  return `${text.slice(0, -2)}${named.length ? ',' : ''}+${unnamed}])`;
}

const groupName = (name: string, offset: number) => (offset === 0 ? name : `${name}⊕${offset}`);

function buildRows(): GenomeCensusRow[] {
  // Direct T-gene groups per collection, and every group referenced anywhere (nested included) --
  // a referenced offset gets a row even with no elements of its own (e.g. S_2⊕1).
  const direct = new Map<string, Set<string>>();
  const referenced = new Set<string>();
  const collect = (g: StoredGenome, into?: Set<string>) => {
    for (const t of g.T) {
      if ('name' in t) {
        const n = groupName(t.name, t.shift ?? 0);
        referenced.add(n);
        into?.add(n);
      } else collect(t);
    }
  };
  for (const c of DATA.collections) {
    if (!c.genome) continue;
    const d = new Set<string>();
    collect(c.genome, d);
    direct.set(c.name, d);
  }

  const rows: GenomeCensusRow[] = [];
  for (const c of DATA.collections) {
    const offsets = new Set(c.offsets.map(o => o.offset));
    for (let k = 1; k <= DATA.maxShift; k++) if (referenced.has(groupName(c.name, k))) offsets.add(k);
    for (const offset of [...offsets].sort((a, b) => a - b)) {
      const o = c.offsets.find(x => x.offset === offset);
      const encs = SECTIONS.flatMap(s => o?.[s]?.elements.map(e => e.encoding) ?? []);
      if (offset === 0) encs.push(c.rep);
      const group = groupName(c.name, offset);
      if (!encs.length && !referenced.has(group)) continue;
      const lives = encs.map(eal);
      rows.push({
        name: c.name, offset, group,
        genome: genomeDisplay(c.name, c.genome),
        rep: c.rep,
        count: encs.length,
        lo: lives.length ? Math.min(...lives) : null,
        hi: lives.length ? Math.max(...lives) : null,
        tHolders: 0, tElements: 0,
      });
    }
  }

  const baseCount = new Map(rows.filter(r => r.offset === 0).map(r => [r.name, r.count]));
  for (const r of rows) {
    for (const [holder, genes] of direct) {
      if (!genes.has(r.group)) continue;
      r.tHolders++;
      r.tElements += baseCount.get(holder) ?? 0;
    }
  }
  return rows;
}

let cache: GenomeCensusRow[] | null = null;
export function genomeCensus(): GenomeCensusRow[] {
  return (cache ??= buildRows());
}
