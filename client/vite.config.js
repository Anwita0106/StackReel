import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export default defineConfig(({ mode }) => {
  // Read the SAME root .env as the API server, so changing PORT in one place
  // updates both the server and this dev proxy (this mismatch is what caused
  // "Backend unavailable" after moving the server to 5002).
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  const apiPort = env.PORT || '5001';
  const apiHost = env.HOST && env.HOST !== '0.0.0.0' ? env.HOST : '127.0.0.1';
  const apiTarget = env.VITE_PROXY_TARGET || `http://${apiHost}:${apiPort}`;
  const clientPort = Number(env.CLIENT_PORT || 5173);

  return {
    envDir: repoRoot,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': path.join(repoRoot, 'shared') } },
    server: {
      port: clientPort,
      strictPort: true, // fail loudly instead of silently moving to another port (which breaks CORS)
      fs: { allow: [repoRoot] },
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false, ws: false },
      },
    },
    preview: { port: clientPort, strictPort: true, proxy: { '/api': { target: apiTarget } } },
    build: {
      sourcemap: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: { flow: ['@xyflow/react'], motion: ['motion'] },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.js'],
      css: false,
      globals: true,
    },
  };
});
