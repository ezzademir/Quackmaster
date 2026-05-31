/*
  Stock take guard: supervisors may only post raw-material outlet inventory rows.
  The UI hides finished goods, but the RPC is the authority for inventory writes.
*/

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
  v_role text;
  v_is_supervisor boolean := false;
  v_session_id uuid;
  rec jsonb;
  v_oi_id uuid;
  v_counted numeric;
  v_remark text;
  v_qoh numeric;
  v_res numeric;
  v_raw_material_id uuid;
  v_sys numeric;
  v_var numeric;
  v_lines_out jsonb := '[]'::jsonb;
  v_existing uuid;
  seen_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_uid IS NULL OR NOT public.profile_can_post_outlet_stock_take(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT lower(trim(p.role::text))
  INTO v_role
  FROM public.profiles p
  WHERE p.id = v_uid;

  v_is_supervisor := v_role = 'supervisor';

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.outlet_stock_take_sessions
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'session_id', v_existing,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_counted := NULLIF(rec->>'counted_qty', '')::numeric;

    IF v_oi_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;

    IF v_oi_id = ANY(seen_ids) THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_outlet_inventory_id', 'outlet_inventory_id', v_oi_id);
    END IF;
    seen_ids := array_append(seen_ids, v_oi_id);

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0), oi.raw_material_id
    INTO v_qoh, v_res, v_raw_material_id
    FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id AND oi.outlet_id = p_outlet_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'outlet_inventory_not_found',
        'outlet_inventory_id', v_oi_id
      );
    END IF;

    IF v_is_supervisor AND v_raw_material_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'supervisor_finished_goods_not_allowed',
        'outlet_inventory_id', v_oi_id
      );
    END IF;

    IF v_counted < v_res THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'counted_below_reserved',
        'outlet_inventory_id', v_oi_id,
        'reserved', v_res,
        'counted', v_counted
      );
    END IF;
  END LOOP;

  INSERT INTO public.outlet_stock_take_sessions (
    outlet_id,
    count_date,
    notes,
    idempotency_key,
    created_by
  )
  VALUES (
    p_outlet_id,
    COALESCE(p_count_date, CURRENT_DATE),
    NULLIF(trim(both from p_notes), ''),
    p_idempotency_key,
    v_uid
  )
  RETURNING id INTO v_session_id;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_counted := NULLIF(rec->>'counted_qty', '')::numeric;
    v_remark := NULLIF(trim(both from rec->>'line_remark'), '');

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id AND oi.outlet_id = p_outlet_id
    FOR UPDATE;

    v_sys := v_qoh;
    v_var := v_counted - v_sys;

    UPDATE public.outlet_inventory oi
    SET
      quantity_on_hand = v_counted,
      available_quantity = v_counted - v_res,
      last_updated = now(),
      updated_at = now()
    WHERE oi.id = v_oi_id;

    INSERT INTO public.outlet_stock_take_lines (
      session_id,
      outlet_inventory_id,
      system_qoh_before,
      counted_qty,
      variance,
      line_remark
    )
    VALUES (v_session_id, v_oi_id, v_sys, v_counted, v_var, v_remark);

    v_lines_out := v_lines_out || jsonb_build_array(
      jsonb_build_object(
        'outlet_inventory_id', v_oi_id,
        'system_qoh_before', v_sys,
        'counted_qty', v_counted,
        'variance', v_var,
        'line_remark', COALESCE(to_jsonb(v_remark), 'null'::jsonb)
      )
    );
  END LOOP;

  PERFORM public._append_data_ledger(
    'posted',
    'outlet_stock_take',
    v_session_id::text,
    'inventory',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'count_date', COALESCE(p_count_date, CURRENT_DATE),
      'lines', v_lines_out
    ),
    NULL,
    jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object(
    'success', true,
    'session_id', v_session_id,
    'lines', v_lines_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_outlet_stock_take(uuid, date, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_outlet_stock_take(uuid, date, text, jsonb, uuid) TO authenticated;
