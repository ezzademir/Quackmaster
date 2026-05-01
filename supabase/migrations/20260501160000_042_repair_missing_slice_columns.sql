/*
  Idempotent repair if Table Editor / introspection shows missing columns from migrations 038–040:
  raw_materials.weighted_avg_unit_cost, purchase_order_items.quantity_ordered_base,
  hub_inventory.lot_id, production_runs.planned_batch_id (and outlet_inventory.lot_id).

  Ensures referenced tables exist before FK columns. Safe to re-run.
*/

CREATE TABLE IF NOT EXISTS public.inventory_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_batch_label text NOT NULL,
  expiry_date date,
  manufactured_at timestamptz,
  parent_lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL,
  purchase_order_item_id uuid REFERENCES public.purchase_order_items(id) ON DELETE SET NULL,
  production_run_id uuid REFERENCES public.production_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.production_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  daily_capacity_units numeric(14, 4) NOT NULL CHECK (daily_capacity_units > 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.planned_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  resource_id uuid REFERENCES public.production_resources(id) ON DELETE SET NULL,
  planned_start timestamptz NOT NULL,
  planned_quantity numeric(14, 4) NOT NULL CHECK (planned_quantity > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'released', 'cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.raw_materials
  ADD COLUMN IF NOT EXISTS weighted_avg_unit_cost numeric(14, 4) NOT NULL DEFAULT 0;

UPDATE public.raw_materials
SET weighted_avg_unit_cost = COALESCE(cost_price, 0)
WHERE weighted_avg_unit_cost = 0 AND cost_price IS NOT NULL;

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS quantity_ordered_base numeric(14, 4);

UPDATE public.purchase_order_items
SET quantity_ordered_base = COALESCE(quantity_ordered, 0)
WHERE quantity_ordered_base IS NULL;

ALTER TABLE public.purchase_order_items
  ALTER COLUMN quantity_ordered_base SET NOT NULL;

ALTER TABLE public.hub_inventory
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL;

ALTER TABLE public.outlet_inventory
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL;

ALTER TABLE public.production_runs
  ADD COLUMN IF NOT EXISTS planned_batch_id uuid REFERENCES public.planned_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hub_inventory_lot ON public.hub_inventory(lot_id);
CREATE INDEX IF NOT EXISTS idx_outlet_inventory_lot ON public.outlet_inventory(lot_id);
CREATE INDEX IF NOT EXISTS idx_production_runs_planned ON public.production_runs(planned_batch_id);
