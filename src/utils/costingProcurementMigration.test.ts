import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import MIG081 from '../../supabase/migrations/20261023130000_081_po_receipt_variance.sql?raw';
import MIG084 from '../../supabase/migrations/20261024100000_084_costing_schema.sql?raw';
import MIG085 from '../../supabase/migrations/20261024100100_085_procurement_role.sql?raw';
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
CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS
  $$ SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND is_active) $$;
CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS
  $$ SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','staff') AND is_active) $$;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all" ON profiles FOR SELECT TO authenticated USING (public.is_profiles_admin());
CREATE POLICY "Own" ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE TABLE data_ledger (id serial, action text, entity_type text, entity_id text, module text, operation text,
  reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb, metadata jsonb);
CREATE FUNCTION public._append_data_ledger(a text, et text, eid text, m text, op text, ref text,
  b jsonb, af jsonb, d jsonb, md jsonb) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO data_ledger(action,entity_type,entity_id,module,operation,reference_id,before_data,after_data,delta_data,metadata)
     VALUES (a,et,eid,m,op,ref,b,af,d,md) $$;
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
  created_at timestamptz default now());
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
CREATE TABLE outlet_inventory (id uuid primary key default gen_random_uuid(), outlet_id uuid, qty numeric);
CREATE TABLE document_links (id uuid primary key default gen_random_uuid(), uploaded_by uuid, storage_path text);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','raw_materials','purchase_orders','purchase_order_items','hub_inventory',
    'recipes','sales_journals','outlet_inventory','document_links','outlets','production_runs'] LOOP
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
  for (const [n, sql] of [['BASE', BASE], ['081', MIG081], ['084', MIG084], ['085', MIG085], ['POS', POS]]) {
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
      // RAISE after ticket + shipment (bad price cast in the receipt insert)
      ['RAISE: invalid invoice price', BUYER_QT, call(PO_QT, line('1', ',"invoice_unit_price":"abc"')), (o) => expect(o.error).toMatch(/numeric/)],
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
    // payments: procurement can neither read nor write them; staff can read; admin writes
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from supplier_payments'))).toBe(0);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method) VALUES ('00000000-0000-0000-0000-0000000b1190',10,'2026-10-21','cash')`)))).toMatch(/row-level security/);
    expect(await as(pg, STAFF, () => err(pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method) VALUES ('00000000-0000-0000-0000-0000000b1190',10,'2026-10-21','cash')`)))).toMatch(/row-level security/);
    expect(await as(pg, STAFF, () => count(pg, 'select * from supplier_payments'))).toBe(3);
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
    await pg.exec(RB085);
    await pg.exec(RB084);
    expect(await c0(pg, `select count(*) n from pg_tables where tablename in ('supplier_items','price_history','menu_items','supplier_bills','supplier_payments','user_entities','business_entities','procurement_tags','delivery_location_entities')`)).toBe(0);
    const [a] = await rows(pg, `select position('procurement' in pg_get_functiondef('admin_set_profile_role_and_outlet(uuid,text,uuid)'::regprocedure)) p`);
    expect(a.p).toBe(0);
    expect(await c0(pg, `select count(*) n from pg_policies where policyname like '%procurement%'`)).toBe(0);
    const [d] = await rows(pg, `select position('_consume_po_receipt_ticket' in pg_get_functiondef('receive_po_shipment(uuid,jsonb)'::regprocedure)) p`);
    expect(d.p).toBe(0);
  });
});

async function c0(pg: PGlite, sql: string) {
  return Number((await rows(pg, sql))[0].n);
}
