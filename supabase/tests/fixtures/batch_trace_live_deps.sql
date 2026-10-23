-- Live (production) definitions captured 19 Oct 2026, used only by src/utils/batchTraceMigration.test.ts.

CREATE OR REPLACE FUNCTION public.fulfill_inventory_reservation(p_hub_inventory_id uuid, p_quantity numeric, p_reference_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_res numeric;
  v_led_id uuid;
  v_led_qty numeric;
BEGIN
  IF NOT public.is_authenticated_active_staff() THEN
    RAISE EXCEPTION 'forbidden: active admin or staff required' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Fulfill quantity must be positive';
  END IF;

  IF p_reference_id IS NULL THEN
    RAISE EXCEPTION 'reference_id is required';
  END IF;

  SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
  INTO v_qoh, v_res
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub inventory row not found';
  END IF;

  SELECT r.id, r.quantity
  INTO v_led_id, v_led_qty
  FROM public.hub_inventory_reservations r
  WHERE r.hub_inventory_id = p_hub_inventory_id
    AND r.reference_id = p_reference_id
  ORDER BY CASE WHEN r.reference_type = 'supply_order' THEN 0 ELSE 1 END, r.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_led_id IS NULL THEN
    RAISE EXCEPTION 'No reservation found for reference';
  END IF;

  IF v_led_qty < p_quantity THEN
    RAISE EXCEPTION 'Cannot fulfill more than reserved for this reference';
  END IF;

  IF v_res < p_quantity THEN
    RAISE EXCEPTION 'Cannot fulfill more than reserved quantity';
  END IF;

  IF v_qoh < p_quantity THEN
    RAISE EXCEPTION 'Cannot fulfill more than on-hand quantity';
  END IF;

  v_new_qoh := v_qoh - p_quantity;
  v_new_res := v_res - p_quantity;

  UPDATE public.hub_inventory
  SET
    quantity_on_hand = v_new_qoh,
    reserved_quantity = v_new_res,
    available_quantity = v_new_qoh - v_new_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = p_hub_inventory_id;

  IF v_led_qty = p_quantity THEN
    DELETE FROM public.hub_inventory_reservations WHERE id = v_led_id;
  ELSE
    UPDATE public.hub_inventory_reservations
    SET quantity = v_led_qty - p_quantity, updated_at = now()
    WHERE id = v_led_id;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reserve_inventory(p_hub_inventory_id uuid, p_quantity numeric, p_reference_type text, p_reference_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
  v_new_res numeric;
  v_ref_type text;
BEGIN
  IF NOT public.is_authenticated_active_staff() THEN
    RAISE EXCEPTION 'forbidden: active admin or staff required' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Reservation quantity must be positive';
  END IF;

  IF p_reference_id IS NULL THEN
    RAISE EXCEPTION 'reference_id is required';
  END IF;

  v_ref_type := NULLIF(trim(both from COALESCE(p_reference_type, '')), '');
  IF v_ref_type IS NULL THEN
    RAISE EXCEPTION 'reference_type is required';
  END IF;

  SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
  INTO v_qoh, v_res
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub inventory row not found';
  END IF;

  v_avail := v_qoh - v_res;
  IF v_avail < p_quantity THEN
    RAISE EXCEPTION 'Insufficient available inventory';
  END IF;

  v_new_res := v_res + p_quantity;

  UPDATE public.hub_inventory
  SET
    reserved_quantity = v_new_res,
    available_quantity = v_qoh - v_new_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = p_hub_inventory_id;

  INSERT INTO public.hub_inventory_reservations (
    hub_inventory_id, reference_type, reference_id, quantity, reason, updated_at
  )
  VALUES (
    p_hub_inventory_id, v_ref_type, p_reference_id, p_quantity, p_reason, now()
  )
  ON CONFLICT (hub_inventory_id, reference_type, reference_id)
  DO UPDATE SET
    quantity = public.hub_inventory_reservations.quantity + EXCLUDED.quantity,
    reason = COALESCE(EXCLUDED.reason, public.hub_inventory_reservations.reason),
    updated_at = now();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.receive_supply_order(p_supply_order_id uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Phase 1: validate every line's hub row (no outlet writes yet).
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
      RETURN jsonb_build_object(
        'success', false,
        'error', 'hub_inventory_missing',
        'hub_inventory_id', line.hub_inventory_id
      );
    END IF;

    IF v_rm IS NULL THEN
      v_pb := trim(both from COALESCE(v_pb::text, ''));
      IF v_pb = '' THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'hub_inventory_invalid_fg',
          'hub_inventory_id', line.hub_inventory_id
        );
      END IF;
    END IF;
  END LOOP;

  -- Phase 2: credit outlet inventory. RAISE on unexpected mid-loop failure.
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
      RAISE EXCEPTION 'hub_inventory_missing'
        USING ERRCODE = 'P0001',
              DETAIL = line.hub_inventory_id::text;
    END IF;

    PERFORM public._set_outlet_movement_ctx(
      v_so.outlet_id, 'supply_in', (timezone('Asia/Kuala_Lumpur', now()))::date, 'supply_order', p_supply_order_id
    );

    v_dest := NULL;
    v_qoh := NULL;
    v_res := NULL;

    IF v_rm IS NOT NULL THEN
      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id AND oi.raw_material_id = v_rm
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET quantity_on_hand = v_new_qoh, available_quantity = v_new_qoh - v_res,
            last_updated = v_iso, updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id, raw_material_id, product_batch, lot_id,
          quantity_on_hand, reserved_quantity, available_quantity, last_updated, updated_at
        )
        VALUES (
          v_so.outlet_id, v_rm, NULL, NULL,
          line.quantity, 0, line.quantity, v_iso, v_iso
        );
      END IF;
    ELSE
      v_pb := trim(both from COALESCE(v_pb::text, ''));
      IF v_pb = '' THEN
        PERFORM public._clear_outlet_movement_ctx();
        RAISE EXCEPTION 'hub_inventory_invalid_fg'
          USING ERRCODE = 'P0001',
                DETAIL = line.hub_inventory_id::text;
      END IF;

      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id AND oi.raw_material_id IS NULL
        AND trim(both from oi.product_batch) = v_pb
        AND (oi.lot_id IS NOT DISTINCT FROM v_hlot)
      ORDER BY oi.created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET quantity_on_hand = v_new_qoh, available_quantity = v_new_qoh - v_res,
            last_updated = v_iso, updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id, raw_material_id, product_batch, lot_id,
          quantity_on_hand, reserved_quantity, available_quantity, last_updated, updated_at
        )
        VALUES (
          v_so.outlet_id, NULL, v_pb, v_hlot,
          line.quantity, 0, line.quantity, v_iso, v_iso
        );
      END IF;
    END IF;

    PERFORM public._clear_outlet_movement_ctx();
  END LOOP;

  UPDATE public.supply_orders
  SET status = 'received', received_date = (timezone('Asia/Kuala_Lumpur', now()))::date, updated_at = v_iso
  WHERE id = p_supply_order_id;

  PERFORM public._append_data_ledger(
    'received', 'supply_order', p_supply_order_id::text, 'distribution', 'event',
    NULL,
    jsonb_build_object('outlet_id', v_so.outlet_id, 'received_date', (timezone('Asia/Kuala_Lumpur', now()))::date, 'idempotency_key', p_idempotency_key),
    NULL, NULL
  );

  RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fg_identifier_matches(p_product_batch text, p_lot_label text, p_recipe_sku text, p_query text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    q <> ''
    AND (
      trim(both from coalesce(p_product_batch, '')) = q
      OR trim(both from coalesce(p_lot_label, '')) = q
      OR trim(both from coalesce(p_recipe_sku, '')) = q
    )
  FROM (SELECT trim(both from coalesce(p_query, '')) AS q) s;
$function$
;
