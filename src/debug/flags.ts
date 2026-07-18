/**
 * Runtime debug flags. Flip these to surface verbose diagnostics on the console;
 * they default off so normal play (and Recreate playback) stays quiet.
 *
 * Exposed on `window.__sproutsDebug` so they can be toggled live from the console
 * without a rebuild, e.g. `__sproutsDebug.recreate = true`.
 */
export const DEBUG = {
  /** Per-move Recreate candidate/voronoi-fallback diagnostics (very chatty). */
  recreate: false,
};

if (typeof window !== 'undefined') {
  (window as unknown as { __sproutsDebug: typeof DEBUG }).__sproutsDebug = DEBUG;
}
