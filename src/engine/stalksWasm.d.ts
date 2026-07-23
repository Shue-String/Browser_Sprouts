// Hand-written types for the Emscripten-generated ./stalksWasm.js (from stalks/build_wasm.bat).
// The generated file is a committed build artifact; this declaration describes its shape so the
// TypeScript wrapper (stalks.ts) can import it without `any`. The name intentionally differs from
// the stalks.ts wrapper — a sibling stalks.js/stalks.d.ts would collide with stalks.ts under
// bundler/TS module resolution (./stalks.js would resolve to the wrapper, not the artifact).

/** The instantiated engine module. `analyze`/`canon` are the embind-bound C++ functions. */
export interface StalksModule {
  /** Analyze an encoding; returns a JSON string (see analyze.cpp / AnalysisResult in stalks.ts). */
  analyze(enc: string): string;
  /** On-demand full (exact) analysis up to 16 lives; same JSON shape as analyze's ok result. */
  analyzeFull(enc: string): string;
  /** On-demand quick-canon nimber up to 16 lives; returns a QuickAnalysis JSON (see stalks.ts). */
  analyzeNimber(enc: string): string;
  /**
   * Children of `enc`'s LITERAL parsed structure (no canonicalize() pre-step, unlike analyze) --
   * see childrenTrackedJson in analyze.cpp / stalks.ts. `enc` must already be decompressed.
   */
  childrenTracked(enc: string): string;
  /**
   * Every legal move of `enc`'s component `component` touching the token at (region, boundary,
   * token), valued the same way -- see regionMovesTrackedJson in analyze.cpp / stalks.ts. `enc`
   * must already be decompressed.
   */
  regionMovesTracked(enc: string, component: number, region: number, boundary: number, token: number): string;
  /**
   * Every legal move of `enc`'s ENTIRE position, across every component, valued the same way --
   * unlike childrenTracked, NOT deduped by canonical result. See allMovesTrackedJson in
   * analyze.cpp / stalks.ts. `enc` must already be decompressed.
   */
  allMovesTracked(enc: string): string;
  /** Canonicalize an encoding; returns the bracketless canonical serialization ("" on parse error). */
  canon(enc: string): string;
  /**
   * Apply one tracked move to a decompressed parent and return the decompressed-canonical child
   * encoding plus provenance, as JSON (see applyMoveTracked in wasm_api.cpp / stalks.ts). `psrcJson`
   * is a 4-level nested int array [component][region][boundary][token] parallel to the parent.
   * kind: 0 = Enclosure (reads region, a=boundary, i, j, mask), 1 = Join (reads region, a=b1, b=b2,
   * i, j; mask ignored).
   */
  applyMoveTracked(
    parentEnc: string,
    psrcJson: string,
    kind: number,
    comp: number,
    region: number,
    a: number,
    b: number,
    i: number,
    j: number,
    mask: number,
  ): string;
  /**
   * Canonicalize an already-decompressed encoding (no pseudo-points) and return the canonical form
   * plus provenance mapping each canonical character back to its index in the INPUT string (see
   * canonicalizeTrackedProvenance in wasm_api.cpp / stalks.ts).
   */
  canonicalizeTrackedProvenance(enc: string): string;
}

/** Async factory: instantiates the WASM and resolves to the module. */
declare const createStalksModule: (overrides?: Record<string, unknown>) => Promise<StalksModule>;
export default createStalksModule;
