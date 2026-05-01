/**
 * Development-only: mirrors structured logs to the browser console and,
 * during `vite dev`, to the terminal via a dev-server middleware (see vite.config.ts).
 * Never send passwords or tokens.
 */
export function devClientLog(scope: string, payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.info(`[${scope}]`, payload);
  fetch('/__devtools_client_log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, payload }),
  }).catch(() => {});
}
