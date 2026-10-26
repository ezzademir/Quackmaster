/*
  086 — _append_data_ledger: write a system row when there is no signed-in user.

  Numbered 086 because 084 and 085 are reserved for #89 (rebased after #90).

  Before: IF auth.uid() IS NULL THEN RETURN; — every call from a migration, cron, edge function using
  service_role, or other non-user context silently wrote NO audit row (found after 082: the PO-0032
  +0.004 kg correction, and 868 StoreHub journals from 11–12 Sep).
  After: such calls write a row with user_id NULL, user_email '' and metadata.actor = 'system'
  (merged over any caller metadata). Signed-in calls are unchanged.

  Unchanged from live (verified 2026-10-24): signature, RETURNS void, plpgsql, SECURITY DEFINER,
  SET search_path TO 'public', owner postgres, EXECUTE only for postgres and service_role,
  and the outer EXCEPTION -> RAISE WARNING so a ledger failure never aborts the caller.
  No data is changed; no backfill (separate proposal).
*/

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

ALTER FUNCTION public._append_data_ledger(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._append_data_ledger(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._append_data_ledger(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) TO service_role;
