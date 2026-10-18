/*
  # Fix supply-order receipt/delete inventory corruption

  - receive_supply_order now validates every line before mutating outlet stock,
    so a later invalid line cannot leave partial credits committed.
  - admin_delete_supply_order now locks the order, reverses the exact FG outlet
    row matched by receipt, and refuses to reverse received orders whose outlet
    stock has already been consumed or reserved.
*/

CREATE OR REPLACE FUNCTION public.receive_supply_order(
  p_supply_order_id uuid,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_so RECORD;
  line RECORD;
  v_hid uuid;
  v_rm uuid;
  v_pb text;
  v_hlot uuid;
  v_dest uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
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

  IF v_so.status IS DISTINCT FROM 'dispatched' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status_for_receive', 'status', v_so.status);
  END IF;

  FOR line IN
    SELECT sol.id, sol.hub_inventory_id
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    SELECT hi.id, hi.raw_material_id, hi.product_batch, hi.lot_id
    INTO v_hid, v_rm, v_pb, v_hlot
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id;

    IF v_hid IS NULL THEN
      RETURN jsonb_build_object(
        'success',
        false,
        'error',
        'hub_inventory_missing',
        'hub_inventory_id',
        line.hub_inventory_id
      );
    END IF;

    IF v_rm IS NULL AND trim(both from COALESCE(v_pb::text, '')) = '' THEN
      RETURN jsonb_build_object(
        'success',
        false,
        'error',
        'hub_inventory_invalid_fg',
        'hub_inventory_id',
        line.hub_inventory_id,
        'message',
        'Finished-goods hub row must have product_batch'
      );
    END IF;
  END LOOP;

  FOR line IN
    SELECT sol.id, sol.quantity, sol.hub_inventory_id
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    SELECT hi.id, hi.raw_material_id, hi.product_batch, hi.lot_id
    INTO v_hid, v_rm, v_pb, v_hlot
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id;

    IF v_hid IS NULL THEN
      RAISE EXCEPTION 'Hub inventory row missing during receipt (hub_inventory_id=%)', line.hub_inventory_id;
    END IF;

    v_dest := NULL;
    v_qoh := NULL;
    v_res := NULL;

    IF v_rm IS NOT NULL THEN
      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id
        AND oi.raw_material_id = v_rm
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET
          quantity_on_hand = v_new_qoh,
          available_quantity = v_new_qoh - v_res,
          last_updated = v_iso,
          updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id,
          raw_material_id,
          product_batch,
          lot_id,
          quantity_on_hand,
          reserved_quantity,
          available_quantity,
          last_updated,
          updated_at
        )
        VALUES (
          v_so.outlet_id,
          v_rm,
          NULL,
          NULL,
          line.quantity,
          0,
          line.quantity,
          v_iso,
          v_iso
        );
      END IF;
    ELSE
      v_pb := trim(both from COALESCE(v_pb::text, ''));

      IF v_pb = '' THEN
        RAISE EXCEPTION 'Finished-goods hub row missing product_batch during receipt (hub_inventory_id=%)', line.hub_inventory_id;
      END IF;

      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id
        AND oi.raw_material_id IS NULL
        AND trim(both from oi.product_batch) = v_pb
        AND (oi.lot_id IS NOT DISTINCT FROM v_hlot)
      ORDER BY oi.created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET
          quantity_on_hand = v_new_qoh,
          available_quantity = v_new_qoh - v_res,
          last_updated = v_iso,
          updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id,
          raw_material_id,
          product_batch,
          lot_id,
          quantity_on_hand,
          reserved_quantity,
          available_quantity,
          last_updated,
          updated_at
        )
        VALUES (
          v_so.outlet_id,
          NULL,
          v_pb,
          v_hlot,
          line.quantity,
          0,
          line.quantity,
          v_iso,
          v_iso
        );
      END IF;
    END IF;
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'received',
    received_date = CURRENT_DATE,
    updated_at = v_iso
  WHERE id = p_supply_order_id;

  PERFORM public._append_data_ledger(
    'received',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'event',
    NULL,
    jsonb_build_object(
      'outlet_id',
      v_so.outlet_id,
      'received_date',
      CURRENT_DATE,
      'idempotency_key',
      p_idempotency_key
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id);
END;
$fn$;

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
  v_fg_batch text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT status, outlet_id INTO st, v_outlet_id
  FROM public.supply_orders
  WHERE id = p_supply_order_id
  FOR UPDATE;

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

      IF rec.hub_raw_material_id IS NOT NULL THEN
        SELECT oi.id INTO v_oi_id
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id = rec.hub_raw_material_id
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for raw material % (outlet %)', rec.hub_raw_material_id, v_outlet_id;
        END IF;
      ELSE
        v_fg_batch := trim(both from COALESCE(rec.hub_product_batch, rec.line_product_batch, ''));

        IF v_fg_batch = '' THEN
          RAISE EXCEPTION 'Cannot reverse finished-goods line with missing product batch (hub_inventory_id=%)', rec.hub_inventory_id;
        END IF;

        SELECT oi.id INTO v_oi_id
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id IS NULL
          AND trim(both from oi.product_batch) = v_fg_batch
          AND (oi.lot_id IS NOT DISTINCT FROM rec.hub_lot_id)
        ORDER BY oi.created_at ASC
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for batch % (outlet %)', v_fg_batch, v_outlet_id;
        END IF;
      END IF;

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - rec.quantity,
        available_quantity = (oi.quantity_on_hand - rec.quantity) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_oi_id
        AND oi.quantity_on_hand >= rec.quantity
        AND (oi.quantity_on_hand - rec.quantity) >= COALESCE(oi.reserved_quantity, 0);
      GET DIAGNOSTICS v_rc = ROW_COUNT;
      IF v_rc <> 1 THEN
        IF rec.hub_raw_material_id IS NOT NULL THEN
          RAISE EXCEPTION 'Cannot reverse raw material % for outlet %: received stock has already been consumed or reserved',
            rec.hub_raw_material_id,
            v_outlet_id;
        ELSE
          RAISE EXCEPTION 'Cannot reverse batch % for outlet %: received stock has already been consumed or reserved',
            v_fg_batch,
            v_outlet_id;
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

REVOKE ALL ON FUNCTION public.receive_supply_order(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_supply_order(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_delete_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_supply_order(uuid) TO authenticated;
