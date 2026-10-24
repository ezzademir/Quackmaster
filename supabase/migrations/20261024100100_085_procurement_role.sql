/*
  085: 'procurement' role, scoped by entity tag and enforced in RLS (not just the UI).

  Depends on 081 (#88, merged + live: receive_po_shipment v2, close_po_short, adjust_po_receipt), 082 (numeric
  widening, separate PR) and 084 (costing schema).
  Draft / held: not applied anywhere.

  - profiles.role gains 'procurement'. Procurement is NOT "active staff": is_authenticated_active_staff()
    stays admin|staff, so every existing staff-gated policy and RPC already excludes it.
  - user_entities: admin-managed many-to-many user <-> procurement tag ('quackteow', 'merdeka_house').
  - Procurement users can, for their tags only:
      * create / edit DRAFT POs and submit them (draft -> pending_approval). Admin approves (-> ordered);
        nobody approves a PO they created.
      * receive deliveries via record_po_delivery (qty, unit, invoice price, DO / invoice attachment),
        within the over-receipt tolerance (081: over-tolerance needs admin + reason).
      * record supplier bills; view payment status read-only (supplier_payments are admin-only).
      * view suppliers / supplier_items / price_history for their tags; add suppliers or items as 'pending'
        (unusable on POs until an admin approves).
  - Procurement users can NOT read: recipes, BOMs, sub-recipes, menu items (prices), costing views,
    sales, PosCompare, outlet / hub stock, production, users (other than their own profile), ledgers,
    raw_materials (cost_price / weighted_avg_unit_cost); they get v_raw_material_catalog (no cost columns).
    Enforced with RESTRICTIVE policies (AND-ed with every existing permissive policy).
  - Cannot: approve a PO, close short, exceed tolerance, edit a posted receipt, mark a bill paid.
  - Audit: entered_by / entered_at on receipts, bills, price_history; created_by / submitted_by on POs.
  - Receipt prices go to price_history; > 5% above the last price is flagged (not blocked).
*/

-- ---------------------------------------------------------------- role
-- Role list reconciled with #81 (073, 'viewer', held): the constraint is the union, so either landing order
-- works as long as 073 runs before 085. 073 as written re-creates the constraint WITHOUT 'procurement';
-- if 073 is applied after 085 it must be rebased to include 'procurement' (see PR body).
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'staff', 'pending', 'supervisor', 'viewer', 'procurement'));

-- Let admins assign the role through the existing RPC. Patched in place (works with or without #81's 'viewer').
DO $$
DECLARE
  v_def text;
  v_old text := 'IF v_norm NOT IN (''admin'', ''staff'', ''supervisor''';
  v_new text := 'IF v_norm NOT IN (''admin'', ''staff'', ''supervisor'', ''procurement''';
BEGIN
  IF to_regprocedure('public.admin_set_profile_role_and_outlet(uuid, text, uuid)') IS NULL THEN RETURN; END IF;
  v_def := pg_get_functiondef('public.admin_set_profile_role_and_outlet(uuid, text, uuid)'::regprocedure);
  IF position(v_new IN v_def) > 0 THEN RETURN; END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '085: admin_set_profile_role_and_outlet role list not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;

CREATE TABLE IF NOT EXISTS public.user_entities (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  procurement_tag text NOT NULL REFERENCES public.procurement_tags(tag),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, procurement_tag)
);
ALTER TABLE public.user_entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_entities_admin ON public.user_entities;
CREATE POLICY user_entities_admin ON public.user_entities FOR ALL TO authenticated
  USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());
DROP POLICY IF EXISTS user_entities_own ON public.user_entities;
CREATE POLICY user_entities_own ON public.user_entities FOR SELECT TO authenticated
  USING (user_id = auth.uid());
REVOKE ALL ON public.user_entities FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_entities TO authenticated;

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION public.is_procurement_user()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active AND lower(trim(p.role)) = 'procurement');
$$;

CREATE OR REPLACE FUNCTION public.procurement_has_tag(p_tag text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_tag IS NOT NULL AND public.is_procurement_user() AND EXISTS (
    SELECT 1 FROM public.user_entities ue WHERE ue.user_id = auth.uid() AND ue.procurement_tag = p_tag);
$$;

CREATE OR REPLACE FUNCTION public.procurement_has_entity(p_entity_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.procurement_has_tag((SELECT be.procurement_tag FROM public.business_entities be WHERE be.code = p_entity_code));
$$;

CREATE OR REPLACE FUNCTION public.procurement_has_po(p_po_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.procurement_has_entity((SELECT po.entity_code FROM public.purchase_orders po WHERE po.id = p_po_id));
$$;

-- Who may operate POs / receipts / bills at all: admin, active staff, or procurement (tag-scoped below).
CREATE OR REPLACE FUNCTION public.is_po_operator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_authenticated_active_staff() OR public.is_procurement_user();
$$;

REVOKE ALL ON FUNCTION public.is_procurement_user(), public.procurement_has_tag(text), public.procurement_has_entity(text),
  public.procurement_has_po(uuid), public.is_po_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_procurement_user(), public.procurement_has_tag(text), public.procurement_has_entity(text),
  public.procurement_has_po(uuid), public.is_po_operator() TO authenticated;

-- ---------------------------------------------------------------- deny-list: tables procurement must never read or write
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'recipes', 'recipe_ingredients', 'menu_items', 'sub_recipes', 'bom_lines', 'price_flag_reviews',
    'sales_journals', 'sales_journal_lines', 'storehub_product_map', 'storehub_store_map', 'storehub_sync_runs',
    'storehub_sync_events', 'storehub_sync_settings',
    'outlets', 'outlet_inventory', 'outlet_inventory_snapshots', 'outlet_stock_movements', 'outlet_par',
    'outlet_stock_take_sessions', 'outlet_stock_take_lines', 'outlet_stock_take_open_balances',
    'outlet_transfers', 'outlet_transfer_lines', 'supply_orders', 'supply_order_lines',
    'hub_inventory', 'hub_inventory_reservations', 'inventory_lots', 'inventory_adjustments',
    'production_runs', 'production_run_materials', 'production_resources', 'production_qc_observations', 'planned_batches',
    'waste_events', 'waste_lines', 'pending_registrations', 'activity_logs', 'data_ledger',
    'qc_audit_settings', 'stock_take_settings', 'raw_materials', 'procurement_settings'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_deny_procurement', t);
      EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                     'USING (NOT public.is_procurement_user()) WITH CHECK (NOT public.is_procurement_user())',
                     t || '_deny_procurement', t);
    END IF;
  END LOOP;
END $$;

-- profiles: procurement sees only its own row.
DROP POLICY IF EXISTS profiles_procurement_own_only ON public.profiles;
CREATE POLICY profiles_procurement_own_only ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_procurement_user() OR id = auth.uid());

-- document_links: procurement sees only what it uploaded.
DO $$ BEGIN
  IF to_regclass('public.document_links') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS document_links_procurement_own ON public.document_links';
    EXECUTE 'CREATE POLICY document_links_procurement_own ON public.document_links AS RESTRICTIVE FOR SELECT TO authenticated
             USING (NOT public.is_procurement_user() OR uploaded_by = auth.uid())';
  END IF;
END $$;

-- ---------------------------------------------------------------- POs: scope + workflow
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid(),
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS entered_by uuid DEFAULT auth.uid(),
  ADD COLUMN IF NOT EXISTS last_edited_by uuid;

-- Restrictive scope: a procurement user only ever touches POs of their tags (untagged POs are invisible).
DROP POLICY IF EXISTS purchase_orders_procurement_scope ON public.purchase_orders;
CREATE POLICY purchase_orders_procurement_scope ON public.purchase_orders AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_procurement_user() OR public.procurement_has_entity(entity_code))
  WITH CHECK (NOT public.is_procurement_user() OR public.procurement_has_entity(entity_code));
DROP POLICY IF EXISTS purchase_order_items_procurement_scope ON public.purchase_order_items;
CREATE POLICY purchase_order_items_procurement_scope ON public.purchase_order_items AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_procurement_user() OR public.procurement_has_po(purchase_order_id))
  WITH CHECK (NOT public.is_procurement_user() OR public.procurement_has_po(purchase_order_id));

-- Permissive grants for procurement (existing write policies are admin-only).
DROP POLICY IF EXISTS purchase_orders_procurement_rw ON public.purchase_orders;
CREATE POLICY purchase_orders_procurement_rw ON public.purchase_orders FOR ALL TO authenticated
  USING (public.procurement_has_entity(entity_code)) WITH CHECK (public.procurement_has_entity(entity_code));
DROP POLICY IF EXISTS purchase_order_items_procurement_rw ON public.purchase_order_items;
CREATE POLICY purchase_order_items_procurement_rw ON public.purchase_order_items FOR ALL TO authenticated
  USING (public.procurement_has_po(purchase_order_id)) WITH CHECK (public.procurement_has_po(purchase_order_id));

-- Workflow guard for non-admins: create as draft; edit only drafts; only draft -> pending_approval;
-- no delete after submit. Approval (pending_approval -> ordered) is admin-only and never by the PO's creator.
--
-- Direct writes vs RPC writes (replaces the old app.po_rpc session flag): these trigger functions are
-- SECURITY INVOKER, so current_user is the role running the statement. A client write through PostgREST runs
-- as 'authenticated'; a write made inside a SECURITY DEFINER RPC (record_po_delivery -> receive_po_shipment,
-- close_po_short, adjust_po_receipt) runs as the function owner. The procurement draft-only rules apply to
-- direct writes; RPC writes are governed by the explicit checks inside each RPC (tag scope, DO / invoice,
-- tolerance + admin reason, admin-only close / adjust). Nothing a client can set changes current_user.
-- A supplier may be used on a PO / bill only when suppliers.status = 'active' (084 enum: active / inactive /
-- pending). SECURITY DEFINER so the answer does not depend on the caller's RLS view of suppliers (a procurement
-- user cannot see suppliers outside its tags; an unseen row must not read as "usable"). A missing row is not usable.
CREATE OR REPLACE FUNCTION public._supplier_is_active(p_supplier_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT s.status = 'active' FROM public.suppliers s WHERE s.id = p_supplier_id), false);
$$;
REVOKE ALL ON FUNCTION public._supplier_is_active(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._supplier_is_active(uuid) TO authenticated;   -- the invoker-rights PO trigger calls it

CREATE OR REPLACE FUNCTION public._po_procurement_workflow()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_admin boolean := public.is_profiles_admin();
  v_proc boolean := public.is_procurement_user() AND current_user IN ('authenticated', 'anon');
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    IF v_proc AND NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'procurement_po_must_start_draft' USING ERRCODE = 'P0001';
    END IF;
    -- pending / inactive suppliers cannot be used on a live PO, whoever writes it and whether or not any line
    -- carries a supplier_item_id (the line-level gate in 084 cannot see ad-hoc lines)
    IF NEW.supplier_id IS NOT NULL AND NEW.status IN ('draft', 'pending_approval', 'ordered')
       AND NOT public._supplier_is_active(NEW.supplier_id) THEN
      RAISE EXCEPTION 'supplier_not_approved' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF v_proc AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'procurement_po_delete_draft_only' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  NEW.created_by := OLD.created_by;
  -- supplier must be active when a live PO changes supplier, is submitted, or is approved. Not checked on
  -- receipt / close-short / adjust status moves, so a supplier deactivated later never strands goods in transit.
  IF NEW.supplier_id IS NOT NULL
     AND ((NEW.supplier_id IS DISTINCT FROM OLD.supplier_id AND NEW.status IN ('draft', 'pending_approval', 'ordered'))
          OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('pending_approval', 'ordered')))
     AND NOT public._supplier_is_active(NEW.supplier_id) THEN
    RAISE EXCEPTION 'supplier_not_approved' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'pending_approval' AND NEW.status = 'ordered' THEN
      IF NOT v_admin THEN
        RAISE EXCEPTION 'po_approval_admin_only' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.created_by IS NOT NULL AND OLD.created_by = auth.uid() THEN
        RAISE EXCEPTION 'po_cannot_approve_own' USING ERRCODE = 'P0001';
      END IF;
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    ELSIF OLD.status = 'draft' AND NEW.status = 'pending_approval' THEN
      NEW.submitted_by := auth.uid();
      NEW.submitted_at := now();
    ELSIF v_proc AND NOT (OLD.status = 'pending_approval' AND NEW.status = 'draft') THEN
      RAISE EXCEPTION 'procurement_po_status_change_not_allowed' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_proc AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'procurement_po_edit_draft_only' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_admin THEN
    NEW.approved_by := OLD.approved_by;
    NEW.approved_at := OLD.approved_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS po_procurement_workflow ON public.purchase_orders;
CREATE TRIGGER po_procurement_workflow BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._po_procurement_workflow();

CREATE OR REPLACE FUNCTION public._po_item_procurement_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.entered_by := COALESCE(auth.uid(), NEW.entered_by); END IF;
  IF TG_OP = 'UPDATE' THEN NEW.entered_by := OLD.entered_by; NEW.last_edited_by := auth.uid(); END IF;
  -- direct client writes only (see _po_procurement_workflow); RPC writes run as the function owner
  IF public.is_procurement_user() AND current_user IN ('authenticated', 'anon') THEN
    SELECT status INTO v_status FROM public.purchase_orders
      WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_order_id ELSE NEW.purchase_order_id END;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'procurement_po_edit_draft_only' USING ERRCODE = 'P0001';
    END IF;
    IF TG_OP = 'INSERT' AND COALESCE(NEW.quantity_received, 0) <> 0 THEN
      RAISE EXCEPTION 'receive_via_record_po_delivery' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS po_item_procurement_guard ON public.purchase_order_items;
CREATE TRIGGER po_item_procurement_guard BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._po_item_procurement_guard();

-- ---------------------------------------------------------------- suppliers / supplier items / price history
DROP POLICY IF EXISTS suppliers_procurement_scope ON public.suppliers;
CREATE POLICY suppliers_procurement_scope ON public.suppliers AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_procurement_user() OR created_by = auth.uid() OR EXISTS (
    SELECT 1 FROM public.supplier_items si WHERE si.supplier_id = suppliers.id AND public.procurement_has_tag(si.procurement_tag)))
  WITH CHECK (NOT public.is_procurement_user() OR (status = 'pending' AND created_by = auth.uid()));
DROP POLICY IF EXISTS suppliers_procurement_insert ON public.suppliers;
CREATE POLICY suppliers_procurement_insert ON public.suppliers FOR INSERT TO authenticated
  WITH CHECK (public.is_procurement_user() AND status = 'pending' AND created_by = auth.uid());

DROP POLICY IF EXISTS supplier_items_procurement_select ON public.supplier_items;
CREATE POLICY supplier_items_procurement_select ON public.supplier_items FOR SELECT TO authenticated
  USING (public.procurement_has_tag(procurement_tag));
DROP POLICY IF EXISTS supplier_items_procurement_insert ON public.supplier_items;
CREATE POLICY supplier_items_procurement_insert ON public.supplier_items FOR INSERT TO authenticated
  WITH CHECK (public.procurement_has_tag(procurement_tag) AND status = 'pending' AND approved_by IS NULL);

DROP POLICY IF EXISTS price_history_procurement_select ON public.price_history;
CREATE POLICY price_history_procurement_select ON public.price_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.supplier_items si
                 WHERE si.id = price_history.supplier_item_id AND public.procurement_has_tag(si.procurement_tag)));

-- raw_materials is denied to procurement (cost_price, weighted_avg_unit_cost). PO line pickers use this safe
-- view instead: no cost columns. Owner-rights view (bypasses raw_materials RLS) with an explicit caller filter.
CREATE OR REPLACE VIEW public.v_raw_material_catalog AS
SELECT rm.id, rm.name, rm.unit_of_measure
FROM public.raw_materials rm
WHERE public.is_po_operator();
REVOKE ALL ON public.v_raw_material_catalog FROM PUBLIC, anon;
GRANT SELECT ON public.v_raw_material_catalog TO authenticated;

-- ---------------------------------------------------------------- leak fixes found by the 085 audit
-- Owner-rights views bypass RLS (incl. the procurement deny-list). Make them run with the caller's rights.
DO $$ BEGIN
  IF to_regclass('public.supplier_scorecard_metrics') IS NOT NULL THEN
    ALTER VIEW public.supplier_scorecard_metrics SET (security_invoker = true);   -- cross-tag PO metrics
  END IF;
  IF to_regclass('public.recipe_variance_by_run') IS NOT NULL THEN
    ALTER VIEW public.recipe_variance_by_run SET (security_invoker = true);       -- production recipe variance
  END IF;
  -- Internal helper (outlet stock sheet) callable by ANY signed-in user with no gate; only ever called from
  -- gated SECURITY DEFINER RPCs (get_outlet_stock_take_sheet, start / submit stock take), which run as owner.
  IF to_regprocedure('public._stock_take_sheet(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public._stock_take_sheet(uuid) FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

-- ---------------------------------------------------------------- receipts (append-only records)
CREATE TABLE IF NOT EXISTS public.po_receipt_records (
  id bigserial PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE RESTRICT,
  purchase_order_item_id uuid NOT NULL REFERENCES public.purchase_order_items(id) ON DELETE RESTRICT,
  quantity_received numeric(14,4) NOT NULL,
  quantity_uom text NOT NULL CHECK (quantity_uom IN ('kg', 'g', 'unit', 'pc', 'pack', 'l', 'ml')),
  invoice_unit_price_rm numeric(12,4) CHECK (invoice_unit_price_rm IS NULL OR invoice_unit_price_rm >= 0),
  do_number text,
  invoice_number text,
  document_path text,
  entered_by uuid NOT NULL DEFAULT auth.uid(),
  entered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS po_receipt_records_po_idx ON public.po_receipt_records (purchase_order_id);
ALTER TABLE public.po_receipt_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_receipt_records_select ON public.po_receipt_records;
CREATE POLICY po_receipt_records_select ON public.po_receipt_records FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff() OR public.procurement_has_po(purchase_order_id));
-- no INSERT/UPDATE/DELETE policies: written only by record_po_delivery; posted receipts are corrected by
-- admin through adjust_po_receipt (081), never edited here.
REVOKE ALL ON public.po_receipt_records FROM PUBLIC, anon;
GRANT SELECT ON public.po_receipt_records TO authenticated;

-- Let receive_po_shipment (081) accept a procurement user ONLY when called from record_po_delivery.
-- record_po_delivery does the procurement checks (tag scope, DO / invoice, lines on this PO), then issues a
-- one-shot ticket for (PO, user, transaction). The patched guard consumes it. Clients cannot write tickets
-- (no grants, no policies) or call the consumer, so calling receive_po_shipment directly stays staff-only.
CREATE TABLE IF NOT EXISTS public.po_receipt_tickets (
  purchase_order_id uuid NOT NULL,
  user_id uuid NOT NULL,
  txid bigint NOT NULL,
  PRIMARY KEY (purchase_order_id, user_id, txid)
);
ALTER TABLE public.po_receipt_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.po_receipt_tickets FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._consume_po_receipt_ticket(p_po_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  DELETE FROM public.po_receipt_tickets
  WHERE purchase_order_id = p_po_id AND user_id = auth.uid() AND txid = txid_current();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0 AND public.procurement_has_po(p_po_id);
END $$;
REVOKE ALL ON FUNCTION public._consume_po_receipt_ticket(uuid) FROM PUBLIC, anon, authenticated;

-- Patched in place so the body stays exactly 081's (re-diffed against live 24 Oct: identical to the merged 081,
-- guard line present once). Fails loudly if the guard line is not found exactly once.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.receive_po_shipment(uuid, jsonb)'::regprocedure);
  v_old text := 'IF NOT public.is_authenticated_active_staff() THEN';
  v_new text := 'IF NOT (public.is_authenticated_active_staff() OR public._consume_po_receipt_ticket(p_po_id)) THEN';
BEGIN
  IF position(v_new IN v_def) > 0 THEN RETURN; END IF;     -- already patched (re-run)
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '085: receive_po_shipment guard not found exactly once; re-check against 081';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;

-- Receive a delivery: posts quantities through receive_po_shipment (tolerance rules unchanged: over-tolerance
-- needs admin + reason, so procurement cannot exceed it), then records unit, invoice price, DO / invoice
-- and attachment per line, and logs receipt prices to price_history (> 5% flagged).
-- p_lines: [{purchase_order_item_id, quantity_received, quantity_uom, invoice_unit_price, reason?}]
CREATE OR REPLACE FUNCTION public.record_po_delivery(p_po_id uuid, p_lines jsonb, p_do_number text DEFAULT NULL,
  p_invoice_number text DEFAULT NULL, p_document_path text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_res jsonb;
  v_line jsonb;
  v_item record;
BEGIN
  IF NOT (public.is_authenticated_active_staff() OR public.procurement_has_po(p_po_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_lines');
  END IF;
  IF public.is_procurement_user() AND COALESCE(nullif(trim(p_document_path), ''), nullif(trim(p_do_number), ''),
       nullif(trim(p_invoice_number), '')) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'do_or_invoice_required');
  END IF;
  -- Every line must belong to this PO (receive_po_shipment re-checks quantities, tolerance and status).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
             WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_items poi
                               WHERE poi.id = (l->>'purchase_order_item_id')::uuid AND poi.purchase_order_id = p_po_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'line_not_on_po');
  END IF;
  IF public.is_procurement_user() THEN
    INSERT INTO public.po_receipt_tickets (purchase_order_id, user_id, txid)
    VALUES (p_po_id, auth.uid(), txid_current()) ON CONFLICT DO NOTHING;
  END IF;
  v_res := public.receive_po_shipment(p_po_id, p_lines);
  DELETE FROM public.po_receipt_tickets WHERE purchase_order_id = p_po_id AND user_id = auth.uid();
  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
    RETURN v_res;
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT poi.id, poi.supplier_item_id, si.pack_qty_base INTO v_item
    FROM public.purchase_order_items poi LEFT JOIN public.supplier_items si ON si.id = poi.supplier_item_id
    WHERE poi.id = (v_line->>'purchase_order_item_id')::uuid AND poi.purchase_order_id = p_po_id;
    INSERT INTO public.po_receipt_records (purchase_order_id, purchase_order_item_id, quantity_received, quantity_uom,
      invoice_unit_price_rm, do_number, invoice_number, document_path, entered_by)
    VALUES (p_po_id, v_item.id, (v_line->>'quantity_received')::numeric, COALESCE(v_line->>'quantity_uom', 'unit'),
      (v_line->>'invoice_unit_price')::numeric, p_do_number, p_invoice_number, p_document_path, auth.uid());
    IF v_item.supplier_item_id IS NOT NULL AND v_line ? 'invoice_unit_price' THEN
      INSERT INTO public.price_history (supplier_item_id, price_rm, pack_qty_base, source, purchase_order_item_id, note)
      VALUES (v_item.supplier_item_id, (v_line->>'invoice_unit_price')::numeric, v_item.pack_qty_base, 'receipt', v_item.id,
              'PO receipt');
    END IF;
  END LOOP;
  RETURN v_res || jsonb_build_object('recorded_lines', jsonb_array_length(p_lines));
END $$;
REVOKE ALL ON FUNCTION public.record_po_delivery(uuid, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_po_delivery(uuid, jsonb, text, text, text) TO authenticated;

-- ---------------------------------------------------------------- supplier bills + payments
CREATE TABLE IF NOT EXISTS public.supplier_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code text NOT NULL REFERENCES public.business_entities(code),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE RESTRICT,
  bill_number text NOT NULL,
  bill_date date NOT NULL,
  due_date date,
  amount_rm numeric(14,2) NOT NULL CHECK (amount_rm >= 0),
  document_path text,
  notes text,
  entered_by uuid DEFAULT auth.uid(),   -- NULL only for service-role / SQL imports
  entered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, bill_number)
);
ALTER TABLE public.supplier_bills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_bills_staff_select ON public.supplier_bills;
CREATE POLICY supplier_bills_staff_select ON public.supplier_bills FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS supplier_bills_admin ON public.supplier_bills;
CREATE POLICY supplier_bills_admin ON public.supplier_bills FOR ALL TO authenticated
  USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());
DROP POLICY IF EXISTS supplier_bills_procurement_select ON public.supplier_bills;
CREATE POLICY supplier_bills_procurement_select ON public.supplier_bills FOR SELECT TO authenticated
  USING (public.procurement_has_entity(entity_code));
DROP POLICY IF EXISTS supplier_bills_procurement_insert ON public.supplier_bills;
CREATE POLICY supplier_bills_procurement_insert ON public.supplier_bills FOR INSERT TO authenticated
  WITH CHECK (public.procurement_has_entity(entity_code));

CREATE OR REPLACE FUNCTION public._supplier_bills_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.entered_by := COALESCE(auth.uid(), NEW.entered_by);
    NEW.entered_at := now();
  ELSE
    NEW.entered_by := OLD.entered_by;
    NEW.entered_at := OLD.entered_at;
  END IF;
  -- a bill can only be booked against an approved (active) supplier; applies to every writer, including admin
  IF (TG_OP = 'INSERT' OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id)
     AND NOT public._supplier_is_active(NEW.supplier_id) THEN
    RAISE EXCEPTION 'supplier_not_approved' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS supplier_bills_guard ON public.supplier_bills;
CREATE TRIGGER supplier_bills_guard BEFORE INSERT OR UPDATE ON public.supplier_bills
  FOR EACH ROW EXECUTE FUNCTION public._supplier_bills_guard();
REVOKE ALL ON public.supplier_bills FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_bills TO authenticated;

-- Payments: part payments allowed; recording is admin-only (RLS). Procurement never reads this table,
-- it sees only the derived status in v_supplier_bill_status.
CREATE TABLE IF NOT EXISTS public.supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES public.supplier_bills(id) ON DELETE RESTRICT,
  amount_rm numeric(14,2) NOT NULL CHECK (amount_rm > 0),
  paid_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'cheque', 'card', 'duitnow', 'other')),
  reference text,
  document_path text,   -- attachment (proof of payment) in storage
  notes text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_payments_bill_idx ON public.supplier_payments (bill_id);
ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_payments_admin ON public.supplier_payments;
CREATE POLICY supplier_payments_admin ON public.supplier_payments FOR ALL TO authenticated
  USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());
DROP POLICY IF EXISTS supplier_payments_staff_select ON public.supplier_payments;
CREATE POLICY supplier_payments_staff_select ON public.supplier_payments FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
REVOKE ALL ON public.supplier_payments FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_payments TO authenticated;

-- Audit + no overpayment. created_by is stamped; a bill's payments may not exceed its amount.
CREATE OR REPLACE FUNCTION public._supplier_payments_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amount numeric; v_paid numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    NEW.created_at := now();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  SELECT amount_rm INTO v_amount FROM public.supplier_bills WHERE id = NEW.bill_id FOR UPDATE;
  SELECT COALESCE(sum(amount_rm), 0) INTO v_paid FROM public.supplier_payments
    WHERE bill_id = NEW.bill_id AND id IS DISTINCT FROM NEW.id;
  IF v_paid + NEW.amount_rm > v_amount THEN
    RAISE EXCEPTION 'payment_exceeds_bill_balance' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS supplier_payments_guard ON public.supplier_payments;
CREATE TRIGGER supplier_payments_guard BEFORE INSERT OR UPDATE ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public._supplier_payments_guard();

-- Paid total for a bill the caller can see. Owner-rights so procurement gets the status without reading
-- supplier_payments; returns NULL for a bill outside the caller's scope.
CREATE OR REPLACE FUNCTION public.supplier_bill_paid_rm(p_bill_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT sum(sp.amount_rm) FROM public.supplier_payments sp WHERE sp.bill_id = b.id), 0)
  FROM public.supplier_bills b
  WHERE b.id = p_bill_id
    AND (public.is_authenticated_active_staff() OR public.procurement_has_entity(b.entity_code));
$$;
REVOKE ALL ON FUNCTION public.supplier_bill_paid_rm(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_bill_paid_rm(uuid) TO authenticated;

-- Payment status derived from payments: paid / overdue / part_paid / unpaid. Caller's RLS applies to bills.
CREATE OR REPLACE VIEW public.v_supplier_bill_status WITH (security_invoker = true) AS
SELECT x.id, x.entity_code, x.supplier_id, x.supplier_name, x.purchase_order_id, x.bill_number, x.bill_date, x.due_date,
       x.amount_rm, x.paid_rm, x.amount_rm - x.paid_rm AS balance_rm,
       CASE WHEN x.paid_rm >= x.amount_rm THEN 'paid'
            WHEN x.due_date IS NOT NULL AND x.due_date < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN 'overdue'
            WHEN x.paid_rm > 0 THEN 'part_paid'
            ELSE 'unpaid' END AS payment_status,
       x.entered_by, x.entered_at
FROM (SELECT b.*, s.name AS supplier_name, COALESCE(public.supplier_bill_paid_rm(b.id), 0) AS paid_rm
      FROM public.supplier_bills b JOIN public.suppliers s ON s.id = b.supplier_id) x;
REVOKE ALL ON public.v_supplier_bill_status FROM PUBLIC, anon;
GRANT SELECT ON public.v_supplier_bill_status TO authenticated;

REVOKE ALL ON FUNCTION public._po_procurement_workflow(), public._po_item_procurement_guard(),
  public._supplier_bills_guard(), public._supplier_payments_guard() FROM PUBLIC, anon, authenticated;
