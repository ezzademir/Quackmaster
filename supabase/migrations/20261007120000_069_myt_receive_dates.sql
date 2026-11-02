-- [HOLD] Audit A-01 + A-02 (7 Oct 2026). NOT APPLIED — pending Clive/Ezzad review.
-- DB TimeZone is UTC, so CURRENT_DATE stamps the previous Malaysia day between 00:00 and 08:00 MYT.
--   receive_supply_order: movement business_date, received_date, ledger received_date (3 uses)
--   receive_po_shipment:  actual_delivery_date (1 use)
-- Rewrites the live definitions (pg_get_functiondef) replacing CURRENT_DATE with the MYT date,
-- matching dispatch_supply_order. Guarded: aborts if the live body drifted (unexpected count).
DO $mig$
DECLARE
  f record;
  v_def text;
  v_n int;
BEGIN
  FOR f IN
    SELECT * FROM (VALUES
      ('public.receive_supply_order(uuid, uuid)'::regprocedure, 3),
      ('public.receive_po_shipment(uuid, jsonb)'::regprocedure, 1)
    ) AS t(oid, expected)
  LOOP
    v_def := pg_get_functiondef(f.oid);
    v_n := (length(v_def) - length(replace(v_def, 'CURRENT_DATE', ''))) / length('CURRENT_DATE');
    IF v_n <> f.expected THEN
      RAISE EXCEPTION 'myt_receive_dates: % has % CURRENT_DATE uses, expected %', f.oid, v_n, f.expected;
    END IF;
    EXECUTE replace(v_def, 'CURRENT_DATE', '(timezone(''Asia/Kuala_Lumpur'', now()))::date');
  END LOOP;
END
$mig$;
