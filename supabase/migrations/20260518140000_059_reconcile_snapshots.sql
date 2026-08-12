/*
  # reconcile_outlet_stock, outlet_inventory_snapshots, get_outlet_balance_as_of
*/

-- ---------------------------------------------------------------------------
-- Snapshots table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outlet_inventory_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES public.outlets(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  snapshot_type text NOT NULL CHECK (snapshot_type IN ('daily', 'post_stock_take', 'manual')),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, snapshot_date, snapshot_type)
);

CREATE INDEX IF NOT EXISTS idx_ois_outlet_date ON public.outlet_inventory_snapshots (outlet_id, snapshot_date DESC);

ALTER TABLE public.outlet_inventory_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin view outlet inventory snapshots"
  ON public.outlet_inventory_snapshots FOR SELECT TO authenticated
  USING (public.is_profiles_admin());

CREATE POLICY "Supervisor view snapshots for assigned outlet"
  ON public.outlet_inventory_snapshots FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id = outlet_inventory_snapshots.outlet_id
    )
  );

CREATE POLICY "Staff view outlet inventory snapshots"
  ON public.outlet_inventory_snapshots FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());

-- ---------------------------------------------------------------------------
-- snapshot_outlet_inventory — capture current rows for one outlet
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.snapshot_outlet_inventory(
  p_outlet_id uuid,
  p_snapshot_date date DEFAULT CURRENT_DATE,
  p_snapshot_type text DEFAULT 'manual'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_lines jsonb;
BEGIN
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'outlet_inventory_id', oi.id,
        'product_batch', oi.product_batch,
        'raw_material_id', oi.raw_material_id,
        'quantity_on_hand', oi.quantity_on_hand,
        'reserved_quantity', COALESCE(oi.reserved_quantity, 0),
        'available_quantity', oi.available_quantity
      )
      ORDER BY oi.id
    ),
    '[]'::jsonb
  )
  INTO v_lines
  FROM public.outlet_inventory oi
  WHERE oi.outlet_id = p_outlet_id;

  INSERT INTO public.outlet_inventory_snapshots (outlet_id, snapshot_date, snapshot_type, lines)
  VALUES (p_outlet_id, p_snapshot_date, p_snapshot_type, v_lines)
  ON CONFLICT (outlet_id, snapshot_date, snapshot_type)
  DO UPDATE SET lines = EXCLUDED.lines, created_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Daily snapshot for all outlets (schedule via Supabase cron or external job)
CREATE OR REPLACE FUNCTION public.snapshot_all_outlets_daily()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_outlet uuid;
  v_count integer := 0;
BEGIN
  FOR v_outlet IN SELECT id FROM public.outlets ORDER BY name
  LOOP
    PERFORM public.snapshot_outlet_inventory(v_outlet, CURRENT_DATE, 'daily');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- reconcile_outlet_stock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_outlet_stock(
  p_outlet_id uuid,
  p_from date,
  p_to date,
  p_include_raw_materials boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- ---------------------------------------------------------------------------
-- get_outlet_balance_as_of
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_outlet_balance_as_of(
  p_outlet_id uuid,
  p_as_of date,
  p_include_raw_materials boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- Hook post_stock_take snapshot after stock take (replace post_outlet_stock_take tail)
CREATE OR REPLACE FUNCTION public._post_stock_take_snapshot_hook(p_outlet_id uuid, p_count_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.snapshot_outlet_inventory(p_outlet_id, COALESCE(p_count_date, CURRENT_DATE), 'post_stock_take');
END;
$$;

REVOKE ALL ON FUNCTION public.snapshot_outlet_inventory(uuid, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.snapshot_outlet_inventory(uuid, date, text) TO authenticated;
REVOKE ALL ON FUNCTION public.snapshot_all_outlets_daily() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.snapshot_all_outlets_daily() TO authenticated;
REVOKE ALL ON FUNCTION public.reconcile_outlet_stock(uuid, date, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_outlet_stock(uuid, date, date, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.get_outlet_balance_as_of(uuid, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_outlet_balance_as_of(uuid, date, boolean) TO authenticated;
