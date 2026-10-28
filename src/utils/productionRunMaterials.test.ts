import { describe, expect, it } from 'vitest';
import { saveRunMaterialsOrRollback, type MaterialsClient } from './productionRunMaterials';

function fake(opts: { insertErr?: string; deleteRunErr?: string; updateErr?: string }) {
  const log: string[] = [];
  const err = (m?: string) => ({ error: m ? { message: m } : null });
  const client: MaterialsClient = {
    from: (t) => ({
      insert: async () => { log.push(`insert ${t}`); return err(opts.insertErr); },
      delete: () => ({ eq: async (c, v) => { log.push(`delete ${t} ${c}=${v}`); return err(t === 'production_runs' ? opts.deleteRunErr : undefined); } }),
      update: (u) => ({ eq: async (c, v) => { log.push(`update ${t} ${u.status} ${c}=${v}`); return err(opts.updateErr); } }),
    }),
  };
  return { client, log };
}
const rows = [{ production_run_id: 'r1', raw_material_id: 'm1', quantity_consumed: 139.05 }];

describe('saveRunMaterialsOrRollback (A-09)', () => {
  it('ok when insert succeeds, no rollback', async () => {
    const f = fake({});
    expect(await saveRunMaterialsOrRollback(f.client, 'r1', rows)).toEqual({ ok: true });
    expect(f.log).toEqual(['insert production_run_materials']);
  });
  it('insert error → deletes run and fails (completion must not proceed)', async () => {
    const f = fake({ insertErr: 'network' });
    const r = await saveRunMaterialsOrRollback(f.client, 'r1', rows);
    expect(r).toMatchObject({ ok: false, rolledBack: 'deleted' });
    expect(f.log).toContain('delete production_runs id=r1');
  });
  it('delete blocked → falls back to cancelled', async () => {
    const f = fake({ insertErr: 'x', deleteRunErr: 'rls' });
    expect(await saveRunMaterialsOrRollback(f.client, 'r1', rows)).toMatchObject({ ok: false, rolledBack: 'cancelled' });
  });
  it('all rollback fails → still reports failure', async () => {
    const f = fake({ insertErr: 'x', deleteRunErr: 'a', updateErr: 'b' });
    expect(await saveRunMaterialsOrRollback(f.client, 'r1', rows)).toMatchObject({ ok: false, rolledBack: 'failed' });
  });
  it('no materials → ok without DB call', async () => {
    const f = fake({});
    expect(await saveRunMaterialsOrRollback(f.client, 'r1', [])).toEqual({ ok: true });
    expect(f.log).toEqual([]);
  });
});
