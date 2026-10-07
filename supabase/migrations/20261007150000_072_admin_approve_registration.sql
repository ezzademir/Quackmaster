-- [HOLD] Users: atomic approve. NOT APPLIED — pending Clive/Ezzad review.
-- Root cause (Apr 2026: abc123randomstuff@gmail.com, din@mano.com approved but role stayed 'pending'):
-- Users.tsx approves with two separate client writes:
--   1) profiles.update({role:'staff'}).eq('id', user)   2) pending_registrations.update({status:'approved'})
-- PostgREST returns NO error when RLS filters the UPDATE to 0 rows. At the time the admin UPDATE
-- policy on profiles was missing/broken (fixed by 016/018), so step 1 silently changed nothing,
-- step 2 succeeded, and the UI reported success. The code still only checks `error`, never the
-- row count, and the two writes are not atomic — any future RLS/guard regression repeats it.
-- Fix: one SECURITY DEFINER RPC that does both writes in a single transaction with row-count checks.

CREATE OR REPLACE FUNCTION public.admin_approve_registration(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_reg public.pending_registrations%ROWTYPE;
  v_role text;
  v_n int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated', 'message', 'You must be signed in');
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only admins can approve users');
  END IF;
  IF p_user_id IS NULL OR p_user_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target', 'message', 'Invalid user');
  END IF;

  SET LOCAL row_security = off;

  SELECT * INTO v_reg FROM public.pending_registrations WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'registration_not_found', 'message', 'No registration for this user');
  END IF;
  IF v_reg.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'status', v_reg.status,
      'message', format('Registration is %s, not pending', v_reg.status));
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found', 'message', 'User profile not found');
  END IF;
  IF lower(trim(v_role)) <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_profile_state', 'role', v_role,
      'message', format('Profile role is %s, not pending', v_role));
  END IF;

  UPDATE public.profiles SET role = 'staff', updated_at = now() WHERE id = p_user_id AND role = v_role;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'approve_profile_update_failed' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.pending_registrations
  SET status = 'approved', reviewed_by = v_uid, reviewed_at = now(), updated_at = now()
  WHERE id = v_reg.id AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'approve_registration_update_failed' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public._append_data_ledger(
    'approved', 'pending_registration', p_user_id::text, 'users', 'update', p_user_id::text,
    jsonb_build_object('status', 'pending', 'role', v_role),
    jsonb_build_object('status', 'approved', 'role', 'staff'),
    NULL, jsonb_build_object('source', 'admin_approve_registration')
  );

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id, 'role', 'staff', 'status', 'approved');
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_approve_registration(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_registration(uuid) TO authenticated;
