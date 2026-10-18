/*
  # admin_delete_supply_order: fail closed on received reversal imbalance

  Deleting a received supply order reverses outlet stock back into hub stock.
  If outlet stock was already consumed or reserved, clamping outlet quantity to
  zero while crediting the hub line quantity silently creates phantom stock.
*/

CREATE OR REPLACE FUNCTION public.admin_delete_supply_order(p_supply_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  st text;
  v_outlet_id uuid;
  rec RECORD;
  v_rc int;
  v_oi_id uuid;
  v_oi_qoh numeric;
  v_oi_res numeric;
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
        sol.product_batch,
        hi.raw_material_id AS hub_raw_material_id
      FROM public.supply_order_lines sol
      INNER JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
      WHERE sol.supply_order_id = p_supply_order_id
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
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for raw material % (outlet %)', rec.hub_raw_material_id, v_outlet_id;
        END IF;
      ELSE
        SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
        INTO v_oi_id, v_oi_qoh, v_oi_res
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id IS NULL
          AND oi.product_batch IS NOT DISTINCT FROM rec.product_batch
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for batch % (outlet %)', rec.product_batch, v_outlet_id;
        END IF;
      END IF;

      IF v_oi_qoh < rec.quantity THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION
            'Cannot reverse received supply order: outlet raw material % has %, need %',
            rec.hub_raw_material_id,
            v_oi_qoh,
            rec.quantity;
        ELSE
          RAISE EXCEPTION
            'Cannot reverse received supply order: outlet batch % has %, need %',
            rec.product_batch,
            v_oi_qoh,
            rec.quantity;
        END IF;
      END IF;

      IF (v_oi_qoh - rec.quantity) < v_oi_res THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION
            'Cannot reverse received supply order: outlet raw material % would fall below reserved quantity %',
            rec.hub_raw_material_id,
            v_oi_res;
        ELSE
          RAISE EXCEPTION
            'Cannot reverse received supply order: outlet batch % would fall below reserved quantity %',
            rec.product_batch,
            v_oi_res;
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
          RAISE EXCEPTION 'Outlet inventory update failed for batch %', rec.product_batch;
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
$$;
