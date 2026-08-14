/*
  Backfill printable FG lot labels for completed (and voided) production runs
  that were posted before lot creation existed.

  Label format: SKU-YYMMDD-RUN  e.g. QUACKTEOW-260812-0082
  Links existing hub, outlet, and sales rows that still use legacy BATCH-<uuid>.
*/

UPDATE public.recipes r
SET
  default_product_batch = public.normalize_fg_sku(r.name),
  updated_at = now()
WHERE r.default_product_batch IS NULL
   OR trim(both from r.default_product_batch) = '';

INSERT INTO public.inventory_lots (
  product_batch_label,
  manufactured_at,
  production_run_id,
  expiry_date,
  created_at,
  updated_at
)
SELECT
  public.format_fg_lot_label(
    COALESCE(
      public.normalize_fg_sku(r.default_product_batch),
      public.normalize_fg_sku(r.name),
      'FG'
    ),
    pr.production_date,
    pr.run_number
  ),
  pr.production_date::timestamptz,
  pr.id,
  CASE
    WHEN r.shelf_life_days IS NOT NULL AND r.shelf_life_days > 0
      THEN pr.production_date + r.shelf_life_days
    ELSE NULL
  END,
  COALESCE(pr.created_at, now()),
  now()
FROM public.production_runs pr
JOIN public.recipes r ON r.id = pr.recipe_id
WHERE pr.status IN ('completed', 'voided')
  AND NOT EXISTS (
    SELECT 1
    FROM public.inventory_lots il
    WHERE il.production_run_id = pr.id
  )
ON CONFLICT (product_batch_label) DO NOTHING;

UPDATE public.hub_inventory hi
SET
  lot_id = il.id,
  updated_at = now()
FROM public.inventory_lots il
JOIN public.production_runs pr ON pr.id = il.production_run_id
WHERE hi.lot_id IS NULL
  AND hi.raw_material_id IS NULL
  AND hi.product_batch = 'BATCH-' || split_part(pr.id::text, '-', 1);

UPDATE public.outlet_inventory oi
SET
  lot_id = il.id,
  updated_at = now()
FROM public.inventory_lots il
JOIN public.production_runs pr ON pr.id = il.production_run_id
WHERE oi.lot_id IS NULL
  AND oi.raw_material_id IS NULL
  AND oi.product_batch = 'BATCH-' || split_part(pr.id::text, '-', 1);

UPDATE public.sales_journal_lines sjl
SET lot_id = il.id
FROM public.inventory_lots il
JOIN public.production_runs pr ON pr.id = il.production_run_id
WHERE sjl.lot_id IS NULL
  AND sjl.product_batch = 'BATCH-' || split_part(pr.id::text, '-', 1);
