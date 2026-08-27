/*
  post_production_completion_inventory inserted the FG lot + hub row, then
  RETURN jsonb success:false on missing/short raw materials.

  PostgREST commits a successful RPC response, so that left phantom finished
  goods while the run stayed in_progress (UI then cancels it). Retry hits the
  unique lot-per-run index; draft delete did not remove the hub row.

  Validate and lock RM first. After any inventory write, RAISE so the
  transaction rolls back. Draft delete / retry scrubs unposted FG for this run.
*/

CREATE OR REPLACE FUNCTION public._remove_unposted_production_fg(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_outlet numeric;
  v_reserved numeric;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM public.hub_inventory hi
  JOIN public.inventory_lots il ON il.id = hi.lot_id
  WHERE il.production_run_id = p_run_id
    AND hi.raw_material_id IS NULL
  FOR UPDATE OF hi;

  SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
  INTO v_outlet
  FROM public.outlet_inventory oi
  JOIN public.inventory_lots il ON il.id = oi.lot_id
  WHERE il.production_run_id = p_run_id;

  IF v_outlet > 0 THEN
    RAISE EXCEPTION 'Cannot remove draft finished goods: this lot already has stock at an outlet';
  END IF;

  SELECT COALESCE(SUM(COALESCE(hi.reserved_quantity, 0)), 0)
  INTO v_reserved
  FROM public.hub_inventory hi
  JOIN public.inventory_lots il ON il.id = hi.lot_id
  WHERE il.production_run_id = p_run_id
    AND hi.raw_material_id IS NULL;

  IF v_reserved > 0 THEN
    RAISE EXCEPTION 'Cannot remove draft finished goods: finished goods have reserved quantity';
  END IF;

  DELETE FROM public.hub_inventory hi
  WHERE hi.raw_material_id IS NULL
    AND hi.lot_id IN (
      SELECT il.id FROM public.inventory_lots il WHERE il.production_run_id = p_run_id
    );

  DELETE FROM public.inventory_lots il WHERE il.production_run_id = p_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public._remove_unposted_production_fg(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.post_production_completion_inventory(
  p_production_run_id uuid,
  p_product_batch text,
  p_finished_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  pr RECORD;
  rec RECORD;
  mat RECORD;
  v_hub_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_avail numeric;
  v_sku text;
  v_lot_label text;
  v_lot_id uuid;
  v_parent_lot uuid;
  v_mfg date;
  v_expiry date;
  v_out_id uuid;
  v_iso timestamptz := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_finished_quantity IS NULL OR p_finished_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_finished_quantity');
  END IF;

  SELECT *
  INTO pr
  FROM public.production_runs
  WHERE id = p_production_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'production_run_not_found');
  END IF;

  IF pr.status IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_run_status', 'status', pr.status);
  END IF;

  -- Drop FG left by a prior non-atomic attempt on this still-open run.
  PERFORM public._remove_unposted_production_fg(p_production_run_id);

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

  SELECT hi.lot_id
  INTO v_parent_lot
  FROM public.production_run_materials prm
  JOIN public.hub_inventory hi
    ON hi.raw_material_id = prm.raw_material_id
   AND hi.lot_id IS NOT NULL
  WHERE prm.production_run_id = p_production_run_id
  ORDER BY prm.created_at ASC NULLS LAST
  LIMIT 1;

  -- Lock and validate every RM line before inserting finished goods.
  FOR mat IN
    SELECT
      prm.raw_material_id,
      SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF v_hub_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'raw_material_hub_row_missing',
        'raw_material_id', mat.raw_material_id
      );
    END IF;

    IF v_qoh < mat.quantity_consumed THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_raw_material',
        'raw_material_id', mat.raw_material_id,
        'on_hand', v_qoh,
        'required', mat.quantity_consumed
      );
    END IF;
  END LOOP;

  IF rec.default_product_batch IS NULL OR trim(both from rec.default_product_batch) = '' THEN
    UPDATE public.recipes
    SET default_product_batch = v_sku, updated_at = v_iso
    WHERE id = pr.recipe_id;
  END IF;

  IF p_finished_quantity > 0 THEN
    INSERT INTO public.inventory_lots (
      product_batch_label,
      expiry_date,
      manufactured_at,
      parent_lot_id,
      production_run_id,
      created_at,
      updated_at
    )
    VALUES (
      v_lot_label,
      v_expiry,
      v_mfg::timestamptz,
      v_parent_lot,
      p_production_run_id,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_lot_id;

    INSERT INTO public.hub_inventory (
      product_batch,
      lot_id,
      quantity_on_hand,
      reserved_quantity,
      available_quantity,
      last_updated,
      updated_at
    )
    VALUES (
      v_sku,
      v_lot_id,
      p_finished_quantity,
      0,
      p_finished_quantity,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_out_id;
  END IF;

  FOR mat IN
    SELECT
      prm.raw_material_id,
      SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF v_hub_id IS NULL THEN
      RAISE EXCEPTION 'raw_material_hub_row_missing after validation (raw_material_id %)', mat.raw_material_id;
    END IF;

    IF v_qoh < mat.quantity_consumed THEN
      RAISE EXCEPTION 'insufficient_raw_material after validation (have %, need %)', v_qoh, mat.quantity_consumed;
    END IF;

    v_new_qoh := v_qoh - mat.quantity_consumed;
    v_new_avail := v_new_qoh - v_res;

    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = v_new_qoh,
      available_quantity = v_new_avail,
      last_updated = v_iso,
      updated_at = v_iso
    WHERE hi.id = v_hub_id;
  END LOOP;

  UPDATE public.production_runs
  SET
    status = 'completed',
    updated_at = v_iso
  WHERE id = p_production_run_id;

  PERFORM public._append_data_ledger(
    'inventory_posted',
    'production_run',
    p_production_run_id::text,
    'production',
    'event',
    NULL,
    jsonb_build_object(
      'hub_inventory_id', v_out_id,
      'product_batch', v_sku,
      'lot_id', v_lot_id,
      'lot_label', v_lot_label,
      'finished_quantity', p_finished_quantity
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

REVOKE ALL ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_production_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run_status text;
  v_run_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT pr.status, pr.run_number
  INTO run_status, v_run_number
  FROM public.production_runs pr
  WHERE pr.id = p_run_id
  FOR UPDATE;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'Production run not found';
  END IF;

  IF run_status NOT IN ('in_progress', 'cancelled') THEN
    RAISE EXCEPTION 'Completed runs must be voided, not deleted. Voided runs can be restored.';
  END IF;

  PERFORM public._remove_unposted_production_fg(p_run_id);

  DELETE FROM public.production_runs WHERE id = p_run_id;

  PERFORM public._append_data_ledger(
    'deleted',
    'production_run',
    p_run_id::text,
    'production',
    'delete',
    v_run_number,
    jsonb_build_object('status', run_status, 'run_number', v_run_number),
    NULL,
    NULL,
    jsonb_build_object('entity_label', v_run_number, 'prior_status', run_status)
  );

  RETURN jsonb_build_object('ok', true, 'run_number', v_run_number);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_production_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_production_run(uuid) TO authenticated;
