-- Rollback 088 (stock entity tags). Drops the tag columns and the hub movement ledger created by 088
-- (tags written to inventory_lots / outlet_stock_movements since 088 are lost). Old rows are untouched.
DROP VIEW IF EXISTS public.v_stock_movements, public.v_hub_stock_by_entity;
DROP TRIGGER IF EXISTS outlet_movement_entity_guard ON public.outlet_stock_movements;
DROP TRIGGER IF EXISTS inventory_lot_entity_guard ON public.inventory_lots;
DROP TRIGGER IF EXISTS po_cancel_stock_entity ON public.purchase_orders;
DROP TRIGGER IF EXISTS po_item_stock_entity ON public.purchase_order_items;
DROP TRIGGER IF EXISTS trg_hub_inventory_movement ON public.hub_inventory;
DROP FUNCTION IF EXISTS public._outlet_movement_entity_guard(), public._inventory_lot_entity_guard(),
  public._po_cancel_stock_entity(), public._po_item_stock_entity(), public._hub_inventory_movement(),
  public._resolve_stock_entity(uuid, uuid), public.set_stock_entity(text), public.set_stock_tag_enforcement(text, boolean),
  public._stock_tag_enforced(text);
DROP TABLE IF EXISTS public.hub_stock_movements, public.stock_tag_enforcement;
DROP INDEX IF EXISTS public.idx_inventory_lots_entity, public.idx_osm_entity;
ALTER TABLE public.inventory_lots DROP COLUMN IF EXISTS entity_code;
ALTER TABLE public.outlet_stock_movements DROP COLUMN IF EXISTS entity_code;
