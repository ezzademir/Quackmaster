import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import { BATCH_TRACE_BASE } from '../test/batchTraceBase';
import SCHEMA from '../../supabase/migrations/20261019140000_078_batch_trace_schema.sql?raw';
import FUNCS from '../../supabase/migrations/20261019140100_079_batch_trace_functions.sql?raw';
import BLIND from '../../supabase/migrations/20261019140200_080_blind_stock_take.sql?raw';
import RB079 from '../../supabase/rollbacks/079_rollback.sql?raw';
import RB080 from '../../supabase/rollbacks/080_rollback.sql?raw';
import LIVE_DEPS from '../../supabase/tests/fixtures/batch_trace_live_deps.sql?raw';
import BLIND_DEPS from '../../supabase/tests/fixtures/blind_stock_take_live_deps.sql?raw';

const OUTLET = '00000000-0000-0000-0000-0000000000b1';
const OTHER = '00000000-0000-0000-0000-0000000000b2';
const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const STAFF = '00000000-0000-0000-0000-0000000000a2';
const SUP = '00000000-0000-0000-0000-0000000000a3';
const SUP2 = '00000000-0000-0000-0000-0000000000a4';

/** Supabase-like auth + the production RLS on the tables 080 touches (permissive policies as live). */
const ENV = `
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE TABLE profiles (id uuid PRIMARY KEY, role text NOT NULL, is_active boolean DEFAULT true, assigned_outlet_id uuid);
CREATE TABLE raw_materials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, unit_of_measure text);
CREATE TABLE outlet_stock_movements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid, outlet_inventory_id uuid,
  movement_type text, signed_qty numeric, business_date date, qoh_after numeric, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE outlet_inventory_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid NOT NULL, snapshot_date date NOT NULL,
  snapshot_type text NOT NULL DEFAULT 'test', lines jsonb NOT NULL DEFAULT '[]', created_at timestamptz DEFAULT now());
INSERT INTO profiles VALUES ('${ADMIN}', 'admin', true, NULL), ('${STAFF}', 'staff', true, NULL),
  ('${SUP}', 'supervisor', true, '${OUTLET}'), ('${SUP2}', 'supervisor', true, '${OUTLET}');
INSERT INTO outlets (id, name) VALUES ('${OUTLET}', 'TTDI'), ('${OTHER}', '1Utama');
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER TABLE outlet_inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Non-pending users can view outlet inventory" ON outlet_inventory FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active AND p.role <> 'pending'));
ALTER TABLE outlet_stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff view all outlet stock movements" ON outlet_stock_movements FOR SELECT TO authenticated USING (true);
ALTER TABLE outlet_inventory_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff view outlet inventory snapshots" ON outlet_inventory_snapshots FOR SELECT TO authenticated USING (true);
ALTER TABLE outlet_stock_take_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Sessions" ON outlet_stock_take_sessions FOR SELECT TO authenticated USING (true);
ALTER TABLE outlet_stock_take_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Non supervisor view outlet stock take lines" ON outlet_stock_take_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active
    AND lower(trim(both from p.role)) <> 'pending' AND lower(trim(both from p.role)) <> 'supervisor'));
CREATE POLICY "Supervisor view stock take lines via session outlet" ON outlet_stock_take_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM outlet_stock_take_sessions s JOIN profiles p ON p.id = auth.uid() AND p.is_active
    WHERE s.id = outlet_stock_take_lines.session_id AND lower(trim(both from p.role)) = 'supervisor'
      AND p.assigned_outlet_id IS NOT NULL AND s.outlet_id = p.assigned_outlet_id));
`;

async function build079(pg: PGlite) {
  await pg.exec(BATCH_TRACE_BASE);
  await pg.exec(LIVE_DEPS);
  await pg.exec(RB079);
  await pg.exec(SCHEMA);
  await pg.exec(FUNCS);
  await pg.exec(ENV);
  await pg.exec(BLIND_DEPS);
}
const before080 = pgliteTemplate(build079);
const db = pgliteTemplate(async (pg) => {
  await build079(pg);
  await pg.exec(BLIND);
});

const as = (pg: PGlite, uid: string) => pg.exec(`SELECT set_config('test.uid', '${uid}', false)`);

async function rpc<T = Record<string, unknown>>(pg: PGlite, uid: string, sql: string, params: unknown[] = []) {
  await as(pg, uid);
  const r = await pg.query<{ j: T }>(`SELECT ${sql} j`, params);
  return r.rows[0].j;
}

/** Read a table the way PostgREST would for this user (RLS applies). */
async function readAs<T>(pg: PGlite, uid: string, sql: string) {
  await as(pg, uid);
  await pg.exec('SET ROLE authenticated');
  try {
    return (await pg.query<T>(sql)).rows;
  } finally {
    await pg.exec('RESET ROLE');
  }
}

let run = 0;
async function stock(pg: PGlite, outlet: string, qoh: number, opts: { expiry?: number; updatedDaysAgo?: number; reserved?: number } = {}) {
  run += 1;
  const r = await pg.query<{ id: string }>(`
    WITH pr AS (INSERT INTO production_runs (run_number) VALUES ('RUN-${String(run).padStart(4, '0')}') RETURNING id),
    il AS (INSERT INTO inventory_lots (product_batch_label, expiry_date, manufactured_at, production_run_id)
           SELECT 'KT-LOT-${run}', (timezone('Asia/Kuala_Lumpur', now()))::date + ${opts.expiry ?? 5}, now(), id FROM pr RETURNING id)
    INSERT INTO outlet_inventory (outlet_id, product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity, last_updated, created_at)
    SELECT '${outlet}', 'KT', id, ${qoh}, ${opts.reserved ?? 0}, ${qoh - (opts.reserved ?? 0)},
           now() - interval '${opts.updatedDaysAgo ?? 0} days', now() - interval '${opts.updatedDaysAgo ?? 0} days' FROM il
    RETURNING id`);
  return r.rows[0].id;
}

type Start = { success: boolean; session_id: string; resumed: boolean; lines: Array<Record<string, unknown>>; error?: string };
type Submit = { success: boolean; error?: string; session_id?: string; lines_counted?: number; lines?: Array<Record<string, number>> };
const QTY_KEYS = /quantity_on_hand|reserved|available|system_qoh|variance|"qoh/;

describe('080 blind stock take: count sheet and visibility', () => {
  it('the count sheet carries batch identity only — no quantities, reserved or variance', async () => {
    const pg = await db();
    const a = await stock(pg, OUTLET, 12, { reserved: 2 });
    const zeroRecent = await stock(pg, OUTLET, 0, { updatedDaysAgo: 3 });
    await stock(pg, OUTLET, 0, { updatedDaysAgo: 120 }); // long gone: not on the sheet
    const s = await rpc<Start>(pg, SUP, `public.start_outlet_stock_take('${OUTLET}')`);
    expect(s.success).toBe(true);
    expect(s.lines.map((l) => l.outlet_inventory_id).sort()).toEqual([a, zeroRecent].sort());
    expect(JSON.stringify(s)).not.toMatch(QTY_KEYS);
    expect(Object.keys(s.lines[0]).sort()).toEqual(
      ['expiry_date', 'item_name', 'lot_id', 'lot_label', 'outlet_inventory_id', 'product_batch', 'raw_material_id', 'recipe_sku', 'run_number', 'unit_of_measure'].sort()
    );
    const sheet = await rpc<Start>(pg, STAFF, `public.get_outlet_stock_take_sheet('${s.session_id}')`);
    expect(JSON.stringify(sheet)).not.toMatch(QTY_KEYS);
  });

  it('while a count is open, non-admins cannot read that outlet’s quantities (RLS); admins and other outlets unaffected', async () => {
    const pg = await db();
    await stock(pg, OUTLET, 7);
    await stock(pg, OTHER, 9);
    await pg.exec(`INSERT INTO outlet_stock_movements (outlet_id, movement_type, signed_qty, qoh_after) VALUES ('${OUTLET}', 'sale', -1, 7), ('${OTHER}', 'sale', -1, 9);
      INSERT INTO outlet_inventory_snapshots (outlet_id, snapshot_date) VALUES ('${OUTLET}', current_date), ('${OTHER}', current_date);`);
    const visible = async (uid: string) => ({
      inv: (await readAs<{ o: string }>(pg, uid, `SELECT outlet_id o FROM outlet_inventory ORDER BY 1`)).map((r) => r.o),
      mov: (await readAs<{ o: string }>(pg, uid, `SELECT outlet_id o FROM outlet_stock_movements ORDER BY 1`)).map((r) => r.o),
      snap: (await readAs<{ o: string }>(pg, uid, `SELECT outlet_id o FROM outlet_inventory_snapshots ORDER BY 1`)).map((r) => r.o),
    });
    const all = { inv: [OUTLET, OTHER], mov: [OUTLET, OTHER], snap: [OUTLET, OTHER] };
    expect(await visible(STAFF)).toEqual(all);

    const s = await rpc<Start>(pg, SUP, `public.start_outlet_stock_take('${OUTLET}')`);
    const hidden = { inv: [OTHER], mov: [OTHER], snap: [OTHER] };
    expect(await visible(STAFF)).toEqual(hidden);
    expect(await visible(SUP)).toEqual(hidden);
    expect(await visible(ADMIN)).toEqual(all);

    const bal = await rpc<{ success: boolean; error?: string }>(pg, STAFF, `public.get_outlet_balance_as_of('${OUTLET}', current_date)`);
    expect(bal).toEqual({ success: false, error: 'stock_take_in_progress' });
    for (const fn of ['reconcile_outlet_stock', 'reconcile_outlet_stock_by_sku']) {
      const r = await rpc<{ error?: string }>(pg, STAFF, `public.${fn}('${OUTLET}', current_date - 7, current_date)`);
      expect(r.error).toBe('stock_take_in_progress');
    }
    const adminBal = await rpc<{ success: boolean }>(pg, ADMIN, `public.get_outlet_balance_as_of('${OUTLET}', current_date)`);
    expect(adminBal.success).toBe(true);

    const line = s.lines[0].outlet_inventory_id as string;
    await rpc(pg, SUP, `public.submit_outlet_stock_take('${s.session_id}', '[{"outlet_inventory_id":"${line}","counted_qty":7}]'::jsonb)`);
    expect(await visible(STAFF)).toEqual(all); // visible again once posted
  });
});

describe('080 blind stock take: submission and variance', () => {
  it('counter gets confirmation only; variance is computed server-side and readable by admins only', async () => {
    const pg = await db();
    const a = await stock(pg, OUTLET, 10);
    const b = await stock(pg, OUTLET, 4);
    const s = await rpc<Start>(pg, SUP, `public.start_outlet_stock_take('${OUTLET}')`);
    const res = await rpc<Submit>(
      pg,
      SUP,
      `public.submit_outlet_stock_take($1, $2::jsonb)`,
      [s.session_id, JSON.stringify([{ outlet_inventory_id: a, counted_qty: 8 }, { outlet_inventory_id: b, counted_qty: 4 }])]
    );
    expect(res).toEqual({ success: true, session_id: s.session_id, lines_counted: 2 });
    expect(JSON.stringify(res)).not.toMatch(QTY_KEYS);

    const raw = await pg.query<{ v: number; sys: number; lot: boolean }>(
      `SELECT variance::float v, system_qoh_before::float sys, lot_id IS NOT NULL lot FROM outlet_stock_take_lines ORDER BY variance`
    );
    expect(raw.rows).toEqual([{ v: -2, sys: 10, lot: true }, { v: 0, sys: 4, lot: true }]);
    expect(await readAs(pg, SUP, `SELECT * FROM outlet_stock_take_lines`)).toHaveLength(0);
    expect(await readAs(pg, STAFF, `SELECT * FROM outlet_stock_take_lines`)).toHaveLength(0);
    expect(await readAs(pg, ADMIN, `SELECT variance FROM outlet_stock_take_lines`)).toHaveLength(2);
    const sess = await pg.query<{ status: string }>(`SELECT status FROM outlet_stock_take_sessions`);
    expect(sess.rows).toEqual([{ status: 'posted' }]);
  });

  it('an admin who submits sees the variance in the result', async () => {
    const pg = await db();
    const a = await stock(pg, OUTLET, 10);
    const s = await rpc<Start>(pg, ADMIN, `public.start_outlet_stock_take('${OUTLET}')`);
    const res = await rpc<Submit>(pg, ADMIN, `public.submit_outlet_stock_take($1, $2::jsonb)`, [
      s.session_id,
      JSON.stringify([{ outlet_inventory_id: a, counted_qty: 13 }]),
    ]);
    expect(res.lines?.[0]).toMatchObject({ system_qoh_before: 10, counted_qty: 13, variance: 3 });
  });

  it('old post_outlet_stock_take cannot post a free-form (pre-filled) count; it only submits into the open session', async () => {
    const pg = await db();
    const a = await stock(pg, OUTLET, 10);
    const legacy = `public.post_outlet_stock_take('${OUTLET}', NULL, NULL, '[{"outlet_inventory_id":"${a}","counted_qty":10}]'::jsonb)`;
    expect(await rpc(pg, STAFF, legacy)).toEqual({ success: false, error: 'blind_count_session_required' });
    const n = await pg.query<{ n: number }>(`SELECT count(*)::int n FROM outlet_stock_take_sessions`);
    expect(n.rows[0].n).toBe(0);
    const s = await rpc<Start>(pg, STAFF, `public.start_outlet_stock_take('${OUTLET}')`);
    const res = await rpc<Submit>(pg, STAFF, legacy);
    expect(res).toEqual({ success: true, session_id: s.session_id, lines_counted: 1 });
  });

  it('a bad line rejects the whole submission (nothing written, count stays open)', async () => {
    const pg = await db();
    const a = await stock(pg, OUTLET, 10);
    const foreign = await stock(pg, OTHER, 3);
    const s = await rpc<Start>(pg, SUP, `public.start_outlet_stock_take('${OUTLET}')`);
    for (const lines of [
      [{ outlet_inventory_id: a, counted_qty: 2 }, { outlet_inventory_id: foreign, counted_qty: 1 }],
      [{ outlet_inventory_id: a, counted_qty: 2 }, { outlet_inventory_id: a, counted_qty: 1 }],
      [{ outlet_inventory_id: a, counted_qty: '' }],
      [{ outlet_inventory_id: a, counted_qty: -1 }],
    ]) {
      const r = await rpc<Submit>(pg, SUP, `public.submit_outlet_stock_take($1, $2::jsonb)`, [s.session_id, JSON.stringify(lines)]);
      expect(r.success).toBe(false);
    }
    const q = await pg.query<{ q: number }>(`SELECT quantity_on_hand::float q FROM outlet_inventory WHERE id = '${a}'`);
    expect(q.rows[0].q).toBe(10);
    const st = await pg.query<{ n: number; status: string }>(
      `SELECT (SELECT count(*)::int FROM outlet_stock_take_lines) n, (SELECT status FROM outlet_stock_take_sessions) status`
    );
    expect(st.rows[0]).toEqual({ n: 0, status: 'open' });
  });

  it('one open count per outlet: start again resumes it; only the opener or an admin can cancel', async () => {
    const pg = await db();
    await stock(pg, OUTLET, 5);
    const s1 = await rpc<Start>(pg, SUP, `public.start_outlet_stock_take('${OUTLET}')`);
    const s2 = await rpc<Start>(pg, SUP2, `public.start_outlet_stock_take('${OUTLET}')`);
    expect(s2).toMatchObject({ session_id: s1.session_id, resumed: true });
    expect(await rpc(pg, SUP2, `public.cancel_outlet_stock_take('${s1.session_id}')`)).toEqual({ success: false, error: 'forbidden' });
    expect(await rpc(pg, SUP, `public.cancel_outlet_stock_take('${s1.session_id}', 'wrong date')`)).toMatchObject({ success: true });
    expect(await readAs(pg, STAFF, `SELECT 1 FROM outlet_inventory WHERE outlet_id = '${OUTLET}'`)).toHaveLength(1);
    const s3 = await rpc<Start>(pg, SUP2, `public.start_outlet_stock_take('${OUTLET}')`);
    expect(s3.resumed).toBe(false);
    expect(await rpc(pg, ADMIN, `public.cancel_outlet_stock_take('${s3.session_id}')`)).toMatchObject({ success: true });
  });
});

/**
 * Call an RPC the way PostgREST does for a signed-in user: role `authenticated` (RLS applies to the
 * caller). The posting functions are re-owned by a non-superuser BYPASSRLS role first, matching prod
 * (owner `postgres`: rolbypassrls = true, rolsuper = false, tables not FORCE ROW LEVEL SECURITY), so
 * the test does not pass merely because pglite's default owner is a superuser.
 */
async function asProdOwner(pg: PGlite) {
  await pg.exec(`
    DO $$ BEGIN CREATE ROLE fn_owner NOSUPERUSER BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO fn_owner;
    GRANT USAGE ON SCHEMA public, auth TO fn_owner;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO fn_owner, authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO fn_owner, authenticated;
    ALTER FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) OWNER TO fn_owner;
    ALTER FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid) OWNER TO fn_owner;
    ALTER FUNCTION public.receive_supply_order(uuid, uuid) OWNER TO fn_owner;
    ALTER FUNCTION public.dispatch_supply_order(uuid) OWNER TO fn_owner;
    DO $$ BEGIN
      IF to_regprocedure('public.get_outlet_sale_batches(uuid)') IS NOT NULL THEN
        ALTER FUNCTION public.get_outlet_sale_batches(uuid) OWNER TO fn_owner;
      END IF;
    END $$;`);
}
async function rpcAsUser<T = Record<string, unknown>>(pg: PGlite, uid: string, sql: string, params: unknown[] = []) {
  await as(pg, uid);
  await pg.exec('SET ROLE authenticated');
  try {
    return (await pg.query<{ j: T }>(`SELECT ${sql} j`, params)).rows[0].j;
  } finally {
    await pg.exec('RESET ROLE');
  }
}

describe('080 blind stock take: operations keep working during an open count', () => {
  type Sale = { success: boolean; error?: string; expired_lines?: number };
  const TODAY = `(timezone('Asia/Kuala_Lumpur', now()))::date`;

  it('staff can post a sale for the outlet while a count is open; FEFO deduction is unchanged', async () => {
    const pg = await db();
    await asProdOwner(pg);
    const later = await stock(pg, OUTLET, 10, { expiry: 9 });
    const earliest = await stock(pg, OUTLET, 4, { expiry: 2 });
    const s = await rpcAsUser<Start>(pg, STAFF, `public.start_outlet_stock_take('${OUTLET}')`);
    expect(s.success).toBe(true);
    // Control: the caller's own reads are hidden by 080's RLS while the count is open…
    expect(await readAs(pg, STAFF, `SELECT 1 FROM outlet_inventory WHERE outlet_id = '${OUTLET}'`)).toHaveLength(0);
    // …but the SECURITY DEFINER posting path is not (owner bypasses RLS), so the sale posts.
    const sale = await rpcAsUser<Sale>(pg, STAFF, `public.post_sales_journal('${OUTLET}', ${TODAY}, $1::jsonb)`, [
      JSON.stringify([{ product_batch: 'KT', outlet_inventory_id: later, quantity_sold: 6 }]),
    ]);
    expect(sale).toMatchObject({ success: true, expired_lines: 0 });
    const q = await pg.query<{ id: string; q: number }>(
      `SELECT id, quantity_on_hand::float q FROM outlet_inventory WHERE id IN ('${later}', '${earliest}')`
    );
    expect(Object.fromEntries(q.rows.map((r) => [r.id, r.q]))).toEqual({ [earliest]: 0, [later]: 8 });
    const sl = await pg.query<{ oi: string; q: number }>(
      `SELECT outlet_inventory_id oi, quantity_sold::float q FROM sales_journal_lines ORDER BY quantity_sold DESC`
    );
    expect(sl.rows).toEqual([{ oi: earliest, q: 4 }, { oi: later, q: 2 }]);
    const st = await pg.query<{ status: string }>(`SELECT status FROM outlet_stock_take_sessions`);
    expect(st.rows).toEqual([{ status: 'open' }]); // the count stays open
  });

  it('waste and supply receive also post during an open count', async () => {
    const pg = await db();
    await asProdOwner(pg);
    const a = await stock(pg, OUTLET, 5, { expiry: 3 });
    await rpcAsUser<Start>(pg, SUP, `public.start_outlet_stock_take('${OUTLET}')`);
    const w = await rpcAsUser<{ success: boolean }>(pg, SUP, `public.post_waste_event('outlet', '${OUTLET}', ${TODAY}, $1::jsonb)`, [
      JSON.stringify([{ outlet_id: OUTLET, outlet_inventory_id: a, quantity: 2, waste_reason: 'spoiled' }]),
    ]);
    expect(w).toMatchObject({ success: true });
    const hub = await pg.query<{ id: string }>(`
      WITH pr AS (INSERT INTO production_runs (run_number) VALUES ('RUN-0900') RETURNING id),
      il AS (INSERT INTO inventory_lots (product_batch_label, expiry_date, manufactured_at, production_run_id)
             SELECT 'KT-LOT-900', ${TODAY} + 8, now(), id FROM pr RETURNING id)
      INSERT INTO hub_inventory (product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity)
      SELECT 'KT', id, 30, 0, 30 FROM il RETURNING id`);
    const so = await pg.query<{ id: string }>(
      `INSERT INTO supply_orders (supply_order_number, outlet_id, status, total_quantity) VALUES ('SO-B', '${OUTLET}', 'pending', 12) RETURNING id`
    );
    await pg.exec(`INSERT INTO supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity)
      VALUES ('${so.rows[0].id}', '${hub.rows[0].id}', 'KT', 12)`);
    const d = await rpcAsUser<{ success: boolean }>(pg, ADMIN, `public.dispatch_supply_order('${so.rows[0].id}')`);
    expect(d).toMatchObject({ success: true });
    const rec = await rpcAsUser<{ success: boolean }>(pg, ADMIN, `public.receive_supply_order('${so.rows[0].id}')`);
    expect(rec).toMatchObject({ success: true });
    const oi = await pg.query<{ label: string; q: number }>(`
      SELECT il.product_batch_label label, oi.quantity_on_hand::float q FROM outlet_inventory oi
      JOIN inventory_lots il ON il.id = oi.lot_id WHERE oi.outlet_id = '${OUTLET}' ORDER BY 1`);
    expect(Object.fromEntries(oi.rows.map((r) => [r.label, r.q]))).toMatchObject({ 'KT-LOT-900': 12 });
    const left = await pg.query<{ q: number }>(`SELECT quantity_on_hand::float q FROM outlet_inventory WHERE id = '${a}'`);
    expect(left.rows[0].q).toBe(3); // 5 − 2 wasted
  });

  it('variance is against stock at submit; quantity at open and net movement during the count are recorded for admins', async () => {
    const pg = await db();
    await asProdOwner(pg);
    const a = await stock(pg, OUTLET, 10, { expiry: 2 });
    const s = await rpcAsUser<Start>(pg, STAFF, `public.start_outlet_stock_take('${OUTLET}')`);
    // Sold 3 while the count was open (posted before submission).
    await rpcAsUser<Sale>(pg, STAFF, `public.post_sales_journal('${OUTLET}', ${TODAY}, $1::jsonb)`, [
      JSON.stringify([{ product_batch: 'KT', quantity_sold: 3 }]),
    ]);
    const res = await rpcAsUser<Submit>(pg, STAFF, `public.submit_outlet_stock_take($1, $2::jsonb)`, [
      s.session_id,
      JSON.stringify([{ outlet_inventory_id: a, counted_qty: 6 }]),
    ]);
    expect(res).toEqual({ success: true, session_id: s.session_id, lines_counted: 1 }); // still blind for staff
    const line = await pg.query(`SELECT system_qoh_at_open::float o, qty_moved_during_count::float m,
      system_qoh_before::float sys, counted_qty::float c, variance::float v FROM outlet_stock_take_lines`);
    expect(line.rows).toEqual([{ o: 10, m: -3, sys: 7, c: 6, v: -1 }]);
    // The open-time quantities are never readable by non-admins.
    expect(await readAs(pg, STAFF, `SELECT * FROM outlet_stock_take_open_balances`)).toHaveLength(0);
    expect(await readAs(pg, SUP, `SELECT * FROM outlet_stock_take_open_balances`)).toHaveLength(0);
    expect(await readAs(pg, ADMIN, `SELECT * FROM outlet_stock_take_open_balances`)).toHaveLength(1);
  });

  it('a batch first received during the count has quantity-at-open 0', async () => {
    const pg = await db();
    await asProdOwner(pg);
    await stock(pg, OUTLET, 2);
    const s = await rpcAsUser<Start>(pg, ADMIN, `public.start_outlet_stock_take('${OUTLET}')`);
    const fresh = await stock(pg, OUTLET, 5);
    const res = await rpcAsUser<Submit>(pg, ADMIN, `public.submit_outlet_stock_take($1, $2::jsonb)`, [
      s.session_id,
      JSON.stringify([{ outlet_inventory_id: fresh, counted_qty: 5 }]),
    ]);
    expect(res.lines?.[0]).toMatchObject({ system_qoh_at_open: 0, qty_moved_during_count: 5, system_qoh_before: 5, variance: 0 });
  });

  it('get_outlet_sale_batches gives the Sales/Waste screens batch identity (no quantities) while stock is hidden', async () => {
    const pg = await db();
    await asProdOwner(pg);
    const late = await stock(pg, OUTLET, 10, { expiry: 9 });
    const early = await stock(pg, OUTLET, 4, { expiry: 2 });
    await stock(pg, OUTLET, 0, { updatedDaysAgo: 1 }); // sold out: not offered
    type B = { success: boolean; hidden: boolean; rows: Array<Record<string, unknown>> };
    const open = await rpcAsUser<B>(pg, STAFF, `public.get_outlet_sale_batches('${OUTLET}')`);
    expect(open).toMatchObject({ success: true, hidden: false });
    expect(open.rows.map((r) => r.id)).toEqual([early, late]);
    await rpcAsUser<Start>(pg, STAFF, `public.start_outlet_stock_take('${OUTLET}')`);
    const during = await rpcAsUser<B>(pg, STAFF, `public.get_outlet_sale_batches('${OUTLET}')`);
    expect(during.hidden).toBe(true);
    expect(during.rows.map((r) => r.id)).toEqual([early, late]);
    expect(JSON.stringify(during)).not.toMatch(QTY_KEYS);
    expect(await rpcAsUser(pg, '00000000-0000-0000-0000-00000000dead', `public.get_outlet_sale_batches('${OUTLET}')`)).toMatchObject({
      success: false,
    });
  });
});

describe('080 guards and rollback', () => {
  it('080 refuses to apply before 079', async () => {
    const pg = await before080();
    await pg.exec(RB079);
    await expect(pg.exec(BLIND)).rejects.toThrow(/apply 079 first/);
  });

  it('080 is re-runnable; rollback 080 restores the 079 stock take and the original line policies', async () => {
    const pg = await db();
    await pg.exec(BLIND);
    await pg.exec(RB080);
    const a = await stock(pg, OUTLET, 10);
    const r = await rpc<{ success: boolean; lines: unknown[] }>(
      pg,
      STAFF,
      `public.post_outlet_stock_take('${OUTLET}', NULL, NULL, '[{"outlet_inventory_id":"${a}","counted_qty":9}]'::jsonb)`
    );
    expect(r.success).toBe(true); // direct post again (079 behaviour)
    expect(await readAs(pg, STAFF, `SELECT variance FROM outlet_stock_take_lines`)).toHaveLength(1);
    const fns = await pg.query(`SELECT 1 FROM pg_proc WHERE proname IN ('start_outlet_stock_take','submit_outlet_stock_take','stock_qty_hidden_for_outlet','get_outlet_sale_batches')`);
    expect(fns.rows).toHaveLength(0);
    const pol = await pg.query(`SELECT 1 FROM pg_policies WHERE policyname LIKE 'Blind count%'`);
    expect(pol.rows).toHaveLength(0);
    const src = await pg.query<{ s: string }>(`SELECT prosrc s FROM pg_proc WHERE proname = 'get_outlet_balance_as_of'`);
    expect(src.rows[0].s).not.toContain('stock_qty_hidden_for_outlet');
  });
});
