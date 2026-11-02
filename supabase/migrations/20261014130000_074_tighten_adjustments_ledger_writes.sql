-- [HOLD] Tighten client writes on inventory_adjustments and data_ledger. NOT APPLIED — pending Clive/Ezzad review.
-- Before: inventory_adjustments had "Authenticated users can manage inventory adjustments" FOR ALL USING (true) WITH CHECK (true),
--         data_ledger had INSERT WITH CHECK (true): any signed-in account, including `pending`, could write/delete.
-- App usage (main 40db3b1): no page inserts inventory_adjustments from the client (createInventoryAdjustment has no caller;
-- apply is the admin-only RPC apply_inventory_adjustment). Stock-take and waste go through SECURITY DEFINER RPCs
-- (post_outlet_stock_take, post_waste_event). data_ledger client inserts come from src/utils/ledger.ts writeLedgerEntry,
-- used by admin pages and by staff/supervisor flows (Production, Distribution, stock-take events).
-- SECURITY DEFINER helpers (_append_data_ledger) bypass RLS and are unaffected.

CREATE OR REPLACE FUNCTION public.is_active_ledger_writer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active AND lower(trim(p.role)) IN ('admin', 'staff', 'supervisor')
  );
$function$;
REVOKE ALL ON FUNCTION public.is_active_ledger_writer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_ledger_writer() TO authenticated;

-- inventory_adjustments: drop the wide-open policy; inserts need active admin/staff and own created_by; update stays admin.
DROP POLICY IF EXISTS "Authenticated users can manage inventory adjustments" ON public.inventory_adjustments;
DROP POLICY IF EXISTS "Authenticated users can insert own inventory_adjustments" ON public.inventory_adjustments;
CREATE POLICY "Active staff insert own inventory_adjustments" ON public.inventory_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authenticated_active_staff() AND created_by = auth.uid());
-- (no DELETE policy: deletes are denied)

-- data_ledger: inserts need an active admin/staff/supervisor writing as themselves.
DROP POLICY IF EXISTS "Authenticated users can insert ledger rows" ON public.data_ledger;
CREATE POLICY "Active members insert own ledger rows" ON public.data_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_ledger_writer() AND user_id = auth.uid());

-- Defence in depth: anon has no business touching either table.
REVOKE ALL ON public.inventory_adjustments, public.data_ledger FROM anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.inventory_adjustments, public.data_ledger FROM authenticated;
