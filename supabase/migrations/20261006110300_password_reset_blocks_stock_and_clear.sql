/*
  Forced password reset was a client-only gate.

  1. clear_own_password_reset_required() cleared the flag for any signed-in user,
     so the reset screen could be skipped without auth.updateUser({ password }).
  2. Stock RPCs and direct hub/outlet inventory writes never read the flag, so a
     user (or anyone with their password) could keep mutating stock while the
     app shell showed "New password required".

  Snapshot GoTrue's encrypted_password when the flag flips on. Clearing the flag
  requires that hash to have changed. Active staff/admin/supervisor helpers and
  hub/outlet inventory triggers refuse work while the flag is set.
*/

CREATE TABLE IF NOT EXISTS public.profile_password_reset_guards (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  verifier text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profile_password_reset_guards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.profile_password_reset_guards FROM PUBLIC;
REVOKE ALL ON TABLE public.profile_password_reset_guards FROM anon, authenticated;

-- Fail the migration if this role cannot read GoTrue password hashes. The
-- snapshot and clear functions run as the same owner.
DO $probe$
BEGIN
  PERFORM u.encrypted_password FROM auth.users u LIMIT 1;
END;
$probe$;

COMMENT ON TABLE public.profile_password_reset_guards IS
  'GoTrue encrypted_password captured when password_reset_required flips on. Not readable by clients.';

CREATE OR REPLACE FUNCTION public._sync_password_reset_guard(
  p_user_id uuid,
  p_was_required boolean,
  p_now_required boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  IF COALESCE(p_now_required, false) AND NOT COALESCE(p_was_required, false) THEN
    INSERT INTO public.profile_password_reset_guards (user_id, verifier, updated_at)
    SELECT p_user_id, u.encrypted_password, now()
    FROM auth.users u
    WHERE u.id = p_user_id
    ON CONFLICT (user_id) DO UPDATE
      SET verifier = EXCLUDED.verifier,
          updated_at = now();
  ELSIF NOT COALESCE(p_now_required, false) AND COALESCE(p_was_required, false) THEN
    DELETE FROM public.profile_password_reset_guards WHERE user_id = p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._sync_password_reset_guard(uuid, boolean, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.profiles_enforce_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bypass text;
  jwt_role text;
  v_was_required boolean;
BEGIN
  v_was_required := CASE
    WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.password_reset_required, false)
    ELSE false
  END;

  bypass := current_setting('quackmaster.bypass_profile_privilege_guard', true);
  IF bypass = 'on' THEN
    PERFORM public._sync_password_reset_guard(
      NEW.id, v_was_required, COALESCE(NEW.password_reset_required, false)
    );
    RETURN NEW;
  END IF;

  jwt_role := coalesce(
    auth.jwt() ->> 'role',
    current_setting('request.jwt.claim.role', true),
    ''
  );

  IF jwt_role = 'service_role' THEN
    PERFORM public._sync_password_reset_guard(
      NEW.id, v_was_required, COALESCE(NEW.password_reset_required, false)
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NULL THEN
      NEW.role := 'pending';
      NEW.assigned_outlet_id := NULL;
      PERFORM public._sync_password_reset_guard(
        NEW.id, false, COALESCE(NEW.password_reset_required, false)
      );
      RETURN NEW;
    END IF;

    IF public.is_profiles_admin() THEN
      PERFORM public._sync_password_reset_guard(
        NEW.id, false, COALESCE(NEW.password_reset_required, false)
      );
      RETURN NEW;
    END IF;

    NEW.role := 'pending';
    NEW.assigned_outlet_id := NULL;
    NEW.password_reset_required := false;
    PERFORM public._sync_password_reset_guard(NEW.id, false, false);
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.assigned_outlet_id IS DISTINCT FROM OLD.assigned_outlet_id
     OR NEW.password_reset_required IS DISTINCT FROM OLD.password_reset_required THEN
    IF public.is_profiles_admin() THEN
      PERFORM public._sync_password_reset_guard(
        NEW.id, v_was_required, COALESCE(NEW.password_reset_required, false)
      );
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'profiles: cannot change role, assigned_outlet_id, or password_reset_required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public._sync_password_reset_guard(
    NEW.id, v_was_required, COALESCE(NEW.password_reset_required, false)
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_enforce_privileged_columns() FROM PUBLIC;

-- Existing rows already flagged must rotate; snapshot the current hash so a
-- no-op clear still fails.
INSERT INTO public.profile_password_reset_guards (user_id, verifier)
SELECT p.id, u.encrypted_password
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE COALESCE(p.password_reset_required, false)
ON CONFLICT (user_id) DO UPDATE
  SET verifier = EXCLUDED.verifier,
      updated_at = now();

CREATE OR REPLACE FUNCTION public.clear_own_password_reset_required()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flag boolean;
  v_snap text;
  v_now text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(password_reset_required, false)
  INTO v_flag
  FROM public.profiles
  WHERE id = auth.uid();

  IF NOT FOUND OR NOT COALESCE(v_flag, false) THEN
    RETURN;
  END IF;

  SELECT g.verifier
  INTO v_snap
  FROM public.profile_password_reset_guards g
  WHERE g.user_id = auth.uid();

  SELECT u.encrypted_password
  INTO v_now
  FROM auth.users u
  WHERE u.id = auth.uid();

  -- Missing snapshot, or hash unchanged since the flag was set: refuse.
  IF v_snap IS NULL OR v_now IS NOT DISTINCT FROM v_snap THEN
    RAISE EXCEPTION 'password_not_changed' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('quackmaster.bypass_profile_privilege_guard', 'on', true);

  UPDATE public.profiles
  SET
    password_reset_required = false,
    updated_at = now()
  WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.clear_own_password_reset_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_own_password_reset_required() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_profiles_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  ok boolean;
BEGIN
  SET LOCAL row_security = off;
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND COALESCE(password_reset_required, false) = false
  )
  INTO ok;
  RETURN COALESCE(ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.is_profiles_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_profiles_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_authenticated_active_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin', 'staff')
      AND COALESCE(p.password_reset_required, false) = false
  );
$$;

REVOKE ALL ON FUNCTION public.is_authenticated_active_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_authenticated_active_staff() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_supervisor_for_outlet(p_outlet_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_outlet_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND lower(trim(p.role::text)) = 'supervisor'
      AND COALESCE(p.password_reset_required, false) = false
      AND p.assigned_outlet_id IS NOT NULL
      AND p.assigned_outlet_id = p_outlet_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_supervisor_for_outlet(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_supervisor_for_outlet(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.profile_can_post_outlet_stock_take(p_outlet_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_outlet_id IS NULL THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND COALESCE(p.password_reset_required, false) = false
        AND lower(trim(p.role::text)) IN ('admin', 'staff')
        AND lower(trim(p.role::text)) <> 'pending'
    ) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND COALESCE(p.password_reset_required, false) = false
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND p.assigned_outlet_id = p_outlet_id
    ) THEN true
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.profile_can_post_outlet_stock_take(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_can_post_outlet_stock_take(uuid) TO authenticated;

-- Catch auth.uid()-only writers (reserve/fulfill, PO receive/cancel) that do not
-- call the helpers above. Service role and migrations have a null auth.uid().
CREATE OR REPLACE FUNCTION public.reject_stock_write_during_password_reset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  locked boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT COALESCE(p.password_reset_required, false)
  INTO locked
  FROM public.profiles p
  WHERE p.id = auth.uid();

  IF COALESCE(locked, false) THEN
    RAISE EXCEPTION 'password_reset_required' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_stock_write_during_password_reset() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_hub_inventory_password_reset_lock ON public.hub_inventory;
CREATE TRIGGER trg_hub_inventory_password_reset_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.hub_inventory
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_stock_write_during_password_reset();

DROP TRIGGER IF EXISTS trg_outlet_inventory_password_reset_lock ON public.outlet_inventory;
CREATE TRIGGER trg_outlet_inventory_password_reset_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.outlet_inventory
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_stock_write_during_password_reset();
