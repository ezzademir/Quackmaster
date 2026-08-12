/*
  stock_take_settings — variance threshold for dual-count workflow
  reconcile_outlet_stock_by_sku — per product_batch / raw_material movement equation
*/

CREATE TABLE IF NOT EXISTS public.stock_take_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  variance_threshold numeric(14, 4) NOT NULL DEFAULT 5 CHECK (variance_threshold >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.stock_take_settings (id, variance_threshold)
VALUES (1, 5)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.stock_take_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view stock_take_settings" ON public.stock_take_settings;
CREATE POLICY "Authenticated users can view stock_take_settings"
  ON public.stock_take_settings FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins can manage stock_take_settings" ON public.stock_take_settings;
CREATE POLICY "Admins can manage stock_take_settings"
  ON public.stock_take_settings FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

-- ---------------------------------------------------------------------------
-- Per-SKU / material reconcile
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_outlet_stock_by_sku(
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
    SELECT
      oi.id AS outlet_inventory_id,
      oi.raw_material_id,
      NULLIF(trim(both from oi.product_batch), '') AS product_batch,
      COALESCE(rm.name, NULLIF(trim(both from oi.product_batch), ''), oi.id::text) AS label,
      CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END AS kind,
      CASE
        WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
        ELSE 'fg:' || COALESCE(NULLIF(trim(both from oi.product_batch), ''), oi.id::text)
      END AS sku_key,
      oi.quantity_on_hand
    FROM public.outlet_inventory oi
    LEFT JOIN public.raw_materials rm ON rm.id = oi.raw_material_id
    WHERE oi.outlet_id = p_outlet_id
      AND (p_include_raw_materials OR oi.raw_material_id IS NULL)
  LOOP
    NULL; -- aggregate in second pass by sku_key
  END LOOP;

  FOR r IN
    WITH keys AS (
      SELECT DISTINCT
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
          ELSE 'fg:' || COALESCE(NULLIF(trim(both from oi.product_batch), ''), oi.id::text)
        END AS sku_key,
        CASE WHEN oi.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END AS kind,
        COALESCE(MAX(rm.name), MAX(NULLIF(trim(both from oi.product_batch), '')), '—') AS label,
        oi.raw_material_id,
        NULLIF(trim(both from MAX(oi.product_batch)), '') AS product_batch
      FROM public.outlet_inventory oi
      LEFT JOIN public.raw_materials rm ON rm.id = oi.raw_material_id
      WHERE oi.outlet_id = p_outlet_id
        AND (p_include_raw_materials OR oi.raw_material_id IS NULL)
      GROUP BY
        CASE
          WHEN oi.raw_material_id IS NOT NULL THEN 'rm:' || oi.raw_material_id::text
          ELSE 'fg:' || COALESCE(NULLIF(trim(both from oi.product_batch), ''), oi.id::text)
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
        OR (r.kind = 'fg' AND NULLIF(trim(both from oi.product_batch), '') IS NOT DISTINCT FROM r.product_batch
            AND oi.raw_material_id IS NULL)
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
        OR (r.kind = 'fg' AND NULLIF(trim(both from oi.product_batch), '') IS NOT DISTINCT FROM r.product_batch
            AND oi.raw_material_id IS NULL)
      );

    SELECT COALESCE(SUM(oi.quantity_on_hand), 0)
    INTO v_live
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = p_outlet_id
      AND (
        (r.kind = 'rm' AND oi.raw_material_id = r.raw_material_id)
        OR (r.kind = 'fg' AND NULLIF(trim(both from oi.product_batch), '') IS NOT DISTINCT FROM r.product_batch
            AND oi.raw_material_id IS NULL)
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
$$;

REVOKE ALL ON FUNCTION public.reconcile_outlet_stock_by_sku(uuid, date, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_outlet_stock_by_sku(uuid, date, date, boolean) TO authenticated;
