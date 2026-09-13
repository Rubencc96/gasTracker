import { defineConfig } from 'vite';

export default defineConfig({
  // Use relative base path for GitHub Pages compatibility
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
  },
});
