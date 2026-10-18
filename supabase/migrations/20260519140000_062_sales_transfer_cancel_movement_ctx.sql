/*
  # Record outlet_stock_movements for sales posts and dispatched-transfer cancels

  Migrations 057 / 057b instrumented receive/transfer/waste/void/stock-take, but
  post_sales_journal and post_sales_journal_fifo_by_sku still update
  outlet_inventory.quantity_on_hand without app.outlet_movement_ctx. The trigger
  then silently skips the row, so every new sale is missing from the movement
  ledger. Reconciliation treats that gap as unexplained shrinkage.

  cancel_outlet_transfer (dispatched) restores source QoH without a reversal
  movement, leaving a dangling transfer_out.

  Also RAISE after any write so PostgREST cannot commit a partial sale.
*/

-- ---------------------------------------------------------------------------
-- post_sales_journal + movement ctx
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
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
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
          AND (
            (oi.lot_id IS NOT NULL AND il.product_batch_label = v_batch)
            OR (oi.lot_id IS NULL AND trim(both from oi.product_batch) = v_batch)
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
        RAISE EXCEPTION 'outlet_inventory_row_missing_mid_post' USING ERRCODE = 'P0001';
      END IF;

      PERFORM public._set_outlet_movement_ctx(
        p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id
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
          AND (
            (oi.lot_id IS NOT NULL AND il.product_batch_label = v_batch)
            OR (oi.lot_id IS NULL AND trim(both from oi.product_batch) = v_batch)
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
          p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id
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
        RAISE EXCEPTION 'fifo_line_alloc_failed' USING ERRCODE = 'P0001';
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

-- ---------------------------------------------------------------------------
-- post_sales_journal_fifo_by_sku + movement ctx
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
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
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
      AND (
        (oi.lot_id IS NOT NULL AND il.product_batch_label = v_sku)
        OR (oi.lot_id IS NULL AND trim(both from oi.product_batch) = v_sku)
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
      AND (
        (oi.lot_id IS NOT NULL AND il.product_batch_label = v_sku)
        OR (oi.lot_id IS NULL AND trim(both from oi.product_batch) = v_sku)
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
      p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id
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
    RAISE EXCEPTION 'fifo_alloc_internal_error' USING ERRCODE = 'P0001';
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

-- ---------------------------------------------------------------------------
-- cancel_outlet_transfer: record reversal when restoring dispatched QoH
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hdr public.outlet_transfers%ROWTYPE;
  v_ln RECORD;
  v_qoh numeric;
  v_res numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_hdr FROM public.outlet_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transfer_not_found');
  END IF;

  IF v_hdr.status = 'received' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot_cancel_received');
  END IF;

  IF v_hdr.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_cancelled');
  END IF;

  IF v_hdr.status = 'pending' THEN
    FOR v_ln IN
      SELECT otl.* FROM public.outlet_transfer_lines otl WHERE otl.outlet_transfer_id = p_transfer_id
      ORDER BY otl.id
    LOOP
      SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
      INTO v_qoh, v_res
      FROM public.outlet_inventory
      WHERE id = v_ln.source_outlet_inventory_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'source_inventory_missing' USING ERRCODE = 'P0001';
      END IF;

      IF v_res < v_ln.quantity THEN
        RAISE EXCEPTION 'reservation_mismatch' USING ERRCODE = 'P0001';
      END IF;

      UPDATE public.outlet_inventory
      SET
        reserved_quantity = v_res - v_ln.quantity,
        available_quantity = v_qoh - (v_res - v_ln.quantity),
        last_updated = now(),
        updated_at = now()
      WHERE id = v_ln.source_outlet_inventory_id;
    END LOOP;

  ELSIF v_hdr.status = 'dispatched' THEN
    FOR v_ln IN
      SELECT otl.* FROM public.outlet_transfer_lines otl WHERE otl.outlet_transfer_id = p_transfer_id
      ORDER BY otl.id
    LOOP
      SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
      INTO v_qoh, v_res
      FROM public.outlet_inventory
      WHERE id = v_ln.source_outlet_inventory_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'source_inventory_missing' USING ERRCODE = 'P0001';
      END IF;

      PERFORM public._set_outlet_movement_ctx(
        v_hdr.from_outlet_id, 'reversal', CURRENT_DATE, 'outlet_transfer', p_transfer_id
      );
      UPDATE public.outlet_inventory
      SET
        quantity_on_hand = v_qoh + v_ln.quantity,
        available_quantity = (v_qoh + v_ln.quantity) - v_res,
        last_updated = now(),
        updated_at = now()
      WHERE id = v_ln.source_outlet_inventory_id;
      PERFORM public._clear_outlet_movement_ctx();
    END LOOP;
  END IF;

  UPDATE public.outlet_transfers
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_transfer_id;

  PERFORM public._append_data_ledger(
    'cancelled',
    'outlet_transfer',
    p_transfer_id::text,
    'distribution',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'transfer_number', v_hdr.transfer_number,
      'prior_status', v_hdr.status
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Backfill sale movements posted after 058 (trigger skipped them)
-- ---------------------------------------------------------------------------
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  sj.outlet_id,
  sjl.outlet_inventory_id,
  'sale',
  -sjl.quantity_sold,
  sj.business_date,
  'sales_journal',
  sj.id,
  jsonb_build_object('source', 'backfill_061', 'product_batch', sjl.product_batch),
  sj.created_at
FROM public.sales_journals sj
JOIN public.sales_journal_lines sjl ON sjl.sales_journal_id = sj.id
WHERE lower(trim(sj.status::text)) IN ('posted', 'voided')
  AND sjl.outlet_inventory_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'sales_journal'
      AND m.reference_id = sj.id
      AND m.movement_type = 'sale'
      AND m.outlet_inventory_id = sjl.outlet_inventory_id
  );

-- Cancelled-after-dispatch: restore movements when transfer_out exists but no reversal
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  ot.from_outlet_id,
  otl.source_outlet_inventory_id,
  'reversal',
  otl.quantity,
  COALESCE(ot.updated_at::date, ot.dispatch_date, ot.created_at::date),
  'outlet_transfer',
  ot.id,
  jsonb_build_object('source', 'backfill_061', 'prior_status', 'dispatched'),
  COALESCE(ot.updated_at, ot.created_at)
FROM public.outlet_transfers ot
JOIN public.outlet_transfer_lines otl ON otl.outlet_transfer_id = ot.id
WHERE lower(trim(ot.status::text)) = 'cancelled'
  AND EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'outlet_transfer'
      AND m.reference_id = ot.id
      AND m.movement_type = 'transfer_out'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'outlet_transfer'
      AND m.reference_id = ot.id
      AND m.movement_type = 'reversal'
      AND m.outlet_inventory_id = otl.source_outlet_inventory_id
  );
