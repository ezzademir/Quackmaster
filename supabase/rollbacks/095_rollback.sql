-- Rollback 095. Restores the 065 policies: active admin/staff may insert or delete
-- supply order lines regardless of the order status.
DROP POLICY IF EXISTS "Staff can insert supply order lines" ON public.supply_order_lines;
CREATE POLICY "Staff can insert supply order lines"
  ON public.supply_order_lines FOR INSERT TO authenticated
  WITH CHECK (public.is_authenticated_active_staff());

DROP POLICY IF EXISTS "Staff can delete supply order lines" ON public.supply_order_lines;
CREATE POLICY "Staff can delete supply order lines"
  ON public.supply_order_lines FOR DELETE TO authenticated
  USING (public.is_authenticated_active_staff());

DROP FUNCTION IF EXISTS public.supply_order_is_pending(uuid);
