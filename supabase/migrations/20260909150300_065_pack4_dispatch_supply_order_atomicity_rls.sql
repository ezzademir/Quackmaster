/*
  Pack 4 (audit P0-2 / P0-4):
  - Atomic dispatch_supply_order + cancel_supply_order RPCs (all-or-nothing).
  - Lock down open RLS on supply_orders / supply_order_lines (no client status flips).
  - Minimal hub_inventory_reservations ledger so release/fulfill honor reference_id
    (stops cross-order cancel corruption).
*/

-- ---------------------------------------------------------------------------
-- Reservation ledger (keyed by hub row + reference)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hub_inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_inventory_id uuid NOT NULL REFERENCES public.hub_inventory(id) ON DELETE CASCADE,
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  quantity numeric(12, 2) NOT NULL CHECK (quantity > 0),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hub_inventory_reservations_ref_unique
    UNIQUE (hub_inventory_id, reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_hub_inv_reservations_reference
  ON public.hub_inventory_reservations (reference_type, reference_id);

ALTER TABLE public.hub_inventory_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view hub inventory reservations" ON public.hub_inventory_reservations;
CREATE POLICY "Staff can view hub inventory reservations"
  ON public.hub_inventory_reservations FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

COMMENT ON TABLE public.hub_inventory_reservations IS
  'Per-reference remaining hub reservation qty. reserve/release/fulfill must match this row so cancel cannot steal other orders'' reserved stock.';

-- Backfill remaining reservations for currently pending supply orders
INSERT INTO public.hub_inventory_reservations (
  hub_inventory_id, reference_type, reference_id, quantity, reason
)
SELECT
  sol.hub_inventory_id,
  'supply_order',
  sol.supply_order_id,
  SUM(sol.quantity)::numeric(12, 2),
  'backfill pending supply_order'
FROM public.supply_order_lines sol
INNER JOIN public.supply_orders so ON so.id = sol.supply_order_id
WHERE lower(trim(both from so.status)) = 'pending'
GROUP BY sol.hub_inventory_id, sol.supply_order_id
ON CONFLICT (hub_inventory_id, reference_type, reference_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- reserve / release / fulfill — honor reference ledger
-- ---------------------------------------------------------------------------
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
  v_ref_type text;
BEGIN
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
  v_led_id uuid;
  v_led_qty numeric;
  v_release numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Release quantity must be positive';
  END IF;

  IF p_reference_id IS NULL THEN
    RAISE EXCEPTION 'reference_id is required';
  END IF;

  -- Lock hub first (same order as reserve) to avoid deadlocks
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
    RAISE EXCEPTION 'Cannot release more than reserved for this reference';
  END IF;

  v_release := p_quantity;

  -- Never decrease hub reserved below zero; never steal other references' share
  IF v_res < v_release THEN
    RAISE EXCEPTION 'Hub reserved_quantity lower than reference reservation';
  END IF;

  v_new_res := v_res - v_release;

  UPDATE public.hub_inventory
  SET
    reserved_quantity = v_new_res,
    available_quantity = v_qoh - v_new_res,
    last_updated = now(),
    updated_at = now()
  WHERE id = p_hub_inventory_id;

  IF v_led_qty = v_release THEN
    DELETE FROM public.hub_inventory_reservations WHERE id = v_led_id;
  ELSE
    UPDATE public.hub_inventory_reservations
    SET quantity = v_led_qty - v_release, updated_at = now()
    WHERE id = v_led_id;
  END IF;
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
  v_led_id uuid;
  v_led_qty numeric;
BEGIN
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
$$;

REVOKE ALL ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- dispatch_supply_order — single transaction, row lock, all-or-nothing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_supply_order(p_supply_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.supply_orders%ROWTYPE;
  v_ln RECORD;
  v_dispatch_date date;
  v_updated int;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT * INTO v_order
  FROM public.supply_orders
  WHERE id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  IF lower(trim(both from v_order.status)) <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_status',
      'status', v_order.status
    );
  END IF;

  v_dispatch_date := (timezone('Asia/Kuala_Lumpur', now()))::date;

  FOR v_ln IN
    SELECT sol.hub_inventory_id, sol.quantity
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    -- RAISE from fulfill aborts the whole transaction (no partial ship)
    PERFORM public.fulfill_inventory_reservation(
      v_ln.hub_inventory_id,
      v_ln.quantity,
      p_supply_order_id
    );
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'dispatched',
    dispatch_date = v_dispatch_date,
    updated_at = now()
  WHERE id = p_supply_order_id
    AND lower(trim(both from status)) = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'dispatch_status_race';
  END IF;

  PERFORM public._append_data_ledger(
    'dispatched',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'update',
    NULL,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'dispatched', 'dispatch_date', v_dispatch_date),
    NULL,
    jsonb_build_object('entity_label', 'Supply order dispatched')
  );

  RETURN jsonb_build_object('success', true, 'dispatch_date', v_dispatch_date);
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_supply_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_supply_order(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- cancel_supply_order — pending only; release by reference then status
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
  v_order public.supply_orders%ROWTYPE;
  v_ln RECORD;
  v_st text;
  v_updated int;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT * INTO v_order
  FROM public.supply_orders
  WHERE id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  v_st := lower(trim(both from COALESCE(v_order.status, '')));

  IF v_st = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true);
  END IF;

  IF v_st <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_status',
      'status', v_order.status
    );
  END IF;

  FOR v_ln IN
    SELECT sol.hub_inventory_id, sol.quantity
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    PERFORM public.release_inventory_reservation(
      v_ln.hub_inventory_id,
      v_ln.quantity,
      p_supply_order_id
    );
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'cancelled',
    updated_at = now()
  WHERE id = p_supply_order_id
    AND lower(trim(both from status)) = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'cancel_status_race';
  END IF;

  PERFORM public._append_data_ledger(
    'cancelled',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'update',
    NULL,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'cancelled'),
    NULL,
    jsonb_build_object(
      'entity_label', 'Supply order cancelled',
      'cancellation_reason', COALESCE(p_reason, '')
    )
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_supply_order(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_supply_order(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS lockdown: no open any-auth status flips; writes via staff helpers + RPCs
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can create supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Authenticated users can update supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Admins can create supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Admins can update supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Admins can delete supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Authenticated users can create supply orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Authenticated users can update supply orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Authenticated users can delete supply orders" ON public.supply_orders;

DROP POLICY IF EXISTS "Staff can insert pending supply_orders" ON public.supply_orders;
CREATE POLICY "Staff can insert pending supply_orders"
  ON public.supply_orders FOR INSERT TO authenticated
  WITH CHECK (
    public.is_authenticated_active_staff()
    AND lower(trim(both from COALESCE(status, ''))) = 'pending'
  );

-- Staff may delete only pending headers (create-path rollback). Status transitions
-- for dispatch/cancel/receive go through SECURITY DEFINER RPCs (bypass RLS).
DROP POLICY IF EXISTS "Staff can delete pending supply_orders" ON public.supply_orders;
CREATE POLICY "Staff can delete pending supply_orders"
  ON public.supply_orders FOR DELETE TO authenticated
  USING (
    public.is_authenticated_active_staff()
    AND lower(trim(both from COALESCE(status, ''))) = 'pending'
  );

-- No UPDATE policy on supply_orders: clients cannot flip status.

DROP POLICY IF EXISTS "Authenticated users can insert supply order lines" ON public.supply_order_lines;
DROP POLICY IF EXISTS "Authenticated users can delete supply order lines" ON public.supply_order_lines;
DROP POLICY IF EXISTS "Authenticated users can update supply order lines" ON public.supply_order_lines;

DROP POLICY IF EXISTS "Staff can insert supply order lines" ON public.supply_order_lines;
CREATE POLICY "Staff can insert supply order lines"
  ON public.supply_order_lines FOR INSERT TO authenticated
  WITH CHECK (public.is_authenticated_active_staff());

DROP POLICY IF EXISTS "Staff can delete supply order lines" ON public.supply_order_lines;
CREATE POLICY "Staff can delete supply order lines"
  ON public.supply_order_lines FOR DELETE TO authenticated
  USING (public.is_authenticated_active_staff());

-- Keep SELECT policies unchanged (authenticated / non-pending view).
