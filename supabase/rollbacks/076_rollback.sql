-- Rollback for 076 (and 075/074). Restores pre-hardening function bodies and grants.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
-- 074 policies
DROP POLICY IF EXISTS "Active staff insert own inventory_adjustments" ON public.inventory_adjustments;
CREATE POLICY "Authenticated users can manage inventory adjustments" ON public.inventory_adjustments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can insert own inventory_adjustments" ON public.inventory_adjustments FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS "Active members insert own ledger rows" ON public.data_ledger;
CREATE POLICY "Authenticated users can insert ledger rows" ON public.data_ledger FOR INSERT TO authenticated WITH CHECK (true);
-- Original (unguarded) function bodies:
CREATE OR REPLACE FUNCTION public.receive_po_shipment(p_po_id uuid, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      WHEN v_received_total >= v_ordered_total AND v_ordered_total > 0 THEN (timezone('Asia/Kuala_Lumpur', now()))::date
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
$function$;

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

CREATE OR REPLACE FUNCTION public.reserve_inventory(p_hub_inventory_id uuid, p_quantity numeric, p_reference_type text, p_reference_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
  v_new_res numeric;
  v_ref_type text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Reservation quantity must be positive';
  END IF;

  IF p_reference_id IS NULL THEN
    RAISE EXCEPTION 'reference_id is required';
  END IF;

  v_ref_type := NULLIF(trim(both from COALESCE(p_reference_type, '')), '');
  IF v_ref_type IS NULL THEN
    RAISE EXCEPTION 'reference_type is required';
  END IF;

  SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
  INTO v_qoh, v_res
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub inventory row not found';
  END IF;

  v_avail := v_qoh - v_res;
  IF v_avail < p_quantity THEN
    RAISE EXCEPTION 'Insufficient available inventory';
  END IF;

  v_new_res := v_res + p_quantity;

  UPDATE public.hub_inventory
  SET
    reserved_quantity = v_new_res,
    available_quantity = v_qoh - v_new_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = p_hub_inventory_id;

  INSERT INTO public.hub_inventory_reservations (
    hub_inventory_id, reference_type, reference_id, quantity, reason, updated_at
  )
  VALUES (
    p_hub_inventory_id, v_ref_type, p_reference_id, p_quantity, p_reason, now()
  )
  ON CONFLICT (hub_inventory_id, reference_type, reference_id)
  DO UPDATE SET
    quantity = public.hub_inventory_reservations.quantity + EXCLUDED.quantity,
    reason = COALESCE(EXCLUDED.reason, public.hub_inventory_reservations.reason),
    updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.fulfill_inventory_reservation(p_hub_inventory_id uuid, p_quantity numeric, p_reference_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_res numeric;
  v_led_id uuid;
  v_led_qty numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Fulfill quantity must be positive';
  END IF;

  IF p_reference_id IS NULL THEN
    RAISE EXCEPTION 'reference_id is required';
  END IF;

  SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
  INTO v_qoh, v_res
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub inventory row not found';
  END IF;

  SELECT r.id, r.quantity
  INTO v_led_id, v_led_qty
  FROM public.hub_inventory_reservations r
  WHERE r.hub_inventory_id = p_hub_inventory_id
    AND r.reference_id = p_reference_id
  ORDER BY CASE WHEN r.reference_type = 'supply_order' THEN 0 ELSE 1 END, r.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_led_id IS NULL THEN
    RAISE EXCEPTION 'No reservation found for reference';
  END IF;

  IF v_led_qty < p_quantity THEN
    RAISE EXCEPTION 'Cannot fulfill more than reserved for this reference';
  END IF;

  IF v_res < p_quantity THEN
    RAISE EXCEPTION 'Cannot fulfill more than reserved quantity';
  END IF;

  IF v_qoh < p_quantity THEN
    RAISE EXCEPTION 'Cannot fulfill more than on-hand quantity';
  END IF;

  v_new_qoh := v_qoh - p_quantity;
  v_new_res := v_res - p_quantity;

  UPDATE public.hub_inventory
  SET
    quantity_on_hand = v_new_qoh,
    reserved_quantity = v_new_res,
    available_quantity = v_new_qoh - v_new_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = p_hub_inventory_id;

  IF v_led_qty = p_quantity THEN
    DELETE FROM public.hub_inventory_reservations WHERE id = v_led_id;
  ELSE
    UPDATE public.hub_inventory_reservations
    SET quantity = v_led_qty - p_quantity, updated_at = now()
    WHERE id = v_led_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_inventory_reservation(p_hub_inventory_id uuid, p_quantity numeric, p_reference_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_new_res numeric;
  v_led_id uuid;
  v_led_qty numeric;
  v_release numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Release quantity must be positive';
  END IF;

  IF p_reference_id IS NULL THEN
    RAISE EXCEPTION 'reference_id is required';
  END IF;

  -- Lock hub first (same order as reserve) to avoid deadlocks
  SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
  INTO v_qoh, v_res
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub inventory row not found';
  END IF;

  SELECT r.id, r.quantity
  INTO v_led_id, v_led_qty
  FROM public.hub_inventory_reservations r
  WHERE r.hub_inventory_id = p_hub_inventory_id
    AND r.reference_id = p_reference_id
  ORDER BY CASE WHEN r.reference_type = 'supply_order' THEN 0 ELSE 1 END, r.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_led_id IS NULL THEN
    RAISE EXCEPTION 'No reservation found for reference';
  END IF;

  IF v_led_qty < p_quantity THEN
    RAISE EXCEPTION 'Cannot release more than reserved for this reference';
  END IF;

  v_release := p_quantity;

  -- Never decrease hub reserved below zero; never steal other references' share
  IF v_res < v_release THEN
    RAISE EXCEPTION 'Hub reserved_quantity lower than reference reservation';
  END IF;

  v_new_res := v_res - v_release;

  UPDATE public.hub_inventory
  SET
    reserved_quantity = v_new_res,
    available_quantity = v_qoh - v_new_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = p_hub_inventory_id;

  IF v_led_qty = v_release THEN
    DELETE FROM public.hub_inventory_reservations WHERE id = v_led_id;
  ELSE
    UPDATE public.hub_inventory_reservations
    SET quantity = v_led_qty - v_release, updated_at = now()
    WHERE id = v_led_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.snapshot_all_outlets_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outlet uuid;
  v_count integer := 0;
BEGIN
  FOR v_outlet IN SELECT id FROM public.outlets ORDER BY name
  LOOP
    PERFORM public.snapshot_outlet_inventory(v_outlet, CURRENT_DATE, 'daily');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.replace_sales_journal(p_existing_sales_journal_id uuid, p_business_date date, p_lines jsonb, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_outlet uuid;
  v_void jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT sj.outlet_id
  INTO v_outlet
  FROM public.sales_journals sj
  WHERE sj.id = p_existing_sales_journal_id AND sj.status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_found_or_not_posted');
  END IF;

  v_void := public.void_sales_journal(p_existing_sales_journal_id);

  IF COALESCE(v_void->>'success', 'false') <> 'true' THEN
    RETURN v_void;
  END IF;

  RETURN public.post_sales_journal(v_outlet, p_business_date, p_lines, p_notes, p_idempotency_key);
END;
$function$;
