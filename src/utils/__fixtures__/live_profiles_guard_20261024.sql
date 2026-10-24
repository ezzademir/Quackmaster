-- Verbatim pg_get_functiondef from live (Quackmaster fknrfntqycfrkaihwngg), read-only metadata query, 2026-10-24 (MYT, ~12:45).
-- ===== profiles_enforce_privileged_columns
CREATE OR REPLACE FUNCTION public.profiles_enforce_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bypass text;
  jwt_role text;
BEGIN
  bypass := current_setting('quackmaster.bypass_profile_privilege_guard', true);
  IF bypass = 'on' THEN
    RETURN NEW;
  END IF;

  jwt_role := coalesce(
    auth.jwt() ->> 'role',
    current_setting('request.jwt.claim.role', true),
    ''
  );

  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NULL THEN
      NEW.role := 'pending';
      NEW.assigned_outlet_id := NULL;
      NEW.is_active := true;
      NEW.deactivated_at := NULL;
      NEW.deactivated_by := NULL;
      RETURN NEW;
    END IF;

    IF public.is_profiles_admin() THEN
      RETURN NEW;
    END IF;

    NEW.role := 'pending';
    NEW.assigned_outlet_id := NULL;
    NEW.password_reset_required := false;
    NEW.is_active := true;
    NEW.deactivated_at := NULL;
    NEW.deactivated_by := NULL;
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.assigned_outlet_id IS DISTINCT FROM OLD.assigned_outlet_id
     OR NEW.password_reset_required IS DISTINCT FROM OLD.password_reset_required
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
     OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by THEN
    IF public.is_profiles_admin() THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'profiles: cannot change role, assigned_outlet_id, password_reset_required, or active status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

-- ===== admin_set_profile_role_and_outlet
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

  IF v_norm NOT IN ('admin', 'staff', 'supervisor') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_role', 'message', 'Role must be admin, staff, or supervisor');
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
  SET
    role = v_norm,
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

-- ===== get_users_management_data
CREATE OR REPLACE FUNCTION public.get_users_management_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  is_admin boolean;
  approved jsonb;
  pending jsonb;
  approved_regs jsonb;
  rejected_regs jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND is_active
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
        'id', s.id,
        'full_name', s.full_name,
        'role', s.role,
        'assigned_outlet_id', s.assigned_outlet_id,
        'last_login', s.last_login,
        'password_reset_required', s.password_reset_required, 'is_active', s.is_active, 'deactivated_at', s.deactivated_at,
        'created_at', s.created_at,
        'email', s.email_out
      )
      ORDER BY s.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO approved
  FROM (
    SELECT
      p.id,
      p.full_name,
      p.role,
      p.assigned_outlet_id,
      p.last_login,
      p.password_reset_required, p.is_active, p.deactivated_at,
      p.created_at,
      COALESCE(
        NULLIF(trim(COALESCE(au.email::text, '')), ''),
        NULLIF(trim(COALESCE(pr.email, '')), ''),
        ''
      ) AS email_out
    FROM public.profiles p
    LEFT JOIN auth.users au ON au.id = p.id
    LEFT JOIN public.pending_registrations pr
      ON pr.user_id = p.id AND pr.status = 'approved'
    WHERE p.role <> 'pending'
  ) s;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.user_id,
        'registration_id', pr.id,
        'email', pr.email,
        'full_name', pr.full_name,
        'status', pr.status,
        'requested_at', pr.requested_at,
        'created_at', pr.created_at,
        'reviewed_at', pr.reviewed_at,
        'reviewed_by', pr.reviewed_by
      )
      ORDER BY pr.requested_at DESC
    ),
    '[]'::jsonb
  )
  INTO pending
  FROM public.pending_registrations pr
  WHERE pr.status = 'pending';

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.user_id,
        'registration_id', pr.id,
        'email', pr.email,
        'full_name', pr.full_name,
        'status', pr.status,
        'requested_at', pr.requested_at,
        'reviewed_at', pr.reviewed_at,
        'reviewed_by', pr.reviewed_by,
        'created_at', pr.created_at
      )
      ORDER BY pr.reviewed_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO approved_regs
  FROM public.pending_registrations pr
  WHERE pr.status = 'approved';

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.user_id,
        'registration_id', pr.id,
        'email', pr.email,
        'full_name', pr.full_name,
        'status', pr.status,
        'requested_at', pr.requested_at,
        'reviewed_at', pr.reviewed_at,
        'reviewed_by', pr.reviewed_by,
        'rejection_reason', pr.rejection_reason,
        'created_at', pr.created_at
      )
      ORDER BY pr.reviewed_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO rejected_regs
  FROM public.pending_registrations pr
  WHERE pr.status = 'rejected';

  RETURN jsonb_build_object(
    'approved', approved,
    'pending', pending,
    'approved_registrations', approved_regs,
    'rejected_registrations', rejected_regs
  );
END;
$function$;

-- ===== _append_data_ledger
CREATE OR REPLACE FUNCTION public._append_data_ledger(p_action text, p_entity_type text, p_entity_id text, p_module text, p_operation text, p_reference_id text DEFAULT NULL::text, p_before jsonb DEFAULT NULL::jsonb, p_after jsonb DEFAULT NULL::jsonb, p_delta jsonb DEFAULT NULL::jsonb, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := '';
  v_metadata jsonb := p_metadata;
BEGIN
  IF v_uid IS NULL THEN
    v_metadata := COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('actor', 'system');
  ELSE
    BEGIN
      SELECT COALESCE(u.email::text, '')
      INTO v_email
      FROM auth.users u
      WHERE u.id = v_uid;
    EXCEPTION
      WHEN OTHERS THEN
        v_email := '';
    END;
    v_email := COALESCE(v_email, '');
  END IF;

  INSERT INTO public.data_ledger (
    user_id,
    user_email,
    action,
    entity_type,
    entity_id,
    module,
    operation,
    reference_id,
    before_data,
    after_data,
    delta_data,
    metadata
  )
  VALUES (
    v_uid,
    v_email,
    p_action,
    p_entity_type,
    p_entity_id,
    p_module,
    p_operation,
    p_reference_id,
    p_before,
    p_after,
    p_delta,
    v_metadata
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'data_ledger insert failed: %', SQLERRM;
END;
$function$;

-- ===== trigger (pg_get_triggerdef), the ONLY non-internal trigger on public.profiles live
CREATE TRIGGER trg_profiles_enforce_privileged_columns BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION profiles_enforce_privileged_columns();
