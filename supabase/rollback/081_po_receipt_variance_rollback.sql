-- Rollback for 081_po_receipt_variance. Run as one transaction.
-- Pre-check: any PO with status 'closed_short' is set back to 'partial' (its stock was never changed).
-- Pre-check: rows with >2 decimals or > ordered will be ROUNDED by the type change; review first:
--   SELECT id, quantity_ordered, quantity_received FROM purchase_order_items
--    WHERE quantity_received <> round(quantity_received,2) OR quantity_ordered <> round(quantity_ordered,2);
BEGIN;
UPDATE public.purchase_orders SET status = 'partial', updated_at = now() WHERE status = 'closed_short';

DROP FUNCTION IF EXISTS public.adjust_po_receipt(uuid, numeric, text, boolean);
DROP FUNCTION IF EXISTS public.adjust_po_receipt(uuid, numeric, text);
DROP POLICY IF EXISTS purchase_orders_closed_short_admin_only ON public.purchase_orders;
DROP FUNCTION IF EXISTS public.close_po_short(uuid, text);

-- restore receive_po_shipment exactly as deployed by 076 (md5(prosrc) a70b76f57cbf3d43dc9f8bc304dc33dd)
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
  IF NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Active admin or staff required');
  END IF;
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
REVOKE ALL ON FUNCTION public.receive_po_shipment(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_po_shipment(uuid, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public._po_line_status(uuid);
DROP FUNCTION IF EXISTS public._po_apply_hub_delta(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public._po_over_receipt_tolerance_pct();
DROP TABLE IF EXISTS public.procurement_settings;

DROP VIEW IF EXISTS public.supplier_scorecard_metrics;
ALTER TABLE public.purchase_order_items
  ALTER COLUMN quantity_ordered TYPE numeric(10,2),
  ALTER COLUMN quantity_received TYPE numeric(10,2),
  ALTER COLUMN unit_price TYPE numeric(12,2);
CREATE VIEW public.supplier_scorecard_metrics AS
 SELECT s.id AS supplier_id, s.name AS supplier_name,
    count(po.id) FILTER (WHERE po.status = ANY (ARRAY['received'::text, 'partial'::text])) AS completed_orders,
    avg(CASE
          WHEN po.expected_delivery_date IS NOT NULL AND po.actual_delivery_date IS NOT NULL AND po.actual_delivery_date <= po.expected_delivery_date THEN 1::numeric
          WHEN po.expected_delivery_date IS NOT NULL AND po.actual_delivery_date IS NOT NULL THEN 0::numeric
          ELSE NULL::numeric END) AS otif_rate,
    avg(CASE WHEN poi.quantity_ordered > 0::numeric THEN poi.quantity_received / poi.quantity_ordered ELSE NULL::numeric END) AS avg_fill_rate
   FROM public.suppliers s
     LEFT JOIN public.purchase_orders po ON po.supplier_id = s.id
     LEFT JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
  GROUP BY s.id, s.name;
REVOKE ALL ON public.supplier_scorecard_metrics FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.supplier_scorecard_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON public.supplier_scorecard_metrics TO authenticated;
COMMIT;
