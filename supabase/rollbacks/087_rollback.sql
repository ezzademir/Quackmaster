-- Rollback order: 090 -> 088 -> 087 -> 085 -> 084 (newest first; 089 goes before 090). Apply order: 084, 085, 087, 088, 090, then 089.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file> (or one Supabase SQL editor / execute_sql call). NEVER plain `psql -f`: it keeps going after an error (e.g. past a raised guard) and leaves a half-done rollback.
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
