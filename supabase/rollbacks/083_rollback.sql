-- Rollback 083 (procurement role). Procurement profiles are set back to 'pending' (locked out), not deleted.
DROP FUNCTION IF EXISTS public.record_po_delivery(uuid, jsonb, text, text, text);
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.receive_po_shipment(uuid, jsonb)'::regprocedure);
  v_new text := 'IF NOT (public.is_authenticated_active_staff() OR public.procurement_has_po(p_po_id)) THEN';
BEGIN
  IF position(v_new IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_new, 'IF NOT public.is_authenticated_active_staff() THEN');
  END IF;
END $$;
DROP VIEW IF EXISTS public.v_supplier_bill_status;
DROP TABLE IF EXISTS public.supplier_bills;
DROP TABLE IF EXISTS public.po_receipt_records;
DROP TRIGGER IF EXISTS po_procurement_workflow ON public.purchase_orders;
DROP TRIGGER IF EXISTS po_item_procurement_guard ON public.purchase_order_items;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
           WHERE schemaname = 'public' AND (policyname LIKE '%\_deny\_procurement' OR policyname LIKE '%procurement%') LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public._po_procurement_workflow();
DROP FUNCTION IF EXISTS public._po_item_procurement_guard();
DROP FUNCTION IF EXISTS public._supplier_bills_guard();
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS submitted_by,
  DROP COLUMN IF EXISTS submitted_at, DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
ALTER TABLE public.purchase_order_items DROP COLUMN IF EXISTS entered_by, DROP COLUMN IF EXISTS last_edited_by;
DROP TABLE IF EXISTS public.user_entities;
DROP FUNCTION IF EXISTS public.is_po_operator();
DROP FUNCTION IF EXISTS public.procurement_has_po(uuid);
DROP FUNCTION IF EXISTS public.procurement_has_entity(text);
DROP FUNCTION IF EXISTS public.procurement_has_tag(text);
DROP FUNCTION IF EXISTS public.is_procurement_user();
UPDATE public.profiles SET role = 'pending' WHERE role = 'procurement';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'staff', 'pending', 'supervisor'));
