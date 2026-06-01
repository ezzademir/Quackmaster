/*
  Fix high-impact inventory mutation bugs:

  - SECURITY DEFINER inventory RPCs must enforce role policy themselves; GRANT EXECUTE
    to authenticated is not enough because direct RPC calls bypass UI role gates.
  - Pending users must not regain outlet_inventory visibility through the
    supervisor split policy.
  - Deleting a received supply order must fail if the outlet no longer has the
    received stock available to reverse. Clamping to zero creates phantom hub stock.
*/

-- ---------------------------------------------------------------------------
-- Procurement RPCs: enforce server-side role gates.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.receive_po_shipment(p_po_id uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec jsonb;
  v_item_id uuid;
  v_target_rcv numeric;
  v_old_rcv numeric;
  v_ordered numeric;
  v_delta numeric;
  v_rm uuid;
  v_price numeric;
  v_po_check uuid;
  v_hub_tot_before numeric;
  v_old_avg numeric;
  v_new_avg numeric;
  v_hub_tot_after numeric;
  v_hub_row uuid;
  v_qoh numeric;
  v_res numeric;
  v_ordered_total numeric := 0;
  v_received_total numeric := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_item_id := (rec->>'purchase_order_item_id')::uuid;
    v_target_rcv := (rec->>'quantity_received')::numeric;

    IF v_target_rcv IS NULL OR v_target_rcv < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity_received');
    END IF;

    SELECT
      poi.quantity_ordered,
      poi.quantity_received,
      poi.raw_material_id,
      poi.unit_price,
      poi.purchase_order_id
    INTO v_ordered, v_old_rcv, v_rm, v_price, v_po_check
    FROM public.purchase_order_items poi
    WHERE poi.id = v_item_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_item_not_found');
    END IF;

    IF v_po_check <> p_po_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_mismatch');
    END IF;

    IF v_target_rcv > v_ordered THEN
      RETURN jsonb_build_object('success', false, 'error', 'received_exceeds_ordered', 'item_id', v_item_id);
    END IF;

    v_delta := v_target_rcv - COALESCE(v_old_rcv, 0);

    UPDATE public.purchase_order_items
    SET
      quantity_received = v_target_rcv,
      line_total = v_target_rcv * COALESCE(v_price, 0)
    WHERE id = v_item_id;

    IF v_delta <> 0 AND v_rm IS NOT NULL THEN
      IF v_delta > 0 THEN
        SELECT COALESCE(SUM(hi.quantity_on_hand), 0)
        INTO v_hub_tot_before
        FROM public.hub_inventory hi
        WHERE hi.raw_material_id = v_rm;

        SELECT COALESCE(r.weighted_avg_unit_cost, r.cost_price, 0)
        INTO v_old_avg
        FROM public.raw_materials r
        WHERE r.id = v_rm
        FOR UPDATE;

        v_hub_tot_after := v_hub_tot_before + v_delta;

        IF v_hub_tot_after <= 0 THEN
          v_new_avg := v_old_avg;
        ELSIF v_hub_tot_before <= 0 THEN
          v_new_avg := COALESCE(v_price, 0);
        ELSE
          v_new_avg :=
            (v_hub_tot_before * v_old_avg + v_delta * COALESCE(v_price, 0))
            / NULLIF(v_hub_tot_after, 0);
        END IF;

        UPDATE public.raw_materials
        SET
          weighted_avg_unit_cost = COALESCE(v_new_avg, 0),
          cost_price = COALESCE(v_new_avg, cost_price),
          updated_at = now()
        WHERE id = v_rm;
      END IF;

      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
      INTO v_hub_row, v_qoh, v_res
      FROM public.hub_inventory hi
      WHERE hi.raw_material_id = v_rm
      ORDER BY hi.created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_hub_row IS NULL THEN
        IF v_delta <= 0 THEN
          RETURN jsonb_build_object('success', false, 'error', 'cannot_reduce_missing_hub_row');
        END IF;
        INSERT INTO public.hub_inventory (
          raw_material_id,
          quantity_on_hand,
          reserved_quantity,
          available_quantity,
          last_updated,
          updated_at
        )
        VALUES (
          v_rm,
          v_delta,
          0,
          v_delta,
          now(),
          now()
        );
      ELSE
        IF v_qoh + v_delta < v_res THEN
          RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved');
        END IF;

        UPDATE public.hub_inventory hi
        SET
          quantity_on_hand = hi.quantity_on_hand + v_delta,
          available_quantity = (hi.quantity_on_hand + v_delta) - COALESCE(hi.reserved_quantity, 0),
          last_updated = now(),
          updated_at = now()
        WHERE hi.id = v_hub_row;
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(poi.quantity_ordered), 0), COALESCE(SUM(poi.quantity_received), 0)
  INTO v_ordered_total, v_received_total
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = p_po_id;

  UPDATE public.purchase_orders po
  SET
    status = CASE
      WHEN v_received_total <= 0 THEN po.status
      WHEN v_received_total < v_ordered_total THEN 'partial'
      ELSE 'received'
    END,
    actual_delivery_date = CASE
      WHEN v_received_total >= v_ordered_total AND v_ordered_total > 0 THEN CURRENT_DATE
      ELSE po.actual_delivery_date
    END,
    updated_at = now()
  WHERE po.id = p_po_id;

  PERFORM public._append_data_ledger(
    'received',
    'purchase_order',
    p_po_id::text,
    'procurement',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'ordered_total', v_ordered_total,
      'received_total', v_received_total,
      'lines', p_lines
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'success', true,
    'ordered_total', v_ordered_total,
    'received_total', v_received_total,
    'status',
    CASE
      WHEN v_received_total <= 0 THEN 'unchanged'
      WHEN v_received_total < v_ordered_total THEN 'partial'
      ELSE 'received'
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.receive_po_shipment(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_po_shipment(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_item RECORD;
  v_rcv numeric;
  v_rm uuid;
  v_price numeric;
  v_q_sum numeric;
  v_avg numeric;
  v_cost_price numeric;
  v_hub_row uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_avg numeric;
  v_lines jsonb := '[]'::jsonb;
  v_before jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;

  IF p_po_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_po_id');
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_found');
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', poi.id,
        'raw_material_id', poi.raw_material_id,
        'quantity_ordered', poi.quantity_ordered,
        'quantity_received', COALESCE(poi.quantity_received, 0),
        'unit_price', COALESCE(poi.unit_price, 0)
      )
      ORDER BY poi.id
    ),
    '[]'::jsonb
  )
  INTO v_before
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = p_po_id;

  FOR v_item IN
    SELECT poi.id, poi.raw_material_id, COALESCE(poi.quantity_received, 0) AS qty_rcv, COALESCE(poi.unit_price, 0) AS unit_p
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = p_po_id
      AND COALESCE(poi.quantity_received, 0) > 0
    ORDER BY poi.id DESC
  LOOP
    v_rcv := v_item.qty_rcv;
    v_rm := v_item.raw_material_id;
    v_price := v_item.unit_p;

    IF v_rm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_raw_material', 'item_id', v_item.id);
    END IF;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_rm
    ORDER BY hi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_hub_row IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'cannot_cancel_missing_hub_row', 'raw_material_id', v_rm);
    END IF;

    IF v_qoh < v_rcv THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_hub_quantity',
        'raw_material_id', v_rm,
        'on_hand', v_qoh,
        'required_return', v_rcv
      );
    END IF;

    IF (v_qoh - v_rcv) < v_res THEN
      RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved', 'raw_material_id', v_rm);
    END IF;

    SELECT COALESCE(SUM(hi.quantity_on_hand), 0)
    INTO v_q_sum
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_rm;

    SELECT COALESCE(r.weighted_avg_unit_cost, 0), COALESCE(r.cost_price, 0)
    INTO v_avg, v_cost_price
    FROM public.raw_materials r
    WHERE r.id = v_rm
    FOR UPDATE;

    IF v_q_sum <= 0 THEN
      v_new_avg := v_avg;
    ELSIF (v_q_sum - v_rcv) <= 0 THEN
      v_new_avg := COALESCE(NULLIF(v_cost_price, 0), v_avg, v_price);
    ELSE
      v_new_avg :=
        (v_avg * v_q_sum - v_rcv * v_price)
        / NULLIF(v_q_sum - v_rcv, 0);
      IF v_new_avg IS NULL OR v_new_avg < 0 THEN
        v_new_avg := COALESCE(v_cost_price, 0);
      END IF;
    END IF;

    UPDATE public.raw_materials r
    SET
      weighted_avg_unit_cost = COALESCE(v_new_avg, 0),
      cost_price = COALESCE(v_new_avg, cost_price),
      updated_at = now()
    WHERE r.id = v_rm;

    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = hi.quantity_on_hand - v_rcv,
      available_quantity = (hi.quantity_on_hand - v_rcv) - COALESCE(hi.reserved_quantity, 0),
      last_updated = now(),
      updated_at = now()
    WHERE hi.id = v_hub_row;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'purchase_order_item_id', v_item.id,
        'quantity_reversed', v_rcv,
        'raw_material_id', v_rm,
        'unit_price', v_price
      )
    );
  END LOOP;

  PERFORM public._append_data_ledger(
    'cancelled',
    'purchase_order',
    p_po_id::text,
    'procurement',
    'event',
    NULL,
    jsonb_build_object(
      'order_number', v_po.order_number,
      'status', v_po.status,
      'lines_before', v_before
    ),
    NULL,
    jsonb_build_object('reversal_lines', v_lines),
    NULL
  );

  DELETE FROM public.purchase_orders WHERE id = p_po_id;

  RETURN jsonb_build_object('success', true, 'reversal_lines', v_lines);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Outlet transfers: direct table mutation is denied; RPCs enforce active staff.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfer_lines" ON public.outlet_transfer_lines;

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

    IF v_res < v_ln.quantity OR v_qoh < v_ln.quantity THEN
      RAISE EXCEPTION 'cannot_fulfill_reserved' USING ERRCODE = 'P0001';
    END IF;

    v_new_qoh := v_qoh - v_ln.quantity;
    v_new_res := v_res - v_ln.quantity;

    UPDATE public.outlet_inventory
    SET
      quantity_on_hand = v_new_qoh,
      reserved_quantity = v_new_res,
      available_quantity = v_new_qoh - v_new_res,
      last_updated = now(),
      updated_at = now()
    WHERE id = v_ln.source_outlet_inventory_id;
  END LOOP;

  UPDATE public.outlet_transfers
  SET
    status = 'dispatched',
    dispatch_date = CURRENT_DATE,
    updated_at = now()
  WHERE id = p_transfer_id;

  PERFORM public._append_data_ledger(
    'dispatched',
    'outlet_transfer',
    p_transfer_id::text,
    'distribution',
    'event',
    NULL,
    NULL,
    jsonb_build_object('transfer_number', v_hdr.transfer_number),
    NULL,
    NULL
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
    SELECT otl.* FROM public.outlet_transfer_lines otl WHERE otl.outlet_transfer_id = p_transfer_id
    ORDER BY otl.id
  LOOP
    v_dest := NULL;
    v_qoh := NULL;
    v_res := NULL;
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
      SET
        quantity_on_hand = v_new_qoh,
        available_quantity = v_new_qoh - v_res,
        last_updated = now(),
        updated_at = now()
      WHERE id = v_dest;
    ELSE
      INSERT INTO public.outlet_inventory (
        outlet_id, product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity,
        last_updated, updated_at
      )
      VALUES (
        v_to, trim(both from v_ln.product_batch), v_ln.lot_id, v_ln.quantity, 0, v_ln.quantity,
        now(), now()
      );
    END IF;
  END LOOP;

  UPDATE public.outlet_transfers
  SET
    status = 'received',
    received_date = CURRENT_DATE,
    updated_at = now()
  WHERE id = p_transfer_id;

  PERFORM public._append_data_ledger(
    'received',
    'outlet_transfer',
    p_transfer_id::text,
    'distribution',
    'event',
    NULL,
    NULL,
    jsonb_build_object('transfer_number', v_hdr.transfer_number, 'to_outlet_id', v_to),
    NULL,
    NULL
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
    jsonb_build_object('transfer_number', v_hdr.transfer_number, 'previous_status', v_hdr.status),
    NULL,
    NULL
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Outlet inventory visibility: pending users are not approved staff.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Non supervisor view all outlet inventory" ON public.outlet_inventory;

CREATE POLICY "Non supervisor view all outlet inventory"
  ON public.outlet_inventory FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) NOT IN ('pending', 'supervisor')
    )
  );

-- ---------------------------------------------------------------------------
-- Supply-order deletion: reverse only stock that is still available to remove.
-- ---------------------------------------------------------------------------

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
  v_oi_qoh numeric;
  v_oi_res numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT status, outlet_id INTO st, v_outlet_id
  FROM public.supply_orders
  WHERE id = p_supply_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supply order not found';
  END IF;

  IF st = 'pending' THEN
    FOR rec IN
      SELECT hub_inventory_id, quantity
      FROM public.supply_order_lines
      WHERE supply_order_id = p_supply_order_id
    LOOP
      PERFORM public.release_inventory_reservation(rec.hub_inventory_id, rec.quantity, p_supply_order_id);
    END LOOP;

  ELSIF st = 'dispatched' THEN
    FOR rec IN
      SELECT hub_inventory_id, quantity
      FROM public.supply_order_lines
      WHERE supply_order_id = p_supply_order_id
    LOOP
      UPDATE public.hub_inventory hi
      SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        RAISE EXCEPTION 'Hub inventory row missing for reversal (hub_inventory_id=%)', rec.hub_inventory_id;
      END IF;
    END LOOP;

  ELSIF st = 'received' THEN
    FOR rec IN
      SELECT
        sol.hub_inventory_id,
        sol.quantity,
        sol.product_batch AS line_product_batch,
        hi.raw_material_id AS hub_raw_material_id,
        hi.product_batch AS hub_product_batch
      FROM public.supply_order_lines sol
      INNER JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
      WHERE sol.supply_order_id = p_supply_order_id
    LOOP
      v_oi_id := NULL;
      v_oi_qoh := NULL;
      v_oi_res := NULL;

      IF rec.hub_raw_material_id IS NOT NULL THEN
        SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_oi_id, v_oi_qoh, v_oi_res
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id = rec.hub_raw_material_id
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for raw material % (outlet %)', rec.hub_raw_material_id, v_outlet_id;
        END IF;
      ELSE
        SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_oi_id, v_oi_qoh, v_oi_res
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id IS NULL
          AND oi.product_batch IS NOT DISTINCT FROM COALESCE(rec.line_product_batch, rec.hub_product_batch)
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for batch % (outlet %)',
            COALESCE(rec.line_product_batch, rec.hub_product_batch),
            v_outlet_id;
        END IF;
      END IF;

      IF v_oi_qoh < rec.quantity THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION 'Insufficient outlet inventory to reverse raw material % (need %, have %, outlet %)',
            rec.hub_raw_material_id, rec.quantity, v_oi_qoh, v_outlet_id;
        ELSE
          RAISE EXCEPTION 'Insufficient outlet inventory to reverse batch % (need %, have %, outlet %)',
            COALESCE(rec.line_product_batch, rec.hub_product_batch), rec.quantity, v_oi_qoh, v_outlet_id;
        END IF;
      END IF;

      IF (v_oi_qoh - rec.quantity) < v_oi_res THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION 'Outlet inventory reversal would violate reservations for raw material % (need remaining >= %, remaining %)',
            rec.hub_raw_material_id, v_oi_res, v_oi_qoh - rec.quantity;
        ELSE
          RAISE EXCEPTION 'Outlet inventory reversal would violate reservations for batch % (need remaining >= %, remaining %)',
            COALESCE(rec.line_product_batch, rec.hub_product_batch), v_oi_res, v_oi_qoh - rec.quantity;
        END IF;
      END IF;

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - rec.quantity,
        available_quantity = (oi.quantity_on_hand - rec.quantity) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_oi_id;
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION 'Outlet inventory update failed for raw material %', rec.hub_raw_material_id;
        ELSE
          RAISE EXCEPTION 'Outlet inventory update failed for batch %',
            COALESCE(rec.line_product_batch, rec.hub_product_batch);
        END IF;
      END IF;

      UPDATE public.hub_inventory hi
      SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        RAISE EXCEPTION 'Hub inventory row missing for reversal (hub_inventory_id=%)', rec.hub_inventory_id;
      END IF;
    END LOOP;

  ELSIF st = 'cancelled' THEN
    NULL;

  ELSE
    RAISE EXCEPTION 'Unsupported supply order status for delete: %', st;
  END IF;

  DELETE FROM public.supply_orders WHERE id = p_supply_order_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_delete_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_supply_order(uuid) TO authenticated;
