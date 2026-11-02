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

-- ---------------------------------------------------------------- default-deny for procurement (S9)
-- Procurement is denied on EVERY public table that has RLS unless the table is explicitly allowed here. Replaces the old
-- static list of ~45 table names, which silently left any table added later (or missed) open to a policy like
-- USING (true). The allow-list holds only tables with deliberate procurement policies elsewhere in this migration.
-- A future migration that creates a public table must either (a) call public.procurement_default_deny_sweep() at its end
-- (adds the RESTRICTIVE deny), or (b) insert the table into procurement_table_allow with a note and write explicit,
-- tag-scoped policies. A repo test fails when a migration after 085 creates a table and does neither, and
-- v_procurement_unclassified_tables must always be empty.
CREATE TABLE IF NOT EXISTS public.procurement_table_allow (
  table_name text PRIMARY KEY,
  note text NOT NULL
);
ALTER TABLE public.procurement_table_allow ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS procurement_table_allow_admin ON public.procurement_table_allow;
CREATE POLICY procurement_table_allow_admin ON public.procurement_table_allow FOR SELECT TO authenticated
  USING (public.is_profiles_admin());
DROP POLICY IF EXISTS procurement_table_allow_deny_procurement ON public.procurement_table_allow;
CREATE POLICY procurement_table_allow_deny_procurement ON public.procurement_table_allow AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_procurement_user()) WITH CHECK (NOT public.is_procurement_user());
REVOKE ALL ON public.procurement_table_allow FROM PUBLIC, anon;
GRANT SELECT ON public.procurement_table_allow TO authenticated;
INSERT INTO public.procurement_table_allow (table_name, note) VALUES
  ('purchase_orders', 'draft/submit workflow, tag-scoped (purchase_orders_procurement_*)'),
  ('purchase_order_items', 'lines of in-scope POs (purchase_order_items_procurement_*)'),
  ('suppliers', 'own proposals + suppliers with items in own tags (suppliers_procurement_*)'),
  ('supplier_items', 'own tags, new items start pending (supplier_items_procurement_*)'),
  ('price_history', 'read price history of own-tag items'),
  ('supplier_bills', 'record + read bills of own entities'),
  ('supplier_payments', 'read payments of own-entity bills'),
  ('user_entities', 'a user reads own tag rows'),
  ('po_receipt_records', 'receipt records of in-scope POs'),
  ('profiles', 'own row only (profiles_procurement_own_only)'),
  ('document_links', 'own uploads only (document_links_procurement_own)')
ON CONFLICT (table_name) DO NOTHING;

-- (Re)applies the default-deny: a RESTRICTIVE <table>_deny_procurement policy on every public RLS table that is not
-- allow-listed, and removes a stale deny from a table that has since been allow-listed. Idempotent. Owner-run only.
CREATE OR REPLACE FUNCTION public.procurement_default_deny_sweep()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0; v_no_rls text;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
             AND NOT EXISTS (SELECT 1 FROM public.procurement_table_allow a WHERE a.table_name = c.relname) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.relname || '_deny_procurement', r.relname);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (NOT public.is_procurement_user()) WITH CHECK (NOT public.is_procurement_user())',
                   r.relname || '_deny_procurement', r.relname);
    n := n + 1;
  END LOOP;
  FOR r IN SELECT p.tablename, p.policyname FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.policyname = p.tablename || '_deny_procurement'
             AND EXISTS (SELECT 1 FROM public.procurement_table_allow a WHERE a.table_name = p.tablename) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
  -- a table with RLS off cannot be fenced by a policy: surface it instead of failing silently
  SELECT string_agg(c.relname, ', ') INTO v_no_rls FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
  IF v_no_rls IS NOT NULL THEN
    RAISE WARNING 'procurement default-deny: tables WITHOUT row level security (policies cannot fence them): %', v_no_rls;
  END IF;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.procurement_default_deny_sweep() FROM PUBLIC, anon, authenticated;
-- (the sweep itself runs at the very END of this migration, after every table 085 creates exists)

-- Monitoring: public tables that are neither allow-listed nor carrying the deny policy. Must be empty. rls_enabled = false
-- rows are tables a policy cannot fence at all (the sweep also warns about them): enable RLS on them or allow-list them.
CREATE OR REPLACE VIEW public.v_procurement_unclassified_tables WITH (security_invoker = true) AS
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND NOT EXISTS (SELECT 1 FROM public.procurement_table_allow a WHERE a.table_name = c.relname)
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                  AND p.policyname = c.relname || '_deny_procurement');
REVOKE ALL ON public.v_procurement_unclassified_tables FROM PUBLIC, anon;
GRANT SELECT ON public.v_procurement_unclassified_tables TO authenticated;

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
    -- the PO a line is moving TO (INSERT / UPDATE) and the PO it is leaving (UPDATE / DELETE) must both be
    -- drafts: a line cannot be pulled out of an ordered PO into a draft, nor edited in a non-draft PO
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      SELECT status INTO v_status FROM public.purchase_orders WHERE id = NEW.purchase_order_id;
      IF v_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'procurement_po_edit_draft_only' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      SELECT status INTO v_status FROM public.purchase_orders WHERE id = OLD.purchase_order_id;
      IF v_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'procurement_po_edit_draft_only' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- received quantities move only through record_po_delivery (hub stock, tolerance, receipt record)
    IF TG_OP = 'INSERT' AND COALESCE(NEW.quantity_received, 0) <> 0 THEN
      RAISE EXCEPTION 'receive_via_record_po_delivery' USING ERRCODE = 'P0001';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.quantity_received IS DISTINCT FROM OLD.quantity_received THEN
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

-- Entities the caller may post against. Procurement cannot read business_entities (staff-only policy), yet the PO
-- and bill forms need the entity picker, so this owner-rights view returns only the caller's own tags
-- (all entities for admin / active staff). No other columns than the picker needs.
CREATE OR REPLACE VIEW public.v_my_entities AS
SELECT be.code, be.name, be.procurement_tag
FROM public.business_entities be
WHERE public.is_authenticated_active_staff() OR public.procurement_has_tag(be.procurement_tag);
REVOKE ALL ON public.v_my_entities FROM PUBLIC, anon;
GRANT SELECT ON public.v_my_entities TO authenticated;

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
  quantity_uom text NOT NULL CHECK (btrim(quantity_uom) <> ''),   -- S8: validated against the PO line's own unit in record_po_delivery, not a fixed list (live PO lines carry free-text units)
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

-- Unit canonicaliser, the SAME alias map as src/utils/procurementPayloads.ts normalizeUom: 'pcs' = 'pc', 'litre' = 'l', ...
-- A unit that is not in the map (free text such as 'bag', 'carton') is compared as lower(trim(x)) verbatim. Used on BOTH
-- sides of the record_po_delivery unit check so a screen that normalises and a line that does not still agree (round 2, F1).
CREATE OR REPLACE FUNCTION public._canon_uom(p_uom text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE lower(btrim(COALESCE(p_uom, '')))
    WHEN '' THEN NULL
    WHEN 'kg' THEN 'kg' WHEN 'kgs' THEN 'kg' WHEN 'kilo' THEN 'kg' WHEN 'kilos' THEN 'kg' WHEN 'kilogram' THEN 'kg' WHEN 'kilograms' THEN 'kg'
    WHEN 'g' THEN 'g' WHEN 'gm' THEN 'g' WHEN 'gram' THEN 'g' WHEN 'grams' THEN 'g'
    WHEN 'l' THEN 'l' WHEN 'lt' THEN 'l' WHEN 'ltr' THEN 'l' WHEN 'litre' THEN 'l' WHEN 'litres' THEN 'l' WHEN 'liter' THEN 'l' WHEN 'liters' THEN 'l'
    WHEN 'ml' THEN 'ml' WHEN 'millilitre' THEN 'ml' WHEN 'millilitres' THEN 'ml' WHEN 'milliliter' THEN 'ml' WHEN 'milliliters' THEN 'ml'
    WHEN 'pc' THEN 'pc' WHEN 'pcs' THEN 'pc' WHEN 'piece' THEN 'pc' WHEN 'pieces' THEN 'pc'
    WHEN 'pack' THEN 'pack' WHEN 'packs' THEN 'pack' WHEN 'pkt' THEN 'pack' WHEN 'packet' THEN 'pack' WHEN 'packets' THEN 'pack'
    WHEN 'unit' THEN 'unit' WHEN 'units' THEN 'unit'
    ELSE lower(btrim(p_uom)) END;
$$;

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
  v_cur numeric;
  v_uom text;
  v_price_txt text;
  v_price numeric;
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
  -- Received quantity is a CUMULATIVE total (081): this function may only raise it. A lower value would post a
  -- negative delta against hub stock; reductions are an admin job (adjust_po_receipt). Serialise per PO first so
  -- two concurrent deliveries cannot each pass the check against the same old total.
  PERFORM 1 FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF (SELECT count(*) <> count(DISTINCT l->>'purchase_order_item_id') FROM jsonb_array_elements(p_lines) l) THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_line',
      'message', 'Each PO line may appear once per delivery.');
  END IF;
  PERFORM 1 FROM public.purchase_order_items poi
    WHERE poi.id IN (SELECT (l->>'purchase_order_item_id')::uuid FROM jsonb_array_elements(p_lines) l)
    ORDER BY poi.id FOR UPDATE;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF NULLIF(v_line->>'quantity_received', '') IS NULL OR (v_line->>'quantity_received')::numeric < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity_received',
        'purchase_order_item_id', v_line->>'purchase_order_item_id');
    END IF;
    SELECT COALESCE(poi.quantity_received, 0), poi.purchase_uom INTO v_cur, v_uom FROM public.purchase_order_items poi
      WHERE poi.id = (v_line->>'purchase_order_item_id')::uuid;
    -- S8: unit of measure. If the screen sends one it must be the PO line's own unit (a "5 kg" typed against a "g" line
    -- would post 1000x the stock). Checked here, before anything is posted.
    IF NULLIF(trim(v_line->>'quantity_uom'), '') IS NOT NULL THEN
      IF NULLIF(trim(v_uom), '') IS NOT NULL THEN
        IF public._canon_uom(v_line->>'quantity_uom') IS DISTINCT FROM public._canon_uom(v_uom) THEN
          RETURN jsonb_build_object('success', false, 'error', 'uom_mismatch',
            'purchase_order_item_id', v_line->>'purchase_order_item_id', 'line_uom', trim(v_uom), 'entered_uom', v_line->>'quantity_uom',
            'message', 'Unit of measure does not match the PO line. Enter the quantity in ' || trim(v_uom) || '.');
        END IF;
      ELSIF public._canon_uom(v_line->>'quantity_uom') NOT IN ('kg', 'g', 'unit', 'pc', 'pack', 'l', 'ml') THEN
        -- the PO line carries no unit, so the entered one must be a known unit
        RETURN jsonb_build_object('success', false, 'error', 'invalid_uom',
          'purchase_order_item_id', v_line->>'purchase_order_item_id', 'entered_uom', v_line->>'quantity_uom');
      END IF;
    END IF;
    -- S8: the invoice price is optional. Absent / null / blank is fine (receipt recorded without a price, no price-history
    -- row); a value that is not a non-negative number is refused up front instead of aborting the receipt mid-way.
    v_price_txt := NULLIF(trim(v_line->>'invoice_unit_price'), '');
    IF v_price_txt IS NOT NULL AND v_price_txt !~ '^[0-9]+(\.[0-9]+)?$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_invoice_price',
        'purchase_order_item_id', v_line->>'purchase_order_item_id',
        'message', 'Invoice unit price must be a number (0 or more), or left blank.');
    END IF;
    -- optimistic check: the screen sends the total it showed; if someone else received since, refuse instead of silently
    -- overwriting (e.g. +4 typed on a stale 5 would otherwise land on 9 when it is now 9). MANDATORY for procurement
    -- (round 2, F8: the cumulative-total contract is exactly where a stale screen or a retried request double-posts);
    -- optional for admin / staff, whose own tools (adjust_po_receipt, scripts) send totals they just read.
    IF public.is_procurement_user() AND NULLIF(btrim(v_line->>'expected_previous_received'), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'expected_previous_received_required',
        'purchase_order_item_id', v_line->>'purchase_order_item_id', 'current_received', v_cur,
        'message', 'Send expected_previous_received (the received total you saw) with every line.');
    END IF;
    IF NULLIF(v_line->>'expected_previous_received', '') IS NOT NULL
       AND (v_line->>'expected_previous_received')::numeric <> v_cur THEN
      RETURN jsonb_build_object('success', false, 'error', 'stale_received_quantity',
        'purchase_order_item_id', v_line->>'purchase_order_item_id', 'current_received', v_cur,
        'message', 'Another delivery was recorded on this line. Reload and enter this delivery again.');
    END IF;
    IF (v_line->>'quantity_received')::numeric < v_cur THEN
      RETURN jsonb_build_object('success', false, 'error', 'cannot_reduce_received',
        'purchase_order_item_id', v_line->>'purchase_order_item_id', 'current_received', v_cur,
        'entered', (v_line->>'quantity_received')::numeric,
        'message', 'Received quantity can only go up. Send the new cumulative total (already received + this delivery). A reduction needs an admin adjustment.');
    END IF;
  END LOOP;
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
    SELECT poi.id, poi.supplier_item_id, poi.purchase_uom, si.pack_qty_base INTO v_item
    FROM public.purchase_order_items poi LEFT JOIN public.supplier_items si ON si.id = poi.supplier_item_id
    WHERE poi.id = (v_line->>'purchase_order_item_id')::uuid AND poi.purchase_order_id = p_po_id;
    v_price := NULLIF(trim(v_line->>'invoice_unit_price'), '')::numeric;       -- NULL when absent / null / blank (validated above)
    INSERT INTO public.po_receipt_records (purchase_order_id, purchase_order_item_id, quantity_received, quantity_uom,
      invoice_unit_price_rm, do_number, invoice_number, document_path, entered_by)
    VALUES (p_po_id, v_item.id, (v_line->>'quantity_received')::numeric,
      lower(COALESCE(NULLIF(trim(v_line->>'quantity_uom'), ''), NULLIF(trim(v_item.purchase_uom), ''), 'unit')),
      v_price, p_do_number, p_invoice_number, p_document_path, auth.uid());
    IF v_item.supplier_item_id IS NOT NULL AND v_price IS NOT NULL THEN
      INSERT INTO public.price_history (supplier_item_id, price_rm, pack_qty_base, source, purchase_order_item_id, note)
      VALUES (v_item.supplier_item_id, v_price, v_item.pack_qty_base, 'receipt', v_item.id, 'PO receipt');
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
-- S12: bills are readable only by admin and by procurement users within their assigned business tags.
-- Plain active staff (hub/outlet) read nothing: there is deliberately NO staff select policy.
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
DECLARE v_paid numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.entered_by := COALESCE(auth.uid(), NEW.entered_by);
    NEW.entered_at := now();
  ELSE
    NEW.entered_by := OLD.entered_by;
    NEW.entered_at := OLD.entered_at;
    -- S6: a bill's amount can never be edited below what has already been paid against it
    IF NEW.amount_rm < OLD.amount_rm THEN
      SELECT COALESCE(sum(amount_rm), 0) INTO v_paid FROM public.supplier_payments WHERE bill_id = NEW.id;
      IF NEW.amount_rm < v_paid THEN
        RAISE EXCEPTION 'bill_amount_below_paid' USING ERRCODE = 'P0001';
      END IF;
    END IF;
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

-- Payments: part payments allowed; recording is admin-only (RLS). S12: read is admin + procurement within the
-- tags of the payment's bill (via the bill, so a user who cannot see a bill cannot see its payments); plain staff nothing.
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
DROP POLICY IF EXISTS supplier_payments_procurement_select ON public.supplier_payments;
CREATE POLICY supplier_payments_procurement_select ON public.supplier_payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.supplier_bills b WHERE b.id = supplier_payments.bill_id
                 AND public.procurement_has_entity(b.entity_code)));
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

-- (live data_ledger_operation_check allows only insert/update/delete/event; _append_data_ledger swallows a violation, so a wrong
-- operation silently loses the audit row. Round 2, F2: 'create' -> 'insert'.)
-- S6/S7: every payment insert / edit / DELETE leaves a data_ledger entry (full row before/after), written server-side
-- by the definer so it works although data_ledger is closed to procurement and _append_data_ledger is not client-callable.
-- A payment delete is therefore allowed for admin but can never be silent.
CREATE OR REPLACE FUNCTION public._supplier_payments_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public._append_data_ledger('deleted', 'supplier_payment', OLD.id::text, 'procurement', 'delete', OLD.bill_id::text,
      to_jsonb(OLD), NULL, NULL, NULL);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM public._append_data_ledger('updated', 'supplier_payment', NEW.id::text, 'procurement', 'update', NEW.bill_id::text,
      to_jsonb(OLD), to_jsonb(NEW), NULL, NULL);
  ELSE
    PERFORM public._append_data_ledger('created', 'supplier_payment', NEW.id::text, 'procurement', 'insert', NEW.bill_id::text,
      NULL, to_jsonb(NEW), NULL, NULL);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS supplier_payments_audit ON public.supplier_payments;
CREATE TRIGGER supplier_payments_audit AFTER INSERT OR UPDATE OR DELETE ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public._supplier_payments_audit();

-- Paid total for a bill the caller can see. Owner-rights so procurement gets the status without reading
-- supplier_payments; returns NULL for a bill outside the caller's scope.
CREATE OR REPLACE FUNCTION public.supplier_bill_paid_rm(p_bill_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT sum(sp.amount_rm) FROM public.supplier_payments sp WHERE sp.bill_id = b.id), 0)
  FROM public.supplier_bills b
  WHERE b.id = p_bill_id
    AND (public.is_profiles_admin() OR public.procurement_has_entity(b.entity_code));
$$;
REVOKE ALL ON FUNCTION public.supplier_bill_paid_rm(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_bill_paid_rm(uuid) TO authenticated;

-- S6: the supplier's display name, owner-rights. The view used to INNER JOIN suppliers under the caller's RLS, so a
-- procurement user's own bill vanished whenever the supplier was outside their scope (not created by them, no item in their tag).
CREATE OR REPLACE FUNCTION public._supplier_display_name(p_supplier_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.name FROM public.suppliers s WHERE s.id = p_supplier_id;
$$;
REVOKE ALL ON FUNCTION public._supplier_display_name(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._supplier_display_name(uuid) TO authenticated;

-- Payment status derived from payments: paid / overdue / part_paid / unpaid. Caller's RLS applies to bills.
CREATE OR REPLACE VIEW public.v_supplier_bill_status WITH (security_invoker = true) AS
SELECT x.id, x.entity_code, x.supplier_id, x.supplier_name, x.purchase_order_id, x.bill_number, x.bill_date, x.due_date,
       x.amount_rm, x.paid_rm, x.amount_rm - x.paid_rm AS balance_rm,
       CASE WHEN x.paid_rm >= x.amount_rm THEN 'paid'
            WHEN x.due_date IS NOT NULL AND x.due_date < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN 'overdue'
            WHEN x.paid_rm > 0 THEN 'part_paid'
            ELSE 'unpaid' END AS payment_status,
       x.entered_by, x.entered_at
FROM (SELECT b.*, public._supplier_display_name(b.supplier_id) AS supplier_name, COALESCE(public.supplier_bill_paid_rm(b.id), 0) AS paid_rm
      FROM public.supplier_bills b) x;
REVOKE ALL ON public.v_supplier_bill_status FROM PUBLIC, anon;
GRANT SELECT ON public.v_supplier_bill_status TO authenticated;

REVOKE ALL ON FUNCTION public._po_procurement_workflow(), public._po_item_procurement_guard(),
  public._supplier_bills_guard(), public._supplier_payments_guard(), public._supplier_payments_audit() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- S7: server-side audit trail for procurement actions
-- data_ledger is closed to procurement (deny-list) and _append_data_ledger is not client-callable, so the trail is
-- written here, by SECURITY DEFINER triggers calling _append_data_ledger, never by the client. Logged: every write a
-- procurement user makes to POs, PO lines, suppliers, supplier items and bills, plus (for any actor) inserts, deletes
-- and status changes on those tables. Receipt-only line updates (quantity_received) are skipped: receive_po_shipment /
-- close_po_short / adjust_po_receipt already ledger those. Payments are audited by _supplier_payments_audit above.
CREATE OR REPLACE FUNCTION public._procurement_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_proc boolean := public.is_procurement_user();
  v_noise text[] := ARRAY['updated_at', 'updated_by', 'last_edited_by', 'quantity_received', 'line_total'];
  v_old jsonb; v_new jsonb; v_id text; v_ref text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_old := to_jsonb(OLD); v_new := NULL; v_id := OLD.id::text;
  ELSIF TG_OP = 'INSERT' THEN v_old := NULL; v_new := to_jsonb(NEW); v_id := NEW.id::text;
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_id := NEW.id::text;
    IF (v_old - v_noise) = (v_new - v_noise) THEN RETURN NULL; END IF;     -- timestamp / receipt-only churn (receipts recompute line_total)
    IF NOT v_proc AND (v_new ->> 'status') IS NOT DISTINCT FROM (v_old ->> 'status') THEN RETURN NULL; END IF;
  END IF;
  v_ref := COALESCE(v_new ->> 'purchase_order_id', v_old ->> 'purchase_order_id', v_new ->> 'supplier_id', v_old ->> 'supplier_id');
  PERFORM public._append_data_ledger(
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
    TG_TABLE_NAME, v_id, 'procurement', lower(TG_OP), v_ref, v_old, v_new, NULL,
    jsonb_build_object('actor_role', CASE WHEN v_proc THEN 'procurement' ELSE 'other' END,
                       'status_from', v_old ->> 'status', 'status_to', v_new ->> 'status'));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._procurement_audit() FROM PUBLIC, anon, authenticated;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders', 'purchase_order_items', 'suppliers', 'supplier_items', 'supplier_bills'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS procurement_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER procurement_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public._procurement_audit()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- exposure guard: views + SECURITY DEFINER functions (round 2, F7)
/*
  The default-deny above fences TABLES. Two other objects bypass table policies and reach a procurement user (who is just
  'authenticated'):
    - a VIEW that is not security_invoker (and any materialized view) reads its tables as the owner, past RLS;
    - a SECURITY DEFINER function executable by authenticated runs as the owner, past RLS (the PUBLIC default grants it).
  Convention for every migration after 085: a new view is WITH (security_invoker = true), a new SECURITY DEFINER function is
  REVOKEd from PUBLIC / anon / authenticated, and anything deliberately client-facing is recorded in
  procurement_exposure_allow with the reason it is safe for procurement (gated in its body, or tag-scoped). The views below list
  whatever is neither, and a repo test fails when a migration adds one without classifying it.
  Baseline: everything that already existed when 085 ran (live pre-PR objects + 084) is recorded as 'baseline' = NOT reviewed
  by this change. Review those one by one (see the PR description); the guard only stops NEW leaks.
*/
CREATE TABLE IF NOT EXISTS public.procurement_exposure_allow (
  kind text NOT NULL CHECK (kind IN ('function', 'view')),
  name text NOT NULL,
  note text NOT NULL,
  PRIMARY KEY (kind, name)
);
ALTER TABLE public.procurement_exposure_allow ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS procurement_exposure_allow_admin ON public.procurement_exposure_allow;
CREATE POLICY procurement_exposure_allow_admin ON public.procurement_exposure_allow FOR SELECT TO authenticated
  USING (public.is_profiles_admin());
DROP POLICY IF EXISTS procurement_exposure_allow_deny_procurement ON public.procurement_exposure_allow;
CREATE POLICY procurement_exposure_allow_deny_procurement ON public.procurement_exposure_allow AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_procurement_user()) WITH CHECK (NOT public.is_procurement_user());
REVOKE ALL ON public.procurement_exposure_allow FROM PUBLIC, anon;
GRANT SELECT ON public.procurement_exposure_allow TO authenticated;

INSERT INTO public.procurement_exposure_allow (kind, name, note)
SELECT DISTINCT 'function', p.proname, 'baseline: existed when 085 ran, client-executable SECURITY DEFINER, NOT reviewed for procurement here'
FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
WHERE ns.nspname = 'public' AND p.prosecdef
  AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
ON CONFLICT (kind, name) DO NOTHING;
INSERT INTO public.procurement_exposure_allow (kind, name, note)
SELECT 'view', c.relname, 'baseline: existed when 085 ran, not security_invoker, NOT reviewed for procurement here'
FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'public' AND c.relkind IN ('v', 'm')
  AND NOT COALESCE(c.reloptions::text[] && ARRAY['security_invoker=true', 'security_invoker=on'], false)
ON CONFLICT (kind, name) DO NOTHING;

-- ADMIN-ONLY (round 3, G4): pg_proc / pg_class are not row-secured, so without the is_profiles_admin() term every client
-- (procurement, staff) would read the name of every client-executable definer function / non-invoker view as 'unclassified'.
CREATE OR REPLACE VIEW public.v_procurement_unclassified_routines WITH (security_invoker = true) AS
SELECT DISTINCT p.proname AS function_name
FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
WHERE public.is_profiles_admin() AND ns.nspname = 'public' AND p.prosecdef
  AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
  AND NOT EXISTS (SELECT 1 FROM public.procurement_exposure_allow a WHERE a.kind = 'function' AND a.name = p.proname);
CREATE OR REPLACE VIEW public.v_procurement_unclassified_views WITH (security_invoker = true) AS
SELECT c.relname AS view_name, c.relkind = 'm' AS materialized
FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE public.is_profiles_admin() AND ns.nspname = 'public' AND c.relkind IN ('v', 'm')
  AND (c.relkind = 'm' OR NOT COALESCE(c.reloptions::text[] && ARRAY['security_invoker=true', 'security_invoker=on'], false))
  AND NOT EXISTS (SELECT 1 FROM public.procurement_exposure_allow a WHERE a.kind = 'view' AND a.name = c.relname);
REVOKE ALL ON public.v_procurement_unclassified_routines, public.v_procurement_unclassified_views FROM PUBLIC, anon;
GRANT SELECT ON public.v_procurement_unclassified_routines, public.v_procurement_unclassified_views TO authenticated;

-- ---------------------------------------------------------------- apply the default-deny (S9): keep this LAST
SELECT public.procurement_default_deny_sweep();
