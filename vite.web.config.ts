// The renderer: one build used by both Electron and the web server.
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { UserConfig } from 'vite';

export const webConfig: UserConfig = {
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  // markdown-it imports Node's punycode; use the browser-compatible package instead.
  resolve: { alias: { punycode: 'punycode/punycode.es6.js' } },
  build: { outDir: resolve(import.meta.dirname, 'out/renderer'), emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
  plugins: [react()],
};

export default webConfig;
