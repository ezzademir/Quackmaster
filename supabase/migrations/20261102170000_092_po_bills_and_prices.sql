-- 092: a supplier bill and an item price when a purchase order is accepted.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file>. NEVER plain `psql -f`.
--
-- Accepting an order (status becomes ordered) creates one unpaid supplier_bills row for that
-- order. Orders already ordered, partial, received, or closed short are backfilled.
-- received / closed_short then sets that bill's amount to the goods actually received, unless
-- the new amount would fall below what has already been paid.
-- Cancelling voids unpaid bills linked to the order. A bill that has a payment still blocks
-- cancel until those payments are removed.
-- v_supplier_order_prices is the latest price for each supplier and raw material: the invoice
-- unit price from a delivery when one was recorded, otherwise the unit price on the latest
-- accepted order line.

CREATE OR REPLACE FUNCTION public._ensure_po_bill(p_po_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_amount numeric(14,2);
  v_number text;
BEGIN
  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id;
  IF NOT FOUND OR v_po.supplier_id IS NULL OR v_po.entity_code IS NULL THEN
    RETURN;
  END IF;
  IF NOT public._supplier_is_active(v_po.supplier_id) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.supplier_bills b
    WHERE b.purchase_order_id = p_po_id AND b.voided_at IS NULL
  ) THEN
    RETURN;
  END IF;

  v_number := COALESCE(NULLIF(btrim(v_po.order_number), ''), 'PO-' || left(p_po_id::text, 8));
  IF EXISTS (
    SELECT 1 FROM public.supplier_bills b
    WHERE b.supplier_id = v_po.supplier_id AND b.bill_number = v_number
  ) THEN
    v_number := v_number || '-' || left(p_po_id::text, 8);
  END IF;

  SELECT round(COALESCE(
    v_po.total_amount,
    (SELECT SUM(COALESCE(poi.line_total, COALESCE(poi.quantity_ordered, 0) * COALESCE(poi.unit_price, 0)))
     FROM public.purchase_order_items poi
     WHERE poi.purchase_order_id = p_po_id),
    0
  ), 2)::numeric(14,2)
  INTO v_amount;

  INSERT INTO public.supplier_bills (
    entity_code, supplier_id, purchase_order_id, bill_number, bill_date, amount_rm, notes
  ) VALUES (
    v_po.entity_code,
    v_po.supplier_id,
    p_po_id,
    v_number,
    COALESCE(v_po.order_date, CURRENT_DATE),
    GREATEST(v_amount, 0),
    'Created from purchase order ' || COALESCE(NULLIF(btrim(v_po.order_number), ''), p_po_id::text)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._sync_po_bill_amount(p_po_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.supplier_bills%ROWTYPE;
  v_received numeric(14,2);
  v_paid numeric;
BEGIN
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

  SELECT round(COALESCE(SUM(COALESCE(poi.quantity_received, 0) * COALESCE(poi.unit_price, 0)), 0), 2)::numeric(14,2)
  INTO v_received
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = p_po_id;

  SELECT COALESCE(SUM(sp.amount_rm), 0) INTO v_paid
  FROM public.supplier_payments sp
  WHERE sp.bill_id = v_bill.id;

  IF v_received < v_paid OR v_received IS NOT DISTINCT FROM v_bill.amount_rm THEN
    RETURN;
  END IF;

  UPDATE public.supplier_bills SET amount_rm = v_received WHERE id = v_bill.id;
END;
$$;

CREATE OR REPLACE FUNCTION public._po_bill_on_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed boolean;
BEGIN
  v_changed := TG_OP = 'INSERT';
  IF NOT v_changed THEN
    v_changed := NEW.status IS DISTINCT FROM OLD.status;
  END IF;
  IF v_changed AND NEW.status IN ('ordered', 'partial', 'received', 'closed_short') THEN
    PERFORM public._ensure_po_bill(NEW.id);
  END IF;
  IF v_changed AND NEW.status IN ('received', 'closed_short') THEN
    PERFORM public._sync_po_bill_amount(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_orders_bill ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_bill
  AFTER INSERT OR UPDATE OF status ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._po_bill_on_status();

REVOKE ALL ON FUNCTION public._ensure_po_bill(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._sync_po_bill_amount(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._po_bill_on_status() FROM PUBLIC, anon, authenticated;

-- Orders already accepted before this migration.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, status FROM public.purchase_orders
    WHERE status IN ('ordered', 'partial', 'received', 'closed_short')
  LOOP
    PERFORM public._ensure_po_bill(r.id);
    IF r.status IN ('received', 'closed_short') THEN
      PERFORM public._sync_po_bill_amount(r.id);
    END IF;
  END LOOP;
END $$;

-- Unpaid bills linked to the order are voided as part of cancel. Paid bills stay linked,
-- so the existing bills_on_po check still refuses the cancel.
CREATE OR REPLACE FUNCTION public._po_cancel_void_unpaid_bills(p_po_id uuid, p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text;
  v_raw text;
  v_bill public.supplier_bills%ROWTYPE;
  v_paid numeric;
  v_uid uuid := auth.uid();
  v_email text := '';
BEGIN
  SELECT r.reason INTO v_raw FROM public.po_cancel_requests r WHERE r.id = p_request_id;
  v_reason := public._po_cancel_trim_reason(COALESCE(NULLIF(btrim(v_raw), ''), 'Purchase order cancelled'));
  PERFORM set_config('app.voiding_bill', '1', true);
  FOR v_bill IN
    SELECT * FROM public.supplier_bills
    WHERE purchase_order_id = p_po_id AND voided_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    SELECT COALESCE(SUM(amount_rm), 0) INTO v_paid
    FROM public.supplier_payments WHERE bill_id = v_bill.id;
    IF v_paid > 0 THEN
      CONTINUE;
    END IF;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.supplier_bills
       SET voided_at = now(),
           voided_by = v_uid,
           void_reason = v_reason,
           voided_purchase_order_id = purchase_order_id,
           purchase_order_id = NULL
     WHERE id = v_bill.id
     RETURNING * INTO v_bill;
    BEGIN
      SELECT COALESCE(u.email::text, '') INTO v_email FROM auth.users u WHERE u.id = v_uid;
    EXCEPTION WHEN OTHERS THEN
      v_email := '';
    END;
    INSERT INTO public.data_ledger (
      user_id, user_email, action, entity_type, entity_id, module, operation,
      reference_id, before_data, after_data, metadata
    ) VALUES (
      v_uid,
      COALESCE(v_email, ''),
      'voided',
      'supplier_bill',
      v_bill.id::text,
      'procurement',
      'event',
      v_bill.voided_purchase_order_id::text,
      NULL,
      to_jsonb(v_bill),
      jsonb_build_object('reason', v_reason, 'purchase_order_id', v_bill.voided_purchase_order_id, 'source', 'po_cancel')
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public._po_cancel_void_unpaid_bills(uuid, uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_def text;
  v_old text := 'FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id;';
  v_paid text := 'FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id AND COALESCE((SELECT sum(sp.amount_rm) FROM public.supplier_payments sp WHERE sp.bill_id = b.id), 0) > 0;';
  v_apply_old text := E'  SELECT count(*)::integer,\n         COALESCE(jsonb_agg(b.bill_number ORDER BY b.bill_number), ''[]''::jsonb)\n    INTO v_bill_count, v_bill_numbers\n    FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id;';
  v_apply_new text := E'  PERFORM public._po_cancel_void_unpaid_bills(p_po_id, p_request_id);\n' || v_apply_old;
BEGIN
  v_def := pg_get_functiondef('public._po_cancel_require_open_po(uuid)'::regprocedure);
  IF strpos(v_def, v_paid) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '092: bill check not found once in _po_cancel_require_open_po';
    END IF;
    EXECUTE replace(v_def, v_old, v_paid);
  END IF;

  v_def := pg_get_functiondef('public._po_cancel_apply(uuid, uuid)'::regprocedure);
  IF strpos(v_def, '_po_cancel_void_unpaid_bills') = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_apply_old, ''))) / length(v_apply_old) <> 1 THEN
      RAISE EXCEPTION '092: bill check not found once in _po_cancel_apply';
    END IF;
    EXECUTE replace(v_def, v_apply_old, v_apply_new);
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_supplier_order_prices WITH (security_invoker = true) AS
WITH accepted AS (
  SELECT po.supplier_id,
         po.order_number,
         COALESCE(po.approved_at, po.updated_at) AS decided_at,
         poi.id AS purchase_order_item_id,
         poi.raw_material_id,
         poi.unit_price
  FROM public.purchase_orders po
  JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
  WHERE po.status IN ('ordered', 'partial', 'received', 'closed_short')
    AND po.supplier_id IS NOT NULL
    AND poi.raw_material_id IS NOT NULL
    AND poi.unit_price IS NOT NULL
),
invoice_price AS (
  SELECT DISTINCT ON (a.supplier_id, a.raw_material_id)
         a.supplier_id,
         a.raw_material_id,
         r.invoice_unit_price_rm AS unit_price_rm,
         a.order_number,
         r.entered_at AS priced_at
  FROM public.po_receipt_records r
  JOIN accepted a ON a.purchase_order_item_id = r.purchase_order_item_id
  WHERE r.invoice_unit_price_rm IS NOT NULL
  ORDER BY a.supplier_id, a.raw_material_id, r.entered_at DESC, r.id DESC
),
order_price AS (
  SELECT DISTINCT ON (a.supplier_id, a.raw_material_id)
         a.supplier_id,
         a.raw_material_id,
         a.unit_price AS unit_price_rm,
         a.order_number,
         a.decided_at AS priced_at
  FROM accepted a
  ORDER BY a.supplier_id, a.raw_material_id, a.decided_at DESC, a.purchase_order_item_id DESC
)
SELECT COALESCE(i.supplier_id, o.supplier_id) AS supplier_id,
       public._supplier_display_name(COALESCE(i.supplier_id, o.supplier_id)) AS supplier_name,
       COALESCE(i.raw_material_id, o.raw_material_id) AS raw_material_id,
       cat.name AS item_name,
       cat.unit_of_measure,
       COALESCE(i.unit_price_rm, o.unit_price_rm) AS unit_price_rm,
       CASE WHEN i.supplier_id IS NOT NULL THEN 'invoice' ELSE 'order' END AS price_source,
       COALESCE(i.order_number, o.order_number) AS order_number,
       COALESCE(i.priced_at, o.priced_at) AS priced_at
FROM order_price o
FULL JOIN invoice_price i
  ON i.supplier_id = o.supplier_id AND i.raw_material_id = o.raw_material_id
LEFT JOIN public.v_raw_material_catalog cat
  ON cat.id = COALESCE(i.raw_material_id, o.raw_material_id);

REVOKE ALL ON public.v_supplier_order_prices FROM PUBLIC, anon;
GRANT SELECT ON public.v_supplier_order_prices TO authenticated;
