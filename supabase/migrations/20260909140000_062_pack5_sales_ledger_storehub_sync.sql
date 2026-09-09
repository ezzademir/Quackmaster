/*
  Pack 5 / audit P0: sales ledger + StoreHub sync correctness

  1. Instrument post_sales_journal + post_sales_journal_fifo_by_sku with
     _set_outlet_movement_ctx / _clear_outlet_movement_ctx (mirror ingest_storehub_sale).
     Preserve supervisor outlet auth from 062 supervisor migration.
  2. Backfill missing sale movements for posted journals that never got them.
  3. ingest_storehub_sale: voided/cancelled journals with the same idempotency_key
     must NOT count as success — free the key and allow re-post.
  4. void_sales_journal: keep admin-only; when source=storehub, align
     storehub_sync_events to voided (P1-4 low-risk).
*/

-- ---------------------------------------------------------------------------
-- post_sales_journal_fifo_by_sku (+ movement ctx + supervisor outlet)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_sales_journal_fifo_by_sku(
  p_outlet_id uuid,
  p_business_date date,
  p_sku text,
  p_quantity_sold numeric,
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
  v_existing uuid;
  v_journal_id uuid;
  v_sku text := trim(both from p_sku);
  v_remaining numeric;
  v_total_avail numeric := 0;
  r RECORD;
  v_avail numeric;
  v_take numeric;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.is_authenticated_active_staff()
    OR public.is_supervisor_for_outlet(p_outlet_id)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.sales_journals
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'sales_journal_id', v_existing,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF v_sku IS NULL OR v_sku = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'sku_required');
  END IF;

  IF p_quantity_sold IS NULL OR p_quantity_sold <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity');
  END IF;

  v_remaining := p_quantity_sold;

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
    v_total_avail := v_total_avail + GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
  END LOOP;

  IF v_total_avail < p_quantity_sold THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_stock',
      'sku', v_sku,
      'requested', p_quantity_sold,
      'available', v_total_avail
    );
  END IF;

  INSERT INTO public.sales_journals (
    outlet_id,
    business_date,
    status,
    notes,
    idempotency_key,
    created_by
  )
  VALUES (
    p_outlet_id,
    p_business_date,
    'posted',
    p_notes,
    p_idempotency_key,
    v_uid
  )
  RETURNING id INTO v_journal_id;

  v_remaining := p_quantity_sold;

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

    INSERT INTO public.sales_journal_lines (
      sales_journal_id,
      product_batch,
      lot_id,
      quantity_sold,
      outlet_inventory_id
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
      jsonb_build_object('source', 'manual', 'mode', 'fifo_by_sku', 'sku', v_sku)
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
        'quantity_sold', v_take
      )
    );

    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'fifo_alloc_internal_error', 'remaining', v_remaining);
  END IF;

  PERFORM public._append_data_ledger(
    'posted',
    'sales_journal',
    v_journal_id::text,
    'sales',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'business_date', p_business_date,
      'mode', 'fifo_by_sku',
      'sku', v_sku,
      'lines', v_lines
    ),
    NULL,
    jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id,
    'lines', v_lines
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- post_sales_journal (+ movement ctx + supervisor outlet)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_sales_journal(
  p_outlet_id uuid,
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
  v_existing uuid;
  v_journal_id uuid;
  rec jsonb;
  v_batch text;
  v_qty numeric;
  v_inv_id uuid;
  v_lot uuid;
  v_o_inv_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
  v_remaining numeric;
  v_take numeric;
  r RECORD;
  v_lines_meta jsonb := '[]'::jsonb;
  v_total_avail numeric;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.is_authenticated_active_staff()
    OR public.is_supervisor_for_outlet(p_outlet_id)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.sales_journals
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'sales_journal_id', v_existing,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_qty := (rec->>'quantity_sold')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;

    IF rec ? 'outlet_inventory_id'
       AND rec->>'outlet_inventory_id' IS NOT NULL
       AND trim(rec->>'outlet_inventory_id') <> '' THEN
      v_inv_id := (rec->>'outlet_inventory_id')::uuid;

      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_o_inv_id, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
      FOR UPDATE;

      IF NOT FOUND OR v_o_inv_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_not_found', 'outlet_inventory_id', v_inv_id);
      END IF;

      v_avail := v_qoh - v_res;
      IF v_avail < v_qty THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'insufficient_available',
          'outlet_inventory_id', v_inv_id,
          'available', v_avail,
          'requested', v_qty
        );
      END IF;
    ELSE
      v_batch := trim(rec->>'product_batch');
      IF v_batch IS NULL OR v_batch = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'product_batch_or_outlet_inventory_id_required');
      END IF;

      v_total_avail := 0;
      FOR r IN
        SELECT
          oi.id,
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
            v_batch
          )
        ORDER BY
          il.expiry_date ASC NULLS LAST,
          il.manufactured_at ASC NULLS LAST,
          oi.created_at ASC NULLS LAST,
          oi.id ASC
        FOR UPDATE OF oi
      LOOP
        v_total_avail := v_total_avail + GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
      END LOOP;

      IF v_total_avail < v_qty THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'insufficient_stock',
          'product_batch', v_batch,
          'requested', v_qty,
          'available', v_total_avail
        );
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.sales_journals (
    outlet_id,
    business_date,
    status,
    notes,
    idempotency_key,
    created_by
  )
  VALUES (
    p_outlet_id,
    p_business_date,
    'posted',
    p_notes,
    p_idempotency_key,
    v_uid
  )
  RETURNING id INTO v_journal_id;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_qty := (rec->>'quantity_sold')::numeric;

    IF rec ? 'outlet_inventory_id'
       AND rec->>'outlet_inventory_id' IS NOT NULL
       AND trim(rec->>'outlet_inventory_id') <> '' THEN
      v_inv_id := (rec->>'outlet_inventory_id')::uuid;

      SELECT oi.product_batch, oi.lot_id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_batch, v_lot, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_missing_mid_post', 'outlet_inventory_id', v_inv_id);
      END IF;

      PERFORM public._set_outlet_movement_ctx(
        p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id,
        jsonb_build_object('source', 'manual', 'mode', 'by_line')
      );

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - v_qty,
        available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_inv_id;

      PERFORM public._clear_outlet_movement_ctx();

      INSERT INTO public.sales_journal_lines (
        sales_journal_id,
        product_batch,
        lot_id,
        quantity_sold,
        outlet_inventory_id
      )
      VALUES (v_journal_id, trim(both from v_batch), v_lot, v_qty, v_inv_id);

      v_lines_meta := v_lines_meta || jsonb_build_array(
        jsonb_build_object(
          'outlet_inventory_id', v_inv_id,
          'product_batch', trim(both from v_batch),
          'quantity_sold', v_qty
        )
      );
    ELSE
      v_batch := trim(rec->>'product_batch');
      v_remaining := v_qty;

      FOR r IN
        SELECT
          oi.id AS inv_id,
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
            v_batch
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

        PERFORM public._set_outlet_movement_ctx(
          p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id,
          jsonb_build_object('source', 'manual', 'mode', 'by_batch_fifo')
        );

        UPDATE public.outlet_inventory oi
        SET
          quantity_on_hand = oi.quantity_on_hand - v_take,
          available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
          last_updated = now(),
          updated_at = now()
        WHERE oi.id = r.inv_id;

        PERFORM public._clear_outlet_movement_ctx();

        INSERT INTO public.sales_journal_lines (
          sales_journal_id,
          product_batch,
          lot_id,
          quantity_sold,
          outlet_inventory_id
        )
        VALUES (
          v_journal_id,
          trim(both from r.product_batch),
          r.lot_id,
          v_take,
          r.inv_id
        );

        v_lines_meta := v_lines_meta || jsonb_build_array(
          jsonb_build_object(
            'outlet_inventory_id', r.inv_id,
            'product_batch', trim(both from r.product_batch),
            'quantity_sold', v_take
          )
        );

        v_remaining := v_remaining - v_take;
      END LOOP;

      IF v_remaining > 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'fifo_line_alloc_failed', 'remaining', v_remaining, 'product_batch', v_batch);
      END IF;
    END IF;
  END LOOP;

  PERFORM public._append_data_ledger(
    'posted',
    'sales_journal',
    v_journal_id::text,
    'sales',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'business_date', p_business_date,
      'lines', v_lines_meta
    ),
    NULL,
    jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Backfill sale movements for posted journals missing any sale movement
-- (extends 058; does not duplicate when live movements already exist)
-- ---------------------------------------------------------------------------
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  sj.outlet_id,
  COALESCE(sjl.outlet_inventory_id, oi.id),
  'sale',
  -sjl.quantity_sold,
  sj.business_date,
  'sales_journal',
  sj.id,
  jsonb_build_object(
    'source', 'backfill',
    'pack', 'pack5',
    'product_batch', sjl.product_batch,
    'journal_source', COALESCE(sj.source, 'manual')
  ),
  sj.created_at
FROM public.sales_journals sj
JOIN public.sales_journal_lines sjl ON sjl.sales_journal_id = sj.id
LEFT JOIN public.outlet_inventory oi ON oi.outlet_id = sj.outlet_id
  AND sjl.outlet_inventory_id IS NULL
  AND trim(both from oi.product_batch) = trim(both from sjl.product_batch)
WHERE lower(trim(sj.status::text)) = 'posted'
  AND COALESCE(sjl.outlet_inventory_id, oi.id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'sales_journal'
      AND m.reference_id = sj.id
      AND m.movement_type = 'sale'
  );

-- ---------------------------------------------------------------------------
-- ingest_storehub_sale: posted-only idempotency; voided frees key for re-post
-- ---------------------------------------------------------------------------
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
  v_skus_seen int := 0;
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

  -- Preflight: every SKU must have enough ATP
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

    v_total_avail := 0;
    FOR r IN
      SELECT
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
      FOR UPDATE OF oi
    LOOP
      v_total_avail := v_total_avail + GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
    END LOOP;

    IF v_total_avail < v_qty THEN
      INSERT INTO public.storehub_sync_events (
        ref_id, invoice_number, event_type, status, outlet_id, error, payload, sync_run_id
      )
      VALUES (
        p_ref_id, p_invoice_number, 'fail', 'failed', p_outlet_id,
        'insufficient_stock',
        jsonb_build_object(
          'sku', v_sku, 'requested', v_qty, 'available', v_total_avail,
          'channel', p_channel, 'notes', p_notes
        ),
        p_sync_run_id
      )
      ON CONFLICT (ref_id) DO UPDATE SET
        event_type = 'fail',
        status = 'failed',
        error = 'insufficient_stock',
        payload = EXCLUDED.payload,
        outlet_id = EXCLUDED.outlet_id,
        invoice_number = EXCLUDED.invoice_number,
        sync_run_id = COALESCE(EXCLUDED.sync_run_id, public.storehub_sync_events.sync_run_id),
        updated_at = now();

      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_stock',
        'sku', v_sku,
        'requested', v_qty,
        'available', v_total_avail
      );
    END IF;
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

    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'fifo_alloc_internal_error remaining=% sku=%', v_remaining, v_sku;
    END IF;
  END LOOP;

  INSERT INTO public.storehub_sync_events (
    ref_id, invoice_number, event_type, status, sales_journal_id, outlet_id, payload, sync_run_id
  )
  VALUES (
    p_ref_id, p_invoice_number, 'sale', 'posted', v_journal_id, p_outlet_id,
    jsonb_build_object('channel', p_channel, 'lines', v_lines),
    p_sync_run_id
  )
  ON CONFLICT (ref_id) DO UPDATE SET
    event_type = 'sale',
    status = 'posted',
    sales_journal_id = EXCLUDED.sales_journal_id,
    outlet_id = EXCLUDED.outlet_id,
    invoice_number = EXCLUDED.invoice_number,
    error = NULL,
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
      'invoice', p_invoice_number
    ),
    NULL,
    jsonb_build_object('notes', p_notes, 'source', 'storehub')
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id,
    'lines', v_lines
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- void_sales_journal: admin-only (unchanged); align StoreHub sync events
-- ---------------------------------------------------------------------------
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
  v_lines_snap jsonb;
  leg_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;

  SELECT * INTO v_header FROM public.sales_journals WHERE id = p_sales_journal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_found');
  END IF;
  IF v_header.status IS DISTINCT FROM 'posted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_voidable_status');
  END IF;

  -- StoreHub-sourced voids stay admin-only (already gated above). Explicit
  -- error keeps intent clear if auth rules ever widen for manual voids.
  IF COALESCE(v_header.source, 'manual') = 'storehub' AND NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'storehub_void_admin_required');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_batch', sj.product_batch, 'quantity_sold', sj.quantity_sold, 'outlet_inventory_id', sj.outlet_inventory_id
  ) ORDER BY sj.created_at, sj.id), '[]'::jsonb)
  INTO v_lines_snap
  FROM public.sales_journal_lines sj WHERE sj.sales_journal_id = p_sales_journal_id;

  FOR r IN
    SELECT product_batch, quantity_sold, outlet_inventory_id
    FROM public.sales_journal_lines WHERE sales_journal_id = p_sales_journal_id ORDER BY created_at, id
  LOOP
    leg_id := r.outlet_inventory_id;
    IF leg_id IS NULL THEN
      SELECT oi.id INTO leg_id FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_header.outlet_id AND trim(both from oi.product_batch) = trim(both from r.product_batch)
      ORDER BY oi.created_at ASC NULLS LAST LIMIT 1;
    END IF;
    IF leg_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'outlet_stock_missing_for_reversal', 'product_batch', r.product_batch);
    END IF;

    PERFORM public._set_outlet_movement_ctx(
      v_header.outlet_id, 'reversal', v_header.business_date, 'sales_journal', p_sales_journal_id
    );

    UPDATE public.outlet_inventory oi SET
      quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
      available_quantity = (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(), updated_at = now()
    WHERE oi.id = leg_id;

    PERFORM public._clear_outlet_movement_ctx();
  END LOOP;

  UPDATE public.sales_journals SET status = 'voided', updated_at = now() WHERE id = p_sales_journal_id;

  IF COALESCE(v_header.source, 'manual') = 'storehub' AND v_header.idempotency_key IS NOT NULL THEN
    UPDATE public.storehub_sync_events
    SET
      event_type = 'cancel',
      status = 'voided',
      error = 'ui_void',
      payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('ui_void', true, 'sales_journal_id', p_sales_journal_id),
      updated_at = now()
    WHERE ref_id = v_header.idempotency_key;
  END IF;

  PERFORM public._append_data_ledger(
    'voided', 'sales_journal', p_sales_journal_id::text, 'sales', 'event', NULL,
    jsonb_build_object(
      'outlet_id', v_header.outlet_id,
      'business_date', v_header.business_date,
      'lines', v_lines_snap,
      'source', COALESCE(v_header.source, 'manual')
    ),
    NULL, NULL
  );

  RETURN jsonb_build_object('success', true, 'sales_journal_id', p_sales_journal_id);
END;
$$;

REVOKE ALL ON FUNCTION public.void_sales_journal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_sales_journal(uuid) TO authenticated;
