-- Rollback 093. Run as one batch: psql -1 -v ON_ERROR_STOP=1 -f <this file>.
-- Drops the receipt-month lookup. Open counts keep working as full-sheet counts.

DROP FUNCTION IF EXISTS public.begin_outlet_stock_take(uuid, date, text, text);
DROP FUNCTION IF EXISTS public.set_outlet_stock_take_receipt_month(uuid, text);
DROP FUNCTION IF EXISTS public.list_outlet_inventory_received_in_month(uuid, text);
DROP FUNCTION IF EXISTS public._outlet_inventory_received_in_month(uuid, text);

ALTER TABLE public.outlet_stock_take_sessions
  DROP CONSTRAINT IF EXISTS outlet_stock_take_sessions_receipt_month_check;
ALTER TABLE public.outlet_stock_take_sessions
  DROP COLUMN IF EXISTS receipt_month;
