/*
  Visibility slice: inventory_adjustments (schema gap fix), sales journals, waste events,
  and SECURITY DEFINER RPCs for stock mutations + data_ledger rows.

  product_batch remains required on inventory rows; lot_id on journal/waste lines is nullable for future Compliance slice.
*/

-- ---------------------------------------------------------------------------
-- inventory_adjustments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_inventory_id uuid NOT NULL REFERENCES public.hub_inventory(id) ON DELETE CASCADE,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('addition', 'deduction')),
  adjusted_quantity numeric(12, 4) NOT NULL CHECK (adjusted_quantity > 0),
  adjustment_reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  notes text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text,
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_hub ON public.inventory_adjustments(hub_inventory_id);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_status ON public.inventory_adjustments(status);

ALTER TABLE public.inventory_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view inventory_adjustments"
  ON public.inventory_adjustments FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert own inventory_adjustments"
  ON public.inventory_adjustments FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Admins can update inventory_adjustments"
  ON public.inventory_adjustments FOR UPDATE TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

-- ---------------------------------------------------------------------------
-- Sales journals (outlet depletion)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES public.outlets(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
  notes text,
  idempotency_key uuid UNIQUE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_journal_id uuid NOT NULL REFERENCES public.sales_journals(id) ON DELETE CASCADE,
  product_batch text NOT NULL,
  lot_id uuid,
  quantity_sold numeric(12, 4) NOT NULL CHECK (quantity_sold > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_journals_outlet_date ON public.sales_journals(outlet_id, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_journal_lines_journal ON public.sales_journal_lines(sales_journal_id);

ALTER TABLE public.sales_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_journal_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view sales_journals"
  ON public.sales_journals FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can view sales_journal_lines"
  ON public.sales_journal_lines FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Waste events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.waste_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_kind text NOT NULL CHECK (location_kind IN ('hub', 'outlet')),
  outlet_id uuid REFERENCES public.outlets(id) ON DELETE CASCADE,
  waste_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
  notes text,
  idempotency_key uuid UNIQUE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_events_outlet_ck CHECK (
    (location_kind = 'outlet' AND outlet_id IS NOT NULL)
    OR (location_kind = 'hub' AND outlet_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.waste_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waste_event_id uuid NOT NULL REFERENCES public.waste_events(id) ON DELETE CASCADE,
  hub_inventory_id uuid REFERENCES public.hub_inventory(id) ON DELETE RESTRICT,
  outlet_id uuid REFERENCES public.outlets(id) ON DELETE CASCADE,
  product_batch text NOT NULL,
  quantity numeric(12, 4) NOT NULL CHECK (quantity > 0),
  waste_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waste_lines_location_ck CHECK (
    (hub_inventory_id IS NOT NULL AND outlet_id IS NULL)
    OR (hub_inventory_id IS NULL AND outlet_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_waste_events_kind_date ON public.waste_events(location_kind, waste_date DESC);
CREATE INDEX IF NOT EXISTS idx_waste_lines_event ON public.waste_lines(waste_event_id);

ALTER TABLE public.waste_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waste_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view waste_events"
  ON public.waste_events FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can view waste_lines"
  ON public.waste_lines FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Internal ledger helper (no GRANT to authenticated — called only from other definer funcs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._append_data_ledger(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_module text,
  p_operation text,
  p_reference_id text DEFAULT NULL,
  p_before jsonb DEFAULT NULL,
  p_after jsonb DEFAULT NULL,
  p_delta jsonb DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := '';
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    SELECT COALESCE(u.email::text, '')
    INTO v_email
    FROM auth.users u
    WHERE u.id = auth.uid();
  EXCEPTION
    WHEN OTHERS THEN
      v_email := '';
  END;

  INSERT INTO public.data_ledger (
    user_id,
    user_email,
    action,
    entity_type,
    entity_id,
    module,
    operation,
    reference_id,
    before_data,
    after_data,
    delta_data,
    metadata
  )
  VALUES (
    auth.uid(),
    v_email,
    p_action,
    p_entity_type,
    p_entity_id,
    p_module,
    p_operation,
    p_reference_id,
    p_before,
    p_after,
    p_delta,
    p_metadata
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'data_ledger insert failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public._append_data_ledger(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- post_sales_journal — p_lines: [{"product_batch":"x","quantity_sold":1}]
-- ---------------------------------------------------------------------------
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
  v_lot uuid;
  v_o_inv_id uuid;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
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
    v_batch := trim(rec->>'product_batch');
    v_qty := (rec->>'quantity_sold')::numeric;
    IF rec ? 'lot_id' AND rec->>'lot_id' IS NOT NULL AND trim(rec->>'lot_id') <> '' THEN
      v_lot := (rec->>'lot_id')::uuid;
    ELSE
      v_lot := NULL;
    END IF;

    IF v_batch IS NULL OR v_batch = '' OR v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;

    IF v_lot IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'lot_id_not_supported_until_compliance');
    END IF;

    SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
    INTO v_o_inv_id, v_qoh, v_res
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = p_outlet_id AND oi.product_batch = v_batch
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'no_outlet_stock_for_batch',
        'product_batch', v_batch
      );
    END IF;

    v_avail := v_qoh - v_res;
    IF v_avail < v_qty THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_available',
        'product_batch', v_batch,
        'available', v_avail,
        'requested', v_qty
      );
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
    v_batch := trim(rec->>'product_batch');
    v_qty := (rec->>'quantity_sold')::numeric;

    INSERT INTO public.sales_journal_lines (sales_journal_id, product_batch, lot_id, quantity_sold)
    VALUES (v_journal_id, v_batch, NULL, v_qty);

    UPDATE public.outlet_inventory oi
    SET
      quantity_on_hand = oi.quantity_on_hand - v_qty,
      available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(),
      updated_at = now()
    WHERE oi.outlet_id = p_outlet_id AND oi.product_batch = v_batch;
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
      'lines', p_lines
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

-- ---------------------------------------------------------------------------
-- post_waste_event
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_waste_event(
  p_location_kind text,
  p_outlet_id uuid,
  p_waste_date date,
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
  v_event_id uuid;
  rec jsonb;
  v_hub_id uuid;
  v_o_id uuid;
  v_batch text;
  v_qty numeric;
  v_reason text;
  v_qoh numeric;
  v_res numeric;
  v_avail numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.waste_events WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'waste_event_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_location_kind NOT IN ('hub', 'outlet') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_location_kind');
  END IF;

  IF p_location_kind = 'outlet' AND p_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required');
  END IF;

  IF p_location_kind = 'hub' AND p_outlet_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_must_be_null_for_hub');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  IF p_location_kind = 'hub' THEN
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_hub_id := (rec->>'hub_inventory_id')::uuid;
      v_batch := COALESCE(trim(rec->>'product_batch'), '');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      IF v_hub_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_reason IS NULL OR v_reason = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_hub_line');
      END IF;

      SELECT hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
      INTO v_qoh, v_res
      FROM public.hub_inventory hi
      WHERE hi.id = v_hub_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_not_found');
      END IF;

      v_avail := v_qoh - v_res;
      IF v_avail < v_qty THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_hub_available', 'hub_inventory_id', v_hub_id);
      END IF;
    END LOOP;
  ELSE
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_o_id := (rec->>'outlet_id')::uuid;
      v_batch := trim(rec->>'product_batch');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');
      IF v_o_id IS NULL OR v_o_id <> p_outlet_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'outlet_line_mismatch');
      END IF;
      IF v_batch = '' OR v_qty IS NULL OR v_qty <= 0 OR v_reason IS NULL OR v_reason = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_outlet_line');
      END IF;

      SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = p_outlet_id AND oi.product_batch = v_batch
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_outlet_stock_for_batch', 'product_batch', v_batch);
      END IF;

      v_avail := v_qoh - v_res;
      IF v_avail < v_qty THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_outlet_available', 'product_batch', v_batch);
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.waste_events (
    location_kind,
    outlet_id,
    waste_date,
    status,
    notes,
    idempotency_key,
    created_by
  )
  VALUES (
    p_location_kind,
    CASE WHEN p_location_kind = 'outlet' THEN p_outlet_id ELSE NULL END,
    p_waste_date,
    'posted',
    p_notes,
    p_idempotency_key,
    v_uid
  )
  RETURNING id INTO v_event_id;

  IF p_location_kind = 'hub' THEN
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_hub_id := (rec->>'hub_inventory_id')::uuid;
      v_batch := trim(rec->>'product_batch');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');

      INSERT INTO public.waste_lines (
        waste_event_id,
        hub_inventory_id,
        outlet_id,
        product_batch,
        quantity,
        waste_reason
      )
      VALUES (v_event_id, v_hub_id, NULL, v_batch, v_qty, v_reason);

      UPDATE public.hub_inventory hi
      SET
        quantity_on_hand = hi.quantity_on_hand - v_qty,
        available_quantity = (hi.quantity_on_hand - v_qty) - COALESCE(hi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE hi.id = v_hub_id;
    END LOOP;
  ELSE
    FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_batch := trim(rec->>'product_batch');
      v_qty := (rec->>'quantity')::numeric;
      v_reason := trim(rec->>'waste_reason');

      INSERT INTO public.waste_lines (
        waste_event_id,
        hub_inventory_id,
        outlet_id,
        product_batch,
        quantity,
        waste_reason
      )
      VALUES (v_event_id, NULL, p_outlet_id, v_batch, v_qty, v_reason);

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - v_qty,
        available_quantity = (oi.quantity_on_hand - v_qty) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.outlet_id = p_outlet_id AND oi.product_batch = v_batch;
    END LOOP;
  END IF;

  PERFORM public._append_data_ledger(
    'posted',
    'waste_event',
    v_event_id::text,
    'waste',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'location_kind', p_location_kind,
      'outlet_id', p_outlet_id,
      'waste_date', p_waste_date,
      'lines', p_lines
    ),
    NULL,
    jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object('success', true, 'waste_event_id', v_event_id);
END;
$$;

REVOKE ALL ON FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_waste_event(text, uuid, date, jsonb, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Apply pending inventory adjustment (hub)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_inventory_adjustment(p_adjustment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  adj RECORD;
  inv RECORD;
  v_new_qoh numeric;
  v_avail numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO adj
  FROM public.inventory_adjustments
  WHERE id = p_adjustment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'adjustment_not_found');
  END IF;

  IF adj.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_applied', true);
  END IF;

  IF adj.status = 'rejected' THEN
    RETURN jsonb_build_object('success', false, 'error', 'rejected_adjustment');
  END IF;

  IF adj.status = 'pending' AND NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'pending_requires_admin');
  END IF;

  SELECT * INTO inv
  FROM public.hub_inventory
  WHERE id = adj.hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_not_found');
  END IF;

  v_new_qoh := inv.quantity_on_hand;
  IF adj.adjustment_type = 'addition' THEN
    v_new_qoh := v_new_qoh + adj.adjusted_quantity;
  ELSE
    v_new_qoh := v_new_qoh - adj.adjusted_quantity;
    IF v_new_qoh < 0 THEN
      v_new_qoh := 0;
    END IF;
  END IF;

  IF v_new_qoh < COALESCE(inv.reserved_quantity, 0) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'on_hand_below_reserved',
      'reserved', inv.reserved_quantity
    );
  END IF;

  v_avail := v_new_qoh - COALESCE(inv.reserved_quantity, 0);

  UPDATE public.hub_inventory
  SET
    quantity_on_hand = v_new_qoh,
    available_quantity = v_avail,
    last_updated = now(),
    updated_at = now()
  WHERE id = inv.id;

  UPDATE public.inventory_adjustments
  SET
    status = 'approved',
    reviewed_by = COALESCE(reviewed_by, auth.uid()),
    reviewed_at = COALESCE(reviewed_at, now()),
    applied_at = now(),
    updated_at = now()
  WHERE id = adj.id;

  PERFORM public._append_data_ledger(
    'approved',
    'hub_inventory',
    inv.id::text,
    'inventory',
    'update',
    adj.id::text,
    jsonb_build_object(
      'quantity_on_hand', inv.quantity_on_hand,
      'available_quantity', inv.quantity_on_hand - COALESCE(inv.reserved_quantity, 0)
    ),
    jsonb_build_object(
      'quantity_on_hand', v_new_qoh,
      'available_quantity', v_avail
    ),
    jsonb_build_object(
      'adjustment_type', adj.adjustment_type,
      'adjusted_quantity', adj.adjusted_quantity,
      'adjustment_reason', adj.adjustment_reason
    ),
    jsonb_build_object('inventory_adjustment_id', adj.id)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_adjustment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_inventory_adjustment(uuid) TO authenticated;

-- Hub quantity set (Inventory modal) — admin-only
CREATE OR REPLACE FUNCTION public.adjust_hub_inventory_quantity(
  p_hub_inventory_id uuid,
  p_new_quantity numeric,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv RECORD;
  v_avail numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity');
  END IF;

  SELECT * INTO inv
  FROM public.hub_inventory
  WHERE id = p_hub_inventory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'hub_inventory_not_found');
  END IF;

  IF p_new_quantity < COALESCE(inv.reserved_quantity, 0) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'below_reserved',
      'reserved', inv.reserved_quantity
    );
  END IF;

  v_avail := p_new_quantity - COALESCE(inv.reserved_quantity, 0);

  UPDATE public.hub_inventory
  SET
    quantity_on_hand = p_new_quantity,
    available_quantity = v_avail,
    last_updated = now(),
    updated_at = now()
  WHERE id = inv.id;

  PERFORM public._append_data_ledger(
    'updated',
    'hub_inventory',
    inv.id::text,
    'inventory',
    'update',
    NULL,
    jsonb_build_object(
      'quantity_on_hand', inv.quantity_on_hand,
      'available_quantity', inv.quantity_on_hand - COALESCE(inv.reserved_quantity, 0)
    ),
    jsonb_build_object(
      'quantity_on_hand', p_new_quantity,
      'available_quantity', v_avail
    ),
    jsonb_build_object('delta_qoh', p_new_quantity - inv.quantity_on_hand),
    jsonb_build_object('reason', p_reason)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_hub_inventory_quantity(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_hub_inventory_quantity(uuid, numeric, text) TO authenticated;
