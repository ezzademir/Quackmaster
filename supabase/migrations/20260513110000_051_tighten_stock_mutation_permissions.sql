/*
  Tighten stock mutation surfaces introduced by recent RPCs.

  - Outlet transfers should be mutated only through guarded RPCs.
  - Purchase order cancellation reverses inventory/costing and is admin-only in the UI.
*/

-- ---------------------------------------------------------------------------
-- Outlet transfer tables: allow active staff to read, but keep writes in RPCs.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can view outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Active staff can view outlet_transfers" ON public.outlet_transfers;

CREATE POLICY "Active staff can view outlet_transfers"
  ON public.outlet_transfers FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

DROP POLICY IF EXISTS "Authenticated users can view outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Active staff can view outlet_transfer_lines" ON public.outlet_transfer_lines;

CREATE POLICY "Active staff can view outlet_transfer_lines"
  ON public.outlet_transfer_lines FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

-- ---------------------------------------------------------------------------
-- Wrap existing transfer RPCs with active-staff checks.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid)
  RENAME TO _create_outlet_transfer_unguarded_20260513;

REVOKE ALL ON FUNCTION public._create_outlet_transfer_unguarded_20260513(uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._create_outlet_transfer_unguarded_20260513(uuid, jsonb, text, uuid) FROM authenticated;

CREATE FUNCTION public.create_outlet_transfer(
  p_from_outlet_id uuid,
  p_lines jsonb,
  p_notes text,
  p_to_outlet_id uuid
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

  RETURN public._create_outlet_transfer_unguarded_20260513(
    p_from_outlet_id,
    p_lines,
    p_notes,
    p_to_outlet_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) TO authenticated;

ALTER FUNCTION public.dispatch_outlet_transfer(uuid)
  RENAME TO _dispatch_outlet_transfer_unguarded_20260513;

REVOKE ALL ON FUNCTION public._dispatch_outlet_transfer_unguarded_20260513(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._dispatch_outlet_transfer_unguarded_20260513(uuid) FROM authenticated;

CREATE FUNCTION public.dispatch_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public._dispatch_outlet_transfer_unguarded_20260513(p_transfer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_outlet_transfer(uuid) TO authenticated;

ALTER FUNCTION public.receive_outlet_transfer(uuid)
  RENAME TO _receive_outlet_transfer_unguarded_20260513;

REVOKE ALL ON FUNCTION public._receive_outlet_transfer_unguarded_20260513(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._receive_outlet_transfer_unguarded_20260513(uuid) FROM authenticated;

CREATE FUNCTION public.receive_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public._receive_outlet_transfer_unguarded_20260513(p_transfer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_outlet_transfer(uuid) TO authenticated;

ALTER FUNCTION public.cancel_outlet_transfer(uuid)
  RENAME TO _cancel_outlet_transfer_unguarded_20260513;

REVOKE ALL ON FUNCTION public._cancel_outlet_transfer_unguarded_20260513(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cancel_outlet_transfer_unguarded_20260513(uuid) FROM authenticated;

CREATE FUNCTION public.cancel_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public._cancel_outlet_transfer_unguarded_20260513(p_transfer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Purchase order cancellation reverses hub inventory and costing: admin-only.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.cancel_purchase_order(uuid)
  RENAME TO _cancel_purchase_order_unguarded_20260513;

REVOKE ALL ON FUNCTION public._cancel_purchase_order_unguarded_20260513(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cancel_purchase_order_unguarded_20260513(uuid) FROM authenticated;

CREATE FUNCTION public.cancel_purchase_order(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;

  RETURN public._cancel_purchase_order_unguarded_20260513(p_po_id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;
