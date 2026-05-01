/*
  Accuracy slice: multi-UOM scaffolding, weighted-average unit cost on raw_materials,
  purchase_order_items base qty column, material_units, atomic PO receive RPC (delta-aware hub + costing).
*/

ALTER TABLE public.raw_materials
  ADD COLUMN IF NOT EXISTS weighted_avg_unit_cost numeric(14, 4) NOT NULL DEFAULT 0;

UPDATE public.raw_materials
SET weighted_avg_unit_cost = COALESCE(cost_price, 0)
WHERE weighted_avg_unit_cost = 0 AND cost_price IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.material_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
  uom_code text NOT NULL,
  label text,
  ratio_to_base numeric(18, 8) NOT NULL CHECK (ratio_to_base > 0),
  is_default_purchase boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_material_id, uom_code)
);

CREATE INDEX IF NOT EXISTS idx_material_units_rm ON public.material_units(raw_material_id);

ALTER TABLE public.material_units ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view material_units"
  ON public.material_units FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage material_units"
  ON public.material_units FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS purchase_uom text,
  ADD COLUMN IF NOT EXISTS quantity_ordered_base numeric(14, 4);

UPDATE public.purchase_order_items
SET quantity_ordered_base = quantity_ordered
WHERE quantity_ordered_base IS NULL;

ALTER TABLE public.purchase_order_items
  ALTER COLUMN quantity_ordered_base SET NOT NULL;

CREATE OR REPLACE FUNCTION public.receive_po_shipment(p_po_id uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec jsonb;
  v_item_id uuid;
  v_target_rcv numeric;
  v_old_rcv numeric;
  v_ordered numeric;
  v_delta numeric;
  v_rm uuid;
  v_price numeric;
  v_po_check uuid;
  v_hub_tot_before numeric;
  v_old_avg numeric;
  v_new_avg numeric;
  v_hub_tot_after numeric;
  v_hub_row uuid;
  v_qoh numeric;
  v_res numeric;
  v_ordered_total numeric := 0;
  v_received_total numeric := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_item_id := (rec->>'purchase_order_item_id')::uuid;
    v_target_rcv := (rec->>'quantity_received')::numeric;

    IF v_target_rcv IS NULL OR v_target_rcv < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity_received');
    END IF;

    SELECT
      poi.quantity_ordered,
      poi.quantity_received,
      poi.raw_material_id,
      poi.unit_price,
      poi.purchase_order_id
    INTO v_ordered, v_old_rcv, v_rm, v_price, v_po_check
    FROM public.purchase_order_items poi
    WHERE poi.id = v_item_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_item_not_found');
    END IF;

    IF v_po_check <> p_po_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'po_mismatch');
    END IF;

    IF v_target_rcv > v_ordered THEN
      RETURN jsonb_build_object('success', false, 'error', 'received_exceeds_ordered', 'item_id', v_item_id);
    END IF;

    v_delta := v_target_rcv - COALESCE(v_old_rcv, 0);

    UPDATE public.purchase_order_items
    SET
      quantity_received = v_target_rcv,
      line_total = v_target_rcv * COALESCE(v_price, 0)
    WHERE id = v_item_id;

    IF v_delta <> 0 AND v_rm IS NOT NULL THEN
      IF v_delta > 0 THEN
        SELECT COALESCE(SUM(hi.quantity_on_hand), 0)
        INTO v_hub_tot_before
        FROM public.hub_inventory hi
        WHERE hi.raw_material_id = v_rm;

        SELECT COALESCE(r.weighted_avg_unit_cost, r.cost_price, 0)
        INTO v_old_avg
        FROM public.raw_materials r
        WHERE r.id = v_rm
        FOR UPDATE;

        v_hub_tot_after := v_hub_tot_before + v_delta;

        IF v_hub_tot_after <= 0 THEN
          v_new_avg := v_old_avg;
        ELSIF v_hub_tot_before <= 0 THEN
          v_new_avg := COALESCE(v_price, 0);
        ELSE
          v_new_avg :=
            (v_hub_tot_before * v_old_avg + v_delta * COALESCE(v_price, 0))
            / NULLIF(v_hub_tot_after, 0);
        END IF;

        UPDATE public.raw_materials
        SET
          weighted_avg_unit_cost = COALESCE(v_new_avg, 0),
          cost_price = COALESCE(v_new_avg, cost_price),
          updated_at = now()
        WHERE id = v_rm;
      END IF;

      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
      INTO v_hub_row, v_qoh, v_res
      FROM public.hub_inventory hi
      WHERE hi.raw_material_id = v_rm
      ORDER BY hi.created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_hub_row IS NULL THEN
        IF v_delta <= 0 THEN
          RETURN jsonb_build_object('success', false, 'error', 'cannot_reduce_missing_hub_row');
        END IF;
        INSERT INTO public.hub_inventory (
          raw_material_id,
          quantity_on_hand,
          reserved_quantity,
          available_quantity,
          last_updated,
          updated_at
        )
        VALUES (
          v_rm,
          v_delta,
          0,
          v_delta,
          now(),
          now()
        );
      ELSE
        IF v_qoh + v_delta < v_res THEN
          RETURN jsonb_build_object('success', false, 'error', 'hub_below_reserved');
        END IF;

        UPDATE public.hub_inventory hi
        SET
          quantity_on_hand = hi.quantity_on_hand + v_delta,
          available_quantity = (hi.quantity_on_hand + v_delta) - COALESCE(hi.reserved_quantity, 0),
          last_updated = now(),
          updated_at = now()
        WHERE hi.id = v_hub_row;
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(poi.quantity_ordered), 0), COALESCE(SUM(poi.quantity_received), 0)
  INTO v_ordered_total, v_received_total
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = p_po_id;

  UPDATE public.purchase_orders po
  SET
    status = CASE
      WHEN v_received_total <= 0 THEN po.status
      WHEN v_received_total < v_ordered_total THEN 'partial'
      ELSE 'received'
    END,
    actual_delivery_date = CASE
      WHEN v_received_total >= v_ordered_total AND v_ordered_total > 0 THEN CURRENT_DATE
      ELSE po.actual_delivery_date
    END,
    updated_at = now()
  WHERE po.id = p_po_id;

  PERFORM public._append_data_ledger(
    'received',
    'purchase_order',
    p_po_id::text,
    'procurement',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'ordered_total', v_ordered_total,
      'received_total', v_received_total,
      'lines', p_lines
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'success', true,
    'ordered_total', v_ordered_total,
    'received_total', v_received_total,
    'status',
    CASE
      WHEN v_received_total <= 0 THEN 'unchanged'
      WHEN v_received_total < v_ordered_total THEN 'partial'
      ELSE 'received'
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.receive_po_shipment(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_po_shipment(uuid, jsonb) TO authenticated;
