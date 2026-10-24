-- Rollback order: 090 -> 088 -> 087 -> 085 -> 084 (newest first; 089 goes before 090); 088's rollback also tolerates running after this one.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file> (or one Supabase SQL editor / execute_sql call). NEVER plain `psql -f`: it keeps going after an error (e.g. past a raised guard) and leaves a half-done rollback.
-- GUARD: refuses to run while 090 is live. 090's triggers/RPC live on public.user_entities and the 'procurement' role that this file removes; dropping
-- 085 under them strands the profiles guard. Run 090_rollback.sql first (and 089's, if applied), then this file. Raises before touching anything.
DO $$ BEGIN
  IF to_regprocedure('public.admin_set_procurement_tags(uuid, text[])') IS NOT NULL
     OR to_regprocedure('public.profiles_guard_role_change()') IS NOT NULL
     OR to_regprocedure('public.user_entities_guard_write()') IS NOT NULL
     OR to_regprocedure('public.profiles_audit_role_change()') IS NOT NULL
     OR to_regprocedure('public.user_entities_audit_write()') IS NOT NULL THEN
    RAISE EXCEPTION '085_rollback refused: migration 090 is still live. Run supabase/rollbacks/090_rollback.sql first (order: 090 -> 088 -> 087 -> 085 -> 084).';
  END IF;
END $$;
-- Rollback 085 (procurement role). Procurement profiles are set back to 'pending' (locked out), not deleted.
DROP FUNCTION IF EXISTS public.record_po_delivery(uuid, jsonb, text, text, text);
DROP FUNCTION IF EXISTS public._canon_uom(text);
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.receive_po_shipment(uuid, jsonb)'::regprocedure);
  v_new text := 'IF NOT (public.is_authenticated_active_staff() OR public._consume_po_receipt_ticket(p_po_id)) THEN';
BEGIN
  IF position(v_new IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_new, 'IF NOT public.is_authenticated_active_staff() THEN');
  END IF;
END $$;
DROP FUNCTION IF EXISTS public._consume_po_receipt_ticket(uuid);
DROP TABLE IF EXISTS public.po_receipt_tickets;
DROP TRIGGER IF EXISTS procurement_audit ON public.purchase_orders;
DROP TRIGGER IF EXISTS procurement_audit ON public.purchase_order_items;
DROP TRIGGER IF EXISTS procurement_audit ON public.suppliers;
DROP TRIGGER IF EXISTS procurement_audit ON public.supplier_items;
DROP TRIGGER IF EXISTS procurement_audit ON public.supplier_bills;
DROP FUNCTION IF EXISTS public._procurement_audit();
DROP VIEW IF EXISTS public.v_supplier_bill_status;
DROP FUNCTION IF EXISTS public.supplier_bill_paid_rm(uuid);
DROP FUNCTION IF EXISTS public._supplier_display_name(uuid);
DROP TABLE IF EXISTS public.supplier_payments;
DROP FUNCTION IF EXISTS public._supplier_payments_guard();
DROP FUNCTION IF EXISTS public._supplier_payments_audit();
DROP TABLE IF EXISTS public.supplier_bills;
DROP VIEW IF EXISTS public.v_raw_material_catalog;
DROP TABLE IF EXISTS public.po_receipt_records;
DROP VIEW IF EXISTS public.v_my_entities;
DROP TRIGGER IF EXISTS po_procurement_workflow ON public.purchase_orders;
DROP TRIGGER IF EXISTS po_item_procurement_guard ON public.purchase_order_items;
-- Drop ONLY the policies migration 085 created, by exact (table, name). Never pattern-match on 'procurement':
-- 081's live procurement_settings_read / procurement_settings_admin_write policies must survive this rollback.
-- (Policies on tables 085 created - user_entities, po_receipt_records, supplier_bills, supplier_payments - go with their tables.)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.t, p.n FROM (VALUES
    ('profiles', 'profiles_procurement_own_only'),
    ('document_links', 'document_links_procurement_own'),
    ('purchase_orders', 'purchase_orders_procurement_scope'),
    ('purchase_order_items', 'purchase_order_items_procurement_scope'),
    ('purchase_orders', 'purchase_orders_procurement_rw'),
    ('purchase_order_items', 'purchase_order_items_procurement_rw'),
    ('suppliers', 'suppliers_procurement_scope'),
    ('suppliers', 'suppliers_procurement_insert'),
    ('supplier_items', 'supplier_items_procurement_select'),
    ('supplier_items', 'supplier_items_procurement_insert'),
    ('price_history', 'price_history_procurement_select')
  ) AS p(t, n) LOOP
    IF to_regclass('public.' || r.t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.n, r.t);
    END IF;
  END LOOP;
  -- the default-deny sweep names every deny policy exactly <table>_deny_procurement (structural match, not a LIKE on 'procurement')
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
           WHERE schemaname = 'public' AND policyname = tablename || '_deny_procurement' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;
DROP VIEW IF EXISTS public.v_procurement_unclassified_tables, public.v_procurement_unclassified_routines, public.v_procurement_unclassified_views;
DROP TABLE IF EXISTS public.procurement_exposure_allow;
DROP FUNCTION IF EXISTS public.procurement_default_deny_sweep();
DROP TABLE IF EXISTS public.procurement_table_allow;
DROP FUNCTION IF EXISTS public._po_procurement_workflow();
DROP FUNCTION IF EXISTS public._po_item_procurement_guard();
DROP FUNCTION IF EXISTS public._supplier_bills_guard();
DROP FUNCTION IF EXISTS public._supplier_is_active(uuid);
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS submitted_by,
  DROP COLUMN IF EXISTS submitted_at, DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
ALTER TABLE public.purchase_order_items DROP COLUMN IF EXISTS entered_by, DROP COLUMN IF EXISTS last_edited_by;
DROP TABLE IF EXISTS public.user_entities;
DROP FUNCTION IF EXISTS public.is_po_operator();
DROP FUNCTION IF EXISTS public.procurement_has_po(uuid);
DROP FUNCTION IF EXISTS public.procurement_has_entity(text);
DROP FUNCTION IF EXISTS public.procurement_has_tag(text);
DROP FUNCTION IF EXISTS public.is_procurement_user();
DO $$
DECLARE
  v_def text;
  v_new text := 'IF v_norm NOT IN (''admin'', ''staff'', ''supervisor'', ''procurement''';
BEGIN
  IF to_regprocedure('public.admin_set_profile_role_and_outlet(uuid, text, uuid)') IS NULL THEN RETURN; END IF;
  v_def := pg_get_functiondef('public.admin_set_profile_role_and_outlet(uuid, text, uuid)'::regprocedure);
  IF position(v_new IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_new, 'IF v_norm NOT IN (''admin'', ''staff'', ''supervisor''');
  END IF;
END $$;
-- Leak fixes (security_invoker views, _stock_take_sheet revoke) are intentionally NOT reverted.
-- A plain psql / SQL-editor session has no JWT and auth.uid() is NULL, so the 071 guard profiles_enforce_privileged_columns refuses this role change
-- (found in the 24 Oct 2026 seeded-copy rehearsal, step 4). Run the statement as service_role, the same transaction-local claim the 090 break-glass
-- runbook uses (one tested pattern, no second route past the guard). set_config(..., true) ends at COMMIT/ROLLBACK; it is also cleared right after the statement.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
UPDATE public.profiles SET role = 'pending' WHERE role = 'procurement';
SELECT set_config('request.jwt.claim.role', '', true);
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'staff', 'pending', 'supervisor', 'viewer'));
