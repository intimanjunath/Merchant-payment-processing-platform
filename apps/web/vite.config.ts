import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dashboard calls the API under /api on its own origin; the proxy strips the
// prefix. Page paths such as /payments/:id stay with the app, so reloading a
// page never lands on the API's JSON. Same origin also keeps the session cookie
// first-party and lets the API's Origin check accept the dashboard.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
