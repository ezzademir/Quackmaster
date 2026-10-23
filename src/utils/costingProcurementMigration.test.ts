import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import MIG081 from '../../supabase/migrations/20261023130000_081_po_receipt_variance.sql?raw';
import MIG082 from '../../supabase/migrations/20261024020000_082_costing_schema.sql?raw';
import MIG083 from '../../supabase/migrations/20261024020100_083_procurement_role.sql?raw';
import RB082 from '../../supabase/rollbacks/082_rollback.sql?raw';
import RB083 from '../../supabase/rollbacks/083_rollback.sql?raw';
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

/** Minimal live-shaped schema: the tables / helpers 081-083 touch, with live-style permissive policies. */
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
CREATE VIEW supplier_scorecard_metrics AS SELECT poi.quantity_received FROM purchase_order_items poi;
CREATE TABLE recipes (id uuid primary key default gen_random_uuid(), name text);
CREATE TABLE sales_journals (id uuid primary key default gen_random_uuid(), outlet_id uuid);
CREATE TABLE outlet_inventory (id uuid primary key default gen_random_uuid(), outlet_id uuid, qty numeric);
CREATE TABLE document_links (id uuid primary key default gen_random_uuid(), uploaded_by uuid, storage_path text);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','raw_materials','purchase_orders','purchase_order_items','hub_inventory',
    'recipes','sales_journals','outlet_inventory','document_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- live today: "authenticated USING (true)" or "role <> pending" read policies
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin())', t || '_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO authenticated', t);
  END LOOP;
END $$;
GRANT SELECT ON profiles TO authenticated;
INSERT INTO profiles (id, full_name, role) VALUES
  ('${ADMIN}','Admin','admin'), ('${ADMIN2}','Admin 2','admin'), ('${STAFF}','Staff','staff'),
  ('${BUYER_QT}','Buyer QT','pending'), ('${BUYER_MH}','Buyer MH','pending');
INSERT INTO suppliers (id, name) VALUES ('${SUP}', 'SRI TERNAK');
INSERT INTO raw_materials VALUES ('${RM}', 'Garlic', 'kg', 3, 3, now());
INSERT INTO recipes (name) VALUES ('Secret sauce');
INSERT INTO sales_journals (outlet_id) VALUES (gen_random_uuid());
INSERT INTO outlet_inventory (outlet_id, qty) VALUES (gen_random_uuid(), 5);
`;

const POS = `
UPDATE profiles SET role='procurement' WHERE id IN ('${BUYER_QT}','${BUYER_MH}');
INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${BUYER_QT}','quackteow'), ('${BUYER_MH}','merdeka_house');
INSERT INTO purchase_orders (id, order_number, supplier_id, status, entity_code) VALUES
  ('${PO_QT}','PO-QT','${SUP}','ordered','QT_PLT'), ('${PO_MH}','PO-MH','${SUP}','ordered','MH_PLT'),
  ('${PO_NONE}','PO-OLD','${SUP}','ordered',NULL);
INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total, purchase_uom)
  VALUES ('${L_QT}','${PO_QT}','${RM}',10,0,3,30,'kg');
INSERT INTO supplier_items (id, supplier_id, procurement_tag, item_name, base_unit, pack_qty_base, price_rm, status)
  VALUES ('00000000-0000-0000-0000-00000000b0b1','${SUP}','quackteow','Garlic 1kg','g',1000,10,'active'),
         ('00000000-0000-0000-0000-00000000b0b2','${SUP}','merdeka_house','Rice 10kg','g',10000,31.5,'active');
UPDATE purchase_order_items SET supplier_item_id='00000000-0000-0000-0000-00000000b0b1' WHERE id='${L_QT}';
INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, due_date, amount_rm, amount_paid_rm)
  VALUES ('QT_PLT','${SUP}','INV-1','2026-10-01','2026-10-02',100,40), ('MH_PLT','${SUP}','INV-2','2026-10-01',NULL,50,50);
`;

const db = pgliteTemplate(async (pg) => {
  for (const [n, sql] of [['BASE', BASE], ['081', MIG081], ['082', MIG082], ['083', MIG083], ['POS', POS]]) {
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

describe('082/083 procurement role RLS', () => {
  it('procurement cannot read costing, recipes, sales, outlet stock or other users', async () => {
    const pg = await db();
    await pg.exec(`INSERT INTO menu_items (entity_code, name, source_sheet, selling_price_ex_sst_rm) VALUES ('MH_PLT','Nasi','F-NASI',12);
      INSERT INTO bom_lines (entity_code, menu_item_id, component_name, line_cost_rm, cost_complete)
        SELECT 'MH_PLT', id, 'RICE', 1, true FROM menu_items;`);
    for (const t of ['menu_items', 'sub_recipes', 'bom_lines', 'v_recipe_cost', 'v_dish_cogs', 'v_cost_drift', 'v_ingredient_usage',
      'recipes', 'sales_journals', 'outlet_inventory', 'price_flag_reviews']) {
      expect(await as(pg, BUYER_MH, () => count(pg, `select * from ${t}`)), t).toBe(0);
    }
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from profiles'))).toBe(1);
    // staff and admin still see them
    expect(await as(pg, STAFF, () => count(pg, 'select * from v_recipe_cost'))).toBe(1);
    expect(await as(pg, STAFF, () => count(pg, 'select * from recipes'))).toBe(1);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from profiles'))).toBe(5);
    // and cannot write them
    expect(await as(pg, BUYER_MH, () => err(pg.exec(`INSERT INTO recipes (name) VALUES ('x')`)))).toMatch(/row-level security/);
  });

  it('procurement sees only POs, items, bills and supplier items of its own tags (untagged hidden)', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select order_number from purchase_orders order by 1'))).toEqual([{ order_number: 'PO-QT' }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select order_number from purchase_orders order by 1'))).toEqual([{ order_number: 'PO-MH' }]);
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from purchase_order_items'))).toBe(0);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select item_name from supplier_items'))).toEqual([{ item_name: 'Garlic 1kg' }]);
    expect(await as(pg, BUYER_QT, () => rows(pg, 'select bill_number, payment_status from v_supplier_bill_status')))
      .toEqual([{ bill_number: 'INV-1', payment_status: 'overdue' }]);
    expect(await as(pg, BUYER_MH, () => rows(pg, 'select payment_status from v_supplier_bill_status'))).toEqual([{ payment_status: 'paid' }]);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from price_history'))).toBe(1);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from purchase_orders'))).toBe(3);
    // a buyer with no tag sees nothing
    await pg.exec(`DELETE FROM user_entities WHERE user_id='${BUYER_QT}'`);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from purchase_orders'))).toBe(0);
  });

  it('draft PO -> submit; cannot create in another tag, approve, or approve own', async () => {
    const pg = await db();
    const ins = (status: string, ent: string) =>
      pg.exec(`INSERT INTO purchase_orders (order_number, supplier_id, status, entity_code) VALUES ('N-${status}-${ent}','${SUP}','${status}','${ent}')`);
    expect(await as(pg, BUYER_QT, () => err(ins('draft', 'MH_PLT')))).toMatch(/row-level security/);
    expect(await as(pg, BUYER_QT, () => err(ins('ordered', 'QT_ENT')))).toMatch(/procurement_po_must_start_draft/);
    expect(await as(pg, BUYER_QT, () => err(ins('draft', 'QT_ENT')))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET notes='x' WHERE order_number='N-draft-QT_ENT'`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='pending_approval' WHERE order_number='N-draft-QT_ENT'`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE order_number='N-draft-QT_ENT'`))))
      .toMatch(/po_approval_admin_only/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET notes='y' WHERE order_number='N-draft-QT_ENT'`))))
      .toMatch(/procurement_po_edit_draft_only/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_orders SET status='closed_short' WHERE id='${PO_QT}'`))))
      .toMatch(/procurement_po_status_change_not_allowed|closed_short/);
    // admin who created a PO cannot approve it; another admin can
    await as(pg, ADMIN, () => pg.exec(`INSERT INTO purchase_orders (order_number, supplier_id, status, entity_code) VALUES ('A1','${SUP}','pending_approval','MH_PLT')`));
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE order_number='A1'`)))).toMatch(/po_cannot_approve_own/);
    expect(await as(pg, ADMIN2, () => err(pg.exec(`UPDATE purchase_orders SET status='ordered' WHERE order_number='N-draft-QT_ENT'`)))).toBeNull();
    const [r] = await rows(pg, `select submitted_by, approved_by, created_by from purchase_orders where order_number='N-draft-QT_ENT'`);
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
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO purchase_orders (id, order_number, supplier_id, entity_code) VALUES ('00000000-0000-0000-0000-00000000f009','D','${SUP}','QT_PLT')`));
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
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from v_price_flags_open'))).toBe(1);
    // direct writes to receipts / quantities / close short / adjust are refused
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE purchase_order_items SET quantity_received=9 WHERE id='${L_QT}'`)))).toMatch(/procurement_po_edit_draft_only/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE po_receipt_records SET quantity_received=1`)))).toMatch(/permission denied/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select receive_po_shipment('${PO_QT}', '[{"purchase_order_item_id":"${L_QT}","quantity_received":1}]'::jsonb)`))))
      .toMatch(/procurement_po_status_change_not_allowed|receive_via_record_po_delivery|procurement_po_edit_draft_only/);
    expect((await as(pg, BUYER_QT, () => rows(pg, `select close_po_short('${PO_QT}', 'x') r`)))[0].r).toMatchObject({ success: false });
  });

  it('bills: procurement records unpaid bills only and cannot mark paid', async () => {
    const pg = await db();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('QT_ENT','${SUP}','B9','2026-10-20',10)`)))).toBeNull();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm) VALUES ('MH_PLT','${SUP}','B8','2026-10-20',10)`)))).toMatch(/row-level security/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO supplier_bills (entity_code, supplier_id, bill_number, bill_date, amount_rm, amount_paid_rm) VALUES ('QT_ENT','${SUP}','B7','2026-10-20',10,10)`)))).toMatch(/row-level security|bill_payment_admin_only/);
    await as(pg, BUYER_QT, () => pg.exec(`UPDATE supplier_bills SET amount_paid_rm=10 WHERE bill_number='B9'`));
    expect((await rows(pg, `select amount_paid_rm::float p from supplier_bills where bill_number='B9'`))[0].p).toBe(0);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE supplier_bills SET amount_paid_rm=10, paid_at=now() WHERE bill_number='B9'`)))).toBeNull();
  });
});

describe('082 costing rules', () => {
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
        VALUES ('00000000-0000-0000-0000-0000000aaa01','MH_PLT','A','F-A',10,'takeaway only',0.5),
               ('00000000-0000-0000-0000-0000000aaa02','MH_PLT','B','F-B',10,'takeaway only',NULL);
      INSERT INTO bom_lines (entity_code, menu_item_id, component_name, line_cost_rm, cost_complete) VALUES
        ('MH_PLT','00000000-0000-0000-0000-0000000aaa01','x',2,true),
        ('MH_PLT','00000000-0000-0000-0000-0000000aaa02','x',2,true),
        ('MH_PLT','00000000-0000-0000-0000-0000000aaa02','chili paste',NULL,false);`);
    const r = await rows(pg, 'select name, cost_complete, food_cost_rm::float f, cogs_dine_in_pct::float d, cogs_takeaway_pct::float t from v_dish_cogs order by name');
    expect(r).toEqual([
      { name: 'A', cost_complete: true, f: 2, d: 20, t: 25 },
      { name: 'B', cost_complete: false, f: null, d: null, t: null },
    ]);
    expect(await err(pg.exec(`INSERT INTO bom_lines (entity_code, menu_item_id, component_name, cost_complete, price_basis)
      VALUES ('MH_PLT','00000000-0000-0000-0000-0000000aaa01','y',true,'pending')`))).toMatch(/check constraint/);
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

  it('rollbacks drop 083 then 082 cleanly', async () => {
    const pg = await db();
    await pg.exec(RB083);
    await pg.exec(RB082);
    expect(await c0(pg, `select count(*) n from pg_tables where tablename in ('supplier_items','price_history','menu_items','supplier_bills','user_entities')`)).toBe(0);
    expect(await c0(pg, `select count(*) n from pg_policies where policyname like '%procurement%'`)).toBe(0);
    const [d] = await rows(pg, `select position('procurement_has_po' in pg_get_functiondef('receive_po_shipment(uuid,jsonb)'::regprocedure)) p`);
    expect(d.p).toBe(0);
  });
});

async function c0(pg: PGlite, sql: string) {
  return Number((await rows(pg, sql))[0].n);
}
