/*
  # admin_delete_supply_order: exact outlet reversal for received lines

  Received supply order deletion must reverse the same outlet inventory row that
  receive_supply_order credited. Finished goods are matched by trimmed batch and
  lot_id with the same oldest-row ordering; underflows fail instead of silently
  clamping outlet stock to zero.
*/

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
  v_rc int;
  v_oi_id uuid;
  v_oi_qoh numeric;
  v_oi_res numeric;
  v_batch text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT status, outlet_id INTO st, v_outlet_id
  FROM public.supply_orders
  WHERE id = p_supply_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supply order not found';
  END IF;

  IF st = 'pending' THEN
    FOR rec IN
      SELECT hub_inventory_id, quantity
      FROM public.supply_order_lines
      WHERE supply_order_id = p_supply_order_id
    LOOP
      PERFORM public.release_inventory_reservation(rec.hub_inventory_id, rec.quantity, p_supply_order_id);
    END LOOP;

  ELSIF st = 'dispatched' THEN
    FOR rec IN
      SELECT hub_inventory_id, quantity
      FROM public.supply_order_lines
      WHERE supply_order_id = p_supply_order_id
    LOOP
      UPDATE public.hub_inventory hi
      SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        RAISE EXCEPTION 'Hub inventory row missing for reversal (hub_inventory_id=%)', rec.hub_inventory_id;
      END IF;
    END LOOP;

  ELSIF st = 'received' THEN
    FOR rec IN
      SELECT
        sol.hub_inventory_id,
        sol.quantity,
        sol.product_batch AS line_product_batch,
        hi.raw_material_id AS hub_raw_material_id,
        hi.product_batch AS hub_product_batch,
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
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id = rec.hub_raw_material_id
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for raw material % (outlet %)', rec.hub_raw_material_id, v_outlet_id;
        END IF;
      ELSE
        v_batch := NULLIF(trim(both from COALESCE(rec.line_product_batch, rec.hub_product_batch)), '');

        IF v_batch IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory batch missing for hub row % (outlet %)', rec.hub_inventory_id, v_outlet_id;
        END IF;

        SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_oi_id, v_oi_qoh, v_oi_res
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id IS NULL
          AND trim(both from oi.product_batch) = v_batch
          AND (oi.lot_id IS NOT DISTINCT FROM rec.hub_lot_id)
        ORDER BY oi.created_at ASC NULLS LAST, oi.id ASC
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for batch % lot % (outlet %)',
            v_batch,
            rec.hub_lot_id,
            v_outlet_id;
        END IF;
      END IF;

      IF v_oi_qoh < rec.quantity OR (v_oi_qoh - rec.quantity) < v_oi_res THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION 'Outlet inventory underflow for raw material % (outlet %, on hand %, reserved %, reversal %)',
            rec.hub_raw_material_id,
            v_outlet_id,
            v_oi_qoh,
            v_oi_res,
            rec.quantity;
        ELSE
          RAISE EXCEPTION 'Outlet inventory underflow for batch % lot % (outlet %, on hand %, reserved %, reversal %)',
            v_batch,
            rec.hub_lot_id,
            v_outlet_id,
            v_oi_qoh,
            v_oi_res,
            rec.quantity;
        END IF;
      END IF;

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = v_oi_qoh - rec.quantity,
        available_quantity = (v_oi_qoh - rec.quantity) - v_oi_res,
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_oi_id;
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION 'Outlet inventory update failed for raw material %', rec.hub_raw_material_id;
        ELSE
          RAISE EXCEPTION 'Outlet inventory update failed for batch % lot %',
            v_batch,
            rec.hub_lot_id;
        END IF;
      END IF;

      UPDATE public.hub_inventory hi
      SET
        quantity_on_hand = hi.quantity_on_hand + rec.quantity,
        available_quantity = hi.quantity_on_hand + rec.quantity - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE hi.id = rec.hub_inventory_id;
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        RAISE EXCEPTION 'Hub inventory row missing for reversal (hub_inventory_id=%)', rec.hub_inventory_id;
      END IF;
    END LOOP;

  ELSIF st = 'cancelled' THEN
    NULL;

  ELSE
    RAISE EXCEPTION 'Unsupported supply order status for delete: %', st;
  END IF;

  DELETE FROM public.supply_orders WHERE id = p_supply_order_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_delete_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_supply_order(uuid) TO authenticated;
