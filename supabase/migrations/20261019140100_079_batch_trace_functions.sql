-- [HOLD] Batch traceability: FUNCTION changes (19 Oct 2026). NOT APPLIED — pending Clive/Ezzad review.
-- Requires 078 (schema) first. Rollback: supabase/rollbacks/079_rollback.sql.
--
-- 1. dispatch_supply_order: batches are RE-PICKED AT DISPATCH, oldest expiry first, ties by
--    production run number ascending. The creation-time pick is a preview/hold only: this order's
--    finished-goods reservations are released and the order's FG lines are rewritten to the batches
--    actually shipped (hub_inventory_id + lot_id), so receive_supply_order (unchanged) credits the
--    outlet with exactly those batches. Expired batches are NOT refused: the line is flagged
--    expired_at_dispatch = true and the RPC returns expired_lines / expired_qty for a UI warning.
--    Shortfall still RAISEs (whole dispatch rolls back). Raw-material lines are unchanged.
-- 2. fg_lot_run_seq(lot_id): numeric run sequence (RUN-0112 -> 112) used as the FEFO tie-break.
-- 3. post_sales_journal: FEFO for EVERY line (expiry, then run number, same order as dispatch),
--    including lines that name an outlet_inventory_id; expired batches are sold but flagged
--    expired_at_sale (line, movement metadata, ledger, RPC result). Validation before any write.
-- 4. post_waste_event: records outlet_inventory_id + lot_id on waste_lines; same FIFO tie-break.
-- 5. post_outlet_stock_take: records lot_id on outlet_stock_take_lines; a NULL p_count_date now
--    defaults to today in MYT (was CURRENT_DATE = UTC date, wrong 00:00-08:00 MYT).

-- Drift guard: every function rewritten below must still be the exact live body captured on
-- 19 Oct 2026 (md5 of prosrc), or already be this migration's version (re-run). Otherwise abort,
-- so a function changed in production after the capture is never silently overwritten.
DO $guard$
DECLARE
  v_fn record;
  v_src text;
BEGIN
  FOR v_fn IN SELECT * FROM (VALUES
    ('public.dispatch_supply_order(uuid)', 'ed225eeb0f32c942f60d99dbe9da144a'),
    ('public.post_waste_event(text, uuid, date, jsonb, text, uuid)', 'aadd8c5674e2df6d8a0915be765ab580'),
    ('public.post_outlet_stock_take(uuid, date, text, jsonb, uuid)', 'b0144df091890e55f6fa573f88d4d22a'),
    ('public.post_sales_journal(uuid, date, jsonb, text, uuid)', '203150c5c18d19049979f4e96d12a0d9')
  ) AS t(sig, md5)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_fn.sig);
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'batch_trace: % not found', v_fn.sig;
    END IF;
    IF md5(v_src) <> v_fn.md5 AND position('batch_trace_07' IN v_src) = 0 THEN
      RAISE EXCEPTION 'batch_trace: % drifted from the captured live body (md5 %), re-capture before applying', v_fn.sig, md5(v_src);
    END IF;
  END LOOP;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fg_lot_run_seq(p_lot_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT (regexp_match(pr.run_number, '(\d+)$'))[1]::bigint
  FROM public.inventory_lots il
  JOIN public.production_runs pr ON pr.id = il.production_run_id
  WHERE il.id = p_lot_id;
$$;
REVOKE ALL ON FUNCTION public.fg_lot_run_seq(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fg_lot_run_seq(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dispatch_supply_order(p_supply_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- batch_trace_079
DECLARE
  v_order public.supply_orders%ROWTYPE;
  v_ln RECORD;
  v_b RECORD;
  v_grp jsonb;
  v_groups jsonb;
  v_sku text;
  v_need numeric;
  v_remaining numeric;
  v_take numeric;
  v_dispatch_date date;
  v_updated int;
  v_expired boolean;
  v_prior jsonb;
  v_picked jsonb := '[]'::jsonb;
  v_expired_lines int := 0;
  v_expired_qty numeric := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT * INTO v_order
  FROM public.supply_orders
  WHERE id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  IF lower(trim(both from v_order.status)) <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_status',
      'status', v_order.status
    );
  END IF;

  v_dispatch_date := (timezone('Asia/Kuala_Lumpur', now()))::date;

  -- Every line must still point at a hub row.
  IF EXISTS (
    SELECT 1 FROM public.supply_order_lines sol
    LEFT JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
    WHERE sol.supply_order_id = p_supply_order_id AND hi.id IS NULL
  ) THEN
    RAISE EXCEPTION 'hub_inventory_missing' USING ERRCODE = 'P0001';
  END IF;

  -- 1. Raw-material lines: unchanged behaviour (fulfil the creation-time reservation).
  FOR v_ln IN
    SELECT sol.id, sol.hub_inventory_id, sol.quantity, hi.lot_id
    FROM public.supply_order_lines sol
    JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
    WHERE sol.supply_order_id = p_supply_order_id
      AND hi.raw_material_id IS NOT NULL
    ORDER BY sol.id
  LOOP
    -- RAISE from fulfill aborts the whole transaction (no partial ship)
    PERFORM public.fulfill_inventory_reservation(v_ln.hub_inventory_id, v_ln.quantity, p_supply_order_id);
    UPDATE public.supply_order_lines SET lot_id = v_ln.lot_id WHERE id = v_ln.id;
  END LOOP;

  -- 2. Finished goods: snapshot the creation-time preview, then release its reservations.
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object('hub_inventory_id', sol.hub_inventory_id, 'lot_id', hi.lot_id, 'quantity', sol.quantity) ORDER BY sol.id), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('sku', g.sku, 'qty', g.qty) ORDER BY g.sku)
      FROM (
        SELECT trim(both from hi2.product_batch) AS sku, SUM(sol2.quantity) AS qty
        FROM public.supply_order_lines sol2
        JOIN public.hub_inventory hi2 ON hi2.id = sol2.hub_inventory_id
        WHERE sol2.supply_order_id = p_supply_order_id AND hi2.raw_material_id IS NULL
        GROUP BY 1
      ) g
    ), '[]'::jsonb)
  INTO v_prior, v_groups
  FROM public.supply_order_lines sol
  JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
  WHERE sol.supply_order_id = p_supply_order_id AND hi.raw_material_id IS NULL;

  FOR v_ln IN
    SELECT r.id, r.hub_inventory_id, r.quantity
    FROM public.hub_inventory_reservations r
    JOIN public.hub_inventory hi ON hi.id = r.hub_inventory_id
    WHERE r.reference_id = p_supply_order_id
      AND r.reference_type = 'supply_order'
      AND hi.raw_material_id IS NULL
    ORDER BY r.hub_inventory_id
    FOR UPDATE OF r, hi
  LOOP
    UPDATE public.hub_inventory hi
    SET
      reserved_quantity = GREATEST(COALESCE(hi.reserved_quantity, 0) - v_ln.quantity, 0),
      available_quantity = hi.quantity_on_hand - GREATEST(COALESCE(hi.reserved_quantity, 0) - v_ln.quantity, 0),
      updated_at = now()
    WHERE hi.id = v_ln.hub_inventory_id;
    DELETE FROM public.hub_inventory_reservations WHERE id = v_ln.id;
  END LOOP;

  DELETE FROM public.supply_order_lines sol
  USING public.hub_inventory hi
  WHERE sol.supply_order_id = p_supply_order_id
    AND hi.id = sol.hub_inventory_id
    AND hi.raw_material_id IS NULL;

  -- 3. Re-pick per SKU at dispatch: oldest expiry first, then run number, then age.
  FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups)
  LOOP
    v_sku := v_grp->>'sku';
    v_need := (v_grp->>'qty')::numeric;
    v_remaining := v_need;

    FOR v_b IN
      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0) AS res,
             hi.lot_id, il.expiry_date, il.product_batch_label
      FROM public.hub_inventory hi
      LEFT JOIN public.inventory_lots il ON il.id = hi.lot_id
      LEFT JOIN public.production_runs pr ON pr.id = il.production_run_id
      WHERE hi.raw_material_id IS NULL
        AND trim(both from hi.product_batch) = v_sku
        AND hi.quantity_on_hand - COALESCE(hi.reserved_quantity, 0) > 0
      ORDER BY
        il.expiry_date ASC NULLS LAST,
        (regexp_match(pr.run_number, '(\d+)$'))[1]::bigint ASC NULLS LAST,
        il.manufactured_at ASC NULLS LAST,
        hi.created_at ASC NULLS LAST,
        hi.id ASC
      FOR UPDATE OF hi
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_b.quantity_on_hand - v_b.res, v_remaining);
      IF v_take <= 0 THEN
        CONTINUE;
      END IF;
      v_expired := v_b.expiry_date IS NOT NULL AND v_b.expiry_date < v_dispatch_date;

      UPDATE public.hub_inventory hi
      SET
        quantity_on_hand = hi.quantity_on_hand - v_take,
        available_quantity = (hi.quantity_on_hand - v_take) - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE hi.id = v_b.id;

      INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity, lot_id, expired_at_dispatch)
      VALUES (p_supply_order_id, v_b.id, v_sku, v_take, v_b.lot_id, v_expired);

      v_picked := v_picked || jsonb_build_array(jsonb_build_object(
        'hub_inventory_id', v_b.id,
        'lot_id', v_b.lot_id,
        'lot_label', v_b.product_batch_label,
        'expiry_date', v_b.expiry_date,
        'quantity', v_take,
        'expired', v_expired
      ));
      IF v_expired THEN
        v_expired_lines := v_expired_lines + 1;
        v_expired_qty := v_expired_qty + v_take;
      END IF;
      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
      -- Whole dispatch (including released reservations) rolls back.
      RAISE EXCEPTION 'insufficient_hub_quantity: % short by % at dispatch', v_sku, v_remaining
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'dispatched',
    dispatch_date = v_dispatch_date,
    updated_at = now()
  WHERE id = p_supply_order_id
    AND lower(trim(both from status)) = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'dispatch_status_race';
  END IF;

  PERFORM public._append_data_ledger(
    'dispatched',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'update',
    NULL,
    jsonb_build_object('status', 'pending', 'preview_lines', v_prior),
    jsonb_build_object('status', 'dispatched', 'dispatch_date', v_dispatch_date, 'lines', v_picked),
    NULL,
    jsonb_build_object(
      'entity_label', 'Supply order dispatched',
      'repicked_at_dispatch', true,
      'expired_lines', v_expired_lines,
      'expired_qty', v_expired_qty
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'dispatch_date', v_dispatch_date,
    'lines', v_picked,
    'expired_lines', v_expired_lines,
    'expired_qty', v_expired_qty
  );
END;
$function$;

-- Sales: every line is deducted FEFO (earliest expiry, then production run number) across the
-- outlet's batches of the same product, consistent with dispatch. A line that names an
-- outlet_inventory_id is resolved to that row's product (recipe SKU / lot label / batch code) and
-- still goes FEFO; the named row is kept as requested_outlet_inventory_id in the movement/ledger
-- metadata. A batch past expiry on the business date is still sold (never blocked) and flagged
-- expired_at_sale on the sales line, the movement metadata and the ledger; the RPC returns
-- expired_lines / expired_qty for a UI warning. Validation runs before any write (atomic).
CREATE OR REPLACE FUNCTION public.post_sales_journal(p_outlet_id uuid, p_business_date date, p_lines jsonb, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- batch_trace_079
DECLARE
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_journal_id uuid;
  rec jsonb;
  v_qty numeric;
  v_key text;
  v_exact uuid;
  v_req uuid;
  v_dkey text;
  v_plan jsonb := '[]'::jsonb;
  v_demand jsonb := '{}'::jsonb;
  v_total_avail numeric;
  v_remaining numeric;
  v_take numeric;
  v_avail numeric;
  v_expired boolean;
  v_sale_date date := COALESCE(p_business_date, (timezone('Asia/Kuala_Lumpur', now()))::date);
  v_lines_meta jsonb := '[]'::jsonb;
  v_expired_lines int := 0;
  v_expired_qty numeric := 0;
  r RECORD;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.is_authenticated_active_staff()
    OR public.is_supervisor_for_outlet(p_outlet_id)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.sales_journals WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'sales_journal_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  -- 1. Resolve every line to a product key (or an exact row when the row has no product identity).
  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_qty := NULLIF(rec->>'quantity_sold', '')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;
    v_key := NULL;
    v_exact := NULL;
    v_req := NULL;
    IF NULLIF(trim(both from coalesce(rec->>'outlet_inventory_id', '')), '') IS NOT NULL THEN
      v_req := (rec->>'outlet_inventory_id')::uuid;
      SELECT COALESCE(
               public.fg_recipe_sku(oi.lot_id),
               NULLIF(trim(both from il.product_batch_label), ''),
               NULLIF(trim(both from oi.product_batch), '')
             )
      INTO v_key
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      WHERE oi.id = v_req AND oi.outlet_id = p_outlet_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_not_found', 'outlet_inventory_id', v_req);
      END IF;
      IF v_key IS NULL THEN
        v_exact := v_req;
      END IF;
    ELSE
      v_key := NULLIF(trim(both from coalesce(rec->>'product_batch', '')), '');
      IF v_key IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'product_batch_or_outlet_inventory_id_required');
      END IF;
    END IF;
    v_dkey := COALESCE('sku:' || v_key, 'row:' || v_exact::text);
    v_demand := jsonb_set(v_demand, ARRAY[v_dkey], to_jsonb(COALESCE((v_demand->>v_dkey)::numeric, 0) + v_qty));
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('key', v_key, 'exact', v_exact, 'req', v_req, 'qty', v_qty));
  END LOOP;

  -- 2. Stock check per product (all lines of the same product together), locking the rows.
  FOR rec IN SELECT jsonb_build_object('k', k, 'q', q) FROM jsonb_each_text(v_demand) AS d(k, q)
  LOOP
    v_dkey := rec->>'k';
    SELECT COALESCE(SUM(GREATEST(x.quantity_on_hand - x.reserved_qty, 0)), 0) INTO v_total_avail
    FROM (
      SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0) AS reserved_qty
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      WHERE oi.outlet_id = p_outlet_id
        AND oi.quantity_on_hand > 0
        AND CASE
              WHEN left(v_dkey, 4) = 'row:' THEN oi.id = substr(v_dkey, 5)::uuid
              ELSE public.fg_identifier_matches(oi.product_batch, il.product_batch_label, public.fg_recipe_sku(oi.lot_id), substr(v_dkey, 5))
            END
      FOR UPDATE OF oi
    ) x;
    IF v_total_avail < (rec->>'q')::numeric THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_stock',
        'product_batch', substr(v_dkey, 5),
        'requested', (rec->>'q')::numeric,
        'available', v_total_avail
      );
    END IF;
  END LOOP;

  INSERT INTO public.sales_journals (outlet_id, business_date, status, notes, idempotency_key, created_by)
  VALUES (p_outlet_id, p_business_date, 'posted', p_notes, p_idempotency_key, v_uid)
  RETURNING id INTO v_journal_id;

  -- 3. Deduct FEFO: expiry ASC, run number ASC, then manufacture / row age (same order as dispatch).
  FOR rec IN SELECT * FROM jsonb_array_elements(v_plan)
  LOOP
    v_key := rec->>'key';
    v_exact := NULLIF(rec->>'exact', '')::uuid;
    v_req := NULLIF(rec->>'req', '')::uuid;
    v_remaining := (rec->>'qty')::numeric;

    FOR r IN
      SELECT oi.id AS inv_id, oi.product_batch, oi.lot_id, oi.quantity_on_hand,
             COALESCE(oi.reserved_quantity, 0) AS reserved_qty, il.expiry_date
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      WHERE oi.outlet_id = p_outlet_id
        AND oi.quantity_on_hand > 0
        AND CASE
              WHEN v_exact IS NOT NULL THEN oi.id = v_exact
              ELSE public.fg_identifier_matches(oi.product_batch, il.product_batch_label, public.fg_recipe_sku(oi.lot_id), v_key)
            END
      ORDER BY
        il.expiry_date ASC NULLS LAST,
        public.fg_lot_run_seq(oi.lot_id) ASC NULLS LAST,
        il.manufactured_at ASC NULLS LAST,
        oi.created_at ASC NULLS LAST,
        oi.id ASC
      FOR UPDATE OF oi
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_avail := GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
      v_take := LEAST(v_avail, v_remaining);
      CONTINUE WHEN v_take <= 0;
      v_expired := r.expiry_date IS NOT NULL AND r.expiry_date < v_sale_date;

      PERFORM public._set_outlet_movement_ctx(
        p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id,
        jsonb_build_object(
          'source', 'manual', 'mode', 'fefo',
          'lot_id', r.lot_id, 'expiry_date', r.expiry_date,
          'expired_at_sale', v_expired,
          'requested_outlet_inventory_id', v_req
        )
      );

      UPDATE public.outlet_inventory oi
      SET quantity_on_hand = oi.quantity_on_hand - v_take,
          available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
          last_updated = now(),
          updated_at = now()
      WHERE oi.id = r.inv_id;

      PERFORM public._clear_outlet_movement_ctx();

      INSERT INTO public.sales_journal_lines (sales_journal_id, product_batch, lot_id, quantity_sold, outlet_inventory_id, expired_at_sale)
      VALUES (v_journal_id, trim(both from coalesce(r.product_batch, '')), r.lot_id, v_take, r.inv_id, v_expired);

      v_lines_meta := v_lines_meta || jsonb_build_array(jsonb_build_object(
        'outlet_inventory_id', r.inv_id,
        'product_batch', trim(both from coalesce(r.product_batch, '')),
        'lot_id', r.lot_id,
        'expiry_date', r.expiry_date,
        'quantity_sold', v_take,
        'expired_at_sale', v_expired,
        'requested_outlet_inventory_id', v_req
      ));
      IF v_expired THEN
        v_expired_lines := v_expired_lines + 1;
        v_expired_qty := v_expired_qty + v_take;
      END IF;
      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'fifo_line_alloc_failed'
        USING ERRCODE = 'P0001', DETAIL = format('remaining %s batch %s', v_remaining, COALESCE(v_key, v_exact::text));
    END IF;
  END LOOP;

  PERFORM public._append_data_ledger(
    'posted', 'sales_journal', v_journal_id::text, 'sales', 'event', NULL, NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'business_date', p_business_date,
      'lines', v_lines_meta,
      'expired_lines', v_expired_lines,
      'expired_qty', v_expired_qty
    ),
    NULL,
    jsonb_build_object('notes', p_notes, 'allocation', 'fefo')
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id,
    'lines', v_lines_meta,
    'expired_lines', v_expired_lines,
    'expired_qty', v_expired_qty
  );
END;
$function$;

-- Waste: record the batch (outlet row + lot) on every waste line; same FIFO tie-break.
CREATE OR REPLACE FUNCTION public.post_waste_event(p_location_kind text, p_outlet_id uuid, p_waste_date date, p_lines jsonb, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- batch_trace_079
DECLARE
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_event_id uuid;
  rec jsonb;
  v_hub_id uuid;
  v_o_id uuid;
  v_batch text;
  v_qty numeric;
  v_reason text;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
  v_inv_id uuid;
  v_lot uuid;
  v_inv_raw text;
  v_remaining numeric;
  v_take numeric;
  v_total_avail numeric;
  r RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_location_kind = 'hub' THEN
    IF NOT public.is_authenticated_active_staff() THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
    END IF;
  ELSIF NOT (
    public.is_authenticated_active_staff()
    OR public.is_supervisor_for_outlet(p_outlet_id)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.waste_events WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'waste_event_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_location_kind NOT IN ('hub', 'outlet') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_location_kind');
  END IF;

  IF p_location_kind = 'outlet' AND p_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required');
  END IF;

  IF p_location_kind = 'hub' AND p_outlet_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_must_be_null_for_hub');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  IF p_location_kind = 'hub' THEN
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_hub_id := (rec->>'hub_inventory_id')::uuid;
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      IF v_hub_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_reason IS NULL OR v_reason = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_hub_line');
      END IF;
      SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0) INTO v_qoh, v_res
      FROM public.hub_inventory hi WHERE hi.id = v_hub_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_not_found');
      END IF;
      IF (v_qoh - v_res) < v_qty THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_hub_available');
      END IF;
    END LOOP;
  ELSE
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_o_id := (rec->>'outlet_id')::uuid;
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      v_inv_raw := trim(both from coalesce(rec->>'outlet_inventory_id', ''));
      v_batch := trim(both from coalesce(rec->>'product_batch', ''));
      IF v_o_id IS NULL OR v_o_id <> p_outlet_id OR v_qty IS NULL OR v_qty <= 0 OR v_reason IS NULL OR v_reason = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_outlet_line');
      END IF;
      IF v_inv_raw <> '' THEN
        v_inv_id := v_inv_raw::uuid;
        SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_qoh, v_res
        FROM public.outlet_inventory oi
        WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_not_found', 'outlet_inventory_id', v_inv_id);
        END IF;
        IF (v_qoh - v_res) < v_qty THEN
          RETURN jsonb_build_object('success', false, 'error', 'insufficient_outlet_available');
        END IF;
      ELSE
        IF v_batch = '' THEN
          RETURN jsonb_build_object('success', false, 'error', 'invalid_outlet_line');
        END IF;
        v_total_avail := 0;
        FOR r IN
          SELECT
            oi.id,
            oi.quantity_on_hand,
            COALESCE(oi.reserved_quantity, 0) AS reserved_qty
          FROM public.outlet_inventory oi
          LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
          WHERE oi.outlet_id = p_outlet_id
            AND oi.quantity_on_hand > 0
            AND public.fg_identifier_matches(
              oi.product_batch,
              il.product_batch_label,
              public.fg_recipe_sku(oi.lot_id),
              v_batch
            )
          ORDER BY
            il.expiry_date ASC NULLS LAST,
            public.fg_lot_run_seq(oi.lot_id) ASC NULLS LAST,
            il.manufactured_at ASC NULLS LAST,
            oi.created_at ASC NULLS LAST,
            oi.id ASC
          FOR UPDATE OF oi
        LOOP
          v_total_avail := v_total_avail + GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
        END LOOP;
        IF v_total_avail < v_qty THEN
          RETURN jsonb_build_object('success', false, 'error', 'insufficient_outlet_available');
        END IF;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.waste_events (location_kind, outlet_id, waste_date, status, notes, idempotency_key, created_by)
  VALUES (p_location_kind, CASE WHEN p_location_kind = 'outlet' THEN p_outlet_id ELSE NULL END,
    p_waste_date, 'posted', p_notes, p_idempotency_key, v_uid)
  RETURNING id INTO v_event_id;

  IF p_location_kind = 'hub' THEN
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_hub_id := (rec->>'hub_inventory_id')::uuid;
      v_batch := trim(rec->>'product_batch');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      INSERT INTO public.waste_lines (waste_event_id, hub_inventory_id, outlet_id, product_batch, quantity, waste_reason, lot_id)
      VALUES (v_event_id, v_hub_id, NULL, v_batch, v_qty, v_reason,
        (SELECT hi.lot_id FROM public.hub_inventory hi WHERE hi.id = v_hub_id));
      UPDATE public.hub_inventory hi SET
        quantity_on_hand = hi.quantity_on_hand - v_qty,
        available_quantity = (hi.quantity_on_hand - v_qty) - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE hi.id = v_hub_id;
    END LOOP;
  ELSE
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      v_inv_raw := trim(both from coalesce(rec->>'outlet_inventory_id', ''));
      v_batch := trim(both from coalesce(rec->>'product_batch', ''));
      IF v_inv_raw <> '' THEN
        v_inv_id := v_inv_raw::uuid;
        SELECT oi.product_batch, oi.lot_id INTO v_batch, v_lot
        FROM public.outlet_inventory oi
        WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
        FOR UPDATE;
        INSERT INTO public.waste_lines (waste_event_id, hub_inventory_id, outlet_id, product_batch, quantity, waste_reason, outlet_inventory_id, lot_id)
        VALUES (v_event_id, NULL, p_outlet_id, coalesce(v_batch, ''), v_qty, v_reason, v_inv_id, v_lot);
        PERFORM public._set_outlet_movement_ctx(p_outlet_id, 'waste', p_waste_date, 'waste_event', v_event_id);
        UPDATE public.outlet_inventory oi SET
          quantity_on_hand = oi.quantity_on_hand - v_qty,
          available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
          last_updated = now(), updated_at = now()
        WHERE oi.id = v_inv_id;
        PERFORM public._clear_outlet_movement_ctx();
      ELSE
        v_remaining := v_qty;
        FOR r IN
          SELECT
            oi.id,
            oi.product_batch,
            oi.lot_id,
            oi.quantity_on_hand,
            COALESCE(oi.reserved_quantity, 0) AS reserved_qty
          FROM public.outlet_inventory oi
          LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
          WHERE oi.outlet_id = p_outlet_id
            AND oi.quantity_on_hand > 0
            AND public.fg_identifier_matches(
              oi.product_batch,
              il.product_batch_label,
              public.fg_recipe_sku(oi.lot_id),
              v_batch
            )
          ORDER BY
            il.expiry_date ASC NULLS LAST,
            public.fg_lot_run_seq(oi.lot_id) ASC NULLS LAST,
            il.manufactured_at ASC NULLS LAST,
            oi.created_at ASC NULLS LAST,
            oi.id ASC
          FOR UPDATE OF oi
        LOOP
          EXIT WHEN v_remaining <= 0;
          v_avail := GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
          v_take := LEAST(v_avail, v_remaining);
          IF v_take <= 0 THEN
            CONTINUE;
          END IF;
          INSERT INTO public.waste_lines (waste_event_id, hub_inventory_id, outlet_id, product_batch, quantity, waste_reason, outlet_inventory_id, lot_id)
          VALUES (v_event_id, NULL, p_outlet_id, trim(both from r.product_batch), v_take, v_reason, r.id, r.lot_id);
          PERFORM public._set_outlet_movement_ctx(p_outlet_id, 'waste', p_waste_date, 'waste_event', v_event_id);
          UPDATE public.outlet_inventory oi SET
            quantity_on_hand = oi.quantity_on_hand - v_take,
            available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
            last_updated = now(), updated_at = now()
          WHERE oi.id = r.id;
          PERFORM public._clear_outlet_movement_ctx();
          v_remaining := v_remaining - v_take;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  PERFORM public._append_data_ledger(
    'posted', 'waste_event', v_event_id::text, 'waste', 'event', NULL, NULL,
    jsonb_build_object('location_kind', p_location_kind, 'outlet_id', p_outlet_id, 'waste_date', p_waste_date, 'lines', p_lines),
    NULL, jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object('success', true, 'waste_event_id', v_event_id);
END;
$function$;

-- Stock take: record the batch counted on every line; NULL count date = today in MYT.
CREATE OR REPLACE FUNCTION public.post_outlet_stock_take(p_outlet_id uuid, p_count_date date, p_notes text, p_lines jsonb, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- batch_trace_079
DECLARE
  v_uid uuid := auth.uid();
  v_session_id uuid;
  rec jsonb;
  v_oi_id uuid;
  v_lot uuid;
  v_counted numeric;
  v_remark text;
  v_qoh numeric;
  v_res numeric;
  v_sys numeric;
  v_var numeric;
  v_lines_out jsonb := '[]'::jsonb;
  v_existing uuid;
  seen_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_uid IS NULL OR NOT public.profile_can_post_outlet_stock_take(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.outlet_stock_take_sessions WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'session_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_outlet_id IS NULL OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_input');
  END IF;

  INSERT INTO public.outlet_stock_take_sessions (outlet_id, count_date, notes, idempotency_key, created_by)
  VALUES (p_outlet_id, COALESCE(p_count_date, (timezone('Asia/Kuala_Lumpur', now()))::date), NULLIF(trim(both from p_notes), ''), p_idempotency_key, v_uid)
  RETURNING id INTO v_session_id;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_counted := NULLIF(rec->>'counted_qty', '')::numeric;
    v_remark := NULLIF(trim(both from rec->>'line_remark'), '');

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0), oi.lot_id
    INTO v_qoh, v_res, v_lot FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id AND oi.outlet_id = p_outlet_id FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_not_found');
    END IF;

    v_sys := v_qoh;
    v_var := v_counted - v_sys;

    PERFORM public._set_outlet_movement_ctx(
      p_outlet_id, 'stock_take', COALESCE(p_count_date, (timezone('Asia/Kuala_Lumpur', now()))::date), 'outlet_stock_take', v_session_id
    );

    UPDATE public.outlet_inventory oi
    SET quantity_on_hand = v_counted, available_quantity = v_counted - v_res,
        last_updated = now(), updated_at = now()
    WHERE oi.id = v_oi_id;

    PERFORM public._clear_outlet_movement_ctx();

    INSERT INTO public.outlet_stock_take_lines (session_id, outlet_inventory_id, system_qoh_before, counted_qty, variance, line_remark, lot_id)
    VALUES (v_session_id, v_oi_id, v_sys, v_counted, v_var, v_remark, v_lot);

    v_lines_out := v_lines_out || jsonb_build_array(
      jsonb_build_object('outlet_inventory_id', v_oi_id, 'lot_id', v_lot, 'system_qoh_before', v_sys, 'counted_qty', v_counted, 'variance', v_var)
    );
  END LOOP;

  PERFORM public._append_data_ledger(
    'posted', 'outlet_stock_take', v_session_id::text, 'inventory', 'event', NULL, NULL,
    jsonb_build_object('outlet_id', p_outlet_id, 'count_date', COALESCE(p_count_date, (timezone('Asia/Kuala_Lumpur', now()))::date), 'lines', v_lines_out),
    NULL, jsonb_build_object('notes', p_notes)
  );

  PERFORM public._post_stock_take_snapshot_hook(p_outlet_id, COALESCE(p_count_date, (timezone('Asia/Kuala_Lumpur', now()))::date));

  RETURN jsonb_build_object('success', true, 'session_id', v_session_id, 'lines', v_lines_out);
END;
$function$;
