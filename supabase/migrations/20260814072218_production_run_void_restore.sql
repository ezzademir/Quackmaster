/*
  Completed production runs are voided, not hard-deleted.
  Void keeps the run + lot for audit, reverses hub FG (only if still at hub),
  and restores consumed raw materials. Restore puts the hub lot back.

  Hard delete remains for never-posted drafts (in_progress / cancelled).
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

-- ---------------------------------------------------------------------------
-- Void a completed run (reversible)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_void_production_run(p_run_id uuid, p_confirm_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pr RECORD;
  lot_rec RECORD;
  hub_rec RECORD;
  mat RECORD;
  v_confirm text;
  v_legacy_batch text;
  v_outlet_qty numeric := 0;
  v_supply_n integer := 0;
  v_sales_n integer := 0;
  v_waste_n integer := 0;
  v_materials jsonb := '[]'::jsonb;
  v_snapshot jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT *
  INTO pr
  FROM public.production_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production run not found';
  END IF;

  IF pr.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'Only completed runs can be voided (status is %)', pr.status;
  END IF;

  v_legacy_batch := 'BATCH-' || split_part(pr.id::text, '-', 1);

  SELECT il.*
  INTO lot_rec
  FROM public.inventory_lots il
  WHERE il.production_run_id = pr.id
  LIMIT 1;

  v_confirm := upper(trim(both from coalesce(p_confirm_text, '')));
  IF v_confirm = ''
     OR (
       v_confirm IS DISTINCT FROM upper(pr.run_number)
       AND (lot_rec.id IS NULL OR v_confirm IS DISTINCT FROM upper(lot_rec.product_batch_label))
     ) THEN
    RAISE EXCEPTION 'Type the run number% to confirm',
      CASE WHEN lot_rec.id IS NOT NULL THEN ' or lot code' ELSE '' END;
  END IF;

  SELECT hi.*
  INTO hub_rec
  FROM public.hub_inventory hi
  WHERE (lot_rec.id IS NOT NULL AND hi.lot_id = lot_rec.id)
     OR hi.product_batch = v_legacy_batch
  ORDER BY CASE WHEN lot_rec.id IS NOT NULL AND hi.lot_id = lot_rec.id THEN 0 ELSE 1 END
  LIMIT 1
  FOR UPDATE;

  IF hub_rec.id IS NOT NULL AND COALESCE(hub_rec.reserved_quantity, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot void: finished goods have reserved quantity (resolve distribution orders first)';
  END IF;

  IF lot_rec.id IS NOT NULL THEN
    SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
    INTO v_outlet_qty
    FROM public.outlet_inventory oi
    WHERE oi.lot_id = lot_rec.id;
  END IF;

  IF COALESCE(v_outlet_qty, 0) <= 0 THEN
    SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
    INTO v_outlet_qty
    FROM public.outlet_inventory oi
    WHERE oi.product_batch = v_legacy_batch
       OR (hub_rec.product_batch IS NOT NULL AND oi.product_batch = hub_rec.product_batch AND hub_rec.product_batch LIKE 'BATCH-%');
  END IF;

  IF COALESCE(v_outlet_qty, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot void: this lot already has stock at an outlet';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_supply_n
  FROM public.supply_order_lines sol
  WHERE (hub_rec.id IS NOT NULL AND sol.hub_inventory_id = hub_rec.id)
     OR sol.product_batch = v_legacy_batch
     OR (lot_rec.product_batch_label IS NOT NULL AND sol.product_batch = lot_rec.product_batch_label);

  IF COALESCE(v_supply_n, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot void: this lot was already used on a supply order';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_sales_n
  FROM public.sales_journal_lines sjl
  WHERE (lot_rec.id IS NOT NULL AND sjl.lot_id = lot_rec.id)
     OR sjl.product_batch = v_legacy_batch
     OR (lot_rec.product_batch_label IS NOT NULL AND sjl.product_batch = lot_rec.product_batch_label);

  IF COALESCE(v_sales_n, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot void: this lot already has sales recorded';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_waste_n
  FROM public.waste_lines wl
  WHERE (hub_rec.id IS NOT NULL AND wl.hub_inventory_id = hub_rec.id)
     OR wl.product_batch = v_legacy_batch
     OR (lot_rec.product_batch_label IS NOT NULL AND wl.product_batch = lot_rec.product_batch_label);

  IF COALESCE(v_waste_n, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot void: this lot already has waste recorded';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'raw_material_id', prm.raw_material_id,
    'quantity_consumed', prm.quantity_consumed
  )), '[]'::jsonb)
  INTO v_materials
  FROM public.production_run_materials prm
  WHERE prm.production_run_id = pr.id;

  v_snapshot := jsonb_build_object(
    'run', to_jsonb(pr),
    'materials', v_materials,
    'lot', CASE WHEN lot_rec.id IS NULL THEN NULL ELSE to_jsonb(lot_rec) END,
    'hub', CASE WHEN hub_rec.id IS NULL THEN NULL ELSE to_jsonb(hub_rec) END
  );

  IF hub_rec.id IS NOT NULL THEN
    DELETE FROM public.hub_inventory WHERE id = hub_rec.id;
  END IF;

  FOR mat IN
    SELECT prm.raw_material_id, prm.quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = pr.id
  LOOP
    PERFORM public._hub_adjust_raw_material(mat.raw_material_id, COALESCE(mat.quantity_consumed, 0));
  END LOOP;

  UPDATE public.production_runs
  SET status = 'voided', updated_at = now()
  WHERE id = pr.id;

  PERFORM public._append_data_ledger(
    'voided',
    'production_run',
    pr.id::text,
    'production',
    'update',
    pr.run_number,
    v_snapshot,
    jsonb_build_object('status', 'voided'),
    NULL,
    jsonb_build_object(
      'entity_label', pr.run_number,
      'prior_status', pr.status,
      'lot_label', lot_rec.product_batch_label
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', pr.id,
    'run_number', pr.run_number,
    'status', 'voided',
    'hub_removed', hub_rec.id IS NOT NULL,
    'hub_quantity_removed', COALESCE(hub_rec.quantity_on_hand, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_void_production_run(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_void_production_run(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Restore a voided run (put hub FG back, re-consume RM)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_restore_voided_production_run(p_run_id uuid, p_confirm_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pr RECORD;
  lot_rec RECORD;
  mat RECORD;
  v_confirm text;
  v_snapshot jsonb;
  v_hub jsonb;
  v_qty numeric;
  v_batch text;
  v_hub_id uuid;
  v_lot_id uuid;
  v_new_hub uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT *
  INTO pr
  FROM public.production_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production run not found';
  END IF;

  IF pr.status IS DISTINCT FROM 'voided' THEN
    RAISE EXCEPTION 'Only voided runs can be restored (status is %)', pr.status;
  END IF;

  SELECT il.*
  INTO lot_rec
  FROM public.inventory_lots il
  WHERE il.production_run_id = pr.id
  LIMIT 1;

  v_confirm := upper(trim(both from coalesce(p_confirm_text, '')));
  IF v_confirm = ''
     OR (
       v_confirm IS DISTINCT FROM upper(pr.run_number)
       AND (lot_rec.id IS NULL OR v_confirm IS DISTINCT FROM upper(lot_rec.product_batch_label))
     ) THEN
    RAISE EXCEPTION 'Type the run number% to confirm',
      CASE WHEN lot_rec.id IS NOT NULL THEN ' or lot code' ELSE '' END;
  END IF;

  SELECT dl.before_data
  INTO v_snapshot
  FROM public.data_ledger dl
  WHERE dl.entity_type = 'production_run'
    AND dl.entity_id = pr.id::text
    AND dl.action = 'voided'
  ORDER BY dl.created_at DESC
  LIMIT 1;

  v_hub := v_snapshot -> 'hub';
  v_lot_id := COALESCE(lot_rec.id, NULLIF(v_hub ->> 'lot_id', '')::uuid);
  v_qty := COALESCE(NULLIF(v_hub ->> 'quantity_on_hand', '')::numeric, pr.actual_output);
  v_batch := COALESCE(
    NULLIF(v_hub ->> 'product_batch', ''),
    'BATCH-' || split_part(pr.id::text, '-', 1)
  );
  v_hub_id := NULLIF(v_hub ->> 'id', '')::uuid;

  IF COALESCE(v_qty, 0) < 0 THEN
    RAISE EXCEPTION 'Invalid snapshot quantity';
  END IF;

  FOR mat IN
    SELECT prm.raw_material_id, prm.quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = pr.id
  LOOP
    PERFORM public._hub_adjust_raw_material(mat.raw_material_id, -COALESCE(mat.quantity_consumed, 0));
  END LOOP;

  IF v_qty > 0 THEN
    IF v_hub_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hub_inventory WHERE id = v_hub_id) THEN
      INSERT INTO public.hub_inventory (
        id,
        product_batch,
        lot_id,
        quantity_on_hand,
        reserved_quantity,
        available_quantity,
        last_updated,
        updated_at
      )
      VALUES (
        v_hub_id,
        v_batch,
        v_lot_id,
        v_qty,
        0,
        v_qty,
        now(),
        now()
      )
      RETURNING id INTO v_new_hub;
    ELSE
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
        v_batch,
        v_lot_id,
        v_qty,
        0,
        v_qty,
        now(),
        now()
      )
      RETURNING id INTO v_new_hub;
    END IF;
  END IF;

  UPDATE public.production_runs
  SET status = 'completed', updated_at = now()
  WHERE id = pr.id;

  PERFORM public._append_data_ledger(
    'restored',
    'production_run',
    pr.id::text,
    'production',
    'update',
    pr.run_number,
    jsonb_build_object('status', 'voided'),
    jsonb_build_object(
      'status', 'completed',
      'hub_inventory_id', v_new_hub,
      'product_batch', v_batch,
      'lot_id', v_lot_id,
      'quantity', v_qty
    ),
    NULL,
    jsonb_build_object(
      'entity_label', pr.run_number,
      'lot_label', lot_rec.product_batch_label
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', pr.id,
    'run_number', pr.run_number,
    'status', 'completed',
    'hub_inventory_id', v_new_hub,
    'product_batch', v_batch,
    'lot_id', v_lot_id,
    'quantity', v_qty
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_restore_voided_production_run(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_restore_voided_production_run(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Hard delete: drafts only (never posted to inventory)
-- ---------------------------------------------------------------------------
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
