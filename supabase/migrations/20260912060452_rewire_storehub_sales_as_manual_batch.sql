-- Quackmaster only.
-- Rewire historical StoreHub-posted sales into the same shape as manual batch journals
-- (like 1Utama): recipe SKU + lot lines, source=manual. Reverse phantom no-lot POS lines
-- that never belonged in FG batch tracking.

DO $$
DECLARE
  r RECORD;
  j RECORD;
  v_restored int := 0;
  v_lines_deleted int := 0;
  v_journals_voided int := 0;
  v_journals_rewired int := 0;
  v_lines_normalized int := 0;
BEGIN
  -- 1) Restore stock for StoreHub lines with no lot (POS menu / non-batch inventory),
  --    then delete those lines. FG lot-backed lines stay.
  FOR r IN
    SELECT
      sj.id AS journal_id,
      sj.outlet_id,
      sj.business_date,
      sjl.id AS line_id,
      sjl.quantity_sold,
      sjl.outlet_inventory_id,
      sjl.product_batch
    FROM public.sales_journal_lines sjl
    JOIN public.sales_journals sj ON sj.id = sjl.sales_journal_id
    WHERE sj.source = 'storehub'
      AND sj.status = 'posted'
      AND sjl.lot_id IS NULL
    ORDER BY sj.business_date, sj.id, sjl.created_at, sjl.id
  LOOP
    IF r.outlet_inventory_id IS NULL THEN
      RAISE EXCEPTION 'storehub_no_lot_line_missing_outlet_inventory line=% batch=%', r.line_id, r.product_batch;
    END IF;

    PERFORM public._set_outlet_movement_ctx(
      r.outlet_id,
      'reversal',
      r.business_date,
      'sales_journal',
      r.journal_id,
      jsonb_build_object(
        'source', 'rewire_storehub_as_manual',
        'reason', 'drop_no_lot_pos_line',
        'product_batch', r.product_batch
      )
    );

    UPDATE public.outlet_inventory oi
    SET
      quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
      available_quantity = (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(),
      updated_at = now()
    WHERE oi.id = r.outlet_inventory_id;

    PERFORM public._clear_outlet_movement_ctx();

    DELETE FROM public.sales_journal_lines WHERE id = r.line_id;
    v_restored := v_restored + 1;
    v_lines_deleted := v_lines_deleted + 1;
  END LOOP;

  -- 2) Void StoreHub journals that have no lines left after the cleanup.
  FOR j IN
    SELECT sj.id, sj.idempotency_key
    FROM public.sales_journals sj
    WHERE sj.source = 'storehub'
      AND sj.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_journal_lines sjl WHERE sjl.sales_journal_id = sj.id
      )
  LOOP
    UPDATE public.sales_journals
    SET status = 'voided', updated_at = now(), notes = COALESCE(notes, '') || CASE
      WHEN notes IS NULL OR notes = '' THEN 'Voided: StoreHub non-batch lines removed'
      ELSE ' · Voided: StoreHub non-batch lines removed'
    END
    WHERE id = j.id;

    IF j.idempotency_key IS NOT NULL THEN
      UPDATE public.storehub_sync_events
      SET
        status = 'voided',
        error = 'rewire_no_lot_only',
        payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('rewired_void', true),
        updated_at = now()
      WHERE ref_id = j.idempotency_key;
    END IF;

    v_journals_voided := v_journals_voided + 1;
  END LOOP;

  -- 3) Remaining posted StoreHub journals are lot-backed FG sales — treat as manual batch journals.
  UPDATE public.sales_journals sj
  SET
    source = 'manual',
    notes = NULL,
    updated_at = now()
  WHERE sj.source = 'storehub'
    AND sj.status = 'posted'
    AND EXISTS (
      SELECT 1 FROM public.sales_journal_lines sjl WHERE sjl.sales_journal_id = sj.id
    );

  GET DIAGNOSTICS v_journals_rewired = ROW_COUNT;

  UPDATE public.storehub_sync_events e
  SET
    payload = COALESCE(e.payload, '{}'::jsonb) || jsonb_build_object('rewired_as_manual', true),
    updated_at = now()
  FROM public.sales_journals sj
  WHERE e.sales_journal_id = sj.id
    AND sj.source = 'manual'
    AND sj.status = 'posted'
    AND e.status = 'posted';

  -- 4) Normalize line product_batch to recipe SKU when the lot has one (matches 1Utama).
  UPDATE public.sales_journal_lines sjl
  SET product_batch = trim(both from public.fg_recipe_sku(sjl.lot_id))
  FROM public.sales_journals sj
  WHERE sjl.sales_journal_id = sj.id
    AND sj.status = 'posted'
    AND sjl.lot_id IS NOT NULL
    AND public.fg_recipe_sku(sjl.lot_id) IS NOT NULL
    AND trim(both from public.fg_recipe_sku(sjl.lot_id)) <> ''
    AND trim(both from sjl.product_batch) IS DISTINCT FROM trim(both from public.fg_recipe_sku(sjl.lot_id));

  GET DIAGNOSTICS v_lines_normalized = ROW_COUNT;

  RAISE NOTICE 'rewire_storehub_sales_as_manual_batch: restored_no_lot_lines=%, deleted_lines=%, voided_empty_journals=%, rewired_journals=%, normalized_batches=%',
    v_restored, v_lines_deleted, v_journals_voided, v_journals_rewired, v_lines_normalized;
END;
$$;
