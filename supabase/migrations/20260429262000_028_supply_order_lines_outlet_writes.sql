/*
  # Supply order lines + outlet inventory writes

  Persist hub batch lines per supply order so dispatch can fulfill reservations and
  receipt can credit outlet_inventory. Restores INSERT/UPDATE on outlet_inventory
  for authenticated users (006 had removed write policies).
*/

CREATE TABLE IF NOT EXISTS public.supply_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_order_id uuid NOT NULL REFERENCES public.supply_orders(id) ON DELETE CASCADE,
  hub_inventory_id uuid NOT NULL REFERENCES public.hub_inventory(id) ON DELETE RESTRICT,
  product_batch text NOT NULL,
  quantity numeric(10, 2) NOT NULL CHECK (quantity > 0),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supply_order_lines_order_id ON public.supply_order_lines(supply_order_id);

ALTER TABLE public.supply_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view supply order lines"
  ON public.supply_order_lines FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert supply order lines"
  ON public.supply_order_lines FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete supply order lines"
  ON public.supply_order_lines FOR DELETE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert outlet inventory"
  ON public.outlet_inventory FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update outlet inventory"
  ON public.outlet_inventory FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
