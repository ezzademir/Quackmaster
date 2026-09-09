/*
  Pack 3 — void/delete integrity (audit P0)

  PP-04 / PP-05 (admin_void_production_run):
    Refuse void when hub FG is missing or remaining hub qoh ≠ production_runs.actual_output.
    Do not restore full RM against a partial/missing FG lot (no free materials).

  P0-3 (admin_delete_supply_order, received):
    Reverse outlet↔hub symmetrically: refuse when outlet cannot absorb the full debit;
    remove GREATEST(0, …) floor that under-debits outlet while fully restoring hub.
    Match FG outlet rows by (outlet, product_batch, lot_id) like receive_supply_order.
*/

-- ---------------------------------------------------------------------------
-- admin_void_production_run — refuse unsafe void (PP-04 / PP-05)
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
  v_original_fg numeric;
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

  -- PP-05: missing hub FG must not restore RM
  IF hub_rec.id IS NULL THEN
    RAISE EXCEPTION 'Cannot void: finished goods hub row missing (refuse unsafe void)';
  END IF;

  -- PP-04: only void when hub FG is still the full original finished quantity
  v_original_fg := COALESCE(pr.actual_output, 0);
  IF COALESCE(hub_rec.quantity_on_hand, 0) IS DISTINCT FROM v_original_fg THEN
    RAISE EXCEPTION
      'Cannot void: hub finished goods remaining (%) does not match original output (%); refuse unsafe void',
      COALESCE(hub_rec.quantity_on_hand, 0),
      v_original_fg;
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
    'hub', to_jsonb(hub_rec)
  );

  DELETE FROM public.hub_inventory WHERE id = hub_rec.id;

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
    'hub_removed', true,
    'hub_quantity_removed', COALESCE(hub_rec.quantity_on_hand, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_void_production_run(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_void_production_run(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- admin_delete_supply_order — symmetric received reverse (P0-3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_supply_order(p_supply_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  st text;
  v_outlet_id uuid;
  rec RECORD;
  v_oi_id uuid;
  v_oi_qoh numeric;
  v_oi_res numeric;
  v_batch text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_profiles_admin() THEN RAISE EXCEPTION 'Admin privileges required'; END IF;

  SELECT status, outlet_id INTO st, v_outlet_id
  FROM public.supply_orders
  WHERE id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Supply order not found'; END IF;

  IF st = 'pending' THEN
    FOR rec IN SELECT hub_inventory_id, quantity FROM public.supply_order_lines WHERE supply_order_id = p_supply_order_id LOOP
      PERFORM public.release_inventory_reservation(rec.hub_inventory_id, rec.quantity, p_supply_order_id);
    END LOOP;
  ELSIF st = 'dispatched' THEN
    FOR rec IN SELECT hub_inventory_id, quantity FROM public.supply_order_lines WHERE supply_order_id = p_supply_order_id LOOP
      UPDATE public.hub_inventory hi SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
    END LOOP;
  ELSIF st = 'received' THEN
    FOR rec IN
      SELECT sol.hub_inventory_id, sol.quantity, sol.product_batch AS line_product_batch,
             hi.raw_material_id AS hub_raw_material_id, hi.product_batch AS hub_product_batch,
             hi.lot_id AS hub_lot_id
      FROM public.supply_order_lines sol
      INNER JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
      WHERE sol.supply_order_id = p_supply_order_id
      ORDER BY sol.id
    LOOP
      v_oi_id := NULL;
      v_oi_qoh := NULL;
      v_oi_res := NULL;

      IF rec.hub_raw_material_id IS NOT NULL THEN
        SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_oi_id, v_oi_qoh, v_oi_res
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id AND oi.raw_material_id = rec.hub_raw_material_id
        ORDER BY oi.updated_at DESC NULLS LAST
        LIMIT 1
        FOR UPDATE;
      ELSE
        v_batch := trim(both from COALESCE(rec.line_product_batch, rec.hub_product_batch, ''));
        IF v_batch = '' THEN
          RAISE EXCEPTION 'Outlet inventory missing for reversal (empty product_batch)';
        END IF;

        SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_oi_id, v_oi_qoh, v_oi_res
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id IS NULL
          AND trim(both from oi.product_batch) = v_batch
          AND (oi.lot_id IS NOT DISTINCT FROM rec.hub_lot_id)
        ORDER BY oi.created_at ASC NULLS LAST
        LIMIT 1
        FOR UPDATE;
      END IF;

      IF v_oi_id IS NULL THEN
        RAISE EXCEPTION 'Outlet inventory missing for reversal';
      END IF;

      -- Refuse asymmetric reverse: never restore more to hub than outlet can debit
      IF COALESCE(v_oi_qoh, 0) < rec.quantity THEN
        RAISE EXCEPTION
          'Cannot delete: outlet on-hand (%) is less than supply qty (%); refuse hub inflation',
          COALESCE(v_oi_qoh, 0),
          rec.quantity;
      END IF;

      IF (COALESCE(v_oi_qoh, 0) - COALESCE(v_oi_res, 0)) < rec.quantity THEN
        RAISE EXCEPTION
          'Cannot delete: outlet available (%) is less than supply qty (%); resolve reservations first',
          COALESCE(v_oi_qoh, 0) - COALESCE(v_oi_res, 0),
          rec.quantity;
      END IF;

      PERFORM public._set_outlet_movement_ctx(v_outlet_id, 'reversal', CURRENT_DATE, 'supply_order', p_supply_order_id);
      UPDATE public.outlet_inventory oi SET
        quantity_on_hand = oi.quantity_on_hand - rec.quantity,
        available_quantity = (oi.quantity_on_hand - rec.quantity) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE oi.id = v_oi_id;
      PERFORM public._clear_outlet_movement_ctx();

      UPDATE public.hub_inventory hi SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(), updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
    END LOOP;
  END IF;

  DELETE FROM public.supply_orders WHERE id = p_supply_order_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_delete_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_supply_order(uuid) TO authenticated;
