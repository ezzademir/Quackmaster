/*
  RBAC / ops alignment: authenticated users can create/update supply_orders (staff distribution flows).
*/

DROP POLICY IF EXISTS "Admins can create supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Admins can update supply_orders" ON public.supply_orders;

CREATE POLICY "Authenticated users can create supply_orders"
  ON public.supply_orders FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update supply_orders"
  ON public.supply_orders FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);
