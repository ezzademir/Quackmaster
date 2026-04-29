/*
  # Admin-only RPC: promote/demote registered users between admin and staff

  Only affects profiles with role 'admin' or 'staff' (not 'pending').
  - Caller must be admin (via is_profiles_admin).
  - Cannot change your own role.
  - Cannot demote the last remaining admin.
*/

CREATE OR REPLACE FUNCTION public.set_registered_user_admin_role(
  p_target_user_id uuid,
  p_make_admin boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  v_role text;
  v_new_role text;
  v_admin_count integer;
  v_updated integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'unauthenticated',
      'message', 'You must be signed in'
    );
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'forbidden',
      'message', 'Only admins can change user roles'
    );
  END IF;

  IF p_target_user_id = auth.uid() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_target',
      'message', 'You cannot change your own role'
    );
  END IF;

  SET LOCAL row_security = off;

  SELECT p.role
  INTO v_role
  FROM public.profiles p
  WHERE p.id = p_target_user_id;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not_found',
      'message', 'User profile not found'
    );
  END IF;

  IF v_role NOT IN ('admin', 'staff') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_state',
      'message', 'Only approved users (staff or admin) can be promoted or demoted'
    );
  END IF;

  v_new_role := CASE WHEN p_make_admin THEN 'admin' ELSE 'staff' END;

  IF v_role = v_new_role THEN
    RETURN jsonb_build_object(
      'success', true,
      'role', v_new_role,
      'message', 'Role unchanged'
    );
  END IF;

  IF v_role = 'admin' AND v_new_role = 'staff' THEN
    SELECT COUNT(*)::integer
    INTO v_admin_count
    FROM public.profiles
    WHERE role = 'admin';

    IF v_admin_count <= 1 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'last_admin',
        'message', 'Cannot remove the last administrator'
      );
    END IF;
  END IF;

  UPDATE public.profiles
  SET role = v_new_role
  WHERE id = p_target_user_id
    AND role IN ('admin', 'staff');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'update_failed',
      'message', 'Could not update role'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'role', v_new_role
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_registered_user_admin_role(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_registered_user_admin_role(uuid, boolean) TO authenticated;
