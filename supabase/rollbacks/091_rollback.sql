-- Rollback 091 only. Run before 089. Safe while 089 and 085 are still live.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file>. NEVER plain `psql -f`.
-- Puts a voided bill back on its purchase order, then drops the void columns and the RPC.
-- Ledger rows already written are kept.

UPDATE public.supplier_bills
   SET purchase_order_id = voided_purchase_order_id
 WHERE voided_at IS NOT NULL
   AND purchase_order_id IS NULL
   AND voided_purchase_order_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.void_supplier_bill(uuid, text);

CREATE OR REPLACE FUNCTION public._supplier_bills_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_paid numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.entered_by := COALESCE(auth.uid(), NEW.entered_by);
    NEW.entered_at := now();
  ELSE
    NEW.entered_by := OLD.entered_by;
    NEW.entered_at := OLD.entered_at;
    IF NEW.amount_rm < OLD.amount_rm THEN
      SELECT COALESCE(sum(amount_rm), 0) INTO v_paid FROM public.supplier_payments WHERE bill_id = NEW.id;
      IF NEW.amount_rm < v_paid THEN
        RAISE EXCEPTION 'bill_amount_below_paid' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id)
     AND NOT public._supplier_is_active(NEW.supplier_id) THEN
    RAISE EXCEPTION 'supplier_not_approved' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE VIEW public.v_supplier_bill_status WITH (security_invoker = true) AS
SELECT x.id, x.entity_code, x.supplier_id, x.supplier_name, x.purchase_order_id, x.bill_number, x.bill_date, x.due_date,
       x.amount_rm, x.paid_rm, x.amount_rm - x.paid_rm AS balance_rm,
       CASE WHEN x.paid_rm >= x.amount_rm THEN 'paid'
            WHEN x.due_date IS NOT NULL AND x.due_date < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN 'overdue'
            WHEN x.paid_rm > 0 THEN 'part_paid'
            ELSE 'unpaid' END AS payment_status,
       x.entered_by, x.entered_at
FROM (SELECT b.*, public._supplier_display_name(b.supplier_id) AS supplier_name, COALESCE(public.supplier_bill_paid_rm(b.id), 0) AS paid_rm
      FROM public.supplier_bills b) x;

ALTER TABLE public.supplier_bills DROP CONSTRAINT IF EXISTS supplier_bills_void_shape;
ALTER TABLE public.supplier_bills
  DROP COLUMN IF EXISTS voided_purchase_order_id,
  DROP COLUMN IF EXISTS void_reason,
  DROP COLUMN IF EXISTS voided_by,
  DROP COLUMN IF EXISTS voided_at;
