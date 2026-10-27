/*
  Phase 1 — ingredient sourcing prices.

  The costing master already lives on ingredients + supplier_items.
  unit_cost_rm is generated (price_rm / pack_qty_base) and is not written directly.

  This migration:
    - marks one preferred supplier item per ingredient
    - records invoice/receipt prices through record_invoice_price_update
    - keeps price_history append-only, with an effective date and source id
    - makes record_po_delivery refresh the live supplier-item price
    - exposes v_ingredient_sourcing_comparison (security invoker)

  Receipt payload key invoice_unit_price stays the pack price (price_rm).
  Pack size in the ingredient base unit is supplier_items.pack_qty_base.
*/

ALTER TABLE public.supplier_items
  ADD COLUMN IF NOT EXISTS is_preferred boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.supplier_items.is_preferred IS
  'Preferred vendor for this ingredient. At most one active preferred row per ingredient.';

CREATE UNIQUE INDEX IF NOT EXISTS supplier_items_one_preferred_per_ingredient
  ON public.supplier_items (ingredient_id)
  WHERE is_preferred AND status = 'active' AND ingredient_id IS NOT NULL;

ALTER TABLE public.price_history
  ADD COLUMN IF NOT EXISTS effective_date date,
  ADD COLUMN IF NOT EXISTS source_id uuid;

-- price_history rejects updates. Lift that guard only for this backfill.
DO $$
BEGIN
  ALTER TABLE public.price_history DISABLE TRIGGER price_history_no_update;

  UPDATE public.price_history
  SET effective_date = entered_at::date
  WHERE effective_date IS NULL;

  ALTER TABLE public.price_history ENABLE TRIGGER price_history_no_update;
EXCEPTION
  WHEN OTHERS THEN
    ALTER TABLE public.price_history ENABLE TRIGGER price_history_no_update;
    RAISE;
END $$;

ALTER TABLE public.price_history
  ALTER COLUMN effective_date SET DEFAULT CURRENT_DATE;

ALTER TABLE public.price_history
  ALTER COLUMN effective_date SET NOT NULL;

COMMENT ON COLUMN public.price_history.effective_date IS
  'Business date the price applies. entered_at is when the row was written.';

COMMENT ON COLUMN public.price_history.source_id IS
  'Origin row for this observation. For source = receipt this matches purchase_order_item_id.';

ALTER TABLE public.price_history DROP CONSTRAINT IF EXISTS price_history_source_check;

ALTER TABLE public.price_history
  ADD CONSTRAINT price_history_source_check
  CHECK (source = ANY (ARRAY['seed'::text, 'list'::text, 'receipt'::text, 'manual'::text, 'invoice'::text]));

-- One preferred vendor per ingredient. Priced rows win; ties break on created_at, then id.
DO $$
BEGIN
  ALTER TABLE public.supplier_items DISABLE TRIGGER USER;

  UPDATE public.supplier_items si
  SET is_preferred = true
  WHERE si.status = 'active'
    AND si.ingredient_id IS NOT NULL
    AND si.is_preferred = false
    AND NOT EXISTS (
      SELECT 1
      FROM public.supplier_items pref
      WHERE pref.ingredient_id = si.ingredient_id
        AND pref.status = 'active'
        AND pref.is_preferred
    )
    AND si.id = (
      SELECT s2.id
      FROM public.supplier_items s2
      WHERE s2.ingredient_id = si.ingredient_id
        AND s2.status = 'active'
      ORDER BY (s2.unit_cost_rm IS NULL), s2.unit_cost_rm, s2.created_at, s2.id
      LIMIT 1
    );

  ALTER TABLE public.supplier_items ENABLE TRIGGER USER;
EXCEPTION
  WHEN OTHERS THEN
    ALTER TABLE public.supplier_items ENABLE TRIGGER USER;
    RAISE;
END $$;

CREATE OR REPLACE FUNCTION public._price_history_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prev numeric;
BEGIN
  NEW.entered_by := COALESCE(auth.uid(), NEW.entered_by);
  NEW.entered_at := now();
  NEW.effective_date := COALESCE(NEW.effective_date, CURRENT_DATE);

  IF NEW.unit_cost_rm IS NULL AND NEW.pack_qty_base IS NOT NULL AND NEW.pack_qty_base > 0 THEN
    NEW.unit_cost_rm := NEW.price_rm / NEW.pack_qty_base;
  END IF;

  SELECT ph.unit_cost_rm
  INTO v_prev
  FROM public.price_history ph
  WHERE ph.supplier_item_id = NEW.supplier_item_id
    AND ph.unit_cost_rm IS NOT NULL
  ORDER BY ph.entered_at DESC, ph.id DESC
  LIMIT 1;

  NEW.previous_unit_cost_rm := v_prev;

  IF v_prev IS NOT NULL AND v_prev > 0 AND NEW.unit_cost_rm IS NOT NULL THEN
    NEW.pct_change := round((NEW.unit_cost_rm - v_prev) / v_prev * 100, 4);
    NEW.flagged_over_5pct := NEW.unit_cost_rm > v_prev * 1.05;
  ELSE
    NEW.pct_change := NULL;
    NEW.flagged_over_5pct := false;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._supplier_items_price_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- record_invoice_price_update writes the history row itself.
  IF current_setting('app.price_log_suppress', true) = '1' THEN
    RETURN NULL;
  END IF;

  IF NEW.price_rm IS NOT NULL AND (
    TG_OP = 'INSERT'
    OR NEW.price_rm IS DISTINCT FROM OLD.price_rm
    OR NEW.pack_qty_base IS DISTINCT FROM OLD.pack_qty_base
  ) THEN
    INSERT INTO public.price_history (
      supplier_item_id,
      price_rm,
      pack_qty_base,
      unit_cost_rm,
      source,
      note,
      purchase_order_item_id,
      effective_date,
      source_id
    )
    VALUES (
      NEW.id,
      NEW.price_rm,
      NEW.pack_qty_base,
      NEW.unit_cost_rm,
      COALESCE(
        NULLIF(current_setting('app.price_source', true), ''),
        CASE WHEN TG_OP = 'INSERT' THEN 'list' ELSE 'manual' END
      ),
      NULLIF(current_setting('app.price_note', true), ''),
      NULLIF(current_setting('app.price_po_item_id', true), '')::uuid,
      COALESCE(NULLIF(current_setting('app.price_effective_date', true), '')::date, CURRENT_DATE),
      NULLIF(current_setting('app.price_source_id', true), '')::uuid
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_invoice_price_update(
  p_supplier_item_id uuid,
  p_pack_price numeric,
  p_pack_size_base numeric,
  p_source_type text,
  p_source_id uuid DEFAULT NULL,
  p_effective_date date DEFAULT CURRENT_DATE
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item public.supplier_items%ROWTYPE;
  v_history_id bigint;
  v_source text;
  v_basis text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;

  IF NOT (public.is_authenticated_active_staff() OR public.is_procurement_user()) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001';
  END IF;

  v_source := lower(btrim(COALESCE(p_source_type, '')));
  IF v_source NOT IN ('receipt', 'invoice', 'manual', 'list') THEN
    RAISE EXCEPTION 'invalid_source_type' USING ERRCODE = 'P0001';
  END IF;

  IF p_pack_price IS NULL OR p_pack_price < 0 THEN
    RAISE EXCEPTION 'invalid_pack_price' USING ERRCODE = 'P0001';
  END IF;

  IF p_pack_size_base IS NULL OR p_pack_size_base <= 0 THEN
    RAISE EXCEPTION 'invalid_pack_size' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
  INTO v_item
  FROM public.supplier_items
  WHERE id = p_supplier_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_item_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF v_item.status = 'inactive' THEN
    RAISE EXCEPTION 'supplier_item_inactive' USING ERRCODE = 'P0001';
  END IF;

  v_basis := CASE
    WHEN v_source IN ('receipt', 'invoice') THEN 'receipt'
    WHEN v_item.price_basis = 'pending' THEN 'list'
    ELSE v_item.price_basis
  END;

  INSERT INTO public.price_history (
    supplier_item_id,
    price_rm,
    pack_qty_base,
    unit_cost_rm,
    source,
    purchase_order_item_id,
    source_id,
    effective_date,
    note
  )
  VALUES (
    v_item.id,
    p_pack_price,
    p_pack_size_base,
    p_pack_price / p_pack_size_base,
    v_source,
    CASE WHEN v_source = 'receipt' THEN p_source_id ELSE NULL END,
    p_source_id,
    COALESCE(p_effective_date, CURRENT_DATE),
    CASE v_source
      WHEN 'receipt' THEN 'PO receipt'
      WHEN 'invoice' THEN 'Supplier invoice'
      ELSE NULL
    END
  )
  RETURNING id INTO v_history_id;

  -- History is already written. Suppress the supplier-item price trigger.
  PERFORM set_config('app.price_log_suppress', '1', true);

  UPDATE public.supplier_items
  SET
    price_rm = p_pack_price,
    pack_qty_base = p_pack_size_base,
    price_basis = v_basis
  WHERE id = v_item.id;

  PERFORM set_config('app.price_log_suppress', '', true);

  RETURN v_history_id;
END;
$$;

COMMENT ON FUNCTION public.record_invoice_price_update(uuid, numeric, numeric, text, uuid, date) IS
  'Append a price_history row and set the supplier item pack price. unit_cost_rm is generated from price_rm / pack_qty_base.';

REVOKE ALL ON FUNCTION public.record_invoice_price_update(uuid, numeric, numeric, text, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_invoice_price_update(uuid, numeric, numeric, text, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_price_update(uuid, numeric, numeric, text, uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.record_po_delivery(
  p_po_id uuid,
  p_lines jsonb,
  p_do_number text DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_document_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_res jsonb;
  v_line jsonb;
  v_item record;
  v_cur numeric;
  v_uom text;
  v_price_txt text;
  v_price numeric;
  v_item_status text;
BEGIN
  IF NOT (public.is_authenticated_active_staff() OR public.procurement_has_po(p_po_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_lines');
  END IF;
  IF public.is_procurement_user() AND COALESCE(nullif(trim(p_document_path), ''), nullif(trim(p_do_number), ''),
       nullif(trim(p_invoice_number), '')) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'do_or_invoice_required');
  END IF;
  -- Every line must belong to this PO (receive_po_shipment re-checks quantities, tolerance and status).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
             WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_items poi
                               WHERE poi.id = (l->>'purchase_order_item_id')::uuid AND poi.purchase_order_id = p_po_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'line_not_on_po');
  END IF;
  -- Received quantity is a CUMULATIVE total (081): this function may only raise it. A lower value would post a
  -- negative delta against hub stock; reductions are an admin job (adjust_po_receipt). Serialise per PO first so
  -- two concurrent deliveries cannot each pass the check against the same old total.
  PERFORM 1 FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF (SELECT count(*) <> count(DISTINCT l->>'purchase_order_item_id') FROM jsonb_array_elements(p_lines) l) THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_line',
      'message', 'Each PO line may appear once per delivery.');
  END IF;
  PERFORM 1 FROM public.purchase_order_items poi
    WHERE poi.id IN (SELECT (l->>'purchase_order_item_id')::uuid FROM jsonb_array_elements(p_lines) l)
    ORDER BY poi.id FOR UPDATE;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF NULLIF(v_line->>'quantity_received', '') IS NULL OR (v_line->>'quantity_received')::numeric < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity_received',
        'purchase_order_item_id', v_line->>'purchase_order_item_id');
    END IF;
    SELECT COALESCE(poi.quantity_received, 0), poi.purchase_uom INTO v_cur, v_uom FROM public.purchase_order_items poi
      WHERE poi.id = (v_line->>'purchase_order_item_id')::uuid;
    -- S8: unit of measure. If the screen sends one it must be the PO line's own unit (a "5 kg" typed against a "g" line
    -- would post 1000x the stock). Checked here, before anything is posted.
    IF NULLIF(trim(v_line->>'quantity_uom'), '') IS NOT NULL THEN
      IF NULLIF(trim(v_uom), '') IS NOT NULL THEN
        IF public._canon_uom(v_line->>'quantity_uom') IS DISTINCT FROM public._canon_uom(v_uom) THEN
          RETURN jsonb_build_object('success', false, 'error', 'uom_mismatch',
            'purchase_order_item_id', v_line->>'purchase_order_item_id', 'line_uom', trim(v_uom), 'entered_uom', v_line->>'quantity_uom',
            'message', 'Unit of measure does not match the PO line. Enter the quantity in ' || trim(v_uom) || '.');
        END IF;
      ELSIF public._canon_uom(v_line->>'quantity_uom') NOT IN ('kg', 'g', 'unit', 'pc', 'pack', 'l', 'ml') THEN
        -- the PO line carries no unit, so the entered one must be a known unit
        RETURN jsonb_build_object('success', false, 'error', 'invalid_uom',
          'purchase_order_item_id', v_line->>'purchase_order_item_id', 'entered_uom', v_line->>'quantity_uom');
      END IF;
    END IF;
    -- S8: the invoice price is optional. Absent / null / blank is fine (receipt recorded without a price, no price-history
    -- row); a value that is not a non-negative number is refused up front instead of aborting the receipt mid-way.
    v_price_txt := NULLIF(trim(v_line->>'invoice_unit_price'), '');
    IF v_price_txt IS NOT NULL AND v_price_txt !~ '^[0-9]+(\.[0-9]+)?$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_invoice_price',
        'purchase_order_item_id', v_line->>'purchase_order_item_id',
        'message', 'Invoice unit price must be a number (0 or more), or left blank.');
    END IF;
    -- optimistic check: the screen sends the total it showed; if someone else received since, refuse instead of silently
    -- overwriting (e.g. +4 typed on a stale 5 would otherwise land on 9 when it is now 9). MANDATORY for procurement
    -- (round 2, F8: the cumulative-total contract is exactly where a stale screen or a retried request double-posts);
    -- optional for admin / staff, whose own tools (adjust_po_receipt, scripts) send totals they just read.
    IF public.is_procurement_user() AND NULLIF(btrim(v_line->>'expected_previous_received'), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'expected_previous_received_required',
        'purchase_order_item_id', v_line->>'purchase_order_item_id', 'current_received', v_cur,
        'message', 'Send expected_previous_received (the received total you saw) with every line.');
    END IF;
    IF NULLIF(v_line->>'expected_previous_received', '') IS NOT NULL
       AND (v_line->>'expected_previous_received')::numeric <> v_cur THEN
      RETURN jsonb_build_object('success', false, 'error', 'stale_received_quantity',
        'purchase_order_item_id', v_line->>'purchase_order_item_id', 'current_received', v_cur,
        'message', 'Another delivery was recorded on this line. Reload and enter this delivery again.');
    END IF;
    IF (v_line->>'quantity_received')::numeric < v_cur THEN
      RETURN jsonb_build_object('success', false, 'error', 'cannot_reduce_received',
        'purchase_order_item_id', v_line->>'purchase_order_item_id', 'current_received', v_cur,
        'entered', (v_line->>'quantity_received')::numeric,
        'message', 'Received quantity can only go up. Send the new cumulative total (already received + this delivery). A reduction needs an admin adjustment.');
    END IF;
  END LOOP;
  IF public.is_procurement_user() THEN
    INSERT INTO public.po_receipt_tickets (purchase_order_id, user_id, txid)
    VALUES (p_po_id, auth.uid(), txid_current()) ON CONFLICT DO NOTHING;
  END IF;
  v_res := public.receive_po_shipment(p_po_id, p_lines);
  DELETE FROM public.po_receipt_tickets WHERE purchase_order_id = p_po_id AND user_id = auth.uid();
  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
    RETURN v_res;
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT poi.id, poi.supplier_item_id, poi.purchase_uom, si.pack_qty_base, si.status
    INTO v_item
    FROM public.purchase_order_items poi
    LEFT JOIN public.supplier_items si ON si.id = poi.supplier_item_id
    WHERE poi.id = (v_line->>'purchase_order_item_id')::uuid
      AND poi.purchase_order_id = p_po_id;

    -- invoice_unit_price is the pack price (price_rm), not the per-base-unit cost.
    v_price := NULLIF(trim(v_line->>'invoice_unit_price'), '')::numeric;
    v_item_status := v_item.status;

    INSERT INTO public.po_receipt_records (
      purchase_order_id,
      purchase_order_item_id,
      quantity_received,
      quantity_uom,
      invoice_unit_price_rm,
      do_number,
      invoice_number,
      document_path,
      entered_by
    )
    VALUES (
      p_po_id,
      v_item.id,
      (v_line->>'quantity_received')::numeric,
      lower(COALESCE(NULLIF(trim(v_line->>'quantity_uom'), ''), NULLIF(trim(v_item.purchase_uom), ''), 'unit')),
      v_price,
      p_do_number,
      p_invoice_number,
      p_document_path,
      auth.uid()
    );

    IF v_item.supplier_item_id IS NOT NULL AND v_price IS NOT NULL THEN
      IF v_item.pack_qty_base IS NOT NULL
         AND v_item.pack_qty_base > 0
         AND v_item_status IS DISTINCT FROM 'inactive' THEN
        PERFORM public.record_invoice_price_update(
          v_item.supplier_item_id,
          v_price,
          v_item.pack_qty_base,
          'receipt',
          v_item.id,
          CURRENT_DATE
        );
      ELSE
        INSERT INTO public.price_history (
          supplier_item_id,
          price_rm,
          pack_qty_base,
          source,
          purchase_order_item_id,
          note
        )
        VALUES (
          v_item.supplier_item_id,
          v_price,
          v_item.pack_qty_base,
          'receipt',
          v_item.id,
          'PO receipt'
        );
      END IF;
    END IF;
  END LOOP;
  RETURN v_res || jsonb_build_object('recorded_lines', jsonb_array_length(p_lines));
END;
$$;

CREATE OR REPLACE VIEW public.v_ingredient_sourcing_comparison
WITH (security_invoker = true) AS
WITH active_items AS (
  SELECT
    si.id AS supplier_item_id,
    si.supplier_id,
    s.name AS supplier_name,
    si.ingredient_id,
    i.name AS ingredient_name,
    i.base_unit,
    CASE i.base_unit
      WHEN 'g' THEN 'kg'
      WHEN 'ml' THEN 'l'
      ELSE i.base_unit
    END AS canonical_unit,
    CASE i.base_unit
      WHEN 'g' THEN 1000::numeric
      WHEN 'ml' THEN 1000::numeric
      ELSE 1::numeric
    END AS canonical_multiplier,
    si.unit_cost_rm,
    si.price_rm,
    si.pack_qty_base,
    si.price_basis,
    si.is_preferred,
    si.updated_at
  FROM public.supplier_items si
  JOIN public.ingredients i ON i.id = si.ingredient_id
  JOIN public.suppliers s ON s.id = si.supplier_id
  WHERE si.status = 'active'
    AND i.status = 'active'
    AND si.base_unit = i.base_unit
),
priced AS (
  SELECT
    a.*,
    a.unit_cost_rm * a.canonical_multiplier AS normalized_unit_cost
  FROM active_items a
  WHERE a.unit_cost_rm IS NOT NULL
),
lowest AS (
  SELECT DISTINCT ON (ingredient_id)
    ingredient_id,
    supplier_item_id AS lowest_supplier_item_id,
    supplier_id AS lowest_supplier_id,
    supplier_name AS lowest_supplier_name,
    unit_cost_rm AS lowest_unit_cost_rm,
    normalized_unit_cost AS lowest_normalized_unit_cost
  FROM priced
  ORDER BY ingredient_id, normalized_unit_cost ASC, supplier_item_id
),
preferred AS (
  SELECT DISTINCT ON (ingredient_id)
    ingredient_id,
    supplier_item_id AS primary_supplier_item_id,
    supplier_id AS primary_supplier_id,
    supplier_name AS primary_supplier_name,
    unit_cost_rm AS primary_unit_cost_rm,
    normalized_unit_cost AS primary_normalized_unit_cost,
    price_basis AS primary_price_basis,
    updated_at AS primary_updated_at
  FROM priced
  ORDER BY ingredient_id, is_preferred DESC, normalized_unit_cost ASC, supplier_item_id
),
counts AS (
  SELECT
    ingredient_id,
    count(*)::integer AS active_supplier_count,
    count(*) FILTER (WHERE unit_cost_rm IS NOT NULL)::integer AS priced_supplier_count
  FROM active_items
  GROUP BY ingredient_id
)
SELECT
  i.id AS ingredient_id,
  i.name AS ingredient_name,
  i.base_unit,
  CASE i.base_unit
    WHEN 'g' THEN 'kg'
    WHEN 'ml' THEN 'l'
    ELSE i.base_unit
  END AS canonical_unit,
  c.active_supplier_count,
  c.priced_supplier_count,
  p.primary_supplier_item_id,
  p.primary_supplier_id,
  p.primary_supplier_name,
  p.primary_unit_cost_rm,
  p.primary_normalized_unit_cost,
  p.primary_price_basis,
  p.primary_updated_at,
  l.lowest_supplier_item_id,
  l.lowest_supplier_id,
  l.lowest_supplier_name,
  l.lowest_unit_cost_rm,
  l.lowest_normalized_unit_cost,
  (p.primary_supplier_item_id IS NOT NULL AND p.primary_supplier_item_id = l.lowest_supplier_item_id) AS primary_is_lowest,
  CASE
    WHEN p.primary_normalized_unit_cost IS NULL OR l.lowest_normalized_unit_cost IS NULL THEN NULL
    ELSE round(p.primary_normalized_unit_cost - l.lowest_normalized_unit_cost, 6)
  END AS savings_per_canonical_unit,
  CASE
    WHEN p.primary_normalized_unit_cost IS NULL
      OR p.primary_normalized_unit_cost = 0
      OR l.lowest_normalized_unit_cost IS NULL THEN NULL
    ELSE round(
      (p.primary_normalized_unit_cost - l.lowest_normalized_unit_cost)
      / p.primary_normalized_unit_cost * 100,
      2
    )
  END AS savings_percent,
  ph.effective_date AS last_price_effective_date,
  ph.entered_at AS last_price_recorded_at,
  ph.source AS last_price_source,
  ph.unit_cost_rm AS last_unit_cost_rm,
  ph.previous_unit_cost_rm,
  CASE
    WHEN ph.unit_cost_rm IS NULL OR ph.previous_unit_cost_rm IS NULL THEN NULL
    ELSE round(ph.unit_cost_rm - ph.previous_unit_cost_rm, 6)
  END AS last_price_shift_rm,
  ph.pct_change AS last_price_shift_percent
FROM public.ingredients i
JOIN counts c ON c.ingredient_id = i.id
LEFT JOIN preferred p ON p.ingredient_id = i.id
LEFT JOIN lowest l ON l.ingredient_id = i.id
LEFT JOIN LATERAL (
  SELECT
    h.effective_date,
    h.entered_at,
    h.source,
    h.unit_cost_rm,
    h.previous_unit_cost_rm,
    h.pct_change
  FROM public.price_history h
  WHERE h.supplier_item_id = p.primary_supplier_item_id
  ORDER BY h.entered_at DESC, h.id DESC
  LIMIT 1
) ph ON true
WHERE i.status = 'active';

COMMENT ON VIEW public.v_ingredient_sourcing_comparison IS
  'One row per active ingredient. Compares the preferred supplier with the lowest normalized unit cost (g→kg, ml→l).';

GRANT SELECT ON public.v_ingredient_sourcing_comparison TO anon, authenticated, service_role;
