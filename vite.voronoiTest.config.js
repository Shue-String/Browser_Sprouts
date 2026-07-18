import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// vite-plugin-singlefile does not support multiple entry points in one config
// (it forces output.inlineDynamicImports, which Rollup rejects for multi-input
// builds) — so voronoiTest.html gets its own build pass into the same dist/.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: 'voronoiTest.html',
    },
  },
});
