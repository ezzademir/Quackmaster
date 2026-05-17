/*
  # admin_delete_supply_order: preserve finished-goods lot identity

  Received supply orders are credited to outlet_inventory by hub product_batch
  and lot_id. Deleting a received order must reverse the same outlet lot, not
  merely the most recently updated row with the same product_batch.
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
    LOOP
      v_oi_id := NULL;

      IF rec.hub_raw_material_id IS NOT NULL THEN
        SELECT oi.id INTO v_oi_id
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id = rec.hub_raw_material_id
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for raw material % (outlet %)', rec.hub_raw_material_id, v_outlet_id;
        END IF;
      ELSE
        SELECT oi.id INTO v_oi_id
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id IS NULL
          AND oi.product_batch IS NOT DISTINCT FROM COALESCE(rec.line_product_batch, rec.hub_product_batch)
          AND oi.lot_id IS NOT DISTINCT FROM rec.hub_lot_id
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for batch % lot % (outlet %)',
            COALESCE(rec.line_product_batch, rec.hub_product_batch),
            rec.hub_lot_id,
            v_outlet_id;
        END IF;
      END IF;

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = GREATEST(0, oi.quantity_on_hand - rec.quantity),
        available_quantity = GREATEST(
          0,
          GREATEST(0, oi.quantity_on_hand - rec.quantity) - COALESCE(oi.reserved_quantity, 0)
        ),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_oi_id;
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION 'Outlet inventory update failed for raw material %', rec.hub_raw_material_id;
        ELSE
          RAISE EXCEPTION 'Outlet inventory update failed for batch % lot %',
            COALESCE(rec.line_product_batch, rec.hub_product_batch),
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
