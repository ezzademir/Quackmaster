/*
  # Users module: RPC for admin user listing

  Loads approved (non-pending) profiles with email from pending_registrations when present,
  plus pending registration rows. Uses SECURITY DEFINER and row_security off inside the body
  so listing does not depend on stacking multiple client RLS evaluations.

  Client: supabase.rpc('get_users_management_data')
*/

CREATE OR REPLACE FUNCTION public.get_users_management_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  is_admin boolean;
  approved jsonb;
  pending jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ) INTO is_admin;

  IF NOT COALESCE(is_admin, false) THEN
    RETURN jsonb_build_object(
      'error', 'forbidden',
      'message', 'Only admins can load user management data'
    );
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'full_name', p.full_name,
        'role', p.role,
        'last_login', p.last_login,
        'password_reset_required', p.password_reset_required,
        'created_at', p.created_at,
        'email', COALESCE(pr.email, '')
      )
      ORDER BY p.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO approved
  FROM public.profiles p
  LEFT JOIN public.pending_registrations pr
    ON pr.user_id = p.id AND pr.status = 'approved'
  WHERE p.role <> 'pending';

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.user_id,
        'email', pr.email,
        'full_name', pr.full_name,
        'status', pr.status,
        'requested_at', pr.requested_at,
        'created_at', pr.created_at
      )
      ORDER BY pr.requested_at DESC
    ),
    '[]'::jsonb
  )
  INTO pending
  FROM public.pending_registrations pr
  WHERE pr.status = 'pending';

  RETURN jsonb_build_object(
    'approved', approved,
    'pending', pending
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_users_management_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_users_management_data() TO authenticated;
