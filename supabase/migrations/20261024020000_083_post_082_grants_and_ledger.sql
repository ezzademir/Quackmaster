/*
  083 — Post-082 fixes (idempotent; safe to re-run; adds NO stock).

  1. 082 dropped/recreated public.recipe_variance_by_run. On recreate, Supabase default privileges gave
     `authenticated` REFERENCES, TRIGGER and TRUNCATE, which it did not hold before 082. Revoke them and
     (re)grant the exact pre-082 set:
       authenticated: SELECT, INSERT, UPDATE, DELETE
       service_role : SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
       postgres     : owner (all)
       anon, PUBLIC : none
  2. 082's PO-0032 correction (+0.004 kg on G-1.0KG hub row 5911121d) went through _append_data_ledger,
     which returns without writing when auth.uid() IS NULL (always true in a migration). The stock change
     landed (194.52 -> 194.524) but no audit row was written. Insert that row directly as a system action
     (user_id NULL, user_email ''), exactly the columns _append_data_ledger writes. data_ledger has no
     triggers, hash or previous-row link.
     Guards: source ledger 6daad5c0 exists; no receipt_rounding_corrected row for the hub row yet; and the
     hub row currently holds 194.524 (i.e. the 0.004 has landed). Never touches hub_inventory.
*/

REVOKE ALL ON public.recipe_variance_by_run FROM anon;
REVOKE ALL ON public.recipe_variance_by_run FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON public.recipe_variance_by_run FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipe_variance_by_run TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.recipe_variance_by_run TO service_role;

DO $led$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.data_ledger WHERE id = '6daad5c0-2233-4e0f-8379-c8398ae60b81') THEN
    RAISE NOTICE '083: PO-0032 source ledger row not present; ledger fix skipped';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.data_ledger WHERE action = 'receipt_rounding_corrected'
             AND entity_type = 'hub_inventory' AND entity_id = '5911121d-53a8-4333-9130-c126dc9601d6') THEN
    RAISE NOTICE '083: PO-0032 correction ledger row already present; skipped';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.hub_inventory WHERE id = '5911121d-53a8-4333-9130-c126dc9601d6'
                 AND quantity_on_hand = 194.524 AND available_quantity = 194.524) THEN
    RAISE NOTICE '083: G-1.0KG hub row is not at 194.524 (082 correction not landed or stock has moved); skipped';
    RETURN;
  END IF;

  INSERT INTO public.data_ledger (user_id, user_email, action, entity_type, entity_id, module, operation,
                                  reference_id, before_data, after_data, delta_data, metadata)
  VALUES (NULL, '', 'receipt_rounding_corrected', 'hub_inventory', '5911121d-53a8-4333-9130-c126dc9601d6',
          'procurement', 'update', '697f67f8-03b3-4ac5-b3d9-2b16c0eb6fc9',
          jsonb_build_object('quantity_on_hand', 194.52, 'available_quantity', 194.52),
          jsonb_build_object('quantity_on_hand', 194.524, 'available_quantity', 194.524),
          jsonb_build_object('posted_delta', 0.004, 'raw_material_id', 'bdf24c4e-34ca-4d77-a2dd-29147a7aa05a',
                             'purchase_order_id', '5a69321e-ca06-4887-8b9b-67f099bc3209',
                             'source_ledger_id', '6daad5c0-2233-4e0f-8379-c8398ae60b81', 'value_delta', 0),
          jsonb_build_object('migration', '082', 'recorded_by', '083', 'actor', 'system',
                             'purchase_order', 'PO-0032', 'source_ledger_id', '6daad5c0-2233-4e0f-8379-c8398ae60b81',
                             'reason', 'PO-0032: adjust_po_receipt posted +5.974 kg (data_ledger 6daad5c0) but hub_inventory numeric(10,2) stored +5.97; 082 added the lost 0.004 kg at zero cost after widening to 4dp. Row written by 083 because _append_data_ledger skips when auth.uid() is NULL.'));
END
$led$;
