import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import { BATCH_TRACE_BASE } from '../test/batchTraceBase';
import LIVE_SCHEMA from '../../supabase/tests/fixtures/live_schema_082.sql?raw';
import LIVE_COLUMNS from '../../supabase/tests/fixtures/live_columns_082.json';
import LIVE_DEPS from '../../supabase/tests/fixtures/batch_trace_live_deps.sql?raw';
import RB079 from '../../supabase/rollbacks/079_rollback.sql?raw';
import FUNCS079 from '../../supabase/migrations/20261019140100_079_batch_trace_functions.sql?raw';
import MIG081 from '../../supabase/migrations/20261023130000_081_po_receipt_variance.sql?raw';
import MIG082 from '../../supabase/migrations/20261024013000_082_quantity_precision.sql?raw';
import RB082 from '../../supabase/rollback/082_quantity_precision_rollback.sql?raw';

/**
 * Tables come from a dump of the LIVE schema (exact numeric types, no unconstrained numerics);
 * only the auth/ledger helper functions are stubbed (from BATCH_TRACE_BASE, tables stripped).
 */
const STUBS = BATCH_TRACE_BASE.replace(/CREATE TABLE (?!ledger_calls|movement_ctx)[\s\S]*?\);\n/g, '');

const OUTLET = '00000000-0000-0000-0000-0000000000b1';
const SUP = '00000000-0000-0000-0000-0000000000d1';
const RM = 'bdf24c4e-34ca-4d77-a2dd-29147a7aa05a';
const HUB = '5911121d-53a8-4333-9130-c126dc9601d6';
const PO = '5a69321e-ca06-4887-8b9b-67f099bc3209';
const ITEM = '697f67f8-03b3-4ac5-b3d9-2b16c0eb6fc9';
const SRC_LEDGER = '6daad5c0-2233-4e0f-8379-c8398ae60b81';

async function build(pg: PGlite) {
  await pg.exec(STUBS);
  await pg.exec(LIVE_SCHEMA);
  await pg.exec(`
    CREATE TABLE data_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text, entity_type text, entity_id text,
      module text, operation text, reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb, metadata jsonb);
    CREATE OR REPLACE FUNCTION public._append_data_ledger(p_action text, p_entity_type text, p_entity_id text, p_module text,
      p_operation text, p_reference_id text, p_before jsonb, p_after jsonb, p_delta jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
      RETURNS void LANGUAGE sql AS $$
        INSERT INTO data_ledger (action, entity_type, entity_id, module, operation, reference_id, before_data, after_data, delta_data, metadata)
        VALUES (p_action, p_entity_type, p_entity_id, p_module, p_operation, p_reference_id, p_before, p_after, p_delta, p_metadata) $$;
    CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  `);
  await pg.exec(LIVE_DEPS);
  await pg.exec(RB079); // pre-079 bodies, then 079 (live) on top
  await pg.exec(FUNCS079);
  await pg.exec(MIG081);
  await pg.exec(`
    INSERT INTO outlets (id, name, location_code) VALUES ('${OUTLET}', '1Utama', '1U');
    INSERT INTO suppliers (id, name) VALUES ('${SUP}', 'S');
    INSERT INTO raw_materials (id, name, unit_of_measure, cost_price, weighted_avg_unit_cost) VALUES ('${RM}', 'G-1.0KG(COP)', 'kg', 3, 3);
    INSERT INTO purchase_orders (id, order_number, supplier_id, status) VALUES ('${PO}', 'PO-T', '${SUP}', 'ordered');
    INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_ordered_base, quantity_received, unit_price, line_total)
      VALUES ('${ITEM}', '${PO}', '${RM}', 12.345, 12.345, 0, 3, 37.04);
    INSERT INTO hub_inventory (id, raw_material_id, quantity_on_hand, reserved_quantity, available_quantity) VALUES ('${HUB}', '${RM}', 0, 0, 0);`);
}

const liveDb = pgliteTemplate(build);
const migratedDb = pgliteTemplate(async (pg) => {
  await build(pg);
  await pg.exec(MIG082);
});

const one = async <T,>(pg: PGlite, sql: string) => (await pg.query<T>(sql)).rows[0];
const num = async (pg: PGlite, sql: string) => Number((await one<{ v: string }>(pg, sql)).v);
const hubQoh = (pg: PGlite) => num(pg, `select quantity_on_hand v from hub_inventory where id='${HUB}'`);

/** Receive 12.345 kg, ship 7.125 kg to 1Utama, receive it there. */
async function receiptToOutlet(pg: PGlite) {
  const rcv = await one<{ r: Record<string, unknown> }>(pg,
    `select receive_po_shipment('${PO}', '[{"purchase_order_item_id":"${ITEM}","quantity_received":12.345}]'::jsonb) r`);
  expect(rcv.r.success).toBe(true);
  const so = (await one<{ id: string }>(pg,
    `INSERT INTO supply_orders (supply_order_number, outlet_id, status, total_quantity) VALUES ('SO-T', '${OUTLET}', 'pending', 7.125) RETURNING id`)).id;
  await pg.exec(`INSERT INTO supply_order_lines (supply_order_id, hub_inventory_id, quantity) VALUES ('${so}', '${HUB}', 7.125);
    SELECT public.reserve_inventory('${HUB}', 7.125, 'supply_order', '${so}', 'test');`);
  const d = await one<{ r: Record<string, unknown> }>(pg, `select dispatch_supply_order('${so}') r`);
  expect(d.r.success).toBe(true);
  const rv = await one<{ r: Record<string, unknown> }>(pg, `select receive_supply_order('${so}') r`);
  expect(rv.r.success).toBe(true);
  return {
    hub: await hubQoh(pg),
    line: await num(pg, `select sum(quantity) v from supply_order_lines where supply_order_id='${so}'`),
    total: await num(pg, `select total_quantity v from supply_orders where id='${so}'`),
    outlet: await num(pg, `select sum(quantity_on_hand) v from outlet_inventory where outlet_id='${OUTLET}'`),
  };
}

const typeOf = async (pg: PGlite, t: string, c: string) =>
  (await one<{ t: string }>(pg, `select format_type(atttypid, atttypmod) t from pg_attribute where attrelid='public.${t}'::regclass and attname='${c}'`)).t;

const WIDENED: [string, string][] = [
  ['hub_inventory', 'quantity_on_hand'], ['hub_inventory', 'reserved_quantity'], ['hub_inventory', 'available_quantity'],
  ['hub_inventory_reservations', 'quantity'], ['inventory_adjustments', 'adjusted_quantity'],
  ['outlet_inventory', 'quantity_on_hand'], ['outlet_inventory', 'reserved_quantity'], ['outlet_inventory', 'available_quantity'],
  ['supply_order_lines', 'quantity'], ['supply_orders', 'total_quantity'], ['raw_materials', 'cost_price'], ['raw_materials', 'reorder_level'],
  ['production_run_materials', 'quantity_consumed'], ['production_runs', 'actual_output'], ['production_runs', 'planned_output'],
  ['recipe_ingredients', 'quantity_required'], ['recipes', 'standard_batch_size'],
];

describe('082 fixture is the live schema', () => {
  it('loads the dumped live types (2dp before 082)', async () => {
    const pg = await liveDb();
    const live = LIVE_COLUMNS as { t: string; c: string; ty: string }[];
    for (const [t, c] of WIDENED) {
      const dumped = live.find((x) => x.t === t && x.c === c)!.ty;
      expect(dumped).toMatch(/^numeric\(1[02],2\)$/);
      expect(await typeOf(pg, t, c)).toBe(dumped);
    }
  });

  it('reproduces the bug on live types: 3-decimal receipt is rounded at hub, dispatch and outlet', async () => {
    const pg = await liveDb();
    const r = await receiptToOutlet(pg);
    expect(r).toEqual({ hub: 5.22, line: 7.13, total: 7.13, outlet: 7.13 }); // 12.345 -> 12.35 at hub, 7.125 -> 7.13 shipped
    expect(Math.round((r.hub + r.outlet) * 10000) / 10000).toBe(12.35); // stock invented by rounding
  });
});

describe('082 widening', () => {
  it('widens all 17 columns to numeric(14,4)', async () => {
    const pg = await migratedDb();
    for (const [t, c] of WIDENED) expect(await typeOf(pg, t, c)).toBe('numeric(14,4)');
    expect(await typeOf(pg, 'purchase_order_items', 'line_total')).toBe('numeric(15,2)');
    expect(await typeOf(pg, 'production_runs', 'yield_percentage')).toBe('numeric(5,2)');
  });

  it('carries a 3-decimal receipt exactly through hub, dispatch and outlet stock', async () => {
    const pg = await migratedDb();
    const r = await receiptToOutlet(pg);
    expect(r).toEqual({ hub: 5.22, line: 7.125, total: 7.125, outlet: 7.125 });
    expect(await num(pg, `select quantity_received v from purchase_order_items where id='${ITEM}'`)).toBe(12.345);
    expect(Math.round((r.hub + r.outlet) * 10000) / 10000).toBe(12.345);
  });

  it('recreates recipe_variance_by_run with grants and correct 4dp values', async () => {
    const pg = await migratedDb();
    const g = await num(pg, `select count(*) v from information_schema.role_table_grants
      where table_name='recipe_variance_by_run' and grantee in ('authenticated','service_role') and privilege_type='SELECT'`);
    expect(g).toBe(2);
    await pg.exec(`
      INSERT INTO recipes (id, name, standard_batch_size, batch_unit) VALUES ('00000000-0000-0000-0000-0000000000f1', 'R', 10.5, 'kg');
      INSERT INTO recipe_ingredients (recipe_id, raw_material_id, quantity_required) VALUES ('00000000-0000-0000-0000-0000000000f1', '${RM}', 2.125);
      INSERT INTO production_runs (id, run_number, recipe_id, planned_output, actual_output, status) VALUES ('00000000-0000-0000-0000-0000000000f2', 'RUN-1', '00000000-0000-0000-0000-0000000000f1', 21, 21, 'completed');
      INSERT INTO production_run_materials (production_run_id, raw_material_id, quantity_consumed) VALUES ('00000000-0000-0000-0000-0000000000f2', '${RM}', 4.3333);`);
    const v = await one<{ t: string; a: string; d: string }>(pg, `select theoretical_qty t, actual_qty a, variance_qty d from recipe_variance_by_run`);
    expect(Number(v.t)).toBe(4.25);
    expect(Number(v.a)).toBe(4.3333);
    expect(Number(v.d)).toBeCloseTo(0.0833, 10);
  });
});

describe('082 PO-0032 correction', () => {
  async function seedPo0032(pg: PGlite) {
    await pg.exec(`UPDATE hub_inventory SET quantity_on_hand = 194.52, available_quantity = 194.52 WHERE id = '${HUB}';
      UPDATE raw_materials SET weighted_avg_unit_cost = 2.9079 WHERE id = '${RM}';
      INSERT INTO data_ledger (id, action, entity_type, entity_id) VALUES ('${SRC_LEDGER}', 'receipt_adjusted', 'purchase_order', '${PO}');`);
  }

  it('adds exactly 0.004 with one ledger row citing PO-0032 and 6daad5c0; WAC untouched; idempotent', async () => {
    const pg = await liveDb();
    await seedPo0032(pg);
    await pg.exec(MIG082);
    expect(await hubQoh(pg)).toBe(194.524);
    expect(await num(pg, `select available_quantity v from hub_inventory where id='${HUB}'`)).toBe(194.524);
    expect(await num(pg, `select weighted_avg_unit_cost v from raw_materials where id='${RM}'`)).toBe(2.9079);
    const rows = (await pg.query<{ b: { quantity_on_hand: number }; a: { quantity_on_hand: number }; d: Record<string, unknown>; m: { reason: string } }>(
      `select before_data b, after_data a, delta_data d, metadata m from data_ledger where action='receipt_rounding_corrected'`)).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].b.quantity_on_hand)).toBe(194.52);
    expect(Number(rows[0].a.quantity_on_hand)).toBe(194.524);
    expect(Number(rows[0].d.posted_delta)).toBe(0.004);
    expect(rows[0].d.source_ledger_id).toBe(SRC_LEDGER);
    expect(rows[0].m.reason).toMatch(/PO-0032/);
    expect(rows[0].m.reason).toMatch(/6daad5c0/);
    // re-running the correction block does nothing
    await pg.exec(MIG082.slice(MIG082.indexOf('DO $corr$')));
    expect(await hubQoh(pg)).toBe(194.524);
    expect(await num(pg, `select count(*) v from data_ledger where action='receipt_rounding_corrected'`)).toBe(1);
  });

  it('skips the correction when the source ledger row is absent', async () => {
    const pg = await migratedDb();
    expect(await hubQoh(pg)).toBe(0);
    expect(await num(pg, `select count(*) v from data_ledger where action='receipt_rounding_corrected'`)).toBe(0);
  });
});

describe('082 rollback', () => {
  it('restores the live 2dp types and the view', async () => {
    const pg = await migratedDb();
    await pg.exec(RB082);
    const live = LIVE_COLUMNS as { t: string; c: string; ty: string }[];
    for (const [t, c] of WIDENED) expect(await typeOf(pg, t, c)).toBe(live.find((x) => x.t === t && x.c === c)!.ty);
    expect(await num(pg, `select count(*) v from pg_views where viewname='recipe_variance_by_run'`)).toBe(1);
  });
});
