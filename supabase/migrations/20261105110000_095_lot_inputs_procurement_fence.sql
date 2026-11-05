/*
  095 — Hide inventory_lot_inputs from procurement.

  093 creates that table with SELECT for every authenticated user and does not
  call the 085 default-deny sweep. The rows are the raw-material lots and
  quantities used to make a finished lot. Re-applying 093 does not run again
  once its version is recorded, so the fence is repeated here.

  No-op when 085 or the table is absent.
*/

DO $lot_inputs_fence$
BEGIN
  IF to_regclass('public.inventory_lot_inputs') IS NULL THEN
    RETURN;
  END IF;
  IF to_regprocedure('public.is_procurement_user()') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS inventory_lot_inputs_deny_procurement ON public.inventory_lot_inputs';
  EXECUTE $policy$
    CREATE POLICY inventory_lot_inputs_deny_procurement
      ON public.inventory_lot_inputs
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (NOT public.is_procurement_user())
      WITH CHECK (NOT public.is_procurement_user())
  $policy$;
END
$lot_inputs_fence$;
