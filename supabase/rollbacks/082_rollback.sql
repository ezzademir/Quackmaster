-- Rollback 082 (costing schema). Run 083_rollback first. Drops costing data (seeded or entered).
DROP VIEW IF EXISTS public.v_price_flags_open, public.v_ingredient_usage, public.v_spend_by_supplier_ingredient,
  public.v_cost_drift, public.v_dish_cogs, public.v_recipe_cost;
DROP TRIGGER IF EXISTS po_line_supplier_item_active ON public.purchase_order_items;
ALTER TABLE public.purchase_order_items DROP COLUMN IF EXISTS supplier_item_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS entity_code;
DROP TABLE IF EXISTS public.bom_lines, public.sub_recipes, public.menu_items;
-- price_history is append-only: drop the guard trigger before dropping the table
DROP TRIGGER IF EXISTS price_history_no_truncate ON public.price_history;
DROP TRIGGER IF EXISTS price_history_no_update ON public.price_history;
DROP TABLE IF EXISTS public.price_flag_reviews, public.price_history, public.supplier_items, public.ingredients;
DROP FUNCTION IF EXISTS public._po_line_supplier_item_active(), public._supplier_items_price_log(), public._supplier_items_audit(),
  public._price_history_before_insert(), public._price_history_append_only();
ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS suppliers_status_check;
ALTER TABLE public.suppliers DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS delivery_day, DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
DROP TABLE IF EXISTS public.business_entities;
