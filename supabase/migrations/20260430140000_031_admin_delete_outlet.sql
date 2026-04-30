/*
  # Admin-only delete for outlets

  Outlets use ON DELETE RESTRICT from supply_orders; this RPC fails with a clear message
  when orders still reference the outlet. SECURITY DEFINER bypasses RLS so only profile
  admins can remove outlets consistently.
*/

CREATE OR REPLACE FUNCTION public.admin_delete_outlet(p_outlet_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.outlets WHERE id = p_outlet_id) THEN
    RAISE EXCEPTION 'Outlet not found';
  END IF;

  IF EXISTS (SELECT 1 FROM public.supply_orders WHERE outlet_id = p_outlet_id) THEN
    RAISE EXCEPTION 'Cannot delete outlet while supply orders reference it. Delete those orders (admin) or cancel them first.';
  END IF;

  DELETE FROM public.outlets WHERE id = p_outlet_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_outlet(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_outlet(uuid) TO authenticated;
