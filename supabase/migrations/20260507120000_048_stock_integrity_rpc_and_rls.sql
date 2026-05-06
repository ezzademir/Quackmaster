/*
  Stock integrity: FIFO batch sales, traceable lines, transactional supply receipt,
  production hub posting RPC, void sales admin-only, drop direct outlet_inventory writes.
*/

-- ---------------------------------------------------------------------------
-- Helper: non-pending staff (admin or staff)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_authenticated_active_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin', 'staff')
  );
$$;

REVOKE ALL ON FUNCTION public.is_authenticated_active_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_authenticated_active_staff() TO authenticated;

-- ---------------------------------------------------------------------------
-- sales_journal_lines: store deduction target for accurate void/reversal
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_journal_lines
  ADD COLUMN IF NOT EXISTS outlet_inventory_id uuid REFERENCES public.outlet_inventory(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_journal_lines_outlet_inv
  ON public.sales_journal_lines(outlet_inventory_id);

-- ---------------------------------------------------------------------------
-- post_sales_journal — p_lines support:
--   {"product_batch":"x","quantity_sold":1}  → FIFO across matching rows (same as SKU match rules)
--   {"outlet_inventory_id":"uuid","quantity_sold":1} → single row (batch from row)
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

  -- Pass 1: validate availability
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
        RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_missing_mid_post', 'outlet_inventory_id', v_inv_id);
      END IF;

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - v_qty,
        available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_inv_id;

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

        UPDATE public.outlet_inventory oi
        SET
          quantity_on_hand = oi.quantity_on_hand - v_take,
          available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
          last_updated = now(),
          updated_at = now()
        WHERE oi.id = r.inv_id;

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

-- ---------------------------------------------------------------------------
-- post_sales_journal_fifo_by_sku — store outlet_inventory_id + lot_id on lines
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

    UPDATE public.outlet_inventory oi
    SET
      quantity_on_hand = oi.quantity_on_hand - v_take,
      available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(),
      updated_at = now()
    WHERE oi.id = r.id;

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

-- ---------------------------------------------------------------------------
-- void_sales_journal — admin only; reverse using outlet_inventory_id when set
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
  v_rows integer;
  v_lines_snap jsonb;
  leg_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
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
          'quantity_sold', sj.quantity_sold,
          'outlet_inventory_id', sj.outlet_inventory_id
        )
        ORDER BY sj.created_at, sj.id
      ),
      '[]'::jsonb
    )
  INTO v_lines_snap
  FROM public.sales_journal_lines sj
  WHERE sj.sales_journal_id = p_sales_journal_id;

  FOR r IN
    SELECT product_batch, quantity_sold, outlet_inventory_id
    FROM public.sales_journal_lines
    WHERE sales_journal_id = p_sales_journal_id
    ORDER BY created_at, id
  LOOP
    IF r.outlet_inventory_id IS NOT NULL THEN
      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
        available_quantity =
          (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = r.outlet_inventory_id
        AND oi.outlet_id = v_header.outlet_id;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'outlet_stock_missing_for_reversal',
          'outlet_inventory_id', r.outlet_inventory_id
        );
      END IF;
    ELSE
      SELECT oi.id INTO leg_id
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_header.outlet_id
        AND trim(both from oi.product_batch) = trim(both from r.product_batch)
      ORDER BY oi.created_at ASC NULLS LAST, oi.id ASC
      LIMIT 1;

      IF leg_id IS NULL THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'outlet_stock_missing_for_reversal',
          'product_batch', r.product_batch
        );
      END IF;

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
        available_quantity =
          (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = leg_id;
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

-- ---------------------------------------------------------------------------
-- receive_supply_order — atomic outlet credit from supply_order_lines + hub row metadata
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.receive_supply_order(
  p_supply_order_id uuid,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_so RECORD;
  line RECORD;
  v_hid uuid;
  v_pb text;
  v_hlot uuid;
  v_dest uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_iso timestamptz := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT *
  INTO v_so
  FROM public.supply_orders so
  WHERE so.id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'supply_order_not_found');
  END IF;

  IF v_so.status IS DISTINCT FROM 'dispatched' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status_for_receive', 'status', v_so.status);
  END IF;

  FOR line IN
    SELECT sol.id, sol.quantity, sol.hub_inventory_id, sol.product_batch
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    SELECT hi.id, trim(both from hi.product_batch), hi.lot_id
    INTO v_hid, v_pb, v_hlot
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id;

    IF v_hid IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_missing', 'hub_inventory_id', line.hub_inventory_id);
    END IF;

    v_dest := NULL;
    v_qoh := NULL;
    v_res := NULL;

    SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
    INTO v_dest, v_qoh, v_res
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = v_so.outlet_id
      AND trim(both from oi.product_batch) = v_pb
      AND (oi.lot_id IS NOT DISTINCT FROM v_hlot)
    ORDER BY oi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_dest IS NOT NULL THEN
      v_new_qoh := v_qoh + line.quantity;
      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = v_new_qoh,
        available_quantity = v_new_qoh - v_res,
        last_updated = v_iso,
        updated_at = v_iso
      WHERE oi.id = v_dest;
    ELSE
      INSERT INTO public.outlet_inventory (
        outlet_id,
        product_batch,
        lot_id,
        quantity_on_hand,
        reserved_quantity,
        available_quantity,
        last_updated,
        updated_at
      )
      VALUES (
        v_so.outlet_id,
        v_pb,
        v_hlot,
        line.quantity,
        0,
        line.quantity,
        v_iso,
        v_iso
      );
    END IF;
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'received',
    received_date = CURRENT_DATE,
    updated_at = v_iso
  WHERE id = p_supply_order_id;

  PERFORM public._append_data_ledger(
    'received',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'event',
    NULL,
    jsonb_build_object(
      'outlet_id', v_so.outlet_id,
      'received_date', CURRENT_DATE,
      'idempotency_key', p_idempotency_key
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_supply_order(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_supply_order(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- post_production_completion_inventory — finished goods + material consumption (atomic)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_production_completion_inventory(
  p_production_run_id uuid,
  p_product_batch text,
  p_finished_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  pr RECORD;
  mat RECORD;
  v_hub_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_avail numeric;
  v_batch text := trim(both from p_product_batch);
  v_out_id uuid;
  v_iso timestamptz := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF v_batch IS NULL OR v_batch = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'product_batch_required');
  END IF;

  IF p_finished_quantity IS NULL OR p_finished_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_finished_quantity');
  END IF;

  SELECT *
  INTO pr
  FROM public.production_runs
  WHERE id = p_production_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'production_run_not_found');
  END IF;

  IF pr.status IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_run_status', 'status', pr.status);
  END IF;

  IF p_finished_quantity > 0 THEN
    INSERT INTO public.hub_inventory (
      product_batch,
      quantity_on_hand,
      reserved_quantity,
      available_quantity,
      last_updated,
      updated_at
    )
    VALUES (
      v_batch,
      p_finished_quantity,
      0,
      p_finished_quantity,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_out_id;
  END IF;

  FOR mat IN
    SELECT prm.raw_material_id, prm.quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
  LOOP
    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF v_hub_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'raw_material_hub_row_missing',
        'raw_material_id', mat.raw_material_id
      );
    END IF;

    IF v_qoh < mat.quantity_consumed THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_raw_material',
        'raw_material_id', mat.raw_material_id,
        'on_hand', v_qoh,
        'required', mat.quantity_consumed
      );
    END IF;

    v_new_qoh := v_qoh - mat.quantity_consumed;
    v_new_avail := v_new_qoh - v_res;

    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = v_new_qoh,
      available_quantity = v_new_avail,
      last_updated = v_iso,
      updated_at = v_iso
    WHERE hi.id = v_hub_id;
  END LOOP;

  UPDATE public.production_runs
  SET
    status = 'completed',
    updated_at = v_iso
  WHERE id = p_production_run_id;

  PERFORM public._append_data_ledger(
    'inventory_posted',
    'production_run',
    p_production_run_id::text,
    'production',
    'event',
    NULL,
    jsonb_build_object(
      'hub_inventory_id', v_out_id,
      'product_batch', v_batch,
      'finished_quantity', p_finished_quantity
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'success', true,
    'production_run_id', p_production_run_id,
    'hub_inventory_id', v_out_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS: no direct client writes to outlet_inventory (use RPCs only)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can insert outlet inventory" ON public.outlet_inventory;
DROP POLICY IF EXISTS "Authenticated users can update outlet inventory" ON public.outlet_inventory;
