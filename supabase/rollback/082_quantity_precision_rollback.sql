/*
  Rollback for 082. WARNING: narrowing back to 2dp ROUNDS any value written with 3-4 decimals since 082
  (e.g. the PO-0032 hub row 194.524 -> 194.52). Run only if 082 must be withdrawn; the correction ledger
  row stays as the audit trail and a reversal row is appended.
*/
DROP VIEW IF EXISTS public.recipe_variance_by_run;

ALTER TABLE public.hub_inventory
  ALTER COLUMN quantity_on_hand TYPE numeric(10,2),
  ALTER COLUMN reserved_quantity TYPE numeric(10,2),
  ALTER COLUMN available_quantity TYPE numeric(10,2);
ALTER TABLE public.hub_inventory_reservations
  ALTER COLUMN quantity TYPE numeric(12,2);
ALTER TABLE public.inventory_adjustments
  ALTER COLUMN adjusted_quantity TYPE numeric(10,2);
ALTER TABLE public.outlet_inventory
  ALTER COLUMN quantity_on_hand TYPE numeric(10,2),
  ALTER COLUMN reserved_quantity TYPE numeric(10,2),
  ALTER COLUMN available_quantity TYPE numeric(10,2);
ALTER TABLE public.supply_order_lines
  ALTER COLUMN quantity TYPE numeric(10,2);
ALTER TABLE public.supply_orders
  ALTER COLUMN total_quantity TYPE numeric(10,2);
ALTER TABLE public.raw_materials
  ALTER COLUMN cost_price TYPE numeric(12,2),
  ALTER COLUMN reorder_level TYPE numeric(10,2);
ALTER TABLE public.production_run_materials
  ALTER COLUMN quantity_consumed TYPE numeric(10,2);
ALTER TABLE public.production_runs
  ALTER COLUMN actual_output TYPE numeric(10,2),
  ALTER COLUMN planned_output TYPE numeric(10,2);
ALTER TABLE public.recipe_ingredients
  ALTER COLUMN quantity_required TYPE numeric(10,2);
ALTER TABLE public.recipes
  ALTER COLUMN standard_batch_size TYPE numeric(10,2);

CREATE VIEW public.recipe_variance_by_run AS
 SELECT pr.id AS production_run_id,
    pr.recipe_id,
    r.name AS recipe_name,
    pri.raw_material_id,
    rm.name AS raw_material_name,
    COALESCE(pri.quantity_required * (pr.actual_output / NULLIF(r.standard_batch_size, 0::numeric)), 0::numeric) AS theoretical_qty,
    COALESCE(prm.quantity_consumed, 0::numeric) AS actual_qty,
    COALESCE(prm.quantity_consumed, 0::numeric) - COALESCE(pri.quantity_required * (pr.actual_output / NULLIF(r.standard_batch_size, 0::numeric)), 0::numeric) AS variance_qty
   FROM production_runs pr
     JOIN recipes r ON r.id = pr.recipe_id
     JOIN recipe_ingredients pri ON pri.recipe_id = pr.recipe_id
     JOIN raw_materials rm ON rm.id = pri.raw_material_id
     LEFT JOIN production_run_materials prm ON prm.production_run_id = pr.id AND prm.raw_material_id = pri.raw_material_id
  WHERE pr.status <> 'cancelled'::text;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipe_variance_by_run TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.recipe_variance_by_run TO service_role;

DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM public.data_ledger WHERE action = 'receipt_rounding_corrected' AND entity_id = '5911121d-53a8-4333-9130-c126dc9601d6') THEN
    PERFORM public._append_data_ledger('receipt_rounding_correction_rolled_back', 'hub_inventory', '5911121d-53a8-4333-9130-c126dc9601d6', 'procurement', 'update',
      '697f67f8-03b3-4ac5-b3d9-2b16c0eb6fc9', NULL, (SELECT jsonb_build_object('quantity_on_hand', quantity_on_hand) FROM public.hub_inventory WHERE id = '5911121d-53a8-4333-9130-c126dc9601d6'),
      NULL, jsonb_build_object('rollback', '082', 'reason', 'column narrowed back to 2dp'));
  END IF;
END
$rb$;
