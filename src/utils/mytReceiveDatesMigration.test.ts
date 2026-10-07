import { describe, expect, it } from 'vitest';
import MIG from '../../supabase/migrations/20261007120000_069_myt_receive_dates.sql?raw';
import { PGlite } from '@electric-sql/pglite';


async function db(supplyUses = 3) {
  const pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  const body = Array.from({ length: supplyUses }, (_, i) => `d${i} := CURRENT_DATE;`).join(' ');
  const decl = Array.from({ length: supplyUses }, (_, i) => `d${i} date;`).join(' ');
  await pg.exec(`
    CREATE FUNCTION public.receive_supply_order(p_supply_order_id uuid, p_idempotency_key uuid DEFAULT NULL)
    RETURNS date LANGUAGE plpgsql AS $$ DECLARE ${decl} BEGIN ${body} RETURN d0; END $$;
    CREATE FUNCTION public.receive_po_shipment(p_po_id uuid, p_lines jsonb)
    RETURNS date LANGUAGE plpgsql AS $$ BEGIN RETURN CURRENT_DATE; END $$;`);
  return pg;
}

describe('069 MYT receive dates migration', () => {
  it('replaces every CURRENT_DATE with the Malaysia date', async () => {
    const pg = await db();
    await pg.exec(MIG);
    const defs = await pg.query<{ d: string }>(
      `select pg_get_functiondef(p.oid) d from pg_proc p where proname in ('receive_supply_order','receive_po_shipment')`
    );
    for (const r of defs.rows) {
      expect(r.d).not.toContain('CURRENT_DATE');
      expect(r.d).toContain("timezone('Asia/Kuala_Lumpur'");
    }
    const myt = await pg.query<{ ok: boolean }>(
      `select public.receive_po_shipment(null, null) = (timezone('Asia/Kuala_Lumpur', now()))::date
          and public.receive_supply_order(null) = (timezone('Asia/Kuala_Lumpur', now()))::date ok`
    );
    expect(myt.rows[0].ok).toBe(true);
  });

  it('MYT expression gives the next day at 00:40 MYT where CURRENT_DATE (UTC) does not', async () => {
    const pg = new PGlite();
    const r = await pg.query<{ myt: string; utc: string }>(
      `select (timezone('Asia/Kuala_Lumpur', t))::date::text myt, (t at time zone 'UTC')::date::text utc
         from (select '2026-05-04 16:40:57+00'::timestamptz t) x`
    );
    expect(r.rows[0]).toEqual({ myt: '2026-05-05', utc: '2026-05-04' });
  });

  it('aborts if the live body drifted', async () => {
    const pg = await db(2);
    await expect(pg.exec(MIG)).rejects.toThrow(/expected 3/);
  });
});
