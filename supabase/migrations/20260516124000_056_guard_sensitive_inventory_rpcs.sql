/*
  # Guard sensitive inventory and procurement RPCs

  These RPCs are SECURITY DEFINER because they perform multi-table inventory
  mutations. They must still enforce application authorization before running;
  otherwise any authenticated user with a known id can mutate inventory/order
  state outside the UI route guards.
*/

DO $$
BEGIN
  IF to_regprocedure('public.receive_po_shipment_unguarded(uuid,jsonb)') IS NULL THEN
    ALTER FUNCTION public.receive_po_shipment(uuid, jsonb) RENAME TO receive_po_shipment_unguarded;
  END IF;

  IF to_regprocedure('public.cancel_purchase_order_unguarded(uuid)') IS NULL THEN
    ALTER FUNCTION public.cancel_purchase_order(uuid) RENAME TO cancel_purchase_order_unguarded;
  END IF;

  IF to_regprocedure('public.create_outlet_transfer_unguarded(uuid,jsonb,text,uuid)') IS NULL THEN
    ALTER FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) RENAME TO create_outlet_transfer_unguarded;
  END IF;

  IF to_regprocedure('public.dispatch_outlet_transfer_unguarded(uuid)') IS NULL THEN
    ALTER FUNCTION public.dispatch_outlet_transfer(uuid) RENAME TO dispatch_outlet_transfer_unguarded;
  END IF;

  IF to_regprocedure('public.receive_outlet_transfer_unguarded(uuid)') IS NULL THEN
    ALTER FUNCTION public.receive_outlet_transfer(uuid) RENAME TO receive_outlet_transfer_unguarded;
  END IF;

  IF to_regprocedure('public.cancel_outlet_transfer_unguarded(uuid)') IS NULL THEN
    ALTER FUNCTION public.cancel_outlet_transfer(uuid) RENAME TO cancel_outlet_transfer_unguarded;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.receive_po_shipment_unguarded(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_po_shipment_unguarded(uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_purchase_order_unguarded(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_purchase_order_unguarded(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.create_outlet_transfer_unguarded(uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_outlet_transfer_unguarded(uuid, jsonb, text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer_unguarded(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer_unguarded(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer_unguarded(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer_unguarded(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer_unguarded(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer_unguarded(uuid) FROM authenticated;

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

  RETURN public.receive_po_shipment_unguarded(p_po_id, p_lines);
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

  RETURN public.cancel_purchase_order_unguarded(p_po_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_outlet_transfer(
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

  RETURN public.create_outlet_transfer_unguarded(p_from_outlet_id, p_lines, p_notes, p_to_outlet_id);
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

  RETURN public.dispatch_outlet_transfer_unguarded(p_transfer_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.receive_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public.receive_outlet_transfer_unguarded(p_transfer_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_outlet_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  RETURN public.cancel_outlet_transfer_unguarded(p_transfer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_po_shipment(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.receive_po_shipment(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;

-- Outlet transfer state changes must go through the guarded RPCs above.
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfer_lines" ON public.outlet_transfer_lines;
