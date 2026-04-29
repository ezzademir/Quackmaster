/*
  # Fix infinite recursion on profiles RLS (42P17)

  Policies on profiles that use EXISTS (SELECT … FROM profiles …) recurse: Postgres re-enters
  profiles RLS while checking profiles RLS.

  Fix: public.is_profiles_admin() uses SECURITY DEFINER and SET LOCAL row_security = off only
  around the lookup so the inner SELECT does not re-trigger profiles policies.

  Drops and recreates:
  - "Admins can view all profiles" (017)
  - "Admins can update all profiles" (016)
*/

DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can update all profiles" ON public.profiles;

DROP FUNCTION IF EXISTS public.is_profiles_admin();

CREATE FUNCTION public.is_profiles_admin()
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
    WHERE id = auth.uid() AND role = 'admin'
  )
  INTO ok;
  RETURN COALESCE(ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.is_profiles_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_profiles_admin() TO authenticated;

CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (public.is_profiles_admin());

CREATE POLICY "Admins can update all profiles"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());
