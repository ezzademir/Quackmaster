/*
  Finished-goods lot labels for ink-print and traceability.

  SKU stays on hub/outlet product_batch (recipe default_product_batch).
  Unique printable lot goes on inventory_lots.product_batch_label (SKU-YYMMDD-RUN).
  Production completion creates the lot and links hub_inventory.lot_id.
  Sales FIFO matches SKU or the printed lot code.
*/

-- ---------------------------------------------------------------------------
-- Recipe shelf life
-- ---------------------------------------------------------------------------
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS shelf_life_days integer;

COMMENT ON COLUMN public.recipes.shelf_life_days IS
  'Days from production date to expiry for finished-goods lots. NULL = no auto expiry.';

ALTER TABLE public.recipes
  DROP CONSTRAINT IF EXISTS recipes_shelf_life_days_nonneg;

ALTER TABLE public.recipes
  ADD CONSTRAINT recipes_shelf_life_days_nonneg
  CHECK (shelf_life_days IS NULL OR shelf_life_days >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_lots_product_batch_label_key
  ON public.inventory_lots (product_batch_label);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_lots_production_run_id_key
  ON public.inventory_lots (production_run_id)
  WHERE production_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_production_run_id
  ON public.inventory_lots (production_run_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_fg_sku(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    trim(both '-' from regexp_replace(upper(trim(both from coalesce(p_raw, ''))), '[^A-Z0-9]+', '-', 'g')),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.format_fg_lot_label(p_sku text, p_mfg date, p_run_number text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_sku
    || '-'
    || to_char(COALESCE(p_mfg, CURRENT_DATE), 'YYMMDD')
    || '-'
    || COALESCE(
         lpad((regexp_match(COALESCE(p_run_number, ''), '(\d+)$'))[1], 4, '0'),
         '0000'
       );
$$;

CREATE OR REPLACE FUNCTION public.fg_identifier_matches(p_product_batch text, p_lot_label text, p_query text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    q <> ''
    AND (
      trim(both from coalesce(p_product_batch, '')) = q
      OR trim(both from coalesce(p_lot_label, '')) = q
    )
  FROM (SELECT trim(both from coalesce(p_query, '')) AS q) s;
$$;

REVOKE ALL ON FUNCTION public.normalize_fg_sku(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.format_fg_lot_label(text, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fg_identifier_matches(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_fg_sku(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.format_fg_lot_label(text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fg_identifier_matches(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Production completion: create lot + hub row with SKU + lot_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_production_completion_inventory(
  p_production_run_id uuid,
  p_product_batch text,
  p_finished_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  pr RECORD;
  rec RECORD;
  mat RECORD;
  v_hub_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_new_avail numeric;
  v_sku text;
  v_lot_label text;
  v_lot_id uuid;
  v_parent_lot uuid;
  v_mfg date;
  v_expiry date;
  v_out_id uuid;
  v_iso timestamptz := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_finished_quantity IS NULL OR p_finished_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_finished_quantity');
  END IF;

  SELECT *
  INTO pr
  FROM public.production_runs
  WHERE id = p_production_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'production_run_not_found');
  END IF;

  IF pr.status IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_run_status', 'status', pr.status);
  END IF;

  SELECT r.name, r.default_product_batch, r.shelf_life_days
  INTO rec
  FROM public.recipes r
  WHERE r.id = pr.recipe_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'recipe_not_found');
  END IF;

  v_sku := COALESCE(
    public.normalize_fg_sku(p_product_batch),
    public.normalize_fg_sku(rec.default_product_batch),
    public.normalize_fg_sku(rec.name),
    'FG'
  );

  IF rec.default_product_batch IS NULL OR trim(both from rec.default_product_batch) = '' THEN
    UPDATE public.recipes
    SET default_product_batch = v_sku, updated_at = v_iso
    WHERE id = pr.recipe_id;
  END IF;

  v_mfg := COALESCE(pr.production_date, CURRENT_DATE);
  IF rec.shelf_life_days IS NOT NULL AND rec.shelf_life_days > 0 THEN
    v_expiry := v_mfg + rec.shelf_life_days;
  ELSE
    v_expiry := NULL;
  END IF;

  v_lot_label := public.format_fg_lot_label(v_sku, v_mfg, pr.run_number);

  SELECT hi.lot_id
  INTO v_parent_lot
  FROM public.production_run_materials prm
  JOIN public.hub_inventory hi
    ON hi.raw_material_id = prm.raw_material_id
   AND hi.lot_id IS NOT NULL
  WHERE prm.production_run_id = p_production_run_id
  ORDER BY prm.created_at ASC NULLS LAST
  LIMIT 1;

  IF p_finished_quantity > 0 THEN
    INSERT INTO public.inventory_lots (
      product_batch_label,
      expiry_date,
      manufactured_at,
      parent_lot_id,
      production_run_id,
      created_at,
      updated_at
    )
    VALUES (
      v_lot_label,
      v_expiry,
      v_mfg::timestamptz,
      v_parent_lot,
      p_production_run_id,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_lot_id;

    INSERT INTO public.hub_inventory (
      product_batch,
      lot_id,
      quantity_on_hand,
      reserved_quantity,
      available_quantity,
      last_updated,
      updated_at
    )
    VALUES (
      v_sku,
      v_lot_id,
      p_finished_quantity,
      0,
      p_finished_quantity,
      v_iso,
      v_iso
    )
    RETURNING id INTO v_out_id;
  END IF;

  FOR mat IN
    SELECT prm.raw_material_id, prm.quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
  LOOP
    SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
    INTO v_hub_id, v_qoh, v_res
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    ORDER BY hi.created_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF v_hub_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'raw_material_hub_row_missing',
        'raw_material_id', mat.raw_material_id
      );
    END IF;

    IF v_qoh < mat.quantity_consumed THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_raw_material',
        'raw_material_id', mat.raw_material_id,
        'on_hand', v_qoh,
        'required', mat.quantity_consumed
      );
    END IF;

    v_new_qoh := v_qoh - mat.quantity_consumed;
    v_new_avail := v_new_qoh - v_res;

    UPDATE public.hub_inventory hi
    SET
      quantity_on_hand = v_new_qoh,
      available_quantity = v_new_avail,
      last_updated = v_iso,
      updated_at = v_iso
    WHERE hi.id = v_hub_id;
  END LOOP;

  UPDATE public.production_runs
  SET
    status = 'completed',
    updated_at = v_iso
  WHERE id = p_production_run_id;

  PERFORM public._append_data_ledger(
    'inventory_posted',
    'production_run',
    p_production_run_id::text,
    'production',
    'event',
    NULL,
    jsonb_build_object(
      'hub_inventory_id', v_out_id,
      'product_batch', v_sku,
      'lot_id', v_lot_id,
      'lot_label', v_lot_label,
      'finished_quantity', p_finished_quantity
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'success', true,
    'production_run_id', p_production_run_id,
    'hub_inventory_id', v_out_id,
    'lot_id', v_lot_id,
    'lot_label', v_lot_label,
    'sku', v_sku,
    'expiry_date', v_expiry,
    'manufactured_at', v_mfg,
    'run_number', pr.run_number,
    'finished_quantity', p_finished_quantity
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_completion_inventory(uuid, text, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin delete: find hub by lot.production_run_id, fall back to legacy BATCH-uuid
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_production_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run_status text;
  batch_label text;
  hub_pid uuid;
  hub_preserved numeric;
  lot_id_found uuid;
  mat RECORD;
  hm_id uuid;
  hm_qoh numeric;
  hm_res numeric;
  new_qoh numeric;
  new_avail numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT status INTO run_status
  FROM public.production_runs
  WHERE id = p_run_id;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'Production run not found';
  END IF;

  batch_label := 'BATCH-' || split_part(p_run_id::text, '-', 1);

  IF run_status = 'completed' THEN
    SELECT il.id
    INTO lot_id_found
    FROM public.inventory_lots il
    WHERE il.production_run_id = p_run_id
    LIMIT 1;

    SELECT hi.id, hi.reserved_quantity
    INTO hub_pid, hub_preserved
    FROM public.hub_inventory hi
    WHERE (lot_id_found IS NOT NULL AND hi.lot_id = lot_id_found)
       OR hi.product_batch = batch_label
    ORDER BY CASE WHEN lot_id_found IS NOT NULL AND hi.lot_id = lot_id_found THEN 0 ELSE 1 END
    LIMIT 1;

    IF hub_pid IS NOT NULL THEN
      IF COALESCE(hub_preserved, 0) > 0 THEN
        RAISE EXCEPTION 'Cannot delete: finished goods batch has reserved quantity (resolve distribution orders first)';
      END IF;

      DELETE FROM public.hub_inventory WHERE id = hub_pid;
    END IF;

    DELETE FROM public.inventory_lots WHERE production_run_id = p_run_id;

    FOR mat IN
      SELECT prm.raw_material_id, prm.quantity_consumed
      FROM public.production_run_materials prm
      WHERE prm.production_run_id = p_run_id
    LOOP
      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
      INTO hm_id, hm_qoh, hm_res
      FROM public.hub_inventory hi
      WHERE hi.raw_material_id = mat.raw_material_id
      LIMIT 1;

      IF hm_id IS NOT NULL THEN
        new_qoh := COALESCE(hm_qoh, 0) + COALESCE(mat.quantity_consumed, 0);
        new_avail := new_qoh - hm_res;

        UPDATE public.hub_inventory
        SET
          quantity_on_hand = new_qoh,
          available_quantity = new_avail,
          last_updated = now(),
          updated_at = now()
        WHERE id = hm_id;
      END IF;
    END LOOP;
  END IF;

  DELETE FROM public.production_runs WHERE id = p_run_id;

  RETURN jsonb_build_object('ok', true, 'batch_label', batch_label, 'lot_id', lot_id_found);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_production_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_production_run(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Sales FIFO: match SKU on product_batch OR printed lot label
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_sales_journal_fifo_by_sku(
  p_outlet_id uuid,
  p_business_date date,
  p_sku text,
  p_quantity_sold numeric,
  p_notes text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_journal_id uuid;
  v_sku text := trim(both from p_sku);
  v_remaining numeric;
  v_total_avail numeric := 0;
  r RECORD;
  v_avail numeric;
  v_take numeric;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.sales_journals
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'sales_journal_id', v_existing,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF v_sku IS NULL OR v_sku = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'sku_required');
  END IF;

  IF p_quantity_sold IS NULL OR p_quantity_sold <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity');
  END IF;

  v_remaining := p_quantity_sold;

  FOR r IN
    SELECT
      oi.id,
      oi.product_batch,
      oi.lot_id,
      oi.quantity_on_hand,
      COALESCE(oi.reserved_quantity, 0) AS reserved_qty
    FROM public.outlet_inventory oi
    LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
    WHERE oi.outlet_id = p_outlet_id
      AND oi.quantity_on_hand > 0
      AND public.fg_identifier_matches(oi.product_batch, il.product_batch_label, v_sku)
    ORDER BY
      il.expiry_date ASC NULLS LAST,
      il.manufactured_at ASC NULLS LAST,
      oi.created_at ASC NULLS LAST,
      oi.id ASC
    FOR UPDATE OF oi
  LOOP
    v_total_avail := v_total_avail + GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
  END LOOP;

  IF v_total_avail < p_quantity_sold THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_stock',
      'sku', v_sku,
      'requested', p_quantity_sold,
      'available', v_total_avail
    );
  END IF;

  INSERT INTO public.sales_journals (
    outlet_id,
    business_date,
    status,
    notes,
    idempotency_key,
    created_by
  )
  VALUES (
    p_outlet_id,
    p_business_date,
    'posted',
    p_notes,
    p_idempotency_key,
    v_uid
  )
  RETURNING id INTO v_journal_id;

  v_remaining := p_quantity_sold;

  FOR r IN
    SELECT
      oi.id,
      oi.product_batch,
      oi.lot_id,
      oi.quantity_on_hand,
      COALESCE(oi.reserved_quantity, 0) AS reserved_qty
    FROM public.outlet_inventory oi
    LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
    WHERE oi.outlet_id = p_outlet_id
      AND oi.quantity_on_hand > 0
      AND public.fg_identifier_matches(oi.product_batch, il.product_batch_label, v_sku)
    ORDER BY
      il.expiry_date ASC NULLS LAST,
      il.manufactured_at ASC NULLS LAST,
      oi.created_at ASC NULLS LAST,
      oi.id ASC
    FOR UPDATE OF oi
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_avail := GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
    v_take := LEAST(v_avail, v_remaining);

    IF v_take <= 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.sales_journal_lines (
      sales_journal_id,
      product_batch,
      lot_id,
      quantity_sold,
      outlet_inventory_id
    )
    VALUES (
      v_journal_id,
      trim(both from r.product_batch),
      r.lot_id,
      v_take,
      r.id
    );

    UPDATE public.outlet_inventory oi
    SET
      quantity_on_hand = oi.quantity_on_hand - v_take,
      available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(),
      updated_at = now()
    WHERE oi.id = r.id;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'outlet_inventory_id', r.id,
        'product_batch', trim(both from r.product_batch),
        'quantity_sold', v_take
      )
    );

    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'fifo_alloc_internal_error', 'remaining', v_remaining);
  END IF;

  PERFORM public._append_data_ledger(
    'posted',
    'sales_journal',
    v_journal_id::text,
    'sales',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'business_date', p_business_date,
      'mode', 'fifo_by_sku',
      'sku', v_sku,
      'lines', v_lines
    ),
    NULL,
    jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id,
    'lines', v_lines
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_sales_journal(
  p_outlet_id uuid,
  p_business_date date,
  p_lines jsonb,
  p_notes text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_journal_id uuid;
  rec jsonb;
  v_batch text;
  v_qty numeric;
  v_inv_id uuid;
  v_lot uuid;
  v_o_inv_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
  v_remaining numeric;
  v_take numeric;
  r RECORD;
  v_lines_meta jsonb := '[]'::jsonb;
  v_total_avail numeric;
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.sales_journals
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'sales_journal_id', v_existing,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_qty := (rec->>'quantity_sold')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;

    IF rec ? 'outlet_inventory_id'
       AND rec->>'outlet_inventory_id' IS NOT NULL
       AND trim(rec->>'outlet_inventory_id') <> '' THEN
      v_inv_id := (rec->>'outlet_inventory_id')::uuid;

      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_o_inv_id, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
      FOR UPDATE;

      IF NOT FOUND OR v_o_inv_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_not_found', 'outlet_inventory_id', v_inv_id);
      END IF;

      v_avail := v_qoh - v_res;
      IF v_avail < v_qty THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'insufficient_available',
          'outlet_inventory_id', v_inv_id,
          'available', v_avail,
          'requested', v_qty
        );
      END IF;
    ELSE
      v_batch := trim(rec->>'product_batch');
      IF v_batch IS NULL OR v_batch = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'product_batch_or_outlet_inventory_id_required');
      END IF;

      v_total_avail := 0;
      FOR r IN
        SELECT
          oi.id,
          oi.quantity_on_hand,
          COALESCE(oi.reserved_quantity, 0) AS reserved_qty
        FROM public.outlet_inventory oi
        LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
        WHERE oi.outlet_id = p_outlet_id
          AND oi.quantity_on_hand > 0
          AND public.fg_identifier_matches(oi.product_batch, il.product_batch_label, v_batch)
        ORDER BY
          il.expiry_date ASC NULLS LAST,
          il.manufactured_at ASC NULLS LAST,
          oi.created_at ASC NULLS LAST,
          oi.id ASC
        FOR UPDATE OF oi
      LOOP
        v_total_avail := v_total_avail + GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
      END LOOP;

      IF v_total_avail < v_qty THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'insufficient_stock',
          'product_batch', v_batch,
          'requested', v_qty,
          'available', v_total_avail
        );
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.sales_journals (
    outlet_id,
    business_date,
    status,
    notes,
    idempotency_key,
    created_by
  )
  VALUES (
    p_outlet_id,
    p_business_date,
    'posted',
    p_notes,
    p_idempotency_key,
    v_uid
  )
  RETURNING id INTO v_journal_id;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_qty := (rec->>'quantity_sold')::numeric;

    IF rec ? 'outlet_inventory_id'
       AND rec->>'outlet_inventory_id' IS NOT NULL
       AND trim(rec->>'outlet_inventory_id') <> '' THEN
      v_inv_id := (rec->>'outlet_inventory_id')::uuid;

      SELECT oi.product_batch, oi.lot_id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_batch, v_lot, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.id = v_inv_id AND oi.outlet_id = p_outlet_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'outlet_inventory_row_missing_mid_post', 'outlet_inventory_id', v_inv_id);
      END IF;

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - v_qty,
        available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = v_inv_id;

      INSERT INTO public.sales_journal_lines (
        sales_journal_id,
        product_batch,
        lot_id,
        quantity_sold,
        outlet_inventory_id
      )
      VALUES (v_journal_id, trim(both from v_batch), v_lot, v_qty, v_inv_id);

      v_lines_meta := v_lines_meta || jsonb_build_array(
        jsonb_build_object(
          'outlet_inventory_id', v_inv_id,
          'product_batch', trim(both from v_batch),
          'quantity_sold', v_qty
        )
      );
    ELSE
      v_batch := trim(rec->>'product_batch');
      v_remaining := v_qty;

      FOR r IN
        SELECT
          oi.id AS inv_id,
          oi.product_batch,
          oi.lot_id,
          oi.quantity_on_hand,
          COALESCE(oi.reserved_quantity, 0) AS reserved_qty
        FROM public.outlet_inventory oi
        LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
        WHERE oi.outlet_id = p_outlet_id
          AND oi.quantity_on_hand > 0
          AND public.fg_identifier_matches(oi.product_batch, il.product_batch_label, v_batch)
        ORDER BY
          il.expiry_date ASC NULLS LAST,
          il.manufactured_at ASC NULLS LAST,
          oi.created_at ASC NULLS LAST,
          oi.id ASC
        FOR UPDATE OF oi
      LOOP
        EXIT WHEN v_remaining <= 0;

        v_avail := GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
        v_take := LEAST(v_avail, v_remaining);
        IF v_take <= 0 THEN
          CONTINUE;
        END IF;

        UPDATE public.outlet_inventory oi
        SET
          quantity_on_hand = oi.quantity_on_hand - v_take,
          available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
          last_updated = now(),
          updated_at = now()
        WHERE oi.id = r.inv_id;

        INSERT INTO public.sales_journal_lines (
          sales_journal_id,
          product_batch,
          lot_id,
          quantity_sold,
          outlet_inventory_id
        )
        VALUES (
          v_journal_id,
          trim(both from r.product_batch),
          r.lot_id,
          v_take,
          r.inv_id
        );

        v_lines_meta := v_lines_meta || jsonb_build_array(
          jsonb_build_object(
            'outlet_inventory_id', r.inv_id,
            'product_batch', trim(both from r.product_batch),
            'quantity_sold', v_take
          )
        );

        v_remaining := v_remaining - v_take;
      END LOOP;

      IF v_remaining > 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'fifo_line_alloc_failed', 'remaining', v_remaining, 'product_batch', v_batch);
      END IF;
    END IF;
  END LOOP;

  PERFORM public._append_data_ledger(
    'posted',
    'sales_journal',
    v_journal_id::text,
    'sales',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'business_date', p_business_date,
      'lines', v_lines_meta
    ),
    NULL,
    jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_sales_journal(uuid, date, jsonb, text, uuid) TO authenticated;
