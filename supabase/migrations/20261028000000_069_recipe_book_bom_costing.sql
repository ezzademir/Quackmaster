/*
  Recipe book, BOM, live dish COGS, and vendor sourcing.

  The linked database already has menu_items, supplier_items, bom_lines, and
  price_history for the ingredient workbook (dishes, preps, and vendor packs).
  Those tables are not recreated: a second definition would collide with
  production data and would not match the two-row raw_materials stock ledger.

  When those tables are absent, this file creates the raw-material recipe book
  from the Phase 1 contract (pack price, unit cost, BOM parents, price history).

  receive_po_shipment is left as the stock-and-weighted-average poster.
  Receipt prices on the ingredient catalog are written by record_po_delivery.
  A price-history trigger is attached only for the raw-material recipe book,
  where price_history.source_type exists.

  v_ingredient_sourcing_suggestions is created for whichever catalog is present.
  It ranks active supplier items, joins supplier_scorecard_metrics for OTIF and
  fill rate, and returns the preferred vendor, the lowest-cost vendor, and the
  savings percentage.
*/

CREATE TABLE IF NOT EXISTS public.menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sku text UNIQUE,
  selling_price numeric(12, 2) NOT NULL DEFAULT 0,
  target_cost_percentage numeric(5, 2) DEFAULT 30,
  category text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- The ingredient workbook already owns supplier_items. Create the raw-material
-- bridge only when that table is not already installed.
DO $$
BEGIN
  IF to_regclass('public.supplier_items') IS NULL THEN
    CREATE TABLE public.supplier_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
      raw_material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
      vendor_sku text,
      pack_description text NOT NULL,
      pack_size numeric(12, 4) NOT NULL CHECK (pack_size > 0),
      pack_uom text NOT NULL,
      pack_price numeric(12, 4) NOT NULL CHECK (pack_price >= 0),
      unit_cost numeric(14, 4) NOT NULL,
      is_preferred boolean DEFAULT false,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE CASCADE,
  sub_recipe_id uuid REFERENCES public.recipes(id) ON DELETE CASCADE,
  raw_material_id uuid REFERENCES public.raw_materials(id) ON DELETE RESTRICT,
  component_sub_recipe_id uuid REFERENCES public.recipes(id) ON DELETE RESTRICT,
  quantity numeric(12, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  notes text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bom_lines' AND column_name = 'quantity'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bom_lines_parent_check' AND conrelid = 'public.bom_lines'::regclass
  ) THEN
    ALTER TABLE public.bom_lines
      ADD CONSTRAINT bom_lines_parent_check
      CHECK (num_nonnulls(menu_item_id, sub_recipe_id) = 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bom_lines_component_check' AND conrelid = 'public.bom_lines'::regclass
  ) THEN
    ALTER TABLE public.bom_lines
      ADD CONSTRAINT bom_lines_component_check
      CHECK (num_nonnulls(raw_material_id, component_sub_recipe_id) = 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_item_id uuid NOT NULL REFERENCES public.supplier_items(id) ON DELETE CASCADE,
  pack_price numeric(12, 4) NOT NULL,
  unit_cost numeric(14, 4) NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('po_received', 'invoice', 'manual')),
  source_id uuid,
  effective_date timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'supplier_items' AND column_name = 'raw_material_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'supplier_items' AND column_name = 'unit_cost'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_supplier_items_raw_material_unit_cost ON public.supplier_items (raw_material_id, unit_cost ASC)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'supplier_items' AND column_name = 'pack_description'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_items' AND column_name = 'supplier_item_id'
  ) THEN
    ALTER TABLE public.purchase_order_items
      ADD COLUMN supplier_item_id uuid REFERENCES public.supplier_items(id) ON DELETE SET NULL;
  END IF;
END $$;

-- RLS for the raw-material recipe book only. The ingredient workbook already
-- has its own policies; adding another SELECT policy here would change them.
DO $$
DECLARE
  v_table text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns AS columns
    WHERE columns.table_schema = 'public' AND columns.table_name = 'supplier_items' AND columns.column_name = 'pack_description'
  ) THEN
    RETURN;
  END IF;

  FOREACH v_table IN ARRAY ARRAY['menu_items', 'supplier_items', 'bom_lines', 'price_history']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_staff_select', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (
         EXISTS (
           SELECT 1 FROM public.profiles p
           WHERE p.id = auth.uid()
             AND COALESCE(p.is_active, false)
             AND lower(btrim(p.role)) <> ''pending''
         )
       )',
      v_table || '_staff_select',
      v_table
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_admin_write', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin())',
      v_table || '_admin_write',
      v_table
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public._recipe_book_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item record;
BEGIN
  IF NEW.supplier_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.quantity_received IS NOT DISTINCT FROM OLD.quantity_received THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(NEW.quantity_received, 0) <= COALESCE(OLD.quantity_received, 0) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND COALESCE(NEW.quantity_received, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT pack_price, pack_size, unit_cost
  INTO v_item
  FROM public.supplier_items
  WHERE id = NEW.supplier_item_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.price_history (supplier_item_id, pack_price, unit_cost, source_type, source_id)
  VALUES (NEW.supplier_item_id, v_item.pack_price, v_item.unit_cost, 'po_received', NEW.id);

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'price_history' AND column_name = 'source_type'
  ) THEN
    DROP TRIGGER IF EXISTS recipe_book_price_history ON public.purchase_order_items;
    DROP FUNCTION IF EXISTS public._recipe_book_price_history();
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_items' AND column_name = 'supplier_item_id'
  ) THEN
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS recipe_book_price_history ON public.purchase_order_items;
  CREATE TRIGGER recipe_book_price_history
    AFTER INSERT OR UPDATE OF quantity_received, supplier_item_id
    ON public.purchase_order_items
    FOR EACH ROW
    EXECUTE FUNCTION public._recipe_book_price_history();
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'supplier_items' AND column_name = 'ingredient_id'
  ) THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.v_ingredient_sourcing_suggestions
      WITH (security_invoker = true) AS
      WITH items AS (
        SELECT
          si.id AS supplier_item_id,
          si.ingredient_id,
          i.raw_material_id,
          i.name AS material_name,
          i.base_unit,
          si.supplier_id,
          s.name AS supplier_name,
          si.unit_cost_rm AS unit_cost,
          si.price_rm AS pack_price,
          si.item_name AS pack_description,
          si.is_preferred,
          CASE i.base_unit
            WHEN 'g' THEN si.unit_cost_rm * 1000
            WHEN 'ml' THEN si.unit_cost_rm * 1000
            ELSE si.unit_cost_rm
          END AS normalized_unit_cost
        FROM public.supplier_items si
        JOIN public.ingredients i ON i.id = si.ingredient_id
        JOIN public.suppliers s ON s.id = si.supplier_id
        WHERE si.status = 'active'
          AND i.status = 'active'
          AND si.unit_cost_rm IS NOT NULL
      ),
      ranked AS (
        SELECT
          items.*,
          row_number() OVER (
            PARTITION BY items.ingredient_id
            ORDER BY items.normalized_unit_cost ASC, items.supplier_item_id
          ) AS cost_rank
        FROM items
      ),
      lowest AS (
        SELECT * FROM ranked WHERE cost_rank = 1
      ),
      preferred AS (
        SELECT DISTINCT ON (ingredient_id) *
        FROM ranked
        ORDER BY ingredient_id, is_preferred DESC, normalized_unit_cost ASC, supplier_item_id
      )
      SELECT
        preferred.ingredient_id,
        preferred.raw_material_id,
        preferred.material_name,
        preferred.base_unit,
        preferred.supplier_item_id AS preferred_supplier_item_id,
        preferred.supplier_id AS preferred_supplier_id,
        preferred.supplier_name AS preferred_supplier_name,
        preferred.unit_cost AS preferred_unit_cost,
        preferred.pack_price AS preferred_pack_price,
        preferred.pack_description AS preferred_pack_description,
        preferred_score.otif_rate AS preferred_otif_rate,
        preferred_score.avg_fill_rate AS preferred_fill_rate,
        lowest.supplier_item_id AS lowest_supplier_item_id,
        lowest.supplier_id AS lowest_supplier_id,
        lowest.supplier_name AS lowest_supplier_name,
        lowest.unit_cost AS lowest_unit_cost,
        lowest.pack_price AS lowest_pack_price,
        lowest_score.otif_rate AS lowest_otif_rate,
        lowest_score.avg_fill_rate AS lowest_fill_rate,
        (preferred.supplier_item_id = lowest.supplier_item_id) AS preferred_is_lowest,
        CASE
          WHEN preferred.normalized_unit_cost IS NULL
            OR preferred.normalized_unit_cost = 0
            OR lowest.normalized_unit_cost IS NULL THEN NULL
          ELSE round((preferred.normalized_unit_cost - lowest.normalized_unit_cost) / preferred.normalized_unit_cost * 100, 2)
        END AS savings_percent,
        (SELECT count(*)::integer FROM items row_item WHERE row_item.ingredient_id = preferred.ingredient_id) AS supplier_count
      FROM preferred
      JOIN lowest ON lowest.ingredient_id = preferred.ingredient_id
      LEFT JOIN public.supplier_scorecard_metrics preferred_score ON preferred_score.supplier_id = preferred.supplier_id
      LEFT JOIN public.supplier_scorecard_metrics lowest_score ON lowest_score.supplier_id = lowest.supplier_id
    $view$;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'supplier_items' AND column_name = 'raw_material_id'
  ) THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.v_ingredient_sourcing_suggestions
      WITH (security_invoker = true) AS
      WITH items AS (
        SELECT
          si.id AS supplier_item_id,
          NULL::uuid AS ingredient_id,
          si.raw_material_id,
          rm.name AS material_name,
          rm.unit_of_measure AS base_unit,
          si.supplier_id,
          s.name AS supplier_name,
          si.unit_cost,
          si.pack_price,
          si.pack_description,
          si.is_preferred
        FROM public.supplier_items si
        JOIN public.raw_materials rm ON rm.id = si.raw_material_id
        JOIN public.suppliers s ON s.id = si.supplier_id
      ),
      ranked AS (
        SELECT
          items.*,
          row_number() OVER (
            PARTITION BY items.raw_material_id
            ORDER BY items.unit_cost ASC, items.supplier_item_id
          ) AS cost_rank
        FROM items
      ),
      lowest AS (
        SELECT * FROM ranked WHERE cost_rank = 1
      ),
      preferred AS (
        SELECT DISTINCT ON (raw_material_id) *
        FROM ranked
        ORDER BY raw_material_id, is_preferred DESC, unit_cost ASC, supplier_item_id
      )
      SELECT
        preferred.ingredient_id,
        preferred.raw_material_id,
        preferred.material_name,
        preferred.base_unit,
        preferred.supplier_item_id AS preferred_supplier_item_id,
        preferred.supplier_id AS preferred_supplier_id,
        preferred.supplier_name AS preferred_supplier_name,
        preferred.unit_cost AS preferred_unit_cost,
        preferred.pack_price AS preferred_pack_price,
        preferred.pack_description AS preferred_pack_description,
        preferred_score.otif_rate AS preferred_otif_rate,
        preferred_score.avg_fill_rate AS preferred_fill_rate,
        lowest.supplier_item_id AS lowest_supplier_item_id,
        lowest.supplier_id AS lowest_supplier_id,
        lowest.supplier_name AS lowest_supplier_name,
        lowest.unit_cost AS lowest_unit_cost,
        lowest.pack_price AS lowest_pack_price,
        lowest_score.otif_rate AS lowest_otif_rate,
        lowest_score.avg_fill_rate AS lowest_fill_rate,
        (preferred.supplier_item_id = lowest.supplier_item_id) AS preferred_is_lowest,
        CASE
          WHEN preferred.unit_cost IS NULL OR preferred.unit_cost = 0 OR lowest.unit_cost IS NULL THEN NULL
          ELSE round((preferred.unit_cost - lowest.unit_cost) / preferred.unit_cost * 100, 2)
        END AS savings_percent,
        (SELECT count(*)::integer FROM items row_item WHERE row_item.raw_material_id = preferred.raw_material_id) AS supplier_count
      FROM preferred
      JOIN lowest ON lowest.raw_material_id = preferred.raw_material_id
      LEFT JOIN public.supplier_scorecard_metrics preferred_score ON preferred_score.supplier_id = preferred.supplier_id
      LEFT JOIN public.supplier_scorecard_metrics lowest_score ON lowest_score.supplier_id = lowest.supplier_id
    $view$;
  END IF;
END $$;

GRANT SELECT ON public.v_ingredient_sourcing_suggestions TO anon, authenticated, service_role;

COMMENT ON VIEW public.v_ingredient_sourcing_suggestions IS
  'Preferred vendor versus lowest unit cost, with OTIF and fill rate from supplier_scorecard_metrics.';
