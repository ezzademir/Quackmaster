/*
  Harden inventory/procurement write paths.

  Several SECURITY DEFINER RPCs mutate stock or purchase order state and must not
  trust UI-only role gates. Keep existing implementations as private unchecked
  bodies, then expose guarded wrappers with the original signatures.
*/

-- ---------------------------------------------------------------------------
-- outlet_inventory read RLS: supervisors are scoped; pending users read none.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can view outlet inventory" ON public.outlet_inventory;
DROP POLICY IF EXISTS "Non-pending users can view outlet inventory" ON public.outlet_inventory;
DROP POLICY IF EXISTS "Non supervisor view all outlet inventory" ON public.outlet_inventory;
DROP POLICY IF EXISTS "Supervisor view outlet inventory for assigned outlet" ON public.outlet_inventory;
DROP POLICY IF EXISTS "Admin and staff view all outlet inventory" ON public.outlet_inventory;

CREATE POLICY "Supervisor view outlet inventory for assigned outlet"
  ON public.outlet_inventory FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND outlet_inventory.outlet_id = p.assigned_outlet_id
    )
  );

CREATE POLICY "Admin and staff view all outlet inventory"
  ON public.outlet_inventory FOR SELECT
  TO authenticated
  USING (public.is_authenticated_active_staff());

-- ---------------------------------------------------------------------------
-- outlet_transfers: all writes go through guarded RPCs.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfer_lines" ON public.outlet_transfer_lines;

ALTER FUNCTION public.create_outlet_transfer(uuid, uuid, text, jsonb)
  RENAME TO create_outlet_transfer_unchecked_056;
ALTER FUNCTION public.dispatch_outlet_transfer(uuid)
  RENAME TO dispatch_outlet_transfer_unchecked_056;
ALTER FUNCTION public.receive_outlet_transfer(uuid)
  RENAME TO receive_outlet_transfer_unchecked_056;
ALTER FUNCTION public.cancel_outlet_transfer(uuid)
  RENAME TO cancel_outlet_transfer_unchecked_056;

REVOKE ALL ON FUNCTION public.create_outlet_transfer_unchecked_056(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer_unchecked_056(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer_unchecked_056(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer_unchecked_056(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_outlet_transfer_unchecked_056(uuid, uuid, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer_unchecked_056(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer_unchecked_056(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer_unchecked_056(uuid) FROM authenticated;

CREATE OR REPLACE FUNCTION public.create_outlet_transfer(
  p_from_outlet_id uuid,
  p_to_outlet_id uuid,
  p_notes text,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public.create_outlet_transfer_unchecked_056(p_from_outlet_id, p_to_outlet_id, p_notes, p_lines);
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public.dispatch_outlet_transfer_unchecked_056(p_transfer_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.receive_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_dispatch_date date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT status, dispatch_date
  INTO v_status, v_dispatch_date
  FROM public.outlet_transfers
  WHERE id = p_transfer_id;

  IF FOUND AND v_status = 'dispatched' AND v_dispatch_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_dispatch_state');
  END IF;

  RETURN public.receive_outlet_transfer_unchecked_056(p_transfer_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_dispatch_date date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT status, dispatch_date
  INTO v_status, v_dispatch_date
  FROM public.outlet_transfers
  WHERE id = p_transfer_id;

  IF FOUND AND v_status = 'dispatched' AND v_dispatch_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_dispatch_state');
  END IF;

  RETURN public.cancel_outlet_transfer_unchecked_056(p_transfer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_outlet_transfer(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_outlet_transfer(uuid, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Purchase order and hub reservation RPCs: active staff/admin only.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.receive_po_shipment(uuid, jsonb)
  RENAME TO receive_po_shipment_unchecked_056;
ALTER FUNCTION public.cancel_purchase_order(uuid)
  RENAME TO cancel_purchase_order_unchecked_056;
ALTER FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text)
  RENAME TO reserve_inventory_unchecked_056;
ALTER FUNCTION public.release_inventory_reservation(uuid, numeric, uuid)
  RENAME TO release_inventory_reservation_unchecked_056;
ALTER FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid)
  RENAME TO fulfill_inventory_reservation_unchecked_056;

REVOKE ALL ON FUNCTION public.receive_po_shipment_unchecked_056(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_purchase_order_unchecked_056(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_inventory_unchecked_056(uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_inventory_reservation_unchecked_056(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfill_inventory_reservation_unchecked_056(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_po_shipment_unchecked_056(uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_purchase_order_unchecked_056(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.reserve_inventory_unchecked_056(uuid, numeric, text, uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.release_inventory_reservation_unchecked_056(uuid, numeric, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.fulfill_inventory_reservation_unchecked_056(uuid, numeric, uuid) FROM authenticated;

CREATE OR REPLACE FUNCTION public.receive_po_shipment(p_po_id uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public.receive_po_shipment_unchecked_056(p_po_id, p_lines);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public.cancel_purchase_order_unchecked_056(p_po_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_inventory(
  p_hub_inventory_id uuid,
  p_quantity numeric,
  p_reference_type text,
  p_reference_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RAISE EXCEPTION 'Not authenticated or inactive';
  END IF;

  PERFORM public.reserve_inventory_unchecked_056(
    p_hub_inventory_id,
    p_quantity,
    p_reference_type,
    p_reference_id,
    p_reason
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_inventory_reservation(
  p_hub_inventory_id uuid,
  p_quantity numeric,
  p_reference_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RAISE EXCEPTION 'Not authenticated or inactive';
  END IF;

  PERFORM public.release_inventory_reservation_unchecked_056(
    p_hub_inventory_id,
    p_quantity,
    p_reference_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfill_inventory_reservation(
  p_hub_inventory_id uuid,
  p_quantity numeric,
  p_reference_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RAISE EXCEPTION 'Not authenticated or inactive';
  END IF;

  PERFORM public.fulfill_inventory_reservation_unchecked_056(
    p_hub_inventory_id,
    p_quantity,
    p_reference_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.receive_po_shipment(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.receive_po_shipment(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin supply-order delete: do not recreate consumed outlet stock in the hub.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.admin_delete_supply_order(uuid)
  RENAME TO admin_delete_supply_order_unchecked_056;

REVOKE ALL ON FUNCTION public.admin_delete_supply_order_unchecked_056(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_supply_order_unchecked_056(uuid) FROM authenticated;

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
  v_oi_id uuid;
  v_qoh numeric;
  v_problem RECORD;
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

  IF st = 'received' THEN
    CREATE TEMP TABLE IF NOT EXISTS pg_temp.admin_delete_supply_order_reversal_targets (
      outlet_inventory_id uuid PRIMARY KEY,
      required_quantity numeric(14, 4) NOT NULL,
      quantity_on_hand numeric(14, 4) NOT NULL
    ) ON COMMIT DROP;

    TRUNCATE pg_temp.admin_delete_supply_order_reversal_targets;

    FOR rec IN
      SELECT
        sol.id AS line_id,
        sol.hub_inventory_id,
        sol.quantity,
        sol.product_batch AS line_product_batch,
        hi.raw_material_id AS hub_raw_material_id,
        hi.product_batch AS hub_product_batch
      FROM public.supply_order_lines sol
      INNER JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
      WHERE sol.supply_order_id = p_supply_order_id
    LOOP
      v_oi_id := NULL;
      v_qoh := NULL;

      IF rec.hub_raw_material_id IS NOT NULL THEN
        SELECT oi.id, oi.quantity_on_hand
        INTO v_oi_id, v_qoh
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id = rec.hub_raw_material_id
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for raw material % (outlet %)',
            rec.hub_raw_material_id,
            v_outlet_id;
        END IF;
      ELSE
        SELECT oi.id, oi.quantity_on_hand
        INTO v_oi_id, v_qoh
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = v_outlet_id
          AND oi.raw_material_id IS NULL
          AND oi.product_batch IS NOT DISTINCT FROM COALESCE(rec.line_product_batch, rec.hub_product_batch)
        ORDER BY oi.updated_at DESC NULLS LAST, oi.id
        LIMIT 1
        FOR UPDATE;

        IF v_oi_id IS NULL THEN
          RAISE EXCEPTION 'Outlet inventory missing for batch % (outlet %)',
            COALESCE(rec.line_product_batch, rec.hub_product_batch),
            v_outlet_id;
        END IF;
      END IF;

      INSERT INTO pg_temp.admin_delete_supply_order_reversal_targets (
        outlet_inventory_id,
        required_quantity,
        quantity_on_hand
      )
      VALUES (v_oi_id, rec.quantity, v_qoh)
      ON CONFLICT (outlet_inventory_id) DO UPDATE
      SET
        required_quantity = admin_delete_supply_order_reversal_targets.required_quantity + EXCLUDED.required_quantity,
        quantity_on_hand = EXCLUDED.quantity_on_hand;
    END LOOP;

    SELECT outlet_inventory_id, required_quantity, quantity_on_hand
    INTO v_problem
    FROM pg_temp.admin_delete_supply_order_reversal_targets
    WHERE quantity_on_hand < required_quantity
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'Cannot delete received supply order: outlet inventory % has %, needs % for reversal',
        v_problem.outlet_inventory_id,
        v_problem.quantity_on_hand,
        v_problem.required_quantity;
    END IF;
  END IF;

  PERFORM public.admin_delete_supply_order_unchecked_056(p_supply_order_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_supply_order(uuid) TO authenticated;
