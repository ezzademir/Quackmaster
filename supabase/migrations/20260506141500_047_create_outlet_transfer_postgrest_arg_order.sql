/*
  PostgREST resolves RPCs by argument type sequence matching the lexical order of
  parameter names (see client error listing p_from_outlet_id, p_lines, p_notes, p_to_outlet_id).

  Previously: (uuid, uuid, text, jsonb) → from, to, notes, lines
  Required:  (uuid, jsonb, text, uuid) → from, lines, notes, to
*/

DROP FUNCTION IF EXISTS public.create_outlet_transfer(uuid, uuid, text, jsonb);

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
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
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
