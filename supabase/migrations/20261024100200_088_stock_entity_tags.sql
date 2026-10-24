/*
  088: every NEW stock posting carries a business-entity tag (Quackteow 'QT' / Merdeka House 'MH').

  Why: MH stock posts into the single shared hub. Read-only inspection of live (24 Oct 2026) shows hub_inventory holds
    - one running balance per RAW MATERIAL (no unique key, no lot, no entity) that mixes every PO and, now, both entities, and
    - one row per finished-goods lot (product_batch + lot_id), never more than one row per lot.
  A single tag per hub row therefore cannot work for raw materials. The tag lives on the MOVEMENT (hub_stock_movements,
  outlet_stock_movements) and on the LOT (inventory_lots); the hub balance is REPORTED split by tag (v_hub_stock_by_entity).

  Existing rows: untouched. entity_code is nullable, there is NO backfill and NO guessed tag. Old movements / lots stay valid
  and readable; the hub quantity not explained by tagged movements is reported as the UNTAGGED bucket (entity_code NULL).

  Enforcement (new postings only, in the DB):
    - Purchase-order receipts and PO-cancel reversals: ALWAYS tagged from the PO's entity_code; a receipt on a PO with no
      entity is refused (po_entity_required_for_receipt). This path is wired here, nothing else has to change.
    - Every other posting path (production, adjustments, dispatch, waste, sales ...) is switched per scope in
      stock_tag_enforcement and ships with enforced = false: those 25 live RPCs do not carry a tag yet, and which entity a
      production run / outlet belongs to is a business input (outlet -> entity mapping is empty today). When a scope is on,
      an untagged new posting is refused with stock_entity_tag_required. A path supplies its tag with set_stock_entity(),
      or through the lot / outlet mapping resolution below. Admins flip a scope with set_stock_tag_enforcement().
  Resolution order for a new posting: set_stock_entity() in this transaction > the lot's entity_code > the outlet's
  delivery_location_entities mapping > none.
  The transaction-local tag lasts to the end of the transaction; a function that posts for two entities in one transaction
  must call set_stock_entity() again between them.
*/

CREATE TABLE IF NOT EXISTS public.stock_tag_enforcement (
  scope text PRIMARY KEY CHECK (scope IN ('hub_rm', 'hub_fg', 'lots', 'outlet_movements')),
  enforced boolean NOT NULL DEFAULT false,
  note text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.stock_tag_enforcement (scope, enforced, note) VALUES
  ('hub_rm', false, 'raw-material postings other than PO receipts (production use, adjustments, waste)'),
  ('hub_fg', false, 'finished-goods postings on the hub (production completion, dispatch, void)'),
  ('lots', false, 'new inventory_lots rows'),
  ('outlet_movements', false, 'outlet_stock_movements (needs the outlet -> entity mapping first)')
ON CONFLICT (scope) DO NOTHING;
ALTER TABLE public.stock_tag_enforcement ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_tag_enforcement_staff ON public.stock_tag_enforcement;
CREATE POLICY stock_tag_enforcement_staff ON public.stock_tag_enforcement FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS stock_tag_enforcement_deny_procurement ON public.stock_tag_enforcement;
CREATE POLICY stock_tag_enforcement_deny_procurement ON public.stock_tag_enforcement AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_procurement_user()) WITH CHECK (NOT public.is_procurement_user());
REVOKE ALL ON public.stock_tag_enforcement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_tag_enforcement TO authenticated;

CREATE OR REPLACE FUNCTION public._stock_tag_enforced(p_scope text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT enforced FROM public.stock_tag_enforcement WHERE scope = p_scope), false);
$$;
REVOKE ALL ON FUNCTION public._stock_tag_enforced(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_stock_tag_enforcement(p_scope text, p_enforced boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_profiles_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'forbidden'); END IF;
  UPDATE public.stock_tag_enforcement SET enforced = p_enforced, updated_by = auth.uid(), updated_at = now() WHERE scope = p_scope;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'unknown_scope'); END IF;
  PERFORM public._append_data_ledger('updated', 'stock_tag_enforcement', p_scope, 'inventory', 'update', NULL, NULL,
    jsonb_build_object('scope', p_scope, 'enforced', p_enforced), NULL, NULL);
  RETURN jsonb_build_object('success', true, 'scope', p_scope, 'enforced', p_enforced);
END $$;
REVOKE ALL ON FUNCTION public.set_stock_tag_enforcement(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_stock_tag_enforcement(text, boolean) TO authenticated;

-- ---------------------------------------------------------------- columns (nullable: old rows stay untagged)
ALTER TABLE public.inventory_lots ADD COLUMN IF NOT EXISTS entity_code text REFERENCES public.business_entities(code);
ALTER TABLE public.outlet_stock_movements ADD COLUMN IF NOT EXISTS entity_code text REFERENCES public.business_entities(code);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_entity ON public.inventory_lots (entity_code);
CREATE INDEX IF NOT EXISTS idx_osm_entity ON public.outlet_stock_movements (entity_code);

-- Hub movement ledger: one row per change of hub_inventory.quantity_on_hand from now on (nothing is backfilled).
CREATE TABLE IF NOT EXISTS public.hub_stock_movements (
  id bigserial PRIMARY KEY,
  hub_inventory_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rm', 'fg')),
  raw_material_id uuid,
  lot_id uuid,
  quantity numeric NOT NULL,            -- signed change in quantity_on_hand
  qoh_after numeric,
  entity_code text REFERENCES public.business_entities(code),   -- NULL only while that scope is not enforced
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_stock_movements_hub_idx ON public.hub_stock_movements (hub_inventory_id);
CREATE INDEX IF NOT EXISTS hub_stock_movements_entity_idx ON public.hub_stock_movements (entity_code);
ALTER TABLE public.hub_stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hub_stock_movements_staff_select ON public.hub_stock_movements;
CREATE POLICY hub_stock_movements_staff_select ON public.hub_stock_movements FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
DROP POLICY IF EXISTS hub_stock_movements_deny_procurement ON public.hub_stock_movements;
CREATE POLICY hub_stock_movements_deny_procurement ON public.hub_stock_movements AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_procurement_user()) WITH CHECK (NOT public.is_procurement_user());
REVOKE ALL ON public.hub_stock_movements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.hub_stock_movements TO authenticated;   -- written only by the trigger below

-- ---------------------------------------------------------------- tag resolution
CREATE OR REPLACE FUNCTION public.set_stock_entity(p_entity_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_entity_code IS NULL OR NOT EXISTS (SELECT 1 FROM public.business_entities WHERE code = p_entity_code) THEN
    RAISE EXCEPTION 'unknown_stock_entity' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.stock_entity', p_entity_code, true);
END $$;
-- callable by the SECURITY DEFINER posting RPCs (owner) and service_role only; a client cannot carry a tag across requests
REVOKE ALL ON FUNCTION public.set_stock_entity(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_stock_entity(text) TO service_role;

CREATE OR REPLACE FUNCTION public._resolve_stock_entity(p_lot uuid, p_outlet uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v text := NULLIF(current_setting('app.stock_entity', true), '');
BEGIN
  IF v IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.business_entities WHERE code = v) THEN
      RAISE EXCEPTION 'unknown_stock_entity' USING ERRCODE = 'P0001';
    END IF;
    RETURN v;
  END IF;
  IF p_lot IS NOT NULL THEN
    SELECT entity_code INTO v FROM public.inventory_lots WHERE id = p_lot;
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  IF p_outlet IS NOT NULL THEN
    SELECT entity_code INTO v FROM public.delivery_location_entities WHERE location_kind = 'outlet' AND outlet_id = p_outlet;
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._resolve_stock_entity(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- hub postings -> tagged movement rows
CREATE OR REPLACE FUNCTION public._hub_inventory_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_delta numeric; v_entity text; v_kind text;
BEGIN
  v_delta := COALESCE(NEW.quantity_on_hand, 0) - CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.quantity_on_hand, 0) ELSE 0 END;
  IF v_delta = 0 THEN RETURN NULL; END IF;
  v_kind := CASE WHEN NEW.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END;
  v_entity := public._resolve_stock_entity(NEW.lot_id, NULL);
  IF v_entity IS NULL AND public._stock_tag_enforced('hub_' || v_kind) THEN
    RAISE EXCEPTION 'stock_entity_tag_required' USING ERRCODE = 'P0001',
      DETAIL = 'hub ' || v_kind || ' posting without a Quackteow / Merdeka House tag';
  END IF;
  INSERT INTO public.hub_stock_movements (hub_inventory_id, kind, raw_material_id, lot_id, quantity, qoh_after, entity_code)
  VALUES (NEW.id, v_kind, NEW.raw_material_id, NEW.lot_id, v_delta, NEW.quantity_on_hand, v_entity);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._hub_inventory_movement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_hub_inventory_movement ON public.hub_inventory;
CREATE TRIGGER trg_hub_inventory_movement AFTER INSERT OR UPDATE OF quantity_on_hand ON public.hub_inventory
  FOR EACH ROW EXECUTE FUNCTION public._hub_inventory_movement();

-- PO receipts / cancel reversals: the tag is the PO's entity (always required for a receipt).
CREATE OR REPLACE FUNCTION public._po_item_stock_entity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_entity text;
BEGIN
  IF NEW.quantity_received IS DISTINCT FROM OLD.quantity_received THEN
    SELECT entity_code INTO v_entity FROM public.purchase_orders WHERE id = NEW.purchase_order_id;
    IF v_entity IS NULL THEN
      RAISE EXCEPTION 'po_entity_required_for_receipt' USING ERRCODE = 'P0001',
        DETAIL = 'set the PO entity (QT / MH) before receiving; see v_po_entity_unresolved';
    END IF;
    PERFORM set_config('app.stock_entity', v_entity, true);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._po_item_stock_entity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS po_item_stock_entity ON public.purchase_order_items;
CREATE TRIGGER po_item_stock_entity BEFORE UPDATE OF quantity_received ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._po_item_stock_entity();

CREATE OR REPLACE FUNCTION public._po_cancel_stock_entity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.entity_code IS NOT NULL THEN
    PERFORM set_config('app.stock_entity', NEW.entity_code, true);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._po_cancel_stock_entity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS po_cancel_stock_entity ON public.purchase_orders;
CREATE TRIGGER po_cancel_stock_entity BEFORE UPDATE OF status ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._po_cancel_stock_entity();

-- ---------------------------------------------------------------- lots + outlet movements
CREATE OR REPLACE FUNCTION public._inventory_lot_entity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.entity_code := COALESCE(NEW.entity_code, public._resolve_stock_entity(NULL, NULL));
    IF NEW.entity_code IS NULL AND public._stock_tag_enforced('lots') THEN
      RAISE EXCEPTION 'stock_entity_tag_required' USING ERRCODE = 'P0001', DETAIL = 'new inventory lot without a tag';
    END IF;
  ELSIF OLD.entity_code IS NOT NULL AND NEW.entity_code IS DISTINCT FROM OLD.entity_code THEN
    RAISE EXCEPTION 'stock_entity_tag_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._inventory_lot_entity_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS inventory_lot_entity_guard ON public.inventory_lots;
CREATE TRIGGER inventory_lot_entity_guard BEFORE INSERT OR UPDATE ON public.inventory_lots
  FOR EACH ROW EXECUTE FUNCTION public._inventory_lot_entity_guard();

CREATE OR REPLACE FUNCTION public._outlet_movement_entity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lot uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.entity_code IS NULL THEN
      SELECT oi.lot_id INTO v_lot FROM public.outlet_inventory oi WHERE oi.id = NEW.outlet_inventory_id;
      NEW.entity_code := public._resolve_stock_entity(v_lot, NEW.outlet_id);
    END IF;
    IF NEW.entity_code IS NULL AND public._stock_tag_enforced('outlet_movements') THEN
      RAISE EXCEPTION 'stock_entity_tag_required' USING ERRCODE = 'P0001', DETAIL = 'outlet movement without a tag';
    END IF;
  ELSIF OLD.entity_code IS NOT NULL AND NEW.entity_code IS DISTINCT FROM OLD.entity_code THEN
    RAISE EXCEPTION 'stock_entity_tag_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._outlet_movement_entity_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS outlet_movement_entity_guard ON public.outlet_stock_movements;
CREATE TRIGGER outlet_movement_entity_guard BEFORE INSERT OR UPDATE ON public.outlet_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public._outlet_movement_entity_guard();

-- ---------------------------------------------------------------- reports, filterable by tag
-- Hub balance split by tag: tagged movements per hub row, plus the UNTAGGED bucket (entity_code NULL) = quantity on hand
-- not explained by tagged movements (all pre-088 stock, and any posting made while its scope was not enforced).
CREATE OR REPLACE VIEW public.v_hub_stock_by_entity WITH (security_invoker = true) AS
SELECT h.id AS hub_inventory_id, h.raw_material_id, h.lot_id, h.product_batch, t.entity_code, t.quantity_on_hand
FROM public.hub_inventory h
CROSS JOIN LATERAL (
  SELECT m.entity_code, sum(m.quantity) AS quantity_on_hand
  FROM public.hub_stock_movements m
  WHERE m.hub_inventory_id = h.id AND m.entity_code IS NOT NULL
  GROUP BY m.entity_code
  UNION ALL
  SELECT NULL::text, COALESCE(h.quantity_on_hand, 0) - COALESCE((SELECT sum(m2.quantity) FROM public.hub_stock_movements m2
                                                                  WHERE m2.hub_inventory_id = h.id AND m2.entity_code IS NOT NULL), 0)
) t
WHERE t.quantity_on_hand <> 0;

CREATE OR REPLACE VIEW public.v_stock_movements WITH (security_invoker = true) AS
SELECT 'hub'::text AS scope, m.id::text AS movement_id, m.created_at, m.entity_code, m.kind AS movement_type,
       NULL::uuid AS outlet_id, m.quantity AS signed_qty, m.qoh_after
FROM public.hub_stock_movements m
UNION ALL
SELECT 'outlet'::text, o.id::text, o.created_at, o.entity_code, o.movement_type, o.outlet_id, o.signed_qty, o.qoh_after
FROM public.outlet_stock_movements o;
REVOKE ALL ON public.v_hub_stock_by_entity, public.v_stock_movements FROM PUBLIC, anon;
GRANT SELECT ON public.v_hub_stock_by_entity, public.v_stock_movements TO authenticated;
