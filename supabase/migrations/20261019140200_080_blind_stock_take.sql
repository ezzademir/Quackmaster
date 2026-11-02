-- [HOLD] Blind stock take, enforced server-side (19 Oct 2026). NOT APPLIED — pending Clive/Ezzad review.
-- Requires 078 (outlet_stock_take_sessions.status/opened_at/opened_by, outlet_stock_take_lines.lot_id)
-- and 079. Rollback: supabase/rollbacks/080_rollback.sql (run before 079/078 rollbacks).
--
-- Rules
--   * Every count is blind: the counter never receives system quantity, reserved quantity or variance.
--   * A count is a server-side session: start_outlet_stock_take -> (get_outlet_stock_take_sheet)
--     -> submit_outlet_stock_take | cancel_outlet_stock_take. One open count per outlet.
--   * The count sheet (RPC) carries batch identity only (row id, lot, SKU, expiry, run number, item).
--   * While a count is open for an outlet, non-admins cannot read that outlet's quantities at all:
--     RESTRICTIVE RLS on outlet_inventory, outlet_stock_movements (qoh_after) and
--     outlet_inventory_snapshots, and the balance/reconcile RPCs refuse with stock_take_in_progress.
--   * Variance is computed only at submission. Only active admins see it: the submit result for
--     non-admins has no system/variance fields, and outlet_stock_take_lines is admin-only under RLS.
--   * post_outlet_stock_take (old signature) no longer accepts free-form counts; it only submits into
--     the outlet's open blind session (error blind_count_session_required otherwise), so an old
--     client cannot post a count it pre-filled from system quantity.
--   * Operations keep working during a count: post_sales_journal, post_waste_event, dispatch and
--     receive_supply_order are SECURITY DEFINER owned by postgres (BYPASSRLS, tables not FORCE RLS),
--     so the caller's hidden-stock RLS does not apply inside them and none of them call the three
--     refusing balance RPCs. The Sales/Waste screens list batches during a count through
--     get_outlet_sale_batches (identity only, no quantities).
--   * Variance basis: counted - system qty AT SUBMIT (which already includes sales/receipts/waste
--     posted while the count was open). The system qty per batch at open is snapshotted into
--     outlet_stock_take_open_balances (admin-only) and each line records system_qoh_at_open and
--     qty_moved_during_count, so an admin can see when a variance coincides with stock that moved
--     mid-count (e.g. a sale posted for goods sold before they were counted).
--   * Submission validates every line before writing (the live body could RETURN an error after
--     writing earlier lines; now all-or-nothing).

-- Drift guards: post_outlet_stock_take must be the 079 version; the three balance RPCs must still
-- contain exactly one auth check to anchor the guard (or already be patched).
DO $guard$
DECLARE
  v_src text;
  v_sig text;
  v_needle constant text := E'RETURN jsonb_build_object(''success'', false, ''error'', ''not_authenticated'');\n  END IF;';
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.post_outlet_stock_take(uuid, date, text, jsonb, uuid)');
  IF v_src IS NULL OR (position('batch_trace_079' IN v_src) = 0 AND position('batch_trace_080' IN v_src) = 0) THEN
    RAISE EXCEPTION 'blind_stock_take: apply 079 first (post_outlet_stock_take is not the 079 version)';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY[
    'public.reconcile_outlet_stock(uuid, date, date, boolean)',
    'public.reconcile_outlet_stock_by_sku(uuid, date, date, boolean)',
    'public.get_outlet_balance_as_of(uuid, date, boolean)'
  ]
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_sig);
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'blind_stock_take: % not found', v_sig;
    END IF;
    IF position('stock_qty_hidden_for_outlet' IN v_src) = 0
       AND (length(v_src) - length(replace(v_src, v_needle, ''))) / length(v_needle) <> 1 THEN
      RAISE EXCEPTION 'blind_stock_take: % drifted (expected exactly one not_authenticated check)', v_sig;
    END IF;
  END LOOP;
END
$guard$;

-- Who may see system quantity / variance of stock takes: active admins.
CREATE OR REPLACE FUNCTION public.can_view_stock_take_variance()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active AND lower(trim(both from p.role::text)) = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.outlet_has_open_stock_take(p_outlet_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_outlet_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.outlet_stock_take_sessions s WHERE s.outlet_id = p_outlet_id AND s.status = 'open'
  );
$$;

-- TRUE when the caller must not see this outlet's quantities (blind count open, caller not admin).
CREATE OR REPLACE FUNCTION public.stock_qty_hidden_for_outlet(p_outlet_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.outlet_has_open_stock_take(p_outlet_id) AND NOT public.can_view_stock_take_variance();
$$;

-- Count sheet: batch identity only, never quantities. Rows on hand, or touched in the last 60 days
-- (so a batch the system thinks is gone can still be counted).
CREATE OR REPLACE FUNCTION public._stock_take_sheet(p_outlet_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'outlet_inventory_id', oi.id,
      'raw_material_id', oi.raw_material_id,
      'product_batch', oi.product_batch,
      'lot_id', oi.lot_id,
      'lot_label', il.product_batch_label,
      'recipe_sku', public.fg_recipe_sku(oi.lot_id),
      'expiry_date', il.expiry_date,
      'run_number', pr.run_number,
      'item_name', rm.name,
      'unit_of_measure', rm.unit_of_measure
    ) ORDER BY (oi.raw_material_id IS NOT NULL), il.expiry_date ASC NULLS LAST,
      public.fg_lot_run_seq(oi.lot_id) ASC NULLS LAST, il.product_batch_label, oi.product_batch, rm.name, oi.id), '[]'::jsonb)
  FROM public.outlet_inventory oi
  LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
  LEFT JOIN public.production_runs pr ON pr.id = il.production_run_id
  LEFT JOIN public.raw_materials rm ON rm.id = oi.raw_material_id
  WHERE oi.outlet_id = p_outlet_id
    AND (oi.quantity_on_hand <> 0 OR COALESCE(oi.last_updated, oi.created_at) >= now() - interval '60 days');
$$;

CREATE OR REPLACE FUNCTION public.start_outlet_stock_take(p_outlet_id uuid, p_count_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
-- batch_trace_080
DECLARE
  v_uid uuid := auth.uid();
  v_sess public.outlet_stock_take_sessions%ROWTYPE;
  v_resumed boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.profile_can_post_outlet_stock_take(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT * INTO v_sess FROM public.outlet_stock_take_sessions
  WHERE outlet_id = p_outlet_id AND status = 'open' FOR UPDATE;
  IF FOUND THEN
    v_resumed := true;
  ELSE
    BEGIN
      INSERT INTO public.outlet_stock_take_sessions (outlet_id, count_date, notes, created_by, status, opened_at, opened_by)
      VALUES (p_outlet_id, COALESCE(p_count_date, (timezone('Asia/Kuala_Lumpur', now()))::date),
              NULLIF(trim(both from p_notes), ''), v_uid, 'open', now(), v_uid)
      RETURNING * INTO v_sess;
      INSERT INTO public.outlet_stock_take_open_balances (session_id, outlet_inventory_id, qoh_at_open)
      SELECT v_sess.id, oi.id, oi.quantity_on_hand FROM public.outlet_inventory oi WHERE oi.outlet_id = p_outlet_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_sess FROM public.outlet_stock_take_sessions WHERE outlet_id = p_outlet_id AND status = 'open';
      v_resumed := true;
    END;
    PERFORM public._append_data_ledger(
      'opened', 'outlet_stock_take', v_sess.id::text, 'inventory', 'event', NULL, NULL,
      jsonb_build_object('outlet_id', p_outlet_id, 'count_date', v_sess.count_date, 'blind', true),
      NULL, NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'session_id', v_sess.id,
    'count_date', v_sess.count_date,
    'opened_at', v_sess.opened_at,
    'resumed', v_resumed,
    'lines', public._stock_take_sheet(p_outlet_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_outlet_stock_take_sheet(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
-- batch_trace_080
DECLARE
  v_sess public.outlet_stock_take_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_sess FROM public.outlet_stock_take_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
  END IF;
  IF auth.uid() IS NULL OR NOT public.profile_can_post_outlet_stock_take(v_sess.outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;
  IF v_sess.status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_open');
  END IF;
  RETURN jsonb_build_object(
    'success', true, 'session_id', v_sess.id, 'outlet_id', v_sess.outlet_id, 'count_date', v_sess.count_date,
    'lines', public._stock_take_sheet(v_sess.outlet_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_outlet_stock_take(p_session_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
-- batch_trace_080
DECLARE
  v_uid uuid := auth.uid();
  v_sess public.outlet_stock_take_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_sess FROM public.outlet_stock_take_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
  END IF;
  IF v_uid IS NULL OR NOT (public.can_view_stock_take_variance()
     OR (v_sess.opened_by = v_uid AND public.profile_can_post_outlet_stock_take(v_sess.outlet_id))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;
  IF v_sess.status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_open');
  END IF;
  UPDATE public.outlet_stock_take_sessions
  SET status = 'cancelled', notes = concat_ws(' · ', notes, NULLIF(trim(both from p_reason), ''))
  WHERE id = p_session_id;
  PERFORM public._append_data_ledger(
    'cancelled', 'outlet_stock_take', p_session_id::text, 'inventory', 'event', NULL, NULL,
    jsonb_build_object('outlet_id', v_sess.outlet_id, 'reason', p_reason), NULL, NULL
  );
  RETURN jsonb_build_object('success', true, 'session_id', p_session_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_outlet_stock_take(p_session_id uuid, p_lines jsonb, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
-- batch_trace_080
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
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.outlet_stock_take_sessions
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

  -- Validate everything before writing anything.
  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := NULLIF(trim(both from coalesce(rec->>'outlet_inventory_id', '')), '')::uuid;
    v_counted := NULLIF(trim(both from coalesce(rec->>'counted_qty', '')), '')::numeric;
    IF v_oi_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;
    IF v_oi_id = ANY (v_seen) THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_outlet_inventory_id');
    END IF;
    v_seen := v_seen || v_oi_id;
    PERFORM 1 FROM public.outlet_inventory oi WHERE oi.id = v_oi_id AND oi.outlet_id = v_sess.outlet_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_not_found');
    END IF;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := (rec->>'outlet_inventory_id')::uuid;
    v_counted := (rec->>'counted_qty')::numeric;
    v_remark := NULLIF(trim(both from rec->>'line_remark'), '');

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0), oi.lot_id
    INTO v_qoh, v_res, v_lot
    FROM public.outlet_inventory oi WHERE oi.id = v_oi_id;

    -- Variance against stock at submit; open-time qty is audit only (0 = batch arrived mid-count).
    v_var := v_counted - v_qoh;
    SELECT ob.qoh_at_open INTO v_open FROM public.outlet_stock_take_open_balances ob
    WHERE ob.session_id = v_sess.id AND ob.outlet_inventory_id = v_oi_id;
    v_open := COALESCE(v_open, 0);
    v_moved := v_qoh - v_open;

    PERFORM public._set_outlet_movement_ctx(
      v_sess.outlet_id, 'stock_take', v_sess.count_date, 'outlet_stock_take', v_sess.id,
      jsonb_build_object('blind', true)
    );
    UPDATE public.outlet_inventory oi
    SET quantity_on_hand = v_counted, available_quantity = v_counted - v_res,
        last_updated = now(), updated_at = now()
    WHERE oi.id = v_oi_id;
    PERFORM public._clear_outlet_movement_ctx();

    INSERT INTO public.outlet_stock_take_lines (session_id, outlet_inventory_id, system_qoh_before, counted_qty, variance, line_remark, lot_id,
                                                system_qoh_at_open, qty_moved_during_count)
    VALUES (v_sess.id, v_oi_id, v_qoh, v_counted, v_var, v_remark, v_lot, v_open, v_moved);

    v_lines_out := v_lines_out || jsonb_build_array(jsonb_build_object(
      'outlet_inventory_id', v_oi_id, 'lot_id', v_lot, 'system_qoh_before', v_qoh, 'counted_qty', v_counted, 'variance', v_var,
      'system_qoh_at_open', v_open, 'qty_moved_during_count', v_moved
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
    NULL, jsonb_build_object('notes', COALESCE(NULLIF(trim(both from p_notes), ''), v_sess.notes))
  );

  PERFORM public._post_stock_take_snapshot_hook(v_sess.outlet_id, v_sess.count_date);

  IF public.can_view_stock_take_variance() THEN
    RETURN jsonb_build_object('success', true, 'session_id', v_sess.id, 'lines_counted', v_n, 'lines', v_lines_out);
  END IF;
  -- Counter (non-admin): confirmation only, no system quantity or variance.
  RETURN jsonb_build_object('success', true, 'session_id', v_sess.id, 'lines_counted', v_n);
END;
$function$;

-- Old signature: only submits into the outlet's open blind session.
CREATE OR REPLACE FUNCTION public.post_outlet_stock_take(p_outlet_id uuid, p_count_date date, p_notes text, p_lines jsonb, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- batch_trace_080
DECLARE
  v_uid uuid := auth.uid();
  v_session uuid;
  v_existing uuid;
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
  SELECT id INTO v_session FROM public.outlet_stock_take_sessions
  WHERE outlet_id = p_outlet_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'blind_count_session_required');
  END IF;
  IF p_count_date IS NOT NULL THEN
    UPDATE public.outlet_stock_take_sessions SET count_date = p_count_date WHERE id = v_session;
  END IF;
  RETURN public.submit_outlet_stock_take(v_session, p_lines, p_notes, p_idempotency_key);
END;
$function$;

-- Sales / Waste screens: FG batches on hand at the outlet, identity only (FEFO order). Works while
-- a blind count hides outlet_inventory from the caller; never returns quantities. Same permission
-- as post_sales_journal.
CREATE OR REPLACE FUNCTION public.get_outlet_sale_batches(p_outlet_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
-- batch_trace_080
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_authenticated_active_staff() OR public.is_supervisor_for_outlet(p_outlet_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'hidden', public.stock_qty_hidden_for_outlet(p_outlet_id),
    'rows', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', oi.id,
          'product_batch', oi.product_batch,
          'created_at', oi.created_at,
          'lot', CASE WHEN il.id IS NULL THEN NULL ELSE jsonb_build_object(
            'expiry_date', il.expiry_date,
            'manufactured_at', il.manufactured_at,
            'product_batch_label', il.product_batch_label,
            'production_run', jsonb_build_object('run_number', pr.run_number,
              'recipe', jsonb_build_object('default_product_batch', public.fg_recipe_sku(oi.lot_id)))
          ) END
        ) ORDER BY il.expiry_date ASC NULLS LAST, public.fg_lot_run_seq(oi.lot_id) ASC NULLS LAST,
          il.manufactured_at ASC NULLS LAST, oi.created_at, oi.id), '[]'::jsonb)
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      LEFT JOIN public.production_runs pr ON pr.id = il.production_run_id
      WHERE oi.outlet_id = p_outlet_id AND oi.raw_material_id IS NULL AND oi.quantity_on_hand > 0
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.can_view_stock_take_variance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.outlet_has_open_stock_take(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stock_qty_hidden_for_outlet(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._stock_take_sheet(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_outlet_stock_take(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_outlet_stock_take_sheet(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_outlet_stock_take(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_outlet_stock_take(uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_outlet_sale_batches(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_view_stock_take_variance() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.outlet_has_open_stock_take(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stock_qty_hidden_for_outlet(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_outlet_stock_take(uuid, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_outlet_stock_take_sheet(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_stock_take(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_outlet_stock_take(uuid, jsonb, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_outlet_sale_batches(uuid) TO authenticated, service_role;

-- RLS: hide quantities of an outlet under blind count from non-admins (RESTRICTIVE = AND-ed with
-- the existing permissive SELECT policies, which stay unchanged).
DROP POLICY IF EXISTS "Blind count hides outlet stock" ON public.outlet_inventory;
CREATE POLICY "Blind count hides outlet stock" ON public.outlet_inventory
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.stock_qty_hidden_for_outlet(outlet_id));

DROP POLICY IF EXISTS "Blind count hides outlet movements" ON public.outlet_stock_movements;
CREATE POLICY "Blind count hides outlet movements" ON public.outlet_stock_movements
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.stock_qty_hidden_for_outlet(outlet_id));

DROP POLICY IF EXISTS "Blind count hides outlet snapshots" ON public.outlet_inventory_snapshots;
CREATE POLICY "Blind count hides outlet snapshots" ON public.outlet_inventory_snapshots
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.stock_qty_hidden_for_outlet(outlet_id));

-- Stock take lines carry system_qoh_before / variance: admins only.
DROP POLICY IF EXISTS "Non supervisor view outlet stock take lines" ON public.outlet_stock_take_lines;
DROP POLICY IF EXISTS "Supervisor view stock take lines via session outlet" ON public.outlet_stock_take_lines;
DROP POLICY IF EXISTS "Admins view outlet stock take lines" ON public.outlet_stock_take_lines;
CREATE POLICY "Admins view outlet stock take lines" ON public.outlet_stock_take_lines
  FOR SELECT TO authenticated
  USING (public.can_view_stock_take_variance());

DROP POLICY IF EXISTS "Admins view stock take open balances" ON public.outlet_stock_take_open_balances;
CREATE POLICY "Admins view stock take open balances" ON public.outlet_stock_take_open_balances
  FOR SELECT TO authenticated
  USING (public.can_view_stock_take_variance());

-- Balance / reconcile RPCs (SECURITY DEFINER, bypass RLS): refuse while the outlet is under a blind
-- count, unless admin. Guarded text patch right after their single auth check.
DO $patch$
DECLARE
  v_sig text;
  v_def text;
  v_needle constant text := E'RETURN jsonb_build_object(''success'', false, ''error'', ''not_authenticated'');\n  END IF;';
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.reconcile_outlet_stock(uuid, date, date, boolean)',
    'public.reconcile_outlet_stock_by_sku(uuid, date, date, boolean)',
    'public.get_outlet_balance_as_of(uuid, date, boolean)'
  ]
  LOOP
    v_def := pg_get_functiondef(to_regprocedure(v_sig));
    CONTINUE WHEN position('stock_qty_hidden_for_outlet' IN v_def) > 0;
    EXECUTE replace(v_def, v_needle, v_needle || E'\n  IF public.stock_qty_hidden_for_outlet(p_outlet_id) THEN\n    RETURN jsonb_build_object(''success'', false, ''error'', ''stock_take_in_progress'');\n  END IF;');
  END LOOP;
END
$patch$;
