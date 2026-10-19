-- [HOLD] Batch traceability: SCHEMA ONLY (19 Oct 2026). NOT APPLIED — pending Clive/Ezzad review.
-- Separable from 079 (function changes). Every column is NULLABLE and additive, so the
-- current app and current RPCs keep working unchanged if only this file is applied.
-- 079 depends on this file (it writes these columns), so apply 078 before 079.
--
--   supply_order_lines.lot_id               actual batch shipped (set by dispatch_supply_order)
--   supply_order_lines.expired_at_dispatch  true when that batch was past expiry (MYT) at dispatch
--   waste_lines.outlet_inventory_id         outlet batch row the waste came off
--   waste_lines.lot_id                      batch wasted (hub or outlet)
--   outlet_stock_take_lines.lot_id          batch counted (snapshot of outlet_inventory.lot_id)
--
-- Existing rows are left NULL (no backfill here; a backfill is a separate data-change clearance).

ALTER TABLE public.supply_order_lines
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expired_at_dispatch boolean;

ALTER TABLE public.waste_lines
  ADD COLUMN IF NOT EXISTS outlet_inventory_id uuid REFERENCES public.outlet_inventory(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL;

ALTER TABLE public.outlet_stock_take_lines
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_supply_order_lines_lot_id ON public.supply_order_lines (lot_id);
CREATE INDEX IF NOT EXISTS idx_waste_lines_lot_id ON public.waste_lines (lot_id);
CREATE INDEX IF NOT EXISTS idx_outlet_stock_take_lines_lot_id ON public.outlet_stock_take_lines (lot_id);

COMMENT ON COLUMN public.supply_order_lines.lot_id IS
  'Batch actually shipped. Written by dispatch_supply_order (079). NULL on lines dispatched before 079 or still pending.';
COMMENT ON COLUMN public.supply_order_lines.expired_at_dispatch IS
  'TRUE when the shipped batch expiry_date < Malaysia date at dispatch. Warning only; dispatch is never blocked.';
COMMENT ON COLUMN public.waste_lines.lot_id IS 'Batch wasted. Written by post_waste_event (079).';
COMMENT ON COLUMN public.waste_lines.outlet_inventory_id IS 'Outlet batch row wasted. Written by post_waste_event (079).';
COMMENT ON COLUMN public.outlet_stock_take_lines.lot_id IS 'Batch counted. Written by post_outlet_stock_take (079).';
