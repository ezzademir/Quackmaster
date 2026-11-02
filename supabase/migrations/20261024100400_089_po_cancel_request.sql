/*
  089: purchase-order cancel REQUEST and admin approval. Applied LAST.

  APPLY ORDER: 084, 085, 087, 088, 090, then 089 (this file must be stamped after 090).
  Depends on 085 (is_procurement_user, procurement_has_po, user_entities, procurement_table_allow,
  procurement_exposure_allow, procurement_default_deny_sweep) and 088 (_po_cancel_plan, tagged
  cancel reversals, cancel_purchase_order). Independent of 090 data.
  RUN EVERY ROLLBACK (and this file) AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <file>, or one
  Supabase SQL editor / execute_sql call; never plain `psql -f`.
  ROLLBACK ORDER (newest first): 089 -> 090 -> 088 -> 087 -> 085 -> 084.
  supabase/rollbacks/089_rollback.sql is safe to run first: it drops only 089 objects and restores
  the 088 cancel_purchase_order. It does not touch 090.

  Settled rules (owner, this change set)
    - procurement cannot cancel a PO directly. They submit a cancel REQUEST with a mandatory
      non-empty trimmed reason. Admin approves or rejects (reject also takes a reason).
    - only an admin decides; a requester cannot approve (or reject) their own request.
    - an admin's own cancel is a DIRECT cancel: one self-approved request row and one ledger
      event in the same transaction (no two-step).
    - cancel reverses receipts first, each reversal tagged with the same entity (MH/QT) as the
      original receipt, then marks the PO cancelled. All atomic; any failure RAISES and changes
      nothing. A PO is never deleted here (088 could delete a PO with no receipt-record FK;
      089 always keeps the row as 'cancelled' so the request row can keep its FK).
    - a PO with a live bill cannot be cancelled (every supplier_bills row is live: there is no
      void/reverse route). The RPC refuses with a message that points at the accounting flow.
      Do not build bill void here.
    - po_cancel_requests: RLS on, no client writes, SELECT for admin and the requester only.
    - fail-closed ledger: INSERT INTO data_ledger directly (not _append_data_ledger).
      cancelled / cancel_requested / cancel_rejected metadata carry entity_code,
      requested_by, decided_by and reason (so the trail survives a table rollback).
    - supplier_scorecard_metrics excludes cancelled POs from fill rate and OTIF
      (a kept cancelled PO with received 0 must not drag the supplier's average).
    - cancel_purchase_order keeps the jsonb soft-return for the existing admin
      screen and forwards PG DETAIL/HINT (bill numbers, accounting pointer, stock
      figures) the same way 088 returned message / bill_count / bill_numbers /
      on_hand / required_return.
    - reason and decision_reason are capped at 1000 characters.
    - no backfill of earlier PO records (procurement fix is 23 Oct 2026 forward only).

  Client-executable SECURITY DEFINER RPCs are allow-listed. Internal helpers are revoked from
  PUBLIC / anon / authenticated. search_path = public, pg_temp (pg_temp last) on every new definer.
*/

DO $$ BEGIN
  IF to_regclass('public.user_entities') IS NULL OR to_regprocedure('public.is_procurement_user()') IS NULL THEN
    RAISE EXCEPTION '089 depends on 085 (public.user_entities / is_procurement_user() is missing)';
  END IF;
  IF to_regprocedure('public._po_cancel_plan(uuid)') IS NULL
     OR to_regprocedure('public.cancel_purchase_order(uuid)') IS NULL THEN
    RAISE EXCEPTION '089 depends on 088 (public._po_cancel_plan / cancel_purchase_order is missing)';
  END IF;
  IF to_regprocedure('public.is_profiles_admin()') IS NULL
     OR to_regclass('public.supplier_bills') IS NULL
     OR to_regclass('public.po_receipt_records') IS NULL
     OR to_regclass('public.data_ledger') IS NULL
     OR to_regprocedure('public._stock_tag_enforced(text)') IS NULL THEN
    RAISE EXCEPTION '089 depends on 085/087/088 (is_profiles_admin / supplier_bills / po_receipt_records / data_ledger / _stock_tag_enforced is missing)';
  END IF;
END $$;

-- ---------------------------------------------------------------- requests
CREATE TABLE IF NOT EXISTS public.po_cancel_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES public.profiles(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  status text NOT NULL,
  decided_by uuid REFERENCES public.profiles(id),
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_cancel_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT po_cancel_requests_reason_check CHECK (length(trim(reason)) > 0),
  CONSTRAINT po_cancel_requests_reason_len_check CHECK (char_length(reason) <= 1000),
  CONSTRAINT po_cancel_requests_decision_reason_len_check CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 1000),
  CONSTRAINT po_cancel_requests_decision_check CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT po_cancel_requests_reject_reason_check CHECK (
    status <> 'rejected' OR length(trim(COALESCE(decision_reason, ''))) > 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS po_cancel_requests_one_pending
  ON public.po_cancel_requests (purchase_order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS po_cancel_requests_requested_by_idx
  ON public.po_cancel_requests (requested_by);

ALTER TABLE public.po_cancel_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_cancel_requests_admin_read ON public.po_cancel_requests;
CREATE POLICY po_cancel_requests_admin_read ON public.po_cancel_requests
  FOR SELECT TO authenticated
  USING (public.is_profiles_admin());
DROP POLICY IF EXISTS po_cancel_requests_own_read ON public.po_cancel_requests;
CREATE POLICY po_cancel_requests_own_read ON public.po_cancel_requests
  FOR SELECT TO authenticated
  USING (requested_by = auth.uid());
-- no INSERT / UPDATE / DELETE policies: clients cannot write this table
REVOKE ALL ON public.po_cancel_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.po_cancel_requests TO authenticated;

INSERT INTO public.procurement_table_allow (table_name, note) VALUES
  ('po_cancel_requests', 'admin + requester SELECT only; all writes go through 089 RPCs')
ON CONFLICT (table_name) DO UPDATE SET note = EXCLUDED.note;

-- 081/085 scorecard counted every PO. 089 keeps cancelled POs (received 0 after
-- reversal), so exclude them from fill rate and OTIF. Grants restated; security_invoker
-- stays true (085). Rollback restores the 081 body.
CREATE OR REPLACE VIEW public.supplier_scorecard_metrics
WITH (security_invoker = true) AS
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
     LEFT JOIN public.purchase_orders po ON po.supplier_id = s.id AND po.status <> 'cancelled'
     LEFT JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
  GROUP BY s.id, s.name;
REVOKE ALL ON public.supplier_scorecard_metrics FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.supplier_scorecard_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON public.supplier_scorecard_metrics TO authenticated;

-- ---------------------------------------------------------------- helpers (not client-executable)
CREATE OR REPLACE FUNCTION public._po_cancel_trim_reason(p_reason text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v text := trim(COALESCE(p_reason, ''));
BEGIN
  IF v = '' THEN
    RAISE EXCEPTION 'reason_required'
      USING ERRCODE = 'P0001',
            DETAIL = 'A non-empty reason is required.';
  END IF;
  IF char_length(v) > 1000 THEN
    RAISE EXCEPTION 'reason_too_long'
      USING ERRCODE = 'P0001',
            DETAIL = 'The reason must be at most 1000 characters.';
  END IF;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public._po_cancel_trim_reason(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._po_cancel_ledger_write(
  p_action text,
  p_po_id uuid,
  p_request_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_meta jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := '';
  v_entity text;
  v_requested_by uuid;
  v_decided_by uuid;
  v_reason text;
  v_decision_reason text;
BEGIN
  IF v_uid IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(u.email::text, '') INTO v_email FROM auth.users u WHERE u.id = v_uid;
    EXCEPTION WHEN OTHERS THEN
      v_email := '';
    END;
  END IF;
  SELECT entity_code INTO v_entity FROM public.purchase_orders WHERE id = p_po_id;
  SELECT requested_by, decided_by, reason, decision_reason
    INTO v_requested_by, v_decided_by, v_reason, v_decision_reason
    FROM public.po_cancel_requests WHERE id = p_request_id;
  INSERT INTO public.data_ledger (
    user_id, user_email, action, entity_type, entity_id, module, operation,
    reference_id, before_data, after_data, metadata
  ) VALUES (
    v_uid,
    COALESCE(v_email, ''),
    p_action,
    'purchase_order',
    p_po_id::text,
    'procurement',
    'event',
    p_request_id::text,
    p_before,
    p_after,
    COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object(
      'request_id', p_request_id,
      'entity_code', v_entity,
      'requested_by', v_requested_by,
      'decided_by', v_decided_by,
      'reason', v_reason,
      'decision_reason', v_decision_reason
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public._po_cancel_ledger_write(text, uuid, uuid, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

-- Receipt reversal + mark cancelled. Caller has already inserted/updated the request row.
-- Failures RAISE (nothing commits). Ledger insert is direct (fail closed).
CREATE OR REPLACE FUNCTION public._po_cancel_apply(p_po_id uuid, p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_step RECORD;
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
  v_tagged numeric;
  v_close_receipts boolean;
  v_lines jsonb := '[]'::jsonb;
  v_before jsonb;
  v_bill_count integer;
  v_bill_numbers jsonb;
BEGIN
  IF p_po_id IS NULL THEN
    RAISE EXCEPTION 'invalid_po_id' USING ERRCODE = 'P0001';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request_id' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_po.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)::integer,
         COALESCE(jsonb_agg(b.bill_number ORDER BY b.bill_number), '[]'::jsonb)
    INTO v_bill_count, v_bill_numbers
    FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id;
  IF v_bill_count > 0 THEN
    RAISE EXCEPTION 'bills_on_po'
      USING ERRCODE = 'P0001',
            DETAIL = 'This purchase order has a supplier bill. Handle the bill through accounting first (void or reverse it, with any payments handled in the payments record), then cancel. Nothing was cancelled.',
            HINT = v_bill_numbers::text;
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

  v_close_receipts := EXISTS (SELECT 1 FROM public.po_receipt_records r WHERE r.purchase_order_id = p_po_id);

  PERFORM 1 FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0
   ORDER BY poi.id DESC FOR UPDATE OF poi;

  IF EXISTS (SELECT 1 FROM public.purchase_order_items poi
             WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0 AND poi.raw_material_id IS NULL) THEN
    RAISE EXCEPTION 'missing_raw_material' USING ERRCODE = 'P0001';
  END IF;
  IF v_po.entity_code IS NULL AND EXISTS (SELECT 1 FROM public._po_cancel_plan(p_po_id)) THEN
    RAISE EXCEPTION 'po_entity_required'
      USING ERRCODE = 'P0001',
            DETAIL = 'Set the PO entity (QT / MH) before cancelling a received PO.';
  END IF;
  IF public._stock_tag_enforced('hub_rm') AND EXISTS (SELECT 1 FROM public._po_cancel_plan(p_po_id) pl WHERE pl.tag IS NULL) THEN
    RAISE EXCEPTION 'stock_entity_tag_required'
      USING ERRCODE = 'P0001',
            DETAIL = 'Part of this PO was received before stock tags existed and cannot be reversed while tags are enforced.';
  END IF;

  FOR v_step IN SELECT pl.rm_id, SUM(pl.qty) AS q FROM public._po_cancel_plan(p_po_id) pl GROUP BY pl.rm_id ORDER BY pl.rm_id LOOP
    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_step.rm_id
    ORDER BY hi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_hub_row IS NULL THEN
      RAISE EXCEPTION 'cannot_cancel_missing_hub_row' USING ERRCODE = 'P0001';
    END IF;
    IF v_qoh < v_step.q THEN
      RAISE EXCEPTION 'insufficient_hub_quantity'
        USING ERRCODE = 'P0001',
              DETAIL = 'Stock received on this PO has already been partly used (on hand ' || v_qoh || ', needed ' || v_step.q || '). Nothing was cancelled; reverse the usage first.',
              HINT = jsonb_build_object(
                'raw_material_id', v_step.rm_id,
                'on_hand', v_qoh,
                'required_return', v_step.q
              )::text;
    END IF;
    IF (v_qoh - v_step.q) < v_res THEN
      RAISE EXCEPTION 'hub_below_reserved' USING ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM public.raw_materials r WHERE r.id = v_step.rm_id FOR UPDATE;
  END LOOP;

  FOR v_step IN SELECT pl.rm_id, pl.tag, SUM(pl.qty) AS q FROM public._po_cancel_plan(p_po_id) pl WHERE pl.tag IS NOT NULL
                GROUP BY pl.rm_id, pl.tag ORDER BY pl.rm_id, pl.tag LOOP
    SELECT COALESCE(SUM(m.quantity), 0) INTO v_tagged
    FROM public.hub_stock_movements m JOIN public.hub_inventory hi ON hi.id = m.hub_inventory_id
    WHERE hi.raw_material_id = v_step.rm_id AND m.entity_code = v_step.tag;
    IF v_tagged < v_step.q THEN
      RAISE EXCEPTION 'insufficient_tagged_stock'
        USING ERRCODE = 'P0001',
              DETAIL = 'Stock received on this PO has already been partly used (' || v_step.tag || ' balance ' || v_tagged || ', needed ' || v_step.q || '). Nothing was cancelled.',
              HINT = jsonb_build_object(
                'raw_material_id', v_step.rm_id,
                'entity_code', v_step.tag,
                'on_hand', v_tagged,
                'required_return', v_step.q
              )::text;
    END IF;
  END LOOP;

  FOR v_step IN SELECT * FROM public._po_cancel_plan(p_po_id) pl ORDER BY pl.item_id DESC, pl.tag NULLS LAST LOOP
    v_rcv := v_step.qty;
    v_rm := v_step.rm_id;
    v_price := v_step.price;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_rm
    ORDER BY hi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_hub_row IS NULL THEN
      RAISE EXCEPTION 'cannot_cancel_missing_hub_row' USING ERRCODE = 'P0001';
    END IF;
    IF v_qoh < v_rcv THEN
      RAISE EXCEPTION 'insufficient_hub_quantity' USING ERRCODE = 'P0001';
    END IF;
    IF (v_qoh - v_rcv) < v_res THEN
      RAISE EXCEPTION 'hub_below_reserved' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(SUM(hi.quantity_on_hand), 0) INTO v_q_sum
    FROM public.hub_inventory hi WHERE hi.raw_material_id = v_rm;

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
      v_new_avg := (v_avg * v_q_sum - v_rcv * v_price) / NULLIF(v_q_sum - v_rcv, 0);
      IF v_new_avg IS NULL OR v_new_avg < 0 THEN
        v_new_avg := COALESCE(v_cost_price, 0);
      END IF;
    END IF;

    UPDATE public.raw_materials r
    SET weighted_avg_unit_cost = COALESCE(v_new_avg, 0),
        cost_price = COALESCE(v_new_avg, cost_price),
        updated_at = now()
    WHERE r.id = v_rm;

    PERFORM set_config('app.stock_entity', COALESCE(v_step.tag, ''), true);
    PERFORM set_config('app.stock_po_item', v_step.item_id::text, true);
    UPDATE public.hub_inventory hi
    SET quantity_on_hand = hi.quantity_on_hand - v_rcv,
        available_quantity = (hi.quantity_on_hand - v_rcv) - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
    WHERE hi.id = v_hub_row;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'purchase_order_item_id', v_step.item_id,
        'quantity_reversed', v_rcv,
        'raw_material_id', v_rm,
        'unit_price', v_price,
        'entity_code', v_step.tag
      )
    );
  END LOOP;

  IF v_close_receipts THEN
    INSERT INTO public.po_receipt_records (purchase_order_id, purchase_order_item_id, quantity_received, quantity_uom, do_number, entered_by)
    SELECT p_po_id, r.purchase_order_item_id, 0, (array_agg(r.quantity_uom ORDER BY r.id DESC))[1], 'PO CANCELLED', auth.uid()
    FROM public.po_receipt_records r
    JOIN public.purchase_order_items poi ON poi.id = r.purchase_order_item_id AND COALESCE(poi.quantity_received, 0) > 0
    WHERE r.purchase_order_id = p_po_id
    GROUP BY r.purchase_order_item_id;
  END IF;
  UPDATE public.purchase_order_items poi
     SET quantity_received = 0, line_total = 0
   WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0;

  PERFORM set_config('app.stock_entity', '', true);
  PERFORM set_config('app.stock_po_item', '', true);

  PERFORM public._po_cancel_ledger_write(
    'cancelled',
    p_po_id,
    p_request_id,
    jsonb_build_object('order_number', v_po.order_number, 'status', v_po.status, 'lines_before', v_before),
    jsonb_build_object('reversal_lines', v_lines, 'po_kept_as_cancelled', true, 'status', 'cancelled'),
    jsonb_build_object('source', '089_po_cancel', 'po_kept_as_cancelled', true, 'reversal_lines', v_lines)
  );

  UPDATE public.purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = p_po_id;

  RETURN jsonb_build_object(
    'success', true,
    'reversal_lines', v_lines,
    'po_kept_as_cancelled', true,
    'request_id', p_request_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public._po_cancel_apply(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._po_cancel_require_open_po(p_po_id uuid)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_bill_count integer;
  v_bill_numbers jsonb;
BEGIN
  IF p_po_id IS NULL THEN
    RAISE EXCEPTION 'invalid_po_id' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_po.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.po_cancel_requests r WHERE r.purchase_order_id = p_po_id AND r.status = 'pending') THEN
    RAISE EXCEPTION 'pending_request_exists'
      USING ERRCODE = 'P0001',
            DETAIL = 'A cancel request is already pending for this purchase order. Approve or reject it first.';
  END IF;
  SELECT count(*)::integer, COALESCE(jsonb_agg(b.bill_number ORDER BY b.bill_number), '[]'::jsonb)
    INTO v_bill_count, v_bill_numbers
    FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id;
  IF v_bill_count > 0 THEN
    RAISE EXCEPTION 'bills_on_po'
      USING ERRCODE = 'P0001',
            DETAIL = 'This purchase order has a supplier bill. Handle the bill through accounting first (void or reverse it, with any payments handled in the payments record), then cancel. Nothing was cancelled.',
            HINT = v_bill_numbers::text;
  END IF;
  RETURN v_po;
END;
$$;
REVOKE ALL ON FUNCTION public._po_cancel_require_open_po(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- client RPCs
-- Admin direct cancel (existing UI). Same body as request_cancel for an admin: one self-approved
-- request row + one cancelled ledger event. Soft-return jsonb is kept for the existing screen
-- (forbidden / not_authenticated); apply failures are converted the same way so the UI still
-- reads error.message. New request / decide RPCs RAISE instead.
CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_req uuid;
  v_reason text := 'Admin direct cancel';
  v_detail text;
  v_hint text;
  v_out jsonb;
  v_hint_json jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only an admin can cancel a purchase order');
  END IF;
  BEGIN
    PERFORM public._po_cancel_require_open_po(p_po_id);
    INSERT INTO public.po_cancel_requests (
      purchase_order_id, requested_by, reason, status, decided_by, decided_at
    ) VALUES (
      p_po_id, v_uid, v_reason, 'approved', v_uid, now()
    ) RETURNING id INTO v_req;
    RETURN public._po_cancel_apply(p_po_id, v_req);
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS
      v_detail = PG_EXCEPTION_DETAIL,
      v_hint = PG_EXCEPTION_HINT;
    v_out := jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)
    );
    IF NULLIF(v_detail, '') IS NOT NULL THEN
      v_out := v_out || jsonb_build_object('detail', v_detail);
    END IF;
    IF NULLIF(v_hint, '') IS NOT NULL THEN
      v_out := v_out || jsonb_build_object('hint', v_hint);
      BEGIN
        v_hint_json := v_hint::jsonb;
        IF jsonb_typeof(v_hint_json) = 'array' THEN
          v_out := v_out || jsonb_build_object(
            'bill_numbers', v_hint_json,
            'bill_count', jsonb_array_length(v_hint_json)
          );
        ELSIF jsonb_typeof(v_hint_json) = 'object' THEN
          -- merge ONLY the known stock-figure keys, so a HINT can never overwrite success, error or message
          v_out := v_out || jsonb_strip_nulls(jsonb_build_object(
            'raw_material_id', v_hint_json -> 'raw_material_id',
            'entity_code', v_hint_json -> 'entity_code',
            'on_hand', v_hint_json -> 'on_hand',
            'required_return', v_hint_json -> 'required_return'
          ));
        END IF;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
    RETURN v_out;
  END;
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_cancel_purchase_order(p_po_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text;
  v_req uuid;
  v_po public.purchase_orders%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;
  v_reason := public._po_cancel_trim_reason(p_reason);

  IF public.is_profiles_admin() THEN
    v_po := public._po_cancel_require_open_po(p_po_id);
    INSERT INTO public.po_cancel_requests (
      purchase_order_id, requested_by, reason, status, decided_by, decided_at
    ) VALUES (
      p_po_id, v_uid, v_reason, 'approved', v_uid, now()
    ) RETURNING id INTO v_req;
    RETURN public._po_cancel_apply(p_po_id, v_req);
  END IF;

  IF NOT public.is_procurement_user() THEN
    RAISE EXCEPTION 'forbidden'
      USING ERRCODE = 'P0001',
            DETAIL = 'Only procurement can request a purchase-order cancel, and only an admin can cancel directly.';
  END IF;
  IF NOT public.procurement_has_po(p_po_id) THEN
    RAISE EXCEPTION 'not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL = 'You can only request cancel on a purchase order tagged with your business (MH / QT).';
  END IF;

  v_po := public._po_cancel_require_open_po(p_po_id);
  INSERT INTO public.po_cancel_requests (
    purchase_order_id, requested_by, reason, status
  ) VALUES (
    p_po_id, v_uid, v_reason, 'pending'
  ) RETURNING id INTO v_req;

  PERFORM public._po_cancel_ledger_write(
    'cancel_requested',
    p_po_id,
    v_req,
    jsonb_build_object('order_number', v_po.order_number, 'status', v_po.status),
    jsonb_build_object('request_id', v_req, 'status', 'pending', 'reason', v_reason),
    jsonb_build_object('source', '089_po_cancel_request')
  );

  RETURN jsonb_build_object('success', true, 'request_id', v_req, 'status', 'pending');
END;
$$;
REVOKE ALL ON FUNCTION public.request_cancel_purchase_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_cancel_purchase_order(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_po_cancel_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.po_cancel_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'forbidden'
      USING ERRCODE = 'P0001',
            DETAIL = 'Only an admin can approve a purchase-order cancel request.';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request_id' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_req FROM public.po_cancel_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_req.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'request_already_decided'
      USING ERRCODE = 'P0001',
            DETAIL = 'This cancel request has already been ' || v_req.status || '.';
  END IF;
  IF v_req.requested_by = v_uid THEN
    RAISE EXCEPTION 'cannot_decide_own_request'
      USING ERRCODE = 'P0001',
            DETAIL = 'You cannot approve your own cancel request.';
  END IF;

  UPDATE public.po_cancel_requests
     SET status = 'approved', decided_by = v_uid, decided_at = now()
   WHERE id = p_request_id;

  RETURN public._po_cancel_apply(v_req.purchase_order_id, p_request_id);
END;
$$;
REVOKE ALL ON FUNCTION public.approve_po_cancel_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_po_cancel_request(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_po_cancel_request(p_request_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text;
  v_req public.po_cancel_requests%ROWTYPE;
  v_po public.purchase_orders%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'forbidden'
      USING ERRCODE = 'P0001',
            DETAIL = 'Only an admin can reject a purchase-order cancel request.';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request_id' USING ERRCODE = 'P0001';
  END IF;
  v_reason := public._po_cancel_trim_reason(p_reason);

  SELECT * INTO v_req FROM public.po_cancel_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_req.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'request_already_decided'
      USING ERRCODE = 'P0001',
            DETAIL = 'This cancel request has already been ' || v_req.status || '.';
  END IF;
  IF v_req.requested_by = v_uid THEN
    RAISE EXCEPTION 'cannot_decide_own_request'
      USING ERRCODE = 'P0001',
            DETAIL = 'You cannot reject your own cancel request.';
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = v_req.purchase_order_id FOR UPDATE;

  UPDATE public.po_cancel_requests
     SET status = 'rejected', decided_by = v_uid, decided_at = now(), decision_reason = v_reason
   WHERE id = p_request_id;

  PERFORM public._po_cancel_ledger_write(
    'cancel_rejected',
    v_req.purchase_order_id,
    p_request_id,
    jsonb_build_object('request_status', 'pending', 'reason', v_req.reason),
    jsonb_build_object('request_status', 'rejected', 'decision_reason', v_reason, 'po_status', v_po.status),
    jsonb_build_object('source', '089_po_cancel_reject')
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'rejected');
END;
$$;
REVOKE ALL ON FUNCTION public.reject_po_cancel_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_po_cancel_request(uuid, text) TO authenticated;

INSERT INTO public.procurement_exposure_allow (kind, name, note) VALUES
  ('function', 'request_cancel_purchase_order',
   'procurement (own entity) submits a pending cancel request. Admin path is a direct self-approved cancel. Body RAISES. No client table writes.')
ON CONFLICT (kind, name) DO UPDATE SET note = EXCLUDED.note;
INSERT INTO public.procurement_exposure_allow (kind, name, note) VALUES
  ('function', 'approve_po_cancel_request',
   'admin only, never the requester. Applies the 088 tagged reversal then marks the PO cancelled. Body RAISES.')
ON CONFLICT (kind, name) DO UPDATE SET note = EXCLUDED.note;
INSERT INTO public.procurement_exposure_allow (kind, name, note) VALUES
  ('function', 'reject_po_cancel_request',
   'admin only, never the requester. Mandatory reason. Body RAISES.')
ON CONFLICT (kind, name) DO UPDATE SET note = EXCLUDED.note;

-- classify po_cancel_requests (allow-listed above) and any other public RLS table 089 did not name
SELECT public.procurement_default_deny_sweep();
