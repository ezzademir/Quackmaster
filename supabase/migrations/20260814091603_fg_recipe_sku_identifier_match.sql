-- Recipe SKU via lot_id (no rewrite of BATCH-… columns or inked lot labels).
-- FIFO / sales / waste / recon match SKU, lot label, or stored product_batch.

CREATE OR REPLACE FUNCTION public.fg_recipe_sku(p_lot_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT NULLIF(trim(both from r.default_product_batch), '')
  FROM public.inventory_lots il
  JOIN public.production_runs pr ON pr.id = il.production_run_id
  JOIN public.recipes r ON r.id = pr.recipe_id
  WHERE il.id = p_lot_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.fg_identifier_matches(
  p_product_batch text,
  p_lot_label text,
  p_recipe_sku text,
  p_query text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    q <> ''
    AND (
      trim(both from coalesce(p_product_batch, '')) = q
      OR trim(both from coalesce(p_lot_label, '')) = q
      OR trim(both from coalesce(p_recipe_sku, '')) = q
    )
  FROM (SELECT trim(both from coalesce(p_query, '')) AS q) s;
$$;

CREATE OR REPLACE FUNCTION public.fg_identifier_matches(p_product_batch text, p_lot_label text, p_query text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT public.fg_identifier_matches(p_product_batch, p_lot_label, NULL::text, p_query);
$$;

REVOKE ALL ON FUNCTION public.fg_recipe_sku(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fg_identifier_matches(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fg_identifier_matches(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fg_recipe_sku(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fg_identifier_matches(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fg_identifier_matches(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Sales FIFO: SKU, lot label, or recipe SKU via lot_id
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

REVOKE ALL ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) TO authenticated;

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

REVOKE ALL ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Waste: prefer outlet_inventory_id; else FEFO via SKU/lot/recipe SKU
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_waste_event(
  p_location_kind text,
  p_outlet_id uuid,
  p_waste_date date,
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
  v_event_id uuid;
  rec jsonb;
  v_hub_id uuid;
  v_o_id uuid;
  v_batch text;
  v_qty numeric;
  v_reason text;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
  v_inv_id uuid;
  v_inv_raw text;
  v_remaining numeric;
  v_take numeric;
  v_total_avail numeric;
  r RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.waste_events WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'waste_event_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_location_kind NOT IN ('hub', 'outlet') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_location_kind');
  END IF;

  IF p_location_kind = 'outlet' AND p_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required');
  END IF;

  IF p_location_kind = 'hub' AND p_outlet_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_must_be_null_for_hub');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  IF p_location_kind = 'hub' THEN
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_hub_id := (rec->>'hub_inventory_id')::uuid;
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      IF v_hub_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_reason IS NULL OR v_reason = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_hub_line');
      END IF;
      SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0) INTO v_qoh, v_res
      FROM public.hub_inventory hi WHERE hi.id = v_hub_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_not_found');
      END IF;
      IF (v_qoh - v_res) < v_qty THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_hub_available');
      END IF;
    END LOOP;
  ELSE
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_o_id := (rec->>'outlet_id')::uuid;
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      v_inv_raw := trim(both from coalesce(rec->>'outlet_inventory_id', ''));
      v_batch := trim(both from coalesce(rec->>'product_batch', ''));
      IF v_o_id IS NULL OR v_o_id <> p_outlet_id OR v_qty IS NULL OR v_qty <= 0 OR v_reason IS NULL OR v_reason = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_outlet_line');
      END IF;
      IF v_inv_raw <> '' THEN
        v_inv_id := v_inv_raw::uuid;
        SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_qoh, v_res
        FROM public.outlet_inventory oi
        WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_not_found', 'outlet_inventory_id', v_inv_id);
        END IF;
        IF (v_qoh - v_res) < v_qty THEN
          RETURN jsonb_build_object('success', false, 'error', 'insufficient_outlet_available');
        END IF;
      ELSE
        IF v_batch = '' THEN
          RETURN jsonb_build_object('success', false, 'error', 'invalid_outlet_line');
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
          RETURN jsonb_build_object('success', false, 'error', 'insufficient_outlet_available');
        END IF;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.waste_events (location_kind, outlet_id, waste_date, status, notes, idempotency_key, created_by)
  VALUES (p_location_kind, CASE WHEN p_location_kind = 'outlet' THEN p_outlet_id ELSE NULL END,
    p_waste_date, 'posted', p_notes, p_idempotency_key, v_uid)
  RETURNING id INTO v_event_id;

  IF p_location_kind = 'hub' THEN
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_hub_id := (rec->>'hub_inventory_id')::uuid;
      v_batch := trim(rec->>'product_batch');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      INSERT INTO public.waste_lines (waste_event_id, hub_inventory_id, outlet_id, product_batch, quantity, waste_reason)
      VALUES (v_event_id, v_hub_id, NULL, v_batch, v_qty, v_reason);
      UPDATE public.hub_inventory hi SET
        quantity_on_hand = hi.quantity_on_hand - v_qty,
        available_quantity = (hi.quantity_on_hand - v_qty) - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE hi.id = v_hub_id;
    END LOOP;
  ELSE
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      v_inv_raw := trim(both from coalesce(rec->>'outlet_inventory_id', ''));
      v_batch := trim(both from coalesce(rec->>'product_batch', ''));
      IF v_inv_raw <> '' THEN
        v_inv_id := v_inv_raw::uuid;
        SELECT oi.product_batch INTO v_batch
        FROM public.outlet_inventory oi
        WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
        FOR UPDATE;
        INSERT INTO public.waste_lines (waste_event_id, hub_inventory_id, outlet_id, product_batch, quantity, waste_reason)
        VALUES (v_event_id, NULL, p_outlet_id, coalesce(v_batch, ''), v_qty, v_reason);
        PERFORM public._set_outlet_movement_ctx(p_outlet_id, 'waste', p_waste_date, 'waste_event', v_event_id);
        UPDATE public.outlet_inventory oi SET
          quantity_on_hand = oi.quantity_on_hand - v_qty,
          available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
          last_updated = now(), updated_at = now()
        WHERE oi.id = v_inv_id;
        PERFORM public._clear_outlet_movement_ctx();
      ELSE
        v_remaining := v_qty;
        FOR r IN
          SELECT
            oi.id,
            oi.product_batch,
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
          INSERT INTO public.waste_lines (waste_event_id, hub_inventory_id, outlet_id, product_batch, quantity, waste_reason)
          VALUES (v_event_id, NULL, p_outlet_id, trim(both from r.product_batch), v_take, v_reason);
          PERFORM public._set_outlet_movement_ctx(p_outlet_id, 'waste', p_waste_date, 'waste_event', v_event_id);
          UPDATE public.outlet_inventory oi SET
            quantity_on_hand = oi.quantity_on_hand - v_take,
            available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
            last_updated = now(), updated_at = now()
          WHERE oi.id = r.id;
          PERFORM public._clear_outlet_movement_ctx();
          v_remaining := v_remaining - v_take;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  PERFORM public._append_data_ledger(
    'posted', 'waste_event', v_event_id::text, 'waste', 'event', NULL, NULL,
    jsonb_build_object('location_kind', p_location_kind, 'outlet_id', p_outlet_id, 'waste_date', p_waste_date, 'lines', p_lines),
    NULL, jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object('success', true, 'waste_event_id', v_event_id);
END;
$$;

REVOKE ALL ON FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Recon: FG sku_key is recipe SKU via lot_id when present
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_outlet_stock_by_sku(
  p_outlet_id uuid,
  p_from date,
  p_to date,
  p_include_raw_materials boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb := '[]'::jsonb;
  r RECORD;
  v_opening numeric;
  v_supply_in numeric;
  v_transfers_in numeric;
  v_transfers_out numeric;
  v_sales numeric;
  v_waste numeric;
  v_stock_take numeric;
  v_reversals numeric;
  v_computed numeric;
  v_live numeric;
  v_key text;
  v_label text;
  v_kind text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  FOR r IN
    WITH keys AS (
      SELECT DISTINCT
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
          ELSE 'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        END AS sku_key,
        CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END AS kind,
        COALESCE(
          MAX(rm.name),
          MAX(NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), '')),
          MAX(
            CASE
              WHEN oi.product_batch ~* '^BATCH-[0-9a-f-]+$' THEN NULL
              ELSE NULLIF(trim(both from oi.product_batch), '')
            END
          ),
          '—'
        ) AS label,
        oi.raw_material_id,
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN NULL
          ELSE COALESCE(
            NULLIF(trim(both from MAX(public.fg_recipe_sku(oi.lot_id))), ''),
            MAX(
              CASE
                WHEN oi.product_batch ~* '^BATCH-[0-9a-f-]+$' THEN NULL
                ELSE NULLIF(trim(both from oi.product_batch), '')
              END
            )
          )
        END AS product_batch
      FROM public.outlet_inventory oi
      LEFT JOIN public.raw_materials rm ON rm.id = oi.raw_material_id
      WHERE oi.outlet_id = p_outlet_id
        AND (p_include_raw_materials OR oi.raw_material_id IS NULL)
      GROUP BY
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
          ELSE 'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        END,
        CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END,
        oi.raw_material_id
    )
    SELECT * FROM keys ORDER BY label
  LOOP
    v_key := r.sku_key;
    v_label := r.label;
    v_kind := r.kind;

    SELECT COALESCE(SUM(osm.signed_qty), 0)
    INTO v_opening
    FROM public.outlet_stock_movements osm
    JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
    WHERE osm.outlet_id = p_outlet_id
      AND osm.business_date < p_from
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT
      COALESCE(SUM(CASE WHEN osm.movement_type = 'supply_in' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_in' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_out' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'sale' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'waste' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'stock_take' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type IN ('reversal', 'admin_adjust') THEN osm.signed_qty ELSE 0 END), 0)
    INTO v_supply_in, v_transfers_in, v_transfers_out, v_sales, v_waste, v_stock_take, v_reversals
    FROM public.outlet_stock_movements osm
    JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
    WHERE osm.outlet_id = p_outlet_id
      AND osm.business_date >= p_from
      AND osm.business_date <= p_to
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
    INTO v_live
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = p_outlet_id
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    v_computed := v_opening + v_supply_in + v_transfers_in + v_transfers_out + v_sales + v_waste + v_stock_take + v_reversals;

    v_rows := v_rows || jsonb_build_array(
      jsonb_build_object(
        'sku_key', v_key,
        'kind', v_kind,
        'label', v_label,
        'raw_material_id', r.raw_material_id,
        'product_batch', r.product_batch,
        'opening_qoh', v_opening,
        'supply_in', v_supply_in,
        'transfers_in', v_transfers_in,
        'transfers_out', v_transfers_out,
        'sales', v_sales,
        'waste', v_waste,
        'stock_take_adjustments', v_stock_take,
        'reversals', v_reversals,
        'computed_closing', v_computed,
        'live_on_hand', v_live,
        'unexplained_variance', v_live - v_computed
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'outlet_id', p_outlet_id,
    'period_from', p_from,
    'period_to', p_to,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_outlet_stock_by_sku(uuid, date, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_outlet_stock_by_sku(uuid, date, date, boolean) TO authenticated;
