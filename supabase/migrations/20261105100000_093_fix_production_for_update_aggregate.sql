/*
  093 — Production completion cannot lock aggregated hub stock.

  Live post_production_completion_inventory (audit_quantity_cost_and_trace)
  validates RM with:

    SELECT SUM(...), COUNT(*) FROM hub_inventory WHERE raw_material_id = ... FOR UPDATE;

  Postgres rejects that: FOR UPDATE is not allowed with aggregate functions.
  The New Production Run form surfaces it as "QC Evaluation Failed".

  Fix: lock the hub rows, then aggregate. Consume path (row-level FOR UPDATE)
  is unchanged. inventory_lot_inputs is created if the unmerged audit
  migration is not in this checkout.
*/

CREATE TABLE IF NOT EXISTS public.inventory_lot_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES public.inventory_lots(id) ON DELETE CASCADE,
  source_lot_id uuid REFERENCES public.inventory_lots(id) ON DELETE SET NULL,
  raw_material_id uuid REFERENCES public.raw_materials(id),
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_lot_inputs_lot_id_idx
  ON public.inventory_lot_inputs (lot_id);

ALTER TABLE public.inventory_lot_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view inventory_lot_inputs" ON public.inventory_lot_inputs;
CREATE POLICY "Authenticated users can view inventory_lot_inputs"
  ON public.inventory_lot_inputs
  FOR SELECT
  TO authenticated
  USING (true);

REVOKE ALL ON TABLE public.inventory_lot_inputs FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.inventory_lot_inputs TO authenticated;

-- 085 denies procurement on every public table unless a later migration classifies the new one.
-- This table records the raw-material lots and quantities inside a finished lot (the recipe).
-- Skip when 085 is not installed; 095 repeats the fence for a database that already ran this file.
DO $lot_inputs_fence$
BEGIN
  IF to_regprocedure('public.is_procurement_user()') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS inventory_lot_inputs_deny_procurement ON public.inventory_lot_inputs';
  EXECUTE $policy$
    CREATE POLICY inventory_lot_inputs_deny_procurement
      ON public.inventory_lot_inputs
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (NOT public.is_procurement_user())
      WITH CHECK (NOT public.is_procurement_user())
  $policy$;
END
$lot_inputs_fence$;

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
  hub RECORD;
  v_sku text;
  v_lot_label text;
  v_lot_id uuid;
  v_parent_lot uuid;
  v_mfg date;
  v_expiry date;
  v_out_id uuid;
  v_iso timestamptz := now();
  v_unreserved numeric;
  v_rows int;
  v_need numeric;
  v_take numeric;
  v_inputs jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_finished_quantity IS NULL OR p_finished_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_finished_quantity');
  END IF;

  SELECT * INTO pr FROM public.production_runs WHERE id = p_production_run_id FOR UPDATE;
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
  v_mfg := COALESCE(pr.production_date, CURRENT_DATE);
  IF rec.shelf_life_days IS NOT NULL AND rec.shelf_life_days > 0 THEN
    v_expiry := v_mfg + rec.shelf_life_days;
  ELSE
    v_expiry := NULL;
  END IF;
  v_lot_label := public.format_fg_lot_label(v_sku, v_mfg, pr.run_number);

  FOR mat IN
    SELECT prm.raw_material_id, SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    -- Lock rows first. The same SELECT cannot both aggregate and FOR UPDATE.
    PERFORM 1
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id
    FOR UPDATE;

    SELECT COALESCE(SUM(GREATEST(hi.quantity_on_hand - COALESCE(hi.reserved_quantity, 0), 0)), 0),
           COUNT(*)::int
      INTO v_unreserved, v_rows
    FROM public.hub_inventory hi
    WHERE hi.raw_material_id = mat.raw_material_id;

    IF v_rows = 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'raw_material_hub_row_missing',
        'raw_material_id', mat.raw_material_id
      );
    END IF;
    IF v_unreserved < mat.quantity_consumed THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_raw_material',
        'raw_material_id', mat.raw_material_id,
        'on_hand', v_unreserved,
        'required', mat.quantity_consumed
      );
    END IF;
  END LOOP;

  FOR mat IN
    SELECT prm.raw_material_id, SUM(COALESCE(prm.quantity_consumed, 0)) AS quantity_consumed
    FROM public.production_run_materials prm
    WHERE prm.production_run_id = p_production_run_id
    GROUP BY prm.raw_material_id
  LOOP
    IF COALESCE(mat.quantity_consumed, 0) <= 0 THEN
      CONTINUE;
    END IF;

    v_need := mat.quantity_consumed;
    FOR hub IN
      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0) AS reserved_qty, hi.lot_id
      FROM public.hub_inventory hi
      WHERE hi.raw_material_id = mat.raw_material_id
        AND hi.quantity_on_hand > COALESCE(hi.reserved_quantity, 0)
      ORDER BY hi.created_at ASC NULLS LAST, hi.id
      FOR UPDATE
    LOOP
      v_take := LEAST(v_need, hub.quantity_on_hand - hub.reserved_qty);
      IF v_take <= 0 THEN
        CONTINUE;
      END IF;

      UPDATE public.hub_inventory hi
      SET quantity_on_hand = hi.quantity_on_hand - v_take,
          available_quantity = (hi.quantity_on_hand - v_take) - COALESCE(hi.reserved_quantity, 0),
          last_updated = v_iso,
          updated_at = v_iso
      WHERE hi.id = hub.id;

      v_inputs := v_inputs || jsonb_build_array(jsonb_build_object(
        'raw_material_id', mat.raw_material_id,
        'source_lot_id', hub.lot_id,
        'quantity', v_take
      ));
      IF v_parent_lot IS NULL AND hub.lot_id IS NOT NULL THEN
        v_parent_lot := hub.lot_id;
      END IF;
      v_need := v_need - v_take;
      EXIT WHEN v_need <= 0;
    END LOOP;

    IF v_need > 0 THEN
      RAISE EXCEPTION 'insufficient_raw_material'
        USING ERRCODE = 'P0001',
              DETAIL = format('have shortfall %s rm %s', v_need, mat.raw_material_id);
    END IF;
  END LOOP;

  IF rec.default_product_batch IS NULL OR trim(both from rec.default_product_batch) = '' THEN
    UPDATE public.recipes
    SET default_product_batch = v_sku, updated_at = v_iso
    WHERE id = pr.recipe_id;
  END IF;

  IF p_finished_quantity > 0 THEN
    INSERT INTO public.inventory_lots (
      product_batch_label, expiry_date, manufactured_at, parent_lot_id, production_run_id, created_at, updated_at
    ) VALUES (
      v_lot_label, v_expiry, v_mfg::timestamptz, v_parent_lot, p_production_run_id, v_iso, v_iso
    )
    RETURNING id INTO v_lot_id;

    INSERT INTO public.inventory_lot_inputs (lot_id, source_lot_id, raw_material_id, quantity)
    SELECT v_lot_id,
           NULLIF(elem->>'source_lot_id', '')::uuid,
           NULLIF(elem->>'raw_material_id', '')::uuid,
           (elem->>'quantity')::numeric
    FROM jsonb_array_elements(v_inputs) elem
    WHERE COALESCE((elem->>'quantity')::numeric, 0) > 0;

    INSERT INTO public.hub_inventory (
      product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity, last_updated, updated_at
    ) VALUES (
      v_sku, v_lot_id, p_finished_quantity, 0, p_finished_quantity, v_iso, v_iso
    )
    RETURNING id INTO v_out_id;
  END IF;

  UPDATE public.production_runs
  SET status = 'completed', updated_at = v_iso
  WHERE id = p_production_run_id;

  PERFORM public._append_data_ledger(
    'inventory_posted', 'production_run', p_production_run_id::text, 'production', 'event',
    NULL,
    jsonb_build_object(
      'hub_inventory_id', v_out_id,
      'product_batch', v_sku,
      'lot_id', v_lot_id,
      'lot_label', v_lot_label,
      'finished_quantity', p_finished_quantity,
      'inputs', v_inputs
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

-- Same body as before 093: active staff only. Classify the replacement so it is not a new exposure.
DO $lot_inputs_exposure$
BEGIN
  IF to_regclass('public.procurement_exposure_allow') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.procurement_exposure_allow (kind, name, note)
  VALUES (
    'function',
    'post_production_completion_inventory',
    'staff-gated: returns not_authenticated_or_inactive unless is_authenticated_active_staff(); procurement is not staff'
  )
  ON CONFLICT (kind, name) DO UPDATE SET note = EXCLUDED.note;
END
$lot_inputs_exposure$;
