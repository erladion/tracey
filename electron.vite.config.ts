import { defineConfig } from 'electron-vite';
import { webConfig } from './vite.web.config';

export default defineConfig({
  main: {
    // Bundle dependencies: the packaged app ships without node_modules.
    build: { externalizeDeps: false, rollupOptions: { input: 'src/main/index.ts' } },
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  // The same renderer is served by the web server (src/server).
  renderer: webConfig,
});
