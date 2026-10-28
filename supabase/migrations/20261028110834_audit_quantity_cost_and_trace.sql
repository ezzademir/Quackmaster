-- Audit fixes against the live functions (receipt variance, cancel requests,
-- blind stock take, recipe-SKU reconcile). Older function bodies are not restored.
-- Hub quantity is numeric(14,4). Base deltas are rounded to that scale.
-- No backfill of historical weighted average, stock, or lot inputs.

CREATE TABLE IF NOT EXISTS public.inventory_lot_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES public.inventory_lots(id) ON DELETE CASCADE,
  source_lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL,
  raw_material_id uuid REFERENCES public.raw_materials(id),
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_lot_inputs_lot_id_idx
  ON public.inventory_lot_inputs (lot_id);

ALTER TABLE public.inventory_lot_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view inventory_lot_inputs" ON public.inventory_lot_inputs;
CREATE POLICY "Authenticated users can view inventory_lot_inputs"
  ON public.inventory_lot_inputs
  FOR SELECT
  TO authenticated
  USING (true);

REVOKE ALL ON TABLE public.inventory_lot_inputs FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.inventory_lot_inputs TO authenticated;

CREATE OR REPLACE FUNCTION public._po_line_base_ratio(p_ordered numeric, p_ordered_base numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_ordered IS NULL OR p_ordered = 0 THEN 1
    WHEN p_ordered_base IS NULL OR p_ordered_base <= 0 THEN 1
    ELSE p_ordered_base / p_ordered
  END;
$$;

REVOKE ALL ON FUNCTION public._po_line_base_ratio(numeric, numeric) FROM PUBLIC, anon, authenticated;

-- Weighted average follows a reduced receipt. Callers pass base-unit delta and price per base unit.
CREATE OR REPLACE FUNCTION public._po_apply_hub_delta(p_rm uuid, p_delta numeric, p_price numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_hub_row uuid;
  v_qoh numeric;
  v_res numeric;
  v_tot_before numeric;
  v_old_avg numeric;
  v_new_avg numeric;
  v_remove numeric;
BEGIN
  IF p_delta = 0 OR p_rm IS NULL THEN
    RETURN;
  END IF;

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

  SELECT COALESCE(SUM(hi.quantity_on_hand), 0)
    INTO v_tot_before
  FROM public.hub_inventory hi
  WHERE hi.raw_material_id = p_rm;

  SELECT COALESCE(r.weighted_avg_unit_cost, r.cost_price, 0)
    INTO v_old_avg
  FROM public.raw_materials r
  WHERE r.id = p_rm
  FOR UPDATE;

  IF p_delta > 0 THEN
    IF v_tot_before <= 0 THEN
      v_new_avg := COALESCE(p_price, 0);
    ELSE
      v_new_avg := (v_tot_before * v_old_avg + p_delta * COALESCE(p_price, 0)) / (v_tot_before + p_delta);
    END IF;
  ELSE
    v_remove := -p_delta;
    IF v_tot_before <= 0 THEN
      v_new_avg := v_old_avg;
    ELSIF (v_tot_before - v_remove) <= 0 THEN
      v_new_avg := COALESCE(p_price, v_old_avg);
    ELSE
      v_new_avg := (v_old_avg * v_tot_before - v_remove * COALESCE(p_price, 0)) / (v_tot_before - v_remove);
      IF v_new_avg IS NULL OR v_new_avg < 0 THEN
        v_new_avg := v_old_avg;
      END IF;
    END IF;
  END IF;

  UPDATE public.raw_materials
     SET weighted_avg_unit_cost = COALESCE(v_new_avg, 0),
         cost_price = COALESCE(v_new_avg, cost_price),
         updated_at = now()
   WHERE id = p_rm;

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
$$;

CREATE OR REPLACE FUNCTION public.receive_po_shipment(p_po_id uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  rec jsonb;
  v_item_id uuid;
  v_target numeric;
  v_reason text;
  v_old numeric;
  v_ordered numeric;
  v_ordered_base numeric;
  v_rm uuid;
  v_price numeric;
  v_uom text;
  v_ratio numeric;
  v_delta numeric;
  v_delta_base numeric;
  v_price_base numeric;
  v_po_check uuid;
  v_status text;
  v_tol numeric;
  v_limit numeric;
  v_is_admin boolean;
  v_qoh numeric;
  v_res numeric;
  v_hub_row uuid;
  v_audit jsonb := '[]'::jsonb;
  v_new_status text;
  v_ordered_total numeric;
  v_received_total numeric;
BEGIN
  IF NOT (public.is_authenticated_active_staff() OR public._consume_po_receipt_ticket(p_po_id)) THEN
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

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_item_id := (rec->>'purchase_order_item_id')::uuid;
    v_target := (rec->>'quantity_received')::numeric;
    v_reason := NULLIF(btrim(rec->>'reason'), '');

    IF v_target IS NULL OR v_target < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity_received', 'item_id', v_item_id);
    END IF;

    SELECT poi.quantity_ordered, poi.quantity_ordered_base, poi.quantity_received, poi.raw_material_id,
           poi.purchase_order_id, poi.unit_price, poi.purchase_uom
      INTO v_ordered, v_ordered_base, v_old, v_rm, v_po_check, v_price, v_uom
    FROM public.purchase_order_items poi
    WHERE poi.id = v_item_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_item_not_found');
    END IF;
    IF v_po_check <> p_po_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_mismatch');
    END IF;

    IF v_uom IS NOT NULL AND btrim(v_uom) <> '' THEN
      PERFORM 1
      FROM public.material_units mu
      WHERE mu.raw_material_id = v_rm
        AND lower(btrim(mu.uom_code)) = lower(btrim(v_uom))
        AND mu.ratio_to_base IS NOT NULL
        AND mu.ratio_to_base > 0;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_purchase_ratio', 'item_id', v_item_id);
      END IF;
    END IF;

    v_ratio := public._po_line_base_ratio(v_ordered, v_ordered_base);
    v_limit := v_ordered * (1 + v_tol / 100);
    IF v_target > v_limit AND NOT (v_is_admin AND v_reason IS NOT NULL) THEN
      RETURN jsonb_build_object('success', false, 'error', 'over_tolerance_needs_admin_reason',
        'item_id', v_item_id, 'ordered', v_ordered, 'limit', v_limit, 'tolerance_pct', v_tol);
    END IF;

    v_delta := v_target - COALESCE(v_old, 0);
    v_delta_base := round(v_delta * v_ratio, 4);
    IF v_delta <> 0 AND v_delta_base = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'base_quantity_rounds_to_zero', 'item_id', v_item_id);
    END IF;

    IF v_delta_base < 0 AND v_rm IS NOT NULL THEN
      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
        INTO v_hub_row, v_qoh, v_res
      FROM public.hub_inventory hi
      WHERE hi.raw_material_id = v_rm
      ORDER BY hi.created_at ASC
      LIMIT 1
      FOR UPDATE;
      IF v_hub_row IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'cannot_reduce_missing_hub_row');
      END IF;
      IF v_qoh + v_delta_base < v_res THEN
        RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved');
      END IF;
    END IF;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_item_id := (rec->>'purchase_order_item_id')::uuid;
    v_target := (rec->>'quantity_received')::numeric;
    v_reason := NULLIF(btrim(rec->>'reason'), '');

    SELECT poi.quantity_ordered, poi.quantity_ordered_base, poi.quantity_received, poi.raw_material_id, poi.unit_price
      INTO v_ordered, v_ordered_base, v_old, v_rm, v_price
    FROM public.purchase_order_items poi
    WHERE poi.id = v_item_id
    FOR UPDATE;

    v_ratio := public._po_line_base_ratio(v_ordered, v_ordered_base);
    v_delta := v_target - COALESCE(v_old, 0);
    v_delta_base := round(v_delta * v_ratio, 4);
    v_price_base := COALESCE(v_price, 0) / v_ratio;
    IF v_delta <> 0 AND v_delta_base = 0 THEN
      RAISE EXCEPTION 'base_quantity_rounds_to_zero' USING ERRCODE = 'P0001';
    END IF;

    -- line_total stays the order commitment (ordered × price).
    UPDATE public.purchase_order_items
       SET quantity_received = v_target
     WHERE id = v_item_id;

    PERFORM public._po_apply_hub_delta(v_rm, v_delta_base, v_price_base);

    v_audit := v_audit || jsonb_build_object(
      'purchase_order_item_id', v_item_id,
      'raw_material_id', v_rm,
      'quantity_ordered', v_ordered,
      'previous_received', COALESCE(v_old, 0),
      'entered_received', v_target,
      'posted_delta', v_delta,
      'posted_delta_base', v_delta_base,
      'over_received', GREATEST(v_target - v_ordered, 0),
      'short_received', GREATEST(v_ordered - v_target, 0),
      'reason', v_reason);
  END LOOP;

  v_new_status := public._po_line_status(p_po_id);
  IF v_new_status = 'ordered' THEN
    v_new_status := v_status;
  END IF;

  SELECT COALESCE(SUM(quantity_ordered), 0), COALESCE(SUM(quantity_received), 0)
    INTO v_ordered_total, v_received_total
  FROM public.purchase_order_items
  WHERE purchase_order_id = p_po_id;

  UPDATE public.purchase_orders po
     SET status = v_new_status,
         actual_delivery_date = CASE
           WHEN v_new_status = 'received' THEN (timezone('Asia/Kuala_Lumpur', now()))::date
           ELSE po.actual_delivery_date
         END,
         updated_at = now()
   WHERE po.id = p_po_id;

  PERFORM public._append_data_ledger(
    'received', 'purchase_order', p_po_id::text, 'procurement', 'event', NULL,
    jsonb_build_object('status', v_status),
    jsonb_build_object('status', v_new_status, 'ordered_total', v_ordered_total, 'received_total', v_received_total),
    jsonb_build_object('lines', v_audit),
    jsonb_build_object('rpc', 'receive_po_shipment', 'version', 3, 'tolerance_pct', v_tol));

  RETURN jsonb_build_object(
    'success', true,
    'ordered_total', v_ordered_total,
    'received_total', v_received_total,
    'status', CASE WHEN v_new_status IN ('ordered') THEN 'unchanged' ELSE v_new_status END,
    'lines', v_audit);
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_po_receipt(
  p_item_id uuid,
  p_new_qty numeric,
  p_reason text,
  p_keep_line_total boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text := NULLIF(btrim(p_reason), '');
  v_po uuid;
  v_status text;
  v_old numeric;
  v_ordered numeric;
  v_ordered_base numeric;
  v_rm uuid;
  v_price numeric;
  v_uom text;
  v_ratio numeric;
  v_delta numeric;
  v_delta_base numeric;
  v_price_base numeric;
  v_new_status text;
  v_line_total numeric;
  v_new_total numeric;
  v_new_price numeric;
  v_value_change numeric;
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

  SELECT quantity_received, quantity_ordered, quantity_ordered_base, raw_material_id, unit_price, line_total, purchase_uom
    INTO v_old, v_ordered, v_ordered_base, v_rm, v_price, v_line_total, v_uom
  FROM public.purchase_order_items
  WHERE id = p_item_id
  FOR UPDATE;

  IF v_uom IS NOT NULL AND btrim(v_uom) <> '' THEN
    PERFORM 1
    FROM public.material_units mu
    WHERE mu.raw_material_id = v_rm
      AND lower(btrim(mu.uom_code)) = lower(btrim(v_uom))
      AND mu.ratio_to_base IS NOT NULL
      AND mu.ratio_to_base > 0;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_purchase_ratio');
    END IF;
  END IF;

  v_delta := p_new_qty - COALESCE(v_old, 0);
  IF v_delta = 0 THEN
    RETURN jsonb_build_object('success', true, 'posted_delta', 0, 'status', v_status);
  END IF;

  v_ratio := public._po_line_base_ratio(v_ordered, v_ordered_base);
  v_delta_base := round(v_delta * v_ratio, 4);
  IF v_delta_base = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'base_quantity_rounds_to_zero');
  END IF;

  IF COALESCE(p_keep_line_total, false) THEN
    IF p_new_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'keep_total_needs_positive_qty');
    END IF;
    v_new_total := COALESCE(v_line_total, COALESCE(v_old, 0) * COALESCE(v_price, 0));
    v_new_price := v_new_total / p_new_qty;
    v_value_change := v_new_total - COALESCE(v_line_total, COALESCE(v_old, 0) * COALESCE(v_price, 0));
    v_price_base := (v_value_change / v_delta) / v_ratio;
  ELSE
    v_new_total := p_new_qty * COALESCE(v_price, 0);
    v_new_price := v_price;
    v_price_base := COALESCE(v_price, 0) / v_ratio;
  END IF;

  BEGIN
    PERFORM public._po_apply_hub_delta(v_rm, v_delta_base, v_price_base);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  UPDATE public.purchase_order_items
     SET quantity_received = p_new_qty,
         line_total = v_new_total,
         unit_price = v_new_price
   WHERE id = p_item_id;

  v_new_status := public._po_line_status(v_po);
  IF v_new_status <> 'received' AND v_status = 'closed_short' THEN
    v_new_status := 'closed_short';
  END IF;
  IF v_new_status = 'ordered' THEN
    v_new_status := 'partial';
  END IF;

  UPDATE public.purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_po;

  PERFORM public._append_data_ledger(
    'receipt_adjusted', 'purchase_order', v_po::text, 'procurement', 'update', p_item_id::text,
    jsonb_build_object('quantity_received', COALESCE(v_old, 0), 'status', v_status),
    jsonb_build_object('quantity_received', p_new_qty, 'status', v_new_status),
    jsonb_build_object('purchase_order_item_id', p_item_id, 'raw_material_id', v_rm,
                       'quantity_ordered', v_ordered, 'posted_delta', v_delta, 'posted_delta_base', v_delta_base,
                       'keep_line_total', COALESCE(p_keep_line_total, false),
                       'line_total_before', v_line_total, 'line_total_after', v_new_total,
                       'unit_price_before', v_price, 'unit_price_after', v_new_price),
    jsonb_build_object('rpc', 'adjust_po_receipt', 'reason', v_reason));

  RETURN jsonb_build_object('success', true, 'posted_delta', v_delta, 'status', v_new_status);
END;
$$;

-- Cancel reverses the snapshotted base quantity. A deleted unit row does not block the reversal.
CREATE OR REPLACE FUNCTION public._po_cancel_plan(p_po_id uuid)
RETURNS TABLE(item_id uuid, rm_id uuid, tag text, qty numeric, price numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH li AS (
    SELECT
      poi.id,
      poi.raw_material_id,
      round(
        COALESCE(poi.quantity_received, 0) * public._po_line_base_ratio(poi.quantity_ordered, poi.quantity_ordered_base),
        4
      ) AS q,
      COALESCE(poi.unit_price, 0) / public._po_line_base_ratio(poi.quantity_ordered, poi.quantity_ordered_base) AS p
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = p_po_id
      AND COALESCE(poi.quantity_received, 0) > 0
  ),
  tg AS (
    SELECT li.id, m.entity_code, LEAST(SUM(m.quantity), li.q) AS q
    FROM li
    JOIN public.hub_stock_movements m ON m.source_po_item_id = li.id AND m.entity_code IS NOT NULL
    GROUP BY li.id, li.q, m.entity_code
    HAVING SUM(m.quantity) > 0
  )
  SELECT tg.id, li.raw_material_id, tg.entity_code, tg.q, li.p
  FROM tg
  JOIN li ON li.id = tg.id
  UNION ALL
  SELECT li.id, li.raw_material_id, NULL::text,
         li.q - COALESCE((SELECT SUM(tg.q) FROM tg WHERE tg.id = li.id), 0),
         li.p
  FROM li
  WHERE li.q - COALESCE((SELECT SUM(tg.q) FROM tg WHERE tg.id = li.id), 0) > 0;
$$;

REVOKE ALL ON FUNCTION public._po_cancel_plan(uuid) FROM PUBLIC, anon, authenticated;

-- Production consumes unreserved hub stock, oldest row first, and records every ingredient.
CREATE OR REPLACE FUNCTION public.post_production_completion_inventory(
  p_production_run_id uuid,
  p_product_batch text,
  p_finished_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  pr RECORD;
  rec RECORD;
  mat RECORD;
  hub RECORD;
  v_sku text;
  v_lot_label text;
  v_lot_id uuid;
  v_parent_lot uuid;
  v_mfg date;
  v_expiry date;
  v_out_id uuid;
  v_iso timestamptz := now();
  v_unreserved numeric;
  v_rows int;
  v_need numeric;
  v_take numeric;
  v_inputs jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_finished_quantity IS NULL OR p_finished_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_finished_quantity');
  END IF;

  SELECT * INTO pr FROM public.production_runs WHERE id = p_production_run_id FOR UPDATE;
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

  FOR mat IN
    SELECT prm.raw_material_id, SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(GREATEST(hi.quantity_on_hand - COALESCE(hi.reserved_quantity, 0), 0)), 0),
           COUNT(*)::int
      INTO v_unreserved, v_rows
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    FOR UPDATE;

    IF v_rows = 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'raw_material_hub_row_missing',
        'raw_material_id', mat.raw_material_id
      );
    END IF;
    IF v_unreserved < mat.quantity_consumed THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_raw_material',
        'raw_material_id', mat.raw_material_id,
        'on_hand', v_unreserved,
        'required', mat.quantity_consumed
      );
    END IF;
  END LOOP;

  FOR mat IN
    SELECT prm.raw_material_id, SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    v_need := mat.quantity_consumed;
    FOR hub IN
      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0) AS reserved_qty, hi.lot_id
      FROM public.hub_inventory hi
      WHERE hi.raw_material_id = mat.raw_material_id
        AND hi.quantity_on_hand > COALESCE(hi.reserved_quantity, 0)
      ORDER BY hi.created_at ASC NULLS LAST, hi.id
      FOR UPDATE
    LOOP
      v_take := LEAST(v_need, hub.quantity_on_hand - hub.reserved_qty);
      IF v_take <= 0 THEN
        CONTINUE;
      END IF;

      UPDATE public.hub_inventory hi
      SET quantity_on_hand = hi.quantity_on_hand - v_take,
          available_quantity = (hi.quantity_on_hand - v_take) - COALESCE(hi.reserved_quantity, 0),
          last_updated = v_iso,
          updated_at = v_iso
      WHERE hi.id = hub.id;

      v_inputs := v_inputs || jsonb_build_array(jsonb_build_object(
        'raw_material_id', mat.raw_material_id,
        'source_lot_id', hub.lot_id,
        'quantity', v_take
      ));
      IF v_parent_lot IS NULL AND hub.lot_id IS NOT NULL THEN
        v_parent_lot := hub.lot_id;
      END IF;
      v_need := v_need - v_take;
      EXIT WHEN v_need <= 0;
    END LOOP;

    IF v_need > 0 THEN
      RAISE EXCEPTION 'insufficient_raw_material'
        USING ERRCODE = 'P0001',
              DETAIL = format('have shortfall %s rm %s', v_need, mat.raw_material_id);
    END IF;
  END LOOP;

  IF rec.default_product_batch IS NULL OR trim(both from rec.default_product_batch) = '' THEN
    UPDATE public.recipes
    SET default_product_batch = v_sku, updated_at = v_iso
    WHERE id = pr.recipe_id;
  END IF;

  IF p_finished_quantity > 0 THEN
    INSERT INTO public.inventory_lots (
      product_batch_label, expiry_date, manufactured_at, parent_lot_id, production_run_id, created_at, updated_at
    ) VALUES (
      v_lot_label, v_expiry, v_mfg::timestamptz, v_parent_lot, p_production_run_id, v_iso, v_iso
    )
    RETURNING id INTO v_lot_id;

    INSERT INTO public.inventory_lot_inputs (lot_id, source_lot_id, raw_material_id, quantity)
    SELECT v_lot_id,
           NULLIF(elem->>'source_lot_id', '')::uuid,
           NULLIF(elem->>'raw_material_id', '')::uuid,
           (elem->>'quantity')::numeric
    FROM jsonb_array_elements(v_inputs) elem
    WHERE COALESCE((elem->>'quantity')::numeric, 0) > 0;

    INSERT INTO public.hub_inventory (
      product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity, last_updated, updated_at
    ) VALUES (
      v_sku, v_lot_id, p_finished_quantity, 0, p_finished_quantity, v_iso, v_iso
    )
    RETURNING id INTO v_out_id;
  END IF;

  UPDATE public.production_runs
  SET status = 'completed', updated_at = v_iso
  WHERE id = p_production_run_id;

  PERFORM public._append_data_ledger(
    'inventory_posted', 'production_run', p_production_run_id::text, 'production', 'event',
    NULL,
    jsonb_build_object(
      'hub_inventory_id', v_out_id,
      'product_batch', v_sku,
      'lot_id', v_lot_id,
      'lot_label', v_lot_label,
      'finished_quantity', p_finished_quantity,
      'inputs', v_inputs
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

-- Sum overlapping waste lines before the existing poster runs. The poster still allocates FEFO.
ALTER FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid)
  RENAME TO _post_waste_event_apply;

CREATE OR REPLACE FUNCTION public.post_waste_event(
  p_location_kind text,
  p_outlet_id uuid,
  p_waste_date date,
  p_lines jsonb,
  p_notes text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_existing uuid;
  demand RECORD;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.waste_events
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'waste_event_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_location_kind = 'hub' AND p_lines IS NOT NULL AND jsonb_typeof(p_lines) = 'array' THEN
    FOR demand IN
      SELECT (line->>'hub_inventory_id')::uuid AS hub_id,
             SUM((line->>'quantity')::numeric) AS qty
      FROM jsonb_array_elements(p_lines) line
      WHERE COALESCE(line->>'hub_inventory_id', '') ~* '^[0-9a-f-]{36}$'
      GROUP BY 1
    LOOP
      SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
        INTO v_qoh, v_res
      FROM public.hub_inventory hi
      WHERE hi.id = demand.hub_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_not_found');
      END IF;
      IF (v_qoh - v_res) < demand.qty THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'insufficient_hub_available',
          'hub_inventory_id', demand.hub_id,
          'requested', demand.qty,
          'available', v_qoh - v_res
        );
      END IF;
    END LOOP;
  ELSIF p_location_kind = 'outlet' AND p_lines IS NOT NULL AND jsonb_typeof(p_lines) = 'array' THEN
    FOR demand IN
      SELECT (line->>'outlet_inventory_id')::uuid AS inv_id,
             SUM((line->>'quantity')::numeric) AS qty
      FROM jsonb_array_elements(p_lines) line
      WHERE COALESCE(line->>'outlet_inventory_id', '') ~* '^[0-9a-f-]{36}$'
      GROUP BY 1
    LOOP
      SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.id = demand.inv_id
        AND oi.outlet_id = p_outlet_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_not_found', 'outlet_inventory_id', demand.inv_id);
      END IF;
      IF (v_qoh - v_res) < demand.qty THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'insufficient_outlet_available',
          'outlet_inventory_id', demand.inv_id,
          'requested', demand.qty,
          'available', v_qoh - v_res
        );
      END IF;
    END LOOP;

    FOR demand IN
      SELECT btrim(line->>'product_batch') AS batch,
             SUM((line->>'quantity')::numeric) AS qty
      FROM jsonb_array_elements(p_lines) line
      WHERE COALESCE(line->>'outlet_inventory_id', '') !~* '^[0-9a-f-]{36}$'
        AND btrim(COALESCE(line->>'product_batch', '')) <> ''
      GROUP BY 1
    LOOP
      SELECT COALESCE(SUM(GREATEST(oi.quantity_on_hand - COALESCE(oi.reserved_quantity, 0), 0)), 0)
        INTO v_avail
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      WHERE oi.outlet_id = p_outlet_id
        AND oi.quantity_on_hand > 0
        AND public.fg_identifier_matches(
          oi.product_batch,
          il.product_batch_label,
          public.fg_recipe_sku(oi.lot_id),
          demand.batch
        )
      FOR UPDATE OF oi;
      IF v_avail < demand.qty THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'insufficient_outlet_available',
          'product_batch', demand.batch,
          'requested', demand.qty,
          'available', v_avail
        );
      END IF;
    END LOOP;
  END IF;

  RETURN public._post_waste_event_apply(
    p_location_kind, p_outlet_id, p_waste_date, p_lines, p_notes, p_idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public._post_waste_event_apply(text, uuid, date, jsonb, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_outlet_stock_take(
  p_session_id uuid,
  p_lines jsonb,
  p_notes text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sess public.outlet_stock_take_sessions%ROWTYPE;
  v_existing uuid;
  rec jsonb;
  v_oi_id uuid;
  v_lot uuid;
  v_counted numeric;
  v_remark text;
  v_qoh numeric;
  v_res numeric;
  v_var numeric;
  v_open numeric;
  v_moved numeric;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_lines_out jsonb := '[]'::jsonb;
  v_n int := 0;
  v_updated int;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.outlet_stock_take_sessions
    WHERE idempotency_key = p_idempotency_key AND status = 'posted';
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'session_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  SELECT * INTO v_sess FROM public.outlet_stock_take_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
  END IF;
  IF v_uid IS NULL OR NOT public.profile_can_post_outlet_stock_take(v_sess.outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;
  IF v_sess.status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_open');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_oi_id := NULLIF(trim(both from coalesce(rec->>'outlet_inventory_id', '')), '')::uuid;
    v_counted := NULLIF(trim(both from coalesce(rec->>'counted_qty', '')), '')::numeric;
    IF v_oi_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;
    IF v_oi_id = ANY (v_seen) THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_outlet_inventory_id');
    END IF;
    v_seen := v_seen || v_oi_id;

    SELECT COALESCE(oi.reserved_quantity, 0)
      INTO v_res
    FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id AND oi.outlet_id = v_sess.outlet_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_not_found');
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

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_oi_id := (rec->>'outlet_inventory_id')::uuid;
    v_counted := (rec->>'counted_qty')::numeric;
    v_remark := NULLIF(trim(both from rec->>'line_remark'), '');

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0), oi.lot_id
      INTO v_qoh, v_res, v_lot
    FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id;

    IF v_counted < v_res THEN
      RAISE EXCEPTION 'counted_below_reserved' USING ERRCODE = 'P0001';
    END IF;

    v_var := v_counted - v_qoh;
    SELECT ob.qoh_at_open INTO v_open
    FROM public.outlet_stock_take_open_balances ob
    WHERE ob.session_id = v_sess.id AND ob.outlet_inventory_id = v_oi_id;
    v_open := COALESCE(v_open, 0);
    v_moved := v_qoh - v_open;

    PERFORM public._set_outlet_movement_ctx(
      v_sess.outlet_id, 'stock_take', v_sess.count_date, 'outlet_stock_take', v_sess.id,
      jsonb_build_object('blind', true)
    );
    UPDATE public.outlet_inventory oi
    SET quantity_on_hand = v_counted,
        available_quantity = v_counted - v_res,
        last_updated = now(),
        updated_at = now()
    WHERE oi.id = v_oi_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    PERFORM public._clear_outlet_movement_ctx();
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'outlet_inventory_not_found' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.outlet_stock_take_lines (
      session_id, outlet_inventory_id, system_qoh_before, counted_qty, variance, line_remark, lot_id,
      system_qoh_at_open, qty_moved_during_count
    ) VALUES (
      v_sess.id, v_oi_id, v_qoh, v_counted, v_var, v_remark, v_lot, v_open, v_moved
    );

    v_lines_out := v_lines_out || jsonb_build_array(jsonb_build_object(
      'outlet_inventory_id', v_oi_id,
      'lot_id', v_lot,
      'system_qoh_before', v_qoh,
      'counted_qty', v_counted,
      'variance', v_var,
      'system_qoh_at_open', v_open,
      'qty_moved_during_count', v_moved
    ));
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.outlet_stock_take_sessions
  SET status = 'posted',
      posted_at = now(),
      notes = COALESCE(NULLIF(trim(both from p_notes), ''), notes),
      idempotency_key = COALESCE(p_idempotency_key, idempotency_key)
  WHERE id = v_sess.id;

  PERFORM public._append_data_ledger(
    'posted', 'outlet_stock_take', v_sess.id::text, 'inventory', 'event', NULL, NULL,
    jsonb_build_object('outlet_id', v_sess.outlet_id, 'count_date', v_sess.count_date, 'blind', true, 'lines', v_lines_out),
    NULL,
    jsonb_build_object('notes', COALESCE(NULLIF(trim(both from p_notes), ''), v_sess.notes))
  );

  PERFORM public._post_stock_take_snapshot_hook(v_sess.outlet_id, v_sess.count_date);

  IF public.can_view_stock_take_variance() THEN
    RETURN jsonb_build_object('success', true, 'session_id', v_sess.id, 'lines_counted', v_n, 'lines', v_lines_out);
  END IF;
  RETURN jsonb_build_object('success', true, 'session_id', v_sess.id, 'lines_counted', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_outlet_stock(
  p_outlet_id uuid,
  p_from date,
  p_to date,
  p_include_raw_materials boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_opening numeric := 0;
  v_live numeric := 0;
  v_supply_in numeric := 0;
  v_transfers_in numeric := 0;
  v_transfers_out numeric := 0;
  v_sales numeric := 0;
  v_waste numeric := 0;
  v_stock_take numeric := 0;
  v_reversals numeric := 0;
  v_computed numeric;
  v_after numeric := 0;
  v_in_transit_supply numeric := 0;
  v_in_transit_transfer numeric := 0;
  v_last_stock_take jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF public.stock_qty_hidden_for_outlet(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'stock_take_in_progress');
  END IF;

  SELECT COALESCE(SUM(osm.signed_qty), 0)
    INTO v_opening
  FROM public.outlet_stock_movements osm
  JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
  WHERE osm.outlet_id = p_outlet_id
    AND osm.business_date < p_from
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  SELECT
    COALESCE(SUM(CASE WHEN osm.movement_type = 'supply_in' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_in' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_out' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'sale' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'waste' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'stock_take' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type IN ('reversal', 'admin_adjust') THEN osm.signed_qty ELSE 0 END), 0)
  INTO v_supply_in, v_transfers_in, v_transfers_out, v_sales, v_waste, v_stock_take, v_reversals
  FROM public.outlet_stock_movements osm
  JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
  WHERE osm.outlet_id = p_outlet_id
    AND osm.business_date >= p_from
    AND osm.business_date <= p_to
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  SELECT COALESCE(SUM(osm.signed_qty), 0)
    INTO v_after
  FROM public.outlet_stock_movements osm
  JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
  WHERE osm.outlet_id = p_outlet_id
    AND osm.business_date > p_to
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
    INTO v_live
  FROM public.outlet_inventory oi
  WHERE oi.outlet_id = p_outlet_id
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  v_computed := v_opening + v_supply_in + v_transfers_in + v_transfers_out + v_sales + v_waste + v_stock_take + v_reversals;

  SELECT COALESCE(SUM(so.total_quantity), 0)
    INTO v_in_transit_supply
  FROM public.supply_orders so
  WHERE so.outlet_id = p_outlet_id
    AND lower(trim(so.status::text)) = 'dispatched';

  SELECT COALESCE(SUM(ot.total_quantity), 0)
    INTO v_in_transit_transfer
  FROM public.outlet_transfers ot
  WHERE ot.to_outlet_id = p_outlet_id
    AND lower(trim(ot.status::text)) = 'dispatched';

  SELECT jsonb_build_object(
    'session_id', sts.id,
    'count_date', sts.count_date,
    'total_variance', COALESCE(SUM(stl.variance), 0)
  )
  INTO v_last_stock_take
  FROM public.outlet_stock_take_sessions sts
  LEFT JOIN public.outlet_stock_take_lines stl ON stl.session_id = sts.id
  WHERE sts.outlet_id = p_outlet_id
  GROUP BY sts.id, sts.count_date, sts.posted_at
  ORDER BY sts.posted_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'outlet_id', p_outlet_id,
    'period_from', p_from,
    'period_to', p_to,
    'include_raw_materials', p_include_raw_materials,
    'opening_qoh', v_opening,
    'supply_in', v_supply_in,
    'transfers_in', v_transfers_in,
    'transfers_out', v_transfers_out,
    'sales', v_sales,
    'waste', v_waste,
    'stock_take_adjustments', v_stock_take,
    'reversals', v_reversals,
    'computed_closing', v_computed,
    'movements_after', v_after,
    'live_on_hand', v_live,
    'unexplained_variance', v_live - (v_computed + v_after),
    'in_transit_supply', v_in_transit_supply,
    'in_transit_transfer', v_in_transit_transfer,
    'last_stock_take', COALESCE(v_last_stock_take, 'null'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_outlet_stock_by_sku(
  p_outlet_id uuid,
  p_from date,
  p_to date,
  p_include_raw_materials boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rows jsonb := '[]'::jsonb;
  r RECORD;
  v_opening numeric;
  v_supply_in numeric;
  v_transfers_in numeric;
  v_transfers_out numeric;
  v_sales numeric;
  v_waste numeric;
  v_stock_take numeric;
  v_reversals numeric;
  v_computed numeric;
  v_live numeric;
  v_after numeric;
  v_in_supply numeric;
  v_in_transfer numeric;
  v_key text;
  v_label text;
  v_kind text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF public.stock_qty_hidden_for_outlet(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'stock_take_in_progress');
  END IF;

  FOR r IN
    SELECT sku_key, kind, label, raw_material_id, product_batch
    FROM (
      SELECT DISTINCT ON (sku_key)
        sku_key, kind, label, raw_material_id, product_batch
      FROM (
        SELECT
          CASE
            WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
            ELSE 'fg:' || COALESCE(
              NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
              NULLIF(trim(both from oi.product_batch), ''),
              oi.id::text
            )
          END AS sku_key,
          CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END AS kind,
          COALESCE(
            MAX(rm.name),
            MAX(NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), '')),
            MAX(
              CASE
                WHEN oi.product_batch ~* '^BATCH-[0-9a-f-]+$' THEN NULL
                ELSE NULLIF(trim(both from oi.product_batch), '')
              END
            ),
            '—'
          ) AS label,
          oi.raw_material_id,
          CASE
            WHEN oi.raw_material_id IS NOT NULL THEN NULL
            ELSE COALESCE(
              NULLIF(trim(both from MAX(public.fg_recipe_sku(oi.lot_id))), ''),
              MAX(
                CASE
                  WHEN oi.product_batch ~* '^BATCH-[0-9a-f-]+$' THEN NULL
                  ELSE NULLIF(trim(both from oi.product_batch), '')
                END
              )
            )
          END AS product_batch,
          0 AS priority
        FROM public.outlet_inventory oi
        LEFT JOIN public.raw_materials rm ON rm.id = oi.raw_material_id
        WHERE oi.outlet_id = p_outlet_id
          AND (p_include_raw_materials OR oi.raw_material_id IS NULL)
        GROUP BY
          CASE
            WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
            ELSE 'fg:' || COALESCE(
              NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
              NULLIF(trim(both from oi.product_batch), ''),
              oi.id::text
            )
          END,
          CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END,
          oi.raw_material_id

        UNION ALL

        SELECT
          CASE
            WHEN hi.raw_material_id IS NOT NULL THEN 'rm:' || hi.raw_material_id::text
            ELSE 'fg:' || COALESCE(
              NULLIF(trim(both from public.fg_recipe_sku(hi.lot_id)), ''),
              NULLIF(trim(both from hi.product_batch), ''),
              hi.id::text
            )
          END,
          CASE WHEN hi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END,
          COALESCE(rm.name, NULLIF(trim(both from hi.product_batch), ''), '—'),
          hi.raw_material_id,
          CASE
            WHEN hi.raw_material_id IS NOT NULL THEN NULL
            ELSE COALESCE(
              NULLIF(trim(both from public.fg_recipe_sku(hi.lot_id)), ''),
              NULLIF(trim(both from hi.product_batch), '')
            )
          END,
          1
        FROM public.supply_order_lines sol
        JOIN public.supply_orders so ON so.id = sol.supply_order_id
        JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
        LEFT JOIN public.raw_materials rm ON rm.id = hi.raw_material_id
        WHERE so.outlet_id = p_outlet_id
          AND lower(trim(both from so.status::text)) = 'dispatched'
          AND (p_include_raw_materials OR hi.raw_material_id IS NULL)

        UNION ALL

        SELECT
          CASE
            WHEN src.raw_material_id IS NOT NULL THEN 'rm:' || src.raw_material_id::text
            ELSE 'fg:' || COALESCE(
              NULLIF(trim(both from public.fg_recipe_sku(src.lot_id)), ''),
              NULLIF(trim(both from src.product_batch), ''),
              src.id::text
            )
          END,
          CASE WHEN src.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END,
          COALESCE(rm.name, NULLIF(trim(both from src.product_batch), ''), '—'),
          src.raw_material_id,
          CASE
            WHEN src.raw_material_id IS NOT NULL THEN NULL
            ELSE COALESCE(
              NULLIF(trim(both from public.fg_recipe_sku(src.lot_id)), ''),
              NULLIF(trim(both from src.product_batch), '')
            )
          END,
          1
        FROM public.outlet_transfer_lines otl
        JOIN public.outlet_transfers ot ON ot.id = otl.outlet_transfer_id
        JOIN public.outlet_inventory src ON src.id = otl.source_outlet_inventory_id
        LEFT JOIN public.raw_materials rm ON rm.id = src.raw_material_id
        WHERE ot.to_outlet_id = p_outlet_id
          AND lower(trim(both from ot.status::text)) = 'dispatched'
          AND (p_include_raw_materials OR src.raw_material_id IS NULL)
      ) merged
      ORDER BY sku_key, priority, label
    ) keys
    ORDER BY label
  LOOP
    v_key := r.sku_key;
    v_label := r.label;
    v_kind := r.kind;

    SELECT COALESCE(SUM(osm.signed_qty), 0)
      INTO v_opening
    FROM public.outlet_stock_movements osm
    JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
    WHERE osm.outlet_id = p_outlet_id
      AND osm.business_date < p_from
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT
      COALESCE(SUM(CASE WHEN osm.movement_type = 'supply_in' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_in' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_out' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'sale' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'waste' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'stock_take' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type IN ('reversal', 'admin_adjust') THEN osm.signed_qty ELSE 0 END), 0)
    INTO v_supply_in, v_transfers_in, v_transfers_out, v_sales, v_waste, v_stock_take, v_reversals
    FROM public.outlet_stock_movements osm
    JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
    WHERE osm.outlet_id = p_outlet_id
      AND osm.business_date >= p_from
      AND osm.business_date <= p_to
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT COALESCE(SUM(osm.signed_qty), 0)
      INTO v_after
    FROM public.outlet_stock_movements osm
    JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
    WHERE osm.outlet_id = p_outlet_id
      AND osm.business_date > p_to
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
      INTO v_live
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = p_outlet_id
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT COALESCE(SUM(sol.quantity), 0)
      INTO v_in_supply
    FROM public.supply_order_lines sol
    JOIN public.supply_orders so ON so.id = sol.supply_order_id
    JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
    WHERE so.outlet_id = p_outlet_id
      AND lower(trim(both from so.status::text)) = 'dispatched'
      AND (
        (r.kind = 'rm' AND hi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND hi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(hi.lot_id)), ''),
            NULLIF(trim(both from hi.product_batch), ''),
            hi.id::text
          )
        ) = r.sku_key)
      );

    SELECT COALESCE(SUM(otl.quantity), 0)
      INTO v_in_transfer
    FROM public.outlet_transfer_lines otl
    JOIN public.outlet_transfers ot ON ot.id = otl.outlet_transfer_id
    JOIN public.outlet_inventory src ON src.id = otl.source_outlet_inventory_id
    WHERE ot.to_outlet_id = p_outlet_id
      AND lower(trim(both from ot.status::text)) = 'dispatched'
      AND (
        (r.kind = 'rm' AND src.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND src.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(src.lot_id)), ''),
            NULLIF(trim(both from src.product_batch), ''),
            src.id::text
          )
        ) = r.sku_key)
      );

    v_computed := v_opening + v_supply_in + v_transfers_in + v_transfers_out + v_sales + v_waste + v_stock_take + v_reversals;

    v_rows := v_rows || jsonb_build_array(
      jsonb_build_object(
        'sku_key', v_key,
        'kind', v_kind,
        'label', v_label,
        'raw_material_id', r.raw_material_id,
        'product_batch', r.product_batch,
        'opening_qoh', v_opening,
        'supply_in', v_supply_in,
        'transfers_in', v_transfers_in,
        'transfers_out', v_transfers_out,
        'sales', v_sales,
        'waste', v_waste,
        'stock_take_adjustments', v_stock_take,
        'reversals', v_reversals,
        'computed_closing', v_computed,
        'movements_after', v_after,
        'live_on_hand', v_live,
        'in_transit_supply', v_in_supply,
        'in_transit_transfer', v_in_transfer,
        'unexplained_variance', v_live - (v_computed + v_after)
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'outlet_id', p_outlet_id,
    'period_from', p_from,
    'period_to', p_to,
    'rows', v_rows
  );
END;
$$;
