-- 091: void an unpaid supplier bill so a purchase order can be cancelled.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file>. NEVER plain `psql -f`.
--
-- 089 refuses to cancel a purchase order that still has a supplier bill, and it says to void the
-- bill first. This is that route. It does not reverse a payment and it does not cancel the order.
-- An admin voids an unpaid bill with a reason. The bill row stays. Its purchase order link is
-- copied to voided_purchase_order_id and then cleared, which is what 089's existing check looks at.
-- A bill that already has a payment is refused until those payments are removed.
-- Direct UPDATEs cannot void a bill or detach it from an order. Only void_supplier_bill can.

ALTER TABLE public.supplier_bills
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS voided_purchase_order_id uuid;

ALTER TABLE public.supplier_bills DROP CONSTRAINT IF EXISTS supplier_bills_void_shape;
ALTER TABLE public.supplier_bills ADD CONSTRAINT supplier_bills_void_shape CHECK (
  (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL AND voided_purchase_order_id IS NULL)
  OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL AND char_length(trim(void_reason)) > 0)
);

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
    IF coalesce(current_setting('app.voiding_bill', true), '') <> '1' AND (
         NEW.voided_at IS DISTINCT FROM OLD.voided_at
      OR NEW.voided_by IS DISTINCT FROM OLD.voided_by
      OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
      OR NEW.voided_purchase_order_id IS DISTINCT FROM OLD.voided_purchase_order_id
      OR (OLD.purchase_order_id IS NOT NULL AND NEW.purchase_order_id IS NULL)
      OR (OLD.voided_at IS NOT NULL AND NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id)
    ) THEN
      RAISE EXCEPTION 'bill_void_via_rpc' USING ERRCODE = 'P0001',
        DETAIL = 'Void a supplier bill with void_supplier_bill. A direct edit cannot void it or detach it from its purchase order.';
    END IF;
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
REVOKE ALL ON FUNCTION public._supplier_bills_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.void_supplier_bill(p_bill_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := '';
  v_bill public.supplier_bills%ROWTYPE;
  v_paid numeric;
  v_reason text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001',
      DETAIL = 'Only an admin can void a supplier bill.';
  END IF;
  v_reason := public._po_cancel_trim_reason(p_reason);
  SELECT * INTO v_bill FROM public.supplier_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_bill.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'bill_already_void' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(sum(amount_rm), 0) INTO v_paid FROM public.supplier_payments WHERE bill_id = p_bill_id;
  IF v_paid > 0 THEN
    RAISE EXCEPTION 'bill_has_payments' USING ERRCODE = 'P0001',
      DETAIL = 'This bill has payments. Remove the payments first, then void the bill. Nothing was voided.';
  END IF;
  PERFORM set_config('app.voiding_bill', '1', true);
  UPDATE public.supplier_bills
     SET voided_at = now(),
         voided_by = v_uid,
         void_reason = v_reason,
         voided_purchase_order_id = purchase_order_id,
         purchase_order_id = NULL
   WHERE id = p_bill_id
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
    p_bill_id::text,
    'procurement',
    'event',
    v_bill.voided_purchase_order_id::text,
    NULL,
    to_jsonb(v_bill),
    jsonb_build_object('reason', v_reason, 'purchase_order_id', v_bill.voided_purchase_order_id)
  );
  RETURN jsonb_build_object('success', true, 'id', p_bill_id, 'purchase_order_id', v_bill.voided_purchase_order_id);
END $$;

REVOKE ALL ON FUNCTION public.void_supplier_bill(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_supplier_bill(uuid, text) TO authenticated;
INSERT INTO public.procurement_exposure_allow (kind, name, note)
VALUES ('function', 'void_supplier_bill', 'admin only: refuses unless is_profiles_admin(); voids an unpaid supplier bill and detaches it from its purchase order')
ON CONFLICT (kind, name) DO UPDATE SET note = EXCLUDED.note;

CREATE OR REPLACE VIEW public.v_supplier_bill_status WITH (security_invoker = true) AS
SELECT x.id, x.entity_code, x.supplier_id, x.supplier_name,
       COALESCE(x.purchase_order_id, x.voided_purchase_order_id) AS purchase_order_id,
       x.bill_number, x.bill_date, x.due_date,
       x.amount_rm, x.paid_rm, x.amount_rm - x.paid_rm AS balance_rm,
       CASE WHEN x.voided_at IS NOT NULL THEN 'void'
            WHEN x.paid_rm >= x.amount_rm THEN 'paid'
            WHEN x.due_date IS NOT NULL AND x.due_date < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN 'overdue'
            WHEN x.paid_rm > 0 THEN 'part_paid'
            ELSE 'unpaid' END AS payment_status,
       x.entered_by, x.entered_at, x.voided_at, x.void_reason
FROM (
  SELECT b.*, public._supplier_display_name(b.supplier_id) AS supplier_name,
         COALESCE(public.supplier_bill_paid_rm(b.id), 0) AS paid_rm
  FROM public.supplier_bills b
) x;

REVOKE ALL ON public.v_supplier_bill_status FROM PUBLIC, anon;
GRANT SELECT ON public.v_supplier_bill_status TO authenticated;
