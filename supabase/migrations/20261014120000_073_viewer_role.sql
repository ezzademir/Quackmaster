-- [HOLD] Read-only `viewer` role for live checks (POS compare only). NOT APPLIED — pending Clive/Ezzad review.
-- viewer: reads storehub_store_map / storehub_product_map (recipes already readable by all signed-in users);
-- the Edge function sync_storehub_sales lets viewer run status/catalog/report only (sync stays admin).
-- viewer is NOT admin and NOT staff: is_profiles_admin() and is_authenticated_active_staff() stay false for it,
-- so every admin/staff write policy and RPC continues to reject it.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'staff'::text, 'pending'::text, 'supervisor'::text, 'viewer'::text]));

CREATE OR REPLACE FUNCTION public.is_profiles_viewer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active AND lower(trim(p.role)) = 'viewer'
  );
$function$;

REVOKE ALL ON FUNCTION public.is_profiles_viewer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_profiles_viewer() TO authenticated;

DROP POLICY IF EXISTS "Viewers read storehub_store_map" ON public.storehub_store_map;
CREATE POLICY "Viewers read storehub_store_map" ON public.storehub_store_map
  FOR SELECT TO authenticated USING (public.is_profiles_viewer());

DROP POLICY IF EXISTS "Viewers read storehub_product_map" ON public.storehub_product_map;
CREATE POLICY "Viewers read storehub_product_map" ON public.storehub_product_map
  FOR SELECT TO authenticated USING (public.is_profiles_viewer());

-- Let admins assign the role from Users (same body as live, role list + message extended).
CREATE OR REPLACE FUNCTION public.admin_set_profile_role_and_outlet(p_target_user_id uuid, p_role text, p_assigned_outlet_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_norm text := lower(trim(p_role));
  v_current text;
  v_admin_count integer;
  v_updated integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated', 'message', 'You must be signed in');
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only admins can change roles');
  END IF;
  IF p_target_user_id = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target', 'message', 'You cannot change your own role this way');
  END IF;
  IF v_norm NOT IN ('admin', 'staff', 'supervisor', 'viewer') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_role', 'message', 'Role must be admin, staff, supervisor, or viewer');
  END IF;
  IF v_norm = 'supervisor' AND p_assigned_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required', 'message', 'Supervisors require an assigned outlet');
  END IF;
  SET LOCAL row_security = off;
  SELECT role INTO v_current FROM public.profiles WHERE id = p_target_user_id;
  IF v_current IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found', 'message', 'User profile not found');
  END IF;
  IF lower(trim(v_current)) = 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_state', 'message', 'Approve pending users before assigning supervisor/admin');
  END IF;
  IF lower(trim(v_current)) = 'admin' AND v_norm <> 'admin' THEN
    SELECT COUNT(*)::integer INTO v_admin_count FROM public.profiles WHERE role = 'admin';
    IF v_admin_count <= 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'last_admin', 'message', 'Cannot remove the last administrator');
    END IF;
  END IF;
  UPDATE public.profiles
  SET role = v_norm,
      assigned_outlet_id = CASE WHEN v_norm = 'supervisor' THEN p_assigned_outlet_id ELSE NULL END,
      updated_at = now()
  WHERE id = p_target_user_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'update_failed', 'message', 'Could not update profile');
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'role', v_norm,
    'assigned_outlet_id', CASE WHEN v_norm = 'supervisor' THEN p_assigned_outlet_id ELSE NULL END
  );
END;
$function$;
