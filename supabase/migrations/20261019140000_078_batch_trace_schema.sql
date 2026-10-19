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
--   sales_journal_lines.expired_at_sale     true when the batch sold was past expiry on the business date
--   outlet_stock_take_sessions.status       NULL (legacy, posted) | 'open' | 'posted' | 'cancelled'
--   outlet_stock_take_sessions.opened_at / opened_by   blind count started (080)
--   one open count per outlet (partial unique index)
--
-- Column DEFAULTs (metadata only; no rows rewritten): supply_orders.supply_date and
-- outlet_stock_take_sessions.count_date default to today in MYT instead of CURRENT_DATE (UTC),
-- which gave yesterday's date for inserts made 00:00-08:00 MYT.
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

-- Business-date defaults: today in Malaysia time (DB timezone is UTC).
ALTER TABLE public.supply_orders
  ALTER COLUMN supply_date SET DEFAULT (timezone('Asia/Kuala_Lumpur', now()))::date;
ALTER TABLE public.outlet_stock_take_sessions
  ALTER COLUMN count_date SET DEFAULT (timezone('Asia/Kuala_Lumpur', now()))::date;

-- Sales: batch past expiry on the business date (flag only; sale is never blocked). Written by 079.
ALTER TABLE public.sales_journal_lines
  ADD COLUMN IF NOT EXISTS expired_at_sale boolean;
COMMENT ON COLUMN public.sales_journal_lines.expired_at_sale IS
  'TRUE when the batch sold had expiry_date < business date. Warning only; the sale is never blocked (079).';

-- Blind stock take sessions (080). Existing rows keep status NULL = legacy posted session.
ALTER TABLE public.outlet_stock_take_sessions
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS opened_by uuid;
DO $c$ BEGIN
  ALTER TABLE public.outlet_stock_take_sessions
    ADD CONSTRAINT outlet_stock_take_sessions_status_check CHECK (status IS NULL OR status IN ('open', 'posted', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_outlet_stock_take_sessions_one_open
  ON public.outlet_stock_take_sessions (outlet_id) WHERE status = 'open';
COMMENT ON COLUMN public.outlet_stock_take_sessions.status IS
  'NULL = legacy posted session; open = blind count in progress (system qty hidden from non-admins); posted; cancelled.';
