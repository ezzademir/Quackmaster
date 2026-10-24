/*
  084: costing schema (shared supplier catalogue + entity-tagged menu costing).

  Lands after 081 (#88, merged) and 082 (numeric widening, separate held PR). Draft / held: not applied anywhere.

  Shared (no entity tag; one catalogue bought once, used by every entity):
    suppliers (existing, extended), ingredients, supplier_items, price_history (append-only).
  Entity-tagged (one cost book per brand: QT = Quackteow, MH = Merdeka House; Quackteow PLT and
  Quackteow Enterprise share the QT book. New entities / tags are rows, not schema changes):
    menu_items, sub_recipes, bom_lines   -- status active / inactive / KIV.
  POs: purchase_orders.entity_code, purchase_order_items.supplier_item_id.

  Rules:
    - Incomplete costs stay NULL with cost_complete = false. Nothing is estimated.
    - price_history is append-only: UPDATE / DELETE / TRUNCATE raise, and no grants exist for them.
    - A price more than 5% above the previous price for the same supplier item is FLAGGED for admin
      review (never blocked).
    - Costing tables (menu_items, sub_recipes, bom_lines, price_flag_reviews and the cost / COGS / drift /
      usage views) are ADMIN-ONLY, read and write. Staff and procurement get nothing.
    - Catalogue (ingredients, supplier_items, price_history): read = admin | active staff; write = admin.
      085 adds tag-scoped procurement read of supplier_items / price_history.
    - Every view is security_invoker so the caller's RLS applies (no definer-view leak).
*/

-- PRE-APPLY CHECK (round 3, G3). The PO entity backfill further down tags EVERY purchase order that has no entity at apply time,
-- and Ezzad's confirmation (24 Oct 2026) covers exactly the 32 POs that exist today (all Quackteow). So the migration refuses
-- to run unless there are exactly 32 untagged POs: a PO raised since (or a re-run after the backfill) aborts here, before any
-- change, instead of being silently tagged QT. If the count moved on purpose, get a fresh confirmation and change the number.
DO $$
DECLARE
  v_untagged bigint;
  v_expected CONSTANT bigint := 32;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'entity_code') THEN
    EXECUTE 'SELECT count(*) FROM public.purchase_orders WHERE entity_code IS NULL' INTO v_untagged;
  ELSE
    SELECT count(*) INTO v_untagged FROM public.purchase_orders;   -- column not added yet: every PO is untagged
  END IF;
  IF v_untagged <> v_expected THEN
    RAISE EXCEPTION '084 aborted: % purchase orders have no entity, expected exactly % (the 32 POs Ezzad confirmed as Quackteow on 24 Oct 2026). Nothing was changed. Re-confirm the new POs with Ezzad before changing this number.', v_untagged, v_expected
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ---------------------------------------------------------------- entities
-- Procurement tags (what a buyer is assigned to in 085). Extensible: add a row.
CREATE TABLE IF NOT EXISTS public.procurement_tags (
  tag text PRIMARY KEY CHECK (tag ~ '^[a-z][a-z0-9_]*$'),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.procurement_tags (tag, name) VALUES
  ('quackteow', 'Quackteow'), ('merdeka_house', 'Merdeka House')
ON CONFLICT (tag) DO NOTHING;

-- Cost books. One per brand: Quackteow PLT and Quackteow Enterprise are NOT split (one QT book).
-- Extensible: a new entity is a row here pointing at an existing or new procurement tag.
CREATE TABLE IF NOT EXISTS public.business_entities (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text NOT NULL UNIQUE,
  procurement_tag text NOT NULL REFERENCES public.procurement_tags(tag),
  legal_entities text,   -- informational, e.g. 'Quackteow PLT; Quackteow Enterprise'
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.business_entities (code, name, procurement_tag, legal_entities) VALUES
  ('QT', 'Quackteow', 'quackteow', 'Quackteow PLT; Quackteow Enterprise'),
  ('MH', 'Merdeka House', 'merdeka_house', 'Merdeka House PLT')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------- shared: suppliers (extend)
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS delivery_day text,
  ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid(),
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS suppliers_status_check;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_status_check
  CHECK (status IN ('active', 'inactive', 'pending'));

-- ---------------------------------------------------------------- shared: ingredients
CREATE TABLE IF NOT EXISTS public.ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_unit text NOT NULL CHECK (base_unit IN ('g', 'ml', 'pc', 'portion')),
  raw_material_id uuid REFERENCES public.raw_materials(id) ON DELETE SET NULL,
  in_house boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending')),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ingredients_name_unit_uq ON public.ingredients (lower(name), base_unit);

-- ---------------------------------------------------------------- shared: supplier_items
CREATE TABLE IF NOT EXISTS public.supplier_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  ingredient_id uuid REFERENCES public.ingredients(id) ON DELETE SET NULL,
  -- who buys it (procurement visibility). Shared items are still bought under one tag.
  procurement_tag text NOT NULL REFERENCES public.procurement_tags(tag),
  shared_ingredient boolean NOT NULL DEFAULT false,
  item_name text NOT NULL,
  pack_qty numeric(14,4),
  pack_unit text,
  base_unit text NOT NULL CHECK (base_unit IN ('g', 'ml', 'pc', 'portion')),
  pack_qty_base numeric(14,4) CHECK (pack_qty_base IS NULL OR pack_qty_base > 0),
  price_rm numeric(12,4) CHECK (price_rm IS NULL OR price_rm >= 0),
  unit_cost_rm numeric(16,8) GENERATED ALWAYS AS (price_rm / NULLIF(pack_qty_base, 0)) STORED,
  price_basis text NOT NULL DEFAULT 'list' CHECK (price_basis IN ('list', 'pending', 'receipt')),
  payment_terms text,
  delivery_day text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'inactive', 'pending')),
  source_list text,
  source_line_no integer,
  notes text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  CONSTRAINT supplier_items_price_basis_null CHECK (price_basis <> 'pending' OR price_rm IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_items_source_uq ON public.supplier_items (source_list, source_line_no)
  WHERE source_line_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_items_supplier_idx ON public.supplier_items (supplier_id);
CREATE INDEX IF NOT EXISTS supplier_items_ingredient_idx ON public.supplier_items (ingredient_id);

-- ---------------------------------------------------------------- shared: price_history (append-only)
CREATE TABLE IF NOT EXISTS public.price_history (
  id bigserial PRIMARY KEY,
  supplier_item_id uuid NOT NULL REFERENCES public.supplier_items(id) ON DELETE RESTRICT,
  price_rm numeric(12,4) NOT NULL CHECK (price_rm >= 0),
  pack_qty_base numeric(14,4),
  unit_cost_rm numeric(16,8),
  source text NOT NULL CHECK (source IN ('seed', 'list', 'receipt', 'manual')),
  purchase_order_item_id uuid REFERENCES public.purchase_order_items(id) ON DELETE RESTRICT,
  previous_unit_cost_rm numeric(16,8),
  pct_change numeric(10,4),
  flagged_over_5pct boolean NOT NULL DEFAULT false,
  note text,
  entered_by uuid DEFAULT auth.uid(),
  entered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_history_item_idx ON public.price_history (supplier_item_id, entered_at DESC);

-- Review state lives outside price_history so price_history never needs an UPDATE.
CREATE TABLE IF NOT EXISTS public.price_flag_reviews (
  price_history_id bigint PRIMARY KEY REFERENCES public.price_history(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('accepted', 'queried')),
  note text,
  reviewed_by uuid NOT NULL DEFAULT auth.uid(),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public._price_history_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'price_history_append_only' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS price_history_no_update ON public.price_history;
CREATE TRIGGER price_history_no_update BEFORE UPDATE OR DELETE ON public.price_history
  FOR EACH ROW EXECUTE FUNCTION public._price_history_append_only();
DROP TRIGGER IF EXISTS price_history_no_truncate ON public.price_history;
CREATE TRIGGER price_history_no_truncate BEFORE TRUNCATE ON public.price_history
  FOR EACH STATEMENT EXECUTE FUNCTION public._price_history_append_only();

-- Fill previous price / % change / >5% flag from the last row for the item. Flag, never block.
CREATE OR REPLACE FUNCTION public._price_history_before_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev numeric;
BEGIN
  NEW.entered_by := COALESCE(auth.uid(), NEW.entered_by);
  NEW.entered_at := now();
  IF NEW.unit_cost_rm IS NULL AND NEW.pack_qty_base IS NOT NULL AND NEW.pack_qty_base > 0 THEN
    NEW.unit_cost_rm := NEW.price_rm / NEW.pack_qty_base;
  END IF;
  SELECT ph.unit_cost_rm INTO v_prev
  FROM public.price_history ph
  WHERE ph.supplier_item_id = NEW.supplier_item_id AND ph.unit_cost_rm IS NOT NULL
  ORDER BY ph.entered_at DESC, ph.id DESC LIMIT 1;
  NEW.previous_unit_cost_rm := v_prev;
  IF v_prev IS NOT NULL AND v_prev > 0 AND NEW.unit_cost_rm IS NOT NULL THEN
    NEW.pct_change := round((NEW.unit_cost_rm - v_prev) / v_prev * 100, 4);
    NEW.flagged_over_5pct := NEW.unit_cost_rm > v_prev * 1.05;
  ELSE
    NEW.pct_change := NULL;
    NEW.flagged_over_5pct := false;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS price_history_fill ON public.price_history;
CREATE TRIGGER price_history_fill BEFORE INSERT ON public.price_history
  FOR EACH ROW EXECUTE FUNCTION public._price_history_before_insert();

-- Every list-price change on supplier_items is written to price_history (who and when).
CREATE OR REPLACE FUNCTION public._supplier_items_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS supplier_items_audit ON public.supplier_items;
CREATE TRIGGER supplier_items_audit BEFORE INSERT OR UPDATE ON public.supplier_items
  FOR EACH ROW EXECUTE FUNCTION public._supplier_items_audit();

CREATE OR REPLACE FUNCTION public._supplier_items_price_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.price_rm IS NOT NULL AND (TG_OP = 'INSERT'
      OR NEW.price_rm IS DISTINCT FROM OLD.price_rm OR NEW.pack_qty_base IS DISTINCT FROM OLD.pack_qty_base) THEN
    INSERT INTO public.price_history (supplier_item_id, price_rm, pack_qty_base, unit_cost_rm, source, note)
    VALUES (NEW.id, NEW.price_rm, NEW.pack_qty_base, NEW.unit_cost_rm,
            COALESCE(NULLIF(current_setting('app.price_source', true), ''), CASE WHEN TG_OP = 'INSERT' THEN 'list' ELSE 'manual' END),
            NULLIF(current_setting('app.price_note', true), ''));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS supplier_items_price_log ON public.supplier_items;
CREATE TRIGGER supplier_items_price_log AFTER INSERT OR UPDATE ON public.supplier_items
  FOR EACH ROW EXECUTE FUNCTION public._supplier_items_price_log();

-- ---------------------------------------------------------------- entity-tagged costing
CREATE TABLE IF NOT EXISTS public.menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code text NOT NULL REFERENCES public.business_entities(code),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'KIV')),
  -- recipe yield: cost per serving = sum(line cost) x (1 + wastage_pct/100) / servings (as on the BOM sheets)
  wastage_pct numeric(6,2) NOT NULL DEFAULT 0 CHECK (wastage_pct >= 0),
  servings numeric(10,3) NOT NULL DEFAULT 1 CHECK (servings > 0),
  selling_price_ex_sst_rm numeric(12,4) CHECK (selling_price_ex_sst_rm IS NULL OR selling_price_ex_sst_rm >= 0),
  packaging_rule text,
  pkg_dine_in_rm numeric(12,4) CHECK (pkg_dine_in_rm IS NULL OR pkg_dine_in_rm >= 0),
  pkg_takeaway_rm numeric(12,4) CHECK (pkg_takeaway_rm IS NULL OR pkg_takeaway_rm >= 0),
  source_sheet text,
  notes text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS menu_items_entity_sheet_uq ON public.menu_items (entity_code, source_sheet);

CREATE TABLE IF NOT EXISTS public.sub_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code text NOT NULL REFERENCES public.business_entities(code),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'KIV')),
  -- recipe yield: cost per serving = sum(line cost) x (1 + wastage_pct/100) / servings (as on the BOM sheets)
  wastage_pct numeric(6,2) NOT NULL DEFAULT 0 CHECK (wastage_pct >= 0),
  servings numeric(10,3) NOT NULL DEFAULT 1 CHECK (servings > 0),
  yield_note text,
  selling_price_ex_sst_rm numeric(12,4),
  source_sheet text,
  notes text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sub_recipes_entity_sheet_uq ON public.sub_recipes (entity_code, source_sheet);

CREATE TABLE IF NOT EXISTS public.bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code text NOT NULL REFERENCES public.business_entities(code),
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE CASCADE,
  sub_recipe_id uuid REFERENCES public.sub_recipes(id) ON DELETE CASCADE,
  component_name text NOT NULL,
  supplier_item_id uuid REFERENCES public.supplier_items(id) ON DELETE RESTRICT,
  component_sub_recipe_id uuid REFERENCES public.sub_recipes(id) ON DELETE RESTRICT,
  qty numeric(14,4),
  unit text,
  base_qty numeric(14,4),
  price_basis text NOT NULL DEFAULT 'list' CHECK (price_basis IN ('list', 'pending', 'receipt')),
  -- snapshot line cost at seed / last costing; NULL = unknown (never estimated)
  line_cost_rm numeric(14,6),
  cost_complete boolean NOT NULL DEFAULT false,
  shared_ingredient boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'KIV')),
  source_sheet text,
  source_row integer,
  issues text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bom_lines_one_parent CHECK ((menu_item_id IS NULL) <> (sub_recipe_id IS NULL)),
  CONSTRAINT bom_lines_complete_has_cost CHECK (NOT cost_complete OR line_cost_rm IS NOT NULL),
  CONSTRAINT bom_lines_pending_is_incomplete CHECK (price_basis <> 'pending' OR NOT cost_complete)
);
CREATE INDEX IF NOT EXISTS bom_lines_menu_idx ON public.bom_lines (menu_item_id);
CREATE INDEX IF NOT EXISTS bom_lines_sub_idx ON public.bom_lines (sub_recipe_id);
CREATE INDEX IF NOT EXISTS bom_lines_item_idx ON public.bom_lines (supplier_item_id);

-- ---------------------------------------------------------------- POs
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS entity_code text REFERENCES public.business_entities(code);
ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS supplier_item_id uuid REFERENCES public.supplier_items(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS purchase_orders_entity_idx ON public.purchase_orders (entity_code);

-- Where a PO is delivered decides its cost book. Live POs have no destination column: every PO so far is
-- delivered to the hub. delivery_outlet_id NULL = hub (today's behaviour); set it for outlet-direct POs.
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS delivery_outlet_id uuid REFERENCES public.outlets(id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS public.delivery_location_entities (
  location_kind text NOT NULL CHECK (location_kind IN ('hub', 'outlet')),
  outlet_id uuid REFERENCES public.outlets(id) ON DELETE CASCADE,
  entity_code text NOT NULL REFERENCES public.business_entities(code),
  CONSTRAINT delivery_location_entities_shape CHECK ((location_kind = 'hub') = (outlet_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_location_entities_uq
  ON public.delivery_location_entities (location_kind, COALESCE(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid));
-- The hub is the Quackteow kitchen (it produces the QUACKTEOW SKU). Outlet rows are added by an admin when
-- outlet-direct POs start; none exist today.
INSERT INTO public.delivery_location_entities (location_kind, outlet_id, entity_code)
SELECT 'hub', NULL, 'QT'
WHERE NOT EXISTS (SELECT 1 FROM public.delivery_location_entities WHERE location_kind = 'hub');

-- CONFIRMED by Ezzad, 24 Oct 2026: all 32 existing POs are Quackteow. This backfill therefore stands as written (every live PO
-- resolves to QT through the hub mapping). It is a ONE-TIME backfill of those existing POs only; nothing else is backfilled or
-- guessed from it.
-- Backfill existing POs from their delivery location. Unresolved POs stay NULL (invisible to procurement)
-- and are listed by v_po_entity_unresolved + a NOTICE here.
UPDATE public.purchase_orders po
SET entity_code = dle.entity_code
FROM public.delivery_location_entities dle
WHERE po.entity_code IS NULL
  AND ((po.delivery_outlet_id IS NULL AND dle.location_kind = 'hub')
    OR (po.delivery_outlet_id IS NOT NULL AND dle.location_kind = 'outlet' AND dle.outlet_id = po.delivery_outlet_id));

CREATE OR REPLACE VIEW public.v_po_entity_unresolved WITH (security_invoker = true) AS
SELECT po.id, po.order_number, po.status, po.order_date, po.delivery_outlet_id
FROM public.purchase_orders po
WHERE po.entity_code IS NULL AND public.is_profiles_admin();

DO $$
DECLARE v_list text;
BEGIN
  SELECT string_agg(COALESCE(order_number, id::text), ', ' ORDER BY order_number) INTO v_list
  FROM public.purchase_orders WHERE entity_code IS NULL;
  IF v_list IS NOT NULL THEN
    RAISE NOTICE '084: POs with no entity after backfill: %', v_list;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS purchase_order_items_supplier_item_idx ON public.purchase_order_items (supplier_item_id);

-- A PO line may only use an APPROVED (active) supplier item; pending items wait for an admin.
CREATE OR REPLACE FUNCTION public._po_line_supplier_item_active()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.supplier_item_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.supplier_item_id IS DISTINCT FROM OLD.supplier_item_id)
     AND NOT EXISTS (SELECT 1 FROM public.supplier_items si WHERE si.id = NEW.supplier_item_id AND si.status = 'active') THEN
    RAISE EXCEPTION 'supplier_item_not_approved' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS po_line_supplier_item_active ON public.purchase_order_items;
CREATE TRIGGER po_line_supplier_item_active BEFORE INSERT OR UPDATE OF supplier_item_id ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._po_line_supplier_item_active();

-- ---------------------------------------------------------------- RLS
ALTER TABLE public.procurement_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_location_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_flag_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sub_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_location_entities_staff ON public.delivery_location_entities;
CREATE POLICY delivery_location_entities_staff ON public.delivery_location_entities FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS delivery_location_entities_admin ON public.delivery_location_entities;
CREATE POLICY delivery_location_entities_admin ON public.delivery_location_entities FOR ALL TO authenticated
  USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());
DROP POLICY IF EXISTS procurement_tags_select ON public.procurement_tags;
CREATE POLICY procurement_tags_select ON public.procurement_tags FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS procurement_tags_admin ON public.procurement_tags;
CREATE POLICY procurement_tags_admin ON public.procurement_tags FOR ALL TO authenticated
  USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());
DROP POLICY IF EXISTS business_entities_select ON public.business_entities;
CREATE POLICY business_entities_select ON public.business_entities FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS business_entities_admin ON public.business_entities;
CREATE POLICY business_entities_admin ON public.business_entities FOR ALL TO authenticated
  USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());

-- Catalogue: staff read, admin write.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingredients', 'supplier_items'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_staff_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_authenticated_active_staff())', t || '_staff_select', t);
  END LOOP;
END $$;

-- Catalogue + costing: admin read / write. Costing tables have NO other policy, so they are admin-only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingredients', 'supplier_items', 'menu_items', 'sub_recipes', 'bom_lines', 'price_flag_reviews'] LOOP
    IF t NOT IN ('ingredients', 'supplier_items') THEN   -- remove any earlier draft's staff read
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_staff_select', t);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_admin_write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin())', t || '_admin_write', t);
  END LOOP;
END $$;

-- price_history: read staff/admin; insert admin (receipts insert via SECURITY DEFINER RPC in 084); never update/delete.
DROP POLICY IF EXISTS price_history_staff_select ON public.price_history;
CREATE POLICY price_history_staff_select ON public.price_history FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS price_history_admin_insert ON public.price_history;
CREATE POLICY price_history_admin_insert ON public.price_history FOR INSERT TO authenticated
  WITH CHECK (public.is_profiles_admin());

REVOKE ALL ON public.delivery_location_entities, public.v_po_entity_unresolved FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.delivery_location_entities TO authenticated;
GRANT SELECT ON public.v_po_entity_unresolved TO authenticated;
REVOKE ALL ON public.procurement_tags, public.business_entities, public.ingredients, public.supplier_items, public.price_history,
  public.price_flag_reviews, public.menu_items, public.sub_recipes, public.bom_lines FROM PUBLIC, anon;
GRANT SELECT ON public.procurement_tags, public.business_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingredients, public.supplier_items, public.menu_items,
  public.sub_recipes, public.bom_lines, public.price_flag_reviews TO authenticated;
GRANT SELECT, INSERT ON public.price_history TO authenticated;   -- no UPDATE / DELETE / TRUNCATE
GRANT USAGE ON SEQUENCE public.price_history_id_seq TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.price_history FROM authenticated, anon, PUBLIC;

-- ---------------------------------------------------------------- views (security_invoker)
-- v_recipe_cost / v_dish_cogs / v_cost_drift / v_ingredient_usage read only admin-only tables, so they return
-- nothing to staff or procurement. v_price_flags_open is filtered to admins explicitly.
-- Cost per serving of each dish / sub-recipe from snapshot line costs, with wastage and servings.
-- Lines counted: active lines (inactive / KIV recipes keep their own lines for reference).
-- food_cost_rm is NULL unless every counted line is complete; known_cost_rm is the partial figure, labelled as such.
CREATE OR REPLACE VIEW public.v_recipe_cost WITH (security_invoker = true) AS
SELECT 'dish'::text AS kind, m.id, m.entity_code, m.name, m.status, m.source_sheet,
       m.selling_price_ex_sst_rm, m.packaging_rule, m.pkg_dine_in_rm, m.pkg_takeaway_rm,
       count(b.id) FILTER (WHERE (b.status = 'active' OR m.status <> 'active')) AS line_count,
       count(b.id) FILTER (WHERE (b.status = 'active' OR m.status <> 'active') AND NOT b.cost_complete) AS incomplete_lines,
       COALESCE(bool_and(b.cost_complete) FILTER (WHERE (b.status = 'active' OR m.status <> 'active')), false) AS cost_complete,
       CASE WHEN COALESCE(bool_and(b.cost_complete) FILTER (WHERE (b.status = 'active' OR m.status <> 'active')), false)
            THEN round(sum(b.line_cost_rm) FILTER (WHERE (b.status = 'active' OR m.status <> 'active')) * (1 + m.wastage_pct / 100) / m.servings, 6) END AS food_cost_rm,
       round(sum(b.line_cost_rm) FILTER (WHERE (b.status = 'active' OR m.status <> 'active')) * (1 + m.wastage_pct / 100) / m.servings, 6) AS known_cost_rm
FROM public.menu_items m LEFT JOIN public.bom_lines b ON b.menu_item_id = m.id
GROUP BY m.id
UNION ALL
SELECT 'sub-recipe', s.id, s.entity_code, s.name, s.status, s.source_sheet,
       s.selling_price_ex_sst_rm, NULL, NULL, NULL,
       count(b.id) FILTER (WHERE (b.status = 'active' OR s.status <> 'active')),
       count(b.id) FILTER (WHERE (b.status = 'active' OR s.status <> 'active') AND NOT b.cost_complete),
       COALESCE(bool_and(b.cost_complete) FILTER (WHERE (b.status = 'active' OR s.status <> 'active')), false),
       CASE WHEN COALESCE(bool_and(b.cost_complete) FILTER (WHERE (b.status = 'active' OR s.status <> 'active')), false)
            THEN round(sum(b.line_cost_rm) FILTER (WHERE (b.status = 'active' OR s.status <> 'active')) * (1 + s.wastage_pct / 100) / s.servings, 6) END,
       round(sum(b.line_cost_rm) FILTER (WHERE (b.status = 'active' OR s.status <> 'active')) * (1 + s.wastage_pct / 100) / s.servings, 6)
FROM public.sub_recipes s LEFT JOIN public.bom_lines b ON b.sub_recipe_id = s.id
GROUP BY s.id;

-- COGS % separately for dine-in and takeaway. NULL whenever food cost, price or that channel's
-- packaging cost is unknown. 'takeaway only' packaging rule => dine-in packaging is RM0 by rule.
CREATE OR REPLACE VIEW public.v_dish_cogs WITH (security_invoker = true) AS
SELECT rc.id AS menu_item_id, rc.entity_code, rc.name, rc.status, rc.cost_complete, rc.food_cost_rm,
       rc.selling_price_ex_sst_rm,
       CASE WHEN rc.packaging_rule = 'takeaway only' THEN COALESCE(rc.pkg_dine_in_rm, 0) ELSE rc.pkg_dine_in_rm END AS pkg_dine_in_rm,
       rc.pkg_takeaway_rm,
       round((rc.food_cost_rm + CASE WHEN rc.packaging_rule = 'takeaway only' THEN COALESCE(rc.pkg_dine_in_rm, 0) ELSE rc.pkg_dine_in_rm END)
             / NULLIF(rc.selling_price_ex_sst_rm, 0) * 100, 2) AS cogs_dine_in_pct,
       round((rc.food_cost_rm + rc.pkg_takeaway_rm) / NULLIF(rc.selling_price_ex_sst_rm, 0) * 100, 2) AS cogs_takeaway_pct,
       round(rc.food_cost_rm / NULLIF(rc.selling_price_ex_sst_rm, 0) * 100, 2) AS food_cost_pct
FROM public.v_recipe_cost rc
WHERE rc.kind = 'dish';

-- Cost drift: snapshot line cost vs. the same quantity at the supplier item's current price.
CREATE OR REPLACE VIEW public.v_cost_drift WITH (security_invoker = true) AS
SELECT b.id AS bom_line_id, b.entity_code, COALESCE(m.name, s.name) AS parent_name,
       CASE WHEN b.menu_item_id IS NOT NULL THEN 'dish' ELSE 'sub-recipe' END AS parent_kind,
       b.component_name, si.item_name AS supplier_item, b.base_qty, b.line_cost_rm AS snapshot_cost_rm,
       round(b.base_qty * si.unit_cost_rm, 6) AS current_cost_rm,
       round(b.base_qty * si.unit_cost_rm - b.line_cost_rm, 6) AS drift_rm,
       round((b.base_qty * si.unit_cost_rm - b.line_cost_rm) / NULLIF(b.line_cost_rm, 0) * 100, 2) AS drift_pct
FROM public.bom_lines b
JOIN public.supplier_items si ON si.id = b.supplier_item_id
LEFT JOIN public.menu_items m ON m.id = b.menu_item_id
LEFT JOIN public.sub_recipes s ON s.id = b.sub_recipe_id
WHERE b.status = 'active' AND b.cost_complete AND b.price_basis = 'list' AND si.unit_cost_rm IS NOT NULL;

-- Spend by supplier and ingredient (received quantity x PO unit price).
CREATE OR REPLACE VIEW public.v_spend_by_supplier_ingredient WITH (security_invoker = true) AS
SELECT po.entity_code, s.id AS supplier_id, s.name AS supplier_name, si.ingredient_id, i.name AS ingredient_name,
       poi.raw_material_id, date_trunc('month', po.order_date)::date AS month,
       sum(COALESCE(poi.quantity_received, 0) * poi.unit_price) AS spend_rm,
       sum(COALESCE(poi.quantity_received, 0)) AS qty_received
FROM public.purchase_order_items poi
JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
JOIN public.suppliers s ON s.id = po.supplier_id
LEFT JOIN public.supplier_items si ON si.id = poi.supplier_item_id
LEFT JOIN public.ingredients i ON i.id = si.ingredient_id
GROUP BY 1, 2, 3, 4, 5, 6, 7;

-- Which dishes / sub-recipes each ingredient feeds.
CREATE OR REPLACE VIEW public.v_ingredient_usage WITH (security_invoker = true) AS
SELECT i.id AS ingredient_id, i.name AS ingredient_name, si.id AS supplier_item_id, si.item_name,
       b.entity_code, CASE WHEN b.menu_item_id IS NOT NULL THEN 'dish' ELSE 'sub-recipe' END AS parent_kind,
       COALESCE(m.name, s.name) AS parent_name, COALESCE(m.status, s.status) AS parent_status,
       b.base_qty, b.shared_ingredient
FROM public.bom_lines b
JOIN public.supplier_items si ON si.id = b.supplier_item_id
LEFT JOIN public.ingredients i ON i.id = si.ingredient_id
LEFT JOIN public.menu_items m ON m.id = b.menu_item_id
LEFT JOIN public.sub_recipes s ON s.id = b.sub_recipe_id;

-- Open (unreviewed) >5% price flags for admin review.
CREATE OR REPLACE VIEW public.v_price_flags_open WITH (security_invoker = true) AS
SELECT ph.*, si.item_name, si.procurement_tag
FROM public.price_history ph
JOIN public.supplier_items si ON si.id = ph.supplier_item_id
WHERE ph.flagged_over_5pct AND public.is_profiles_admin()
  AND NOT EXISTS (SELECT 1 FROM public.price_flag_reviews r WHERE r.price_history_id = ph.id);

REVOKE ALL ON public.v_recipe_cost, public.v_dish_cogs, public.v_cost_drift, public.v_spend_by_supplier_ingredient,
  public.v_ingredient_usage, public.v_price_flags_open FROM PUBLIC, anon;
GRANT SELECT ON public.v_recipe_cost, public.v_dish_cogs, public.v_cost_drift, public.v_spend_by_supplier_ingredient,
  public.v_ingredient_usage, public.v_price_flags_open TO authenticated;

REVOKE ALL ON FUNCTION public._price_history_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._price_history_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._supplier_items_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._supplier_items_price_log() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._po_line_supplier_item_active() FROM PUBLIC, anon, authenticated;
