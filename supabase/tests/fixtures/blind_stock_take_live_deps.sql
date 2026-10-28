-- Live (pre-080) definitions captured from production 19 Oct 2026 (read-only), used by tests.

CREATE OR REPLACE FUNCTION public.reconcile_outlet_stock(p_outlet_id uuid, p_from date, p_to date, p_include_raw_materials boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_opening numeric := 0;
  v_live numeric := 0;
  v_supply_in numeric := 0;
  v_transfers_in numeric := 0;
  v_transfers_out numeric := 0;
  v_sales numeric := 0;
  v_waste numeric := 0;
  v_stock_take numeric := 0;
  v_reversals numeric := 0;
  v_computed numeric;
  v_in_transit_supply numeric := 0;
  v_in_transit_transfer numeric := 0;
  v_last_stock_take jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- Opening: sum movements before p_from (or snapshot if available)
  SELECT COALESCE(SUM(osm.signed_qty), 0)
  INTO v_opening
  FROM public.outlet_stock_movements osm
  JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
  WHERE osm.outlet_id = p_outlet_id
    AND osm.business_date < p_from
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  -- Period buckets
  SELECT
    COALESCE(SUM(CASE WHEN osm.movement_type = 'supply_in' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_in' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_out' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'sale' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'waste' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type = 'stock_take' THEN osm.signed_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN osm.movement_type IN ('reversal', 'admin_adjust') THEN osm.signed_qty ELSE 0 END), 0)
  INTO v_supply_in, v_transfers_in, v_transfers_out, v_sales, v_waste, v_stock_take, v_reversals
  FROM public.outlet_stock_movements osm
  JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
  WHERE osm.outlet_id = p_outlet_id
    AND osm.business_date >= p_from
    AND osm.business_date <= p_to
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
  INTO v_live
  FROM public.outlet_inventory oi
  WHERE oi.outlet_id = p_outlet_id
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  v_computed := v_opening + v_supply_in + v_transfers_in + v_transfers_out + v_sales + v_waste + v_stock_take + v_reversals;

  SELECT COALESCE(SUM(so.total_quantity), 0)
  INTO v_in_transit_supply
  FROM public.supply_orders so
  WHERE so.outlet_id = p_outlet_id
    AND lower(trim(so.status::text)) = 'dispatched';

  SELECT COALESCE(SUM(ot.total_quantity), 0)
  INTO v_in_transit_transfer
  FROM public.outlet_transfers ot
  WHERE ot.to_outlet_id = p_outlet_id
    AND lower(trim(ot.status::text)) = 'dispatched';

  SELECT jsonb_build_object(
    'session_id', sts.id,
    'count_date', sts.count_date,
    'total_variance', COALESCE(SUM(stl.variance), 0)
  )
  INTO v_last_stock_take
  FROM public.outlet_stock_take_sessions sts
  LEFT JOIN public.outlet_stock_take_lines stl ON stl.session_id = sts.id
  WHERE sts.outlet_id = p_outlet_id
  GROUP BY sts.id, sts.count_date, sts.posted_at
  ORDER BY sts.posted_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'outlet_id', p_outlet_id,
    'period_from', p_from,
    'period_to', p_to,
    'include_raw_materials', p_include_raw_materials,
    'opening_qoh', v_opening,
    'supply_in', v_supply_in,
    'transfers_in', v_transfers_in,
    'transfers_out', v_transfers_out,
    'sales', v_sales,
    'waste', v_waste,
    'stock_take_adjustments', v_stock_take,
    'reversals', v_reversals,
    'computed_closing', v_computed,
    'live_on_hand', v_live,
    'unexplained_variance', v_live - v_computed,
    'in_transit_supply', v_in_transit_supply,
    'in_transit_transfer', v_in_transit_transfer,
    'last_stock_take', COALESCE(v_last_stock_take, 'null'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_outlet_stock_by_sku(p_outlet_id uuid, p_from date, p_to date, p_include_raw_materials boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows jsonb := '[]'::jsonb;
  r RECORD;
  v_opening numeric;
  v_supply_in numeric;
  v_transfers_in numeric;
  v_transfers_out numeric;
  v_sales numeric;
  v_waste numeric;
  v_stock_take numeric;
  v_reversals numeric;
  v_computed numeric;
  v_live numeric;
  v_key text;
  v_label text;
  v_kind text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  FOR r IN
    WITH keys AS (
      SELECT DISTINCT
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
          ELSE 'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        END AS sku_key,
        CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END AS kind,
        COALESCE(
          MAX(rm.name),
          MAX(NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), '')),
          MAX(
            CASE
              WHEN oi.product_batch ~* '^BATCH-[0-9a-f-]+$' THEN NULL
              ELSE NULLIF(trim(both from oi.product_batch), '')
            END
          ),
          '—'
        ) AS label,
        oi.raw_material_id,
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN NULL
          ELSE COALESCE(
            NULLIF(trim(both from MAX(public.fg_recipe_sku(oi.lot_id))), ''),
            MAX(
              CASE
                WHEN oi.product_batch ~* '^BATCH-[0-9a-f-]+$' THEN NULL
                ELSE NULLIF(trim(both from oi.product_batch), '')
              END
            )
          )
        END AS product_batch
      FROM public.outlet_inventory oi
      LEFT JOIN public.raw_materials rm ON rm.id = oi.raw_material_id
      WHERE oi.outlet_id = p_outlet_id
        AND (p_include_raw_materials OR oi.raw_material_id IS NULL)
      GROUP BY
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
          ELSE 'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        END,
        CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END,
        oi.raw_material_id
    )
    SELECT * FROM keys ORDER BY label
  LOOP
    v_key := r.sku_key;
    v_label := r.label;
    v_kind := r.kind;

    SELECT COALESCE(SUM(osm.signed_qty), 0)
    INTO v_opening
    FROM public.outlet_stock_movements osm
    JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
    WHERE osm.outlet_id = p_outlet_id
      AND osm.business_date < p_from
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT
      COALESCE(SUM(CASE WHEN osm.movement_type = 'supply_in' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_in' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'transfer_out' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'sale' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'waste' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type = 'stock_take' THEN osm.signed_qty ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN osm.movement_type IN ('reversal', 'admin_adjust') THEN osm.signed_qty ELSE 0 END), 0)
    INTO v_supply_in, v_transfers_in, v_transfers_out, v_sales, v_waste, v_stock_take, v_reversals
    FROM public.outlet_stock_movements osm
    JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
    WHERE osm.outlet_id = p_outlet_id
      AND osm.business_date >= p_from
      AND osm.business_date <= p_to
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
    INTO v_live
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = p_outlet_id
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND oi.raw_material_id IS NULL AND (
          'fg:' || COALESCE(
            NULLIF(trim(both from public.fg_recipe_sku(oi.lot_id)), ''),
            NULLIF(trim(both from oi.product_batch), ''),
            oi.id::text
          )
        ) = r.sku_key)
      );

    v_computed := v_opening + v_supply_in + v_transfers_in + v_transfers_out + v_sales + v_waste + v_stock_take + v_reversals;

    v_rows := v_rows || jsonb_build_array(
      jsonb_build_object(
        'sku_key', v_key,
        'kind', v_kind,
        'label', v_label,
        'raw_material_id', r.raw_material_id,
        'product_batch', r.product_batch,
        'opening_qoh', v_opening,
        'supply_in', v_supply_in,
        'transfers_in', v_transfers_in,
        'transfers_out', v_transfers_out,
        'sales', v_sales,
        'waste', v_waste,
        'stock_take_adjustments', v_stock_take,
        'reversals', v_reversals,
        'computed_closing', v_computed,
        'live_on_hand', v_live,
        'unexplained_variance', v_live - v_computed
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'outlet_id', p_outlet_id,
    'period_from', p_from,
    'period_to', p_to,
    'rows', v_rows
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_outlet_balance_as_of(p_outlet_id uuid, p_as_of date, p_include_raw_materials boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_snapshot_date date;
  v_base numeric := 0;
  v_delta numeric := 0;
  v_lines jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT s.snapshot_date, s.lines
  INTO v_snapshot_date, v_snapshot
  FROM public.outlet_inventory_snapshots s
  WHERE s.outlet_id = p_outlet_id AND s.snapshot_date <= p_as_of
  ORDER BY s.snapshot_date DESC, s.created_at DESC
  LIMIT 1;

  IF v_snapshot IS NOT NULL THEN
    SELECT COALESCE(SUM((elem->>'quantity_on_hand')::numeric), 0)
    INTO v_base
    FROM jsonb_array_elements(v_snapshot) elem
    WHERE p_include_raw_materials OR (elem->>'raw_material_id') IS NULL;
  END IF;

  SELECT COALESCE(SUM(osm.signed_qty), 0)
  INTO v_delta
  FROM public.outlet_stock_movements osm
  JOIN public.outlet_inventory oi ON oi.id = osm.outlet_inventory_id
  WHERE osm.outlet_id = p_outlet_id
    AND osm.business_date > COALESCE(v_snapshot_date, '1900-01-01'::date)
    AND osm.business_date <= p_as_of
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'outlet_inventory_id', oi.id,
        'product_batch', oi.product_batch,
        'raw_material_id', oi.raw_material_id,
        'quantity_on_hand', oi.quantity_on_hand
      )
      ORDER BY oi.id
    ),
    '[]'::jsonb
  )
  INTO v_lines
  FROM public.outlet_inventory oi
  WHERE oi.outlet_id = p_outlet_id
    AND (p_include_raw_materials OR oi.raw_material_id IS NULL);

  RETURN jsonb_build_object(
    'success', true,
    'outlet_id', p_outlet_id,
    'as_of', p_as_of,
    'snapshot_date', v_snapshot_date,
    'total_on_hand', v_base + v_delta,
    'from_snapshot_base', v_base,
    'movements_delta', v_delta,
    'current_live_lines', v_lines
  );
END;
$function$;

-- Live auth helpers (unchanged by 078-080).

CREATE OR REPLACE FUNCTION public.is_authenticated_active_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin', 'staff')
      AND p.is_active
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_supervisor_for_outlet(p_outlet_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_outlet_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND lower(trim(p.role::text)) = 'supervisor'
      AND p.assigned_outlet_id IS NOT NULL
      AND p.assigned_outlet_id = p_outlet_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.profile_can_post_outlet_stock_take(p_outlet_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_outlet_id IS NULL THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_active
        AND lower(trim(p.role::text)) IN ('admin', 'staff')
    ) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_active
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND p.assigned_outlet_id = p_outlet_id
    ) THEN true
    ELSE false
  END;
$function$;
