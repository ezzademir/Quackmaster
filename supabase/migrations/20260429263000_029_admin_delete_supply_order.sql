/*
  # Admin delete supply order

  supply_orders has no client DELETE policy after migration 006. Admins may remove
  pending supply orders (releases hub reservations per supply_order_lines) or
  purge cancelled rows. Dispatched/received orders cannot be deleted from here.
*/

CREATE OR REPLACE FUNCTION public.admin_delete_supply_order(p_supply_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  st text;
  rec RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT status INTO st FROM public.supply_orders WHERE id = p_supply_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supply order not found';
  END IF;

  IF st IN ('dispatched', 'received') THEN
    RAISE EXCEPTION 'Cannot delete dispatched or received supply orders';
  END IF;

  IF st = 'pending' THEN
    FOR rec IN
      SELECT hub_inventory_id, quantity
      FROM public.supply_order_lines
      WHERE supply_order_id = p_supply_order_id
    LOOP
      PERFORM public.release_inventory_reservation(rec.hub_inventory_id, rec.quantity, p_supply_order_id);
    END LOOP;
  END IF;

  DELETE FROM public.supply_orders WHERE id = p_supply_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_supply_order(uuid) TO authenticated;
