import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:8787',
      '/batches': 'http://localhost:8787',
      '/strains': 'http://localhost:8787',
      '/milk-bases': 'http://localhost:8787',
      '/readings': 'http://localhost:8787',
      '/sync': 'http://localhost:8787',
      '/coordination': 'http://localhost:8787',
      '/sources': 'http://localhost:8787'
    }
  },
  build: { target: 'es2022' }
});
