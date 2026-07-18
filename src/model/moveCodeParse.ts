/**
 * Parses a Move Sequence string back into structured per-move data.
 *
 * This is the exact structural inverse of computeMoveCode (see moveCode.ts).
 * The full string produced by the UI is:
 *
 *     n:tok/tok/...
 *
 * where n is the starting spot count (prefixed so that starting spots which are
 * never played — and therefore leave no token — can still be recreated), and
 * each tok is a single move code:
 *
 *     lo[_sub] X hi[_sub] [[]] [(m) | ()] [s,...]
 *
 * Vertex ids are signed integers (original spots negative, midpoints positive),
 * so lo/hi/sub/m and the bracket entries may all carry a leading '-'.
 *
 * The parser is strict: any malformed token throws an Error naming the move
 * index (1-based) and the offending substring, so the Recreate dialog can show
 * a useful message rather than silently mis-replaying.
 */

import type { VertexId } from './types';

/**
 * One `[s,...]` bracket entry: either a single vertex id / spot label
 * (non-spot sub-boundaries, or an already-fixed spot), or a compact
 * "lo..hi" range naming an entire block of still-live, mutually symmetric
 * enclosed/outer spots (see spotGroupInfo in vertexLabels.ts). Only ever a
 * range when the sequence was recorded with labels (nL:) — raw-ID sequences
 * (n:) always emit plain single ids.
 */
export type BracketEntry = VertexId | { lo: VertexId; hi: VertexId };

export interface ParsedMove {
  /** Raw token text (without the trailing `{encoding}` Move Check tag, if any), kept verbatim for oracle comparison during synthesis. */
  token: string;
  /** Move Check tag `{encoding}` recorded after this move, or null if the sequence wasn't recorded in Move Check mode. */
  checkEncoding: string | null;
  lo: VertexId;
  hi: VertexId;
  /** Joint subscript on lo / hi, or null when the endpoint is not a joint. */
  loSub: VertexId | null;
  hiSub: VertexId | null;
  /** `[]` — split into a parallel-arc lens with no other vertices inside. */
  parallel: boolean;
  /**
   * Same-side-membrane disambiguator `(m)`:
   *   number       — the `m` vertex id / spot label (already fixed)
   *   {lo,hi}      — m is a still-live, still-symmetric spot named by its
   *                  range (only ever emitted by labelled sequences)
   *   'empty'      — `()` literally appeared (no qualifying m existed)
   *   null         — no parens present
   */
  parens: VertexId | { lo: VertexId; hi: VertexId } | 'empty' | null;
  /** `[s,...]` sub-boundary mins/ranges on the lo→hi arc side; null when absent. */
  brackets: BracketEntry[] | null;
}

/**
 * A ParsedMove with lo/hi/brackets fully resolved to raw vertex IDs (labels
 * looked up against the live label state during Recreate replay — see
 * resolveLabelToVertexId / resolveBracketEntry in vertexLabels.ts). This is
 * what every downstream consumer (candidate synthesis, hints, oracle
 * comparison) actually operates on; ParsedMove is only the raw parse output.
 */
export interface ResolvedMove extends Omit<ParsedMove, 'brackets' | 'parens'> {
  brackets: VertexId[] | null;
  parens: VertexId | 'empty' | null;
}

export interface ParsedSequence {
  spots: number;
  /** True when the "n:" prefix carried the "L" marker — lo/hi/brackets are
   *  spot LABELS (need resolving to raw vertex IDs during replay) rather than
   *  raw vertex IDs. See src/model/vertexLabels.ts. */
  useLabels: boolean;
  /** True when the "n:" prefix carried the "C" (Move Check) marker — every
   *  move token carries a trailing `{encoding}` tag that Recreate should
   *  verify against the actual resulting position. */
  useCheck: boolean;
  moves: ParsedMove[];
}

const INT = String.raw`-?\d+`;

/** Parse the full `n:tok/tok/...` string. Throws on any malformed input. */
export function parseMoveSequence(input: string): ParsedSequence {
  const raw = input.trim();
  if (raw.length === 0) throw new Error('Empty move sequence.');

  const colon = raw.indexOf(':');
  if (colon < 0) {
    throw new Error("Missing 'n:' spot-count prefix (expected e.g. \"3:0X-1/...\").");
  }
  let spotsStr = raw.slice(0, colon).trim();
  let useLabels = false;
  let useCheck = false;
  // Trailing marker letters (order-independent): "L" = spot-labelled tokens,
  // "C" = Move Check ({encoding} tags present, verify during Recreate).
  while (spotsStr.length > 0 && /[LC]$/.test(spotsStr)) {
    const marker = spotsStr[spotsStr.length - 1];
    if (marker === 'L') useLabels = true; else useCheck = true;
    spotsStr = spotsStr.slice(0, -1);
  }
  if (!/^\d+$/.test(spotsStr)) {
    throw new Error(`Invalid spot count "${spotsStr}" before ':'.`);
  }
  const spots = parseInt(spotsStr, 10);
  if (spots < 1 || spots > 26) {
    throw new Error(`Spot count ${spots} out of range (1–26).`);
  }

  const body = raw.slice(colon + 1).trim();
  const moves: ParsedMove[] = [];
  if (body.length === 0) return { spots, useLabels, useCheck, moves };

  const tokens = body.split('/');
  tokens.forEach((tok, i) => {
    const t = tok.trim();
    if (t.length === 0) throw new Error(`Move ${i + 1}: empty token.`);
    moves.push(parseToken(t, i + 1));
  });

  return { spots, useLabels, useCheck, moves };
}

/** Parse one move token. `index` is 1-based for error messages. */
export function parseToken(token: string, index: number): ParsedMove {
  const fail = (why: string): never => {
    throw new Error(`Move ${index} ("${token}"): ${why}`);
  };

  // Strip a trailing Move Check tag `{encoding}` before parsing the move
  // grammar proper — it's appended after everything else by computeMoveCode's
  // caller and isn't part of the move code itself.
  let core = token;
  let checkEncoding: string | null = null;
  const braceM = /^(.*)\{([^{}]*)\}$/.exec(token);
  if (braceM) {
    core = braceM[1];
    checkEncoding = braceM[2];
  }

  // Exactly one 'X' separates the two endpoints (vertex ids never contain 'X').
  const xPos = core.indexOf('X');
  if (xPos < 0) fail("missing 'X' separator");
  if (core.indexOf('X', xPos + 1) >= 0) fail("more than one 'X'");

  const loPart = core.slice(0, xPos);
  const rest = core.slice(xPos + 1);

  const loM = new RegExp(`^(${INT})(?:_(${INT}))?$`).exec(loPart);
  if (!loM) fail(`unparseable lo endpoint "${loPart}"`);
  const lo = parseInt(loM![1], 10);
  const loSub = loM![2] !== undefined ? parseInt(loM![2], 10) : null;

  // hi endpoint sits at the start of `rest`; whatever follows is the suffix.
  const hiM = new RegExp(`^(${INT})(?:_(${INT}))?`).exec(rest);
  if (!hiM) fail(`unparseable hi endpoint in "${rest}"`);
  const hi = parseInt(hiM![1], 10);
  const hiSub = hiM![2] !== undefined ? parseInt(hiM![2], 10) : null;
  const suffix = rest.slice(hiM![0].length);

  let parallel = false;
  let parens: VertexId | { lo: VertexId; hi: VertexId } | 'empty' | null = null;
  let brackets: BracketEntry[] | null = null;

  if (suffix.length > 0) {
    if (suffix === '[]') {
      parallel = true;
      brackets = [];
    } else {
      // Optional (m)/() then a required [...] bracket. m may itself be a
      // compact spot-label range (e.g. "(-4..-2)") when m is a still-live,
      // still-symmetric spot in a labelled sequence.
      const sM = new RegExp(`^(?:\\((${INT}(?:\\.\\.${INT})?)?\\))?\\[([-\\d,.]*)\\]$`).exec(suffix);
      if (!sM) fail(`unrecognized suffix "${suffix}"`);
      if (sM![0].startsWith('(')) {
        const pRaw = sM![1];
        if (pRaw === undefined) {
          parens = 'empty';
        } else {
          const pRangeM = new RegExp(`^(${INT})\\.\\.(${INT})$`).exec(pRaw);
          parens = pRangeM
            ? { lo: parseInt(pRangeM[1], 10), hi: parseInt(pRangeM[2], 10) }
            : parseInt(pRaw, 10);
        }
      }
      const inner = sM![2];
      brackets = inner.length === 0
        ? []
        : inner.split(',').map(s => {
            // Compact spot-label range, e.g. "-5..-3" (only ever emitted by
            // labelled sequences — see BracketEntry).
            const rangeM = new RegExp(`^(${INT})\\.\\.(${INT})$`).exec(s);
            if (rangeM) return { lo: parseInt(rangeM[1], 10), hi: parseInt(rangeM[2], 10) };
            if (!new RegExp(`^${INT}$`).test(s)) fail(`bad bracket entry "${s}"`);
            return parseInt(s, 10);
          });
    }
  }

  return { token: core, checkEncoding, lo, hi, loSub, hiSub, parallel, parens, brackets };
}
