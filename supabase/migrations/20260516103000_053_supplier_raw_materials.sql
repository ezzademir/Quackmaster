/*
  Junction catalog: which raw materials each supplier can supply (for PO line filtering).
  RLS mirrors other ERP tables: authenticated read; admin insert/update/delete.
*/

CREATE TABLE IF NOT EXISTS public.supplier_raw_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT supplier_raw_materials_supplier_raw_unique UNIQUE (supplier_id, raw_material_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_raw_materials_supplier_id
  ON public.supplier_raw_materials(supplier_id);

CREATE INDEX IF NOT EXISTS idx_supplier_raw_materials_raw_material_id
  ON public.supplier_raw_materials(raw_material_id);

ALTER TABLE public.supplier_raw_materials ENABLE ROW LEVEL SECURITY;

-- Reset RLS policies idempotently: remote DBs may already have these names from a
-- partial apply or manual SQL, while CREATE POLICY is not IF NOT EXISTS.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'supplier_raw_materials'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.supplier_raw_materials', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can view supplier_raw_materials"
  ON public.supplier_raw_materials FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can create supplier_raw_materials"
  ON public.supplier_raw_materials FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

CREATE POLICY "Admins can update supplier_raw_materials"
  ON public.supplier_raw_materials FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

CREATE POLICY "Admins can delete supplier_raw_materials"
  ON public.supplier_raw_materials FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

COMMENT ON TABLE public.supplier_raw_materials IS 'Raw materials linked to suppliers for procurement catalog filtering.';

INSERT INTO public.supplier_raw_materials (supplier_id, raw_material_id)
SELECT DISTINCT po.supplier_id, poi.raw_material_id
FROM public.purchase_order_items poi
JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
WHERE po.supplier_id IS NOT NULL
  AND poi.raw_material_id IS NOT NULL
ON CONFLICT (supplier_id, raw_material_id) DO NOTHING;
