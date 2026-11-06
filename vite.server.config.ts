// The web server (and the `check` command for CI), as one Node script.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'index.js', format: 'es' } },
  },
  // Bundle everything except vite itself (only used by --dev).
  ssr: { noExternal: true, external: ['vite'] },
});
