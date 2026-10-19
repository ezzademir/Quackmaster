import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import SCHEMA from '../../supabase/migrations/20261019140000_078_batch_trace_schema.sql?raw';
import FUNCS from '../../supabase/migrations/20261019140100_079_batch_trace_functions.sql?raw';
import RB078 from '../../supabase/rollbacks/078_rollback.sql?raw';
import RB079 from '../../supabase/rollbacks/079_rollback.sql?raw';
import LIVE_DEPS from '../../supabase/tests/fixtures/batch_trace_live_deps.sql?raw';

/** Minimal tables + stubs matching production columns used by the batch RPCs. */
const BASE = `
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-0000000000aa'::uuid $$;
CREATE TABLE outlets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE production_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_number text, production_date date, created_at timestamptz DEFAULT now());
CREATE TABLE inventory_lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_batch_label text, expiry_date date,
  manufactured_at timestamptz, production_run_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE hub_inventory (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), raw_material_id uuid, product_batch text, lot_id uuid,
  quantity_on_hand numeric DEFAULT 0, reserved_quantity numeric DEFAULT 0, available_quantity numeric,
  last_updated timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE hub_inventory_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hub_inventory_id uuid NOT NULL, reference_type text NOT NULL,
  reference_id uuid NOT NULL, quantity numeric NOT NULL, reason text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (hub_inventory_id, reference_type, reference_id));
CREATE TABLE supply_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supply_order_number text, outlet_id uuid, dispatch_date date DEFAULT CURRENT_DATE,
  received_date date, status text DEFAULT 'pending', total_quantity numeric, notes text, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), supply_date date DEFAULT CURRENT_DATE);
CREATE TABLE supply_order_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supply_order_id uuid, hub_inventory_id uuid,
  product_batch text, quantity numeric, created_at timestamptz DEFAULT now());
CREATE TABLE outlet_inventory (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid, product_batch text, quantity_on_hand numeric DEFAULT 0,
  reserved_quantity numeric DEFAULT 0, available_quantity numeric, last_updated timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), lot_id uuid, raw_material_id uuid);
CREATE TABLE sales_journals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid NOT NULL, business_date date NOT NULL, status text DEFAULT 'posted',
  notes text, idempotency_key uuid, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), source text DEFAULT 'manual');
CREATE TABLE sales_journal_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_journal_id uuid NOT NULL, product_batch text NOT NULL, lot_id uuid,
  quantity_sold numeric NOT NULL, created_at timestamptz DEFAULT now(), outlet_inventory_id uuid);
CREATE TABLE waste_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_kind text NOT NULL, outlet_id uuid, waste_date date, status text DEFAULT 'posted',
  notes text, idempotency_key uuid, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE waste_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), waste_event_id uuid NOT NULL, hub_inventory_id uuid, outlet_id uuid,
  product_batch text NOT NULL, quantity numeric NOT NULL, waste_reason text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE outlet_stock_take_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid NOT NULL, count_date date NOT NULL DEFAULT CURRENT_DATE, notes text,
  idempotency_key uuid, created_by uuid, created_at timestamptz DEFAULT now(), posted_at timestamptz DEFAULT now());
CREATE TABLE outlet_stock_take_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, outlet_inventory_id uuid NOT NULL,
  system_qoh_before numeric NOT NULL, counted_qty numeric NOT NULL, variance numeric NOT NULL, line_remark text);
CREATE TABLE ledger_calls (action text, entity_type text, after_data jsonb, metadata jsonb);
CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.is_supervisor_for_outlet(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.profile_can_post_outlet_stock_take(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.fg_recipe_sku(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'KT'::text $$;
CREATE TABLE movement_ctx (outlet_id uuid, movement_type text, business_date date, reference_type text, reference_id uuid, metadata jsonb);
CREATE FUNCTION public._set_outlet_movement_ctx(uuid, text, date, text, uuid, jsonb DEFAULT NULL) RETURNS void LANGUAGE sql
  AS $$ INSERT INTO movement_ctx VALUES ($1, $2, $3, $4, $5, $6) $$;
CREATE FUNCTION public._clear_outlet_movement_ctx() RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public._post_stock_take_snapshot_hook(uuid, date) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public._append_data_ledger(p_action text, p_entity_type text, p_entity_id text, p_module text, p_operation text,
  p_reference_id text, p_before jsonb, p_after jsonb, p_delta jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
  RETURNS void LANGUAGE sql AS $$ INSERT INTO ledger_calls VALUES (p_action, p_entity_type, p_after, p_metadata) $$;
`;

const OUTLET = '00000000-0000-0000-0000-0000000000b1';
const TODAY = `(timezone('Asia/Kuala_Lumpur', now()))::date`;

/** Production state before this PR: live bodies (from the 079 rollback) + live deps. */
const liveDb = pgliteTemplate(async (pg) => {
  await pg.exec(BASE);
  await pg.exec(LIVE_DEPS);
  await pg.exec(RB079);
  await pg.exec(`INSERT INTO outlets (id, name) VALUES ('${OUTLET}', 'TTDI');`);
});

/** Same live state with 078 + 079 applied. */
const migratedDb = pgliteTemplate(async (pg) => {
  await pg.exec(BASE);
  await pg.exec(LIVE_DEPS);
  await pg.exec(RB079);
  await pg.exec(`INSERT INTO outlets (id, name) VALUES ('${OUTLET}', 'TTDI');`);
  await pg.exec(SCHEMA);
  await pg.exec(FUNCS);
});

/** Hub batch: run RUN-<run>, expiry = MYT today + offset days. Returns hub_inventory id. */
async function batch(pg: PGlite, run: number, expiryOffset: number | null, qoh: number, createdAt = 'now()') {
  const r = await pg.query<{ hub: string }>(`
    WITH pr AS (INSERT INTO production_runs (run_number) VALUES ('RUN-${String(run).padStart(4, '0')}') RETURNING id),
    il AS (INSERT INTO inventory_lots (product_batch_label, expiry_date, manufactured_at, production_run_id)
           SELECT 'KT-LOT-${run}', ${expiryOffset === null ? 'NULL' : `${TODAY} + ${expiryOffset}`}, now(), id FROM pr RETURNING id)
    INSERT INTO hub_inventory (product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity, last_updated, created_at)
    SELECT 'KT', id, ${qoh}, 0, ${qoh}, ${createdAt}, ${createdAt} FROM il RETURNING id AS hub`);
  return r.rows[0].hub;
}

/** Pending order whose creation-time preview reserved `qty` on `hubId`. */
async function order(pg: PGlite, hubId: string, qty: number) {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO supply_orders (supply_order_number, outlet_id, status, total_quantity) VALUES ('SO-T', '${OUTLET}', 'pending', ${qty}) RETURNING id`
  );
  const id = r.rows[0].id;
  await pg.exec(`
    INSERT INTO supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity) VALUES ('${id}', '${hubId}', 'KT', ${qty});
    SELECT public.reserve_inventory('${hubId}', LEAST(${qty}, available_quantity), 'supply_order', '${id}', 'test')
    FROM hub_inventory WHERE id = '${hubId}';`);
  return id;
}

async function dispatch(pg: PGlite, id: string) {
  const r = await pg.query<{ j: Record<string, unknown> }>(`SELECT public.dispatch_supply_order('${id}') j`);
  return r.rows[0].j;
}

async function lines(pg: PGlite, id: string) {
  const r = await pg.query<{ label: string; qty: number; expired: boolean | null; lot_matches: boolean }>(`
    SELECT il.product_batch_label label, sol.quantity::float qty, sol.expired_at_dispatch expired,
           (sol.lot_id IS NOT DISTINCT FROM hi.lot_id) lot_matches
    FROM supply_order_lines sol JOIN hub_inventory hi ON hi.id = sol.hub_inventory_id
    LEFT JOIN inventory_lots il ON il.id = sol.lot_id
    WHERE sol.supply_order_id = '${id}' ORDER BY il.product_batch_label`);
  return r.rows;
}

describe('079 dispatch_supply_order re-picks at dispatch', () => {
  it('ignores the creation-time pick, splits across batches oldest-expiry first, records lot_id', async () => {
    const pg = await migratedDb();
    const b112 = await batch(pg, 112, 3, 48);
    const b113 = await batch(pg, 113, 3, 68);
    const b114 = await batch(pg, 114, 5, 566);
    const so = await order(pg, b114, 150); // preview wrongly held the newest batch

    const res = await dispatch(pg, so);
    expect(res.success).toBe(true);
    expect(res.expired_lines).toBe(0);
    expect(await lines(pg, so)).toEqual([
      { label: 'KT-LOT-112', qty: 48, expired: false, lot_matches: true },
      { label: 'KT-LOT-113', qty: 68, expired: false, lot_matches: true },
      { label: 'KT-LOT-114', qty: 34, expired: false, lot_matches: true },
    ]);
    const hub = await pg.query<{ id: string; q: number; r: number; a: number }>(
      `SELECT id, quantity_on_hand::float q, reserved_quantity::float r, available_quantity::float a FROM hub_inventory`
    );
    const byId = Object.fromEntries(hub.rows.map((h) => [h.id, h]));
    expect(byId[b112]).toMatchObject({ q: 0, r: 0, a: 0 });
    expect(byId[b113]).toMatchObject({ q: 0, r: 0, a: 0 });
    expect(byId[b114]).toMatchObject({ q: 532, r: 0, a: 532 });
    const resv = await pg.query(`SELECT 1 FROM hub_inventory_reservations WHERE reference_id = '${so}'`);
    expect(resv.rows).toHaveLength(0);
    const st = await pg.query<{ status: string; ok: boolean }>(
      `SELECT status, dispatch_date = ${TODAY} ok FROM supply_orders WHERE id = '${so}'`
    );
    expect(st.rows[0]).toEqual({ status: 'dispatched', ok: true });
  });

  it('equal expiry: lower run number ships first even when it was created later', async () => {
    const pg = await migratedDb();
    await batch(pg, 113, 3, 68, `now() - interval '2 days'`);
    const b112 = await batch(pg, 112, 3, 48, `now()`);
    const so = await order(pg, b112, 50);
    await dispatch(pg, so);
    expect((await lines(pg, so)).map((l) => [l.label, l.qty])).toEqual([
      ['KT-LOT-112', 48],
      ['KT-LOT-113', 2],
    ]);
  });

  it('all batches expired: dispatch is NOT blocked, lines are flagged and counted', async () => {
    const pg = await migratedDb();
    const old = await batch(pg, 90, -5, 30);
    await batch(pg, 91, -1, 30);
    await batch(pg, 92, 0, 30); // expires today (MYT): not expired
    const so = await order(pg, old, 70);
    const res = await dispatch(pg, so);
    expect(res).toMatchObject({ success: true, expired_lines: 2, expired_qty: 60 });
    expect((await lines(pg, so)).map((l) => [l.label, l.qty, l.expired])).toEqual([
      ['KT-LOT-90', 30, true],
      ['KT-LOT-91', 30, true],
      ['KT-LOT-92', 10, false],
    ]);
    const led = await pg.query<{ m: { expired_lines: number } }>(
      `SELECT metadata m FROM ledger_calls WHERE action = 'dispatched'`
    );
    expect(led.rows[0].m.expired_lines).toBe(2);
  });

  it('respects other orders\u2019 holds and RAISEs atomically on shortfall', async () => {
    const pg = await migratedDb();
    const b1 = await batch(pg, 1, 3, 50);
    const b2 = await batch(pg, 2, 4, 20);
    await order(pg, b1, 40); // another pending order holds 40 of batch 1
    const so = await order(pg, b2, 20);
    const ok = await dispatch(pg, so);
    expect(ok.success).toBe(true);
    expect((await lines(pg, so)).map((l) => [l.label, l.qty])).toEqual([
      ['KT-LOT-1', 10],
      ['KT-LOT-2', 10],
    ]);

    const so2 = await order(pg, b2, 10);
    await pg.exec(`UPDATE supply_order_lines SET quantity = 999 WHERE supply_order_id = '${so2}'`);
    await expect(dispatch(pg, so2)).rejects.toThrow(/insufficient_hub_quantity: KT short by/);
    const st = await pg.query<{ status: string }>(`SELECT status FROM supply_orders WHERE id = '${so2}'`);
    expect(st.rows[0].status).toBe('pending');
    const resv = await pg.query<{ q: number }>(
      `SELECT quantity::float q FROM hub_inventory_reservations WHERE reference_id = '${so2}'`
    );
    expect(resv.rows).toEqual([{ q: 10 }]); // hold untouched after rollback
  });

  it('raw-material lines still fulfil their own reservation', async () => {
    const pg = await migratedDb();
    const r = await pg.query<{ id: string }>(
      `INSERT INTO hub_inventory (raw_material_id, quantity_on_hand, reserved_quantity, available_quantity)
       VALUES (gen_random_uuid(), 10, 0, 10) RETURNING id`
    );
    const so = await order(pg, r.rows[0].id, 4);
    expect((await dispatch(pg, so)).success).toBe(true);
    const h = await pg.query<{ q: number; r: number }>(
      `SELECT quantity_on_hand::float q, reserved_quantity::float r FROM hub_inventory WHERE id = '${r.rows[0].id}'`
    );
    expect(h.rows[0]).toEqual({ q: 6, r: 0 });
  });

  it('receive_supply_order (unchanged) credits the outlet with the batches actually shipped', async () => {
    const pg = await migratedDb();
    await batch(pg, 112, 3, 48);
    const b114 = await batch(pg, 114, 5, 100);
    const so = await order(pg, b114, 60);
    await dispatch(pg, so);
    const rec = await pg.query<{ j: { success: boolean } }>(`SELECT public.receive_supply_order('${so}') j`);
    expect(rec.rows[0].j.success).toBe(true);
    const oi = await pg.query<{ label: string; q: number }>(`
      SELECT il.product_batch_label label, oi.quantity_on_hand::float q FROM outlet_inventory oi
      JOIN inventory_lots il ON il.id = oi.lot_id WHERE oi.outlet_id = '${OUTLET}' ORDER BY 1`);
    expect(oi.rows).toEqual([
      { label: 'KT-LOT-112', q: 48 },
      { label: 'KT-LOT-114', q: 12 },
    ]);
  });
});

async function outletRow(pg: PGlite, run: number, expiryOffset: number, qoh: number, createdAt: string) {
  const hub = await batch(pg, run, expiryOffset, 0);
  const r = await pg.query<{ id: string }>(`
    INSERT INTO outlet_inventory (outlet_id, product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity, created_at)
    SELECT '${OUTLET}', 'KT', lot_id, ${qoh}, 0, ${qoh}, ${createdAt} FROM hub_inventory WHERE id = '${hub}' RETURNING id`);
  return r.rows[0].id;
}

describe('079 outlet sales, waste and stock take keep the batch', () => {
  it('post_sales_journal: equal expiry consumes the lower run number first', async () => {
    const pg = await migratedDb();
    await outletRow(pg, 113, 3, 20, `now() - interval '2 days'`);
    const o112 = await outletRow(pg, 112, 3, 20, `now()`);
    const r = await pg.query<{ j: { success: boolean } }>(
      `SELECT public.post_sales_journal('${OUTLET}', ${TODAY}, '[{"product_batch":"KT","quantity_sold":25}]'::jsonb) j`
    );
    expect(r.rows[0].j.success).toBe(true);
    const sl = await pg.query<{ oi: string; q: number }>(
      `SELECT outlet_inventory_id oi, quantity_sold::float q FROM sales_journal_lines ORDER BY quantity_sold DESC`
    );
    expect(sl.rows[0]).toEqual({ oi: o112, q: 20 });
    expect(sl.rows[1].q).toBe(5);
  });

  it('live sales body (before 079) picked the older-created row on a tie', async () => {
    const pg = await liveDb();
    const o113 = await outletRow(pg, 113, 3, 20, `now() - interval '2 days'`);
    await outletRow(pg, 112, 3, 20, `now()`);
    await pg.query(`SELECT public.post_sales_journal('${OUTLET}', ${TODAY}, '[{"product_batch":"KT","quantity_sold":5}]'::jsonb)`);
    const sl = await pg.query<{ oi: string }>(`SELECT outlet_inventory_id oi FROM sales_journal_lines`);
    expect(sl.rows[0].oi).toBe(o113);
  });

  it('post_waste_event records outlet_inventory_id + lot_id (FIFO and explicit) and hub lot_id', async () => {
    const pg = await migratedDb();
    const o1 = await outletRow(pg, 1, 1, 5, 'now()');
    const o2 = await outletRow(pg, 2, 2, 5, 'now()');
    const hub = await batch(pg, 3, 4, 10);
    await pg.query(`SELECT public.post_waste_event('outlet', '${OUTLET}', ${TODAY},
      '[{"outlet_id":"${OUTLET}","product_batch":"KT","quantity":7,"waste_reason":"spoiled"},
        {"outlet_id":"${OUTLET}","outlet_inventory_id":"${o2}","quantity":1,"waste_reason":"dropped"}]'::jsonb)`);
    await pg.query(`SELECT public.post_waste_event('hub', NULL, ${TODAY},
      '[{"hub_inventory_id":"${hub}","product_batch":"KT","quantity":2,"waste_reason":"spoiled"}]'::jsonb)`);
    const wl = await pg.query<{ oi: string | null; ok: boolean; q: number }>(`
      SELECT wl.outlet_inventory_id oi, wl.quantity::float q,
             wl.lot_id IS NOT DISTINCT FROM COALESCE(oi.lot_id, hi.lot_id) AND wl.lot_id IS NOT NULL ok
      FROM waste_lines wl LEFT JOIN outlet_inventory oi ON oi.id = wl.outlet_inventory_id
      LEFT JOIN hub_inventory hi ON hi.id = wl.hub_inventory_id ORDER BY wl.created_at, wl.quantity DESC`);
    expect(wl.rows.every((r) => r.ok)).toBe(true);
    expect(wl.rows.filter((r) => r.oi).map((r) => [r.oi, r.q])).toEqual(
      expect.arrayContaining([[o1, 5], [o2, 2], [o2, 1]])
    );
  });

  it('post_outlet_stock_take records the batch counted', async () => {
    const pg = await migratedDb();
    const o1 = await outletRow(pg, 1, 1, 5, 'now()');
    await pg.query(`SELECT public.post_outlet_stock_take('${OUTLET}', ${TODAY}, NULL,
      '[{"outlet_inventory_id":"${o1}","counted_qty":3}]'::jsonb)`);
    const l = await pg.query<{ ok: boolean; v: number }>(`
      SELECT l.lot_id = oi.lot_id ok, l.variance::float v FROM outlet_stock_take_lines l
      JOIN outlet_inventory oi ON oi.id = l.outlet_inventory_id`);
    expect(l.rows).toEqual([{ ok: true, v: -2 }]);
  });
});

describe('079 post_sales_journal deducts FEFO and flags expired batches', () => {
  type SaleResult = { success: boolean; error?: string; expired_lines?: number; expired_qty?: number };
  async function sell(pg: PGlite, lines: unknown[], date = TODAY) {
    const r = await pg.query<{ j: SaleResult }>(`SELECT public.post_sales_journal('${OUTLET}', ${date}, $1::jsonb) j`, [
      JSON.stringify(lines),
    ]);
    return r.rows[0].j;
  }
  async function soldRows(pg: PGlite) {
    const r = await pg.query<{ oi: string; q: number; expired: boolean | null }>(
      `SELECT sl.outlet_inventory_id oi, sl.quantity_sold::float q, sl.expired_at_sale expired FROM sales_journal_lines sl
       LEFT JOIN inventory_lots il ON il.id = sl.lot_id ORDER BY il.expiry_date NULLS LAST, public.fg_lot_run_seq(sl.lot_id)`
    );
    return r.rows;
  }

  it('a line naming a later batch (Sales page by_line) is still deducted from the earliest expiry first', async () => {
    const pg = await migratedDb();
    const early = await outletRow(pg, 10, 2, 4, 'now()');
    const late = await outletRow(pg, 11, 9, 50, 'now()');
    const j = await sell(pg, [{ product_batch: 'KT', quantity_sold: 6, outlet_inventory_id: late }]);
    expect(j.success).toBe(true);
    expect(await soldRows(pg)).toEqual([
      { oi: early, q: 4, expired: false },
      { oi: late, q: 2, expired: false },
    ]);
    const ctx = await pg.query<{ m: Record<string, unknown> }>(`SELECT metadata m FROM movement_ctx WHERE movement_type = 'sale'`);
    expect(ctx.rows.map((r) => r.m.mode)).toEqual(['fefo', 'fefo']);
    expect(ctx.rows[0].m.requested_outlet_inventory_id).toBe(late);
  });

  it('equal expiry: lower run number first, matching dispatch', async () => {
    const pg = await migratedDb();
    const r113 = await outletRow(pg, 113, 5, 10, `now() - interval '3 days'`);
    const r112 = await outletRow(pg, 112, 5, 10, 'now()');
    expect((await sell(pg, [{ product_batch: 'KT', quantity_sold: 12 }])).success).toBe(true);
    expect((await soldRows(pg)).map((r) => [r.oi, r.q])).toEqual([
      [r112, 10],
      [r113, 2],
    ]);
  });

  it('expired batch is sold (not blocked) and flagged on the line, the movement, the ledger and the result', async () => {
    const pg = await migratedDb();
    const expired = await outletRow(pg, 20, -1, 3, 'now()');
    const today = await outletRow(pg, 21, 0, 10, 'now()'); // expiry = business date: not expired
    const j = await sell(pg, [{ product_batch: 'KT', quantity_sold: 5 }]);
    expect(j).toMatchObject({ success: true, expired_lines: 1, expired_qty: 3 });
    expect(await soldRows(pg)).toEqual([
      { oi: expired, q: 3, expired: true },
      { oi: today, q: 2, expired: false },
    ]);
    const ctx = await pg.query<{ e: boolean }>(
      `SELECT (metadata->>'expired_at_sale')::boolean e FROM movement_ctx WHERE movement_type = 'sale' ORDER BY (metadata->>'expired_at_sale') DESC`
    );
    expect(ctx.rows.map((r) => r.e)).toEqual([true, false]);
    const led = await pg.query<{ a: { expired_lines: number; lines: Array<{ expired_at_sale: boolean }> } }>(
      `SELECT after_data a FROM ledger_calls WHERE entity_type = 'sales_journal'`
    );
    expect(led.rows[0].a.expired_lines).toBe(1);
    expect(led.rows[0].a.lines.map((l) => l.expired_at_sale)).toEqual([true, false]);
  });

  it('expiry is judged on the business date, so a late-posted sale is not flagged retroactively', async () => {
    const pg = await migratedDb();
    await outletRow(pg, 30, -2, 5, 'now()'); // expired 2 days ago
    const j = await sell(pg, [{ product_batch: 'KT', quantity_sold: 1 }], `${TODAY} - 3`);
    expect(j).toMatchObject({ success: true, expired_lines: 0 });
  });

  it('several lines of one product are checked together; a shortfall writes nothing', async () => {
    const pg = await migratedDb();
    const a = await outletRow(pg, 40, 1, 5, 'now()');
    const b = await outletRow(pg, 41, 2, 5, 'now()');
    const j = await sell(pg, [
      { product_batch: 'KT', quantity_sold: 6, outlet_inventory_id: b },
      { product_batch: 'KT', quantity_sold: 5 },
    ]);
    expect(j).toMatchObject({ success: false, error: 'insufficient_stock', requested: 11, available: 10 });
    const n = await pg.query<{ n: number }>(`SELECT (SELECT count(*) FROM sales_journals)::int + (SELECT count(*) FROM sales_journal_lines)::int n`);
    expect(n.rows[0].n).toBe(0);
    const q = await pg.query<{ q: number }>(`SELECT sum(quantity_on_hand)::float q FROM outlet_inventory WHERE id IN ('${a}', '${b}')`);
    expect(q.rows[0].q).toBe(10);
  });

  it('a row with no product identity (no lot / SKU / batch code) is still sold from that exact row', async () => {
    const pg = await migratedDb();
    const r = await pg.query<{ id: string }>(
      `INSERT INTO outlet_inventory (outlet_id, product_batch, quantity_on_hand, reserved_quantity, available_quantity)
       VALUES ('${OUTLET}', NULL, 4, 0, 4) RETURNING id`
    );
    await pg.exec(`CREATE OR REPLACE FUNCTION public.fg_recipe_sku(uuid) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;`);
    const j = await sell(pg, [{ product_batch: 'x', quantity_sold: 1, outlet_inventory_id: r.rows[0].id }]);
    expect(j.success).toBe(true);
    expect((await soldRows(pg))[0].oi).toBe(r.rows[0].id);
  });
});

describe('078/079 guards and rollback', () => {
  it('079 aborts if a live function body drifted from the captured version', async () => {
    const pg = await liveDb();
    await pg.exec(SCHEMA);
    await pg.exec(`CREATE OR REPLACE FUNCTION public.post_sales_journal(p_outlet_id uuid, p_business_date date, p_lines jsonb,
      p_notes text DEFAULT NULL, p_idempotency_key uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`);
    await expect(pg.exec(FUNCS)).rejects.toThrow(/post_sales_journal.*drifted/);
  });

  it('079 is re-runnable, and rollback 079 then 078 restores the live behaviour and schema', async () => {
    const pg = await migratedDb();
    await pg.exec(FUNCS); // idempotent re-run (sales patch skips)
    await pg.exec(RB079);
    await pg.exec(RB078);
    const fn = await pg.query(`SELECT 1 FROM pg_proc WHERE proname = 'fg_lot_run_seq'`);
    expect(fn.rows).toHaveLength(0);
    const col = await pg.query(
      `SELECT 1 FROM information_schema.columns WHERE (table_name, column_name) IN (
        ('supply_order_lines','lot_id'), ('supply_order_lines','expired_at_dispatch'), ('waste_lines','lot_id'),
        ('waste_lines','outlet_inventory_id'), ('outlet_stock_take_lines','lot_id'))`
    );
    expect(col.rows).toHaveLength(0);
    const b1 = await batch(pg, 1, 3, 10);
    const b2 = await batch(pg, 2, 4, 10);
    const so = await order(pg, b2, 5);
    expect((await dispatch(pg, so)).success).toBe(true);
    const sol = await pg.query<{ h: string }>(`SELECT hub_inventory_id h FROM supply_order_lines WHERE supply_order_id = '${so}'`);
    expect(sol.rows).toEqual([{ h: b2 }]); // old behaviour: ships the creation-time pick
    expect(b1).toBeTruthy();
  });
});

describe('078/079 business-date defaults use today in MYT (00:00-08:00 MYT edge)', () => {
  /** Evaluate a column DEFAULT with now() pinned to a fixed UTC instant. */
  async function defaultAt(pg: PGlite, table: string, column: string, utcInstant: string) {
    const d = await pg.query<{ expr: string }>(`
      SELECT pg_get_expr(ad.adbin, ad.adrelid) expr FROM pg_attrdef ad
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
      WHERE ad.adrelid = 'public.${table}'::regclass AND a.attname = '${column}'`);
    const expr = d.rows[0].expr
      .replace(/now\(\)/g, `'${utcInstant}'::timestamptz`)
      .replace(/CURRENT_DATE/g, `('${utcInstant}'::timestamptz)::date`);
    const r = await pg.query<{ v: string }>(`SELECT (${expr})::text v`);
    return r.rows[0].v;
  }

  const cases: Array<[string, string]> = [
    ['2026-10-18T16:00:00Z', '2026-10-19'], // 00:00 MYT
    ['2026-10-18T16:30:00Z', '2026-10-19'], // 00:30 MYT
    ['2026-10-18T23:59:59Z', '2026-10-19'], // 07:59:59 MYT
    ['2026-10-19T00:00:00Z', '2026-10-19'], // 08:00 MYT
    ['2026-10-18T15:59:59Z', '2026-10-18'], // 23:59:59 MYT previous day
  ];

  it('supply_orders.supply_date and outlet_stock_take_sessions.count_date default to the MYT date', async () => {
    const pg = await migratedDb();
    for (const [utc, myt] of cases) {
      expect(await defaultAt(pg, 'supply_orders', 'supply_date', utc)).toBe(myt);
      expect(await defaultAt(pg, 'outlet_stock_take_sessions', 'count_date', utc)).toBe(myt);
    }
    // live (pre-078) CURRENT_DATE default gave the UTC date: yesterday at 00:30 MYT
    const live = await liveDb();
    expect(await defaultAt(live, 'supply_orders', 'supply_date', '2026-10-18T16:30:00Z')).toBe('2026-10-18');
    expect(await defaultAt(live, 'outlet_stock_take_sessions', 'count_date', '2026-10-18T16:30:00Z')).toBe('2026-10-18');
    // an insert without a date takes the MYT default
    const so = await pg.query<{ ok: boolean }>(
      `INSERT INTO supply_orders (outlet_id, status) VALUES ('${OUTLET}', 'pending') RETURNING supply_date = ${TODAY} ok`
    );
    expect(so.rows).toEqual([{ ok: true }]);
  });

  it('post_outlet_stock_take with a NULL count date uses the MYT date (no CURRENT_DATE left)', async () => {
    const pg = await migratedDb();
    const def = await pg.query<{ d: string }>(
      `SELECT pg_get_functiondef('public.post_outlet_stock_take(uuid,date,text,jsonb,uuid)'::regprocedure) d`
    );
    expect(def.rows[0].d).not.toMatch(/CURRENT_DATE/i);
    expect(def.rows[0].d.match(/timezone\('Asia\/Kuala_Lumpur', now\(\)\)\)::date/g)).toHaveLength(4);
    const o1 = await outletRow(pg, 1, 1, 5, 'now()');
    await pg.query(`SELECT public.post_outlet_stock_take('${OUTLET}', NULL, NULL,
      '[{"outlet_inventory_id":"${o1}","counted_qty":5}]'::jsonb)`);
    const s = await pg.query<{ ok: boolean }>(`SELECT count_date = ${TODAY} ok FROM outlet_stock_take_sessions`);
    expect(s.rows).toEqual([{ ok: true }]);
  });

  it('rollback 078 restores the CURRENT_DATE defaults', async () => {
    const pg = await migratedDb();
    await pg.exec(RB079);
    await pg.exec(RB078);
    expect(await defaultAt(pg, 'supply_orders', 'supply_date', '2026-10-18T16:30:00Z')).toBe('2026-10-18');
    expect(await defaultAt(pg, 'outlet_stock_take_sessions', 'count_date', '2026-10-18T16:30:00Z')).toBe('2026-10-18');
  });
});
