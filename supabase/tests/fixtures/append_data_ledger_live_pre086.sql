-- Live definition of public._append_data_ledger captured 2026-10-24 (pre-086). ACL live: {postgres=X/postgres,service_role=X/postgres}, owner postgres.
CREATE OR REPLACE FUNCTION public._append_data_ledger(p_action text, p_entity_type text, p_entity_id text, p_module text, p_operation text, p_reference_id text DEFAULT NULL::text, p_before jsonb DEFAULT NULL::jsonb, p_after jsonb DEFAULT NULL::jsonb, p_delta jsonb DEFAULT NULL::jsonb, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := '';
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    SELECT COALESCE(u.email::text, '')
    INTO v_email
    FROM auth.users u
    WHERE u.id = auth.uid();
  EXCEPTION
    WHEN OTHERS THEN
      v_email := '';
  END;

  INSERT INTO public.data_ledger (
    user_id, user_email, action, entity_type, entity_id, module, operation, reference_id,
    before_data, after_data, delta_data, metadata
  )
  VALUES (
    auth.uid(), v_email, p_action, p_entity_type, p_entity_id, p_module, p_operation, p_reference_id,
    p_before, p_after, p_delta, p_metadata
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'data_ledger insert failed: %', SQLERRM;
END;
$function$;
REVOKE ALL ON FUNCTION public._append_data_ledger(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._append_data_ledger(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) TO service_role;
