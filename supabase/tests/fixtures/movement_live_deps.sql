-- Live production definitions (Supabase fknrfntqycfrkaihwngg, read-only pg_get_functiondef, 19 Oct 2026 23:50 MYT)
-- of the outlet movement trigger, its context helpers, the stock take snapshot hook and void_sales_journal.
-- Test-only fixture: lets pglite tests observe real outlet_stock_movements rows (zero-variance submit,
-- sales void restores the same batch). Not a migration.
CREATE OR REPLACE FUNCTION public._clear_outlet_movement_ctx()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.outlet_movement_ctx', '', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public._outlet_inventory_movement_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_raw text;
  v_ctx jsonb;
  v_delta numeric(14, 4);
  v_outlet_id uuid;
BEGIN
  v_raw := current_setting('app.outlet_movement_ctx', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN NEW;
  END IF;

  v_ctx := v_raw::jsonb;
  v_outlet_id := (v_ctx->>'outlet_id')::uuid;

  IF TG_OP = 'INSERT' THEN
    v_delta := NEW.quantity_on_hand;
  ELSE
    v_delta := NEW.quantity_on_hand - OLD.quantity_on_hand;
  END IF;

  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.outlet_stock_movements (
    outlet_id,
    outlet_inventory_id,
    movement_type,
    signed_qty,
    business_date,
    reference_type,
    reference_id,
    qoh_after,
    metadata
  )
  VALUES (
    v_outlet_id,
    NEW.id,
    v_ctx->>'movement_type',
    v_delta,
    (v_ctx->>'business_date')::date,
    v_ctx->>'reference_type',
    (v_ctx->>'reference_id')::uuid,
    NEW.quantity_on_hand,
    COALESCE(v_ctx->'metadata', '{}'::jsonb)
  );

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public._post_stock_take_snapshot_hook(p_outlet_id uuid, p_count_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.snapshot_outlet_inventory(p_outlet_id, COALESCE(p_count_date, CURRENT_DATE), 'post_stock_take');
END;
$function$
;

CREATE OR REPLACE FUNCTION public._set_outlet_movement_ctx(p_outlet_id uuid, p_movement_type text, p_business_date date, p_reference_type text, p_reference_id uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config(
    'app.outlet_movement_ctx',
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'movement_type', p_movement_type,
      'business_date', p_business_date,
      'reference_type', p_reference_type,
      'reference_id', p_reference_id,
      'metadata', COALESCE(p_metadata, '{}'::jsonb)
    )::text,
    true
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_profiles_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ok boolean;
BEGIN
  SET LOCAL row_security = off;
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active
  )
  INTO ok;
  RETURN COALESCE(ok, false);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.snapshot_outlet_inventory(p_outlet_id uuid, p_snapshot_date date DEFAULT CURRENT_DATE, p_snapshot_type text DEFAULT 'manual'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_lines jsonb;
BEGIN
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'outlet_inventory_id', oi.id,
        'product_batch', oi.product_batch,
        'raw_material_id', oi.raw_material_id,
        'quantity_on_hand', oi.quantity_on_hand,
        'reserved_quantity', COALESCE(oi.reserved_quantity, 0),
        'available_quantity', oi.available_quantity
      )
      ORDER BY oi.id
    ),
    '[]'::jsonb
  )
  INTO v_lines
  FROM public.outlet_inventory oi
  WHERE oi.outlet_id = p_outlet_id;

  INSERT INTO public.outlet_inventory_snapshots (outlet_id, snapshot_date, snapshot_type, lines)
  VALUES (p_outlet_id, p_snapshot_date, p_snapshot_type, v_lines)
  ON CONFLICT (outlet_id, snapshot_date, snapshot_type)
  DO UPDATE SET lines = EXCLUDED.lines, created_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.void_sales_journal(p_sales_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_header RECORD;
  r RECORD;
  v_lines_snap jsonb;
  leg_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;

  SELECT * INTO v_header FROM public.sales_journals WHERE id = p_sales_journal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_found');
  END IF;
  IF v_header.status IS DISTINCT FROM 'posted' THEN
    RETURN jsonb_build_object('success', false, 'error', 'journal_not_voidable_status');
  END IF;

  -- StoreHub-sourced voids stay admin-only (already gated above). Explicit
  -- error keeps intent clear if auth rules ever widen for manual voids.
  IF COALESCE(v_header.source, 'manual') = 'storehub' AND NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'storehub_void_admin_required');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_batch', sj.product_batch, 'quantity_sold', sj.quantity_sold, 'outlet_inventory_id', sj.outlet_inventory_id
  ) ORDER BY sj.created_at, sj.id), '[]'::jsonb)
  INTO v_lines_snap
  FROM public.sales_journal_lines sj WHERE sj.sales_journal_id = p_sales_journal_id;

  FOR r IN
    SELECT product_batch, quantity_sold, outlet_inventory_id
    FROM public.sales_journal_lines WHERE sales_journal_id = p_sales_journal_id ORDER BY created_at, id
  LOOP
    leg_id := r.outlet_inventory_id;
    IF leg_id IS NULL THEN
      SELECT oi.id INTO leg_id FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_header.outlet_id AND trim(both from oi.product_batch) = trim(both from r.product_batch)
      ORDER BY oi.created_at ASC NULLS LAST LIMIT 1;
    END IF;
    IF leg_id IS NULL THEN
      RAISE EXCEPTION 'outlet_stock_missing_for_reversal'
        USING ERRCODE = 'P0001',
              DETAIL = r.product_batch;
    END IF;

    PERFORM public._set_outlet_movement_ctx(
      v_header.outlet_id, 'reversal', v_header.business_date, 'sales_journal', p_sales_journal_id
    );

    UPDATE public.outlet_inventory oi SET
      quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
      available_quantity = (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
      last_updated = now(), updated_at = now()
    WHERE oi.id = leg_id;

    PERFORM public._clear_outlet_movement_ctx();
  END LOOP;

  UPDATE public.sales_journals SET status = 'voided', updated_at = now() WHERE id = p_sales_journal_id;

  IF COALESCE(v_header.source, 'manual') = 'storehub' AND v_header.idempotency_key IS NOT NULL THEN
    UPDATE public.storehub_sync_events
    SET
      event_type = 'cancel',
      status = 'voided',
      error = 'ui_void',
      payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('ui_void', true, 'sales_journal_id', p_sales_journal_id),
      updated_at = now()
    WHERE ref_id = v_header.idempotency_key;
  END IF;

  PERFORM public._append_data_ledger(
    'voided', 'sales_journal', p_sales_journal_id::text, 'sales', 'event', NULL,
    jsonb_build_object(
      'outlet_id', v_header.outlet_id,
      'business_date', v_header.business_date,
      'lines', v_lines_snap,
      'source', COALESCE(v_header.source, 'manual')
    ),
    NULL, NULL
  );

  RETURN jsonb_build_object('success', true, 'sales_journal_id', p_sales_journal_id);
END;
$function$;

CREATE TRIGGER trg_outlet_inventory_movement AFTER INSERT OR UPDATE OF quantity_on_hand ON public.outlet_inventory FOR EACH ROW EXECUTE FUNCTION _outlet_inventory_movement_trigger();
