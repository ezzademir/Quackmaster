/*
  # Movement instrumentation: admin delete reversal, outlet waste, sales void
*/

CREATE OR REPLACE FUNCTION public.admin_delete_supply_order(p_supply_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  st text;
  v_outlet_id uuid;
  rec RECORD;
  v_rc int;
  v_oi_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_profiles_admin() THEN RAISE EXCEPTION 'Admin privileges required'; END IF;

  SELECT status, outlet_id INTO st, v_outlet_id FROM public.supply_orders WHERE id = p_supply_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supply order not found'; END IF;

  IF st = 'pending' THEN
    FOR rec IN SELECT hub_inventory_id, quantity FROM public.supply_order_lines WHERE supply_order_id = p_supply_order_id LOOP
      PERFORM public.release_inventory_reservation(rec.hub_inventory_id, rec.quantity, p_supply_order_id);
    END LOOP;
  ELSIF st = 'dispatched' THEN
    FOR rec IN SELECT hub_inventory_id, quantity FROM public.supply_order_lines WHERE supply_order_id = p_supply_order_id LOOP
      UPDATE public.hub_inventory hi SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
    END LOOP;
  ELSIF st = 'received' THEN
    FOR rec IN
      SELECT sol.hub_inventory_id, sol.quantity, sol.product_batch AS line_product_batch,
             hi.raw_material_id AS hub_raw_material_id, hi.product_batch AS hub_product_batch
      FROM public.supply_order_lines sol
      INNER JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
      WHERE sol.supply_order_id = p_supply_order_id
    LOOP
      IF rec.hub_raw_material_id IS NOT NULL THEN
        SELECT oi.id INTO v_oi_id FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id AND oi.raw_material_id = rec.hub_raw_material_id
        ORDER BY oi.updated_at DESC NULLS LAST LIMIT 1;
      ELSE
        SELECT oi.id INTO v_oi_id FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id AND oi.raw_material_id IS NULL
          AND oi.product_batch IS NOT DISTINCT FROM COALESCE(rec.line_product_batch, rec.hub_product_batch)
        ORDER BY oi.updated_at DESC NULLS LAST LIMIT 1;
      END IF;
      IF v_oi_id IS NULL THEN RAISE EXCEPTION 'Outlet inventory missing for reversal'; END IF;

      PERFORM public._set_outlet_movement_ctx(v_outlet_id, 'reversal', CURRENT_DATE, 'supply_order', p_supply_order_id);
      UPDATE public.outlet_inventory oi SET
        quantity_on_hand = GREATEST(0, oi.quantity_on_hand - rec.quantity),
        available_quantity = GREATEST(0, GREATEST(0, oi.quantity_on_hand - rec.quantity) - COALESCE(oi.reserved_quantity, 0)),
        last_updated = now(), updated_at = now()
      WHERE oi.id = v_oi_id;
      PERFORM public._clear_outlet_movement_ctx();

      UPDATE public.hub_inventory hi SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
    END LOOP;
  END IF;

  DELETE FROM public.supply_orders WHERE id = p_supply_order_id;
END;
$fn$;

-- post_waste_event: full 037 body + movement ctx on outlet UPDATE
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
      v_batch := trim(rec->>'product_batch');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      IF v_o_id IS NULL OR v_o_id <> p_outlet_id OR v_batch = '' OR v_qty IS NULL OR v_qty <= 0 OR v_reason = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_outlet_line');
      END IF;
      SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0) INTO v_qoh, v_res
      FROM public.outlet_inventory oi WHERE oi.outlet_id = p_outlet_id AND oi.product_batch = v_batch FOR UPDATE;
      IF NOT FOUND OR (v_qoh - v_res) < v_qty THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_outlet_available');
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
      v_batch := trim(rec->>'product_batch');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      INSERT INTO public.waste_lines (waste_event_id, hub_inventory_id, outlet_id, product_batch, quantity, waste_reason)
      VALUES (v_event_id, NULL, p_outlet_id, v_batch, v_qty, v_reason);
      PERFORM public._set_outlet_movement_ctx(p_outlet_id, 'waste', p_waste_date, 'waste_event', v_event_id);
      UPDATE public.outlet_inventory oi SET
        quantity_on_hand = oi.quantity_on_hand - v_qty,
        available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE oi.outlet_id = p_outlet_id AND oi.product_batch = v_batch;
      PERFORM public._clear_outlet_movement_ctx();
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

-- void_sales_journal + movement ctx on outlet restore
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

  SELECT * INTO v_header FROM public.sales_journals WHERE id = p_sales_journal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_found');
  END IF;
  IF v_header.status IS DISTINCT FROM 'posted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_voidable_status');
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

  PERFORM public._append_data_ledger(
    'voided', 'sales_journal', p_sales_journal_id::text, 'sales', 'event', NULL,
    jsonb_build_object('outlet_id', v_header.outlet_id, 'business_date', v_header.business_date, 'lines', v_lines_snap),
    NULL, NULL
  );

  RETURN jsonb_build_object('success', true, 'sales_journal_id', p_sales_journal_id);
END;
$$;
