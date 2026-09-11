/*
  P0 RG-01 / RG-02: sales journal atomic abort + outlet transfer RLS lockdown.

  RG-01: Soft RETURN success:false AFTER sales_journals / stock writes still COMMITS
  under PostgREST. Mirror pack2 (063): validate-all-first soft returns stay; after any
  journal/stock write begins, RAISE EXCEPTION so the transaction aborts.

  RG-02: Drop open WITH CHECK (true) write policies on outlet_transfers /
  outlet_transfer_lines. Clients write only via SECURITY DEFINER RPCs. Harden those
  RPCs to active staff/admin (pending cannot write). SELECT policies unchanged.
*/

-- ---------------------------------------------------------------------------
-- RG-01: post_sales_journal_fifo_by_sku (abort mid-alloc)
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
    RAISE EXCEPTION 'fifo_alloc_internal_error'
      USING ERRCODE = 'P0001',
            DETAIL = format('remaining %s', v_remaining);
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
-- RG-01: post_sales_journal (abort mid-post)
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
        RAISE EXCEPTION 'outlet_inventory_row_missing_mid_post'
          USING ERRCODE = 'P0001',
                DETAIL = v_inv_id::text;
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
        RAISE EXCEPTION 'fifo_line_alloc_failed'
          USING ERRCODE = 'P0001',
                DETAIL = format('remaining %s batch %s', v_remaining, v_batch);
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
-- RG-01 sibling: void_sales_journal (abort if stock missing mid-reversal)
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
      RAISE EXCEPTION 'outlet_stock_missing_for_reversal'
        USING ERRCODE = 'P0001',
              DETAIL = r.product_batch;
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

-- ---------------------------------------------------------------------------
-- RG-02: outlet_transfers / outlet_transfer_lines RLS lockdown
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can delete outlet_transfers" ON public.outlet_transfers;

DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can delete outlet_transfer_lines" ON public.outlet_transfer_lines;

-- No INSERT/UPDATE/DELETE policies: table writes go through SECURITY DEFINER RPCs.
-- Keep SELECT for authenticated viewers (unchanged from 046).

-- ---------------------------------------------------------------------------
-- RG-02: transfer RPCs — active staff/admin only (pending blocked)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_outlet_transfer(
  p_from_outlet_id uuid,
  p_lines jsonb,
  p_notes text,
  p_to_outlet_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer_id uuid;
  v_num text;
  v_total numeric := 0;
  rec jsonb;
  v_i integer;
  v_oid uuid;
  v_iid uuid;
  v_qty numeric;
  v_batch text;
  v_lot uuid;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_from_outlet_id IS NULL OR p_to_outlet_id IS NULL OR p_from_outlet_id = p_to_outlet_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_outlets');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  FOR v_i IN 0 .. (jsonb_array_length(p_lines) - 1) LOOP
    rec := p_lines->v_i;
    v_iid := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_qty := NULLIF(rec->>'quantity', '')::numeric;
    IF v_iid IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;
    v_total := v_total + v_qty;
  END LOOP;

  v_num := 'OT-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.outlet_transfers (
    transfer_number, from_outlet_id, to_outlet_id, status, total_quantity, notes
  )
  VALUES (
    v_num,
    p_from_outlet_id,
    p_to_outlet_id,
    'pending',
    v_total,
    NULLIF(trim(both from p_notes), '')
  )
  RETURNING id INTO v_transfer_id;

  FOR v_i IN 0 .. (jsonb_array_length(p_lines) - 1) LOOP
    rec := p_lines->v_i;
    v_iid := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_qty := (rec->>'quantity')::numeric;

    SELECT outlet_id, trim(both from product_batch), lot_id, quantity_on_hand, COALESCE(reserved_quantity, 0)
    INTO v_oid, v_batch, v_lot, v_qoh, v_res
    FROM public.outlet_inventory
    WHERE id = v_iid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'outlet_inventory_not_found' USING ERRCODE = 'P0001';
    END IF;

    IF v_oid <> p_from_outlet_id THEN
      RAISE EXCEPTION 'inventory_wrong_outlet' USING ERRCODE = 'P0001';
    END IF;

    v_avail := v_qoh - v_res;
    IF v_avail < v_qty THEN
      RAISE EXCEPTION 'insufficient_available:%:%', v_avail::text, v_qty::text USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.outlet_transfer_lines (
      outlet_transfer_id, source_outlet_inventory_id, product_batch, quantity, lot_id
    )
    VALUES (v_transfer_id, v_iid, v_batch, v_qty, v_lot);

    UPDATE public.outlet_inventory
    SET
      reserved_quantity = v_res + v_qty,
      available_quantity = v_qoh - (v_res + v_qty),
      last_updated = now(),
      updated_at = now()
    WHERE id = v_iid;
  END LOOP;

  UPDATE public.outlet_transfers SET updated_at = now() WHERE id = v_transfer_id;

  PERFORM public._append_data_ledger(
    'created',
    'outlet_transfer',
    v_transfer_id::text,
    'distribution',
    'event',
    NULL,
    NULL,
    jsonb_build_object('transfer_number', v_num, 'from_outlet_id', p_from_outlet_id, 'to_outlet_id', p_to_outlet_id, 'lines', p_lines),
    NULL,
    NULL
  );

  RETURN jsonb_build_object('success', true, 'outlet_transfer_id', v_transfer_id, 'transfer_number', v_num);
END;
$$;

REVOKE ALL ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.dispatch_outlet_transfer(p_transfer_id uuid)
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
  v_new_qoh numeric;
  v_new_res numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT * INTO v_hdr FROM public.outlet_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transfer_not_found');
  END IF;

  IF v_hdr.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'status', v_hdr.status);
  END IF;

  FOR v_ln IN
    SELECT otl.* FROM public.outlet_transfer_lines otl WHERE otl.outlet_transfer_id = p_transfer_id ORDER BY otl.id
  LOOP
    SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.outlet_inventory WHERE id = v_ln.source_outlet_inventory_id FOR UPDATE;

    IF NOT FOUND OR v_res < v_ln.quantity OR v_qoh < v_ln.quantity THEN
      RAISE EXCEPTION 'cannot_fulfill_reserved' USING ERRCODE = 'P0001';
    END IF;

    PERFORM public._set_outlet_movement_ctx(
      v_hdr.from_outlet_id, 'transfer_out', CURRENT_DATE, 'outlet_transfer', p_transfer_id
    );

    v_new_qoh := v_qoh - v_ln.quantity;
    v_new_res := v_res - v_ln.quantity;

    UPDATE public.outlet_inventory
    SET quantity_on_hand = v_new_qoh, reserved_quantity = v_new_res,
        available_quantity = v_new_qoh - v_new_res, last_updated = now(), updated_at = now()
    WHERE id = v_ln.source_outlet_inventory_id;

    PERFORM public._clear_outlet_movement_ctx();
  END LOOP;

  UPDATE public.outlet_transfers
  SET status = 'dispatched', dispatch_date = CURRENT_DATE, updated_at = now()
  WHERE id = p_transfer_id;

  PERFORM public._append_data_ledger(
    'dispatched', 'outlet_transfer', p_transfer_id::text, 'distribution', 'event',
    NULL, NULL, jsonb_build_object('transfer_number', v_hdr.transfer_number), NULL, NULL
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_outlet_transfer(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.receive_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hdr public.outlet_transfers%ROWTYPE;
  v_ln RECORD;
  v_dest uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_to uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT * INTO v_hdr FROM public.outlet_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transfer_not_found');
  END IF;

  IF v_hdr.status <> 'dispatched' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'status', v_hdr.status);
  END IF;

  v_to := v_hdr.to_outlet_id;

  FOR v_ln IN
    SELECT otl.* FROM public.outlet_transfer_lines otl WHERE otl.outlet_transfer_id = p_transfer_id ORDER BY otl.id
  LOOP
    PERFORM public._set_outlet_movement_ctx(
      v_to, 'transfer_in', CURRENT_DATE, 'outlet_transfer', p_transfer_id
    );

    v_dest := NULL;
    SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
    INTO v_dest, v_qoh, v_res
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = v_to
      AND trim(both from oi.product_batch) = trim(both from v_ln.product_batch)
      AND (oi.lot_id IS NOT DISTINCT FROM v_ln.lot_id)
    ORDER BY oi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_dest IS NOT NULL THEN
      v_new_qoh := v_qoh + v_ln.quantity;
      UPDATE public.outlet_inventory
      SET quantity_on_hand = v_new_qoh, available_quantity = v_new_qoh - v_res,
          last_updated = now(), updated_at = now()
      WHERE id = v_dest;
    ELSE
      INSERT INTO public.outlet_inventory (
        outlet_id, product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity,
        last_updated, updated_at
      )
      VALUES (
        v_to, trim(both from v_ln.product_batch), v_ln.lot_id, v_ln.quantity, 0, v_ln.quantity, now(), now()
      );
    END IF;

    PERFORM public._clear_outlet_movement_ctx();
  END LOOP;

  UPDATE public.outlet_transfers
  SET status = 'received', received_date = CURRENT_DATE, updated_at = now()
  WHERE id = p_transfer_id;

  PERFORM public._append_data_ledger(
    'received', 'outlet_transfer', p_transfer_id::text, 'distribution', 'event',
    NULL, NULL, jsonb_build_object('transfer_number', v_hdr.transfer_number, 'to_outlet_id', v_to), NULL, NULL
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_outlet_transfer(uuid) TO authenticated;

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
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
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

      UPDATE public.outlet_inventory
      SET
        quantity_on_hand = v_qoh + v_ln.quantity,
        available_quantity = (v_qoh + v_ln.quantity) - v_res,
        last_updated = now(),
        updated_at = now()
      WHERE id = v_ln.source_outlet_inventory_id;
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

REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;

