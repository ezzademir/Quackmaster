import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import MIG081 from '../../supabase/migrations/20261023130000_081_po_receipt_variance.sql?raw';
import MIG084 from '../../supabase/migrations/20261024100000_084_costing_schema.sql?raw';
import MIG085 from '../../supabase/migrations/20261024100100_085_procurement_role.sql?raw';
import MIG087 from '../../supabase/migrations/20261024110000_087_is_profiles_admin_scope_row_security.sql?raw';
import MIG088 from '../../supabase/migrations/20261024100200_088_stock_entity_tags.sql?raw';
import RB088 from '../../supabase/rollbacks/088_rollback.sql?raw';
import RB087 from '../../supabase/rollbacks/087_rollback.sql?raw';
import RB084 from '../../supabase/rollbacks/084_rollback.sql?raw';
import RB085 from '../../supabase/rollbacks/085_rollback.sql?raw';
import SEED from '../../supabase/seeds/costing_seed_20261023.sql?raw';

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const ADMIN2 = '00000000-0000-0000-0000-0000000000a2';
const STAFF = '00000000-0000-0000-0000-0000000000a3';
const BUYER_QT = '00000000-0000-0000-0000-0000000000a4';
const BUYER_MH = '00000000-0000-0000-0000-0000000000a5';
const SUP = '00000000-0000-0000-0000-0000000000d1';
const RM = '00000000-0000-0000-0000-0000000000c1';
const PO_QT = '00000000-0000-0000-0000-00000000f001';
const PO_MH = '00000000-0000-0000-0000-00000000f002';
const PO_NONE = '00000000-0000-0000-0000-00000000f003';
const L_QT = '00000000-0000-0000-0000-00000000e001';
const RM2 = '00000000-0000-0000-0000-0000000000c2';
const OLD_LOT = '00000000-0000-0000-0000-00000000a0e1';
const OLD_HUB_FG = '00000000-0000-0000-0000-00000000a0e2';
const OLD_HUB_RM = '00000000-0000-0000-0000-00000000a0e3';

/** Verbatim pg_get_functiondef output of public.is_profiles_admin() on live (Quackmaster fknrfntqycfrkaihwngg, 2026-10-24, read-only). */
const LIVE_IS_PROFILES_ADMIN_DEF = `CREATE OR REPLACE FUNCTION public.is_profiles_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ok boolean;
BEGIN
  SET LOCAL row_security = off;
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active
  )
  INTO ok;
  RETURN COALESCE(ok, false);
END;
$function$
`;

/** Minimal live-shaped schema: the tables / helpers 081-084 touch, with live-style permissive policies. */
const BASE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth, public TO authenticated;
CREATE TABLE test_ctx (uid uuid);
INSERT INTO test_ctx VALUES (NULL);
GRANT SELECT ON test_ctx TO authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT uid FROM public.test_ctx $$;
CREATE TABLE profiles (id uuid primary key, full_name text, role text NOT NULL DEFAULT 'pending',
  is_active boolean NOT NULL DEFAULT true, assigned_outlet_id uuid,
  CONSTRAINT profiles_role_check CHECK (role IN ('admin','staff','pending','supervisor')));
${LIVE_IS_PROFILES_ADMIN_DEF};
CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS
  $$ SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','staff') AND is_active) $$;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all" ON profiles FOR SELECT TO authenticated USING (public.is_profiles_admin());
CREATE POLICY "Own" ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE TABLE data_ledger (id serial, action text, entity_type text, entity_id text, module text, operation text,
  reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb, metadata jsonb, user_id uuid);
ALTER TABLE data_ledger ENABLE ROW LEVEL SECURITY;   -- live: RLS on, no client policies
-- like live: SECURITY DEFINER, not callable by clients (only definer functions can write the ledger)
CREATE FUNCTION public._append_data_ledger(a text, et text, eid text, m text, op text, ref text,
  b jsonb, af jsonb, d jsonb, md jsonb) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public AS
  $$ INSERT INTO data_ledger(action,entity_type,entity_id,module,operation,reference_id,before_data,after_data,delta_data,metadata,user_id)
     VALUES (a,et,eid,m,op,ref,b,af,d,md,auth.uid()) $$;
REVOKE ALL ON FUNCTION public._append_data_ledger(text,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
CREATE TABLE suppliers (id uuid primary key default gen_random_uuid(), name text NOT NULL, payment_terms text,
  created_at timestamptz default now(), updated_at timestamptz default now());
CREATE TABLE raw_materials (id uuid primary key, name text, unit_of_measure text, cost_price numeric(12,2),
  weighted_avg_unit_cost numeric(14,4), updated_at timestamptz);
CREATE TABLE purchase_orders (id uuid primary key default gen_random_uuid(), order_number text, supplier_id uuid REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'draft', order_date date DEFAULT CURRENT_DATE, expected_delivery_date date,
  actual_delivery_date date, total_amount numeric, notes text, updated_at timestamptz);
CREATE TABLE purchase_order_items (id uuid primary key default gen_random_uuid(), purchase_order_id uuid REFERENCES purchase_orders(id),
  raw_material_id uuid, quantity_ordered numeric(10,2), quantity_received numeric(10,2) DEFAULT 0, unit_price numeric(12,2),
  line_total numeric(15,2), purchase_uom text);
CREATE TABLE hub_inventory (id uuid primary key default gen_random_uuid(), raw_material_id uuid, quantity_on_hand numeric,
  reserved_quantity numeric default 0, available_quantity numeric, last_updated timestamptz, updated_at timestamptz,
  created_at timestamptz default now(), product_batch text, lot_id uuid);
CREATE TABLE inventory_lots (id uuid primary key default gen_random_uuid(), product_batch_label text UNIQUE, production_run_id uuid,
  purchase_order_item_id uuid, expiry_date date, created_at timestamptz default now());
CREATE TABLE outlet_stock_movements (id uuid primary key default gen_random_uuid(), outlet_id uuid, outlet_inventory_id uuid,
  movement_type text, signed_qty numeric, business_date date, reference_type text, reference_id uuid, qoh_after numeric,
  metadata jsonb, created_at timestamptz default now());
CREATE VIEW supplier_scorecard_metrics AS SELECT po.supplier_id, count(po.id) n FROM purchase_orders po GROUP BY 1;
CREATE TABLE outlets (id uuid primary key default gen_random_uuid(), name text);
CREATE TABLE production_runs (id uuid primary key default gen_random_uuid(), run_number text);
CREATE VIEW recipe_variance_by_run AS SELECT pr.run_number FROM production_runs pr;
-- live-shaped (role list line is what 085 patches)
CREATE FUNCTION public.admin_set_profile_role_and_outlet(p_user_id uuid, p_role text, p_assigned_outlet_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_norm text := lower(trim(p_role));
BEGIN
  IF NOT public.is_profiles_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'forbidden'); END IF;
  IF v_norm NOT IN ('admin', 'staff', 'supervisor') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_role');
  END IF;
  UPDATE profiles SET role = v_norm WHERE id = p_user_id;
  RETURN jsonb_build_object('success', true, 'role', v_norm);
END $$;
CREATE TABLE recipes (id uuid primary key default gen_random_uuid(), name text);
CREATE TABLE sales_journals (id uuid primary key default gen_random_uuid(), outlet_id uuid);
CREATE TABLE outlet_inventory (id uuid primary key default gen_random_uuid(), outlet_id uuid, qty numeric, lot_id uuid);
CREATE TABLE document_links (id uuid primary key default gen_random_uuid(), uploaded_by uuid, storage_path text);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','raw_materials','purchase_orders','purchase_order_items','hub_inventory',
    'recipes','sales_journals','outlet_inventory','document_links','outlets','production_runs','inventory_lots','outlet_stock_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- live today: "authenticated USING (true)" or "role <> pending" read policies
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin())', t || '_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO authenticated', t);
  END LOOP;
END $$;
GRANT SELECT ON profiles, supplier_scorecard_metrics, recipe_variance_by_run TO authenticated;
CREATE FUNCTION public._stock_take_sheet(p uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS
  $$ SELECT jsonb_agg(oi.qty) FROM outlet_inventory oi WHERE oi.outlet_id = p $$;
GRANT EXECUTE ON FUNCTION public._stock_take_sheet(uuid) TO authenticated;
INSERT INTO profiles (id, full_name, role) VALUES
  ('${ADMIN}','Admin','admin'), ('${ADMIN2}','Admin 2','admin'), ('${STAFF}','Staff','staff'),
  ('${BUYER_QT}','Buyer QT','pending'), ('${BUYER_MH}','Buyer MH','pending');
INSERT INTO suppliers (id, name) VALUES ('${SUP}', 'SRI TERNAK');
INSERT INTO raw_materials VALUES ('${RM}', 'Garlic', 'kg', 3, 3, now());
INSERT INTO recipes (name) VALUES ('Secret sauce');
INSERT INTO sales_journals (outlet_id) VALUES (gen_random_uuid());
INSERT INTO outlet_inventory (outlet_id, qty) VALUES ('00000000-0000-0000-0000-00000000c0c0', 5);
INSERT INTO production_runs (run_number) VALUES ('RUN-1');
-- pre-088 stock rows (live today: no tag column anywhere): an old FG lot + its hub row, an old RM hub balance, old outlet movements
INSERT INTO inventory_lots (id, product_batch_label, production_run_id) VALUES ('${OLD_LOT}', 'OLD-BATCH-1', (SELECT id FROM production_runs LIMIT 1));
INSERT INTO hub_inventory (id, product_batch, lot_id, quantity_on_hand, available_quantity) VALUES ('${OLD_HUB_FG}', 'OLD-BATCH-1', '${OLD_LOT}', 7, 7);
INSERT INTO hub_inventory (id, raw_material_id, quantity_on_hand, available_quantity) VALUES ('${OLD_HUB_RM}', '${RM2}', 100, 100);
INSERT INTO outlet_stock_movements (outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date, qoh_after)
  VALUES ('00000000-0000-0000-0000-00000000c0c0', (SELECT id FROM outlet_inventory LIMIT 1), 'sale', -1, CURRENT_DATE, 4);
-- pre-existing (live-style) POs: no entity column yet; 084 backfills them from the hub
INSERT INTO purchase_orders (order_number, supplier_id, status) VALUES ('PO-LIVE-1','${SUP}','received'), ('PO-LIVE-2','${SUP}','partial');
`;

const POS = `
UPDATE profiles SET role='procurement' WHERE id IN ('${BUYER_QT}','${BUYER_MH}');
INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${BUYER_QT}','quackteow'), ('${BUYER_MH}','merdeka_house');
INSERT INTO purchase_orders (id, order_number, supplier_id, status, entity_code) VALUES
  ('${PO_QT}','PO-QT','${SUP}','ordered','QT'), ('${PO_MH}','PO-MH','${SUP}','ordered','MH'),
  ('${PO_NONE}','PO-OLD','${SUP}','ordered',NULL);
INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total, purchase_uom)
  VALUES ('${L_QT}','${PO_QT}','${RM}',10,0,3,30,'kg');
INSERT INTO supplier_items (id, supplier_id, procurement_tag, item_name, base_unit, pack_qty_base, price_rm, status)
  VALUES ('00000000-0000-0000-0000-00000000b0b1','${SUP}','quackteow','Garlic 1kg','g',1000,10,'active'),
         ('00000000-0000-0000-0000-00000000b0b2','${SUP}','merdeka_house','Rice 10kg','g',10000,31.5,'active');
UPDATE purchase_order_items SET supplier_item_id='00000000-0000-0000-0000-00000000b0b1' WHERE id='${L_QT}';
INSERT INTO supplier_bills (id, entity_code, supplier_id, bill_number, bill_date, due_date, amount_rm) VALUES
  ('00000000-0000-0000-0000-0000000b1110','QT','${SUP}','INV-1','2026-10-01','2026-10-02',100),
  ('00000000-0000-0000-0000-0000000b1120','MH','${SUP}','INV-2','2026-10-01',NULL,50);
INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method, reference) VALUES
  ('00000000-0000-0000-0000-0000000b1110',40,'2026-10-02','bank_transfer','TX1'),
  ('00000000-0000-0000-0000-0000000b1120',20,'2026-10-02','cash',NULL),
  ('00000000-0000-0000-0000-0000000b1120',30,'2026-10-03','cheque','CHQ-9');
`;

const db = pgliteTemplate(async (pg) => {
  for (const [n, sql] of [['BASE', BASE], ['081', MIG081], ['084', MIG084], ['085', MIG085], ['088', MIG088], ['POS', POS]]) {
    try {
      await pg.exec(sql);
    } catch (e) {
      throw new Error(`${n}: ${(e as Error).message}`);
    }
  }
});

async function as<T>(pg: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`UPDATE test_ctx SET uid='${uid}'; SET ROLE authenticated;`);
  try {
    return await fn();
  } finally {
    await pg.exec('RESET ROLE');
  }
}
const rows = async (pg: PGlite, sql: string) => (await pg.query<Record<string, unknown>>(sql)).rows;
const count = async (pg: PGlite, sql: string) => Number((await rows(pg, `select count(*)::int n from (${sql}) x`))[0].n);
const err = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe('084/085 procurement role RLS', () => {
  it('procurement cannot read costing, recipes, sales, outlet stock or other users', async () => {
    const pg = await db();
    await pg.exec(`INSERT INTO menu_items (entity_code, name, source_sheet, selling_price_ex_sst_rm) VALUES ('MH','Nasi','F-NASI',12);
      INSERT INTO bom_lines (entity_code, menu_item_id, component_name, line_cost_rm, cost_complete)
        SELECT 'MH', id, 'RICE', 1, true FROM menu_items;`);
    for (const t of ['menu_items', 'sub_recipes', 'bom_lines', 'v_recipe_cost', 'v_dish_cogs', 'v_cost_drift', 'v_ingredient_usage',
      'recipes', 'sales_journals', 'outlet_inventory', 'price_flag_reviews']) {
      expect(await as(pg, BUYER_MH, () => count(pg, `select * from ${t}`)), t).toBe(0);
    }
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from profiles'))).toBe(1);
    // costing is admin-only: staff gets nothing either; production recipes stay staff-readable
    for (const t of ['menu_items', 'sub_recipes', 'bom_lines', 'v_recipe_cost', 'v_dish_cogs', 'v_cost_drift', 'v_ingredient_usage', 'price_flag_reviews']) {
      expect(await as(pg, STAFF, () => count(pg, `select * from ${t}`)), `staff ${t}`).toBe(0);
    }
    expect(await as(pg, ADMIN, () => count(pg, 'select * from v_recipe_cost'))).toBe(1);
    expect(await as(pg, STAFF, () => err(pg.exec(`UPDATE menu_items SET name='x'`)))).toBeNull();
    expect((await rows(pg, 'select name from menu_items'))[0].name).toBe('Nasi');
    expect(await as(pg, STAFF, () => count(pg, 'select * from recipes'))).toBe(1);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from profiles'))).toBe(5);
    // raw_materials cost columns: procurement is denied the table and gets the cost-free catalogue view
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from raw_materials'))).toBe(0);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select * from v_raw_material_catalog'))).toEqual([{ id: RM, name: 'Garlic', unit_of_measure: 'kg' }]);
    expect(await as(pg, STAFF, () => count(pg, 'select cost_price, weighted_avg_unit_cost from raw_materials'))).toBe(1);
    // and cannot write them
    expect(await as(pg, BUYER_MH, () => err(pg.exec(`INSERT INTO recipes (name) VALUES ('x')`)))).toMatch(/row-level security/);
  });

  it('procurement sees only POs, items, bills and supplier items of its own tags (untagged hidden)', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select order_number from purchase_orders order by 1')))
      .toEqual([{ order_number: 'PO-LIVE-1' }, { order_number: 'PO-LIVE-2' }, { order_number: 'PO-QT' }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select order_number from purchase_orders order by 1'))).toEqual([{ order_number: 'PO-MH' }]);
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from purchase_order_items'))).toBe(0);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select item_name from supplier_items'))).toEqual([{ item_name: 'Garlic 1kg' }]);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select bill_number, payment_status from v_supplier_bill_status')))
      .toEqual([{ bill_number: 'INV-1', payment_status: 'overdue' }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select payment_status, paid_rm::float p from v_supplier_bill_status'))).toEqual([{ payment_status: 'paid', p: 50 }]);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from price_history'))).toBe(1);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from purchase_orders'))).toBe(5);
    // a buyer with no tag sees nothing
    await pg.exec(`DELETE FROM user_entities WHERE user_id='${BUYER_QT}'`);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from purchase_orders'))).toBe(0);
  });

  it('draft PO -> submit; cannot create in another tag, approve, or approve own', async () => {
    const pg = await db();
    const ins = (status: string, ent: string) =>
      pg.exec(`INSERT INTO purchase_orders (order_number, supplier_id, status, entity_code) VALUES ('N-${status}-${ent}','${SUP}','${status}','${ent}')`);
    expect(await as(pg, BUYER_QT, () => err(ins('draft', 'MH')))).toMatch(/row-level security/);
    expect(await as(pg, BUYER_QT, () => err(ins('ordered', 'QT')))).toMatch(/procurement_po_must_start_draft/);
    expect(await as(pg, BUYER_QT, () => err(ins('draft', 'QT')))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET notes='x' WHERE order_number='N-draft-QT'`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE order_number='N-draft-QT'`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE order_number='N-draft-QT'`))))
      .toMatch(/po_approval_admin_only/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET notes='y' WHERE order_number='N-draft-QT'`))))
      .toMatch(/procurement_po_edit_draft_only/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='closed_short' WHERE id='${PO_QT}'`))))
      .toMatch(/procurement_po_status_change_not_allowed|closed_short/);
    // admin who created a PO cannot approve it; another admin can
    await as(pg, ADMIN, () => pg.exec(`INSERT INTO purchase_orders (order_number, supplier_id, status, entity_code) VALUES ('A1','${SUP}','pending_approval','MH')`));
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE order_number='A1'`)))).toMatch(/po_cannot_approve_own/);
    expect(await as(pg, ADMIN2, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE order_number='N-draft-QT'`)))).toBeNull();
    const [r] = await rows(pg, `select submitted_by, approved_by, created_by from purchase_orders where order_number='N-draft-QT'`);
    expect(r).toEqual({ submitted_by: BUYER_QT, approved_by: ADMIN2, created_by: BUYER_QT });
  });

  it('pending supplier / item: procurement may add as pending only; PO lines refuse unapproved items', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO suppliers (name, status) VALUES ('New Co','active')`)))).toMatch(/row-level security/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO suppliers (name, status) VALUES ('New Co','pending')`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_items (supplier_id, procurement_tag, item_name, base_unit, status) VALUES ('${SUP}','quackteow','Chili','g','active')`))))
      .toMatch(/row-level security/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_items (supplier_id, procurement_tag, item_name, base_unit, status) VALUES ('${SUP}','merdeka_house','Chili','g','pending')`))))
      .toMatch(/row-level security/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_items (id, supplier_id, procurement_tag, item_name, base_unit, status) VALUES ('00000000-0000-0000-0000-00000000b0b9','${SUP}','quackteow','Chili','g','pending')`))))
      .toBeNull();
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_orders (id, order_number, supplier_id, entity_code) VALUES ('00000000-0000-0000-0000-00000000f009','D','${SUP}','QT')`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO purchase_order_items (purchase_order_id, raw_material_id, quantity_ordered, unit_price, supplier_item_id)
      VALUES ('00000000-0000-0000-0000-00000000f009','${RM}',1,1,'00000000-0000-0000-0000-00000000b0b9')`)))).toMatch(/supplier_item_not_approved/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO purchase_order_items (purchase_order_id, raw_material_id, quantity_ordered, unit_price, supplier_item_id)
      VALUES ('00000000-0000-0000-0000-00000000f009','${RM}',1,1,'00000000-0000-0000-0000-00000000b0b1')`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE supplier_items SET status='active' WHERE id='00000000-0000-0000-0000-00000000b0b9'`)))).toBeNull();
    expect((await rows(pg, `select status from supplier_items where id='00000000-0000-0000-0000-00000000b0b9'`))[0].status).toBe('pending');
  });

  it('receives within tolerance with DO + invoice price; > 5% price is flagged not blocked; no over-tolerance, no direct receipt edits', async () => {
    const pg = await db();
    const recv = (qty: number, price: number, doc = "'DO-1'") =>
      rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":${qty},"quantity_uom":"kg","invoice_unit_price":${price}}]'::jsonb, ${doc}) r`);
    expect((await as(pg, BUYER_QT, () => recv(5, 10, 'NULL')))[0].r).toMatchObject({ success: false, error: 'do_or_invoice_required' });
    expect((await as(pg, BUYER_QT, () => recv(12, 10)))[0].r).toMatchObject({ success: false, error: 'over_tolerance_needs_admin_reason' });
    expect((await as(pg, BUYER_MH, () => rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":1}]'::jsonb, 'DO') r`)))[0].r)
      .toMatchObject({ success: false, error: 'not_authorized' });
    expect((await as(pg, BUYER_QT, () => recv(5, 10.6)))[0].r).toMatchObject({ success: true });
    const [rec] = await rows(pg, 'select quantity_received::float q, quantity_uom, do_number, entered_by from po_receipt_records');
    expect(rec).toEqual({ q: 5, quantity_uom: 'kg', do_number: 'DO-1', entered_by: BUYER_QT });
    const [ph] = await rows(pg, `select flagged_over_5pct, source, entered_by from price_history where source='receipt'`);
    expect(ph).toEqual({ flagged_over_5pct: true, source: 'receipt', entered_by: BUYER_QT });
    expect(await as(pg, ADMIN, () => count(pg, 'select * from v_price_flags_open'))).toBe(1);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from v_price_flags_open'))).toBe(0);
    // the delivery moved the PO to partial via the RPC (no session flag involved)
    expect((await rows(pg, `select status from purchase_orders where id='${PO_QT}'`))[0].status).toBe('partial');
    // a line from another PO is refused by record_po_delivery itself
    expect((await as(pg, BUYER_QT, () => rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"00000000-0000-0000-0000-000000000bad","quantity_received":1}]'::jsonb, 'DO') r`)))[0].r)
      .toMatchObject({ success: false, error: 'line_not_on_po' });
    // setting the old bypass flag does nothing now
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`SELECT set_config('app.po_rpc','on',false); UPDATE purchase_order_items SET quantity_received=9 WHERE id='${L_QT}'`))))
      .toMatch(/procurement_po_edit_draft_only/);
    await pg.exec(`RESET app.po_rpc`).catch(() => undefined);
    // direct writes to receipts / quantities / close short / adjust are refused
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET quantity_received=9 WHERE id='${L_QT}'`)))).toMatch(/procurement_po_edit_draft_only/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE po_receipt_records SET quantity_received=1`)))).toMatch(/permission denied/);
    // calling receive_po_shipment directly (skipping the DO / invoice rule) is refused: only record_po_delivery
    // issues the one-shot receipt ticket that lets a procurement user through its guard
    expect((await as(pg, BUYER_QT, () => rows(pg, `select receive_po_shipment('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":1}]'::jsonb) r`)))[0].r)
      .toMatchObject({ success: false });
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO po_receipt_tickets (purchase_order_id, user_id, txid) VALUES ('${PO_QT}','${BUYER_QT}',txid_current())`))))
      .toMatch(/permission denied/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select _consume_po_receipt_ticket('${PO_QT}')`)))).toMatch(/permission denied/);
    expect(await c0(pg, 'select count(*) n from po_receipt_tickets')).toBe(0);
    expect((await as(pg, BUYER_QT, () => rows(pg, `select close_po_short('${PO_QT}', 'x') r`)))[0].r).toMatchObject({ success: false });
  });

  it('receipt ticket: single-use (no replay), expires with its transaction, bound to the user and their tags', async () => {
    const pg = await db();
    const ship = (po: string, line: string) =>
      `select receive_po_shipment('${po}', '[{"purchase_order_item_id":"${line}","quantity_received":1}]'::jsonb) r`;
    const L_MH = '00000000-0000-0000-0000-00000000e002';
    await pg.exec(`INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total, purchase_uom)
      VALUES ('${L_MH}','${PO_MH}','${RM}',10,0,3,30,'kg')`);
    // run fn inside ONE transaction: a ticket row is planted (as the owner, i.e. "a server function"), then the
    // buyer calls receive_po_shipment directly, as a client could
    const inTx = (uid: string, plant: string, calls: string[]) =>
      pg.transaction(async (tx) => {
        if (plant) await tx.exec(plant);
        await tx.exec(`UPDATE test_ctx SET uid='${uid}'; SET LOCAL ROLE authenticated;`);
        const out: unknown[] = [];
        for (const q of calls) out.push((await tx.query<{ r: unknown }>(q)).rows[0].r);
        return out;
      });
    const tk = (po: string, uid: string, txid = 'txid_current()') =>
      `INSERT INTO po_receipt_tickets (purchase_order_id, user_id, txid) VALUES ('${po}','${uid}',${txid})`;

    // replay: one ticket lets exactly one call through; the second call in the same transaction is refused
    const [first, replay] = await inTx(BUYER_QT, tk(PO_QT, BUYER_QT), [ship(PO_QT, L_QT), ship(PO_QT, L_QT)]);
    expect(first).toMatchObject({ success: true });
    expect(replay).toMatchObject({ success: false });
    expect(await c0(pg, 'select count(*) n from po_receipt_tickets')).toBe(0);

    // expiry: a ticket left over from an earlier (committed) transaction is dead in any later one
    await pg.exec(tk(PO_QT, BUYER_QT));
    const [stale] = await inTx(BUYER_QT, '', [ship(PO_QT, L_QT)]);
    expect(stale).toMatchObject({ success: false });
    await pg.exec('DELETE FROM po_receipt_tickets');

    // cross-tag: a QT ticket held by the MH buyer does not open the QT PO, and a QT buyer's ticket for the
    // QT PO does not open the MH PO
    const [crossUser] = await inTx(BUYER_MH, tk(PO_QT, BUYER_MH), [ship(PO_QT, L_QT)]);
    expect(crossUser).toMatchObject({ success: false });
    const [crossPo] = await inTx(BUYER_QT, tk(PO_QT, BUYER_QT), [ship(PO_MH, L_MH)]);
    expect(crossPo).toMatchObject({ success: false });
    // another user's ticket in the same transaction is not usable either
    const [otherUser] = await inTx(BUYER_QT, tk(PO_QT, BUYER_MH), [ship(PO_QT, L_QT)]);
    expect(otherUser).toMatchObject({ success: false });
    // (unconsumed planted rows above are inert: bound to a txid that is now over)
    await pg.exec('DELETE FROM po_receipt_tickets');
    // record_po_delivery for the wrong tag never issues a ticket
    await as(pg, BUYER_MH, () => rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":1}]'::jsonb, 'DO') r`));
    expect(await c0(pg, 'select count(*) n from po_receipt_tickets')).toBe(0);
  });

  it('receipt ticket: po_receipt_tickets is empty after every path through record_po_delivery (commit and rollback)', async () => {
    const pg = await db();
    const tickets = () => c0(pg, 'select count(*) n from po_receipt_tickets');
    const line = (q: string, extra = '') => `[{"purchase_order_item_id":"${L_QT}","quantity_received":${q}${extra}}]`;
    const call = (po: string, lines: string, doc = "'DO-T'") =>
      `select record_po_delivery('${po}', '${lines}'::jsonb, ${doc}) r`;
    // runs the call in ONE transaction as uid; checks the table inside the transaction (before end), then
    // commits or rolls back. Raising calls run under a savepoint so the outer transaction can still commit.
    const run = async (uid: string, sql: string, end: 'commit' | 'rollback') => {
      const out: { r?: unknown; error?: string; inside?: number } = {};
      await pg
        .transaction(async (tx) => {
          await tx.exec(`UPDATE test_ctx SET uid='${uid}'; SET LOCAL ROLE authenticated; SAVEPOINT s;`);
          try {
            out.r = (await tx.query<{ r: unknown }>(sql)).rows[0].r;
          } catch (e) {
            out.error = (e as Error).message;
            await tx.exec('ROLLBACK TO SAVEPOINT s');
          }
          await tx.exec('RESET ROLE');
          out.inside = Number((await tx.query<{ n: number }>('select count(*) n from po_receipt_tickets')).rows[0].n);
          if (end === 'rollback') throw new Error('__rollback__');
        })
        .catch((e) => {
          if ((e as Error).message !== '__rollback__') throw e;
        });
      return out;
    };
    const paths: [string, string, string, (o: { r?: unknown; error?: string }) => void][] = [
      ['not_authorized (wrong tag)', BUYER_MH, call(PO_QT, line('1')), (o) => expect(o.r).toMatchObject({ error: 'not_authorized' })],
      ['not_authorized (no scope PO)', BUYER_QT, call(PO_NONE, line('1')), (o) => expect(o.r).toMatchObject({ error: 'not_authorized' })],
      ['no_lines', BUYER_QT, call(PO_QT, '[]'), (o) => expect(o.r).toMatchObject({ error: 'no_lines' })],
      ['do_or_invoice_required', BUYER_QT, call(PO_QT, line('1'), 'NULL'), (o) => expect(o.r).toMatchObject({ error: 'do_or_invoice_required' })],
      ['line_not_on_po', BUYER_QT, call(PO_QT, `[{"purchase_order_item_id":"00000000-0000-0000-0000-000000000bad","quantity_received":1}]`),
        (o) => expect(o.r).toMatchObject({ error: 'line_not_on_po' })],
      // ticket issued, receive_po_shipment soft-fails
      ['over_tolerance (after ticket)', BUYER_QT, call(PO_QT, line('12')), (o) => expect(o.r).toMatchObject({ success: false })],
      ['negative qty (after ticket)', BUYER_QT, call(PO_QT, line('-1')), (o) => expect(o.r ?? o.error).toBeTruthy()],
      // RAISE before the ticket (bad uuid cast in the line check)
      ['RAISE: invalid line id', BUYER_QT, call(PO_QT, `[{"purchase_order_item_id":"nope","quantity_received":1}]`), (o) => expect(o.error).toMatch(/uuid/)],
      // S8: a bad price used to RAISE after the ticket + shipment; it is now refused up front, before anything is posted
      ['invalid invoice price (refused before ticket)', BUYER_QT, call(PO_QT, line('1', ',"invoice_unit_price":"abc"')), (o) => expect(o.r).toMatchObject({ error: 'invalid_invoice_price' })],
      ['uom mismatch (refused before ticket)', BUYER_QT, call(PO_QT, line('1', ',"quantity_uom":"g"')), (o) => expect(o.r).toMatchObject({ error: 'uom_mismatch' })],
      ['RAISE: invalid quantity', BUYER_QT, call(PO_QT, line('"abc"')), (o) => expect(o.error).toBeTruthy()],
      // success paths: procurement (ticket issued + consumed) and staff (no ticket)
      ['success (procurement)', BUYER_QT, call(PO_QT, line('1')), (o) => expect(o.r).toMatchObject({ success: true })],
      ['success (staff)', STAFF, call(PO_QT, line('1')), (o) => expect(o.r).toMatchObject({ success: true })],
    ];
    for (const end of ['rollback', 'commit'] as const) {
      for (const [name, uid, sql, check] of paths) {
        const o = await run(uid, sql, end);
        check(o);
        expect({ name, end, inside: o.inside }).toEqual({ name, end, inside: 0 });
        expect({ name, end, after: await tickets() }).toEqual({ name, end, after: 0 });
      }
    }
    // and outside any explicit transaction (autocommit), success and soft-fail after the ticket
    await as(pg, BUYER_QT, () => rows(pg, call(PO_QT, line('1'))));
    await as(pg, BUYER_QT, () => rows(pg, call(PO_QT, line('99'))));
    expect(await tickets()).toBe(0);
  });

  it('bills + payments: procurement records bills, sees derived status only; payments admin-only, part payments, no overpay', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_bills (id, entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('00000000-0000-0000-0000-0000000b1190','QT','${SUP}','B9','2026-10-20',10)`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('MH','${SUP}','B8','2026-10-20',10)`)))).toMatch(/row-level security/);
    // payments: procurement reads only its own tag's payments and cannot write; plain staff reads nothing; admin writes
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from supplier_payments'))).toBe(1);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method) VALUES ('00000000-0000-0000-0000-0000000b1190',10,'2026-10-21','cash')`)))).toMatch(/row-level security/);
    expect(await as(pg, STAFF, () => err(pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method) VALUES ('00000000-0000-0000-0000-0000000b1190',10,'2026-10-21','cash')`)))).toMatch(/row-level security/);
    expect(await as(pg, STAFF, () => count(pg, 'select * from supplier_payments'))).toBe(0);
    expect(await as(pg, BUYER_QT, () => rows(pg, `select payment_status from v_supplier_bill_status where bill_number='B9'`))).toEqual([{ payment_status: 'unpaid' }]);
    expect(await as(pg, ADMIN, () => err(pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method, reference, document_path) VALUES ('00000000-0000-0000-0000-0000000b1190',4,'2026-10-21','duitnow','REF1','bills/b9.pdf')`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => rows(pg, `select payment_status, balance_rm::float b from v_supplier_bill_status where bill_number='B9'`))).toEqual([{ payment_status: 'part_paid', b: 6 }]);
    expect(await as(pg, ADMIN, () => err(pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method) VALUES ('00000000-0000-0000-0000-0000000b1190',7,'2026-10-22','cash')`)))).toMatch(/payment_exceeds_bill_balance/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method) VALUES ('00000000-0000-0000-0000-0000000b1190',6,'2026-10-22','cash')`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => rows(pg, `select payment_status from v_supplier_bill_status where bill_number='B9'`))).toEqual([{ payment_status: 'paid' }]);
    const [p] = await rows(pg, `select created_by from supplier_payments where reference='REF1'`);
    expect(p.created_by).toBe(ADMIN);
    // no paid-amount field on bills any more; paid total leaks nothing outside the caller's scope
    expect(await c0(pg, `select count(*) n from information_schema.columns where table_name='supplier_bills' and column_name in ('amount_paid_rm','paid_at','paid_by')`)).toBe(0);
    expect((await as(pg, BUYER_MH, () => rows(pg, `select supplier_bill_paid_rm('00000000-0000-0000-0000-0000000b1110') v`)))[0].v).toBeNull();
  });

  it('leak audit fixes: definer views run as caller, internal stock helper not callable, role RPC + viewer', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from recipe_variance_by_run'))).toBe(0);
    expect(await as(pg, STAFF, () => count(pg, 'select * from recipe_variance_by_run'))).toBe(1);
    // scorecard counts only the buyer's own POs (PO-MH), not the whole book
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from supplier_scorecard_metrics'))).toBe(await as(pg, BUYER_MH, () => count(pg, 'select distinct supplier_id from purchase_orders')));
    expect(await as(pg, BUYER_MH, () => c0(pg, "select (select c.reloptions::text from pg_class c where relname='supplier_scorecard_metrics') like '%security_invoker=true%' n"))).toBeTruthy();
    expect(await as(pg, BUYER_MH, () => err(pg.exec(`select _stock_take_sheet('00000000-0000-0000-0000-00000000c0c0')`)))).toMatch(/permission denied/);
    expect(await as(pg, STAFF, () => err(pg.exec(`select _stock_take_sheet('00000000-0000-0000-0000-00000000c0c0')`)))).toMatch(/permission denied/);
    // every SECURITY DEFINER function 084/085 adds is gated: called by a user with no role it returns nothing
    expect((await as(pg, STAFF, () => rows(pg, `select record_po_delivery('${PO_QT}', '[]'::jsonb) r`)))[0].r).toMatchObject({ success: false });
    expect((await as(pg, BUYER_MH, () => rows(pg, `select procurement_has_po('${PO_QT}') v, procurement_has_tag('quackteow') t`)))[0]).toEqual({ v: false, t: false });
    // admin can assign the new role through the existing RPC; 'viewer' (#81) is allowed by the constraint
    expect((await as(pg, ADMIN, () => rows(pg, `select admin_set_profile_role_and_outlet('${STAFF}', 'procurement', NULL) r`)))[0].r).toMatchObject({ success: true });
    expect(await err(pg.exec(`UPDATE profiles SET role='viewer' WHERE id='${STAFF}'`))).toBeNull();
    expect(await err(pg.exec(`UPDATE profiles SET role='bogus' WHERE id='${STAFF}'`))).toMatch(/profiles_role_check/);
  });

  it('PO entity backfill: existing POs resolved from the hub; anything unresolved is listed for admins', async () => {
    const pg = await db();
    expect(await rows(pg, `select order_number, entity_code from purchase_orders where order_number like 'PO-LIVE%' order by 1`))
      .toEqual([{ order_number: 'PO-LIVE-1', entity_code: 'QT' }, { order_number: 'PO-LIVE-2', entity_code: 'QT' }]);
    expect(await as(pg, ADMIN, () => rows(pg, 'select order_number from v_po_entity_unresolved'))).toEqual([{ order_number: 'PO-OLD' }]);
    expect(await as(pg, STAFF, () => count(pg, 'select * from v_po_entity_unresolved'))).toBe(0);
    expect(await rows(pg, 'select code, procurement_tag from business_entities order by 1'))
      .toEqual([{ code: 'MH', procurement_tag: 'merdeka_house' }, { code: 'QT', procurement_tag: 'quackteow' }]);
    // extensible: a new entity / tag is a row
    expect(await err(pg.exec(`INSERT INTO procurement_tags VALUES ('new_brand','New Brand'); INSERT INTO business_entities (code, name, procurement_tag) VALUES ('NB','New Brand','new_brand')`))).toBeNull();
  });
});

describe('PR #92 review fixes: B1 pending supplier blocked on POs and bills (DB level)', () => {
  const PEND = '00000000-0000-0000-0000-0000000000d2';
  const PO_X = '00000000-0000-0000-0000-00000000f0a1';
  const mkPendingSupplier = (pg: PGlite) => pg.exec(`INSERT INTO suppliers (id, name, status) VALUES ('${PEND}', 'Pending Co', 'pending')`);
  const poSql = (supplier: string, status = 'draft') =>
    `INSERT INTO purchase_orders (id, order_number, supplier_id, status, entity_code) VALUES ('${PO_X}','PX','${supplier}','${status}','QT')`;

  it('procurement cannot create a PO against a pending (or inactive) supplier, but can against an active one', async () => {
    const pg = await db();
    await mkPendingSupplier(pg);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(poSql(PEND))))).toMatch(/supplier_not_approved/);
    await pg.exec(`UPDATE suppliers SET status='inactive' WHERE id='${PEND}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(poSql(PEND))))).toMatch(/supplier_not_approved/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(poSql(SUP))))).toBeNull();
    expect(await c0(pg, `select count(*) n from purchase_orders where id='${PO_X}'`)).toBe(1);
  });

  it('a pending supplier the buyer created themselves (visible to them) is also refused', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO suppliers (id, name, status) VALUES ('${PEND}', 'Mine', 'pending')`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(poSql(PEND))))).toMatch(/supplier_not_approved/);
  });

  it('admin-created pending supplier outside the buyer tags (invisible to RLS) is refused, not treated as usable', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => pg.exec(`INSERT INTO suppliers (id, name, status) VALUES ('${PEND}', 'Hidden', 'pending')`));
    expect(await as(pg, BUYER_QT, () => count(pg, `select * from suppliers where id='${PEND}'`))).toBe(0);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(poSql(PEND))))).toMatch(/supplier_not_approved/);
  });

  it('switching a draft PO to a pending supplier is refused', async () => {
    const pg = await db();
    await mkPendingSupplier(pg);
    await as(pg, BUYER_QT, () => pg.exec(poSql(SUP)));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET supplier_id='${PEND}' WHERE id='${PO_X}'`)))).toMatch(/supplier_not_approved/);
    expect((await rows(pg, `select supplier_id from purchase_orders where id='${PO_X}'`))[0].supplier_id).toBe(SUP);
    // editing other fields while the supplier is untouched still works
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET notes='ok' WHERE id='${PO_X}'`)))).toBeNull();
  });

  it('submit (draft -> pending_approval) and approve (-> ordered) are refused once the supplier is not active; lines without supplier_item_id do not help', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => pg.exec(poSql(SUP)));
    // ad-hoc line: no supplier_item_id, so 084's line gate never fires
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_order_items (purchase_order_id, raw_material_id, quantity_ordered, unit_price) VALUES ('${PO_X}','${RM}',2,3)`));
    expect(await c0(pg, `select count(*) n from purchase_order_items where purchase_order_id='${PO_X}' and supplier_item_id is null`)).toBe(1);
    // supplier is demoted to pending after the draft was written
    await pg.exec(`UPDATE suppliers SET status='pending' WHERE id='${SUP}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE id='${PO_X}'`)))).toMatch(/supplier_not_approved/);
    // the rule is on the row, not the role: admin and the table owner are refused too
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE id='${PO_X}'`)))).toMatch(/supplier_not_approved/);
    expect(await err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE id='${PO_X}'`))).toMatch(/supplier_not_approved/);
    expect((await rows(pg, `select status from purchase_orders where id='${PO_X}'`))[0].status).toBe('draft');
    // approving the supplier unblocks the same submit
    await pg.exec(`UPDATE suppliers SET status='active' WHERE id='${SUP}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE id='${PO_X}'`)))).toBeNull();
  });

  it('approval of a PO whose supplier is not active is refused for admin; works once the supplier is active', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => pg.exec(poSql(SUP)));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE id='${PO_X}'`)))).toBeNull();
    await pg.exec(`UPDATE suppliers SET status='pending' WHERE id='${SUP}'`);
    expect(await as(pg, ADMIN2, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE id='${PO_X}'`)))).toMatch(/supplier_not_approved/);
    expect((await rows(pg, `select status from purchase_orders where id='${PO_X}'`))[0].status).toBe('pending_approval');
    await as(pg, ADMIN2, () => pg.exec(`UPDATE suppliers SET status='active' WHERE id='${SUP}'`));
    expect(await as(pg, ADMIN2, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE id='${PO_X}'`)))).toBeNull();
    expect((await rows(pg, `select status from purchase_orders where id='${PO_X}'`))[0].status).toBe('ordered');
  });

  it('submit of a draft with a pending supplier and no lines is refused (buyer submit path, lines irrelevant)', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => pg.exec(poSql(SUP)));
    await pg.exec(`UPDATE suppliers SET status='inactive' WHERE id='${SUP}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE id='${PO_X}'`)))).toMatch(/supplier_not_approved/);
  });

  it('receiving on an existing ordered PO still works after its supplier is deactivated (goods in transit are not stranded)', async () => {
    const pg = await db();
    await pg.exec(`UPDATE suppliers SET status='inactive' WHERE id='${SUP}'`);
    const r = await as(pg, BUYER_QT, () =>
      rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":2,"quantity_uom":"kg"}]'::jsonb, 'DO-1') r`));
    expect(r[0].r).toMatchObject({ success: true });
  });

  it('bills: refused against a pending supplier (buyer and admin), allowed for active; re-pointing a bill is checked too', async () => {
    const pg = await db();
    await mkPendingSupplier(pg);
    const bill = (sup: string, no: string) =>
      `INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('QT','${sup}','${no}','2026-10-20',10)`;
    expect(await as(pg, BUYER_QT, () => err(pg.exec(bill(PEND, 'P-1'))))).toMatch(/supplier_not_approved/);
    expect(await as(pg, ADMIN, () => err(pg.exec(bill(PEND, 'P-2'))))).toMatch(/supplier_not_approved/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(bill(SUP, 'A-1'))))).toBeNull();
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE supplier_bills SET supplier_id='${PEND}' WHERE bill_number='A-1'`)))).toMatch(/supplier_not_approved/);
    // editing an existing bill whose supplier was later deactivated is not blocked (only new / re-pointed bills are)
    await pg.exec(`UPDATE suppliers SET status='inactive' WHERE id='${SUP}'`);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE supplier_bills SET notes='n' WHERE bill_number='A-1'`)))).toBeNull();
    expect(await c0(pg, `select count(*) n from supplier_bills where bill_number in ('P-1','P-2')`)).toBe(0);
  });
});

describe('PR #92 review fixes: B2 received quantity is cumulative and can never go down via record_po_delivery', () => {
  const recv = (pg: PGlite, qty: number | string, extra = '', po = PO_QT, line = L_QT) =>
    rows(pg, `select record_po_delivery('${po}', '[{"purchase_order_item_id":"${line}","quantity_received":${qty},"quantity_uom":"kg"${extra}}]'::jsonb, 'DO-B2') r`);
  const hub = async (pg: PGlite) => Number((await rows(pg, `select coalesce(sum(quantity_on_hand),0)::float q from hub_inventory where raw_material_id='${RM}'`))[0].q);
  const lineQty = async (pg: PGlite) => Number((await rows(pg, `select quantity_received::float q from purchase_order_items where id='${L_QT}'`))[0].q);
  const tickets = (pg: PGlite) => c0(pg, 'select count(*) n from po_receipt_tickets');

  it('4 more on a line that already has 5 is sent as 9 and lands on 9; typing 4 as the total is refused and leaves stock alone', async () => {
    const pg = await db();
    expect((await as(pg, BUYER_QT, () => recv(pg, 5)))[0].r).toMatchObject({ success: true });
    expect(await hub(pg)).toBe(5);
    // the old UI behaviour: typed "4" sent as the total -> would have cut hub stock by 1
    expect((await as(pg, BUYER_QT, () => recv(pg, 4)))[0].r).toMatchObject({ success: false, error: 'cannot_reduce_received', current_received: 5, entered: 4 });
    expect(await hub(pg)).toBe(5);
    expect(await lineQty(pg)).toBe(5);
    // the corrected UI sends existing + typed
    expect((await as(pg, BUYER_QT, () => recv(pg, 9)))[0].r).toMatchObject({ success: true });
    expect(await hub(pg)).toBe(9);
    expect(await lineQty(pg)).toBe(9);
    expect(await tickets(pg)).toBe(0);
  });

  it('two successive part-deliveries accumulate; equal total is a harmless no-op', async () => {
    const pg = await db();
    expect((await as(pg, BUYER_QT, () => recv(pg, 3)))[0].r).toMatchObject({ success: true });
    expect((await as(pg, BUYER_QT, () => recv(pg, 7)))[0].r).toMatchObject({ success: true });
    expect(await hub(pg)).toBe(7);
    expect((await as(pg, BUYER_QT, () => recv(pg, 7)))[0].r).toMatchObject({ success: true });
    expect(await hub(pg)).toBe(7);
    expect((await rows(pg, `select status from purchase_orders where id='${PO_QT}'`))[0].status).toBe('partial');
    expect((await as(pg, BUYER_QT, () => recv(pg, 6.9999)))[0].r).toMatchObject({ success: false, error: 'cannot_reduce_received' });
    expect(await hub(pg)).toBe(7);
    expect(await tickets(pg)).toBe(0);
  });

  it('refusal also holds for admin / staff through record_po_delivery (reductions go through adjust_po_receipt)', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => recv(pg, 5));
    expect((await as(pg, ADMIN, () => recv(pg, 2)))[0].r).toMatchObject({ success: false, error: 'cannot_reduce_received' });
    expect((await as(pg, STAFF, () => recv(pg, 2)))[0].r).toMatchObject({ success: false, error: 'cannot_reduce_received' });
    expect(await hub(pg)).toBe(5);
    expect((await as(pg, ADMIN, () => rows(pg, `select adjust_po_receipt('${L_QT}', 4, 'miscount') r`)))[0].r).toMatchObject({ success: true });
    expect(await hub(pg)).toBe(4);
  });

  it('stale screens, duplicate lines and bad quantities are refused before anything posts', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => recv(pg, 5));
    // screen showed 5 but another receipt took it to 8 meanwhile
    await as(pg, ADMIN, () => recv(pg, 8));
    expect((await as(pg, BUYER_QT, () => recv(pg, 9, ',"expected_previous_received":5')))[0].r)
      .toMatchObject({ success: false, error: 'stale_received_quantity', current_received: 8 });
    expect((await as(pg, BUYER_QT, () => recv(pg, 9, ',"expected_previous_received":8')))[0].r).toMatchObject({ success: true });
    const dup = `[{"purchase_order_item_id":"${L_QT}","quantity_received":9.5},{"purchase_order_item_id":"${L_QT}","quantity_received":9.2}]`;
    expect((await as(pg, BUYER_QT, () => rows(pg, `select record_po_delivery('${PO_QT}', '${dup}'::jsonb, 'DO') r`)))[0].r).toMatchObject({ success: false, error: 'duplicate_line' });
    expect((await as(pg, BUYER_QT, () => recv(pg, -1)))[0].r).toMatchObject({ success: false, error: 'invalid_quantity_received' });
    expect((await as(pg, BUYER_QT, () => rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}"}]'::jsonb, 'DO') r`)))[0].r)
      .toMatchObject({ success: false, error: 'invalid_quantity_received' });
    expect(await hub(pg)).toBe(9);
    expect(await c0(pg, `select count(*) n from po_receipt_records`)).toBe(3); // only the three accepted deliveries are recorded
    expect(await tickets(pg)).toBe(0);
  });
});

describe('PR #92 review fixes: S2 / S3 PO line guard', () => {
  const DRAFT = '00000000-0000-0000-0000-00000000f0b1';
  const LINE_D = '00000000-0000-0000-0000-00000000e0b1';
  const mkDraft = async (pg: PGlite) => {
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_orders (id, order_number, supplier_id, entity_code) VALUES ('${DRAFT}','PD','${SUP}','QT')`));
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, unit_price) VALUES ('${LINE_D}','${DRAFT}','${RM}',5,2)`));
  };

  it('S2: a line cannot be moved out of an ordered PO into a draft (source PO is checked, not just the destination)', async () => {
    const pg = await db();
    await mkDraft(pg);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET purchase_order_id='${DRAFT}' WHERE id='${L_QT}'`)))).toMatch(/procurement_po_edit_draft_only/);
    expect((await rows(pg, `select purchase_order_id from purchase_order_items where id='${L_QT}'`))[0].purchase_order_id).toBe(PO_QT);
    // and the reverse: a draft line cannot be moved into an ordered PO
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET purchase_order_id='${PO_QT}' WHERE id='${LINE_D}'`)))).toMatch(/procurement_po_edit_draft_only/);
    // ordinary edits of a draft line still work
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET quantity_ordered=6 WHERE id='${LINE_D}'`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`DELETE FROM purchase_order_items WHERE id='${LINE_D}'`)))).toBeNull();
  });

  it('S2: moving a line between two drafts is allowed; admin is unaffected by the procurement-only rule', async () => {
    const pg = await db();
    await mkDraft(pg);
    const D2 = '00000000-0000-0000-0000-00000000f0b2';
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_orders (id, order_number, supplier_id, entity_code) VALUES ('${D2}','PD2','${SUP}','QT')`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET purchase_order_id='${D2}' WHERE id='${LINE_D}'`)))).toBeNull();
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE purchase_order_items SET purchase_order_id='${D2}' WHERE id='${L_QT}'`)))).toBeNull();
  });

  it('S3: procurement cannot change quantity_received on a draft line (UPDATE), only 0 on insert and untouched on edit', async () => {
    const pg = await db();
    await mkDraft(pg);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET quantity_received=5 WHERE id='${LINE_D}'`)))).toMatch(/receive_via_record_po_delivery/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET quantity_received=0 WHERE id='${LINE_D}'`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO purchase_order_items (purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price) VALUES ('${DRAFT}','${RM}',1,1,1)`)))).toMatch(/receive_via_record_po_delivery/);
    expect(Number((await rows(pg, `select quantity_received::float q from purchase_order_items where id='${LINE_D}'`))[0].q)).toBe(0);
    // the sanctioned path still moves received quantity (runs as the function owner)
    expect((await as(pg, BUYER_QT, () => rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":1,"quantity_uom":"kg"}]'::jsonb, 'DO') r`)))[0].r).toMatchObject({ success: true });
  });
});

describe('S10 (088): mandatory QT / MH tag on NEW stock postings; old rows untouched', () => {
  const hubQty = async (pg: PGlite, rm: string) =>
    Number((await rows(pg, `select coalesce(sum(quantity_on_hand),0)::float q from hub_inventory where raw_material_id='${rm}'`))[0].q);
  const receive = (pg: PGlite, po: string, line: string, qty: number) =>
    rows(pg, `select receive_po_shipment('${po}', '[{"purchase_order_item_id":"${line}","quantity_received":${qty}}]'::jsonb) r`);
  const L_MH = '00000000-0000-0000-0000-00000000e002';
  const mhLine = async (pg: PGlite) =>
    pg.exec(`INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total, purchase_uom)
             VALUES ('${L_MH}','${PO_MH}','${RM}',10,0,3,30,'kg')`);

  it('old rows stay valid and readable: no tag, no backfill, still updatable; hub shows them as the UNTAGGED bucket', async () => {
    const pg = await db();
    expect(await count(pg, `select * from inventory_lots where entity_code is null`)).toBe(1);
    expect(await count(pg, `select * from outlet_stock_movements where entity_code is null`)).toBe(1);
    expect(await count(pg, `select * from hub_stock_movements`)).toBe(0);            // nothing backfilled
    expect(await as(pg, STAFF, () => count(pg, `select * from inventory_lots`))).toBe(1);
    // ordinary updates of old rows are not blocked by the new triggers
    await pg.exec(`UPDATE inventory_lots SET expiry_date = CURRENT_DATE WHERE id='${OLD_LOT}'`);
    await pg.exec(`UPDATE outlet_stock_movements SET qoh_after = 4`);
    expect(await rows(pg, `select entity_code, quantity_on_hand::float q from v_hub_stock_by_entity where hub_inventory_id in ('${OLD_HUB_FG}','${OLD_HUB_RM}') order by q`))
      .toEqual([{ entity_code: null, q: 7 }, { entity_code: null, q: 100 }]);
  });

  it('PO receipts are tagged from the PO entity: QT and MH both work and land in the shared hub row, split by tag in the report', async () => {
    const pg = await db();
    await mhLine(pg);
    // the shared hub: both entities receive the same raw material into ONE running balance
    await as(pg, ADMIN, () => receive(pg, PO_QT, L_QT, 4));
    await as(pg, ADMIN, () => receive(pg, PO_MH, L_MH, 6));
    expect(await hubQty(pg, RM)).toBe(10);
    expect(await count(pg, `select * from hub_inventory where raw_material_id='${RM}'`)).toBe(1);
    expect(await rows(pg, `select entity_code, sum(quantity)::float q from hub_stock_movements where raw_material_id='${RM}' group by 1 order by 1`))
      .toEqual([{ entity_code: 'MH', q: 6 }, { entity_code: 'QT', q: 4 }]);
    expect(await rows(pg, `select entity_code, quantity_on_hand::float q from v_hub_stock_by_entity where raw_material_id='${RM}' order by 1`))
      .toEqual([{ entity_code: 'MH', q: 6 }, { entity_code: 'QT', q: 4 }]);
    // reports filter by tag
    expect(await as(pg, STAFF, () => rows(pg, `select quantity_on_hand::float q from v_hub_stock_by_entity where raw_material_id='${RM}' and entity_code='MH'`))).toEqual([{ q: 6 }]);
    expect(await as(pg, STAFF, () => rows(pg, `select scope, entity_code, signed_qty::float q from v_stock_movements where entity_code='QT' and scope='hub'`))).toEqual([{ scope: 'hub', entity_code: 'QT', q: 4 }]);
    // the same posting through the procurement role (record_po_delivery) is tagged too
    const r = await as(pg, BUYER_MH, () => rows(pg, `select record_po_delivery('${PO_MH}', '[{"purchase_order_item_id":"${L_MH}","quantity_received":8,"expected_previous_received":6,"quantity_uom":"kg"}]'::jsonb, 'DO-MH') r`));
    expect(r[0].r).toMatchObject({ success: true });
    expect(await rows(pg, `select entity_code, sum(quantity)::float q from hub_stock_movements where raw_material_id='${RM}' group by 1 order by 1`))
      .toEqual([{ entity_code: 'MH', q: 8 }, { entity_code: 'QT', q: 4 }]);
  });

  it('a receipt on a PO with no entity is refused (no untagged hub posting from the PO path), nothing is posted', async () => {
    const pg = await db();
    await pg.exec(`INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total, purchase_uom)
      VALUES ('00000000-0000-0000-0000-00000000e003','${PO_NONE}','${RM}',5,0,3,15,'kg')`);
    const e = await err(as(pg, ADMIN, () => receive(pg, PO_NONE, '00000000-0000-0000-0000-00000000e003', 2)));
    expect(e).toMatch(/po_entity_required_for_receipt/);
    expect(await hubQty(pg, RM)).toBe(0);
    expect(await count(pg, `select * from hub_stock_movements`)).toBe(0);
  });

  it('untagged new posting is refused when the scope is enforced, and allowed (recorded untagged) when it is not', async () => {
    const pg = await db();
    // not enforced (shipped default): a direct hub posting without a tag is recorded with entity NULL
    await pg.exec(`UPDATE hub_inventory SET quantity_on_hand = 101 WHERE id='${OLD_HUB_RM}'`);
    expect(await rows(pg, `select entity_code, quantity::float q from hub_stock_movements`)).toEqual([{ entity_code: null, q: 1 }]);
    // admin switches the scope on (audited), non-admins cannot
    expect(await as(pg, STAFF, () => rows(pg, `select set_stock_tag_enforcement('hub_rm', true) r`))).toEqual([{ r: { success: false, error: 'forbidden' } }]);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE stock_tag_enforcement SET enforced=false`)))).toMatch(/permission denied|row-level security/);
    expect((await as(pg, ADMIN, () => rows(pg, `select set_stock_tag_enforcement('hub_rm', true) r`)))[0].r).toMatchObject({ success: true });
    expect(await count(pg, `select * from data_ledger where entity_type='stock_tag_enforcement'`)).toBe(1);
    // enforced: untagged RM posting refused and rolled back; old balance unchanged
    expect(await err(pg.exec(`UPDATE hub_inventory SET quantity_on_hand = 150 WHERE id='${OLD_HUB_RM}'`))).toMatch(/stock_entity_tag_required/);
    expect(await hubQty(pg, RM2)).toBe(101);
    // a tagged posting (QT, then MH) goes through: tag supplied in the same transaction
    await pg.exec(`BEGIN; SELECT public.set_stock_entity('QT'); UPDATE hub_inventory SET quantity_on_hand = 111 WHERE id='${OLD_HUB_RM}'; COMMIT;`);
    await pg.exec(`BEGIN; SELECT public.set_stock_entity('MH'); UPDATE hub_inventory SET quantity_on_hand = 116 WHERE id='${OLD_HUB_RM}'; COMMIT;`);
    expect(await rows(pg, `select entity_code, quantity_on_hand::float q from v_hub_stock_by_entity where hub_inventory_id='${OLD_HUB_RM}' order by entity_code nulls last`))
      .toEqual([{ entity_code: 'MH', q: 5 }, { entity_code: 'QT', q: 10 }, { entity_code: null, q: 101 }]);
    expect(await err(pg.exec(`SELECT public.set_stock_entity('XX')`))).toMatch(/unknown_stock_entity/);
  });

  it('new lots and outlet movements: refused untagged when enforced; QT / MH both work; lot tag flows to its movements; tags are immutable', async () => {
    const pg = await db();
    await pg.exec(`UPDATE stock_tag_enforcement SET enforced = true WHERE scope IN ('lots','outlet_movements','hub_fg')`);
    expect(await err(pg.exec(`INSERT INTO inventory_lots (product_batch_label) VALUES ('NEW-UNTAGGED')`))).toMatch(/stock_entity_tag_required/);
    await pg.exec(`INSERT INTO inventory_lots (id, product_batch_label, entity_code) VALUES ('00000000-0000-0000-0000-00000000a0f1','NEW-QT','QT')`);
    await pg.exec(`INSERT INTO inventory_lots (id, product_batch_label, entity_code) VALUES ('00000000-0000-0000-0000-00000000a0f2','NEW-MH','MH')`);
    await pg.exec(`BEGIN; SELECT public.set_stock_entity('MH'); INSERT INTO inventory_lots (product_batch_label) VALUES ('NEW-VIA-GUC'); COMMIT;`);
    expect(await rows(pg, `select entity_code from inventory_lots where product_batch_label='NEW-VIA-GUC'`)).toEqual([{ entity_code: 'MH' }]);
    expect(await err(pg.exec(`UPDATE inventory_lots SET entity_code='MH' WHERE product_batch_label='NEW-QT'`))).toMatch(/stock_entity_tag_immutable/);
    // hub FG posting resolves its tag from the lot
    await pg.exec(`INSERT INTO hub_inventory (id, product_batch, lot_id, quantity_on_hand) VALUES ('00000000-0000-0000-0000-00000000a0f3','NEW-MH','00000000-0000-0000-0000-00000000a0f2', 12)`);
    expect(await rows(pg, `select entity_code, kind, quantity::float q from hub_stock_movements`)).toEqual([{ entity_code: 'MH', kind: 'fg', q: 12 }]);
    // an FG posting against an OLD (untagged) lot is refused once hub_fg is enforced
    expect(await err(pg.exec(`UPDATE hub_inventory SET quantity_on_hand = 6 WHERE id='${OLD_HUB_FG}'`))).toMatch(/stock_entity_tag_required/);
    // outlet movements: untagged refused, outlet mapping (admin data) resolves the tag, explicit tag works
    const OUT = '00000000-0000-0000-0000-00000000c0c0';
    expect(await err(pg.exec(`INSERT INTO outlet_stock_movements (outlet_id, movement_type, signed_qty) VALUES ('${OUT}','sale',-1)`))).toMatch(/stock_entity_tag_required/);
    await pg.exec(`INSERT INTO outlets (id, name) VALUES ('${OUT}','MH outlet')`);
    await pg.exec(`INSERT INTO delivery_location_entities (location_kind, outlet_id, entity_code) VALUES ('outlet','${OUT}','MH')`);
    await pg.exec(`INSERT INTO outlet_stock_movements (outlet_id, movement_type, signed_qty) VALUES ('${OUT}','sale',-1)`);
    await pg.exec(`INSERT INTO outlet_stock_movements (outlet_id, movement_type, signed_qty, entity_code) VALUES (gen_random_uuid(),'sale',-2,'QT')`);
    expect(await rows(pg, `select entity_code, count(*)::int n from outlet_stock_movements group by 1 order by 1 nulls last`))
      .toEqual([{ entity_code: 'MH', n: 1 }, { entity_code: 'QT', n: 1 }, { entity_code: null, n: 1 }]);
    expect(await rows(pg, `select count(*)::int n from v_stock_movements where scope='outlet' and entity_code='MH'`)).toEqual([{ n: 1 }]);
  });

  it('procurement cannot read hub movements, the enforcement switch or the stock reports', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => receive(pg, PO_QT, L_QT, 2));
    expect(await as(pg, BUYER_QT, () => count(pg, `select * from hub_stock_movements`))).toBe(0);
    expect(await as(pg, BUYER_QT, () => count(pg, `select * from stock_tag_enforcement`))).toBe(0);
    expect(await as(pg, BUYER_QT, () => count(pg, `select * from v_hub_stock_by_entity`))).toBe(0);
    expect(await as(pg, BUYER_QT, () => count(pg, `select * from v_stock_movements`))).toBe(0);
    expect(await as(pg, STAFF, () => count(pg, `select * from hub_stock_movements`))).toBe(1);
  });

  it('088 rollback removes the tag columns and ledger, leaves old rows and the receipt path intact', async () => {
    const pg = await db();
    await pg.exec(RB088);
    expect(await c0(pg, `select count(*) n from information_schema.columns where column_name='entity_code' and table_name in ('inventory_lots','outlet_stock_movements')`)).toBe(0);
    expect(await c0(pg, `select count(*) n from pg_tables where tablename in ('hub_stock_movements','stock_tag_enforcement')`)).toBe(0);
    expect(await c0(pg, `select count(*) n from inventory_lots`)).toBe(1);
    await as(pg, ADMIN, () => receive(pg, PO_QT, L_QT, 2));
    expect(await hubQty(pg, RM)).toBe(2);
  });
});

describe('S12: supplier bills / payments / status readable by admin + procurement within own tags only', () => {
  const B_QT = '00000000-0000-0000-0000-0000000b1110';
  const B_MH = '00000000-0000-0000-0000-0000000b1120';
  it('plain active staff gets zero rows from the tables, the view and the paid-total function', async () => {
    const pg = await db();
    expect(await as(pg, STAFF, () => count(pg, 'select * from supplier_bills'))).toBe(0);
    expect(await as(pg, STAFF, () => count(pg, 'select * from supplier_payments'))).toBe(0);
    expect(await as(pg, STAFF, () => count(pg, 'select * from v_supplier_bill_status'))).toBe(0);
    expect((await as(pg, STAFF, () => rows(pg, `select supplier_bill_paid_rm('${B_QT}') v`)))[0].v).toBeNull();
    // and cannot write them either
    expect(await as(pg, STAFF, () => err(pg.exec(`INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('QT','${SUP}','S-1','2026-10-20',1)`)))).toMatch(/row-level security/);
  });
  it('procurement reads only bills, payments and status of its own business tags', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select entity_code from supplier_bills'))).toEqual([{ entity_code: 'QT' }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select entity_code from supplier_bills'))).toEqual([{ entity_code: 'MH' }]);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select bill_id, amount_rm::float a from supplier_payments'))).toEqual([{ bill_id: B_QT, a: 40 }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select amount_rm::float a from supplier_payments order by 1'))).toEqual([{ a: 20 }, { a: 30 }]);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select entity_code, paid_rm::float p from v_supplier_bill_status'))).toEqual([{ entity_code: 'QT', p: 40 }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select entity_code, payment_status from v_supplier_bill_status'))).toEqual([{ entity_code: 'MH', payment_status: 'paid' }]);
    expect((await as(pg, BUYER_QT, () => rows(pg, `select supplier_bill_paid_rm('${B_MH}') v`)))[0].v).toBeNull();
    // a user with both tags sees both
    await pg.exec(`INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${BUYER_QT}', 'merdeka_house')`);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from supplier_bills'))).toBe(2);
  });
  it('admin reads everything', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => count(pg, 'select * from supplier_bills'))).toBe(2);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from supplier_payments'))).toBe(3);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from v_supplier_bill_status'))).toBe(2);
  });
});

describe('S5: rollbacks are exact', () => {
  it('085 rollback keeps 081 procurement_settings policies working and drops every 085 policy by exact name', async () => {
    const pg = await db();
    const before = await rows(pg, `select policyname, cmd, permissive from pg_policies where tablename='procurement_settings' and policyname in ('procurement_settings_read','procurement_settings_admin_write') order by 1`);
    expect(before).toHaveLength(2);
    expect(await c0(pg, `select count(*) n from pg_policies where policyname='procurement_settings_deny_procurement'`)).toBe(1);
    await pg.exec(RB088);
    await pg.exec(RB085);
    const after = await rows(pg, `select policyname, cmd, permissive from pg_policies where tablename='procurement_settings' order by 1`);
    expect(after).toEqual(before);                                       // 081's policies untouched, 085's deny gone
    expect(await as(pg, STAFF, () => count(pg, 'select * from procurement_settings'))).toBe(1);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE procurement_settings SET over_receipt_tolerance_pct = 12`)))).toBeNull();
    expect(await c0(pg, `select count(*) n from pg_policies where policyname like '%!_deny!_procurement' escape '!'`)).toBe(0);
    expect(await c0(pg, `select count(*) n from pg_policies where policyname in ('profiles_procurement_own_only','document_links_procurement_own','purchase_orders_procurement_scope','purchase_orders_procurement_rw','suppliers_procurement_scope')`)).toBe(0);
  });
  it('084 rollback preserves suppliers.status in a backup table and warns about pending suppliers', async () => {
    const pg = await db();
    await pg.exec(`INSERT INTO suppliers (id, name, status) VALUES ('00000000-0000-0000-0000-0000000005e1','Pending Co','pending')`);
    await pg.exec(RB088); await pg.exec(RB085); await pg.exec(RB084);
    expect(await c0(pg, `select count(*) n from information_schema.columns where table_name='suppliers' and column_name='status'`)).toBe(0);
    expect(await rows(pg, `select status from suppliers_status_backup_084 where id='00000000-0000-0000-0000-0000000005e1'`)).toEqual([{ status: 'pending' }]);
  });
});

describe('S6: bills view / bill amount / payment deletes', () => {
  const B_QT = '00000000-0000-0000-0000-0000000b1110';
  it('a procurement user\'s own bill never vanishes from the status view, even when the supplier is outside their RLS scope', async () => {
    const pg = await db();
    // a supplier the QT buyer did not create and has no QT supplier_items for
    const OTHER = '00000000-0000-0000-0000-0000000005e2';
    await pg.exec(`INSERT INTO suppliers (id, name, status) VALUES ('${OTHER}','Outside Scope Co','active')`);
    expect(await as(pg, BUYER_QT, () => count(pg, `select * from suppliers where id='${OTHER}'`))).toBe(0);     // invisible to the buyer
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('QT','${OTHER}','OWN-1','2026-10-20',25)`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => count(pg, `select * from supplier_bills where bill_number='OWN-1'`))).toBe(1);
    const v = await as(pg, BUYER_QT, () => rows(pg, `select supplier_name, payment_status from v_supplier_bill_status where bill_number='OWN-1'`));
    expect(v).toEqual([{ supplier_name: 'Outside Scope Co', payment_status: 'unpaid' }]);
  });
  it('bill amount cannot be edited below what has been paid (admin included); raising or equalling is fine', async () => {
    const pg = await db();                                   // INV-1: amount 100, paid 40
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE supplier_bills SET amount_rm = 39.99 WHERE id='${B_QT}'`)))).toMatch(/bill_amount_below_paid/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE supplier_bills SET amount_rm = 40 WHERE id='${B_QT}'`)))).toBeNull();
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE supplier_bills SET amount_rm = 500 WHERE id='${B_QT}'`)))).toBeNull();
    await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE supplier_bills SET amount_rm = 1 WHERE id='${B_QT}'`)));   // no UPDATE policy for procurement: 0 rows
    expect(await rows(pg, `select amount_rm::float a from supplier_bills where id='${B_QT}'`)).toEqual([{ a: 500 }]);
  });
  it('payment delete / edit / insert always leave a ledger entry with the full row; procurement and staff cannot delete', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => err(pg.exec(`DELETE FROM supplier_payments`)));      // no DELETE policy: 0 rows
    await as(pg, STAFF, () => pg.exec(`DELETE FROM supplier_payments`));
    expect(await c0(pg, `select count(*) n from supplier_payments`)).toBe(3);
    await as(pg, ADMIN, () => pg.exec(`UPDATE supplier_payments SET reference='TX1-fixed' WHERE reference='TX1'`));
    await as(pg, ADMIN, () => pg.exec(`DELETE FROM supplier_payments WHERE reference='CHQ-9'`));
    expect(await c0(pg, `select count(*) n from supplier_payments`)).toBe(2);
    const l = await rows(pg, `select action, user_id, before_data->>'reference' b, after_data->>'reference' a, before_data->>'amount_rm' amt, reference_id from data_ledger where entity_type='supplier_payment' and action <> 'created' order by id`);
    expect(await c0(pg, `select count(*) n from data_ledger where entity_type='supplier_payment' and action='created'`)).toBe(3);   // the 3 seeded inserts
    expect(l).toEqual([
      { action: 'updated', user_id: ADMIN, b: 'TX1', a: 'TX1-fixed', amt: '40.00', reference_id: B_QT },
      { action: 'deleted', user_id: ADMIN, b: 'CHQ-9', a: null, amt: '30.00', reference_id: '00000000-0000-0000-0000-0000000b1120' },
    ]);
  });
});

describe('S7: procurement actions are ledgered server-side (data_ledger is closed to procurement)', () => {
  const led = (pg: PGlite, where: string) =>
    rows(pg, `select action, entity_type, user_id, metadata->>'actor_role' role, metadata->>'status_from' sf, metadata->>'status_to' st from data_ledger where ${where} order by id`);
  it('PO create -> submit -> admin approve, supplier proposal, line edit and bill all leave ledger rows with the real actor', async () => {
    const pg = await db();
    const PO = '00000000-0000-0000-0000-00000000f0a7';
    await pg.exec(`DELETE FROM data_ledger`);
    // the client can neither read the ledger nor call the writer
    expect(await as(pg, BUYER_QT, () => err(pg.exec('select * from data_ledger')))).toMatch(/permission denied|row-level security/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`SELECT public._append_data_ledger('x','y','z','m','o',null,null,null,null,null)`)))).toMatch(/permission denied/);
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_orders (id, order_number, supplier_id, entity_code) VALUES ('${PO}','S7','${SUP}','QT')`));
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_order_items (purchase_order_id, raw_material_id, quantity_ordered, unit_price, line_total, purchase_uom) VALUES ('${PO}','${RM}',3,2,6,'kg')`));
    await as(pg, BUYER_QT, () => pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE id='${PO}'`));
    await as(pg, ADMIN, () => pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE id='${PO}'`));
    expect(await led(pg, `entity_type='purchase_orders'`)).toEqual([
      { action: 'created', entity_type: 'purchase_orders', user_id: BUYER_QT, role: 'procurement', sf: null, st: 'draft' },
      { action: 'updated', entity_type: 'purchase_orders', user_id: BUYER_QT, role: 'procurement', sf: 'draft', st: 'pending_approval' },
      { action: 'updated', entity_type: 'purchase_orders', user_id: ADMIN, role: 'other', sf: 'pending_approval', st: 'ordered' },
    ]);
    expect(await led(pg, `entity_type='purchase_order_items'`)).toEqual([
      { action: 'created', entity_type: 'purchase_order_items', user_id: BUYER_QT, role: 'procurement', sf: null, st: null }]);
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO suppliers (name, status) VALUES ('Ledger Co','pending')`));
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('QT','${SUP}','L-1','2026-10-20',9)`));
    expect(await led(pg, `entity_type in ('suppliers','supplier_bills')`)).toEqual([
      { action: 'created', entity_type: 'suppliers', user_id: BUYER_QT, role: 'procurement', sf: null, st: 'pending' },
      { action: 'created', entity_type: 'supplier_bills', user_id: BUYER_QT, role: 'procurement', sf: null, st: null }]);
    // before/after payload is the whole row
    expect((await rows(pg, `select after_data->>'order_number' n from data_ledger where entity_type='purchase_orders' and action='created'`))[0].n).toBe('S7');
  });
  it('a rejected write leaves no ledger row; admin edits without status change are not noise; receipts are not double-logged', async () => {
    const pg = await db();
    await pg.exec(`DELETE FROM data_ledger`);
    await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE id='${PO_QT}'`)));       // refused
    await as(pg, ADMIN, () => pg.exec(`UPDATE purchase_orders SET notes='tidy' WHERE id='${PO_QT}'`));                    // admin, no status change
    expect(await c0(pg, `select count(*) n from data_ledger where entity_type='purchase_orders'`)).toBe(0);
    await as(pg, ADMIN, () => pg.exec(`UPDATE supplier_items SET status='inactive' WHERE id='00000000-0000-0000-0000-00000000b0b1'`));
    expect(await c0(pg, `select count(*) n from data_ledger where entity_type='supplier_items'`)).toBe(1);
    await pg.exec(`DELETE FROM data_ledger`);
    await as(pg, BUYER_QT, () => rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":2,"expected_previous_received":0,"quantity_uom":"kg"}]'::jsonb, 'DO-1') r`));
    expect(await c0(pg, `select count(*) n from data_ledger where entity_type='purchase_order_items'`)).toBe(0);          // line qty_received churn skipped
    expect(await c0(pg, `select count(*) n from data_ledger where entity_type='purchase_order' and action='received' and user_id='${BUYER_QT}'`)).toBe(1);   // the receipt itself is ledgered by 081
  });
});

describe('S8: record_po_delivery validates unit of measure and survives a null invoice price', () => {
  const recv = (pg: PGlite, extra: string, qty = 2) =>
    rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":${qty}${extra}}]'::jsonb, 'DO-S8') r`);
  const hub = async (pg: PGlite) => Number((await rows(pg, `select coalesce(sum(quantity_on_hand),0)::float q from hub_inventory where raw_material_id='${RM}'`))[0].q);
  it('a unit that is not the PO line unit is refused and nothing is posted; matching (any case) or omitted unit works and defaults to the line unit', async () => {
    const pg = await db();                                     // line L_QT is purchased in kg
    const bad = (await as(pg, BUYER_QT, () => recv(pg, ',"quantity_uom":"g"')))[0].r;
    expect(bad).toMatchObject({ success: false, error: 'uom_mismatch', line_uom: 'kg', entered_uom: 'g' });
    expect(await hub(pg)).toBe(0);
    expect(await c0(pg, `select count(*) n from po_receipt_records`)).toBe(0);
    expect((await as(pg, BUYER_QT, () => recv(pg, ',"quantity_uom":" KG "')))[0].r).toMatchObject({ success: true });
    expect((await as(pg, BUYER_QT, () => recv(pg, '', 3)))[0].r).toMatchObject({ success: true });
    expect(await rows(pg, `select quantity_uom from po_receipt_records order by quantity_received`)).toEqual([{ quantity_uom: 'kg' }, { quantity_uom: 'kg' }]);
    // a free-text legacy line unit works when it is entered verbatim; an unknown unit on a unit-less line is refused
    await pg.exec(`UPDATE purchase_order_items SET purchase_uom='box' WHERE id='${L_QT}'`);
    expect((await as(pg, BUYER_QT, () => recv(pg, ',"quantity_uom":"box"', 4)))[0].r).toMatchObject({ success: true });
    await pg.exec(`UPDATE purchase_order_items SET purchase_uom=NULL WHERE id='${L_QT}'`);
    expect((await as(pg, BUYER_QT, () => recv(pg, ',"quantity_uom":"bag"', 5)))[0].r).toMatchObject({ success: false, error: 'invalid_uom' });
    expect(await hub(pg)).toBe(4);
  });
  it('null / blank / missing invoice price: receipt goes through, receipt record has NULL price, no price_history row', async () => {
    const pg = await db();
    const ph = () => c0(pg, `select count(*) n from price_history where source='receipt'`);
    expect((await as(pg, BUYER_QT, () => recv(pg, ',"invoice_unit_price":null', 1)))[0].r).toMatchObject({ success: true });
    expect((await as(pg, BUYER_QT, () => recv(pg, ',"invoice_unit_price":""', 2)))[0].r).toMatchObject({ success: true });
    expect((await as(pg, BUYER_QT, () => recv(pg, '', 3)))[0].r).toMatchObject({ success: true });
    expect(await hub(pg)).toBe(3);
    expect(await rows(pg, `select invoice_unit_price_rm from po_receipt_records`)).toEqual([{ invoice_unit_price_rm: null }, { invoice_unit_price_rm: null }, { invoice_unit_price_rm: null }]);
    expect(await ph()).toBe(0);
    expect((await as(pg, BUYER_QT, () => recv(pg, ',"invoice_unit_price":10.5', 4)))[0].r).toMatchObject({ success: true });
    expect(await ph()).toBe(1);
  });
  it('a non-numeric or negative invoice price is refused up front (soft error, nothing posted, no leftover ticket)', async () => {
    const pg = await db();
    for (const bad of ['"abc"', '-3', '"1e3"']) {
      const r = (await as(pg, BUYER_QT, () => recv(pg, `,"invoice_unit_price":${bad}`)))[0].r;
      expect(r, bad).toMatchObject({ success: false, error: 'invalid_invoice_price' });
    }
    expect(await hub(pg)).toBe(0);
    expect(await c0(pg, `select count(*) n from po_receipt_tickets`)).toBe(0);
  });
});

describe('S9: procurement is default-deny on every table that is not explicitly allowed', () => {
  it('no public RLS table is unclassified: each is allow-listed or carries <table>_deny_procurement', async () => {
    const pg = await db();
    expect(await rows(pg, `select table_name from v_procurement_unclassified_tables`)).toEqual([{ table_name: 'test_ctx' }]);   // fixture helper, no RLS; live has 46/46 tables with RLS
    const allow = (await rows(pg, `select table_name from procurement_table_allow order by 1`)).map((r) => r.table_name);
    expect(allow).toContain('purchase_orders');
    expect(allow).not.toContain('data_ledger');
    // every allow-listed table has no blanket deny; everything else has one
    expect(await c0(pg, `select count(*) n from pg_policies p where policyname = tablename || '_deny_procurement' and tablename in (select table_name from procurement_table_allow)`)).toBe(0);
    expect(await c0(pg, `select count(*) n from pg_tables t where schemaname='public' and rowsecurity and tablename not in (select table_name from procurement_table_allow) and not exists (select 1 from pg_policies p where p.tablename=t.tablename and p.policyname=t.tablename||'_deny_procurement')`)).toBe(0);
    // the allow-list itself is not readable by procurement
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from procurement_table_allow'))).toBe(0);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from procurement_table_allow'))).toBe(allow.length);
  });
  it('a table added later with a permissive USING (true) policy is flagged, leaks to procurement until swept, and is denied after the sweep', async () => {
    const pg = await db();
    await pg.exec(`CREATE TABLE zz_new_costs (id int primary key, secret text);
      INSERT INTO zz_new_costs VALUES (1, 'margin');
      ALTER TABLE zz_new_costs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY zz_read ON zz_new_costs FOR SELECT TO authenticated USING (true);
      GRANT SELECT ON zz_new_costs TO authenticated;`);
    expect(await rows(pg, `select table_name from v_procurement_unclassified_tables where table_name <> 'test_ctx' order by 1`)).toEqual([{ table_name: 'zz_new_costs' }]);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from zz_new_costs'))).toBe(1);              // the gap a static list leaves
    expect((await rows(pg, `select public.procurement_default_deny_sweep() n`))[0].n).toBeGreaterThan(0);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from zz_new_costs'))).toBe(0);
    expect(await as(pg, STAFF, () => count(pg, 'select * from zz_new_costs'))).toBe(1);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from zz_new_costs'))).toBe(1);
    expect(await rows(pg, `select table_name from v_procurement_unclassified_tables where table_name <> 'test_ctx'`)).toEqual([]);
    // idempotent, and not callable by clients
    await pg.exec(`select public.procurement_default_deny_sweep()`);
    expect(await as(pg, ADMIN, () => err(pg.exec(`select public.procurement_default_deny_sweep()`)))).toMatch(/permission denied/);
  });
  it('allow-listing a table removes its blanket deny on the next sweep', async () => {
    const pg = await db();
    await pg.exec(`CREATE TABLE zz_shared (id int); ALTER TABLE zz_shared ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON zz_shared FOR SELECT TO authenticated USING (true);
      GRANT SELECT ON zz_shared TO authenticated; INSERT INTO zz_shared VALUES (1); SELECT public.procurement_default_deny_sweep();`);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from zz_shared'))).toBe(0);
    await pg.exec(`INSERT INTO procurement_table_allow VALUES ('zz_shared','test'); SELECT public.procurement_default_deny_sweep();`);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from zz_shared'))).toBe(1);
  });
  it('repo guard: every migration after 085 that creates a public table classifies it (explicit deny, allow row, or sweep call)', () => {
    const files = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const after = Object.entries(files).filter(([f]) => /\/(\d{14})_/.exec(f)![1] > '20261024100100');
    expect(after.length).toBeGreaterThan(0);                       // 087, 088 at least
    const bad: string[] = [];
    for (const [f, sql] of after) {
      const body = sql.replace(/--.*$/gm, '');
      for (const m of body.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?([a-z_0-9]+)/gi)) {
        const t = m[1];
        const ok = new RegExp(`${t}_deny_procurement`).test(body) || /procurement_default_deny_sweep\s*\(/.test(body) ||
          new RegExp(`procurement_table_allow[^;]*'${t}'`, 's').test(body);
        if (!ok) bad.push(`${f.split('/').pop()}: ${t}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('S4 (own change set 087): is_profiles_admin() row_security leak', () => {
  const BATCH = `BEGIN; SELECT public.is_profiles_admin() a; SELECT current_setting('row_security') rs; SELECT count(*) FROM suppliers; COMMIT;`;
  const runBatch = (pg: PGlite, uid: string) => as(pg, uid, async () => {
    try {
      const r = await pg.exec(BATCH);
      return { rs: r.map((x) => x.rows[0]?.rs).find((v) => v !== undefined) as string, error: null as string | null };
    } catch (e) {
      await pg.exec('ROLLBACK');
      return { rs: null, error: (e as Error).message };
    }
  });
  const def = async (pg: PGlite) => String((await rows(pg, `select pg_get_functiondef('public.is_profiles_admin()'::regprocedure) d`))[0].d);

  it('fixture is byte-for-byte the live definition (so tests run against live behaviour)', async () => {
    const pg = await db();
    expect(await def(pg)).toBe(LIVE_IS_PROFILES_ADMIN_DEF);
  });

  it('LIVE BEHAVIOUR: after is_profiles_admin() the rest of the transaction runs with row_security=off, so invoker queries on RLS tables fail', async () => {
    const pg = await db();
    for (const uid of [BUYER_QT, STAFF, ADMIN]) {
      expect((await runBatch(pg, uid)).error).toMatch(/query would be affected by row-level security policy/);
    }
  });

  it('087 up: row_security is restored on return, admin answers unchanged, grants kept', async () => {
    const pg = await db();
    const aclBefore = (await rows(pg, `select proacl::text a from pg_proc where proname='is_profiles_admin'`))[0].a;
    await pg.exec(MIG087);
    for (const uid of [BUYER_QT, STAFF, ADMIN]) expect(await runBatch(pg, uid)).toEqual({ rs: 'on', error: null });
    expect(await as(pg, ADMIN, () => rows(pg, 'select public.is_profiles_admin() a'))).toEqual([{ a: true }]);
    expect(await as(pg, STAFF, () => rows(pg, 'select public.is_profiles_admin() a'))).toEqual([{ a: false }]);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select public.is_profiles_admin() a'))).toEqual([{ a: false }]);
    expect((await rows(pg, `select proconfig::text c from pg_proc where proname='is_profiles_admin'`))[0].c).toMatch(/row_security=off/);
    expect((await rows(pg, `select proacl::text a from pg_proc where proname='is_profiles_admin'`))[0].a).toBe(aclBefore);
  });

  it('087 rollback restores the exact live definition (byte-for-byte), and the rollback file embeds it verbatim', async () => {
    const pg = await db();
    await pg.exec(MIG087);
    expect(await def(pg)).not.toBe(LIVE_IS_PROFILES_ADMIN_DEF);
    await pg.exec(RB087);
    expect(await def(pg)).toBe(LIVE_IS_PROFILES_ADMIN_DEF);
    expect(RB087).toContain(LIVE_IS_PROFILES_ADMIN_DEF.trimEnd());
  });

  it('087 is independent of 084/085 (does not mention them)', async () => {
    expect(MIG087.replace(/^--.*$/gm, '')).not.toMatch(/procurement|084|085/i);
  });
});

describe('PR #92 review fixes: S1 UI-facing DB surface', () => {
  it('v_my_entities: procurement sees only its own entities (cannot read business_entities); staff and admin see all', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from business_entities'))).toBe(0);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select code, name, procurement_tag from v_my_entities order by 1')))
      .toEqual([{ code: 'QT', name: 'Quackteow', procurement_tag: 'quackteow' }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select code from v_my_entities'))).toEqual([{ code: 'MH' }]);
    expect(await as(pg, STAFF, () => count(pg, 'select * from v_my_entities'))).toBe(2);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from v_my_entities'))).toBe(2);
    await pg.exec(`DELETE FROM user_entities WHERE user_id='${BUYER_QT}'`);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from v_my_entities'))).toBe(0);
  });

  it('the exact payloads the screens now send work for procurement: pending supplier, entity-tagged draft PO, uom-carrying receipt', async () => {
    const pg = await db();
    // supplier insert as the UI builds it (status pending, created_by from the column default)
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO suppliers (name, payment_terms, status) VALUES ('UI Co','30d','pending')`)))).toBeNull();
    // old UI payload (no status) is refused
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO suppliers (name, payment_terms) VALUES ('Old UI Co','30d')`)))).toMatch(/row-level security/);
    // PO insert as the UI builds it (entity_code from v_my_entities, status draft)
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO purchase_orders (order_number, supplier_id, order_date, total_amount, entity_code, status) VALUES ('PO-UI','${SUP}',CURRENT_DATE,3,'QT','draft')`)))).toBeNull();
    // old UI payload (no entity_code) is refused
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO purchase_orders (order_number, supplier_id, order_date, total_amount, status) VALUES ('PO-OLDUI','${SUP}',CURRENT_DATE,3,'draft')`)))).toMatch(/row-level security/);
    // receipt carries the line's unit
    const r = await as(pg, BUYER_QT, () =>
      rows(pg, `select record_po_delivery('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":2,"expected_previous_received":0,"quantity_uom":"kg"}]'::jsonb, 'DO-UI') r`));
    expect(r[0].r).toMatchObject({ success: true });
    expect((await rows(pg, 'select quantity_uom from po_receipt_records'))[0].quantity_uom).toBe('kg');
  });
});

describe('084 costing rules', () => {
  it('price_history is append-only, even for admin and the owner', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => err(pg.exec('UPDATE price_history SET price_rm = 0')))).toMatch(/permission denied/);
    expect(await err(pg.exec('UPDATE price_history SET price_rm = 0'))).toMatch(/price_history_append_only/);
    expect(await err(pg.exec('DELETE FROM price_history'))).toMatch(/price_history_append_only/);
    expect(await err(pg.exec('TRUNCATE price_history CASCADE'))).toMatch(/price_history_append_only/);
  });

  it('incomplete lines keep the dish cost NULL; COGS is split dine-in / takeaway', async () => {
    const pg = await db();
    await pg.exec(`
      INSERT INTO menu_items (id, entity_code, name, source_sheet, selling_price_ex_sst_rm, packaging_rule, pkg_takeaway_rm)
        VALUES ('00000000-0000-0000-0000-0000000aaa01','MH','A','F-A',10,'takeaway only',0.5),
               ('00000000-0000-0000-0000-0000000aaa02','MH','B','F-B',10,'takeaway only',NULL);
      INSERT INTO bom_lines (entity_code, menu_item_id, component_name, line_cost_rm, cost_complete) VALUES
        ('MH','00000000-0000-0000-0000-0000000aaa01','x',2,true),
        ('MH','00000000-0000-0000-0000-0000000aaa02','x',2,true),
        ('MH','00000000-0000-0000-0000-0000000aaa02','chili paste',NULL,false);`);
    const r = await rows(pg, 'select name, cost_complete, food_cost_rm::float f, cogs_dine_in_pct::float d, cogs_takeaway_pct::float t from v_dish_cogs order by name');
    expect(r).toEqual([
      { name: 'A', cost_complete: true, f: 2, d: 20, t: 25 },
      { name: 'B', cost_complete: false, f: null, d: null, t: null },
    ]);
    expect(await err(pg.exec(`INSERT INTO bom_lines (entity_code, menu_item_id, component_name, cost_complete, price_basis)
      VALUES ('MH','00000000-0000-0000-0000-0000000aaa01','y',true,'pending')`))).toMatch(/check constraint/);
  });

  it('seed script loads: counts, incomplete costs NULL, tags', async () => {
    const pg = await db();
    await pg.exec(SEED);
    const c = async (sql: string) => Number((await rows(pg, sql))[0].n);
    expect(await c(`select count(*) n from supplier_items where source_list='MASTER_LIST_2_20261023'`)).toBe(232);
    expect(await c(`select count(*) n from supplier_items where procurement_tag='quackteow' and source_list is not null`)).toBe(34);
    expect(await c('select count(*) n from menu_items')).toBe(51);
    expect(await c('select count(*) n from sub_recipes')).toBe(27);
    expect(await c('select count(*) n from bom_lines')).toBe(560);
    expect(await c('select count(*) n from bom_lines where not cost_complete')).toBe(17);
    expect(await c('select count(*) n from bom_lines where not cost_complete and price_basis = \'pending\' and line_cost_rm is not null')).toBe(0);
    expect(await c(`select count(*) n from price_history where source='seed'`)).toBe(230);
    expect(await c(`select count(*) n from v_recipe_cost where kind='dish' and not cost_complete and food_cost_rm is null`))
      .toBe(await c(`select count(*) n from v_recipe_cost where kind='dish' and not cost_complete`));
    expect(await c(`select count(*) n from v_recipe_cost where kind='dish' and not cost_complete`)).toBe(11);
    expect(await c(`select count(*) n from v_recipe_cost where kind='sub-recipe' and not cost_complete`)).toBe(3);
    // cost per serving = sum(lines) x (1 + wastage) / servings, matching the cleaned dish_costs.csv
    const cost = async (sheet: string) => Number((await rows(pg, `select food_cost_rm n from v_recipe_cost where source_sheet = '${sheet}'`))[0].n);
    expect(await cost('P- Nasi Ayam (Nasi 2.0)')).toBeCloseTo(0.7249, 4);
    expect(await cost('P-CUCUR ')).toBeCloseTo(0.3121, 4);
    // idempotent
    await pg.exec(SEED);
    expect(await c('select count(*) n from bom_lines')).toBe(560);
  });

  it('rollbacks drop 085 then 084 cleanly', async () => {
    const pg = await db();
    await pg.exec(RB088);
    await pg.exec(RB085);
    await pg.exec(RB084);
    expect(await c0(pg, `select count(*) n from pg_tables where tablename in ('supplier_items','price_history','menu_items','supplier_bills','supplier_payments','user_entities','business_entities','procurement_tags','delivery_location_entities')`)).toBe(0);
    const [a] = await rows(pg, `select position('procurement' in pg_get_functiondef('admin_set_profile_role_and_outlet(uuid,text,uuid)'::regprocedure)) p`);
    expect(a.p).toBe(0);
    // only 081's two live procurement_settings policies remain (S5)
    expect((await rows(pg, `select policyname from pg_policies where policyname like '%procurement%' order by 1`)).map((r) => r.policyname))
      .toEqual(['procurement_settings_admin_write', 'procurement_settings_read']);
    const [d] = await rows(pg, `select position('_consume_po_receipt_ticket' in pg_get_functiondef('receive_po_shipment(uuid,jsonb)'::regprocedure)) p`);
    expect(d.p).toBe(0);
  });
});

async function c0(pg: PGlite, sql: string) {
  return Number((await rows(pg, sql))[0].n);
}
