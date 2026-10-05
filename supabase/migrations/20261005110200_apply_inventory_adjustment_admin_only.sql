/*
  Hub stock adjustments are admin-only (same gate as adjust_hub_inventory_quantity).

  apply_inventory_adjustment is SECURITY DEFINER and granted to authenticated.
  The previous body only required is_profiles_admin() when status = 'pending'.
  RLS let any authenticated user insert their own row with status = 'approved'
  (WITH CHECK was only created_by = auth.uid()). A staff, supervisor, or pending
  session could then call the RPC and add or remove hub quantity, bypassing the
  Inventory screen's admin check.

  Deductions that exceeded quantity_on_hand were also clamped to 0 and marked
  applied, so the ledger quantity did not match the requested adjustment.

  This migration:
    - requires an admin for every apply, including rows already marked approved
    - refuses a deduction that would drive on-hand negative (no silent floor)
    - lets only active staff insert pending rows; only admins may insert approved
*/

DROP POLICY IF EXISTS "Authenticated users can insert own inventory_adjustments"
  ON public.inventory_adjustments;

CREATE POLICY "Active staff insert own inventory adjustments"
  ON public.inventory_adjustments FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.is_authenticated_active_staff()
    AND (
      status = 'pending'
      OR (status = 'approved' AND public.is_profiles_admin())
    )
  );

CREATE OR REPLACE FUNCTION public.apply_inventory_adjustment(p_adjustment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  adj RECORD;
  inv RECORD;
  v_new_qoh numeric;
  v_avail numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- Hub quantity changes are admin-only. Client-supplied status = 'approved'
  -- must not skip this check.
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  SELECT * INTO adj
  FROM public.inventory_adjustments
  WHERE id = p_adjustment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'adjustment_not_found');
  END IF;

  IF adj.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_applied', true);
  END IF;

  IF adj.status = 'rejected' THEN
    RETURN jsonb_build_object('success', false, 'error', 'rejected_adjustment');
  END IF;

  SELECT * INTO inv
  FROM public.hub_inventory
  WHERE id = adj.hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_not_found');
  END IF;

  IF adj.adjustment_type = 'addition' THEN
    v_new_qoh := inv.quantity_on_hand + adj.adjusted_quantity;
  ELSE
    v_new_qoh := inv.quantity_on_hand - adj.adjusted_quantity;
    IF v_new_qoh < 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_on_hand',
        'quantity_on_hand', inv.quantity_on_hand,
        'requested', adj.adjusted_quantity
      );
    END IF;
  END IF;

  IF v_new_qoh < COALESCE(inv.reserved_quantity, 0) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'on_hand_below_reserved',
      'reserved', inv.reserved_quantity
    );
  END IF;

  v_avail := v_new_qoh - COALESCE(inv.reserved_quantity, 0);

  UPDATE public.hub_inventory
  SET
    quantity_on_hand = v_new_qoh,
    available_quantity = v_avail,
    last_updated = now(),
    updated_at = now()
  WHERE id = inv.id;

  UPDATE public.inventory_adjustments
  SET
    status = 'approved',
    reviewed_by = COALESCE(reviewed_by, auth.uid()),
    reviewed_at = COALESCE(reviewed_at, now()),
    applied_at = now(),
    updated_at = now()
  WHERE id = adj.id;

  PERFORM public._append_data_ledger(
    'approved',
    'hub_inventory',
    inv.id::text,
    'inventory',
    'update',
    adj.id::text,
    jsonb_build_object(
      'quantity_on_hand', inv.quantity_on_hand,
      'available_quantity', inv.quantity_on_hand - COALESCE(inv.reserved_quantity, 0)
    ),
    jsonb_build_object(
      'quantity_on_hand', v_new_qoh,
      'available_quantity', v_avail
    ),
    jsonb_build_object(
      'adjustment_type', adj.adjustment_type,
      'adjusted_quantity', adj.adjusted_quantity,
      'adjustment_reason', adj.adjustment_reason
    ),
    jsonb_build_object('inventory_adjustment_id', adj.id)
  );

  RETURN jsonb_build_object('success', true, 'quantity_on_hand', v_new_qoh);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_adjustment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_inventory_adjustment(uuid) TO authenticated;
