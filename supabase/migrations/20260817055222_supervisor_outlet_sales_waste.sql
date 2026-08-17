/*
  Supervisors may post sales and outlet waste for assigned_outlet_id only.
  Hub waste and other staff RPCs stay admin/staff.
  SELECT on sales/waste is scoped so supervisors cannot browse other outlets.
*/

CREATE OR REPLACE FUNCTION public.is_supervisor_for_outlet(p_outlet_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_outlet_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND lower(trim(p.role::text)) = 'supervisor'
      AND p.assigned_outlet_id IS NOT NULL
      AND p.assigned_outlet_id = p_outlet_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_supervisor_for_outlet(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_supervisor_for_outlet(uuid) TO authenticated;

-- Patch SECURITY DEFINER bodies: allow assigned-outlet supervisors on sales RPCs.
DO $$
DECLARE
  src text;
  needle text := $n$IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;$n$;
  repl text := $n$IF v_uid IS NULL OR NOT (
    public.is_authenticated_active_staff()
    OR public.is_supervisor_for_outlet(p_outlet_id)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;$n$;
BEGIN
  SELECT pg_get_functiondef('public.post_sales_journal(uuid, date, jsonb, text, uuid)'::regprocedure) INTO src;
  IF src IS NULL OR position(needle in src) = 0 THEN
    RAISE EXCEPTION 'post_sales_journal auth guard not found; aborting';
  END IF;
  EXECUTE replace(src, needle, repl);

  SELECT pg_get_functiondef('public.post_sales_journal_fifo_by_sku(uuid, date, text, numeric, text, uuid)'::regprocedure) INTO src;
  IF src IS NULL OR position(needle in src) = 0 THEN
    RAISE EXCEPTION 'post_sales_journal_fifo_by_sku auth guard not found; aborting';
  END IF;
  EXECUTE replace(src, needle, repl);
END $$;

DO $$
DECLARE
  src text;
  needle text := $n$IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;$n$;
  repl text := $n$IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_location_kind = 'hub' THEN
    IF NOT public.is_authenticated_active_staff() THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
    END IF;
  ELSIF NOT (
    public.is_authenticated_active_staff()
    OR public.is_supervisor_for_outlet(p_outlet_id)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;$n$;
BEGIN
  SELECT pg_get_functiondef('public.post_waste_event(text, uuid, date, jsonb, text, uuid)'::regprocedure) INTO src;
  IF src IS NULL OR position(needle in src) = 0 THEN
    RAISE EXCEPTION 'post_waste_event auth guard not found; aborting';
  END IF;
  EXECUTE replace(src, needle, repl);
END $$;

DROP POLICY IF EXISTS "Authenticated users can view sales_journals" ON public.sales_journals;
CREATE POLICY "Active staff view sales_journals"
  ON public.sales_journals FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
CREATE POLICY "Supervisor view assigned outlet sales_journals"
  ON public.sales_journals FOR SELECT TO authenticated
  USING (public.is_supervisor_for_outlet(outlet_id));

DROP POLICY IF EXISTS "Authenticated users can view sales_journal_lines" ON public.sales_journal_lines;
CREATE POLICY "Active staff view sales_journal_lines"
  ON public.sales_journal_lines FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
CREATE POLICY "Supervisor view assigned outlet sales_journal_lines"
  ON public.sales_journal_lines FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sales_journals sj
      WHERE sj.id = sales_journal_lines.sales_journal_id
        AND public.is_supervisor_for_outlet(sj.outlet_id)
    )
  );

DROP POLICY IF EXISTS "Authenticated users can view waste_events" ON public.waste_events;
CREATE POLICY "Active staff view waste_events"
  ON public.waste_events FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
CREATE POLICY "Supervisor view assigned outlet waste_events"
  ON public.waste_events FOR SELECT TO authenticated
  USING (
    location_kind = 'outlet'
    AND public.is_supervisor_for_outlet(outlet_id)
  );

DROP POLICY IF EXISTS "Authenticated users can view waste_lines" ON public.waste_lines;
CREATE POLICY "Active staff view waste_lines"
  ON public.waste_lines FOR SELECT TO authenticated
  USING (public.is_authenticated_active_staff());
CREATE POLICY "Supervisor view assigned outlet waste_lines"
  ON public.waste_lines FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.waste_events we
      WHERE we.id = waste_lines.waste_event_id
        AND we.location_kind = 'outlet'
        AND public.is_supervisor_for_outlet(we.outlet_id)
    )
  );
