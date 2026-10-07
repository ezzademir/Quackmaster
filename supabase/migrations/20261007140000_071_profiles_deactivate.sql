-- [HOLD] Users: deactivate / reactivate (keeps history). NOT APPLIED — pending Clive/Ezzad review.
-- Deactivation = soft: profile row, ledger, journals etc. stay intact (names still resolve).
-- Login is blocked by the admin_set_user_active Edge Function (auth ban + session revoke via
-- admin_apply_user_active below). In the database an inactive profile has no access: every
-- helper (is_profiles_admin, is_authenticated_active_staff, ...) and every inline RLS policy that
-- looks up the caller's profile (`p.id = auth.uid()`) additionally requires p.is_active.

-- 1. Columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Privileged-column guard: is_active / deactivated_* are admin/service only.
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
    -- System / signup inserts (no end-user JWT): force pending + active
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

    -- Non-admin self-insert cannot mint privileged rows
    NEW.role := 'pending';
    NEW.assigned_outlet_id := NULL;
    NEW.password_reset_required := false;
    NEW.is_active := true;
    NEW.deactivated_at := NULL;
    NEW.deactivated_by := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE: non-admins cannot change privileged columns
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

-- 3. Access helpers require an active profile.
CREATE OR REPLACE FUNCTION public.is_profiles_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ok boolean;
BEGIN
  SET LOCAL row_security = off;
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active
  )
  INTO ok;
  RETURN COALESCE(ok, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_authenticated_active_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin', 'staff')
      AND p.is_active
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_supervisor_for_outlet(p_outlet_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_outlet_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND lower(trim(p.role::text)) = 'supervisor'
      AND p.assigned_outlet_id IS NOT NULL
      AND p.assigned_outlet_id = p_outlet_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.profile_can_post_outlet_stock_take(p_outlet_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_outlet_id IS NULL THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_active
        AND lower(trim(p.role::text)) IN ('admin', 'staff')
    ) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_active
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND p.assigned_outlet_id = p_outlet_id
    ) THEN true
    ELSE false
  END;
$function$;

-- 4. Inline RLS policies that look up the caller's profile as `p` also require p.is_active.
DO $pol$
DECLARE
  r record;
  v_q text;
  v_w text;
  v_n int := 0;
  k_from constant text := '(p.id = auth.uid())';
  k_to constant text := '((p.id = auth.uid()) AND p.is_active)';
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (strpos(coalesce(qual, ''), k_from) > 0 OR strpos(coalesce(with_check, ''), k_from) > 0)
  LOOP
    v_q := CASE WHEN r.qual IS NOT NULL AND strpos(r.qual, 'p.is_active') = 0 THEN replace(r.qual, k_from, k_to) END;
    v_w := CASE WHEN r.with_check IS NOT NULL AND strpos(r.with_check, 'p.is_active') = 0 THEN replace(r.with_check, k_from, k_to) END;
    IF v_q IS NOT NULL AND v_q <> r.qual THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', r.policyname, r.schemaname, r.tablename, v_q);
      v_n := v_n + 1;
    END IF;
    IF v_w IS NOT NULL AND v_w <> r.with_check THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', r.policyname, r.schemaname, r.tablename, v_w);
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'profiles_deactivate: % policy clauses now require p.is_active', v_n;
END
$pol$;

-- 5. Users admin data: expose is_active / deactivated_at; admin check requires active.
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.get_users_management_data()'::regprocedure);
  v_new text;
  k1 constant text := '''password_reset_required'', s.password_reset_required,';
  k2 constant text := 'p.password_reset_required,';
  k3 constant text := 'WHERE id = auth.uid() AND role = ''admin''';
BEGIN
  IF strpos(v_def, 'is_active') > 0 THEN
    RETURN; -- already applied
  END IF;
  IF (length(v_def) - length(replace(v_def, k1, ''))) / length(k1) <> 1
     OR (length(v_def) - length(replace(v_def, k2, ''))) / length(k2) <> 1
     OR (length(v_def) - length(replace(v_def, k3, ''))) / length(k3) <> 1 THEN
    RAISE EXCEPTION 'profiles_deactivate: get_users_management_data body drifted; refusing to patch';
  END IF;
  v_new := replace(v_def, k1, k1 || ' ''is_active'', s.is_active, ''deactivated_at'', s.deactivated_at,');
  v_new := replace(v_new, k2, k2 || ' p.is_active, p.deactivated_at,');
  v_new := replace(v_new, k3, k3 || ' AND is_active');
  EXECUTE v_new;
END
$mig$;

-- 6. Service-role-only RPC used by the admin_set_user_active Edge Function.
CREATE OR REPLACE FUNCTION public.admin_apply_user_active(
  p_actor uuid,
  p_target uuid,
  p_active boolean,
  p_reason text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_other_admins int;
  v_email text := '';
  v_sessions int := 0;
BEGIN
  IF p_actor IS NULL OR p_target IS NULL OR p_active IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_input', 'message', 'actor, target and active are required');
  END IF;

  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  IF NOT FOUND OR v_actor.role <> 'admin' OR NOT v_actor.is_active THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only active admins can change account status');
  END IF;

  IF p_actor = p_target THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target', 'message', 'You cannot deactivate or reactivate yourself');
  END IF;

  SELECT * INTO v_target FROM public.profiles WHERE id = p_target FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found', 'message', 'User profile not found');
  END IF;

  IF v_target.is_active = p_active THEN
    RETURN jsonb_build_object('success', true, 'unchanged', true, 'is_active', p_active);
  END IF;

  IF NOT p_active AND v_target.role = 'admin' THEN
    SELECT count(*)::int INTO v_other_admins
    FROM public.profiles
    WHERE role = 'admin' AND is_active AND id <> p_target;
    IF v_other_admins < 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'last_admin', 'message', 'Cannot deactivate the last active administrator');
    END IF;
  END IF;

  PERFORM set_config('quackmaster.bypass_profile_privilege_guard', 'on', true);

  UPDATE public.profiles
  SET
    is_active = p_active,
    deactivated_at = CASE WHEN p_active THEN NULL ELSE now() END,
    deactivated_by = CASE WHEN p_active THEN NULL ELSE p_actor END,
    updated_at = now()
  WHERE id = p_target;

  PERFORM set_config('quackmaster.bypass_profile_privilege_guard', 'off', true);

  IF NOT p_active THEN
    DELETE FROM auth.sessions WHERE user_id = p_target;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;
    DELETE FROM auth.refresh_tokens WHERE user_id = p_target::text;
  END IF;

  SELECT COALESCE(u.email::text, '') INTO v_email FROM auth.users u WHERE u.id = p_actor;

  INSERT INTO public.data_ledger (
    user_id, user_email, action, entity_type, entity_id, module, operation,
    reference_id, before_data, after_data, metadata
  ) VALUES (
    p_actor, COALESCE(v_email, ''),
    CASE WHEN p_active THEN 'reactivated' ELSE 'deactivated' END,
    'profile', p_target::text, 'users', 'update', NULL,
    jsonb_build_object('is_active', v_target.is_active, 'deactivated_at', v_target.deactivated_at),
    jsonb_build_object('is_active', p_active),
    jsonb_build_object('reason', p_reason, 'sessions_revoked', v_sessions, 'source', 'admin_set_user_active')
  );

  RETURN jsonb_build_object('success', true, 'is_active', p_active, 'sessions_revoked', v_sessions);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_apply_user_active(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_apply_user_active(uuid, uuid, boolean, text) TO service_role;
