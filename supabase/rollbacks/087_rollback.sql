-- Rollback 087: restores the EXACT live definition of public.is_profiles_admin() as captured read-only with
-- pg_get_functiondef on project fknrfntqycfrkaihwngg (Quackmaster) on 2026-10-24. proconfig is reset to {search_path=public}.
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
