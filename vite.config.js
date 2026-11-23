import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Libraries change far less often than game code, so browsers keep them cached between releases
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          physics: ['cannon-es'],
          map: ['leaflet'],
        },
      },
    },
    chunkSizeWarningLimit: 600, // three.js alone is ~550 kB minified
  }
});
