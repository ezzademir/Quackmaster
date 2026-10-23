import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import MIG from '../../supabase/migrations/20261023130000_081_po_receipt_variance.sql?raw';
import ROLLBACK from '../../supabase/rollback/081_po_receipt_variance_rollback.sql?raw';

const PO = '00000000-0000-0000-0000-00000000a001';
const L1 = '00000000-0000-0000-0000-00000000b001';
const L2 = '00000000-0000-0000-0000-00000000b002';
const RM = '00000000-0000-0000-0000-00000000c001';
const RM2 = '00000000-0000-0000-0000-00000000c002';

const SCHEMA = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE test_ctx (uid uuid, staff boolean, admin boolean);
INSERT INTO test_ctx VALUES ('00000000-0000-0000-0000-0000000000e1', true, false);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT uid FROM test_ctx $$;
CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT staff OR admin FROM test_ctx $$;
CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT admin FROM test_ctx $$;
CREATE TABLE data_ledger (id serial, action text, entity_type text, entity_id text, module text, operation text,
  reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb, metadata jsonb);
CREATE FUNCTION public._append_data_ledger(a text, et text, eid text, m text, op text, ref text,
  b jsonb, af jsonb, d jsonb, md jsonb) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO data_ledger(action,entity_type,entity_id,module,operation,reference_id,before_data,after_data,delta_data,metadata)
     VALUES (a,et,eid,m,op,ref,b,af,d,md) $$;
CREATE TABLE suppliers (id uuid primary key, name text);
CREATE TABLE raw_materials (id uuid primary key, name text, cost_price numeric(12,2), weighted_avg_unit_cost numeric(14,4), updated_at timestamptz);
CREATE TABLE purchase_orders (id uuid primary key, supplier_id uuid, status text, expected_delivery_date date,
  actual_delivery_date date, updated_at timestamptz);
CREATE TABLE purchase_order_items (id uuid primary key, purchase_order_id uuid, raw_material_id uuid,
  quantity_ordered numeric(10,2), quantity_received numeric(10,2), unit_price numeric(12,2), line_total numeric(15,2));
CREATE TABLE hub_inventory (id uuid primary key default gen_random_uuid(), raw_material_id uuid, quantity_on_hand numeric,
  reserved_quantity numeric default 0, available_quantity numeric, last_updated timestamptz, updated_at timestamptz,
  created_at timestamptz default now());
CREATE VIEW supplier_scorecard_metrics AS SELECT poi.quantity_received FROM purchase_order_items poi;
`;

let pg: PGlite;
const q = async <T = Record<string, unknown>>(sql: string) => (await pg.query<T>(sql)).rows;
const rpc = async (sql: string) => (await q<{ r: Record<string, unknown> }>(`select ${sql} r`))[0].r;
const hub = async () => Number((await q<{ v: string }>(`select quantity_on_hand v from hub_inventory where raw_material_id='${RM}'`))[0].v);
const asAdmin = (a: boolean) => pg.exec(`update test_ctx set admin=${a}`);
const recv = (qty: number, reason?: string) =>
  rpc(`receive_po_shipment('${PO}', '[{"purchase_order_item_id":"${L1}","quantity_received":${qty}${reason ? `,"reason":"${reason}"` : ''}}]'::jsonb)`);

const SEED = `
    INSERT INTO suppliers VALUES ('00000000-0000-0000-0000-0000000000d1','S');
    INSERT INTO raw_materials VALUES ('${RM}','G',3,3,now()), ('${RM2}','E',1,1,now());
    INSERT INTO purchase_orders VALUES ('${PO}','00000000-0000-0000-0000-0000000000d1','ordered',null,null,now());
    INSERT INTO purchase_order_items VALUES ('${L1}','${PO}','${RM}',315,0,3,945);
    INSERT INTO hub_inventory (raw_material_id, quantity_on_hand, reserved_quantity, available_quantity) VALUES ('${RM}',100,50,50);`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIG);
  return db;
}

beforeAll(async () => {
  pg = await freshDb();
}, 60000);

beforeEach(async () => {
  await pg.exec(`TRUNCATE suppliers, raw_materials, purchase_orders, purchase_order_items, hub_inventory, data_ledger;
    UPDATE test_ctx SET admin=false; UPDATE procurement_settings SET over_receipt_tolerance_pct = 10;` + SEED);
});

describe('081 receive_po_shipment v2', () => {
  it('posts the full entered over-receipt within tolerance', async () => {
    const r = await recv(320);
    expect(r.success).toBe(true);
    expect(r.status).toBe('received');
    expect(await hub()).toBe(420);
  });

  it('rejects beyond tolerance for staff, and for admin without a reason', async () => {
    expect((await recv(400)).error).toBe('over_tolerance_needs_admin_reason');
    await asAdmin(true);
    expect((await recv(400)).error).toBe('over_tolerance_needs_admin_reason');
    expect(await hub()).toBe(100);
    const ok = await recv(400, 'supplier sent extra sack');
    expect(ok.success).toBe(true);
    expect(await hub()).toBe(500);
  });

  it('honours a configured tolerance', async () => {
    await pg.exec(`update procurement_settings set over_receipt_tolerance_pct = 0`);
    expect((await recv(316)).error).toBe('over_tolerance_needs_admin_reason');
  });

  it('is idempotent when the same total is submitted twice', async () => {
    await recv(313);
    await recv(313);
    expect(await hub()).toBe(413);
  });

  it('writes exactly one ledger row with entered, previous, delta and reason', async () => {
    await recv(313);
    const rows = await q<{ delta_data: { lines: Array<Record<string, unknown>> } }>(`select delta_data from data_ledger`);
    expect(rows).toHaveLength(1);
    const line = rows[0].delta_data.lines[0];
    expect(Number(line.entered_received)).toBe(313);
    expect(Number(line.previous_received)).toBe(0);
    expect(Number(line.posted_delta)).toBe(313);
    expect(Number(line.short_received)).toBe(2);
  });

  it('keeps 4-decimal quantities exactly', async () => {
    await recv(314.3135);
    const [row] = await q<{ v: string }>(`select quantity_received::text v from purchase_order_items where id='${L1}'`);
    expect(row.v).toBe('314.3135');
    expect(await hub()).toBeCloseTo(414.3135, 6);
  });

  it('updates weighted average cost on over-receipt', async () => {
    await pg.exec(`update purchase_order_items set unit_price = 4 where id='${L1}'`);
    await recv(330);
    const [r] = await q<{ v: string }>(`select weighted_avg_unit_cost v from raw_materials where id='${RM}'`);
    expect(Number(r.v)).toBeCloseTo((100 * 3 + 330 * 4) / 430, 4);
  });

  it('sets status per line: one over, one short is still partial', async () => {
    await pg.exec(`insert into purchase_order_items values ('${L2}','${PO}','${RM2}',100,0,1,100)`);
    const r = await rpc(`receive_po_shipment('${PO}', '[{"purchase_order_item_id":"${L1}","quantity_received":330},{"purchase_order_item_id":"${L2}","quantity_received":90}]'::jsonb)`);
    expect(r.status).toBe('partial');
  });

  it('refuses a received PO (edits go through adjust_po_receipt)', async () => {
    await recv(315);
    expect((await recv(310)).error).toBe('po_not_receivable');
  });
});

describe('081 close_po_short', () => {
  it('closes a partial PO with a reason and posts no stock', async () => {
    await recv(313);
    await asAdmin(true);
    expect((await rpc(`close_po_short('${PO}', '  ')`)).error).toBe('reason_required');
    const r = await rpc(`close_po_short('${PO}', 'supplier short 2kg')`);
    expect(r.status).toBe('closed_short');
    expect(await hub()).toBe(413);
    const [po] = await q<{ status: string }>(`select status from purchase_orders`);
    expect(po.status).toBe('closed_short');
  });

  it('refuses a non-partial PO', async () => {
    await asAdmin(true);
    expect((await rpc(`close_po_short('${PO}', 'x')`)).error).toBe('po_not_partial');
  });
});

describe('081 close_po_short is admin-only (Ezzad, 23 Oct)', () => {
  it('staff cannot close short: RPC refuses, PO stays partial, no ledger row, no stock change', async () => {
    await recv(300);
    const before = await hub();
    const r = await rpc(`close_po_short('${PO}', 'supplier short')`);
    expect(r).toEqual({ success: false, error: 'admin_required' });
    const [po] = await q<{ status: string }>(`select status from purchase_orders`);
    expect(po.status).toBe('partial');
    const [l] = await q<{ n: number }>(`select count(*)::int n from data_ledger where action='closed_short'`);
    expect(l.n).toBe(0);
    expect(await hub()).toBe(before);
  });

  it('RLS: staff cannot write status closed_short directly; admin can', async () => {
    await recv(300);
    await pg.exec(`ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS t_all ON purchase_orders;
      CREATE POLICY t_all ON purchase_orders FOR ALL TO authenticated USING (true) WITH CHECK (true);
      GRANT SELECT, UPDATE ON purchase_orders, test_ctx TO authenticated;`);
    try {
      await pg.exec('SET ROLE authenticated');
      await expect(pg.exec(`update purchase_orders set status='closed_short' where id='${PO}'`)).rejects.toThrow(/row-level security/);
      await pg.exec(`update purchase_orders set updated_at=now() where id='${PO}'`); // other edits unaffected
      await pg.exec('RESET ROLE');
      await asAdmin(true);
      await pg.exec('SET ROLE authenticated');
      await pg.exec(`update purchase_orders set status='closed_short' where id='${PO}'`);
    } finally {
      await pg.exec('RESET ROLE; DROP POLICY t_all ON purchase_orders; ALTER TABLE purchase_orders DISABLE ROW LEVEL SECURITY;');
    }
    const [po] = await q<{ status: string }>(`select status from purchase_orders`);
    expect(po.status).toBe('closed_short');
  });
});

describe('081 PO-0032: 315 -> 320.974 kg at an unchanged invoice total', () => {
  // seed: hub 100 kg @ avg 3 (50 reserved); PO line 315 kg @ 3 = 945
  const num = async (sql: string) => Number((await q<{ v: string }>(sql))[0].v);
  const line = () => q<{ qr: string; up: string; lt: string }>(
    `select quantity_received qr, unit_price up, line_total lt from purchase_order_items where id='${L1}'`);
  const wac = () => num(`select weighted_avg_unit_cost v from raw_materials where id='${RM}'`);
  const hubValue = async () => (await hub()) * (await wac());

  async function check(dispatched: number) {
    await recv(315);
    expect(await hub()).toBe(415);
    expect(await wac()).toBe(3);
    if (dispatched > 0) await pg.exec(`update hub_inventory set quantity_on_hand = quantity_on_hand - ${dispatched} where raw_material_id='${RM}'`);
    const hubBefore = await hub();
    const valueBefore = await hubValue();
    const ledgerBefore = await num(`select count(*) v from data_ledger`);

    await asAdmin(true);
    const r = await rpc(`adjust_po_receipt('${L1}', 320.974, 'PO-0032 reweigh, invoice total unchanged', true)`);
    expect(r.success).toBe(true);
    expect(Number(r.posted_delta)).toBe(5.974);

    // hub rises by exactly the difference
    expect(Math.round(((await hub()) - hubBefore) * 10000) / 10000).toBe(5.974);
    expect(await hub()).toBe(Math.round((hubBefore + 5.974) * 10000) / 10000);
    // receipt total value unchanged
    const [l] = await line();
    expect(Number(l.qr)).toBe(320.974);
    expect(Number(l.lt)).toBe(945);
    // unit price repriced over 320.974 (column is numeric(12,2) live -> 2.94)
    expect(Number(l.up)).toBe(Math.round((945 / 320.974) * 100) / 100);
    // average cost repriced: on-hand value unchanged, spread over the larger quantity
    const expectedWac = Math.round(((hubBefore * 3) / (hubBefore + 5.974)) * 10000) / 10000;
    expect(await wac()).toBe(expectedWac);
    expect(Math.abs((await hubValue()) - valueBefore)).toBeLessThan(0.05);
    // one ledger row, delta only
    expect((await num(`select count(*) v from data_ledger`)) - ledgerBefore).toBe(1);
    const [led] = await q<{ d: Record<string, unknown> }>(`select delta_data d from data_ledger where action='receipt_adjusted'`);
    expect(Number(led.d.posted_delta)).toBe(5.974);
    expect(Number(led.d.line_total_before)).toBe(945);
    expect(Number(led.d.line_total_after)).toBe(945);
    return expectedWac;
  }

  it('nothing dispatched: +5.974 kg, value 945 kept, WAC = (100*3 + 945) / 420.974', async () => {
    const w = await check(0);
    // equals the other 100 kg @ 3 blended with the receipt repriced over 320.974
    expect(w).toBe(Math.round(((100 * 3 + (945 / 320.974) * 320.974) / 420.974) * 10000) / 10000);
    console.log(`PO-0032 (0 dispatched): hub ${await hub()} kg, WAC ${w}, line 320.974 kg = MYR 945`);
  });

  it('200 kg of the 315 already dispatched: still only +5.974 kg posted, value kept', async () => {
    const w = await check(200);
    expect(await hub()).toBe(220.974);
    console.log(`PO-0032 (200 dispatched): hub ${await hub()} kg, WAC ${w}, line 320.974 kg = MYR 945`);
  });

  it('default (invoice total not kept) still posts the delta at the line price', async () => {
    await recv(315);
    await asAdmin(true);
    await rpc(`adjust_po_receipt('${L1}', 320.974, 'extra delivered and invoiced')`);
    const [l] = await line();
    expect(Number(l.lt)).toBe(Math.round(320.974 * 3 * 100) / 100);
    expect(await wac()).toBe(3);
  });
});

describe('081 adjust_po_receipt', () => {
  it('requires admin and a reason', async () => {
    await recv(315);
    expect((await rpc(`adjust_po_receipt('${L1}', 313, 'x')`)).error).toBe('admin_required');
    await asAdmin(true);
    expect((await rpc(`adjust_po_receipt('${L1}', 313, '')`)).error).toBe('reason_required');
  });

  it('posts only the delta, both directions, with before/after in the ledger', async () => {
    await recv(315);
    await asAdmin(true);
    const down = await rpc(`adjust_po_receipt('${L1}', 313, 'weighed 313')`);
    expect(Number(down.posted_delta)).toBe(-2);
    expect(down.status).toBe('partial');
    expect(await hub()).toBe(413);
    await rpc(`adjust_po_receipt('${L1}', 318, 'recount')`);
    expect(await hub()).toBe(418);
    const [l] = await q<{ b: string; a: string }>(
      `select before_data->>'quantity_received' b, after_data->>'quantity_received' a from data_ledger where action='receipt_adjusted' order by id desc limit 1`);
    expect([Number(l.b), Number(l.a)]).toEqual([313, 318]);
  });

  it('blocks a reduction below reserved and changes nothing', async () => {
    await recv(315);
    await asAdmin(true);
    await pg.exec(`update hub_inventory set reserved_quantity = 400`);
    const r = await rpc(`adjust_po_receipt('${L1}', 200, 'wrong entry')`);
    expect(r.error).toBe('hub_below_reserved');
    expect(await hub()).toBe(415);
    const [i] = await q<{ v: string }>(`select quantity_received v from purchase_order_items`);
    expect(Number(i.v)).toBe(315);
  });

  it('keeps closed_short unless the line becomes fully received', async () => {
    await recv(300);
    await asAdmin(true);
    await rpc(`close_po_short('${PO}', 'short')`);
    expect((await rpc(`adjust_po_receipt('${L1}', 305, 'found a sack')`)).status).toBe('closed_short');
    expect((await rpc(`adjust_po_receipt('${L1}', 315, 'rest found')`)).status).toBe('received');
  });
});

describe('081 grants and rollback', () => {
  it('does not let clients call the internal hub helper', async () => {
    const [r] = await q<{ ok: boolean }>(`select has_function_privilege('authenticated','public._po_apply_hub_delta(uuid,numeric,numeric)','EXECUTE') ok`);
    expect(r.ok).toBe(false);
  });

  it('rollback restores the 076 function and 2-decimal columns', async () => {
    pg = await freshDb();
    await pg.exec(ROLLBACK);
    const [t] = await q<{ t: string }>(`select format_type(atttypid, atttypmod) t from pg_attribute where attrelid='purchase_order_items'::regclass and attname='quantity_received'`);
    expect(t.t).toBe('numeric(10,2)');
    const [f] = await q<{ n: number }>(`select count(*)::int n from pg_proc where proname in ('close_po_short','adjust_po_receipt')`);
    expect(f.n).toBe(0);
    expect((await recv(320)).error).toBe('received_exceeds_ordered');
  }, 30000);
});
