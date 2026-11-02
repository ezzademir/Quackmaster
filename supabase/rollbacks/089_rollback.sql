-- Rollback order: 089 -> 090 -> 088 -> 087 -> 085 -> 084 (newest first). Apply order: 084, 085, 087, 088, 090, then 089.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file> (or one Supabase SQL editor / execute_sql call). NEVER plain `psql -f`: it keeps going after an error and leaves a half-done rollback.
-- Rollback 089 (PO cancel request / approval). Safe to run FIRST while 090/088/087/085/084 are still live.
-- Drops the requests table and the 089 RPCs / helpers, removes the 089 allow-list rows (tolerates those
-- tables already being gone), restores supplier_scorecard_metrics to the 081 body (security_invoker kept),
-- and restores the 088 cancel_purchase_order (tagged reversal, jsonb soft-return,
-- _append_data_ledger, may delete a PO with no receipt-record FK). Ledger rows 089 wrote are NOT deleted
-- (the ledger is append-only).
-- REFUSES while any po_cancel_requests row has status = pending (RAISE, so a -1 batch changes nothing).
-- Already-decided request rows (approved / rejected) are discarded with the table when this rollback is
-- allowed to run; they are not archived. The ledger keeps cancel_requested / cancelled / cancel_rejected.
-- Independent of 090: nothing here reads or writes 090 objects.

DO $$ BEGIN
  IF to_regclass('public.po_cancel_requests') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.po_cancel_requests WHERE status = 'pending') THEN
      RAISE EXCEPTION '089_rollback_refused_pending_requests'
        USING ERRCODE = 'P0001',
              DETAIL = 'Rollback 089 refuses to run while any po_cancel_requests row is pending. Approve or reject them first. Already-decided (approved/rejected) request rows are discarded with the table when this rollback is allowed to run; the ledger keeps cancel_requested / cancelled / cancel_rejected events.';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.reject_po_cancel_request(uuid, text);
DROP FUNCTION IF EXISTS public.approve_po_cancel_request(uuid);
DROP FUNCTION IF EXISTS public.request_cancel_purchase_order(uuid, text);
DROP FUNCTION IF EXISTS public._po_cancel_apply(uuid, uuid);
DROP FUNCTION IF EXISTS public._po_cancel_require_open_po(uuid);
DROP FUNCTION IF EXISTS public._po_cancel_ledger_write(text, uuid, uuid, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public._po_cancel_trim_reason(text);
DROP TABLE IF EXISTS public.po_cancel_requests;
DO $$ BEGIN
  IF to_regclass('public.procurement_exposure_allow') IS NOT NULL THEN
    DELETE FROM public.procurement_exposure_allow
     WHERE kind = 'function'
       AND name IN ('request_cancel_purchase_order', 'approve_po_cancel_request', 'reject_po_cancel_request');
  END IF;
  IF to_regclass('public.procurement_table_allow') IS NOT NULL THEN
    DELETE FROM public.procurement_table_allow WHERE table_name = 'po_cancel_requests';
  END IF;
END $$;

-- restore the 088 cancel_purchase_order (verbatim from 20261024100200_088_stock_entity_tags.sql)
CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_keep boolean;
  v_lines jsonb := '[]'::jsonb;
  v_before jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  -- ADMIN ONLY (Ezzad, 24 Oct 2026: "nobody can cancel the purchase order without the approval of the admin"). The live function
  -- also let plain active staff cancel any PO; that is closed here, in the database, so a direct RPC call by staff, procurement
  -- or anon is refused too. (089 adds the procurement request / admin-approval path; this function stays admin-only.)
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only an admin can cancel a purchase order');
  END IF;

  IF p_po_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_po_id');
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_found');
  END IF;
  IF v_po.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_cancelled');
  END IF;
  -- BILL RULE (Ezzad, 24 Oct 2026: "follow the proper steps, accounting flow"). A PO with a bill cannot be cancelled while the bill
  -- exists: no silent cancel that leaves a bill 'unpaid', and cancel never deletes or edits accounting records (bills, payments).
  -- The repo has NO void / reverse route for a bill (supplier_bills has no status or voided column, no void function), so every
  -- bill row counts as live. Until such a route is built (follow-up), the only way past this refusal is an admin changing the
  -- accounting records themselves, deliberately and audited (payments are ledgered on delete), then cancelling.
  IF EXISTS (SELECT 1 FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'bills_on_po',
      'bill_count', (SELECT count(*) FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id),
      'bill_numbers', (SELECT jsonb_agg(b.bill_number ORDER BY b.bill_number) FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id),
      'message', 'This purchase order has a supplier bill. Handle the bill through accounting first (void or reverse it, with any payments handled in the payments record), then cancel. Nothing was cancelled.');
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

  -- records that make a hard DELETE impossible (RESTRICT foreign keys): such a PO is kept, as 'cancelled'
  -- (bills cannot be present here: refused above; the term stays as a safety net)
  v_keep := EXISTS (SELECT 1 FROM public.po_receipt_records r WHERE r.purchase_order_id = p_po_id)
         OR EXISTS (SELECT 1 FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id)
         OR EXISTS (SELECT 1 FROM public.price_history ph JOIN public.purchase_order_items poi ON poi.id = ph.purchase_order_item_id
                    WHERE poi.purchase_order_id = p_po_id);

  -- Phase 1: lock + validate everything that must be reversed (no hub/WAC writes).
  PERFORM 1 FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0
   ORDER BY poi.id DESC FOR UPDATE OF poi;

  IF EXISTS (SELECT 1 FROM public.purchase_order_items poi
             WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0 AND poi.raw_material_id IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_raw_material');
  END IF;
  IF v_keep AND v_po.entity_code IS NULL AND EXISTS (SELECT 1 FROM public._po_cancel_plan(p_po_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_entity_required',
      'message', 'Set the PO entity (QT / MH) before cancelling a received PO.');
  END IF;
  IF public._stock_tag_enforced('hub_rm') AND EXISTS (SELECT 1 FROM public._po_cancel_plan(p_po_id) pl WHERE pl.tag IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'stock_entity_tag_required',
      'message', 'Part of this PO was received before stock tags existed and cannot be reversed while tags are enforced.');
  END IF;

  -- per raw material (all lines of this PO together)
  FOR v_step IN SELECT pl.rm_id, SUM(pl.qty) AS q FROM public._po_cancel_plan(p_po_id) pl GROUP BY pl.rm_id ORDER BY pl.rm_id LOOP
    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_step.rm_id
    ORDER BY hi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_hub_row IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'cannot_cancel_missing_hub_row', 'raw_material_id', v_step.rm_id);
    END IF;

    IF v_qoh < v_step.q THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_hub_quantity',
        'raw_material_id', v_step.rm_id,
        'on_hand', v_qoh,
        'required_return', v_step.q,
        'message', 'Stock received on this PO has already been partly used (on hand ' || v_qoh || ', needed ' || v_step.q ||
                   '). Nothing was cancelled; reverse the usage first.'
      );
    END IF;

    IF (v_qoh - v_step.q) < v_res THEN
      RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved', 'raw_material_id', v_step.rm_id);
    END IF;

    PERFORM 1 FROM public.raw_materials r WHERE r.id = v_step.rm_id FOR UPDATE;
  END LOOP;

  -- per raw material and tag: the tagged balance must not go negative
  FOR v_step IN SELECT pl.rm_id, pl.tag, SUM(pl.qty) AS q FROM public._po_cancel_plan(p_po_id) pl WHERE pl.tag IS NOT NULL
                GROUP BY pl.rm_id, pl.tag ORDER BY pl.rm_id, pl.tag LOOP
    SELECT COALESCE(SUM(m.quantity), 0) INTO v_tagged
    FROM public.hub_stock_movements m JOIN public.hub_inventory hi ON hi.id = m.hub_inventory_id
    WHERE hi.raw_material_id = v_step.rm_id AND m.entity_code = v_step.tag;
    IF v_tagged < v_step.q THEN
      RETURN jsonb_build_object('success', false, 'error', 'insufficient_tagged_stock',
        'raw_material_id', v_step.rm_id, 'entity_code', v_step.tag, 'on_hand', v_tagged, 'required_return', v_step.q,
        'message', 'Stock received on this PO has already been partly used (' || v_step.tag || ' balance ' || v_tagged ||
                   ', needed ' || v_step.q || '). Nothing was cancelled.');
    END IF;
  END LOOP;

  -- Phase 2: reverse receipts, each with the tag its receipt carried. RAISE on unexpected failure after mutations begin.
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

    -- 088: the reversal carries the tag of the receipt it undoes (empty = that part was received untagged)
    PERFORM set_config('app.stock_entity', COALESCE(v_step.tag, ''), true);
    PERFORM set_config('app.stock_po_item', v_step.item_id::text, true);
    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = hi.quantity_on_hand - v_rcv,
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

  IF v_keep THEN
    -- close the receipt records (they hold CUMULATIVE totals): a final row of 0 per line, then the lines go back to 0
    INSERT INTO public.po_receipt_records (purchase_order_id, purchase_order_item_id, quantity_received, quantity_uom, do_number, entered_by)
    SELECT p_po_id, r.purchase_order_item_id, 0, (array_agg(r.quantity_uom ORDER BY r.id DESC))[1], 'PO CANCELLED', auth.uid()
    FROM public.po_receipt_records r
    JOIN public.purchase_order_items poi ON poi.id = r.purchase_order_item_id AND COALESCE(poi.quantity_received, 0) > 0
    WHERE r.purchase_order_id = p_po_id
    GROUP BY r.purchase_order_item_id;
    UPDATE public.purchase_order_items poi SET quantity_received = 0, line_total = 0
     WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0;
  END IF;
  PERFORM set_config('app.stock_entity', '', true);
  PERFORM set_config('app.stock_po_item', '', true);

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
    jsonb_build_object('reversal_lines', v_lines, 'po_kept_as_cancelled', v_keep),
    NULL
  );

  IF v_keep THEN
    UPDATE public.purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = p_po_id;
  ELSE
    DELETE FROM public.purchase_orders WHERE id = p_po_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'reversal_lines', v_lines, 'po_kept_as_cancelled', v_keep);
END;
$function$;
-- Grants stated explicitly (round 3, G6) instead of relying on what 045/063 left in place: no PUBLIC, no anon (the body would refuse
-- an anonymous caller anyway: auth.uid() is NULL), signed-in clients only. CREATE OR REPLACE keeps the grants of the live function.
REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;

-- restore the 081 supplier_scorecard_metrics body (cancelled POs counted again); keep 085 security_invoker
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
     LEFT JOIN public.purchase_orders po ON po.supplier_id = s.id
     LEFT JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
  GROUP BY s.id, s.name;
REVOKE ALL ON public.supplier_scorecard_metrics FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.supplier_scorecard_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON public.supplier_scorecard_metrics TO authenticated;
