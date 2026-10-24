-- Rollback 088 (stock entity tags). Drops the tag columns and the hub movement ledger created by 088
-- (tags written to inventory_lots / outlet_stock_movements since 088 are lost). Old rows are untouched.
-- cancel_purchase_order: restore the live definition captured read-only on 24 Oct 2026 (pre-088, untagged reversal, always deletes)
CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Active admin or staff required');
  END IF;
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

  -- Phase 1: lock + validate every received line (no hub/WAC writes).
  FOR v_item IN
    SELECT poi.id, poi.raw_material_id, COALESCE(poi.quantity_received, 0) AS qty_rcv, COALESCE(poi.unit_price, 0) AS unit_p
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = p_po_id
      AND COALESCE(poi.quantity_received, 0) > 0
    ORDER BY poi.id DESC
    FOR UPDATE OF poi
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

    PERFORM 1 FROM public.raw_materials r WHERE r.id = v_rm FOR UPDATE;
  END LOOP;

  -- Phase 2: reverse receipts. RAISE on unexpected failure after mutations begin.
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
      RAISE EXCEPTION 'missing_raw_material'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_rm
    ORDER BY hi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_hub_row IS NULL THEN
      RAISE EXCEPTION 'cannot_cancel_missing_hub_row'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_qoh < v_rcv THEN
      RAISE EXCEPTION 'insufficient_hub_quantity'
        USING ERRCODE = 'P0001';
    END IF;

    IF (v_qoh - v_rcv) < v_res THEN
      RAISE EXCEPTION 'hub_below_reserved'
        USING ERRCODE = 'P0001';
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
$function$;
DROP FUNCTION IF EXISTS public._po_cancel_plan(uuid);
DROP VIEW IF EXISTS public.v_stock_movements, public.v_hub_stock_by_entity;
DROP TRIGGER IF EXISTS outlet_movement_entity_guard ON public.outlet_stock_movements;
DROP TRIGGER IF EXISTS inventory_lot_entity_guard ON public.inventory_lots;
DROP TRIGGER IF EXISTS po_cancel_stock_entity ON public.purchase_orders;
DROP TRIGGER IF EXISTS po_item_stock_entity ON public.purchase_order_items;
DROP TRIGGER IF EXISTS trg_hub_inventory_movement ON public.hub_inventory;
DROP FUNCTION IF EXISTS public._outlet_movement_entity_guard(), public._inventory_lot_entity_guard(),
  public._po_cancel_stock_entity(), public._po_item_stock_entity(), public._hub_inventory_movement(),
  public._resolve_stock_entity(uuid, uuid), public.set_stock_entity(text), public.set_stock_tag_enforcement(text, boolean),
  public._stock_tag_enforced(text);
DROP TABLE IF EXISTS public.hub_stock_movements, public.stock_tag_enforcement;
DROP INDEX IF EXISTS public.idx_inventory_lots_entity, public.idx_osm_entity;
ALTER TABLE public.inventory_lots DROP COLUMN IF EXISTS entity_code;
ALTER TABLE public.outlet_stock_movements DROP COLUMN IF EXISTS entity_code;
