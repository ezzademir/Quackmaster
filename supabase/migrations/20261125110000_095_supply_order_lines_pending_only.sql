-- 095: supply order lines can be inserted or deleted only while the order is pending.
--
-- Dispatch deducts hub stock, then receive_supply_order credits the outlet for whatever
-- supply_order_lines exist at receive time. 065 let any active admin or staff insert and
-- delete those lines with no status check. After dispatch and before receive, that user
-- can delete the shipped lines (hub stock is already gone, the outlet is credited nothing)
-- or insert an extra line (the outlet is credited and the hub is not deducted again).
--
-- Dispatch itself rewrites finished-goods lines while the header is still pending, and it
-- is SECURITY DEFINER, so it bypasses this policy. Creating an order still inserts lines
-- on a pending header.

CREATE OR REPLACE FUNCTION public.supply_order_is_pending(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.supply_orders so
    WHERE so.id = p_order_id
      AND lower(trim(both from COALESCE(so.status, ''))) = 'pending'
  );
$$;

REVOKE ALL ON FUNCTION public.supply_order_is_pending(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_order_is_pending(uuid) TO authenticated;

DROP POLICY IF EXISTS "Staff can insert supply order lines" ON public.supply_order_lines;
CREATE POLICY "Staff can insert supply order lines"
  ON public.supply_order_lines FOR INSERT TO authenticated
  WITH CHECK (
    public.is_authenticated_active_staff()
    AND public.supply_order_is_pending(supply_order_id)
  );

DROP POLICY IF EXISTS "Staff can delete supply order lines" ON public.supply_order_lines;
CREATE POLICY "Staff can delete supply order lines"
  ON public.supply_order_lines FOR DELETE TO authenticated
  USING (
    public.is_authenticated_active_staff()
    AND public.supply_order_is_pending(supply_order_id)
  );
