-- Rollback for 079. Restores the live (pre-079) bodies captured from production on 19 Oct 2026.
-- Safe to run alone; 078 columns can stay (nullable). Dispatched orders keep their re-picked lines,
-- which remain consistent with hub/outlet stock.

CREATE OR REPLACE FUNCTION public.dispatch_supply_order(p_supply_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.supply_orders%ROWTYPE;
  v_ln RECORD;
  v_dispatch_date date;
  v_updated int;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT * INTO v_order
  FROM public.supply_orders
  WHERE id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  IF lower(trim(both from v_order.status)) <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_status',
      'status', v_order.status
    );
  END IF;

  v_dispatch_date := (timezone('Asia/Kuala_Lumpur', now()))::date;

  FOR v_ln IN
    SELECT sol.hub_inventory_id, sol.quantity
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    -- RAISE from fulfill aborts the whole transaction (no partial ship)
    PERFORM public.fulfill_inventory_reservation(
      v_ln.hub_inventory_id,
      v_ln.quantity,
      p_supply_order_id
    );
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'dispatched',
    dispatch_date = v_dispatch_date,
    updated_at = now()
  WHERE id = p_supply_order_id
    AND lower(trim(both from status)) = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'dispatch_status_race';
  END IF;

  PERFORM public._append_data_ledger(
    'dispatched',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'update',
    NULL,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'dispatched', 'dispatch_date', v_dispatch_date),
    NULL,
    jsonb_build_object('entity_label', 'Supply order dispatched')
  );

  RETURN jsonb_build_object('success', true, 'dispatch_date', v_dispatch_date);
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_waste_event(p_location_kind text, p_outlet_id uuid, p_waste_date date, p_lines jsonb, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF p_location_kind = 'hub' THEN
    IF NOT public.is_authenticated_active_staff() THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
    END IF;
  ELSIF NOT (
    public.is_authenticated_active_staff()
    OR public.is_supervisor_for_outlet(p_outlet_id)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
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
$function$;

CREATE OR REPLACE FUNCTION public.post_outlet_stock_take(p_outlet_id uuid, p_count_date date, p_notes text, p_lines jsonb, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_session_id uuid;
  rec jsonb;
  v_oi_id uuid;
  v_counted numeric;
  v_remark text;
  v_qoh numeric;
  v_res numeric;
  v_sys numeric;
  v_var numeric;
  v_lines_out jsonb := '[]'::jsonb;
  v_existing uuid;
  seen_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_uid IS NULL OR NOT public.profile_can_post_outlet_stock_take(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.outlet_stock_take_sessions WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'session_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_outlet_id IS NULL OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_input');
  END IF;

  INSERT INTO public.outlet_stock_take_sessions (outlet_id, count_date, notes, idempotency_key, created_by)
  VALUES (p_outlet_id, COALESCE(p_count_date, CURRENT_DATE), NULLIF(trim(both from p_notes), ''), p_idempotency_key, v_uid)
  RETURNING id INTO v_session_id;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_counted := NULLIF(rec->>'counted_qty', '')::numeric;
    v_remark := NULLIF(trim(both from rec->>'line_remark'), '');

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
    INTO v_qoh, v_res FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id AND oi.outlet_id = p_outlet_id FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_not_found');
    END IF;

    v_sys := v_qoh;
    v_var := v_counted - v_sys;

    PERFORM public._set_outlet_movement_ctx(
      p_outlet_id, 'stock_take', COALESCE(p_count_date, CURRENT_DATE), 'outlet_stock_take', v_session_id
    );

    UPDATE public.outlet_inventory oi
    SET quantity_on_hand = v_counted, available_quantity = v_counted - v_res,
        last_updated = now(), updated_at = now()
    WHERE oi.id = v_oi_id;

    PERFORM public._clear_outlet_movement_ctx();

    INSERT INTO public.outlet_stock_take_lines (session_id, outlet_inventory_id, system_qoh_before, counted_qty, variance, line_remark)
    VALUES (v_session_id, v_oi_id, v_sys, v_counted, v_var, v_remark);

    v_lines_out := v_lines_out || jsonb_build_array(
      jsonb_build_object('outlet_inventory_id', v_oi_id, 'system_qoh_before', v_sys, 'counted_qty', v_counted, 'variance', v_var)
    );
  END LOOP;

  PERFORM public._append_data_ledger(
    'posted', 'outlet_stock_take', v_session_id::text, 'inventory', 'event', NULL, NULL,
    jsonb_build_object('outlet_id', p_outlet_id, 'count_date', COALESCE(p_count_date, CURRENT_DATE), 'lines', v_lines_out),
    NULL, jsonb_build_object('notes', p_notes)
  );

  PERFORM public._post_stock_take_snapshot_hook(p_outlet_id, COALESCE(p_count_date, CURRENT_DATE));

  RETURN jsonb_build_object('success', true, 'session_id', v_session_id, 'lines', v_lines_out);
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_sales_journal(p_outlet_id uuid, p_business_date date, p_lines jsonb, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

DROP FUNCTION IF EXISTS public.fg_lot_run_seq(uuid);
