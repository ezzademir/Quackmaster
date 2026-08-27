/*
  Harden inventory and order mutation paths.

  Pending users still hold the Supabase "authenticated" JWT role while waiting
  for approval. Direct write policies and SECURITY DEFINER RPCs must therefore
  check the application role, not just auth.uid().
*/

-- Keep the staff predicate available to this migration even if it is re-run.
CREATE OR REPLACE FUNCTION public.is_authenticated_active_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin', 'staff')
  );
$$;

REVOKE ALL ON FUNCTION public.is_authenticated_active_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_authenticated_active_staff() TO authenticated;

-- Harden existing SECURITY DEFINER RPCs that previously accepted any
-- authenticated JWT, including pending/unapproved users.
DO $$
DECLARE
  target regprocedure;
  targets regprocedure[] := ARRAY[
    'public.reserve_inventory(uuid,numeric,text,uuid,text)'::regprocedure,
    'public.release_inventory_reservation(uuid,numeric,uuid)'::regprocedure,
    'public.fulfill_inventory_reservation(uuid,numeric,uuid)'::regprocedure,
    'public.receive_po_shipment(uuid,jsonb)'::regprocedure,
    'public.cancel_purchase_order(uuid)'::regprocedure,
    'public.create_outlet_transfer(uuid,jsonb,text,uuid)'::regprocedure,
    'public.dispatch_outlet_transfer(uuid)'::regprocedure,
    'public.receive_outlet_transfer(uuid)'::regprocedure,
    'public.cancel_outlet_transfer(uuid)'::regprocedure
  ];
  definition text;
  hardened_definition text;
BEGIN
  FOREACH target IN ARRAY targets LOOP
    definition := pg_get_functiondef(target::oid);

    IF position('IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN' in definition) > 0 THEN
      CONTINUE;
    END IF;

    hardened_definition := replace(
      definition,
      'IF auth.uid() IS NULL THEN',
      'IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN'
    );

    IF hardened_definition = definition THEN
      RAISE EXCEPTION 'Could not harden authentication guard for %', target::text;
    END IF;

    EXECUTE hardened_definition;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_po_shipment(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.receive_outlet_transfer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_outlet_transfer(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reserve_inventory(uuid, numeric, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_inventory_reservation(uuid, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_inventory_reservation(uuid, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_po_shipment(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_outlet_transfer(uuid, jsonb, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_outlet_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_outlet_transfer(uuid) TO authenticated;

-- Restrict direct table mutations to approved staff. These policies support
-- existing staff UI flows while excluding pending accounts and arbitrary clients.
DROP POLICY IF EXISTS "Authenticated users can create supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Authenticated users can update supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Active staff can create supply_orders" ON public.supply_orders;
DROP POLICY IF EXISTS "Active staff can update supply_orders" ON public.supply_orders;

CREATE POLICY "Active staff can create supply_orders"
  ON public.supply_orders FOR INSERT TO authenticated
  WITH CHECK (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can update supply_orders"
  ON public.supply_orders FOR UPDATE TO authenticated
  USING (public.is_authenticated_active_staff())
  WITH CHECK (public.is_authenticated_active_staff());

DROP POLICY IF EXISTS "Authenticated users can view supply order lines" ON public.supply_order_lines;
DROP POLICY IF EXISTS "Authenticated users can insert supply order lines" ON public.supply_order_lines;
DROP POLICY IF EXISTS "Authenticated users can delete supply order lines" ON public.supply_order_lines;
DROP POLICY IF EXISTS "Active staff can view supply order lines" ON public.supply_order_lines;
DROP POLICY IF EXISTS "Active staff can insert supply order lines" ON public.supply_order_lines;
DROP POLICY IF EXISTS "Active staff can delete supply order lines" ON public.supply_order_lines;

CREATE POLICY "Active staff can view supply order lines"
  ON public.supply_order_lines FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can insert supply order lines"
  ON public.supply_order_lines FOR INSERT TO authenticated
  WITH CHECK (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can delete supply order lines"
  ON public.supply_order_lines FOR DELETE TO authenticated
  USING (public.is_authenticated_active_staff());

DROP POLICY IF EXISTS "Authenticated users can view outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Active staff can view outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Active staff can insert outlet_transfers" ON public.outlet_transfers;
DROP POLICY IF EXISTS "Active staff can update outlet_transfers" ON public.outlet_transfers;

CREATE POLICY "Active staff can view outlet_transfers"
  ON public.outlet_transfers FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can insert outlet_transfers"
  ON public.outlet_transfers FOR INSERT TO authenticated
  WITH CHECK (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can update outlet_transfers"
  ON public.outlet_transfers FOR UPDATE TO authenticated
  USING (public.is_authenticated_active_staff())
  WITH CHECK (public.is_authenticated_active_staff());

DROP POLICY IF EXISTS "Authenticated users can view outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Authenticated users can update outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Active staff can view outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Active staff can insert outlet_transfer_lines" ON public.outlet_transfer_lines;
DROP POLICY IF EXISTS "Active staff can update outlet_transfer_lines" ON public.outlet_transfer_lines;

CREATE POLICY "Active staff can view outlet_transfer_lines"
  ON public.outlet_transfer_lines FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can insert outlet_transfer_lines"
  ON public.outlet_transfer_lines FOR INSERT TO authenticated
  WITH CHECK (public.is_authenticated_active_staff());

CREATE POLICY "Active staff can update outlet_transfer_lines"
  ON public.outlet_transfer_lines FOR UPDATE TO authenticated
  USING (public.is_authenticated_active_staff())
  WITH CHECK (public.is_authenticated_active_staff());
