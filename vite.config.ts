import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Prints selected client diagnostics to the terminal running `vite dev` (dev only). */
function devClientLogPlugin(): Plugin {
  return {
    name: 'dev-client-log',
    configureServer(server) {
      server.middlewares.use('/__devtools_client_log', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(raw) as { scope?: string; payload?: unknown };
            console.info('[vite dev]', parsed.scope ?? 'client', parsed.payload ?? raw);
          } catch {
            console.info('[vite dev] client-log (invalid JSON)');
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Relative base so JS/CSS resolve correctly on GitHub Pages, previews, and subdirectory deploys
  base: './',
  plugins: [react(), ...(command === 'serve' ? [devClientLogPlugin()] : [])],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
}));
