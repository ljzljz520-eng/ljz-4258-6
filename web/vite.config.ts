import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
export default defineConfig({
  root: 'web',
  plugins: [solid()],
  server: { port: 5173, proxy: { '/auth': 'http://localhost:8080', '/commands': 'http://localhost:8080', '/sync': 'http://localhost:8080', '/state': 'http://localhost:8080', '/batches': 'http://localhost:8080', '/device': 'http://localhost:8080', '/health': 'http://localhost:8080' } },
  build: { outDir: '../dist', emptyOutDir: true },
});
