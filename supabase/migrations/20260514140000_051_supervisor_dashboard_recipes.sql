/*
  Recipes: default FG batch label for dashboards / planners.
  Profiles: supervisor role + assigned_outlet_id.
  Stock take: supervisors may post only for assigned outlet (RPC + RLS).
  Inventory visibility: supervisors see outlet_inventory / stock_take only for their outlet.
*/

-- Recipes
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS default_product_batch text;

COMMENT ON COLUMN public.recipes.default_product_batch IS 'Canonical hub/outlet FG product_batch string for KPIs and stock take grouping.';

-- Profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS assigned_outlet_id uuid REFERENCES public.outlets(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.assigned_outlet_id IS 'For role supervisor: outlet this user may inventory / stock-take only.';

CREATE OR REPLACE FUNCTION public.profile_can_post_outlet_stock_take(p_outlet_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_outlet_id IS NULL THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) IN ('admin', 'staff')
        AND lower(trim(p.role::text)) <> 'pending'
    ) THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND p.assigned_outlet_id = p_outlet_id
    ) THEN true
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.profile_can_post_outlet_stock_take(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_can_post_outlet_stock_take(uuid) TO authenticated;

-- Stock take RPC auth: allow supervisors for their outlet
CREATE OR REPLACE FUNCTION public.post_outlet_stock_take(
  p_outlet_id uuid,
  p_count_date date,
  p_notes text,
  p_lines jsonb,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session_id uuid;
  rec jsonb;
  v_oi_id uuid;
  v_counted numeric;
  v_remark text;
  v_qoh numeric;
  v_res numeric;
  v_sys numeric;
  v_var numeric;
  v_lines_out jsonb := '[]'::jsonb;
  v_existing uuid;
  seen_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_uid IS NULL OR NOT public.profile_can_post_outlet_stock_take(p_outlet_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM public.outlet_stock_take_sessions
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'session_id', v_existing,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'lines_required');
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_counted := NULLIF(rec->>'counted_qty', '')::numeric;

    IF v_oi_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_line');
    END IF;

    IF v_oi_id = ANY(seen_ids) THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_outlet_inventory_id', 'outlet_inventory_id', v_oi_id);
    END IF;
    seen_ids := array_append(seen_ids, v_oi_id);

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id AND oi.outlet_id = p_outlet_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'outlet_inventory_not_found',
        'outlet_inventory_id', v_oi_id
      );
    END IF;

    IF v_counted < v_res THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'counted_below_reserved',
        'outlet_inventory_id', v_oi_id,
        'reserved', v_res,
        'counted', v_counted
      );
    END IF;
  END LOOP;

  INSERT INTO public.outlet_stock_take_sessions (
    outlet_id,
    count_date,
    notes,
    idempotency_key,
    created_by
  )
  VALUES (
    p_outlet_id,
    COALESCE(p_count_date, CURRENT_DATE),
    NULLIF(trim(both from p_notes), ''),
    p_idempotency_key,
    v_uid
  )
  RETURNING id INTO v_session_id;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_oi_id := NULLIF(trim(both from rec->>'outlet_inventory_id'), '')::uuid;
    v_counted := NULLIF(rec->>'counted_qty', '')::numeric;
    v_remark := NULLIF(trim(both from rec->>'line_remark'), '');

    SELECT oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
    INTO v_qoh, v_res
    FROM public.outlet_inventory oi
    WHERE oi.id = v_oi_id AND oi.outlet_id = p_outlet_id
    FOR UPDATE;

    v_sys := v_qoh;
    v_var := v_counted - v_sys;

    UPDATE public.outlet_inventory oi
    SET
      quantity_on_hand = v_counted,
      available_quantity = v_counted - v_res,
      last_updated = now(),
      updated_at = now()
    WHERE oi.id = v_oi_id;

    INSERT INTO public.outlet_stock_take_lines (
      session_id,
      outlet_inventory_id,
      system_qoh_before,
      counted_qty,
      variance,
      line_remark
    )
    VALUES (v_session_id, v_oi_id, v_sys, v_counted, v_var, v_remark);

    v_lines_out := v_lines_out || jsonb_build_array(
      jsonb_build_object(
        'outlet_inventory_id', v_oi_id,
        'system_qoh_before', v_sys,
        'counted_qty', v_counted,
        'variance', v_var,
        'line_remark', COALESCE(to_jsonb(v_remark), 'null'::jsonb)
      )
    );
  END LOOP;

  PERFORM public._append_data_ledger(
    'posted',
    'outlet_stock_take',
    v_session_id::text,
    'inventory',
    'event',
    NULL,
    NULL,
    jsonb_build_object(
      'outlet_id', p_outlet_id,
      'count_date', COALESCE(p_count_date, CURRENT_DATE),
      'lines', v_lines_out
    ),
    NULL,
    jsonb_build_object('notes', p_notes)
  );

  RETURN jsonb_build_object(
    'success', true,
    'session_id', v_session_id,
    'lines', v_lines_out
  );
END;
$$;

-- RLS: outlet_inventory — supervisor sees only assigned outlet
DROP POLICY IF EXISTS "Authenticated users can view outlet inventory" ON public.outlet_inventory;

CREATE POLICY "Supervisor view outlet inventory for assigned outlet"
  ON public.outlet_inventory FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND outlet_inventory.outlet_id = p.assigned_outlet_id
    )
  );

CREATE POLICY "Non supervisor view all outlet inventory"
  ON public.outlet_inventory FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) <> 'supervisor'
    )
  );

-- Stock take session / line visibility
DROP POLICY IF EXISTS "Non-pending users can view outlet stock take sessions" ON public.outlet_stock_take_sessions;
DROP POLICY IF EXISTS "Non-pending users can view outlet stock take lines" ON public.outlet_stock_take_lines;

CREATE POLICY "Supervisor view stock take sessions for assigned outlet"
  ON public.outlet_stock_take_sessions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND outlet_stock_take_sessions.outlet_id = p.assigned_outlet_id
    )
  );

CREATE POLICY "Non supervisor view outlet stock take sessions"
  ON public.outlet_stock_take_sessions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) <> 'pending'
        AND lower(trim(p.role::text)) <> 'supervisor'
    )
  );

CREATE POLICY "Supervisor view stock take lines via session outlet"
  ON public.outlet_stock_take_lines FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.outlet_stock_take_sessions s
      JOIN public.profiles p ON p.id = auth.uid()
      WHERE s.id = outlet_stock_take_lines.session_id
        AND lower(trim(p.role::text)) = 'supervisor'
        AND p.assigned_outlet_id IS NOT NULL
        AND s.outlet_id = p.assigned_outlet_id
    )
  );

CREATE POLICY "Non supervisor view outlet stock take lines"
  ON public.outlet_stock_take_lines FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(trim(p.role::text)) <> 'pending'
        AND lower(trim(p.role::text)) <> 'supervisor'
    )
  );

-- Block supervisor role without outlet (application should enforce; DB safety)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_supervisor_requires_outlet;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_supervisor_requires_outlet
  CHECK (
    lower(trim(role::text)) <> 'supervisor'
    OR assigned_outlet_id IS NOT NULL
  );

-- Admin promote/demote: reject legacy toggle for supervisors
CREATE OR REPLACE FUNCTION public.set_registered_user_admin_role(
  p_target_user_id uuid,
  p_make_admin boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  v_role text;
  v_new_role text;
  v_admin_count integer;
  v_updated integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'unauthenticated',
      'message', 'You must be signed in'
    );
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'forbidden',
      'message', 'Only admins can change user roles'
    );
  END IF;

  IF p_target_user_id = auth.uid() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_target',
      'message', 'You cannot change your own role'
    );
  END IF;

  SET LOCAL row_security = off;

  SELECT p.role
  INTO v_role
  FROM public.profiles p
  WHERE p.id = p_target_user_id;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not_found',
      'message', 'User profile not found'
    );
  END IF;

  IF lower(trim(v_role)) = 'supervisor' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_state',
      'message', 'Outlet supervisors must be updated via role & outlet assignment'
    );
  END IF;

  IF v_role NOT IN ('admin', 'staff') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_state',
      'message', 'Only approved users (staff or admin) can be promoted or demoted'
    );
  END IF;

  v_new_role := CASE WHEN p_make_admin THEN 'admin' ELSE 'staff' END;

  IF v_role = v_new_role THEN
    RETURN jsonb_build_object(
      'success', true,
      'role', v_new_role,
      'message', 'Role unchanged'
    );
  END IF;

  IF v_role = 'admin' AND v_new_role = 'staff' THEN
    SELECT COUNT(*)::integer
    INTO v_admin_count
    FROM public.profiles
    WHERE role = 'admin';

    IF v_admin_count <= 1 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'last_admin',
        'message', 'Cannot remove the last administrator'
      );
    END IF;
  END IF;

  UPDATE public.profiles
  SET role = v_new_role
  WHERE id = p_target_user_id
    AND role IN ('admin', 'staff');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'update_failed',
      'message', 'Could not update role'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'role', v_new_role
  );
END;
$$;

-- Admin: set role (admin | staff | supervisor) and optional outlet
CREATE OR REPLACE FUNCTION public.admin_set_profile_role_and_outlet(
  p_target_user_id uuid,
  p_role text,
  p_assigned_outlet_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  v_norm text := lower(trim(p_role));
  v_current text;
  v_admin_count integer;
  v_updated integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated', 'message', 'You must be signed in');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only admins can change roles');
  END IF;

  IF p_target_user_id = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target', 'message', 'You cannot change your own role this way');
  END IF;

  IF v_norm NOT IN ('admin', 'staff', 'supervisor') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_role', 'message', 'Role must be admin, staff, or supervisor');
  END IF;

  IF v_norm = 'supervisor' AND p_assigned_outlet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'outlet_required', 'message', 'Supervisors require an assigned outlet');
  END IF;

  SET LOCAL row_security = off;

  SELECT role INTO v_current FROM public.profiles WHERE id = p_target_user_id;
  IF v_current IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found', 'message', 'User profile not found');
  END IF;

  IF lower(trim(v_current)) = 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_state', 'message', 'Approve pending users before assigning supervisor/admin');
  END IF;

  IF lower(trim(v_current)) = 'admin' AND v_norm <> 'admin' THEN
    SELECT COUNT(*)::integer INTO v_admin_count FROM public.profiles WHERE role = 'admin';
    IF v_admin_count <= 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'last_admin', 'message', 'Cannot remove the last administrator');
    END IF;
  END IF;

  UPDATE public.profiles
  SET
    role = v_norm,
    assigned_outlet_id = CASE WHEN v_norm = 'supervisor' THEN p_assigned_outlet_id ELSE NULL END,
    updated_at = now()
  WHERE id = p_target_user_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'update_failed', 'message', 'Could not update profile');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'role', v_norm,
    'assigned_outlet_id', CASE WHEN v_norm = 'supervisor' THEN p_assigned_outlet_id ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_profile_role_and_outlet(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_profile_role_and_outlet(uuid, text, uuid) TO authenticated;

-- Users management payload: include assigned_outlet_id (full shape from 022)
CREATE OR REPLACE FUNCTION public.get_users_management_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  is_admin boolean;
  approved jsonb;
  pending jsonb;
  approved_regs jsonb;
  rejected_regs jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ) INTO is_admin;

  IF NOT COALESCE(is_admin, false) THEN
    RETURN jsonb_build_object(
      'error', 'forbidden',
      'message', 'Only admins can load user management data'
    );
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'full_name', s.full_name,
        'role', s.role,
        'assigned_outlet_id', s.assigned_outlet_id,
        'last_login', s.last_login,
        'password_reset_required', s.password_reset_required,
        'created_at', s.created_at,
        'email', s.email_out
      )
      ORDER BY s.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO approved
  FROM (
    SELECT
      p.id,
      p.full_name,
      p.role,
      p.assigned_outlet_id,
      p.last_login,
      p.password_reset_required,
      p.created_at,
      COALESCE(
        NULLIF(trim(COALESCE(au.email::text, '')), ''),
        NULLIF(trim(COALESCE(pr.email, '')), ''),
        ''
      ) AS email_out
    FROM public.profiles p
    LEFT JOIN auth.users au ON au.id = p.id
    LEFT JOIN public.pending_registrations pr
      ON pr.user_id = p.id AND pr.status = 'approved'
    WHERE p.role <> 'pending'
  ) s;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.user_id,
        'registration_id', pr.id,
        'email', pr.email,
        'full_name', pr.full_name,
        'status', pr.status,
        'requested_at', pr.requested_at,
        'created_at', pr.created_at,
        'reviewed_at', pr.reviewed_at,
        'reviewed_by', pr.reviewed_by
      )
      ORDER BY pr.requested_at DESC
    ),
    '[]'::jsonb
  )
  INTO pending
  FROM public.pending_registrations pr
  WHERE pr.status = 'pending';

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.user_id,
        'registration_id', pr.id,
        'email', pr.email,
        'full_name', pr.full_name,
        'status', pr.status,
        'requested_at', pr.requested_at,
        'reviewed_at', pr.reviewed_at,
        'reviewed_by', pr.reviewed_by,
        'created_at', pr.created_at
      )
      ORDER BY pr.reviewed_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO approved_regs
  FROM public.pending_registrations pr
  WHERE pr.status = 'approved';

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', pr.user_id,
        'registration_id', pr.id,
        'email', pr.email,
        'full_name', pr.full_name,
        'status', pr.status,
        'requested_at', pr.requested_at,
        'reviewed_at', pr.reviewed_at,
        'reviewed_by', pr.reviewed_by,
        'rejection_reason', pr.rejection_reason,
        'created_at', pr.created_at
      )
      ORDER BY pr.reviewed_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO rejected_regs
  FROM public.pending_registrations pr
  WHERE pr.status = 'rejected';

  RETURN jsonb_build_object(
    'approved', approved,
    'pending', pending,
    'approved_registrations', approved_regs,
    'rejected_registrations', rejected_regs
  );
END;
$$;

