-- snapshot_all_outlets_daily: fix 076 guard. current_user is always the owner inside SECURITY DEFINER, so the
-- postgres/supabase_admin clause let every signed-in user through. Admin or service_role only.
CREATE OR REPLACE FUNCTION public.snapshot_all_outlets_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outlet uuid;
  v_count integer := 0;
BEGIN
  IF NOT (public.is_profiles_admin() OR coalesce(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  FOR v_outlet IN SELECT id FROM public.outlets ORDER BY name
  LOOP
    PERFORM public.snapshot_outlet_inventory(v_outlet, CURRENT_DATE, 'daily');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

