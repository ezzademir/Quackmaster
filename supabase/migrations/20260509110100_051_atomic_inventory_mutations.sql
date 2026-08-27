/*
  # Atomic inventory mutations

  - Dispatch supply orders in a single row-locked RPC so multi-line orders cannot
    partially ship while remaining pending.
  - Cancel pending supply orders in a single row-locked RPC so reservations and
    status cannot diverge from concurrent dispatch/cancel attempts.
  - Validate and deduct production materials before inserting finished goods.
*/

-- ---------------------------------------------------------------------------
-- dispatch_supply_order — atomically fulfill hub reservations and mark shipped
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_supply_order(p_supply_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_so RECORD;
  line RECORD;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_res numeric;
  v_iso timestamptz := now();
  v_line_count integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT *
  INTO v_so
  FROM public.supply_orders so
  WHERE so.id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'supply_order_not_found');
  END IF;

  IF v_so.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status_for_dispatch', 'status', v_so.status);
  END IF;

  SELECT count(*) INTO v_line_count
  FROM public.supply_order_lines sol
  WHERE sol.supply_order_id = p_supply_order_id;

  IF v_line_count < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'supply_order_has_no_lines');
  END IF;

  -- Validate and lock each hub row before mutating any inventory.
  FOR line IN
    SELECT sol.hub_inventory_id, SUM(sol.quantity)::numeric AS quantity
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    GROUP BY sol.hub_inventory_id
    ORDER BY sol.hub_inventory_id
  LOOP
    IF line.quantity IS NULL OR line.quantity <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_supply_order_line');
    END IF;

    SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_missing', 'hub_inventory_id', line.hub_inventory_id);
    END IF;

    IF v_res < line.quantity THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_reserved_quantity',
        'hub_inventory_id', line.hub_inventory_id,
        'reserved', v_res,
        'required', line.quantity
      );
    END IF;

    IF v_qoh < line.quantity THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_on_hand_quantity',
        'hub_inventory_id', line.hub_inventory_id,
        'on_hand', v_qoh,
        'required', line.quantity
      );
    END IF;
  END LOOP;

  FOR line IN
    SELECT sol.hub_inventory_id, SUM(sol.quantity)::numeric AS quantity
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    GROUP BY sol.hub_inventory_id
    ORDER BY sol.hub_inventory_id
  LOOP
    SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id
    FOR UPDATE;

    v_new_qoh := v_qoh - line.quantity;
    v_new_res := v_res - line.quantity;

    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = v_new_qoh,
      reserved_quantity = v_new_res,
      available_quantity = v_new_qoh - v_new_res,
      last_updated = v_iso,
      updated_at = v_iso
    WHERE hi.id = line.hub_inventory_id;
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'dispatched',
    dispatch_date = CURRENT_DATE,
    updated_at = v_iso
  WHERE id = p_supply_order_id;

  PERFORM public._append_data_ledger(
    'dispatched',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'event',
    NULL,
    jsonb_build_object('status', 'dispatched', 'dispatch_date', CURRENT_DATE),
    NULL,
    NULL
  );

  RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id);
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_supply_order(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- cancel_supply_order — atomically release pending hub reservations
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_supply_order(
  p_supply_order_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_so RECORD;
  line RECORD;
  v_qoh numeric;
  v_res numeric;
  v_new_res numeric;
  v_iso timestamptz := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT *
  INTO v_so
  FROM public.supply_orders so
  WHERE so.id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'supply_order_not_found');
  END IF;

  IF v_so.status IS DISTINCT FROM 'pending' THEN
    IF v_so.status IS NOT DISTINCT FROM 'cancelled' THEN
      RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id, 'idempotent_replay', true);
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'invalid_status_for_cancel', 'status', v_so.status);
  END IF;

  -- Validate and lock each hub row before mutating any reservation.
  FOR line IN
    SELECT sol.hub_inventory_id, SUM(sol.quantity)::numeric AS quantity
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    GROUP BY sol.hub_inventory_id
    ORDER BY sol.hub_inventory_id
  LOOP
    IF line.quantity IS NULL OR line.quantity <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_supply_order_line');
    END IF;

    SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_missing', 'hub_inventory_id', line.hub_inventory_id);
    END IF;

    IF v_res < line.quantity THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_reserved_quantity',
        'hub_inventory_id', line.hub_inventory_id,
        'reserved', v_res,
        'required', line.quantity
      );
    END IF;
  END LOOP;

  FOR line IN
    SELECT sol.hub_inventory_id, SUM(sol.quantity)::numeric AS quantity
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    GROUP BY sol.hub_inventory_id
    ORDER BY sol.hub_inventory_id
  LOOP
    SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id
    FOR UPDATE;

    v_new_res := v_res - line.quantity;

    UPDATE public.hub_inventory hi
    SET
      reserved_quantity = v_new_res,
      available_quantity = v_qoh - v_new_res,
      last_updated = v_iso,
      updated_at = v_iso
    WHERE hi.id = line.hub_inventory_id;
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'cancelled',
    updated_at = v_iso
  WHERE id = p_supply_order_id;

  PERFORM public._append_data_ledger(
    'cancelled',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'event',
    NULL,
    jsonb_build_object('status', 'cancelled'),
    NULL,
    jsonb_build_object('cancellation_reason', NULLIF(trim(both from COALESCE(p_reason, '')), ''))
  );

  RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_supply_order(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_supply_order(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- post_production_completion_inventory — validate before finished-goods insert
-- ---------------------------------------------------------------------------
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
  mat RECORD;
  v_hub_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_avail numeric;
  v_batch text := trim(both from p_product_batch);
  v_out_id uuid;
  v_iso timestamptz := now();
  v_expected_materials integer;
  v_actual_materials integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF v_batch IS NULL OR v_batch = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'product_batch_required');
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

  SELECT count(*) INTO v_expected_materials
  FROM public.recipe_ingredients ri
  WHERE ri.recipe_id = pr.recipe_id;

  SELECT count(*) INTO v_actual_materials
  FROM public.production_run_materials prm
  WHERE prm.production_run_id = p_production_run_id;

  IF v_expected_materials > 0 AND v_actual_materials < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'production_materials_required');
  END IF;

  -- Validate and lock raw-material hub rows before any inventory mutation.
  FOR mat IN
    SELECT prm.raw_material_id, SUM(prm.quantity_consumed)::numeric AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
    ORDER BY prm.raw_material_id
  LOOP
    IF mat.quantity_consumed IS NULL OR mat.quantity_consumed < 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'invalid_material_quantity',
        'raw_material_id', mat.raw_material_id
      );
    END IF;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
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

  FOR mat IN
    SELECT prm.raw_material_id, SUM(prm.quantity_consumed)::numeric AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
    ORDER BY prm.raw_material_id
  LOOP
    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

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

  IF p_finished_quantity > 0 THEN
    INSERT INTO public.hub_inventory (
      product_batch,
      quantity_on_hand,
      reserved_quantity,
      available_quantity,
      last_updated,
      updated_at
    )
    VALUES (
      v_batch,
      p_finished_quantity,
      0,
      p_finished_quantity,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_out_id;
  END IF;

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
      'product_batch', v_batch,
      'finished_quantity', p_finished_quantity
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'success', true,
    'production_run_id', p_production_run_id,
    'hub_inventory_id', v_out_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) TO authenticated;
