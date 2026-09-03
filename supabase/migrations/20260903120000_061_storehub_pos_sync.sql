/*
  StoreHub POS sync: map stores/products, ingest FIFO sales journals, void on cancel.
  Quackmaster remains lot-level source of truth. StoreHub inventory is not written.
*/

-- ---------------------------------------------------------------------------
-- sales_journals.source
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_journals
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

ALTER TABLE public.sales_journals
  DROP CONSTRAINT IF EXISTS sales_journals_source_check;

ALTER TABLE public.sales_journals
  ADD CONSTRAINT sales_journals_source_check
  CHECK (source IN ('manual', 'storehub'));

CREATE INDEX IF NOT EXISTS idx_sales_journals_source
  ON public.sales_journals (source)
  WHERE source = 'storehub';

-- ---------------------------------------------------------------------------
-- Maps + sync log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.storehub_store_map (
  storehub_store_id text PRIMARY KEY,
  outlet_id uuid NOT NULL REFERENCES public.outlets(id) ON DELETE CASCADE,
  storehub_store_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storehub_store_map_outlet
  ON public.storehub_store_map (outlet_id);

CREATE TABLE IF NOT EXISTS public.storehub_product_map (
  storehub_product_id text PRIMARY KEY,
  quackmaster_sku text NOT NULL,
  storehub_sku text,
  storehub_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storehub_product_map_sku
  ON public.storehub_product_map (quackmaster_sku);

CREATE TABLE IF NOT EXISTS public.storehub_sync_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  cron_token uuid NOT NULL DEFAULT gen_random_uuid(),
  last_success_to date,
  timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  functions_anon_key text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.storehub_sync_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.storehub_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  window_from date,
  window_to date,
  triggered_by text NOT NULL DEFAULT 'admin' CHECK (triggered_by IN ('admin', 'cron')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  stores_synced integer NOT NULL DEFAULT 0,
  sales_ingested integer NOT NULL DEFAULT 0,
  cancelled integer NOT NULL DEFAULT 0,
  returns_flagged integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storehub_sync_runs_started
  ON public.storehub_sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS public.storehub_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_id uuid NOT NULL UNIQUE,
  invoice_number text,
  event_type text NOT NULL CHECK (event_type IN ('sale', 'cancel', 'return', 'fail')),
  status text NOT NULL CHECK (status IN ('posted', 'voided', 'needs_review', 'failed', 'skipped')),
  sales_journal_id uuid REFERENCES public.sales_journals(id) ON DELETE SET NULL,
  outlet_id uuid REFERENCES public.outlets(id) ON DELETE SET NULL,
  error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_run_id uuid REFERENCES public.storehub_sync_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storehub_sync_events_status
  ON public.storehub_sync_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storehub_sync_events_outlet
  ON public.storehub_sync_events (outlet_id, created_at DESC);

ALTER TABLE public.storehub_store_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storehub_product_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storehub_sync_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storehub_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storehub_sync_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read storehub_store_map" ON public.storehub_store_map;
CREATE POLICY "Admins read storehub_store_map"
  ON public.storehub_store_map FOR SELECT TO authenticated
  USING (public.is_profiles_admin());

DROP POLICY IF EXISTS "Admins write storehub_store_map" ON public.storehub_store_map;
CREATE POLICY "Admins write storehub_store_map"
  ON public.storehub_store_map FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

DROP POLICY IF EXISTS "Admins read storehub_product_map" ON public.storehub_product_map;
CREATE POLICY "Admins read storehub_product_map"
  ON public.storehub_product_map FOR SELECT TO authenticated
  USING (public.is_profiles_admin());

DROP POLICY IF EXISTS "Admins write storehub_product_map" ON public.storehub_product_map;
CREATE POLICY "Admins write storehub_product_map"
  ON public.storehub_product_map FOR ALL TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

DROP POLICY IF EXISTS "Admins read storehub_sync_settings" ON public.storehub_sync_settings;
CREATE POLICY "Admins read storehub_sync_settings"
  ON public.storehub_sync_settings FOR SELECT TO authenticated
  USING (public.is_profiles_admin());

DROP POLICY IF EXISTS "Admins update storehub_sync_settings" ON public.storehub_sync_settings;
CREATE POLICY "Admins update storehub_sync_settings"
  ON public.storehub_sync_settings FOR UPDATE TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());

DROP POLICY IF EXISTS "Admins read storehub_sync_runs" ON public.storehub_sync_runs;
CREATE POLICY "Admins read storehub_sync_runs"
  ON public.storehub_sync_runs FOR SELECT TO authenticated
  USING (public.is_profiles_admin());

DROP POLICY IF EXISTS "Admins read storehub_sync_events" ON public.storehub_sync_events;
CREATE POLICY "Admins read storehub_sync_events"
  ON public.storehub_sync_events FOR SELECT TO authenticated
  USING (public.is_profiles_admin());

-- ---------------------------------------------------------------------------
-- Auth helper for Edge Function (service_role) or admin JWT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_storehub_ingest()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    coalesce(auth.role(), '') = 'service_role'
    OR coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    OR public.is_profiles_admin();
$$;

REVOKE ALL ON FUNCTION public.is_storehub_ingest() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_storehub_ingest() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_storehub_ingest() TO service_role;

-- ---------------------------------------------------------------------------
-- ingest_storehub_sale — one StoreHub refId → one FIFO journal (multi-SKU)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_storehub_sale(
  p_ref_id uuid,
  p_outlet_id uuid,
  p_business_date date,
  p_lines jsonb,
  p_notes text DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_sync_run_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing uuid;
  v_event public.storehub_sync_events%ROWTYPE;
  v_journal_id uuid;
  rec jsonb;
  v_sku text;
  v_qty numeric;
  v_remaining numeric;
  v_total_avail numeric;
  r RECORD;
  v_avail numeric;
  v_take numeric;
  v_lines jsonb := '[]'::jsonb;
  v_skus_seen int := 0;
BEGIN
  IF NOT public.is_storehub_ingest() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  IF p_ref_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ref_id_required');
  END IF;

  IF p_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required');
  END IF;

  IF p_business_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'business_date_required');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  SELECT id INTO v_existing
  FROM public.sales_journals
  WHERE idempotency_key = p_ref_id;

  IF FOUND THEN
    INSERT INTO public.storehub_sync_events (
      ref_id, invoice_number, event_type, status, sales_journal_id, outlet_id, payload, sync_run_id
    )
    VALUES (
      p_ref_id, p_invoice_number, 'sale', 'skipped', v_existing, p_outlet_id,
      jsonb_build_object('idempotent_replay', true, 'channel', p_channel),
      p_sync_run_id
    )
    ON CONFLICT (ref_id) DO UPDATE SET
      updated_at = now(),
      sync_run_id = COALESCE(EXCLUDED.sync_run_id, public.storehub_sync_events.sync_run_id);

    RETURN jsonb_build_object(
      'success', true,
      'sales_journal_id', v_existing,
      'idempotent_replay', true
    );
  END IF;

  SELECT * INTO v_event FROM public.storehub_sync_events WHERE ref_id = p_ref_id;
  IF FOUND AND v_event.status IN ('posted', 'voided') AND v_event.sales_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'sales_journal_id', v_event.sales_journal_id,
      'idempotent_replay', true
    );
  END IF;

  -- Preflight: every SKU must have enough ATP
  FOR rec IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_sku := trim(both from coalesce(rec ->> 'sku', ''));
    v_qty := (rec ->> 'quantity')::numeric;
    IF v_sku = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'sku_required');
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity', 'sku', v_sku);
    END IF;
    v_skus_seen := v_skus_seen + 1;

    v_total_avail := 0;
    FOR r IN
      SELECT
        oi.quantity_on_hand,
        COALESCE(oi.reserved_quantity, 0) AS reserved_qty
      FROM public.outlet_inventory oi
      LEFT JOIN public.inventory_lots il ON il.id = oi.lot_id
      WHERE oi.outlet_id = p_outlet_id
        AND oi.quantity_on_hand > 0
        AND public.fg_identifier_matches(
          oi.product_batch,
          il.product_batch_label,
          public.fg_recipe_sku(oi.lot_id),
          v_sku
        )
      FOR UPDATE OF oi
    LOOP
      v_total_avail := v_total_avail + GREATEST(r.quantity_on_hand - r.reserved_qty, 0);
    END LOOP;

    IF v_total_avail < v_qty THEN
      INSERT INTO public.storehub_sync_events (
        ref_id, invoice_number, event_type, status, outlet_id, error, payload, sync_run_id
      )
      VALUES (
        p_ref_id, p_invoice_number, 'fail', 'failed', p_outlet_id,
        'insufficient_stock',
        jsonb_build_object(
          'sku', v_sku, 'requested', v_qty, 'available', v_total_avail,
          'channel', p_channel, 'notes', p_notes
        ),
        p_sync_run_id
      )
      ON CONFLICT (ref_id) DO UPDATE SET
        event_type = 'fail',
        status = 'failed',
        error = 'insufficient_stock',
        payload = EXCLUDED.payload,
        outlet_id = EXCLUDED.outlet_id,
        invoice_number = EXCLUDED.invoice_number,
        sync_run_id = COALESCE(EXCLUDED.sync_run_id, public.storehub_sync_events.sync_run_id),
        updated_at = now();

      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_stock',
        'sku', v_sku,
        'requested', v_qty,
        'available', v_total_avail
      );
    END IF;
  END LOOP;

  IF v_skus_seen = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_lines');
  END IF;

  INSERT INTO public.sales_journals (
    outlet_id, business_date, status, notes, idempotency_key, created_by, source
  )
  VALUES (
    p_outlet_id,
    p_business_date,
    'posted',
    p_notes,
    p_ref_id,
    auth.uid(),
    'storehub'
  )
  RETURNING id INTO v_journal_id;

  FOR rec IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_sku := trim(both from coalesce(rec ->> 'sku', ''));
    v_qty := (rec ->> 'quantity')::numeric;
    v_remaining := v_qty;

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
        AND public.fg_identifier_matches(
          oi.product_batch,
          il.product_batch_label,
          public.fg_recipe_sku(oi.lot_id),
          v_sku
        )
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
        sales_journal_id, product_batch, lot_id, quantity_sold, outlet_inventory_id
      )
      VALUES (
        v_journal_id,
        trim(both from r.product_batch),
        r.lot_id,
        v_take,
        r.id
      );

      PERFORM public._set_outlet_movement_ctx(
        p_outlet_id, 'sale', p_business_date, 'sales_journal', v_journal_id,
        jsonb_build_object('source', 'storehub', 'sku', v_sku, 'ref_id', p_ref_id)
      );

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand - v_take,
        available_quantity = (oi.quantity_on_hand - v_take) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = r.id;

      PERFORM public._clear_outlet_movement_ctx();

      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'outlet_inventory_id', r.id,
          'product_batch', trim(both from r.product_batch),
          'sku', v_sku,
          'quantity_sold', v_take
        )
      );

      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'fifo_alloc_internal_error remaining=% sku=%', v_remaining, v_sku;
    END IF;
  END LOOP;

  INSERT INTO public.storehub_sync_events (
    ref_id, invoice_number, event_type, status, sales_journal_id, outlet_id, payload, sync_run_id
  )
  VALUES (
    p_ref_id, p_invoice_number, 'sale', 'posted', v_journal_id, p_outlet_id,
    jsonb_build_object('channel', p_channel, 'lines', v_lines),
    p_sync_run_id
  )
  ON CONFLICT (ref_id) DO UPDATE SET
    event_type = 'sale',
    status = 'posted',
    sales_journal_id = EXCLUDED.sales_journal_id,
    outlet_id = EXCLUDED.outlet_id,
    invoice_number = EXCLUDED.invoice_number,
    error = NULL,
    payload = EXCLUDED.payload,
    sync_run_id = COALESCE(EXCLUDED.sync_run_id, public.storehub_sync_events.sync_run_id),
    updated_at = now();

  PERFORM public._append_data_ledger(
    'posted',
    'sales_journal',
    v_journal_id::text,
    'sales',
    'event',
    p_ref_id::text,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'business_date', p_business_date,
      'mode', 'storehub_fifo',
      'lines', v_lines,
      'invoice', p_invoice_number
    ),
    NULL,
    jsonb_build_object('notes', p_notes, 'source', 'storehub')
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_journal_id', v_journal_id,
    'lines', v_lines
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_sale(uuid, uuid, date, jsonb, text, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- ingest_storehub_cancel — void posted journal for a StoreHub refId
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_storehub_cancel(
  p_ref_id uuid,
  p_sync_run_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event public.storehub_sync_events%ROWTYPE;
  v_journal_id uuid;
  v_header RECORD;
  r RECORD;
  v_leg uuid;
  v_lines_snap jsonb;
BEGIN
  IF NOT public.is_storehub_ingest() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  IF p_ref_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ref_id_required');
  END IF;

  SELECT * INTO v_event FROM public.storehub_sync_events WHERE ref_id = p_ref_id;

  IF NOT FOUND THEN
    INSERT INTO public.storehub_sync_events (
      ref_id, event_type, status, error, payload, sync_run_id
    )
    VALUES (
      p_ref_id, 'cancel', 'skipped', 'never_ingested',
      jsonb_build_object('reason', 'cancel_before_ingest'),
      p_sync_run_id
    )
    ON CONFLICT (ref_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'never_ingested');
  END IF;

  IF v_event.status = 'voided' THEN
    RETURN jsonb_build_object('success', true, 'idempotent_replay', true, 'sales_journal_id', v_event.sales_journal_id);
  END IF;

  v_journal_id := v_event.sales_journal_id;
  IF v_journal_id IS NULL THEN
    SELECT id INTO v_journal_id FROM public.sales_journals WHERE idempotency_key = p_ref_id;
  END IF;

  IF v_journal_id IS NULL THEN
    UPDATE public.storehub_sync_events
    SET event_type = 'cancel', status = 'skipped', error = 'no_journal', updated_at = now(),
        sync_run_id = COALESCE(p_sync_run_id, sync_run_id)
    WHERE ref_id = p_ref_id;
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'no_journal');
  END IF;

  SELECT * INTO v_header FROM public.sales_journals WHERE id = v_journal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_found');
  END IF;

  IF v_header.status IS DISTINCT FROM 'posted' THEN
    UPDATE public.storehub_sync_events
    SET event_type = 'cancel', status = 'voided', updated_at = now(),
        sync_run_id = COALESCE(p_sync_run_id, sync_run_id)
    WHERE ref_id = p_ref_id;
    RETURN jsonb_build_object('success', true, 'already_voided', true, 'sales_journal_id', v_journal_id);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_batch', sj.product_batch, 'quantity_sold', sj.quantity_sold, 'outlet_inventory_id', sj.outlet_inventory_id
  ) ORDER BY sj.created_at, sj.id), '[]'::jsonb)
  INTO v_lines_snap
  FROM public.sales_journal_lines sj WHERE sj.sales_journal_id = v_journal_id;

  FOR r IN
    SELECT product_batch, quantity_sold, outlet_inventory_id
    FROM public.sales_journal_lines WHERE sales_journal_id = v_journal_id ORDER BY created_at, id
  LOOP
    v_leg := r.outlet_inventory_id;
    IF v_leg IS NULL THEN
      SELECT oi.id INTO v_leg FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_header.outlet_id AND trim(both from oi.product_batch) = trim(both from r.product_batch)
      ORDER BY oi.created_at ASC NULLS LAST LIMIT 1;
    END IF;
    IF v_leg IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'outlet_stock_missing_for_reversal', 'product_batch', r.product_batch);
    END IF;

    PERFORM public._set_outlet_movement_ctx(
      v_header.outlet_id, 'reversal', v_header.business_date, 'sales_journal', v_journal_id
    );

    UPDATE public.outlet_inventory oi SET
      quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
      available_quantity = (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(), updated_at = now()
    WHERE oi.id = v_leg;

    PERFORM public._clear_outlet_movement_ctx();
  END LOOP;

  UPDATE public.sales_journals SET status = 'voided', updated_at = now() WHERE id = v_journal_id;

  UPDATE public.storehub_sync_events
  SET event_type = 'cancel', status = 'voided', sales_journal_id = v_journal_id, error = NULL,
      updated_at = now(), sync_run_id = COALESCE(p_sync_run_id, sync_run_id)
  WHERE ref_id = p_ref_id;

  PERFORM public._append_data_ledger(
    'voided', 'sales_journal', v_journal_id::text, 'sales', 'event', p_ref_id::text,
    jsonb_build_object('outlet_id', v_header.outlet_id, 'business_date', v_header.business_date, 'lines', v_lines_snap),
    NULL, NULL, jsonb_build_object('source', 'storehub_cancel')
  );

  RETURN jsonb_build_object('success', true, 'sales_journal_id', v_journal_id);
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_storehub_cancel(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_cancel(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_cancel(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- ingest_storehub_return_flag — cashiers return; do not reverse FIFO in v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_storehub_return_flag(
  p_ref_id uuid,
  p_invoice_number text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_sync_run_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_storehub_ingest() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  INSERT INTO public.storehub_sync_events (
    ref_id, invoice_number, event_type, status, payload, sync_run_id
  )
  VALUES (
    p_ref_id, p_invoice_number, 'return', 'needs_review', COALESCE(p_payload, '{}'::jsonb), p_sync_run_id
  )
  ON CONFLICT (ref_id) DO UPDATE SET
    event_type = 'return',
    status = 'needs_review',
    invoice_number = COALESCE(EXCLUDED.invoice_number, public.storehub_sync_events.invoice_number),
    payload = EXCLUDED.payload,
    sync_run_id = COALESCE(EXCLUDED.sync_run_id, public.storehub_sync_events.sync_run_id),
    updated_at = now();

  RETURN jsonb_build_object('success', true, 'status', 'needs_review');
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_storehub_return_flag(uuid, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_return_flag(uuid, text, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_storehub_return_flag(uuid, text, jsonb, uuid) TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.storehub_store_map TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.storehub_product_map TO authenticated, service_role;
GRANT SELECT, UPDATE ON public.storehub_sync_settings TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.storehub_sync_runs TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.storehub_sync_events TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.invoke_storehub_sync_cron()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_token uuid;
  v_anon text;
  v_id bigint;
BEGIN
  SELECT cron_token, functions_anon_key INTO v_token, v_anon FROM public.storehub_sync_settings WHERE id = 1;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'storehub_sync_settings missing cron_token';
  END IF;
  IF v_anon IS NULL OR length(trim(v_anon)) = 0 THEN
    RAISE EXCEPTION 'storehub_sync_settings missing functions_anon_key';
  END IF;
  SELECT net.http_post(
    url := 'https://fknrfntqycfrkaihwngg.supabase.co/functions/v1/sync_storehub_sales',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || trim(v_anon),
      'apikey', trim(v_anon),
      'x-storehub-cron-token', v_token::text
    ),
    body := jsonb_build_object('action', 'sync', 'fromCron', true),
    timeout_milliseconds := 120000
  ) INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_storehub_sync_cron() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_storehub_sync_cron() TO postgres;
GRANT EXECUTE ON FUNCTION public.invoke_storehub_sync_cron() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'storehub-sync-15m') THEN
    PERFORM cron.unschedule('storehub-sync-15m');
  END IF;
  PERFORM cron.schedule(
    'storehub-sync-15m',
    '*/15 * * * *',
    $job$SELECT public.invoke_storehub_sync_cron();$job$
  );
END;
$$;
