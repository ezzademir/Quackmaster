/*
  # Pack 1 — Auth lockdown (audit P0 / selected P1)

  1. profiles.role CHECK + default 'pending'
  2. handle_new_user() hard-codes role='pending' (ignores signup metadata)
  3. BEFORE INSERT/UPDATE trigger blocks non-admin changes to
     role, assigned_outlet_id, password_reset_required
  4. clear_own_password_reset_required() for post-password-change UX
  5. Drop anon INSERT on pending_registrations (keep authenticated own-row insert)
*/

-- ---------------------------------------------------------------------------
-- Role constraint + safer default
-- ---------------------------------------------------------------------------
UPDATE public.profiles
SET role = 'pending'
WHERE lower(trim(role::text)) NOT IN ('admin', 'staff', 'pending', 'supervisor');

ALTER TABLE public.profiles
  ALTER COLUMN role SET DEFAULT 'pending';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'staff', 'pending', 'supervisor'));

-- ---------------------------------------------------------------------------
-- Signup trigger: never trust client metadata for role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'pending'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileged-column guard (RLS own-UPDATE still exists; trigger narrows it)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_enforce_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    -- System / signup inserts (no end-user JWT): force pending
    IF auth.uid() IS NULL THEN
      NEW.role := 'pending';
      NEW.assigned_outlet_id := NULL;
      RETURN NEW;
    END IF;

    IF public.is_profiles_admin() THEN
      RETURN NEW;
    END IF;

    -- Non-admin self-insert cannot mint privileged rows
    NEW.role := 'pending';
    NEW.assigned_outlet_id := NULL;
    NEW.password_reset_required := false;
    RETURN NEW;
  END IF;

  -- UPDATE: non-admins cannot change privileged columns
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.assigned_outlet_id IS DISTINCT FROM OLD.assigned_outlet_id
     OR NEW.password_reset_required IS DISTINCT FROM OLD.password_reset_required THEN
    IF public.is_profiles_admin() THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'profiles: cannot change role, assigned_outlet_id, or password_reset_required'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_enforce_privileged_columns ON public.profiles;

CREATE TRIGGER trg_profiles_enforce_privileged_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_enforce_privileged_columns();

REVOKE ALL ON FUNCTION public.profiles_enforce_privileged_columns() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Allow the signed-in user to clear their own force-reset flag after
-- supabase.auth.updateUser({ password }) succeeds (client calls this RPC).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_own_password_reset_required()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
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

-- ---------------------------------------------------------------------------
-- pending_registrations: remove anon INSERT (spam / unbound user_id)
-- Authenticated own-row insert from 034 remains.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anon users can create pending registrations" ON public.pending_registrations;
DROP POLICY IF EXISTS "Anon users can create their pending registration" ON public.pending_registrations;
DROP POLICY IF EXISTS "Anon users can create pending registration" ON public.pending_registrations;
