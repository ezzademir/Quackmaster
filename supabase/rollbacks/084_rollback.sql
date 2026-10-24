-- Rollback 084 (costing schema). Run 085_rollback first. Drops costing data (seeded or entered).
DROP VIEW IF EXISTS public.v_price_flags_open, public.v_ingredient_usage, public.v_spend_by_supplier_ingredient,
  public.v_cost_drift, public.v_dish_cogs, public.v_recipe_cost;
DROP TRIGGER IF EXISTS po_line_supplier_item_active ON public.purchase_order_items;
ALTER TABLE public.purchase_order_items DROP COLUMN IF EXISTS supplier_item_id;
DROP VIEW IF EXISTS public.v_po_entity_unresolved;
DROP TABLE IF EXISTS public.delivery_location_entities;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS entity_code, DROP COLUMN IF EXISTS delivery_outlet_id;
DROP TABLE IF EXISTS public.bom_lines, public.sub_recipes, public.menu_items;
-- price_history is append-only: drop the guard trigger before dropping the table
DROP TRIGGER IF EXISTS price_history_no_truncate ON public.price_history;
DROP TRIGGER IF EXISTS price_history_no_update ON public.price_history;
DROP TABLE IF EXISTS public.price_flag_reviews, public.price_history, public.supplier_items, public.ingredients;
DROP FUNCTION IF EXISTS public._po_line_supplier_item_active(), public._supplier_items_price_log(), public._supplier_items_audit(),
  public._price_history_before_insert(), public._price_history_append_only();
-- WARNING: rolling back 084 DROPS suppliers.status (pending / active / inactive approval state) plus approved_by, approved_at,
-- created_by and delivery_day. After the rollback every supplier looks approved. The values are preserved in a backup table first;
-- re-apply them by hand if you re-run 084.
DO $$
DECLARE n_open int;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'status') THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS public.suppliers_status_backup_084 AS
             SELECT id, status, delivery_day, created_by, approved_by, approved_at, now() AS backed_up_at FROM public.suppliers';
    -- the backup is operator data, not API data: RLS on (no policies) and no grants to anon / authenticated / PUBLIC
    -- (a CTAS table in public is otherwise readable through the Data API under the default grants)
    EXECUTE 'ALTER TABLE public.suppliers_status_backup_084 ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON public.suppliers_status_backup_084 FROM PUBLIC, anon, authenticated';
    EXECUTE 'SELECT count(*) FROM public.suppliers WHERE status IS DISTINCT FROM ''active''' INTO n_open;
    IF n_open > 0 THEN
      RAISE WARNING '084 rollback: % supplier(s) are pending/inactive and will look approved after suppliers.status is dropped; see public.suppliers_status_backup_084', n_open;
    END IF;
  END IF;
END $$;
ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS suppliers_status_check;
ALTER TABLE public.suppliers DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS delivery_day, DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
DROP TABLE IF EXISTS public.business_entities;
DROP TABLE IF EXISTS public.procurement_tags;
