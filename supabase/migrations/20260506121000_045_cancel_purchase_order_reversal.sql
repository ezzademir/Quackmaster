/*
  Atomically reverse PO receipts (hub qty + weighted average), then delete PO + items.
  Mirrors receive_po_shipment: touches first hub row per material (created_at ASC).
*/

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

  -- Reverse receipts in reverse application order (mirror LIFO within this PO).
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
      -- Emptied hub across all bins for this material; fall back to static cost_price.
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
