/*
  # Backfill outlet_stock_movements from historical transactional data
*/

-- Supply received
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  so.outlet_id,
  oi.id,
  'supply_in',
  sol.quantity,
  COALESCE(so.received_date, so.dispatch_date, so.supply_date, so.created_at::date),
  'supply_order',
  so.id,
  jsonb_build_object('source', 'backfill', 'supply_order_line_id', sol.id),
  COALESCE(so.updated_at, so.created_at)
FROM public.supply_orders so
JOIN public.supply_order_lines sol ON sol.supply_order_id = so.id
JOIN public.hub_inventory hi ON hi.id = sol.hub_inventory_id
JOIN public.outlet_inventory oi ON oi.outlet_id = so.outlet_id
  AND (
    (hi.raw_material_id IS NOT NULL AND oi.raw_material_id = hi.raw_material_id)
    OR (
      hi.raw_material_id IS NULL
      AND oi.raw_material_id IS NULL
      AND trim(both from oi.product_batch) = trim(both from COALESCE(sol.product_batch, hi.product_batch))
      AND (oi.lot_id IS NOT DISTINCT FROM hi.lot_id)
    )
  )
WHERE lower(trim(so.status::text)) = 'received'
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'supply_order' AND m.reference_id = so.id
      AND m.outlet_inventory_id = oi.id AND m.metadata->>'source' = 'backfill'
  );

-- Outlet transfer in
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  ot.to_outlet_id,
  oi.id,
  'transfer_in',
  otl.quantity,
  COALESCE(ot.received_date, ot.dispatch_date, ot.created_at::date),
  'outlet_transfer',
  ot.id,
  jsonb_build_object('source', 'backfill'),
  COALESCE(ot.updated_at, ot.created_at)
FROM public.outlet_transfers ot
JOIN public.outlet_transfer_lines otl ON otl.outlet_transfer_id = ot.id
JOIN public.outlet_inventory oi ON oi.outlet_id = ot.to_outlet_id
  AND trim(both from oi.product_batch) = trim(both from otl.product_batch)
  AND (oi.lot_id IS NOT DISTINCT FROM otl.lot_id)
WHERE lower(trim(ot.status::text)) = 'received'
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'outlet_transfer' AND m.reference_id = ot.id AND m.metadata->>'source' = 'backfill'
  );

-- Outlet transfer out
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  ot.from_outlet_id,
  otl.source_outlet_inventory_id,
  'transfer_out',
  -otl.quantity,
  COALESCE(ot.dispatch_date, ot.created_at::date),
  'outlet_transfer',
  ot.id,
  jsonb_build_object('source', 'backfill'),
  COALESCE(ot.updated_at, ot.created_at)
FROM public.outlet_transfers ot
JOIN public.outlet_transfer_lines otl ON otl.outlet_transfer_id = ot.id
WHERE lower(trim(ot.status::text)) IN ('dispatched', 'received')
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'outlet_transfer' AND m.reference_id = ot.id
      AND m.movement_type = 'transfer_out' AND m.metadata->>'source' = 'backfill'
  );

-- Sales
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  sj.outlet_id,
  COALESCE(sjl.outlet_inventory_id, oi.id),
  'sale',
  -sjl.quantity_sold,
  sj.business_date,
  'sales_journal',
  sj.id,
  jsonb_build_object('source', 'backfill', 'product_batch', sjl.product_batch),
  sj.created_at
FROM public.sales_journals sj
JOIN public.sales_journal_lines sjl ON sjl.sales_journal_id = sj.id
LEFT JOIN public.outlet_inventory oi ON oi.outlet_id = sj.outlet_id
  AND sjl.outlet_inventory_id IS NULL
  AND trim(both from oi.product_batch) = trim(both from sjl.product_batch)
WHERE lower(trim(sj.status::text)) = 'posted'
  AND COALESCE(sjl.outlet_inventory_id, oi.id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'sales_journal' AND m.reference_id = sj.id AND m.metadata->>'source' = 'backfill'
  );

-- Waste (outlet)
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  we.outlet_id,
  oi.id,
  'waste',
  -wl.quantity,
  we.waste_date,
  'waste_event',
  we.id,
  jsonb_build_object('source', 'backfill', 'product_batch', wl.product_batch),
  we.created_at
FROM public.waste_events we
JOIN public.waste_lines wl ON wl.waste_event_id = we.id
JOIN public.outlet_inventory oi ON oi.outlet_id = we.outlet_id
  AND trim(both from oi.product_batch) = trim(both from wl.product_batch)
WHERE we.location_kind = 'outlet'
  AND lower(trim(we.status::text)) = 'posted'
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'waste_event' AND m.reference_id = we.id AND m.metadata->>'source' = 'backfill'
  );

-- Stock take adjustments
INSERT INTO public.outlet_stock_movements (
  outlet_id, outlet_inventory_id, movement_type, signed_qty, business_date,
  reference_type, reference_id, metadata, created_at
)
SELECT
  sts.outlet_id,
  stl.outlet_inventory_id,
  'stock_take',
  stl.variance,
  sts.count_date,
  'outlet_stock_take',
  sts.id,
  jsonb_build_object(
    'source', 'backfill',
    'system_qoh_before', stl.system_qoh_before,
    'counted_qty', stl.counted_qty
  ),
  sts.posted_at
FROM public.outlet_stock_take_sessions sts
JOIN public.outlet_stock_take_lines stl ON stl.session_id = sts.id
WHERE stl.variance <> 0
  AND NOT EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
    WHERE m.reference_type = 'outlet_stock_take' AND m.reference_id = sts.id
      AND m.outlet_inventory_id = stl.outlet_inventory_id AND m.metadata->>'source' = 'backfill'
  );
