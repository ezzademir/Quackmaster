/*
  post_production_completion_inventory deducted raw materials using quantity_on_hand
  only. A pending RM supply order reserves hub stock; completing a run with
  on-hand >= consumed but available < consumed stole the reservation and left
  available_quantity negative. Dispatch of the supply order then fails.

  Compare against available (on-hand minus reserved). RAISE after the FG insert
  so PostgREST cannot commit a shortfall as a successful jsonb RPC.
*/

CREATE OR REPLACE FUNCTION public._hub_adjust_raw_material(p_raw_material_id uuid, p_delta numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  hm_id uuid;
  hm_qoh numeric;
  hm_res numeric;
  new_qoh numeric;
BEGIN
  IF p_raw_material_id IS NULL OR COALESCE(p_delta, 0) = 0 THEN
    RETURN;
  END IF;

  SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
  INTO hm_id, hm_qoh, hm_res
  FROM public.hub_inventory hi
  WHERE hi.raw_material_id = p_raw_material_id
  ORDER BY hi.created_at ASC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF hm_id IS NULL THEN
    RAISE EXCEPTION 'Raw material hub row missing';
  END IF;

  new_qoh := COALESCE(hm_qoh, 0) + p_delta;
  IF new_qoh < 0 THEN
    RAISE EXCEPTION 'Insufficient raw material on hand (have %, need %)',
      COALESCE(hm_qoh, 0),
      abs(p_delta);
  END IF;

  IF new_qoh < hm_res THEN
    RAISE EXCEPTION 'Insufficient raw material available (have %, reserved %, need %)',
      COALESCE(hm_qoh, 0),
      hm_res,
      abs(p_delta);
  END IF;

  UPDATE public.hub_inventory
  SET
    quantity_on_hand = new_qoh,
    available_quantity = new_qoh - hm_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = hm_id;
END;
$$;

REVOKE ALL ON FUNCTION public._hub_adjust_raw_material(uuid, numeric) FROM PUBLIC;

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
  v_avail numeric;
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

  -- Lock and reject reserved overdraw before inserting finished goods.
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

    v_avail := v_qoh - v_res;
    IF v_avail < mat.quantity_consumed THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_raw_material_available',
        'raw_material_id', mat.raw_material_id,
        'on_hand', v_qoh,
        'reserved', v_res,
        'available', v_avail,
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

    v_avail := v_qoh - v_res;
    IF v_avail < mat.quantity_consumed THEN
      RAISE EXCEPTION 'insufficient_raw_material_available after validation (available %, need %)',
        v_avail, mat.quantity_consumed;
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
