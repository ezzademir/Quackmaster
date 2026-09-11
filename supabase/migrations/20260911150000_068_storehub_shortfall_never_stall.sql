-- 068: StoreHub ingest posts through stock shortfalls (negative ATP + needs_review).
-- Cursor never stalls on insufficient_stock — Edge advances when run has no error.
-- Revenue tickets are never silently dropped; shortfall is visible in sync_events.

CREATE OR REPLACE FUNCTION public.ingest_storehub_sale(
  p_ref_id uuid,
  p_outlet_id uuid,
  p_business_date date,
  p_lines jsonb,
  p_notes text DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_sync_run_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing uuid;
  v_existing_status text;
  v_event public.storehub_sync_events%ROWTYPE;
  v_journal_id uuid;
  rec jsonb;
  v_sku text;
  v_qty numeric;
  v_remaining numeric;
  v_total_avail numeric;
  r RECORD;
  v_avail numeric;
  v_take numeric;
  v_lines jsonb := '[]'::jsonb;
  v_shortfalls jsonb := '[]'::jsonb;
  v_skus_seen int := 0;
  v_has_shortfall boolean := false;
  v_short_inv uuid;
  v_short_batch text;
  v_short_lot uuid;
BEGIN
  IF NOT public.is_storehub_ingest() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  IF p_ref_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ref_id_required');
  END IF;

  IF p_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required');
  END IF;

  IF p_business_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'business_date_required');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  SELECT id, status INTO v_existing, v_existing_status
  FROM public.sales_journals
  WHERE idempotency_key = p_ref_id
  FOR UPDATE;

  IF FOUND THEN
    IF lower(trim(COALESCE(v_existing_status, ''))) = 'posted' THEN
      INSERT INTO public.storehub_sync_events (
        ref_id, invoice_number, event_type, status, sales_journal_id, outlet_id, payload, sync_run_id
      )
      VALUES (
        p_ref_id, p_invoice_number, 'sale', 'skipped', v_existing, p_outlet_id,
        jsonb_build_object('idempotent_replay', true, 'channel', p_channel),
        p_sync_run_id
      )
      ON CONFLICT (ref_id) DO UPDATE SET
        updated_at = now(),
        sync_run_id = COALESCE(EXCLUDED.sync_run_id, public.storehub_sync_events.sync_run_id);

      RETURN jsonb_build_object(
        'success', true,
        'sales_journal_id', v_existing,
        'idempotent_replay', true
      );
    END IF;

    -- voided / cancelled / draft: free unique key so POS can re-post after UI void
    UPDATE public.sales_journals
    SET idempotency_key = NULL,
        updated_at = now()
    WHERE id = v_existing;
  END IF;

  SELECT * INTO v_event FROM public.storehub_sync_events WHERE ref_id = p_ref_id;
  IF FOUND AND v_event.status = 'posted' AND v_event.sales_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'sales_journal_id', v_event.sales_journal_id,
      'idempotent_replay', true
    );
  END IF;
  -- Also treat needs_review (prior shortfall post) as idempotent success
  IF FOUND AND v_event.status = 'needs_review' AND v_event.sales_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'sales_journal_id', v_event.sales_journal_id,
      'idempotent_replay', true,
      'shortfall', true
    );
  END IF;

  -- Validate lines (do NOT hard-fail on ATP shortfall — post + flag instead)
  FOR rec IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_sku := trim(both from coalesce(rec ->> 'sku', ''));
    v_qty := (rec ->> 'quantity')::numeric;
    IF v_sku = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_required');
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity', 'sku', v_sku);
    END IF;
    v_skus_seen := v_skus_seen + 1;
  END LOOP;

  IF v_skus_seen = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  INSERT INTO public.sales_journals (
    outlet_id, business_date, status, notes, idempotency_key, created_by, source
  )
  VALUES (
    p_outlet_id,
    p_business_date,
    'posted',
    p_notes,
    p_ref_id,
    auth.uid(),
    'storehub'
  )
  RETURNING id INTO v_journal_id;

  FOR rec IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_sku := trim(both from coalesce(rec ->> 'sku', ''));
    v_qty := (rec ->> 'quantity')::numeric;
    v_remaining := v_qty;
    v_total_avail := 0;

    -- FIFO consume from positive ATP lots
    FOR r IN
      SELECT
        oi.id,
        oi.product_batch,
        oi.lot_id,
        oi.quantity_on_hand,
        COALESCE(oi.reserved_quantity, 0) AS reserved_qty
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      WHERE oi.outlet_id = p_outlet_id
        AND oi.quantity_on_hand > 0
        AND public.fg_identifier_matches(
          oi.product_batch,
          il.product_batch_label,
          public.fg_recipe_sku(oi.lot_id),
          v_sku
        )
      ORDER BY
        il.expiry_date ASC NULLS LAST,
        il.manufactured_at ASC NULLS LAST,
        oi.created_at ASC NULLS LAST,
        oi.id ASC
      FOR UPDATE OF oi
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_avail := GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
      v_take := LEAST(v_avail, v_remaining);
      IF v_take <= 0 THEN
        CONTINUE;
      END IF;

      v_total_avail := v_total_avail + v_take;

      INSERT INTO public.sales_journal_lines (
        sales_journal_id, product_batch, lot_id, quantity_sold, outlet_inventory_id
      )
      VALUES (
        v_journal_id,
        trim(both from r.product_batch),
        r.lot_id,
        v_take,
        r.id
      );

      PERFORM public._set_outlet_movement_ctx(
        p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id,
        jsonb_build_object('source', 'storehub', 'sku', v_sku, 'ref_id', p_ref_id)
      );

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - v_take,
        available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = r.id;

      PERFORM public._clear_outlet_movement_ctx();

      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'outlet_inventory_id', r.id,
          'product_batch', trim(both from r.product_batch),
          'sku', v_sku,
          'quantity_sold', v_take
        )
      );

      v_remaining := v_remaining - v_take;
    END LOOP;

    -- Shortfall: allow negative ATP so the revenue ticket is fully posted
    IF v_remaining > 0 THEN
      v_has_shortfall := true;
      v_short_inv := NULL;
      v_short_batch := NULL;
      v_short_lot := NULL;

      -- Prefer any existing matching inventory row (incl. zero/negative) to go more negative
      SELECT oi.id, oi.product_batch, oi.lot_id
      INTO v_short_inv, v_short_batch, v_short_lot
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      WHERE oi.outlet_id = p_outlet_id
        AND oi.raw_material_id IS NULL
        AND public.fg_identifier_matches(
          oi.product_batch,
          il.product_batch_label,
          public.fg_recipe_sku(oi.lot_id),
          v_sku
        )
      ORDER BY oi.created_at ASC NULLS LAST, oi.id ASC
      LIMIT 1
      FOR UPDATE OF oi;

      IF v_short_inv IS NULL THEN
        -- No row for this SKU: create synthetic FG row keyed by SKU as product_batch
        INSERT INTO public.outlet_inventory (
          outlet_id, product_batch, quantity_on_hand, reserved_quantity, available_quantity
        )
        VALUES (
          p_outlet_id, v_sku, 0, 0, 0
        )
        RETURNING id, product_batch, lot_id INTO v_short_inv, v_short_batch, v_short_lot;
      END IF;

      INSERT INTO public.sales_journal_lines (
        sales_journal_id, product_batch, lot_id, quantity_sold, outlet_inventory_id
      )
      VALUES (
        v_journal_id,
        trim(both from COALESCE(v_short_batch, v_sku)),
        v_short_lot,
        v_remaining,
        v_short_inv
      );

      PERFORM public._set_outlet_movement_ctx(
        p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id,
        jsonb_build_object(
          'source', 'storehub',
          'sku', v_sku,
          'ref_id', p_ref_id,
          'shortfall', true,
          'shortfall_qty', v_remaining
        )
      );

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - v_remaining,
        available_quantity = (oi.quantity_on_hand - v_remaining) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_short_inv;

      PERFORM public._clear_outlet_movement_ctx();

      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'outlet_inventory_id', v_short_inv,
          'product_batch', trim(both from COALESCE(v_short_batch, v_sku)),
          'sku', v_sku,
          'quantity_sold', v_remaining,
          'shortfall', true
        )
      );

      v_shortfalls := v_shortfalls || jsonb_build_array(
        jsonb_build_object(
          'sku', v_sku,
          'requested', v_qty,
          'available', v_total_avail,
          'shortfall', v_remaining,
          'outlet_inventory_id', v_short_inv
        )
      );

      v_remaining := 0;
    END IF;
  END LOOP;

  INSERT INTO public.storehub_sync_events (
    ref_id, invoice_number, event_type, status, sales_journal_id, outlet_id, error, payload, sync_run_id
  )
  VALUES (
    p_ref_id,
    p_invoice_number,
    'sale',
    CASE WHEN v_has_shortfall THEN 'needs_review' ELSE 'posted' END,
    v_journal_id,
    p_outlet_id,
    CASE WHEN v_has_shortfall THEN 'insufficient_stock_shortfall' ELSE NULL END,
    jsonb_build_object(
      'channel', p_channel,
      'lines', v_lines,
      'shortfalls', v_shortfalls,
      'negative_atp', v_has_shortfall
    ),
    p_sync_run_id
  )
  ON CONFLICT (ref_id) DO UPDATE SET
    event_type = 'sale',
    status = EXCLUDED.status,
    sales_journal_id = EXCLUDED.sales_journal_id,
    outlet_id = EXCLUDED.outlet_id,
    invoice_number = EXCLUDED.invoice_number,
    error = EXCLUDED.error,
    payload = EXCLUDED.payload,
    sync_run_id = COALESCE(EXCLUDED.sync_run_id, public.storehub_sync_events.sync_run_id),
    updated_at = now();

  PERFORM public._append_data_ledger(
    'posted',
    'sales_journal',
    v_journal_id::text,
    'sales',
    'event',
    p_ref_id::text,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'business_date', p_business_date,
      'mode', 'storehub_fifo',
      'lines', v_lines,
      'shortfalls', v_shortfalls,
      'invoice', p_invoice_number
    ),
    NULL,
    jsonb_build_object('notes', p_notes, 'source', 'storehub', 'shortfall', v_has_shortfall)
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id,
    'lines', v_lines,
    'shortfall', v_has_shortfall,
    'shortfalls', v_shortfalls
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) TO service_role;

COMMENT ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) IS
  'StoreHub POS ingest: posts full ticket qty via FIFO; on ATP shortfall allows negative outlet ATP and marks sync_event needs_review (insufficient_stock_shortfall). Never blocks cursor.';
