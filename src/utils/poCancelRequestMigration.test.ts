import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import MIG081 from '../../supabase/migrations/20261023130000_081_po_receipt_variance.sql?raw';
import MIG084 from '../../supabase/migrations/20261024100000_084_costing_schema.sql?raw';
import MIG085 from '../../supabase/migrations/20261024100100_085_procurement_role.sql?raw';
import MIG087 from '../../supabase/migrations/20261024100150_087_is_profiles_admin_scope_row_security.sql?raw';
import MIG088 from '../../supabase/migrations/20261024100200_088_stock_entity_tags.sql?raw';
import MIG089 from '../../supabase/migrations/20261024100400_089_po_cancel_request.sql?raw';
import MIG091 from '../../supabase/migrations/20261026091332_091_void_supplier_bill.sql?raw';
import MIG090 from '../../supabase/migrations/20261024100300_090_profile_role_tag_guards.sql?raw';
import LIVE_CANCEL from './__fixtures__/live_cancel_purchase_order.sql?raw';
import RB088 from '../../supabase/rollbacks/088_rollback.sql?raw';
import RB089 from '../../supabase/rollbacks/089_rollback.sql?raw';
import RB090 from '../../supabase/rollbacks/090_rollback.sql?raw';
import PROCUREMENT_TSX from '../pages/Procurement.tsx?raw';

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

/** Same live-shaped costing fixture as costingProcurementMigration.test.ts, plus user_email on data_ledger (live column). */
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
  reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb, metadata jsonb, user_id uuid,
  user_email text NOT NULL DEFAULT '',
  CONSTRAINT data_ledger_operation_check CHECK (operation = ANY (ARRAY['insert','update','delete','event'])));
ALTER TABLE data_ledger ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public._append_data_ledger(a text, et text, eid text, m text, op text, ref text,
  b jsonb, af jsonb, d jsonb, md jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS
  $$ BEGIN
       INSERT INTO data_ledger(action,entity_type,entity_id,module,operation,reference_id,before_data,after_data,delta_data,metadata,user_id)
       VALUES (a,et,eid,m,op,ref,b,af,d,md,auth.uid());
     EXCEPTION WHEN OTHERS THEN RAISE WARNING 'data_ledger insert failed: %', SQLERRM;
     END $$;
REVOKE ALL ON FUNCTION public._append_data_ledger(text,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
CREATE TABLE suppliers (id uuid primary key default gen_random_uuid(), name text NOT NULL, payment_terms text,
  created_at timestamptz default now(), updated_at timestamptz default now());
CREATE TABLE raw_materials (id uuid primary key, name text, unit_of_measure text, cost_price numeric(12,2),
  weighted_avg_unit_cost numeric(14,4), updated_at timestamptz);
CREATE TABLE purchase_orders (id uuid primary key default gen_random_uuid(), order_number text, supplier_id uuid REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'draft', order_date date DEFAULT CURRENT_DATE, expected_delivery_date date,
  actual_delivery_date date, total_amount numeric, notes text, updated_at timestamptz);
CREATE TABLE purchase_order_items (id uuid primary key default gen_random_uuid(), purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE CASCADE,
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
INSERT INTO inventory_lots (id, product_batch_label, production_run_id) VALUES ('${OLD_LOT}', 'OLD-BATCH-1', (SELECT id FROM production_runs LIMIT 1));
INSERT INTO hub_inventory (id, product_batch, lot_id, quantity_on_hand, available_quantity) VALUES ('${OLD_HUB_FG}', 'OLD-BATCH-1', '${OLD_LOT}', 7, 7);
INSERT INTO hub_inventory (id, raw_material_id, quantity_on_hand, available_quantity) VALUES ('${OLD_HUB_RM}', '${RM2}', 100, 100);
INSERT INTO outlet_stock_movements (outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date, qoh_after)
  VALUES ('00000000-0000-0000-0000-00000000c0c0', (SELECT id FROM outlet_inventory LIMIT 1), 'sale', -1, CURRENT_DATE, 4);
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

const PAD_UNTAGGED = `INSERT INTO purchase_orders (order_number, supplier_id, status) SELECT 'PO-PAD-' || g, '${SUP}', 'received' FROM generate_series(1, 30) g;`;
const UNPAD = `DELETE FROM purchase_orders WHERE order_number LIKE 'PO-PAD-%';`;

const UP_TO_088: [string, string][] = [
  ['BASE', BASE],
  ['081', MIG081],
  ['LIVE_CANCEL', LIVE_CANCEL],
  ['PAD', PAD_UNTAGGED],
  ['084', MIG084],
  ['UNPAD', UNPAD],
  ['085', MIG085],
  ['087', MIG087],
  ['088', MIG088],
  ['POS', POS],
];

const db = pgliteTemplate(async (pg) => {
  for (const [n, sql] of [...UP_TO_088, ['089', MIG089], ['091', MIG091]]) {
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
const rpc = (pg: PGlite, sql: string) => rows(pg, sql).then((r) => r[0].r as Record<string, unknown>);
const deliver = (pg: PGlite, total: number, po = PO_QT, line = L_QT, prev = 0) =>
  rows(pg, `select record_po_delivery('${po}', '[{"purchase_order_item_id":"${line}","quantity_received":${total},"expected_previous_received":${prev},"invoice_unit_price":3}]'::jsonb, 'DO-089') r`);
const mov = (pg: PGlite) =>
  rows(pg, `select entity_code, quantity::float q, source_po_item_id s from hub_stock_movements where raw_material_id='${RM}' order by id`);
const split = (pg: PGlite) =>
  rows(pg, `select entity_code, quantity_on_hand::float q from v_hub_stock_by_entity where raw_material_id='${RM}' order by entity_code nulls last`);
const qoh = async (pg: PGlite) =>
  Number((await rows(pg, `select coalesce(sum(quantity_on_hand),0)::float q from hub_inventory where raw_material_id='${RM}'`))[0].q);
const poState = (pg: PGlite) =>
  rows(pg, `select status, (select quantity_received::float from purchase_order_items where id='${L_QT}') rcv from purchase_orders where id='${PO_QT}'`);
const reqs = (pg: PGlite) =>
  rows(pg, `select status, requested_by::text rb, decided_by::text db, reason, decision_reason from po_cancel_requests order by created_at, id`);
const ledgerActions = (pg: PGlite) =>
  rows(pg, `select action, entity_id, operation from data_ledger where entity_type='purchase_order' and action in ('cancelled','cancel_requested','cancel_rejected') order by id`);
const ledgerMeta = (pg: PGlite) =>
  rows(pg, `select action, metadata from data_ledger where entity_type='purchase_order' and action in ('cancelled','cancel_requested','cancel_rejected') order by id`);
const viewDef = async (pg: PGlite) =>
  String((await rows(pg, `select pg_get_viewdef('public.supplier_scorecard_metrics'::regclass, true) d`))[0].d);
const fillRate = async (pg: PGlite) =>
  Number((await rows(pg, `select avg_fill_rate::float f from supplier_scorecard_metrics where supplier_id='${SUP}'`))[0].f);

describe('089 files: stamp after 090, rollback pairing, apply/rollback headers', () => {
  const files = Object.keys(import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }));
  const stamps = files.map((f) => /\/(\d{14})_(\d+)_/.exec(f)).filter(Boolean).map((m) => [m![2], m![1]]);
  const st = Object.fromEntries(stamps);
  it('is stamped after 090 and the rollback file is paired', () => {
    expect(st['089'] > st['090']).toBe(true);
    const rb = Object.keys(import.meta.glob('../../supabase/rollbacks/*.sql', { query: '?raw', import: 'default', eager: true }));
    expect(rb.some((f) => f.endsWith('/089_rollback.sql'))).toBe(true);
  });
  it('089 header and rollback state the apply / rollback order and ONE-batch rule', () => {
    const head = MIG089.slice(0, MIG089.indexOf('*/'));
    expect(head).toMatch(/APPLY ORDER: 084, 085, 087, 088, 090, then 089/);
    expect(head).toMatch(/ROLLBACK ORDER[^\n]*089 -> 090 -> 088 -> 087 -> 085 -> 084/);
    expect(RB089.split('\n').slice(0, 2).join('\n')).toMatch(/RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file>/);
    expect(RB089.split('\n').slice(0, 2).join('\n')).toMatch(/NEVER plain `psql -f`/);
    expect(RB089.split('\n')[0]).toMatch(/089 -> 090 -> 088 -> 087 -> 085 -> 084/);
  });
  it('does not add a bill void / reverse route', () => {
    expect(MIG089).not.toMatch(/void_.*bill|reverse_.*bill|bill_void/i);
    expect(MIG090).toMatch(/bill void\/reverse route is a separate PR/);
  });
  it('cancel button and confirm no longer say the PO is deleted', () => {
    expect(PROCUREMENT_TSX).not.toMatch(/Cancel & delete order/);
    expect(PROCUREMENT_TSX).toMatch(/PoCancelPanel/);
    expect(PROCUREMENT_TSX).not.toMatch(/Cancel and permanently delete purchase order/);
    expect(PROCUREMENT_TSX).not.toMatch(/cancel_purchase_order/);
  });
});

describe('089: request then approve, reject, admin direct, guards, RLS, atomicity', () => {
  it('procurement requests with a reason; admin approves; receipts reverse QT; one cancelled ledger event; PO kept cancelled', async () => {
    const pg = await db();
    expect((await as(pg, BUYER_QT, () => deliver(pg, 10)))[0].r).toMatchObject({ success: true });
    expect(await split(pg)).toEqual([{ entity_code: 'QT', q: 10 }]);
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', '  wrong qty  ') r`));
    expect(req).toMatchObject({ success: true, status: 'pending' });
    expect(await reqs(pg)).toEqual([{ status: 'pending', rb: BUYER_QT, db: null, reason: 'wrong qty', decision_reason: null }]);
    expect(await poState(pg)).toEqual([{ status: 'received', rcv: 10 }]);
    expect(await ledgerActions(pg)).toEqual([
      expect.objectContaining({ action: 'cancel_requested', entity_id: PO_QT, operation: 'event' }),
    ]);

    const ap = await as(pg, ADMIN, () => rpc(pg, `select approve_po_cancel_request('${req.request_id}') r`));
    expect(ap).toMatchObject({ success: true, po_kept_as_cancelled: true, request_id: req.request_id });
    expect(ap.reversal_lines).toEqual([expect.objectContaining({ quantity_reversed: 10, entity_code: 'QT' })]);
    expect(await mov(pg)).toEqual([
      { entity_code: 'QT', q: 10, s: L_QT },
      { entity_code: 'QT', q: -10, s: L_QT },
    ]);
    expect(await split(pg)).toEqual([]);
    expect(await qoh(pg)).toBe(0);
    expect(await poState(pg)).toEqual([{ status: 'cancelled', rcv: 0 }]);
    expect(await reqs(pg)).toEqual([{ status: 'approved', rb: BUYER_QT, db: ADMIN, reason: 'wrong qty', decision_reason: null }]);
    expect((await ledgerActions(pg)).map((r) => r.action)).toEqual(['cancel_requested', 'cancelled']);
  });

  it('admin rejects with a reason; PO and stock unchanged', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 4));
    const before = { mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg) };
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'please cancel') r`));
    expect(await as(pg, ADMIN, () => err(pg.exec(`select reject_po_cancel_request('${req.request_id}', '  ')`)))).toMatch(/reason_required/);
    expect(await as(pg, ADMIN, () => rpc(pg, `select reject_po_cancel_request('${req.request_id}', '  keep it  ') r`)))
      .toMatchObject({ success: true, status: 'rejected' });
    expect(await reqs(pg)).toEqual([{ status: 'rejected', rb: BUYER_QT, db: ADMIN, reason: 'please cancel', decision_reason: 'keep it' }]);
    expect({ mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg) }).toEqual(before);
    expect((await ledgerActions(pg)).map((r) => r.action)).toEqual(['cancel_requested', 'cancel_rejected']);
  });

  it('admin direct cancel is one self-approved request and one cancelled ledger event (no two-step)', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 10));
    const r = await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`));
    expect(r).toMatchObject({ success: true, po_kept_as_cancelled: true });
    expect(await reqs(pg)).toEqual([{ status: 'approved', rb: ADMIN, db: ADMIN, reason: 'Admin direct cancel', decision_reason: null }]);
    expect(await ledgerActions(pg)).toEqual([expect.objectContaining({ action: 'cancelled', entity_id: PO_QT, operation: 'event' })]);
    expect(await poState(pg)).toEqual([{ status: 'cancelled', rcv: 0 }]);
    expect(await mov(pg)).toEqual([
      { entity_code: 'QT', q: 10, s: L_QT },
      { entity_code: 'QT', q: -10, s: L_QT },
    ]);

    const r2 = await as(pg, ADMIN, () => rpc(pg, `select request_cancel_purchase_order('${PO_MH}', 'admin reason') r`));
    expect(r2).toMatchObject({ success: true, po_kept_as_cancelled: true });
    expect(await rows(pg, `select status, requested_by::text rb, decided_by::text db from po_cancel_requests where purchase_order_id='${PO_MH}'`))
      .toEqual([{ status: 'approved', rb: ADMIN, db: ADMIN }]);
    expect(await count(pg, `select * from data_ledger where action='cancel_requested' and entity_id='${PO_MH}'`)).toBe(0);
    expect(await count(pg, `select * from data_ledger where action='cancelled' and entity_id='${PO_MH}'`)).toBe(1);
  });

  it('requester cannot approve their own request; another admin can', async () => {
    const pg = await db();
    // promote buyer to admin after they requested? No: an admin who requested via the request RPC
    // is self-approved already. Create a pending request, then try as the requester after making them admin.
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'own') r`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select approve_po_cancel_request('${req.request_id}')`)))).toMatch(/forbidden/);
    await pg.exec(`UPDATE profiles SET role='admin' WHERE id='${BUYER_QT}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select approve_po_cancel_request('${req.request_id}')`)))).toMatch(/cannot_decide_own_request/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select reject_po_cancel_request('${req.request_id}', 'no')`)))).toMatch(/cannot_decide_own_request/);
    expect(await reqs(pg)).toEqual([expect.objectContaining({ status: 'pending', rb: BUYER_QT })]);
    expect(await as(pg, ADMIN, () => rpc(pg, `select approve_po_cancel_request('${req.request_id}') r`))).toMatchObject({ success: true });
  });

  it('non-admin cannot approve or reject; staff cannot request; procurement cannot cancel directly', async () => {
    const pg = await db();
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'need cancel') r`));
    for (const uid of [STAFF, BUYER_QT, BUYER_MH]) {
      expect(await as(pg, uid, () => err(pg.exec(`select approve_po_cancel_request('${req.request_id}')`))), uid).toMatch(/forbidden/);
      expect(await as(pg, uid, () => err(pg.exec(`select reject_po_cancel_request('${req.request_id}', 'no')`))), uid).toMatch(/forbidden/);
    }
    expect(await as(pg, STAFF, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'staff')`)))).toMatch(/forbidden/);
    expect(await as(pg, BUYER_QT, () => rpc(pg, `select cancel_purchase_order('${PO_MH}') r`)))
      .toMatchObject({ success: false, error: 'forbidden' });
    expect(await as(pg, BUYER_MH, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'other tag')`)))).toMatch(/not_authorized/);
    expect(await reqs(pg)).toHaveLength(1);
  });

  it('a billed PO is refused on request, approve and admin cancel; nothing changes; message points at accounting', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 4));
    const BILL = '00000000-0000-0000-0000-0000000b9901';
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO supplier_bills (id, entity_code, supplier_id, purchase_order_id, bill_number, bill_date, amount_rm) VALUES ('${BILL}','QT','${SUP}','${PO_QT}','G1-1','2026-10-20',12)`));
    const snap = async () => ({
      mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg),
      rec: await count(pg, 'select * from po_receipt_records'),
      bills: await count(pg, `select * from supplier_bills where id='${BILL}'`),
      reqs: await count(pg, 'select * from po_cancel_requests'),
      ledger: await count(pg, `select * from data_ledger where action in ('cancelled','cancel_requested')`),
    });
    const before = await snap();
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'billed')`)))).toMatch(/bills_on_po/);
    expect(await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`))).toMatchObject({ success: false, error: 'bills_on_po' });
    expect(await snap()).toEqual(before);

    await pg.exec(`DELETE FROM supplier_bills WHERE id='${BILL}'`);
    const pending = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'now') r`));
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO supplier_bills (id, entity_code, supplier_id, purchase_order_id, bill_number, bill_date, amount_rm) VALUES ('${BILL}','QT','${SUP}','${PO_QT}','G1-2','2026-10-20',12)`));
    const beforeApprove = { po: await poState(pg), req: await reqs(pg), qoh: await qoh(pg) };
    expect(await as(pg, ADMIN, () => err(pg.exec(`select approve_po_cancel_request('${pending.request_id}')`)))).toMatch(/bills_on_po/);
    expect({ po: await poState(pg), req: await reqs(pg), qoh: await qoh(pg) }).toEqual(beforeApprove);
    expect(MIG089).toMatch(/Handle the bill through accounting first/);
  });

  it('an admin can void an unpaid bill, which lets the purchase order be cancelled', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 4));
    const BILL = '00000000-0000-0000-0000-0000000b9902';
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO supplier_bills (id, entity_code, supplier_id, purchase_order_id, bill_number, bill_date, amount_rm) VALUES ('${BILL}','QT','${SUP}','${PO_QT}','G1-void','2026-10-20',12)`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select void_supplier_bill('${BILL}', 'wrong bill')`)))).toMatch(/forbidden/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE supplier_bills SET purchase_order_id = NULL WHERE id='${BILL}'`)))).toMatch(/bill_void_via_rpc/);
    await as(pg, ADMIN, () => pg.exec(`INSERT INTO supplier_payments (bill_id, amount_rm, paid_on, method) VALUES ('${BILL}', 12, '2026-10-21', 'cash')`));
    expect(await as(pg, ADMIN, () => err(pg.exec(`select void_supplier_bill('${BILL}', 'paid already')`)))).toMatch(/bill_has_payments/);
    await as(pg, ADMIN, () => pg.exec(`DELETE FROM supplier_payments WHERE bill_id='${BILL}'`));
    const voided = await as(pg, ADMIN, () => rpc(pg, `select void_supplier_bill('${BILL}', 'wrong delivery') r`));
    expect(voided).toMatchObject({ success: true, purchase_order_id: PO_QT });
    expect(await rows(pg, `select purchase_order_id::text po, voided_purchase_order_id::text kept, void_reason from supplier_bills where id='${BILL}'`)).toEqual([
      { po: null, kept: PO_QT, void_reason: 'wrong delivery' },
    ]);
    expect(await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`))).toMatchObject({ success: true });
    expect(await count(pg, `select * from data_ledger where entity_type='supplier_bill' and action='voided'`)).toBe(1);
  });

  it('empty / blank reason is refused; a second pending request is refused; double decision is refused; cancelled PO is refused', async () => {
    const pg = await db();
    for (const reason of ['', '   ']) {
      expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', '${reason}')`)))).toMatch(/reason_required/);
    }
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'first') r`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'second')`)))).toMatch(/pending_request_exists/);
    await as(pg, ADMIN, () => rpc(pg, `select reject_po_cancel_request('${req.request_id}', 'no') r`));
    expect(await as(pg, ADMIN, () => err(pg.exec(`select reject_po_cancel_request('${req.request_id}', 'again')`)))).toMatch(/request_already_decided/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`select approve_po_cancel_request('${req.request_id}')`)))).toMatch(/request_already_decided/);
    const again = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'retry') r`));
    await as(pg, ADMIN, () => rpc(pg, `select approve_po_cancel_request('${again.request_id}') r`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'late')`)))).toMatch(/already_cancelled/);
    expect(await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`))).toMatchObject({ success: false, error: 'already_cancelled' });
  });

  it('a failed ledger insert rolls the cancel back (fail closed): request, stock and PO unchanged', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 6));
    const BREAK = `ALTER TABLE data_ledger ADD CONSTRAINT zz_ledger_down CHECK (action NOT IN ('cancelled','cancel_requested','cancel_rejected')) NOT VALID`;
    await pg.exec(BREAK);
    const before = { mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg), reqs: await count(pg, 'select * from po_cancel_requests') };
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'x')`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`select cancel_purchase_order('${PO_QT}')`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect({ mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg), reqs: await count(pg, 'select * from po_cancel_requests') }).toEqual(before);

    await pg.exec(`ALTER TABLE data_ledger DROP CONSTRAINT zz_ledger_down`);
    const pending = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'x') r`));
    await pg.exec(BREAK);
    const beforeApprove = { mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg), req: await reqs(pg) };
    expect(await as(pg, ADMIN, () => err(pg.exec(`select approve_po_cancel_request('${pending.request_id}')`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect({ mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg), req: await reqs(pg) }).toEqual(beforeApprove);
  });

  it('RLS: no client writes; reads are admin or the requester only', async () => {
    const pg = await db();
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'rls') r`));
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`INSERT INTO po_cancel_requests (purchase_order_id, requested_by, reason, status) VALUES ('${PO_MH}','${BUYER_QT}','x','pending')`))))
      .toMatch(/permission denied|row-level security/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE po_cancel_requests SET status='rejected' WHERE id='${req.request_id}'`))))
      .toMatch(/permission denied|row-level security/);
    expect(await as(pg, BUYER_QT, () => count(pg, 'select * from po_cancel_requests'))).toBe(1);
    expect(await as(pg, BUYER_MH, () => count(pg, 'select * from po_cancel_requests'))).toBe(0);
    expect(await as(pg, STAFF, () => count(pg, 'select * from po_cancel_requests'))).toBe(0);
    expect(await as(pg, ADMIN, () => count(pg, 'select * from po_cancel_requests'))).toBe(1);
    await pg.exec('SET ROLE anon');
    const anonErr = await err(pg.exec('select * from po_cancel_requests'));
    await pg.exec('RESET ROLE');
    expect(anonErr).toMatch(/permission denied/);
  });

  it('admin cancel of a billed PO returns the accounting message, detail and bill numbers to the caller', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 4));
    await as(pg, BUYER_QT, () => pg.exec(`INSERT INTO supplier_bills (id, entity_code, supplier_id, purchase_order_id, bill_number, bill_date, amount_rm) VALUES ('00000000-0000-0000-0000-0000000b9902','QT','${SUP}','${PO_QT}','G1-SOFT','2026-10-20',12)`));
    const r = await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`));
    expect(r).toMatchObject({ success: false, error: 'bills_on_po', bill_count: 1 });
    expect(String(r.message)).toMatch(/Handle the bill through accounting first/);
    expect(String(r.detail)).toMatch(/Handle the bill through accounting first/);
    expect(r.bill_numbers).toEqual(['G1-SOFT']);
    expect(String(r.hint)).toMatch(/G1-SOFT/);
    expect(await poState(pg)).toEqual([{ status: 'partial', rcv: 4 }]);
  });

  it('soft-return HINT object cannot overwrite success, error or message; only known stock keys merge', async () => {
    const pg = await db();
    await pg.exec(`CREATE OR REPLACE FUNCTION public._po_cancel_require_open_po(p_po_id uuid) RETURNS public.purchase_orders LANGUAGE plpgsql AS $f$
      BEGIN
        RAISE EXCEPTION 'forced_refusal' USING ERRCODE = 'P0001', DETAIL = 'forced detail',
          HINT = '{"success":true,"error":"x","message":"y","evil":1,"on_hand":5,"required_return":9,"raw_material_id":"rm1","entity_code":"QT"}';
      END $f$`);
    const r = await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`));
    expect(r).toMatchObject({ success: false, error: 'forced_refusal', message: 'forced detail', on_hand: 5, required_return: 9, raw_material_id: 'rm1', entity_code: 'QT' });
    expect(r).not.toHaveProperty('evil');
  });

  it('cancelled ledger metadata carries entity_code, requested_by, decided_by and reason', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 4));
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'wrong qty') r`));
    expect(await ledgerMeta(pg)).toEqual([
      expect.objectContaining({
        action: 'cancel_requested',
        metadata: expect.objectContaining({
          entity_code: 'QT',
          requested_by: BUYER_QT,
          decided_by: null,
          reason: 'wrong qty',
          request_id: req.request_id,
        }),
      }),
    ]);
    await as(pg, ADMIN, () => rpc(pg, `select approve_po_cancel_request('${req.request_id}') r`));
    const afterApprove = await ledgerMeta(pg);
    expect(afterApprove.map((r) => r.action)).toEqual(['cancel_requested', 'cancelled']);
    expect(afterApprove[1].metadata).toEqual(expect.objectContaining({
      entity_code: 'QT',
      requested_by: BUYER_QT,
      decided_by: ADMIN,
      reason: 'wrong qty',
      request_id: req.request_id,
    }));

    const r2 = await as(pg, BUYER_MH, () => rpc(pg, `select request_cancel_purchase_order('${PO_MH}', 'keep?') r`));
    await as(pg, ADMIN, () => rpc(pg, `select reject_po_cancel_request('${r2.request_id}', 'still needed') r`));
    const rejected = (await ledgerMeta(pg)).find((r) => r.action === 'cancel_rejected');
    expect(rejected?.metadata).toEqual(expect.objectContaining({
      entity_code: 'MH',
      requested_by: BUYER_MH,
      decided_by: ADMIN,
      reason: 'keep?',
      decision_reason: 'still needed',
      request_id: r2.request_id,
    }));

    const r3 = await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_NONE}') r`));
    expect(r3).toMatchObject({ success: true });
    const direct = (await ledgerMeta(pg)).filter((r) => r.action === 'cancelled');
    expect(direct[direct.length - 1].metadata).toEqual(expect.objectContaining({
      entity_code: null,
      requested_by: ADMIN,
      decided_by: ADMIN,
      reason: 'Admin direct cancel',
    }));
  });

  it('cancelled PO with received 0 does not change the supplier avg fill rate', async () => {
    const pg = await db();
    expect((await as(pg, BUYER_QT, () => deliver(pg, 10)))[0].r).toMatchObject({ success: true });
    const before = await fillRate(pg);
    expect(before).toBeCloseTo(1, 6);
    expect(await viewDef(pg)).toMatch(/status <> 'cancelled'|status !== 'cancelled'/);

    const PO_ZERO = '00000000-0000-0000-0000-00000000f0c0';
    const L_ZERO = '00000000-0000-0000-0000-00000000e0c0';
    await pg.exec(`INSERT INTO purchase_orders (id, order_number, supplier_id, status, entity_code) VALUES ('${PO_ZERO}','PO-ZERO','${SUP}','ordered','QT');
      INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total, purchase_uom)
      VALUES ('${L_ZERO}','${PO_ZERO}','${RM}',10,0,3,30,'kg')`);
    expect(await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_ZERO}') r`))).toMatchObject({ success: true });
    expect(await rows(pg, `select status from purchase_orders where id='${PO_ZERO}'`)).toEqual([{ status: 'cancelled' }]);
    expect(await fillRate(pg)).toBeCloseTo(before, 6);
    expect(await fillRate(pg)).toBeCloseTo(1, 6);
  });

  it('MH-tagged PO reversal through approve tags the reversal MH', async () => {
    const pg = await db();
    const L_MH = '00000000-0000-0000-0000-00000000e002';
    await pg.exec(`INSERT INTO purchase_order_items (id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total, purchase_uom)
                   VALUES ('${L_MH}','${PO_MH}','${RM}',8,0,3,24,'kg')`);
    expect((await as(pg, BUYER_MH, () => deliver(pg, 8, PO_MH, L_MH)))[0].r).toMatchObject({ success: true });
    const req = await as(pg, BUYER_MH, () => rpc(pg, `select request_cancel_purchase_order('${PO_MH}', 'mh reverse') r`));
    const ap = await as(pg, ADMIN, () => rpc(pg, `select approve_po_cancel_request('${req.request_id}') r`));
    expect(ap).toMatchObject({ success: true });
    expect(ap.reversal_lines).toEqual([expect.objectContaining({ quantity_reversed: 8, entity_code: 'MH' })]);
    expect(await mov(pg)).toEqual([
      { entity_code: 'MH', q: 8, s: L_MH },
      { entity_code: 'MH', q: -8, s: L_MH },
    ]);
    expect(await rows(pg, `select status from purchase_orders where id='${PO_MH}'`)).toEqual([{ status: 'cancelled' }]);
  });

  it('mixed tagged/untagged (pre-088) receipts reverse each portion with its own tag', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 4));
    await pg.exec('DELETE FROM hub_stock_movements');
    await as(pg, BUYER_QT, () => deliver(pg, 6, PO_QT, L_QT, 4));
    expect(await split(pg)).toEqual([{ entity_code: 'QT', q: 2 }, { entity_code: null, q: 4 }]);
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'mixed era') r`));
    expect(await as(pg, ADMIN, () => rpc(pg, `select approve_po_cancel_request('${req.request_id}') r`))).toMatchObject({ success: true });
    expect(await mov(pg)).toEqual([
      { entity_code: 'QT', q: 2, s: L_QT },
      { entity_code: 'QT', q: -2, s: L_QT },
      { entity_code: null, q: -4, s: L_QT },
    ]);
    expect(await split(pg)).toEqual([]);
    expect(await qoh(pg)).toBe(0);
    expect(await poState(pg)).toEqual([{ status: 'cancelled', rcv: 0 }]);
  });

  it('insufficient-stock refusal through approve leaves state unchanged', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => deliver(pg, 10));
    await pg.exec(`UPDATE hub_inventory SET quantity_on_hand = quantity_on_hand - 7 WHERE raw_material_id='${RM}'`);
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'used already') r`));
    const before = {
      mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg), req: await reqs(pg),
      ledger: await count(pg, `select * from data_ledger where action='cancelled'`),
    };
    expect(await as(pg, ADMIN, () => err(pg.exec(`select approve_po_cancel_request('${req.request_id}')`)))).toMatch(/insufficient_hub_quantity/);
    expect({
      mov: await mov(pg), qoh: await qoh(pg), po: await poState(pg), req: await reqs(pg),
      ledger: await count(pg, `select * from data_ledger where action='cancelled'`),
    }).toEqual(before);
    expect(before.po[0].rcv).toBe(10);
    expect(before.req[0].status).toBe('pending');

    const soft = await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`));
    expect(soft).toMatchObject({ success: false, error: 'pending_request_exists' });
    await as(pg, ADMIN, () => rpc(pg, `select reject_po_cancel_request('${req.request_id}', 'cannot reverse') r`));
    const used = await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`));
    expect(used).toMatchObject({ success: false, error: 'insufficient_hub_quantity', on_hand: 3, required_return: 10 });
    expect(String(used.message)).toMatch(/partly used/);
    expect(String(used.detail)).toMatch(/partly used/);
    expect(await poState(pg)).toEqual([{ status: 'received', rcv: 10 }]);
  });

  it('inactive procurement, untagged procurement, deactivated admin, and pending-role users are refused', async () => {
    const pg = await db();
    const snap = async () => ({
      reqs: await count(pg, 'select * from po_cancel_requests'),
      po: await poState(pg),
    });
    const before = await snap();

    await pg.exec(`UPDATE profiles SET is_active=false WHERE id='${BUYER_QT}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'inactive')`)))).toMatch(/forbidden/);
    await pg.exec(`UPDATE profiles SET is_active=true WHERE id='${BUYER_QT}'`);

    await pg.exec(`DELETE FROM user_entities WHERE user_id='${BUYER_QT}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'no tag')`)))).toMatch(/not_authorized/);
    await pg.exec(`INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${BUYER_QT}','quackteow')`);

    await pg.exec(`UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`);
    expect(await as(pg, ADMIN, () => rpc(pg, `select cancel_purchase_order('${PO_QT}') r`)))
      .toMatchObject({ success: false, error: 'forbidden' });
    const pending = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'need admin') r`));
    expect(await as(pg, ADMIN, () => err(pg.exec(`select approve_po_cancel_request('${pending.request_id}')`)))).toMatch(/forbidden/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`select reject_po_cancel_request('${pending.request_id}', 'no')`)))).toMatch(/forbidden/);
    await pg.exec(`UPDATE profiles SET is_active=true WHERE id='${ADMIN}'`);
    await as(pg, ADMIN, () => rpc(pg, `select reject_po_cancel_request('${pending.request_id}', 'reset') r`));

    await pg.exec(`UPDATE profiles SET role='pending' WHERE id='${BUYER_QT}'`);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'pending role')`)))).toMatch(/forbidden/);
    expect(await snap()).toEqual({
      reqs: before.reqs + 1,
      po: before.po,
    });
  });

  it('reason and decision_reason longer than 1000 characters are refused', async () => {
    const pg = await db();
    const long = 'x'.repeat(1001);
    const ok = 'y'.repeat(1000);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', '${long}')`))))
      .toMatch(/reason_too_long/);
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', '${ok}') r`));
    expect(req).toMatchObject({ success: true, status: 'pending' });
    expect(await as(pg, ADMIN, () => err(pg.exec(`select reject_po_cancel_request('${req.request_id}', '${long}')`))))
      .toMatch(/reason_too_long/);
    expect(await reqs(pg)).toEqual([expect.objectContaining({ status: 'pending', reason: ok })]);
  });
});

describe('089 rollback', () => {
  it('089_rollback refuses while a request is pending and leaves every 089 object unchanged', async () => {
    const pg = await db();
    await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'still pending') r`));
    const before = {
      reqs: await reqs(pg),
      po: await poState(pg),
      table: await count(pg, `select * from pg_tables where schemaname='public' and tablename='po_cancel_requests'`),
      fns: await count(pg, `select * from pg_proc where proname in ('request_cancel_purchase_order','approve_po_cancel_request','reject_po_cancel_request','_po_cancel_apply')`),
      view: await viewDef(pg),
      cancel: String((await rows(pg, `select pg_get_functiondef('public.cancel_purchase_order(uuid)'::regprocedure) d`))[0].d),
    };
    expect(before.reqs[0].status).toBe('pending');
    expect(await err(pg.exec(RB089))).toMatch(/089_rollback_refused_pending_requests|pending/);
    expect({
      reqs: await reqs(pg),
      po: await poState(pg),
      table: await count(pg, `select * from pg_tables where schemaname='public' and tablename='po_cancel_requests'`),
      fns: await count(pg, `select * from pg_proc where proname in ('request_cancel_purchase_order','approve_po_cancel_request','reject_po_cancel_request','_po_cancel_apply')`),
      view: await viewDef(pg),
      cancel: String((await rows(pg, `select pg_get_functiondef('public.cancel_purchase_order(uuid)'::regprocedure) d`))[0].d),
    }).toEqual(before);
    expect(before.view).toMatch(/status <> 'cancelled'|status !== 'cancelled'/);
    expect(before.cancel).toMatch(/po_cancel_requests|_po_cancel_apply/);
  });

  it('089_rollback succeeds when no request is pending', async () => {
    const pg = await db();
    const req = await as(pg, BUYER_QT, () => rpc(pg, `select request_cancel_purchase_order('${PO_QT}', 'will drop') r`));
    await as(pg, ADMIN, () => rpc(pg, `select reject_po_cancel_request('${req.request_id}', 'rollback rehearsal') r`));
    expect(await viewDef(pg)).toMatch(/status <> 'cancelled'|status !== 'cancelled'/);
    expect(await err(pg.exec(RB089))).toBeNull();
    expect(await err(pg.exec(RB089))).toBeNull();
    expect(await count(pg, `select * from pg_tables where tablename='po_cancel_requests'`)).toBe(0);
    expect(await count(pg, `select * from pg_proc where proname in ('request_cancel_purchase_order','approve_po_cancel_request','reject_po_cancel_request','_po_cancel_apply')`)).toBe(0);
    const def = String((await rows(pg, `select pg_get_functiondef('public.cancel_purchase_order(uuid)'::regprocedure) d`))[0].d);
    expect(def).toMatch(/_append_data_ledger/);
    expect(def).toMatch(/po_kept_as_cancelled/);
    expect(def).not.toMatch(/po_cancel_requests|_po_cancel_apply|_po_cancel_ledger_write/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'x')`)))).toMatch(/does not exist|function request_cancel/);
    const restored = await viewDef(pg);
    expect(restored).not.toMatch(/cancelled/);
    expect(restored).toMatch(/avg_fill_rate/);
    expect(await count(pg, `select * from pg_class c where relname='supplier_scorecard_metrics' and reloptions::text like '%security_invoker=true%'`)).toBe(1);
  });

  it('089_rollback is safe to run first: drops 089 objects and restores the 088 cancel', async () => {
    const pg = await db();
    expect(await err(pg.exec(RB089))).toBeNull();
    expect(await err(pg.exec(RB089))).toBeNull();
    expect(await count(pg, `select * from pg_tables where tablename='po_cancel_requests'`)).toBe(0);
    expect(await count(pg, `select * from pg_proc where proname in ('request_cancel_purchase_order','approve_po_cancel_request','reject_po_cancel_request','_po_cancel_apply')`)).toBe(0);
    const def = String((await rows(pg, `select pg_get_functiondef('public.cancel_purchase_order(uuid)'::regprocedure) d`))[0].d);
    expect(def).toMatch(/_append_data_ledger/);
    expect(def).toMatch(/po_kept_as_cancelled/);
    expect(def).not.toMatch(/po_cancel_requests|_po_cancel_apply|_po_cancel_ledger_write/);
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`select request_cancel_purchase_order('${PO_QT}', 'x')`)))).toMatch(/does not exist|function request_cancel/);
  });
  it('after 089_rollback the 088 rollback still runs (documented reverse order)', async () => {
    const pg = await db();
    await pg.exec(RB089);
    expect(await err(pg.exec(RB088))).toBeNull();
    expect(await count(pg, `select * from pg_proc where proname='_po_cancel_plan'`)).toBe(0);
  });
  it('089 refuses to apply without 088', async () => {
    const pg = await db();
    await pg.exec(RB089);
    await pg.exec(RB088);
    expect(await err(pg.exec(MIG089))).toMatch(/depends on 088/);
  });
});

describe('089: 090 is not required (own change set) and rollback headers still mention 089 first', () => {
  it('RB090 still documents 089 -> 090 -> ... and 089_rollback does not touch 090 objects', () => {
    expect(RB090.split('\n')[0]).toMatch(/089 -> 090 -> 088 -> 087 -> 085 -> 084/);
    expect(RB089).not.toMatch(/profiles_guard_role_change|admin_set_procurement_tags|get_users_management_data/);
  });
});
