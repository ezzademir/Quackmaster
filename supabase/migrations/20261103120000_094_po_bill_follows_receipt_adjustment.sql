-- 094: keep an auto-created supplier bill aligned when an admin corrects a receipt.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file>. NEVER plain `psql -f`.
-- Depends on 092.
--
-- 092 sets the bill to goods received only when the purchase order's status changes to
-- received or closed_short. adjust_po_receipt often corrects the quantity without changing
-- that status (a received order stays received; a closed-short order stays closed-short),
-- so the payable kept the old amount while stock moved.
-- A correction that drops a received order back to partial puts the auto bill back on the
-- order amount. line_total cannot be used for that: receipt rewrites it to the received value.
-- A correction that keeps the invoice total does not touch the bill. A reduction that would
-- fall below what is already paid leaves the bill amount unchanged and still posts the stock.

CREATE OR REPLACE FUNCTION public._restore_po_bill_order_amount(p_po_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_bill public.supplier_bills%ROWTYPE;
  v_order numeric(14,2);
  v_paid numeric;
BEGIN
  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_bill
  FROM public.supplier_bills
  WHERE purchase_order_id = p_po_id
    AND voided_at IS NULL
    AND notes LIKE 'Created from purchase order %'
  ORDER BY entered_at, id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT round(COALESCE(
    v_po.total_amount,
    (SELECT SUM(COALESCE(poi.quantity_ordered, 0) * COALESCE(poi.unit_price, 0))
     FROM public.purchase_order_items poi
     WHERE poi.purchase_order_id = p_po_id),
    0
  ), 2)::numeric(14,2)
  INTO v_order;
  v_order := GREATEST(COALESCE(v_order, 0), 0);

  SELECT COALESCE(SUM(sp.amount_rm), 0) INTO v_paid
  FROM public.supplier_payments sp
  WHERE sp.bill_id = v_bill.id;

  IF v_order < v_paid OR v_order IS NOT DISTINCT FROM v_bill.amount_rm THEN
    RETURN;
  END IF;

  UPDATE public.supplier_bills SET amount_rm = v_order WHERE id = v_bill.id;
END;
$$;

REVOKE ALL ON FUNCTION public._restore_po_bill_order_amount(uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_def text;
  v_old text := $old$  UPDATE public.purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_po;

  PERFORM public._append_data_ledger(
    'receipt_adjusted', 'purchase_order', v_po::text, 'procurement', 'update', p_item_id::text,$old$;
  v_new text := $new$  UPDATE public.purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_po;

  IF v_new_status IN ('received', 'closed_short') AND NOT COALESCE(p_keep_line_total, false) THEN
    PERFORM public._sync_po_bill_amount(v_po);
  ELSIF v_status IN ('received', 'closed_short') AND v_new_status = 'partial' AND NOT COALESCE(p_keep_line_total, false) THEN
    PERFORM public._restore_po_bill_order_amount(v_po);
  END IF;

  PERFORM public._append_data_ledger(
    'receipt_adjusted', 'purchase_order', v_po::text, 'procurement', 'update', p_item_id::text,$new$;
BEGIN
  IF to_regprocedure('public._sync_po_bill_amount(uuid)') IS NULL THEN
    RAISE EXCEPTION '094 depends on 092 (_sync_po_bill_amount is missing)';
  END IF;

  v_def := pg_get_functiondef('public.adjust_po_receipt(uuid, numeric, text, boolean)'::regprocedure);
  IF strpos(v_def, '_restore_po_bill_order_amount') > 0 THEN
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '094: receipt-status update not found once in adjust_po_receipt';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;
