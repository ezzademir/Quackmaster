-- Rollback for 078 (schema). Roll back 080 and 079 FIRST (supabase/rollbacks/079_rollback.sql),
-- otherwise the 079 functions will fail on the missing columns.
-- WARNING: drops the batch columns and any values written into them since 078/079 went live.
DROP INDEX IF EXISTS public.idx_supply_order_lines_lot_id;
DROP INDEX IF EXISTS public.idx_waste_lines_lot_id;
DROP INDEX IF EXISTS public.idx_outlet_stock_take_lines_lot_id;
ALTER TABLE public.supply_order_lines DROP COLUMN IF EXISTS expired_at_dispatch, DROP COLUMN IF EXISTS lot_id;
ALTER TABLE public.waste_lines DROP COLUMN IF EXISTS lot_id, DROP COLUMN IF EXISTS outlet_inventory_id;
ALTER TABLE public.outlet_stock_take_lines DROP COLUMN IF EXISTS lot_id;
-- Restore the pre-078 business-date defaults.
ALTER TABLE public.supply_orders ALTER COLUMN supply_date SET DEFAULT CURRENT_DATE;
ALTER TABLE public.outlet_stock_take_sessions ALTER COLUMN count_date SET DEFAULT CURRENT_DATE;
DROP INDEX IF EXISTS public.uq_outlet_stock_take_sessions_one_open;
ALTER TABLE public.outlet_stock_take_sessions DROP CONSTRAINT IF EXISTS outlet_stock_take_sessions_status_check;
ALTER TABLE public.outlet_stock_take_sessions DROP COLUMN IF EXISTS opened_by, DROP COLUMN IF EXISTS opened_at, DROP COLUMN IF EXISTS status;
ALTER TABLE public.sales_journal_lines DROP COLUMN IF EXISTS expired_at_sale;
DROP TABLE IF EXISTS public.outlet_stock_take_open_balances;
ALTER TABLE public.outlet_stock_take_lines DROP COLUMN IF EXISTS qty_moved_during_count, DROP COLUMN IF EXISTS system_qoh_at_open;
