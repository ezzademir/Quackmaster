-- Rollback 092 only. Restores adjust_po_receipt to the 081 body (hub delta before the PO-line tag).
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file>. NEVER plain `psql -f`.
-- Safe while 081 and 088 are still live. After this rollback a receipt correction is untagged again.

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

REVOKE ALL ON FUNCTION public.adjust_po_receipt(uuid, numeric, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_po_receipt(uuid, numeric, text, boolean) TO authenticated;
