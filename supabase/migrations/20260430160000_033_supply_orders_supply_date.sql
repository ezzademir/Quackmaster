/*
  # supply_orders.supply_date — user-selected supply date (immutable)

  dispatch_date continues to record actual hub dispatch (updated when status → dispatched).
*/

ALTER TABLE public.supply_orders
  ADD COLUMN IF NOT EXISTS supply_date date;

UPDATE public.supply_orders
SET supply_date = dispatch_date::date
WHERE supply_date IS NULL AND dispatch_date IS NOT NULL;

UPDATE public.supply_orders
SET supply_date = (created_at AT TIME ZONE 'UTC')::date
WHERE supply_date IS NULL;

ALTER TABLE public.supply_orders
  ALTER COLUMN supply_date SET DEFAULT CURRENT_DATE;

ALTER TABLE public.supply_orders
  ALTER COLUMN supply_date SET NOT NULL;
