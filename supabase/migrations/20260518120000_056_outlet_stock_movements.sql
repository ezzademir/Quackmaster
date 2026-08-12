/*
  # outlet_stock_movements — append-only outlet quantity ledger

  RPCs set transaction-local context via set_config('app.outlet_movement_ctx', ...)
  before mutating outlet_inventory; trigger records signed qty movements.
*/

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outlet_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES public.outlets(id) ON DELETE RESTRICT,
  outlet_inventory_id uuid NOT NULL REFERENCES public.outlet_inventory(id) ON DELETE RESTRICT,
  movement_type text NOT NULL CHECK (
    movement_type IN (
      'supply_in',
      'transfer_in',
      'transfer_out',
      'sale',
      'waste',
      'stock_take',
      'reversal',
      'admin_adjust'
    )
  ),
  signed_qty numeric(14, 4) NOT NULL,
  business_date date NOT NULL,
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  qoh_after numeric(14, 4),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_osm_outlet_business_date
  ON public.outlet_stock_movements (outlet_id, business_date);

CREATE INDEX IF NOT EXISTS idx_osm_outlet_inventory_created
  ON public.outlet_stock_movements (outlet_inventory_id, created_at);

CREATE INDEX IF NOT EXISTS idx_osm_reference
  ON public.outlet_stock_movements (reference_type, reference_id);

ALTER TABLE public.outlet_stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin view all outlet stock movements"
  ON public.outlet_stock_movements FOR SELECT TO authenticated
  USING (public.is_profiles_admin());

CREATE POLICY "Supervisor view movements for assigned outlet"
  ON public.outlet_stock_movements FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND outlet_stock_movements.outlet_id = p.assigned_outlet_id
    )
  );

CREATE POLICY "Staff view all outlet stock movements"
  ON public.outlet_stock_movements FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) NOT IN ('supervisor')
        AND public.is_authenticated_active_staff()
    )
  );

-- ---------------------------------------------------------------------------
-- Context helper (called from RPCs before outlet_inventory mutation)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._set_outlet_movement_ctx(
  p_outlet_id uuid,
  p_movement_type text,
  p_business_date date,
  p_reference_type text,
  p_reference_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public._clear_outlet_movement_ctx()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.outlet_movement_ctx', '', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: record movement when outlet_inventory.quantity_on_hand changes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._outlet_inventory_movement_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

DROP TRIGGER IF EXISTS trg_outlet_inventory_movement ON public.outlet_inventory;

CREATE TRIGGER trg_outlet_inventory_movement
  AFTER INSERT OR UPDATE OF quantity_on_hand ON public.outlet_inventory
  FOR EACH ROW
  EXECUTE FUNCTION public._outlet_inventory_movement_trigger();

REVOKE ALL ON FUNCTION public._set_outlet_movement_ctx(uuid, text, date, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._clear_outlet_movement_ctx() FROM PUBLIC;

-- No-op until snapshot table exists (059 replaces this)
CREATE OR REPLACE FUNCTION public._post_stock_take_snapshot_hook(p_outlet_id uuid, p_count_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NULL;
END;
$$;
