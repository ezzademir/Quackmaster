/*
  # Inventory reservation RPCs (hub_inventory)

  Client code calls reserve_inventory / release_inventory_reservation / fulfill_inventory_reservation.
  Hub inventory has SELECT-only RLS for authenticated users; writes go through SECURITY DEFINER RPCs.

  Semantics:
  - reserve: lock stock by increasing reserved_quantity (available = qoh - reserved).
  - release: undo a reservation (e.g. rollback failed supply order).
  - fulfill: ship reserved stock — decrease both quantity_on_hand and reserved_quantity.
*/

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
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
  v_new_res numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Reservation quantity must be positive';
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
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_new_res numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Release quantity must be positive';
  END IF;

  SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
  INTO v_qoh, v_res
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub inventory row not found';
  END IF;

  v_new_res := GREATEST(0, v_res - p_quantity);

  UPDATE public.hub_inventory
  SET
    reserved_quantity = v_new_res,
    available_quantity = v_qoh - v_new_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = p_hub_inventory_id;
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
DECLARE
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_res numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Fulfill quantity must be positive';
  END IF;

  SELECT quantity_on_hand, COALESCE(reserved_quantity, 0)
  INTO v_qoh, v_res
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub inventory row not found';
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
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) TO authenticated;
