/*
  post_waste_event validated each line against full on-hand independently.
  Staff can add two lines for the same lot (spoilage + damage). Each line
  looks valid; the deduct pass then drives quantity_on_hand negative.

  Sum requested qty per inventory row before writes. Reject the event if
  the combined quantity exceeds available. Deducts use a guarded UPDATE
  that RAISES (rolls back) if a line would still overdraw.
*/

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
  v_sum numeric;
  v_requested jsonb := '{}'::jsonb;
  v_rows integer;
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
      v_sum := COALESCE((v_requested->>v_hub_id::text)::numeric, 0) + v_qty;
      IF (v_qoh - v_res) < v_sum THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_hub_available');
      END IF;
      v_requested := v_requested || jsonb_build_object(v_hub_id::text, v_sum);
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
        v_sum := COALESCE((v_requested->>v_inv_id::text)::numeric, 0) + v_qty;
        IF (v_qoh - v_res) < v_sum THEN
          RETURN jsonb_build_object('success', false, 'error', 'insufficient_outlet_available');
        END IF;
        v_requested := v_requested || jsonb_build_object(v_inv_id::text, v_sum);
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
      WHERE hi.id = v_hub_id
        AND (hi.quantity_on_hand - COALESCE(hi.reserved_quantity, 0)) >= v_qty;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'insufficient_hub_available';
      END IF;
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
        WHERE oi.id = v_inv_id
          AND oi.outlet_id = p_outlet_id
          AND (oi.quantity_on_hand - COALESCE(oi.reserved_quantity, 0)) >= v_qty;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        PERFORM public._clear_outlet_movement_ctx();
        IF v_rows <> 1 THEN
          RAISE EXCEPTION 'insufficient_outlet_available';
        END IF;
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
          WHERE oi.id = r.id
            AND (oi.quantity_on_hand - COALESCE(oi.reserved_quantity, 0)) >= v_take;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          PERFORM public._clear_outlet_movement_ctx();
          IF v_rows <> 1 THEN
            RAISE EXCEPTION 'insufficient_outlet_available';
          END IF;
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
