/*
  082 — Quantity / cost precision to 4dp (forward-only; values are only widened, never rounded).

  Widens 17 live columns to numeric(14,4) (from numeric(10,2) / numeric(12,2)):
    hub_inventory.quantity_on_hand / reserved_quantity / available_quantity
    hub_inventory_reservations.quantity
    inventory_adjustments.adjusted_quantity
    outlet_inventory.quantity_on_hand / reserved_quantity / available_quantity
    supply_order_lines.quantity, supply_orders.total_quantity
    raw_materials.cost_price, raw_materials.reorder_level
    production_run_materials.quantity_consumed
    production_runs.actual_output / planned_output
    recipe_ingredients.quantity_required, recipes.standard_batch_size
  Left at 2dp by design: money totals (purchase_order_items.line_total, purchase_orders.total_amount)
  and percentages/settings (yield %, qc_audit_settings, procurement_settings tolerance).

  Dependent view recipe_variance_by_run (reads quantity_consumed, actual_output, quantity_required,
  standard_batch_size) is dropped and recreated with the same definition and grants.
  No function DECLARE / OUT / RETURNS TABLE uses numeric(10,2) or numeric(12,2) (checked live), so no
  function bodies change. ALTER TYPE takes ACCESS EXCLUSIVE and rewrites the tables: apply outside trading.

  Data correction (guarded, idempotent): PO-0032 G-1.0KG hub row was stored as 194.52 by the 2dp column
  after adjust_po_receipt posted +5.974 (data_ledger 6daad5c0-2233-4e0f-8379-c8398ae60b81). Add the lost 0.004 kg
  with its own data_ledger row. weighted_avg_unit_cost (2.9079) already reflects 194.524 and is not touched.

  Rollback: supabase/rollback/082_quantity_precision_rollback.sql
*/

DROP VIEW IF EXISTS public.recipe_variance_by_run;

ALTER TABLE public.hub_inventory
  ALTER COLUMN quantity_on_hand TYPE numeric(14,4),
  ALTER COLUMN reserved_quantity TYPE numeric(14,4),
  ALTER COLUMN available_quantity TYPE numeric(14,4);
ALTER TABLE public.hub_inventory_reservations
  ALTER COLUMN quantity TYPE numeric(14,4);
ALTER TABLE public.inventory_adjustments
  ALTER COLUMN adjusted_quantity TYPE numeric(14,4);
ALTER TABLE public.outlet_inventory
  ALTER COLUMN quantity_on_hand TYPE numeric(14,4),
  ALTER COLUMN reserved_quantity TYPE numeric(14,4),
  ALTER COLUMN available_quantity TYPE numeric(14,4);
ALTER TABLE public.supply_order_lines
  ALTER COLUMN quantity TYPE numeric(14,4);
ALTER TABLE public.supply_orders
  ALTER COLUMN total_quantity TYPE numeric(14,4);
ALTER TABLE public.raw_materials
  ALTER COLUMN cost_price TYPE numeric(14,4),
  ALTER COLUMN reorder_level TYPE numeric(14,4);
ALTER TABLE public.production_run_materials
  ALTER COLUMN quantity_consumed TYPE numeric(14,4);
ALTER TABLE public.production_runs
  ALTER COLUMN actual_output TYPE numeric(14,4),
  ALTER COLUMN planned_output TYPE numeric(14,4);
ALTER TABLE public.recipe_ingredients
  ALTER COLUMN quantity_required TYPE numeric(14,4);
ALTER TABLE public.recipes
  ALTER COLUMN standard_batch_size TYPE numeric(14,4);

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

-- PO-0032 rounding correction ---------------------------------------------------------
DO $corr$
DECLARE
  v_qoh numeric; v_avail numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.data_ledger WHERE id::text = '6daad5c0-2233-4e0f-8379-c8398ae60b81') THEN
    RAISE NOTICE '082: PO-0032 source ledger row not present; correction skipped';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.data_ledger WHERE action = 'receipt_rounding_corrected'
             AND entity_id = '5911121d-53a8-4333-9130-c126dc9601d6') THEN
    RAISE NOTICE '082: PO-0032 correction already applied; skipped';
    RETURN;
  END IF;
  SELECT quantity_on_hand, available_quantity INTO v_qoh, v_avail
  FROM public.hub_inventory WHERE id = '5911121d-53a8-4333-9130-c126dc9601d6' AND raw_material_id = 'bdf24c4e-34ca-4d77-a2dd-29147a7aa05a' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '082: PO-0032 hub row 5911121d-53a8-4333-9130-c126dc9601d6 not found';
  END IF;

  UPDATE public.hub_inventory
     SET quantity_on_hand = quantity_on_hand + 0.004,
         available_quantity = available_quantity + 0.004,
         last_updated = now(), updated_at = now()
   WHERE id = '5911121d-53a8-4333-9130-c126dc9601d6';

  PERFORM public._append_data_ledger(
    'receipt_rounding_corrected', 'hub_inventory', '5911121d-53a8-4333-9130-c126dc9601d6', 'procurement', 'update', '697f67f8-03b3-4ac5-b3d9-2b16c0eb6fc9',
    jsonb_build_object('quantity_on_hand', v_qoh, 'available_quantity', v_avail),
    jsonb_build_object('quantity_on_hand', v_qoh + 0.004, 'available_quantity', v_avail + 0.004),
    jsonb_build_object('posted_delta', 0.004, 'raw_material_id', 'bdf24c4e-34ca-4d77-a2dd-29147a7aa05a', 'purchase_order_id', '5a69321e-ca06-4887-8b9b-67f099bc3209',
                       'source_ledger_id', '6daad5c0-2233-4e0f-8379-c8398ae60b81', 'value_delta', 0),
    jsonb_build_object('migration', '082', 'reason',
      'PO-0032: adjust_po_receipt posted +5.974 kg (data_ledger 6daad5c0) but hub_inventory numeric(10,2) stored +5.97; adding the lost 0.004 kg at zero cost after widening to 4dp'));
END
$corr$;
