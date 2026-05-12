/*
  Lock outlet transfer state changes behind audited RPCs and active staff checks.

  The transfer tables model inventory movement state. Direct client writes can
  desynchronise document status from reserved/on-hand quantities, so clients may
  only read these rows; writes must go through the transactional RPCs below.
*/

DROP POLICY IF EXISTS "Authenticated users can view outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfers" ON public.outlet_transfers;

DROP POLICY IF EXISTS "Authenticated users can view outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfer_lines" ON public.outlet_transfer_lines;

DROP POLICY IF EXISTS "Active staff can view outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Active staff can view outlet_transfer_lines" ON public.outlet_transfer_lines;

CREATE POLICY "Active staff can view outlet_transfers"
  ON public.outlet_transfers FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can view outlet_transfer_lines"
  ON public.outlet_transfer_lines FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

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

REVOKE ALL ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;
