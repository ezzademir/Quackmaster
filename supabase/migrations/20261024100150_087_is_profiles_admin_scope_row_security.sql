-- 087: is_profiles_admin() must not leave row_security = off for the rest of the transaction.
-- Independent of 084/085 (own change set). Applies on live as-is: replaces only this function; grants (authenticated, service_role) are kept.
--
-- Live today: body runs `SET LOCAL row_security = off`, which lasts to the end of the transaction, so any later query by an
-- RLS-governed role in the same transaction fails with "query would be affected by row-level security policy".
-- The function owner (postgres) has BYPASSRLS and public.profiles is not FORCE RLS, so the setting is not needed; the
-- function-level SET below keeps it scoped to the call (restored on return) for any deployment where the owner lacks BYPASSRLS.
CREATE OR REPLACE FUNCTION public.is_profiles_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET row_security TO 'off'
AS $function$
DECLARE
  ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active
  )
  INTO ok;
  RETURN COALESCE(ok, false);
END;
$function$;
