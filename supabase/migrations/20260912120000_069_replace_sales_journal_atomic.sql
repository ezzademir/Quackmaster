/*
  replace_sales_journal voids the posted journal, then reposts.

  void_sales_journal and post_sales_journal report pre-write failures with
  RETURN jsonb success:false. PostgREST treats that as a successful RPC
  and commits. After sales_journals_status_check allows 'voided', a failed
  edit persists the void: the original sale leaves the posted list and
  outlet stock is restored while the UI shows an error.

  Trigger: admin edits a posted sale to a qty/SKU that cannot be
  reposted (e.g. 5 sold, 2 remaining, save as 8). Void restores 5
  (7 available), post returns insufficient_stock, transaction commits.

  Inner soft-failures now RAISE so the void (and any partial repost)
  rolls back with the original posted journal intact.

  Also require is_profiles_admin() here (void already does) so a
  non-admin cannot reach post after a void that somehow passed.
*/

CREATE OR REPLACE FUNCTION public.replace_sales_journal(
  p_existing_sales_journal_id uuid,
  p_business_date date,
  p_lines jsonb,
  p_notes text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_outlet uuid;
  v_void jsonb;
  v_post jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;

  SELECT sj.outlet_id
  INTO v_outlet
  FROM public.sales_journals sj
  WHERE sj.id = p_existing_sales_journal_id AND sj.status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_found_or_not_posted');
  END IF;

  v_void := public.void_sales_journal(p_existing_sales_journal_id);

  IF COALESCE(v_void->>'success', 'false') <> 'true' THEN
    RAISE EXCEPTION '%', COALESCE(v_void->>'error', 'replace_sales_journal_void_failed')
      USING ERRCODE = 'P0001',
            DETAIL = v_void::text;
  END IF;

  v_post := public.post_sales_journal(
    v_outlet,
    p_business_date,
    p_lines,
    p_notes,
    p_idempotency_key
  );

  IF COALESCE(v_post->>'success', 'false') <> 'true' THEN
    RAISE EXCEPTION '%', COALESCE(v_post->>'error', 'replace_sales_journal_repost_failed')
      USING ERRCODE = 'P0001',
            DETAIL = v_post::text;
  END IF;

  RETURN v_post;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_sales_journal(uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_sales_journal(uuid, date, jsonb, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.replace_sales_journal(uuid, date, jsonb, text, uuid) IS
  'Admin replace: void then post. Soft failures after void/post writes RAISE so PostgREST rolls back the original posted journal.';
