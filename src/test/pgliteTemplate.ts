import { afterAll, afterEach, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

/**
 * Build a PGlite database ONCE per test file (in a hook, so the cold WASM start + initdb + migration
 * SQL is charged to hookTimeout, not to the first test), then hand each test a cheap clone
 * (~0.4 s instead of ~1.5-2 s for a fresh PGlite + re-running all setup SQL).
 *
 * Clones are closed after each test and the template after the file, so workers don't accumulate
 * WASM heaps. Session settings (SET ...) are not copied by clone(); pass them as `sessionSql`.
 */
export function pgliteTemplate(build: (pg: PGlite) => Promise<void>, sessionSql = `SET TimeZone='UTC';`) {
  let template: PGlite | undefined;
  const open: PGlite[] = [];

  beforeAll(async () => {
    template = await PGlite.create();
    await template.exec(sessionSql);
    await build(template);
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((pg) => pg.close()));
  });

  afterAll(async () => {
    await template?.close();
  });

  return async function fresh(): Promise<PGlite> {
    if (!template) throw new Error('pgliteTemplate: template not built (call fresh() inside a test)');
    // clone() is typed as PGliteInterface; it is a full PGlite instance at runtime.
    const pg = (await template.clone()) as PGlite;
    open.push(pg);
    await pg.exec(sessionSql);
    return pg;
  };
}
