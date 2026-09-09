/*
  Pack 2 (audit P0): abort RPC transactions on mid-mutation failure.

  Soft RETURN jsonb success:false AFTER inventory / PO writes still COMMITS under
  PostgREST. That left partial PO receives/cancels, orphan FG on failed production
  posts, and double-credited outlet stock on receive_supply_order retry.

  Strategy:
  - post_production_completion_inventory: lock+validate all RM, consume RM, THEN
    insert FG lot/hub; RAISE after inventory writes begin.
  - receive_po_shipment: validate-all-first (locks, no writes), then apply deltas;
    RAISE if apply sees an unexpected shortfall. Happy-path delta receive unchanged.
  - cancel_purchase_order: validate-all-first, then reverse; RAISE mid-apply.
  - receive_supply_order: validate all hub lines first, then credit outlets; RAISE
    instead of soft-return after any outlet write.
*/

-- ---------------------------------------------------------------------------
-- Production: RM validate/consume before FG insert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_production_completion_inventory(
  p_production_run_id uuid,
  p_product_batch text,
  p_finished_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  pr RECORD;
  rec RECORD;
  mat RECORD;
  v_hub_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_avail numeric;
  v_sku text;
  v_lot_label text;
  v_lot_id uuid;
  v_parent_lot uuid;
  v_mfg date;
  v_expiry date;
  v_out_id uuid;
  v_iso timestamptz := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_finished_quantity IS NULL OR p_finished_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_finished_quantity');
  END IF;

  SELECT *
  INTO pr
  FROM public.production_runs
  WHERE id = p_production_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'production_run_not_found');
  END IF;

  IF pr.status IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_run_status', 'status', pr.status);
  END IF;

  SELECT r.name, r.default_product_batch, r.shelf_life_days
  INTO rec
  FROM public.recipes r
  WHERE r.id = pr.recipe_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'recipe_not_found');
  END IF;

  v_sku := COALESCE(
    public.normalize_fg_sku(p_product_batch),
    public.normalize_fg_sku(rec.default_product_batch),
    public.normalize_fg_sku(rec.name),
    'FG'
  );

  v_mfg := COALESCE(pr.production_date, CURRENT_DATE);
  IF rec.shelf_life_days IS NOT NULL AND rec.shelf_life_days > 0 THEN
    v_expiry := v_mfg + rec.shelf_life_days;
  ELSE
    v_expiry := NULL;
  END IF;

  v_lot_label := public.format_fg_lot_label(v_sku, v_mfg, pr.run_number);

  SELECT hi.lot_id
  INTO v_parent_lot
  FROM public.production_run_materials prm
  JOIN public.hub_inventory hi
    ON hi.raw_material_id = prm.raw_material_id
   AND hi.lot_id IS NOT NULL
  WHERE prm.production_run_id = p_production_run_id
  ORDER BY prm.created_at ASC NULLS LAST
  LIMIT 1;

  -- Pass 1: lock + validate every RM (no stock writes yet → soft RETURN OK).
  FOR mat IN
    SELECT
      prm.raw_material_id,
      SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF v_hub_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'raw_material_hub_row_missing',
        'raw_material_id', mat.raw_material_id
      );
    END IF;

    IF v_qoh < mat.quantity_consumed THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_raw_material',
        'raw_material_id', mat.raw_material_id,
        'on_hand', v_qoh,
        'required', mat.quantity_consumed
      );
    END IF;
  END LOOP;

  -- Pass 2: consume RM before FG insert (preferred order).
  FOR mat IN
    SELECT
      prm.raw_material_id,
      SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF v_hub_id IS NULL THEN
      RAISE EXCEPTION 'raw_material_hub_row_missing'
        USING ERRCODE = 'P0001',
              DETAIL = mat.raw_material_id::text;
    END IF;

    IF v_qoh < mat.quantity_consumed THEN
      RAISE EXCEPTION 'insufficient_raw_material'
        USING ERRCODE = 'P0001',
              DETAIL = format('have %s need %s rm %s', v_qoh, mat.quantity_consumed, mat.raw_material_id);
    END IF;

    v_new_qoh := v_qoh - mat.quantity_consumed;
    v_new_avail := v_new_qoh - v_res;

    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = v_new_qoh,
      available_quantity = v_new_avail,
      last_updated = v_iso,
      updated_at = v_iso
    WHERE hi.id = v_hub_id;
  END LOOP;

  IF rec.default_product_batch IS NULL OR trim(both from rec.default_product_batch) = '' THEN
    UPDATE public.recipes
    SET default_product_batch = v_sku, updated_at = v_iso
    WHERE id = pr.recipe_id;
  END IF;

  IF p_finished_quantity > 0 THEN
    INSERT INTO public.inventory_lots (
      product_batch_label,
      expiry_date,
      manufactured_at,
      parent_lot_id,
      production_run_id,
      created_at,
      updated_at
    )
    VALUES (
      v_lot_label,
      v_expiry,
      v_mfg::timestamptz,
      v_parent_lot,
      p_production_run_id,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_lot_id;

    INSERT INTO public.hub_inventory (
      product_batch,
      lot_id,
      quantity_on_hand,
      reserved_quantity,
      available_quantity,
      last_updated,
      updated_at
    )
    VALUES (
      v_sku,
      v_lot_id,
      p_finished_quantity,
      0,
      p_finished_quantity,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_out_id;
  END IF;

  UPDATE public.production_runs
  SET
    status = 'completed',
    updated_at = v_iso
  WHERE id = p_production_run_id;

  PERFORM public._append_data_ledger(
    'inventory_posted',
    'production_run',
    p_production_run_id::text,
    'production',
    'event',
    NULL,
    jsonb_build_object(
      'hub_inventory_id', v_out_id,
      'product_batch', v_sku,
      'lot_id', v_lot_id,
      'lot_label', v_lot_label,
      'finished_quantity', p_finished_quantity
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'success', true,
    'production_run_id', p_production_run_id,
    'hub_inventory_id', v_out_id,
    'lot_id', v_lot_id,
    'lot_label', v_lot_label,
    'sku', v_sku,
    'expiry_date', v_expiry,
    'manufactured_at', v_mfg,
    'run_number', pr.run_number,
    'finished_quantity', p_finished_quantity
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- PO receive: validate-all-first, then apply delta (happy path unchanged)
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
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  -- Phase 1: lock + validate every line. No PO/hub/WAC writes yet.
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

    IF v_delta <> 0 AND v_rm IS NOT NULL THEN
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
      ELSE
        IF v_qoh + v_delta < v_res THEN
          RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved');
        END IF;
      END IF;

      IF v_delta > 0 THEN
        PERFORM 1 FROM public.raw_materials r WHERE r.id = v_rm FOR UPDATE;
      END IF;
    END IF;
  END LOOP;

  -- Phase 2: apply deltas. Unexpected failure must RAISE (txn abort).
  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_item_id := (rec->>'purchase_order_item_id')::uuid;
    v_target_rcv := (rec->>'quantity_received')::numeric;

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

    IF NOT FOUND OR v_po_check <> p_po_id THEN
      RAISE EXCEPTION 'po_item_not_found'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_target_rcv IS NULL OR v_target_rcv < 0 OR v_target_rcv > v_ordered THEN
      RAISE EXCEPTION 'invalid_quantity_received'
        USING ERRCODE = 'P0001';
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
          RAISE EXCEPTION 'cannot_reduce_missing_hub_row'
            USING ERRCODE = 'P0001';
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
          RAISE EXCEPTION 'hub_below_reserved'
            USING ERRCODE = 'P0001';
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

-- ---------------------------------------------------------------------------
-- Cancel PO: validate-all-first, then reverse hub/WAC + delete
-- ---------------------------------------------------------------------------
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
$$;

REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- receive_supply_order: validate hub lines first; RAISE after outlet writes
-- ---------------------------------------------------------------------------
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

  -- Phase 1: validate every line's hub row (no outlet writes yet).
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

    IF v_rm IS NULL THEN
      v_pb := trim(both from COALESCE(v_pb::text, ''));
      IF v_pb = '' THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'hub_inventory_invalid_fg',
          'hub_inventory_id', line.hub_inventory_id
        );
      END IF;
    END IF;
  END LOOP;

  -- Phase 2: credit outlet inventory. RAISE on unexpected mid-loop failure.
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
      RAISE EXCEPTION 'hub_inventory_missing'
        USING ERRCODE = 'P0001',
              DETAIL = line.hub_inventory_id::text;
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
        PERFORM public._clear_outlet_movement_ctx();
        RAISE EXCEPTION 'hub_inventory_invalid_fg'
          USING ERRCODE = 'P0001',
                DETAIL = line.hub_inventory_id::text;
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

REVOKE ALL ON FUNCTION public.receive_supply_order(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_supply_order(uuid, uuid) TO authenticated;
