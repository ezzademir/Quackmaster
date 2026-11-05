import { describe, expect, it } from 'vitest';
import MIG from '../../supabase/migrations/20261105100000_093_fix_production_for_update_aggregate.sql?raw';
import FENCE from '../../supabase/migrations/20261105110000_095_lot_inputs_procurement_fence.sql?raw';
import { pgliteTemplate } from '../test/pgliteTemplate';

const RECIPE = '00000000-0000-0000-0000-0000000000a1';
const RM = '00000000-0000-0000-0000-0000000000a2';
const RUN = '00000000-0000-0000-0000-0000000000a3';
const LOT_A = '00000000-0000-0000-0000-0000000000b1';
const LOT_B = '00000000-0000-0000-0000-0000000000b2';
const HUB_A = '00000000-0000-0000-0000-0000000000c1';
const HUB_B = '00000000-0000-0000-0000-0000000000c2';

const SCHEMA = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE test_ctx (uid uuid, staff boolean, procurement boolean DEFAULT false);
INSERT INTO test_ctx VALUES ('00000000-0000-0000-0000-0000000000e1', true, false);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT uid FROM test_ctx $$;
CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT staff FROM test_ctx $$;
CREATE FUNCTION public.is_procurement_user() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT procurement FROM test_ctx), false)
$$;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON test_ctx TO authenticated;
CREATE TABLE data_ledger (
  action text, entity_type text, entity_id text, module text, operation text,
  reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb, metadata jsonb
);
CREATE FUNCTION public._append_data_ledger(a text, et text, eid text, m text, op text, ref text,
  b jsonb, af jsonb, d jsonb DEFAULT NULL, md jsonb DEFAULT NULL) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO data_ledger(action,entity_type,entity_id,module,operation,reference_id,before_data,after_data,delta_data,metadata)
     VALUES (a,et,eid,m,op,ref,b,af,d,md) $$;
CREATE FUNCTION public.normalize_fg_sku(p_raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(trim(both '-' from regexp_replace(upper(trim(both from coalesce(p_raw, ''))), '[^A-Z0-9]+', '-', 'g')), '');
$$;
CREATE FUNCTION public.format_fg_lot_label(p_sku text, p_mfg date, p_run_number text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT p_sku || '-' || to_char(COALESCE(p_mfg, CURRENT_DATE), 'YYMMDD') || '-' ||
         COALESCE(lpad((regexp_match(COALESCE(p_run_number, ''), '(\\d+)$'))[1], 4, '0'), '0000');
$$;
CREATE TABLE raw_materials (id uuid PRIMARY KEY, name text);
CREATE TABLE recipes (
  id uuid PRIMARY KEY, name text, default_product_batch text, shelf_life_days integer, updated_at timestamptz
);
CREATE TABLE production_runs (
  id uuid PRIMARY KEY, recipe_id uuid, run_number text, production_date date, status text, updated_at timestamptz
);
CREATE TABLE production_run_materials (
  production_run_id uuid, raw_material_id uuid, quantity_consumed numeric
);
CREATE TABLE inventory_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_batch_label text NOT NULL,
  expiry_date date,
  manufactured_at timestamptz,
  parent_lot_id uuid,
  production_run_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE hub_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_material_id uuid,
  product_batch text,
  lot_id uuid,
  quantity_on_hand numeric DEFAULT 0,
  reserved_quantity numeric DEFAULT 0,
  available_quantity numeric DEFAULT 0,
  last_updated timestamptz,
  updated_at timestamptz,
  created_at timestamptz DEFAULT now()
);
`;

const SEED = `
INSERT INTO raw_materials VALUES ('${RM}', 'Flour');
INSERT INTO recipes VALUES ('${RECIPE}', 'Quackteow', 'KT', 7, now());
INSERT INTO production_runs VALUES ('${RUN}', '${RECIPE}', 'KT-0007', '2026-11-04', 'in_progress', now());
INSERT INTO production_run_materials VALUES ('${RUN}', '${RM}', 10);
INSERT INTO inventory_lots (id, product_batch_label, manufactured_at)
  VALUES ('${LOT_A}', 'RM-A', '2026-11-01'), ('${LOT_B}', 'RM-B', '2026-11-02');
INSERT INTO hub_inventory (id, raw_material_id, lot_id, quantity_on_hand, reserved_quantity, available_quantity, created_at)
  VALUES
    ('${HUB_A}', '${RM}', '${LOT_A}', 6, 0, 6, '2026-11-01'),
    ('${HUB_B}', '${RM}', '${LOT_B}', 8, 2, 6, '2026-11-02');
`;

const fresh = pgliteTemplate(async (pg) => {
  await pg.exec(SCHEMA);
  await pg.exec(SEED);
  await pg.exec(MIG);
});

async function post(pg: Awaited<ReturnType<typeof fresh>>, qty = 360) {
  const rows = await pg.query<{ r: Record<string, unknown> }>(
    `SELECT public.post_production_completion_inventory('${RUN}', 'KT', ${qty}) r`
  );
  return rows.rows[0].r;
}

describe('093 production completion FOR UPDATE + aggregate', () => {
  it('does not lock hub stock with SUM/COUNT and FOR UPDATE on the same query', () => {
    const body = MIG.slice(MIG.indexOf('AS $$'), MIG.lastIndexOf('$$;'));
    expect(body).toMatch(/PERFORM 1\s+FROM public\.hub_inventory hi/);
    expect(body).toMatch(
      /COUNT\(\*\)::int\s+INTO v_unreserved, v_rows\s+FROM public\.hub_inventory hi\s+WHERE hi\.raw_material_id = mat\.raw_material_id;/
    );
    expect(body).not.toMatch(
      /COUNT\(\*\)::int\s+INTO v_unreserved, v_rows\s+FROM public\.hub_inventory hi\s+WHERE hi\.raw_material_id = mat\.raw_material_id\s+FOR UPDATE/
    );
  });

  it('reproduces the live Postgres error when aggregates are locked', async () => {
    const pg = await fresh();
    await expect(
      pg.exec(`
        SELECT COALESCE(SUM(GREATEST(quantity_on_hand - COALESCE(reserved_quantity, 0), 0)), 0), COUNT(*)::int
        FROM hub_inventory
        WHERE raw_material_id = '${RM}'
        FOR UPDATE;
      `)
    ).rejects.toThrow(/FOR UPDATE is not allowed with aggregate functions/i);
  });

  it('completes a run, consumes FIFO unreserved stock, and records lot inputs', async () => {
    const pg = await fresh();
    const result = await post(pg, 360);
    expect(result.success).toBe(true);
    expect(result.sku).toBe('KT');
    expect(result.lot_label).toBe('KT-261104-0007');
    expect(Number(result.finished_quantity)).toBe(360);

    const hubs = await pg.query<{ id: string; qoh: number; avail: number }>(`
      SELECT id, quantity_on_hand::float qoh, available_quantity::float avail
      FROM hub_inventory WHERE raw_material_id = '${RM}' ORDER BY created_at
    `);
    expect(hubs.rows).toEqual([
      { id: HUB_A, qoh: 0, avail: 0 },
      { id: HUB_B, qoh: 4, avail: 2 },
    ]);

    const fg = await pg.query<{ qoh: number; sku: string }>(`
      SELECT quantity_on_hand::float qoh, product_batch sku
      FROM hub_inventory WHERE lot_id = '${result.lot_id}'
    `);
    expect(fg.rows[0]).toEqual({ qoh: 360, sku: 'KT' });

    const inputs = await pg.query<{ src: string; qty: number }>(`
      SELECT source_lot_id::text src, quantity::float qty
      FROM inventory_lot_inputs WHERE lot_id = '${result.lot_id}' ORDER BY source_lot_id
    `);
    expect(inputs.rows).toEqual([
      { src: LOT_A, qty: 6 },
      { src: LOT_B, qty: 4 },
    ]);

    const status = await pg.query<{ status: string }>(`SELECT status FROM production_runs WHERE id = '${RUN}'`);
    expect(status.rows[0].status).toBe('completed');
  });

  it('soft-returns when unreserved hub stock is short', async () => {
    const pg = await fresh();
    await pg.exec(`UPDATE production_run_materials SET quantity_consumed = 20 WHERE production_run_id = '${RUN}'`);
    const result = await post(pg, 10);
    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient_raw_material');
    const status = await pg.query<{ status: string }>(`SELECT status FROM production_runs WHERE id = '${RUN}'`);
    expect(status.rows[0].status).toBe('in_progress');
  });

  it('hides finished-lot ingredient quantities from procurement', async () => {
    const pg = await fresh();
    const result = await post(pg, 360);
    expect(result.success).toBe(true);
    await pg.exec(FENCE);

    const asUser = async (procurement: boolean) => {
      await pg.exec(`UPDATE test_ctx SET procurement = ${procurement}`);
      await pg.exec('SET ROLE authenticated');
      try {
        const seen = await pg.query<{ n: number }>(`SELECT count(*)::int n FROM inventory_lot_inputs`);
        return seen.rows[0].n;
      } finally {
        await pg.exec('RESET ROLE');
      }
    };

    expect(await asUser(false)).toBe(2);
    expect(await asUser(true)).toBe(0);

    await pg.exec('DROP POLICY inventory_lot_inputs_deny_procurement ON inventory_lot_inputs');
    expect(await asUser(true)).toBe(2);
    await pg.exec(FENCE);
    expect(await asUser(true)).toBe(0);
    expect(await asUser(false)).toBe(2);
  });
});
