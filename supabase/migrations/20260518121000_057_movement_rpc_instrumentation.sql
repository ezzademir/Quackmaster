/*
  # Instrument outlet_inventory mutating RPCs with movement context
*/

-- receive_supply_order (from 052 + movement ctx)
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
  v_rm uuid;
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
    SELECT sol.id, sol.quantity, sol.hub_inventory_id
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    SELECT hi.id, hi.raw_material_id, hi.product_batch, hi.lot_id
    INTO v_hid, v_rm, v_pb, v_hlot
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id;

    IF v_hid IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'hub_inventory_missing',
        'hub_inventory_id', line.hub_inventory_id
      );
    END IF;

    PERFORM public._set_outlet_movement_ctx(
      v_so.outlet_id, 'supply_in', CURRENT_DATE, 'supply_order', p_supply_order_id
    );

    v_dest := NULL;
    v_qoh := NULL;
    v_res := NULL;

    IF v_rm IS NOT NULL THEN
      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id AND oi.raw_material_id = v_rm
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET quantity_on_hand = v_new_qoh, available_quantity = v_new_qoh - v_res,
            last_updated = v_iso, updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id, raw_material_id, product_batch, lot_id,
          quantity_on_hand, reserved_quantity, available_quantity, last_updated, updated_at
        )
        VALUES (
          v_so.outlet_id, v_rm, NULL, NULL,
          line.quantity, 0, line.quantity, v_iso, v_iso
        );
      END IF;
    ELSE
      v_pb := trim(both from COALESCE(v_pb::text, ''));
      IF v_pb = '' THEN
        RETURN jsonb_build_object(
          'success', false, 'error', 'hub_inventory_invalid_fg',
          'hub_inventory_id', line.hub_inventory_id
        );
      END IF;

      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id AND oi.raw_material_id IS NULL
        AND trim(both from oi.product_batch) = v_pb
        AND (oi.lot_id IS NOT DISTINCT FROM v_hlot)
      ORDER BY oi.created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET quantity_on_hand = v_new_qoh, available_quantity = v_new_qoh - v_res,
            last_updated = v_iso, updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id, raw_material_id, product_batch, lot_id,
          quantity_on_hand, reserved_quantity, available_quantity, last_updated, updated_at
        )
        VALUES (
          v_so.outlet_id, NULL, v_pb, v_hlot,
          line.quantity, 0, line.quantity, v_iso, v_iso
        );
      END IF;
    END IF;

    PERFORM public._clear_outlet_movement_ctx();
  END LOOP;

  UPDATE public.supply_orders
  SET status = 'received', received_date = CURRENT_DATE, updated_at = v_iso
  WHERE id = p_supply_order_id;

  PERFORM public._append_data_ledger(
    'received', 'supply_order', p_supply_order_id::text, 'distribution', 'event',
    NULL,
    jsonb_build_object('outlet_id', v_so.outlet_id, 'received_date', CURRENT_DATE, 'idempotency_key', p_idempotency_key),
    NULL, NULL
  );

  RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id);
END;
$$;

-- dispatch_outlet_transfer + movement ctx
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
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
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

-- receive_outlet_transfer + movement ctx
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
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
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

-- post_outlet_stock_take + movement ctx (from 051)
CREATE OR REPLACE FUNCTION public.post_outlet_stock_take(
  p_outlet_id uuid,
  p_count_date date,
  p_notes text,
  p_lines jsonb,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;
