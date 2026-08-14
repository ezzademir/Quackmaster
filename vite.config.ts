/// <reference types="vitest/config" />
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

const pagesBaseRaw = process.env.VITE_PAGES_BASE_PATH?.trim() ?? '';

// https://vitejs.dev/guide/build#public-base-path — GitHub project Pages needs an absolute base
function resolveBase(command: string): string {
  if (command !== 'build' || !pagesBaseRaw) return './';
  return pagesBaseRaw.endsWith('/') ? pagesBaseRaw : `${pagesBaseRaw}/`;
}

export default defineConfig(({ command }) => ({
  base: resolveBase(command),
  plugins: [react(), ...(command === 'serve' ? [devClientLogPlugin()] : [])],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react-router')) return 'router';
          if (id.includes('lucide-react')) return 'lucide';
        },
      },
    },
  },
}));
