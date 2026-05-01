/*
  Compliance slice (foundation): inventory_lots + optional lot_id on hub/outlet rows,
  document_links, Storage bucket erp_documents + policies.
*/

CREATE TABLE IF NOT EXISTS public.inventory_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_batch_label text NOT NULL,
  expiry_date date,
  manufactured_at timestamptz,
  parent_lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL,
  purchase_order_item_id uuid REFERENCES public.purchase_order_items(id) ON DELETE SET NULL,
  production_run_id uuid REFERENCES public.production_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_batch_label ON public.inventory_lots(product_batch_label);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_expiry ON public.inventory_lots(expiry_date);

ALTER TABLE public.inventory_lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view inventory_lots"
  ON public.inventory_lots FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage inventory_lots"
  ON public.inventory_lots FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

ALTER TABLE public.hub_inventory
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL;

ALTER TABLE public.outlet_inventory
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hub_inventory_lot ON public.hub_inventory(lot_id);
CREATE INDEX IF NOT EXISTS idx_outlet_inventory_lot ON public.outlet_inventory(lot_id);

CREATE TABLE IF NOT EXISTS public.document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  storage_path text NOT NULL,
  mime_type text,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_links_entity ON public.document_links(entity_type, entity_id);

ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view document_links"
  ON public.document_links FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert document_links"
  ON public.document_links FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

CREATE POLICY "Admins can delete document_links"
  ON public.document_links FOR DELETE TO authenticated
  USING (public.is_profiles_admin());

INSERT INTO storage.buckets (id, name, public)
VALUES ('erp_documents', 'erp_documents', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "erp_documents authenticated select" ON storage.objects;
DROP POLICY IF EXISTS "erp_documents authenticated insert" ON storage.objects;
DROP POLICY IF EXISTS "erp_documents authenticated update" ON storage.objects;
DROP POLICY IF EXISTS "erp_documents admins delete" ON storage.objects;

CREATE POLICY "erp_documents authenticated select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'erp_documents');

CREATE POLICY "erp_documents authenticated insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'erp_documents');

CREATE POLICY "erp_documents authenticated update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'erp_documents')
  WITH CHECK (bucket_id = 'erp_documents');

CREATE POLICY "erp_documents admins delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'erp_documents' AND public.is_profiles_admin());

ALTER TABLE public.sales_journal_lines
  DROP CONSTRAINT IF EXISTS sales_journal_lines_lot_id_fkey;

ALTER TABLE public.sales_journal_lines
  ADD CONSTRAINT sales_journal_lines_lot_id_fkey
  FOREIGN KEY (lot_id) REFERENCES public.inventory_lots(id) ON DELETE SET NULL;
