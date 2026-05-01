/*
  Intelligence + backlog: production capacity/planning, supplier scorecards,
  PAR targets, recipe variance view, QC observations.
*/

CREATE TABLE IF NOT EXISTS public.production_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  daily_capacity_units numeric(14, 4) NOT NULL CHECK (daily_capacity_units > 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.planned_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  resource_id uuid REFERENCES public.production_resources(id) ON DELETE SET NULL,
  planned_start timestamptz NOT NULL,
  planned_quantity numeric(14, 4) NOT NULL CHECK (planned_quantity > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'released', 'cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.production_runs
  ADD COLUMN IF NOT EXISTS planned_batch_id uuid REFERENCES public.planned_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_planned_batches_start ON public.planned_batches(planned_start);
CREATE INDEX IF NOT EXISTS idx_production_runs_planned ON public.production_runs(planned_batch_id);

ALTER TABLE public.production_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planned_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view production_resources"
  ON public.production_resources FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage production_resources"
  ON public.production_resources FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

CREATE POLICY "Authenticated users can view planned_batches"
  ON public.planned_batches FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage planned_batches"
  ON public.planned_batches FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

CREATE OR REPLACE VIEW public.supplier_scorecard_metrics AS
SELECT
  s.id AS supplier_id,
  s.name AS supplier_name,
  COUNT(po.id) FILTER (WHERE po.status IN ('received', 'partial')) AS completed_orders,
  AVG(
    CASE
      WHEN po.expected_delivery_date IS NOT NULL AND po.actual_delivery_date IS NOT NULL
        AND po.actual_delivery_date <= po.expected_delivery_date
      THEN 1::numeric
      WHEN po.expected_delivery_date IS NOT NULL AND po.actual_delivery_date IS NOT NULL
      THEN 0::numeric
      ELSE NULL::numeric
    END
  ) AS otif_rate,
  AVG(
    CASE
      WHEN poi.quantity_ordered > 0
      THEN poi.quantity_received / poi.quantity_ordered
      ELSE NULL::numeric
    END
  ) AS avg_fill_rate
FROM public.suppliers s
LEFT JOIN public.purchase_orders po ON po.supplier_id = s.id
LEFT JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
GROUP BY s.id, s.name;

GRANT SELECT ON public.supplier_scorecard_metrics TO authenticated;

CREATE TABLE IF NOT EXISTS public.outlet_par (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES public.outlets(id) ON DELETE CASCADE,
  par_key text NOT NULL DEFAULT '*',
  target_qty numeric(14, 4) NOT NULL CHECK (target_qty >= 0),
  safety_stock numeric(14, 4) NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, par_key)
);

ALTER TABLE public.outlet_par ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view outlet_par"
  ON public.outlet_par FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage outlet_par"
  ON public.outlet_par FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

CREATE TABLE IF NOT EXISTS public.production_qc_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_run_id uuid NOT NULL REFERENCES public.production_runs(id) ON DELETE CASCADE,
  check_name text NOT NULL,
  passed boolean NOT NULL DEFAULT true,
  notes text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_qc_run ON public.production_qc_observations(production_run_id);

ALTER TABLE public.production_qc_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view production_qc_observations"
  ON public.production_qc_observations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert production_qc_observations"
  ON public.production_qc_observations FOR INSERT TO authenticated
  WITH CHECK (recorded_by = auth.uid());

CREATE POLICY "Admins can delete production_qc_observations"
  ON public.production_qc_observations FOR DELETE TO authenticated
  USING (public.is_profiles_admin());

CREATE OR REPLACE VIEW public.recipe_variance_by_run AS
SELECT
  pr.id AS production_run_id,
  pr.recipe_id,
  r.name AS recipe_name,
  pri.raw_material_id,
  rm.name AS raw_material_name,
  COALESCE(pri.quantity_required * (pr.actual_output / NULLIF(r.standard_batch_size, 0)), 0) AS theoretical_qty,
  COALESCE(prm.quantity_consumed, 0) AS actual_qty,
  COALESCE(prm.quantity_consumed, 0)
    - COALESCE(pri.quantity_required * (pr.actual_output / NULLIF(r.standard_batch_size, 0)), 0) AS variance_qty
FROM public.production_runs pr
JOIN public.recipes r ON r.id = pr.recipe_id
JOIN public.recipe_ingredients pri ON pri.recipe_id = pr.recipe_id
JOIN public.raw_materials rm ON rm.id = pri.raw_material_id
LEFT JOIN public.production_run_materials prm
  ON prm.production_run_id = pr.id AND prm.raw_material_id = pri.raw_material_id
WHERE pr.status <> 'cancelled';

GRANT SELECT ON public.recipe_variance_by_run TO authenticated;
