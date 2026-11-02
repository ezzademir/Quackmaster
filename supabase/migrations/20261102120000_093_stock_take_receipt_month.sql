-- 093: keep a blind count's receipt month on the session, and resolve which lines
-- were received that month without reading outlet_inventory / outlet_stock_movements
-- as the caller.
-- RUN AS ONE BATCH: psql -1 -v ON_ERROR_STOP=1 -f <this file>. NEVER plain `psql -f`.
-- Rollback: supabase/rollbacks/093_rollback.sql
--
-- While a count is open, restrictive RLS hides those two tables from non-admins.
-- The count screen was reading them directly, so a second device saw an empty
-- receipt list, dropped the month, and submitted every current line. Submission
-- sets quantity_on_hand to the counted quantity, including 0. The month is now
-- written in the same transaction that opens the count, and the id lookup is
-- SECURITY DEFINER so it still works while quantities are hidden. It returns
-- ids only — no quantities.

ALTER TABLE public.outlet_stock_take_sessions
  ADD COLUMN IF NOT EXISTS receipt_month text;

DO $c$ BEGIN
  ALTER TABLE public.outlet_stock_take_sessions
    ADD CONSTRAINT outlet_stock_take_sessions_receipt_month_check
    CHECK (receipt_month IS NULL OR receipt_month ~ '^\d{4}-(0[1-9]|1[0-2])$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

COMMENT ON COLUMN public.outlet_stock_take_sessions.receipt_month IS
  'YYYY-MM of goods this open count is limited to (hub supply or transfer, or the row''s first Malaysia calendar month). NULL = every current line. Set once when the count opens.';

-- Ids only. Not granted to clients: it does not check the caller.
CREATE OR REPLACE FUNCTION public._outlet_inventory_received_in_month(p_outlet_id uuid, p_year_month text)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT oi.id), ARRAY[]::uuid[])
  FROM public.outlet_inventory oi
  WHERE oi.outlet_id = p_outlet_id
    AND (
      (oi.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date
        BETWEEN (p_year_month || '-01')::date
            AND ((p_year_month || '-01')::date + interval '1 month' - interval '1 day')::date
      OR EXISTS (
        SELECT 1
        FROM public.outlet_stock_movements m
        WHERE m.outlet_inventory_id = oi.id
          AND m.outlet_id = p_outlet_id
          AND m.movement_type IN ('supply_in', 'transfer_in')
          AND m.business_date BETWEEN (p_year_month || '-01')::date
              AND ((p_year_month || '-01')::date + interval '1 month' - interval '1 day')::date
      )
    );
$$;

REVOKE ALL ON FUNCTION public._outlet_inventory_received_in_month(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._outlet_inventory_received_in_month(uuid, text) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_outlet_inventory_received_in_month(p_outlet_id uuid, p_year_month text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_month text := NULLIF(trim(both from COALESCE(p_year_month, '')), '');
  v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.profile_can_post_outlet_stock_take(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;
  IF v_month IS NULL OR v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_month');
  END IF;
  v_ids := public._outlet_inventory_received_in_month(p_outlet_id, v_month);
  RETURN jsonb_build_object(
    'success', true,
    'ids', COALESCE((SELECT jsonb_agg(x) FROM unnest(v_ids) AS x), '[]'::jsonb)
  );
END;
$$;

-- One-shot lock. A different month cannot replace the one stored on an open count.
CREATE OR REPLACE FUNCTION public.set_outlet_stock_take_receipt_month(p_session_id uuid, p_year_month text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sess public.outlet_stock_take_sessions%ROWTYPE;
  v_month text := NULLIF(trim(both from COALESCE(p_year_month, '')), '');
BEGIN
  IF v_month IS NULL OR v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_month');
  END IF;
  SELECT * INTO v_sess
  FROM public.outlet_stock_take_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
  END IF;
  IF v_uid IS NULL OR NOT public.profile_can_post_outlet_stock_take(v_sess.outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;
  IF v_sess.status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_not_open');
  END IF;
  IF v_sess.receipt_month IS NOT NULL AND v_sess.receipt_month IS DISTINCT FROM v_month THEN
    RETURN jsonb_build_object('success', false, 'error', 'receipt_month_locked', 'receipt_month', v_sess.receipt_month);
  END IF;
  UPDATE public.outlet_stock_take_sessions
  SET receipt_month = v_month
  WHERE id = p_session_id;
  RETURN jsonb_build_object('success', true, 'session_id', p_session_id, 'receipt_month', v_month);
END;
$$;

-- Opens (or resumes) a blind count and, for a new count, stores the receipt month
-- before the transaction commits. An empty month does not leave an open session.
CREATE OR REPLACE FUNCTION public.begin_outlet_stock_take(
  p_outlet_id uuid,
  p_count_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_receipt_month text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_requested text := NULLIF(trim(both from COALESCE(p_receipt_month, '')), '');
  v_res jsonb;
  v_id uuid;
  v_resumed boolean;
  v_month text;
  v_ids uuid[];
BEGIN
  IF v_requested IS NOT NULL AND v_requested !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_month');
  END IF;

  BEGIN
    v_res := public.start_outlet_stock_take(p_outlet_id, p_count_date, p_notes);
    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RETURN v_res;
    END IF;
    v_id := (v_res->>'session_id')::uuid;
    v_resumed := COALESCE((v_res->>'resumed')::boolean, false);

    IF v_resumed THEN
      SELECT s.receipt_month INTO v_month
      FROM public.outlet_stock_take_sessions s
      WHERE s.id = v_id;
    ELSIF v_requested IS NOT NULL THEN
      v_ids := public._outlet_inventory_received_in_month(p_outlet_id, v_requested);
      IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
        RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.outlet_stock_take_sessions
      SET receipt_month = v_requested
      WHERE id = v_id;
      v_month := v_requested;
    ELSE
      v_month := NULL;
    END IF;

    IF v_month IS NOT NULL THEN
      v_ids := public._outlet_inventory_received_in_month(p_outlet_id, v_month);
    ELSE
      v_ids := NULL;
    END IF;

    RETURN v_res || jsonb_build_object(
      'receipt_month', v_month,
      'received_ids', CASE
        WHEN v_month IS NULL THEN NULL
        ELSE COALESCE((SELECT jsonb_agg(x) FROM unnest(v_ids) AS x), '[]'::jsonb)
      END
    );
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM = 'no_receipt_lines' THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_lines');
      END IF;
      RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.list_outlet_inventory_received_in_month(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_outlet_stock_take_receipt_month(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_outlet_stock_take(uuid, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_outlet_inventory_received_in_month(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_outlet_stock_take_receipt_month(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_outlet_stock_take(uuid, date, text, text) TO authenticated, service_role;
