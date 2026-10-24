-- Rollback 085 (procurement role). Procurement profiles are set back to 'pending' (locked out), not deleted.
DROP FUNCTION IF EXISTS public.record_po_delivery(uuid, jsonb, text, text, text);
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
DROP VIEW IF EXISTS public.v_supplier_bill_status;
DROP FUNCTION IF EXISTS public.supplier_bill_paid_rm(uuid);
DROP TABLE IF EXISTS public.supplier_payments;
DROP FUNCTION IF EXISTS public._supplier_payments_guard();
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
    ('recipes', 'recipes_deny_procurement'),
    ('recipe_ingredients', 'recipe_ingredients_deny_procurement'),
    ('menu_items', 'menu_items_deny_procurement'),
    ('sub_recipes', 'sub_recipes_deny_procurement'),
    ('bom_lines', 'bom_lines_deny_procurement'),
    ('price_flag_reviews', 'price_flag_reviews_deny_procurement'),
    ('sales_journals', 'sales_journals_deny_procurement'),
    ('sales_journal_lines', 'sales_journal_lines_deny_procurement'),
    ('storehub_product_map', 'storehub_product_map_deny_procurement'),
    ('storehub_store_map', 'storehub_store_map_deny_procurement'),
    ('storehub_sync_runs', 'storehub_sync_runs_deny_procurement'),
    ('storehub_sync_events', 'storehub_sync_events_deny_procurement'),
    ('storehub_sync_settings', 'storehub_sync_settings_deny_procurement'),
    ('outlets', 'outlets_deny_procurement'),
    ('outlet_inventory', 'outlet_inventory_deny_procurement'),
    ('outlet_inventory_snapshots', 'outlet_inventory_snapshots_deny_procurement'),
    ('outlet_stock_movements', 'outlet_stock_movements_deny_procurement'),
    ('outlet_par', 'outlet_par_deny_procurement'),
    ('outlet_stock_take_sessions', 'outlet_stock_take_sessions_deny_procurement'),
    ('outlet_stock_take_lines', 'outlet_stock_take_lines_deny_procurement'),
    ('outlet_stock_take_open_balances', 'outlet_stock_take_open_balances_deny_procurement'),
    ('outlet_transfers', 'outlet_transfers_deny_procurement'),
    ('outlet_transfer_lines', 'outlet_transfer_lines_deny_procurement'),
    ('supply_orders', 'supply_orders_deny_procurement'),
    ('supply_order_lines', 'supply_order_lines_deny_procurement'),
    ('hub_inventory', 'hub_inventory_deny_procurement'),
    ('hub_inventory_reservations', 'hub_inventory_reservations_deny_procurement'),
    ('inventory_lots', 'inventory_lots_deny_procurement'),
    ('inventory_adjustments', 'inventory_adjustments_deny_procurement'),
    ('production_runs', 'production_runs_deny_procurement'),
    ('production_run_materials', 'production_run_materials_deny_procurement'),
    ('production_resources', 'production_resources_deny_procurement'),
    ('production_qc_observations', 'production_qc_observations_deny_procurement'),
    ('planned_batches', 'planned_batches_deny_procurement'),
    ('waste_events', 'waste_events_deny_procurement'),
    ('waste_lines', 'waste_lines_deny_procurement'),
    ('pending_registrations', 'pending_registrations_deny_procurement'),
    ('activity_logs', 'activity_logs_deny_procurement'),
    ('data_ledger', 'data_ledger_deny_procurement'),
    ('qc_audit_settings', 'qc_audit_settings_deny_procurement'),
    ('stock_take_settings', 'stock_take_settings_deny_procurement'),
    ('raw_materials', 'raw_materials_deny_procurement'),
    ('procurement_settings', 'procurement_settings_deny_procurement'),
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
END $$;
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
UPDATE public.profiles SET role = 'pending' WHERE role = 'procurement';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'staff', 'pending', 'supervisor', 'viewer'));
