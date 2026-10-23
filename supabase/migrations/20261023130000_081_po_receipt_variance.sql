/*
  081 — Procurement receipt variance (forward-only; no historical rows touched).

  1. purchase_order_items.quantity_ordered / quantity_received widened to numeric(14,4)
     (supplier_scorecard_metrics depends on them: dropped + recreated, grants restored;
     'closed_short' now counts as a completed order).
  2. procurement_settings: single row, over_receipt_tolerance_pct (default 10).
  3. _po_apply_hub_delta: internal helper (hub + WAC), not callable by clients.
  4. receive_po_shipment(uuid, jsonb) v2, same signature. Line keys:
       purchase_order_item_id, quantity_received (new cumulative total), reason (optional)
     - over-receipt up to ordered * (1 + tolerance%) is accepted;
     - beyond that requires an admin AND a reason (error over_tolerance_needs_admin_reason);
     - only ordered / partial POs (received POs -> adjust_po_receipt);
     - status is per line: every line >= ordered -> received, else partial;
     - ONE data_ledger row: entered, previous, posted delta, over/short, reason per line.
  5. close_po_short(uuid, text): ADMIN ONLY (Ezzad, 23 Oct). partial -> closed_short, reason required,
     no stock posting. RLS: restrictive policy so only admins can write status 'closed_short'.
  6. adjust_po_receipt(uuid, numeric, text, boolean DEFAULT false): admin, reason required, posts delta only.
     p_keep_line_total = true: invoice total unchanged (e.g. PO-0032 315 -> 320.974 kg); the delta qty
     posts at zero added value, line_total kept, unit_price repriced = line_total / new qty.
     blocks hub going below reserved; ledger row carries before/after.
  Rollback: supabase/rollback/081_po_receipt_variance_rollback.sql
*/

-- 1. widen columns -----------------------------------------------------------
DROP VIEW IF EXISTS public.supplier_scorecard_metrics;

ALTER TABLE public.purchase_order_items
  ALTER COLUMN quantity_ordered TYPE numeric(14,4),
  ALTER COLUMN quantity_received TYPE numeric(14,4);

CREATE VIEW public.supplier_scorecard_metrics AS
 SELECT s.id AS supplier_id,
    s.name AS supplier_name,
    count(po.id) FILTER (WHERE po.status = ANY (ARRAY['received'::text, 'partial'::text, 'closed_short'::text])) AS completed_orders,
    avg(
        CASE
            WHEN po.expected_delivery_date IS NOT NULL AND po.actual_delivery_date IS NOT NULL AND po.actual_delivery_date <= po.expected_delivery_date THEN 1::numeric
            WHEN po.expected_delivery_date IS NOT NULL AND po.actual_delivery_date IS NOT NULL THEN 0::numeric
            ELSE NULL::numeric
        END) AS otif_rate,
    avg(
        CASE
            WHEN poi.quantity_ordered > 0::numeric THEN poi.quantity_received / poi.quantity_ordered
            ELSE NULL::numeric
        END) AS avg_fill_rate
   FROM public.suppliers s
     LEFT JOIN public.purchase_orders po ON po.supplier_id = s.id
     LEFT JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
  GROUP BY s.id, s.name;

REVOKE ALL ON public.supplier_scorecard_metrics FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.supplier_scorecard_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON public.supplier_scorecard_metrics TO authenticated;

-- 2. settings ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.procurement_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  over_receipt_tolerance_pct numeric(6,2) NOT NULL DEFAULT 10 CHECK (over_receipt_tolerance_pct >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.procurement_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.procurement_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS procurement_settings_read ON public.procurement_settings;
CREATE POLICY procurement_settings_read ON public.procurement_settings
  FOR SELECT TO authenticated USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS procurement_settings_admin_write ON public.procurement_settings;
CREATE POLICY procurement_settings_admin_write ON public.procurement_settings
  FOR UPDATE TO authenticated USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());
REVOKE ALL ON public.procurement_settings FROM PUBLIC, anon;
GRANT SELECT, UPDATE ON public.procurement_settings TO authenticated;

CREATE OR REPLACE FUNCTION public._po_over_receipt_tolerance_pct()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT COALESCE((SELECT over_receipt_tolerance_pct FROM public.procurement_settings WHERE id), 10) $$;

-- 3. internal hub/WAC helper ---------------------------------------------------
CREATE OR REPLACE FUNCTION public._po_apply_hub_delta(p_rm uuid, p_delta numeric, p_price numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_hub_row uuid; v_qoh numeric; v_res numeric;
  v_tot_before numeric; v_old_avg numeric; v_new_avg numeric;
BEGIN
  IF p_delta = 0 OR p_rm IS NULL THEN RETURN; END IF;

  SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
  FROM public.hub_inventory hi
  WHERE hi.raw_material_id = p_rm
  ORDER BY hi.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_hub_row IS NULL AND p_delta < 0 THEN
    RAISE EXCEPTION 'cannot_reduce_missing_hub_row' USING ERRCODE = 'P0001';
  END IF;
  IF v_hub_row IS NOT NULL AND v_qoh + p_delta < v_res THEN
    RAISE EXCEPTION 'hub_below_reserved' USING ERRCODE = 'P0001';
  END IF;

  IF p_delta > 0 THEN
    SELECT COALESCE(SUM(hi.quantity_on_hand), 0) INTO v_tot_before
    FROM public.hub_inventory hi WHERE hi.raw_material_id = p_rm;
    SELECT COALESCE(r.weighted_avg_unit_cost, r.cost_price, 0) INTO v_old_avg
    FROM public.raw_materials r WHERE r.id = p_rm FOR UPDATE;
    IF v_tot_before <= 0 THEN
      v_new_avg := COALESCE(p_price, 0);
    ELSE
      v_new_avg := (v_tot_before * v_old_avg + p_delta * COALESCE(p_price, 0)) / (v_tot_before + p_delta);
    END IF;
    UPDATE public.raw_materials
       SET weighted_avg_unit_cost = COALESCE(v_new_avg, 0),
           cost_price = COALESCE(v_new_avg, cost_price),
           updated_at = now()
     WHERE id = p_rm;
  END IF;

  IF v_hub_row IS NULL THEN
    INSERT INTO public.hub_inventory (raw_material_id, quantity_on_hand, reserved_quantity, available_quantity, last_updated, updated_at)
    VALUES (p_rm, p_delta, 0, p_delta, now(), now());
  ELSE
    UPDATE public.hub_inventory hi
       SET quantity_on_hand = hi.quantity_on_hand + p_delta,
           available_quantity = (hi.quantity_on_hand + p_delta) - COALESCE(hi.reserved_quantity, 0),
           last_updated = now(),
           updated_at = now()
     WHERE hi.id = v_hub_row;
  END IF;
END;
$fn$;

-- status helper: per line, not totals
CREATE OR REPLACE FUNCTION public._po_line_status(p_po_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN COALESCE(SUM(quantity_received), 0) <= 0 THEN 'ordered'
    WHEN bool_and(quantity_received >= quantity_ordered) THEN 'received'
    ELSE 'partial' END
  FROM public.purchase_order_items WHERE purchase_order_id = p_po_id
$$;

-- 4. receive_po_shipment v2 ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.receive_po_shipment(p_po_id uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  rec jsonb;
  v_item_id uuid;
  v_target numeric;
  v_reason text;
  v_old numeric;
  v_ordered numeric;
  v_rm uuid;
  v_price numeric;
  v_po_check uuid;
  v_status text;
  v_tol numeric;
  v_limit numeric;
  v_is_admin boolean;
  v_delta numeric;
  v_qoh numeric;
  v_res numeric;
  v_hub_row uuid;
  v_audit jsonb := '[]'::jsonb;
  v_new_status text;
  v_ordered_total numeric;
  v_received_total numeric;
BEGIN
  IF NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Active admin or staff required');
  END IF;
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  SELECT po.status INTO v_status FROM public.purchase_orders po WHERE po.id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_found');
  END IF;
  IF v_status NOT IN ('ordered', 'partial') THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_receivable', 'status', v_status);
  END IF;

  v_tol := public._po_over_receipt_tolerance_pct();
  v_is_admin := public.is_profiles_admin();

  -- Phase 1: lock + validate every line, no writes.
  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_item_id := (rec->>'purchase_order_item_id')::uuid;
    v_target := (rec->>'quantity_received')::numeric;
    v_reason := NULLIF(btrim(rec->>'reason'), '');

    IF v_target IS NULL OR v_target < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity_received', 'item_id', v_item_id);
    END IF;

    SELECT poi.quantity_ordered, poi.quantity_received, poi.raw_material_id, poi.purchase_order_id
      INTO v_ordered, v_old, v_rm, v_po_check
    FROM public.purchase_order_items poi WHERE poi.id = v_item_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_item_not_found');
    END IF;
    IF v_po_check <> p_po_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_mismatch');
    END IF;

    v_limit := v_ordered * (1 + v_tol / 100);
    IF v_target > v_limit AND NOT (v_is_admin AND v_reason IS NOT NULL) THEN
      RETURN jsonb_build_object('success', false, 'error', 'over_tolerance_needs_admin_reason',
        'item_id', v_item_id, 'ordered', v_ordered, 'limit', v_limit, 'tolerance_pct', v_tol);
    END IF;

    v_delta := v_target - COALESCE(v_old, 0);
    IF v_delta < 0 AND v_rm IS NOT NULL THEN
      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0) INTO v_hub_row, v_qoh, v_res
      FROM public.hub_inventory hi WHERE hi.raw_material_id = v_rm
      ORDER BY hi.created_at ASC LIMIT 1 FOR UPDATE;
      IF v_hub_row IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'cannot_reduce_missing_hub_row');
      END IF;
      IF v_qoh + v_delta < v_res THEN
        RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved');
      END IF;
    END IF;
  END LOOP;

  -- Phase 2: apply. Unexpected failure RAISEs (txn abort).
  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_item_id := (rec->>'purchase_order_item_id')::uuid;
    v_target := (rec->>'quantity_received')::numeric;
    v_reason := NULLIF(btrim(rec->>'reason'), '');

    SELECT poi.quantity_ordered, poi.quantity_received, poi.raw_material_id, poi.unit_price
      INTO v_ordered, v_old, v_rm, v_price
    FROM public.purchase_order_items poi WHERE poi.id = v_item_id FOR UPDATE;

    v_delta := v_target - COALESCE(v_old, 0);

    UPDATE public.purchase_order_items
       SET quantity_received = v_target,
           line_total = v_target * COALESCE(v_price, 0)
     WHERE id = v_item_id;

    PERFORM public._po_apply_hub_delta(v_rm, v_delta, v_price);

    v_audit := v_audit || jsonb_build_object(
      'purchase_order_item_id', v_item_id,
      'raw_material_id', v_rm,
      'quantity_ordered', v_ordered,
      'previous_received', COALESCE(v_old, 0),
      'entered_received', v_target,
      'posted_delta', v_delta,
      'over_received', GREATEST(v_target - v_ordered, 0),
      'short_received', GREATEST(v_ordered - v_target, 0),
      'reason', v_reason);
  END LOOP;

  v_new_status := public._po_line_status(p_po_id);
  IF v_new_status = 'ordered' THEN v_new_status := v_status; END IF;

  SELECT COALESCE(SUM(quantity_ordered), 0), COALESCE(SUM(quantity_received), 0)
    INTO v_ordered_total, v_received_total
  FROM public.purchase_order_items WHERE purchase_order_id = p_po_id;

  UPDATE public.purchase_orders po
     SET status = v_new_status,
         actual_delivery_date = CASE WHEN v_new_status = 'received'
           THEN (timezone('Asia/Kuala_Lumpur', now()))::date ELSE po.actual_delivery_date END,
         updated_at = now()
   WHERE po.id = p_po_id;

  PERFORM public._append_data_ledger(
    'received', 'purchase_order', p_po_id::text, 'procurement', 'event', NULL,
    jsonb_build_object('status', v_status),
    jsonb_build_object('status', v_new_status, 'ordered_total', v_ordered_total, 'received_total', v_received_total),
    jsonb_build_object('lines', v_audit),
    jsonb_build_object('rpc', 'receive_po_shipment', 'version', 2, 'tolerance_pct', v_tol));

  RETURN jsonb_build_object(
    'success', true,
    'ordered_total', v_ordered_total,
    'received_total', v_received_total,
    'status', CASE WHEN v_new_status IN ('ordered') THEN 'unchanged' ELSE v_new_status END,
    'lines', v_audit);
END;
$function$;

-- 5. close_po_short ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_po_short(p_po_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_status text;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_short jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;
  SELECT status INTO v_status FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_found');
  END IF;
  IF v_status <> 'partial' THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_partial', 'status', v_status);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'purchase_order_item_id', id, 'quantity_ordered', quantity_ordered,
           'quantity_received', quantity_received,
           'short_received', GREATEST(quantity_ordered - quantity_received, 0))), '[]'::jsonb)
    INTO v_short
  FROM public.purchase_order_items WHERE purchase_order_id = p_po_id;

  UPDATE public.purchase_orders
     SET status = 'closed_short',
         actual_delivery_date = COALESCE(actual_delivery_date, (timezone('Asia/Kuala_Lumpur', now()))::date),
         updated_at = now()
   WHERE id = p_po_id;

  PERFORM public._append_data_ledger(
    'closed_short', 'purchase_order', p_po_id::text, 'procurement', 'event', NULL,
    jsonb_build_object('status', v_status), jsonb_build_object('status', 'closed_short'),
    jsonb_build_object('lines', v_short, 'stock_posted', 0),
    jsonb_build_object('rpc', 'close_po_short', 'reason', v_reason));

  RETURN jsonb_build_object('success', true, 'status', 'closed_short');
END;
$fn$;

-- 6. adjust_po_receipt ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_po_receipt(p_item_id uuid, p_new_qty numeric, p_reason text,
  p_keep_line_total boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_reason text := NULLIF(btrim(p_reason), '');
  v_po uuid; v_status text; v_old numeric; v_ordered numeric; v_rm uuid; v_price numeric;
  v_delta numeric; v_new_status text; v_line_total numeric; v_new_total numeric; v_new_price numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;
  IF p_new_qty IS NULL OR p_new_qty < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity_received');
  END IF;

  SELECT poi.purchase_order_id INTO v_po FROM public.purchase_order_items poi WHERE poi.id = p_item_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_item_not_found');
  END IF;
  SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po FOR UPDATE;
  IF v_status NOT IN ('partial', 'received', 'closed_short') THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_adjustable', 'status', v_status);
  END IF;

  SELECT quantity_received, quantity_ordered, raw_material_id, unit_price, line_total
    INTO v_old, v_ordered, v_rm, v_price, v_line_total
  FROM public.purchase_order_items WHERE id = p_item_id FOR UPDATE;

  v_delta := p_new_qty - COALESCE(v_old, 0);
  IF v_delta = 0 THEN
    RETURN jsonb_build_object('success', true, 'posted_delta', 0, 'status', v_status);
  END IF;

  IF COALESCE(p_keep_line_total, false) THEN
    IF p_new_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'keep_total_needs_positive_qty');
    END IF;
    v_new_total := COALESCE(v_line_total, COALESCE(v_old, 0) * COALESCE(v_price, 0));
    v_new_price := v_new_total / p_new_qty;
  ELSE
    v_new_total := p_new_qty * COALESCE(v_price, 0);
    v_new_price := v_price;
  END IF;

  BEGIN
    -- value posted with the delta = change in the receipt's value (0 when the invoice total is kept)
    PERFORM public._po_apply_hub_delta(v_rm, v_delta,
      (v_new_total - COALESCE(v_line_total, COALESCE(v_old, 0) * COALESCE(v_price, 0))) / v_delta);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  UPDATE public.purchase_order_items
     SET quantity_received = p_new_qty, line_total = v_new_total, unit_price = v_new_price
   WHERE id = p_item_id;

  v_new_status := public._po_line_status(v_po);
  IF v_new_status <> 'received' AND v_status = 'closed_short' THEN v_new_status := 'closed_short'; END IF;
  IF v_new_status = 'ordered' THEN v_new_status := 'partial'; END IF;

  UPDATE public.purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_po;

  PERFORM public._append_data_ledger(
    'receipt_adjusted', 'purchase_order', v_po::text, 'procurement', 'update', p_item_id::text,
    jsonb_build_object('quantity_received', COALESCE(v_old, 0), 'status', v_status),
    jsonb_build_object('quantity_received', p_new_qty, 'status', v_new_status),
    jsonb_build_object('purchase_order_item_id', p_item_id, 'raw_material_id', v_rm,
                       'quantity_ordered', v_ordered, 'posted_delta', v_delta,
                       'keep_line_total', COALESCE(p_keep_line_total, false),
                       'line_total_before', v_line_total, 'line_total_after', v_new_total,
                       'unit_price_before', v_price, 'unit_price_after', v_new_price),
    jsonb_build_object('rpc', 'adjust_po_receipt', 'reason', v_reason));

  RETURN jsonb_build_object('success', true, 'posted_delta', v_delta, 'status', v_new_status);
END;
$fn$;

-- grants -------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._po_apply_hub_delta(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._po_line_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._po_over_receipt_tolerance_pct() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receive_po_shipment(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_po_short(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adjust_po_receipt(uuid, numeric, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_po_shipment(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_po_short(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_po_receipt(uuid, numeric, text, boolean) TO authenticated;

-- RLS: closing short is admin-only (defence in depth; direct status writes are already admin-only live)
DROP POLICY IF EXISTS purchase_orders_closed_short_admin_only ON public.purchase_orders;
CREATE POLICY purchase_orders_closed_short_admin_only ON public.purchase_orders
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (status IS DISTINCT FROM 'closed_short' OR public.is_profiles_admin());
