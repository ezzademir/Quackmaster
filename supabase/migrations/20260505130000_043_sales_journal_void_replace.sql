/*
  Sales journal maintenance: reverse outlet stock and delete a posted journal, or atomically replace
  (void + repost). RLS prevents direct DELETE on sales_journals; these SECURITY DEFINER RPCs mirror post_sales_journal.
*/

CREATE OR REPLACE FUNCTION public.void_sales_journal(p_sales_journal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_header RECORD;
  r RECORD;
  v_rows integer;
  v_lines_snap jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT *
  INTO v_header
  FROM public.sales_journals
  WHERE id = p_sales_journal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_found');
  END IF;

  IF v_header.status IS DISTINCT FROM 'posted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_voidable_status');
  END IF;

  SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'product_batch', sj.product_batch,
          'quantity_sold', sj.quantity_sold
        )
        ORDER BY sj.created_at, sj.id
      ),
      '[]'::jsonb
    )
  INTO v_lines_snap
  FROM public.sales_journal_lines sj
  WHERE sj.sales_journal_id = p_sales_journal_id;

  FOR r IN
    SELECT product_batch, quantity_sold
    FROM public.sales_journal_lines
    WHERE sales_journal_id = p_sales_journal_id
    ORDER BY created_at, id
  LOOP
    UPDATE public.outlet_inventory oi
    SET
      quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
      available_quantity =
        (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(),
      updated_at = now()
    WHERE oi.outlet_id = v_header.outlet_id AND oi.product_batch = trim(both from r.product_batch);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'outlet_stock_missing_for_reversal',
        'product_batch', r.product_batch
      );
    END IF;
  END LOOP;

  PERFORM public._append_data_ledger(
    'voided',
    'sales_journal',
    p_sales_journal_id::text,
    'sales',
    'event',
    NULL,
    jsonb_build_object(
      'outlet_id', v_header.outlet_id,
      'business_date', v_header.business_date,
      'lines', v_lines_snap,
      'notes', v_header.notes
    ),
    NULL,
    NULL,
    jsonb_build_object('reason', 'user_void')
  );

  DELETE FROM public.sales_journals WHERE id = p_sales_journal_id;

  RETURN jsonb_build_object('success', true, 'sales_journal_id', p_sales_journal_id);
END;
$$;

REVOKE ALL ON FUNCTION public.void_sales_journal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_sales_journal(uuid) TO authenticated;

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
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
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
    RETURN v_void;
  END IF;

  RETURN public.post_sales_journal(v_outlet, p_business_date, p_lines, p_notes, p_idempotency_key);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_sales_journal(uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_sales_journal(uuid, date, jsonb, text, uuid) TO authenticated;
