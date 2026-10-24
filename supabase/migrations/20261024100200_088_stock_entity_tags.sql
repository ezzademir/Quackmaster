/*
  Depends on 085 (writes procurement_exposure_allow). Rollback order, newest first: 088 -> 087 -> 085 -> 084. 088_rollback.sql
  also tolerates running after 085's rollback (it skips the 085-owned allow row when the table is gone).

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
INSERT INTO public.procurement_exposure_allow (kind, name, note)
VALUES ('function', 'set_stock_tag_enforcement', 'admin only: refuses unless is_profiles_admin() (a procurement user is never an admin)')
ON CONFLICT (kind, name) DO UPDATE SET note = EXCLUDED.note;

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
  source_po_item_id uuid,               -- PO line behind a receipt / adjustment / cancel reversal (no FK: the line may be deleted with its PO)
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_stock_movements_hub_idx ON public.hub_stock_movements (hub_inventory_id);
CREATE INDEX IF NOT EXISTS hub_stock_movements_entity_idx ON public.hub_stock_movements (entity_code);
CREATE INDEX IF NOT EXISTS hub_stock_movements_po_item_idx ON public.hub_stock_movements (source_po_item_id) WHERE source_po_item_id IS NOT NULL;
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
DECLARE v_delta numeric; v_entity text; v_kind text; v_po_item uuid;
BEGIN
  v_delta := COALESCE(NEW.quantity_on_hand, 0) - CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.quantity_on_hand, 0) ELSE 0 END;
  IF v_delta = 0 THEN RETURN NULL; END IF;
  v_kind := CASE WHEN NEW.raw_material_id IS NOT NULL THEN 'rm' ELSE 'fg' END;
  v_entity := public._resolve_stock_entity(NEW.lot_id, NULL);
  IF v_entity IS NULL AND public._stock_tag_enforced('hub_' || v_kind) THEN
    RAISE EXCEPTION 'stock_entity_tag_required' USING ERRCODE = 'P0001',
      DETAIL = 'hub ' || v_kind || ' posting without a Quackteow / Merdeka House tag';
  END IF;
  -- which PO line this posting belongs to (set by the PO item trigger / cancel_purchase_order); only trusted when the line is
  -- really for this raw material, so a stale transaction-local value can never label an unrelated posting
  v_po_item := NULLIF(current_setting('app.stock_po_item', true), '')::uuid;
  IF v_po_item IS NOT NULL AND (v_kind <> 'rm' OR NOT EXISTS (SELECT 1 FROM public.purchase_order_items poi
                                                                WHERE poi.id = v_po_item AND poi.raw_material_id = NEW.raw_material_id)) THEN
    v_po_item := NULL;
  END IF;
  INSERT INTO public.hub_stock_movements (hub_inventory_id, kind, raw_material_id, lot_id, quantity, qoh_after, entity_code, source_po_item_id)
  VALUES (NEW.id, v_kind, NEW.raw_material_id, NEW.lot_id, v_delta, NEW.quantity_on_hand, v_entity, v_po_item);
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
    PERFORM set_config('app.stock_po_item', NEW.id::text, true);
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

-- ---------------------------------------------------------------- PO cancel: tagged reversal (round 2, F3)
/*
  cancel_purchase_order (live, written before tags existed) reverses received stock with plain hub_inventory updates, so after
  088 the reversal was UNTAGGED (QT +4 from the receipt, UNTAGGED -4 from the cancel). This version, otherwise the same function:
    - reverses each received line with the tag(s) the receipts carried (hub_stock_movements.source_po_item_id): QT receipt -> QT
      reversal, and any quantity received before 088 (no tag) is reversed untagged, never guessed;
    - refuses, before anything is written, when the stock cannot be taken back: hub on hand below what the PO received (stock
      partly used, summed per raw material), below reserved, or the tagged balance would go negative;
    - keeps the PO, as status 'cancelled', when it has receipt records / bills / price history (their foreign keys are ON DELETE
      RESTRICT and are NOT changed): receipt records get a closing "cumulative 0" row, the lines go back to received 0, and the
      PO row stays for the audit trail. A PO with none of those is deleted exactly as before.
*/
CREATE OR REPLACE FUNCTION public._po_cancel_plan(p_po_id uuid)
RETURNS TABLE (item_id uuid, rm_id uuid, tag text, qty numeric, price numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH li AS (
    SELECT poi.id, poi.raw_material_id, COALESCE(poi.quantity_received, 0) AS q, COALESCE(poi.unit_price, 0) AS p
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0
  ), tg AS (
    SELECT li.id, m.entity_code, LEAST(SUM(m.quantity), li.q) AS q
    FROM li JOIN public.hub_stock_movements m ON m.source_po_item_id = li.id AND m.entity_code IS NOT NULL
    GROUP BY li.id, li.q, m.entity_code
    HAVING SUM(m.quantity) > 0
  )
  SELECT tg.id, li.raw_material_id, tg.entity_code, tg.q, li.p FROM tg JOIN li ON li.id = tg.id
  UNION ALL
  SELECT li.id, li.raw_material_id, NULL::text, li.q - COALESCE((SELECT SUM(tg.q) FROM tg WHERE tg.id = li.id), 0), li.p
  FROM li WHERE li.q - COALESCE((SELECT SUM(tg.q) FROM tg WHERE tg.id = li.id), 0) > 0;
$$;
REVOKE ALL ON FUNCTION public._po_cancel_plan(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_step RECORD;
  v_rcv numeric;
  v_rm uuid;
  v_price numeric;
  v_q_sum numeric;
  v_avg numeric;
  v_cost_price numeric;
  v_hub_row uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_avg numeric;
  v_tagged numeric;
  v_keep boolean;
  v_lines jsonb := '[]'::jsonb;
  v_before jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  -- ADMIN ONLY (Ezzad, 24 Oct 2026: "nobody can cancel the purchase order without the approval of the admin"). The live function
  -- also let plain active staff cancel any PO; that is closed here, in the database, so a direct RPC call by staff, procurement
  -- or anon is refused too. (A request / approval path for non-admins is a separate follow-up, 089.)
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only an admin can cancel a purchase order');
  END IF;

  IF p_po_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_po_id');
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_not_found');
  END IF;
  IF v_po.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_cancelled');
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', poi.id,
        'raw_material_id', poi.raw_material_id,
        'quantity_ordered', poi.quantity_ordered,
        'quantity_received', COALESCE(poi.quantity_received, 0),
        'unit_price', COALESCE(poi.unit_price, 0)
      )
      ORDER BY poi.id
    ),
    '[]'::jsonb
  )
  INTO v_before
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = p_po_id;

  -- records that make a hard DELETE impossible (RESTRICT foreign keys): such a PO is kept, as 'cancelled'
  v_keep := EXISTS (SELECT 1 FROM public.po_receipt_records r WHERE r.purchase_order_id = p_po_id)
         OR EXISTS (SELECT 1 FROM public.supplier_bills b WHERE b.purchase_order_id = p_po_id)
         OR EXISTS (SELECT 1 FROM public.price_history ph JOIN public.purchase_order_items poi ON poi.id = ph.purchase_order_item_id
                    WHERE poi.purchase_order_id = p_po_id);

  -- Phase 1: lock + validate everything that must be reversed (no hub/WAC writes).
  PERFORM 1 FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0
   ORDER BY poi.id DESC FOR UPDATE OF poi;

  IF EXISTS (SELECT 1 FROM public.purchase_order_items poi
             WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0 AND poi.raw_material_id IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_raw_material');
  END IF;
  IF v_keep AND v_po.entity_code IS NULL AND EXISTS (SELECT 1 FROM public._po_cancel_plan(p_po_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'po_entity_required',
      'message', 'Set the PO entity (QT / MH) before cancelling a received PO.');
  END IF;
  IF public._stock_tag_enforced('hub_rm') AND EXISTS (SELECT 1 FROM public._po_cancel_plan(p_po_id) pl WHERE pl.tag IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'stock_entity_tag_required',
      'message', 'Part of this PO was received before stock tags existed and cannot be reversed while tags are enforced.');
  END IF;

  -- per raw material (all lines of this PO together)
  FOR v_step IN SELECT pl.rm_id, SUM(pl.qty) AS q FROM public._po_cancel_plan(p_po_id) pl GROUP BY pl.rm_id ORDER BY pl.rm_id LOOP
    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_step.rm_id
    ORDER BY hi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_hub_row IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'cannot_cancel_missing_hub_row', 'raw_material_id', v_step.rm_id);
    END IF;

    IF v_qoh < v_step.q THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_hub_quantity',
        'raw_material_id', v_step.rm_id,
        'on_hand', v_qoh,
        'required_return', v_step.q,
        'message', 'Stock received on this PO has already been partly used (on hand ' || v_qoh || ', needed ' || v_step.q ||
                   '). Nothing was cancelled; reverse the usage first.'
      );
    END IF;

    IF (v_qoh - v_step.q) < v_res THEN
      RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved', 'raw_material_id', v_step.rm_id);
    END IF;

    PERFORM 1 FROM public.raw_materials r WHERE r.id = v_step.rm_id FOR UPDATE;
  END LOOP;

  -- per raw material and tag: the tagged balance must not go negative
  FOR v_step IN SELECT pl.rm_id, pl.tag, SUM(pl.qty) AS q FROM public._po_cancel_plan(p_po_id) pl WHERE pl.tag IS NOT NULL
                GROUP BY pl.rm_id, pl.tag ORDER BY pl.rm_id, pl.tag LOOP
    SELECT COALESCE(SUM(m.quantity), 0) INTO v_tagged
    FROM public.hub_stock_movements m JOIN public.hub_inventory hi ON hi.id = m.hub_inventory_id
    WHERE hi.raw_material_id = v_step.rm_id AND m.entity_code = v_step.tag;
    IF v_tagged < v_step.q THEN
      RETURN jsonb_build_object('success', false, 'error', 'insufficient_tagged_stock',
        'raw_material_id', v_step.rm_id, 'entity_code', v_step.tag, 'on_hand', v_tagged, 'required_return', v_step.q,
        'message', 'Stock received on this PO has already been partly used (' || v_step.tag || ' balance ' || v_tagged ||
                   ', needed ' || v_step.q || '). Nothing was cancelled.');
    END IF;
  END LOOP;

  -- Phase 2: reverse receipts, each with the tag its receipt carried. RAISE on unexpected failure after mutations begin.
  FOR v_step IN SELECT * FROM public._po_cancel_plan(p_po_id) pl ORDER BY pl.item_id DESC, pl.tag NULLS LAST LOOP
    v_rcv := v_step.qty;
    v_rm := v_step.rm_id;
    v_price := v_step.price;

    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_row, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_rm
    ORDER BY hi.created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF v_hub_row IS NULL THEN
      RAISE EXCEPTION 'cannot_cancel_missing_hub_row'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_qoh < v_rcv THEN
      RAISE EXCEPTION 'insufficient_hub_quantity'
        USING ERRCODE = 'P0001';
    END IF;

    IF (v_qoh - v_rcv) < v_res THEN
      RAISE EXCEPTION 'hub_below_reserved'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(SUM(hi.quantity_on_hand), 0)
    INTO v_q_sum
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = v_rm;

    SELECT COALESCE(r.weighted_avg_unit_cost, 0), COALESCE(r.cost_price, 0)
    INTO v_avg, v_cost_price
    FROM public.raw_materials r
    WHERE r.id = v_rm
    FOR UPDATE;

    IF v_q_sum <= 0 THEN
      v_new_avg := v_avg;
    ELSIF (v_q_sum - v_rcv) <= 0 THEN
      v_new_avg := COALESCE(NULLIF(v_cost_price, 0), v_avg, v_price);
    ELSE
      v_new_avg :=
        (v_avg * v_q_sum - v_rcv * v_price)
        / NULLIF(v_q_sum - v_rcv, 0);
      IF v_new_avg IS NULL OR v_new_avg < 0 THEN
        v_new_avg := COALESCE(v_cost_price, 0);
      END IF;
    END IF;

    UPDATE public.raw_materials r
    SET
      weighted_avg_unit_cost = COALESCE(v_new_avg, 0),
      cost_price = COALESCE(v_new_avg, cost_price),
      updated_at = now()
    WHERE r.id = v_rm;

    -- 088: the reversal carries the tag of the receipt it undoes (empty = that part was received untagged)
    PERFORM set_config('app.stock_entity', COALESCE(v_step.tag, ''), true);
    PERFORM set_config('app.stock_po_item', v_step.item_id::text, true);
    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = hi.quantity_on_hand - v_rcv,
      available_quantity = (hi.quantity_on_hand - v_rcv) - COALESCE(hi.reserved_quantity, 0),
      last_updated = now(),
      updated_at = now()
    WHERE hi.id = v_hub_row;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'purchase_order_item_id', v_step.item_id,
        'quantity_reversed', v_rcv,
        'raw_material_id', v_rm,
        'unit_price', v_price,
        'entity_code', v_step.tag
      )
    );
  END LOOP;

  IF v_keep THEN
    -- close the receipt records (they hold CUMULATIVE totals): a final row of 0 per line, then the lines go back to 0
    INSERT INTO public.po_receipt_records (purchase_order_id, purchase_order_item_id, quantity_received, quantity_uom, do_number, entered_by)
    SELECT p_po_id, r.purchase_order_item_id, 0, (array_agg(r.quantity_uom ORDER BY r.id DESC))[1], 'PO CANCELLED', auth.uid()
    FROM public.po_receipt_records r
    JOIN public.purchase_order_items poi ON poi.id = r.purchase_order_item_id AND COALESCE(poi.quantity_received, 0) > 0
    WHERE r.purchase_order_id = p_po_id
    GROUP BY r.purchase_order_item_id;
    UPDATE public.purchase_order_items poi SET quantity_received = 0, line_total = 0
     WHERE poi.purchase_order_id = p_po_id AND COALESCE(poi.quantity_received, 0) > 0;
  END IF;
  PERFORM set_config('app.stock_entity', '', true);
  PERFORM set_config('app.stock_po_item', '', true);

  PERFORM public._append_data_ledger(
    'cancelled',
    'purchase_order',
    p_po_id::text,
    'procurement',
    'event',
    NULL,
    jsonb_build_object(
      'order_number', v_po.order_number,
      'status', v_po.status,
      'lines_before', v_before
    ),
    NULL,
    jsonb_build_object('reversal_lines', v_lines, 'po_kept_as_cancelled', v_keep),
    NULL
  );

  IF v_keep THEN
    UPDATE public.purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = p_po_id;
  ELSE
    DELETE FROM public.purchase_orders WHERE id = p_po_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'reversal_lines', v_lines, 'po_kept_as_cancelled', v_keep);
END;
$function$;
-- Grants stated explicitly (round 3, G6) instead of relying on what 045/063 left in place: no PUBLIC, no anon (the body would refuse
-- an anonymous caller anyway: auth.uid() is NULL), signed-in clients only. CREATE OR REPLACE keeps the grants of the live function.
REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid) TO authenticated;
