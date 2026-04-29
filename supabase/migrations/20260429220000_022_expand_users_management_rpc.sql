/*
  # Expand get_users_management_data()

  - Registered users: emails from auth.users (canonical), then pending_registrations (approved row).
  - pending: all pending_registrations with status = 'pending'.
  - approved_registrations: all rows with status = 'approved' (audit trail).
  - rejected_registrations: all rows with status = 'rejected' (includes rejection_reason).

  Requires VOLATILE + SECURITY DEFINER + row_security off (same as 020).
*/

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

  -- Active directory: profiles not stuck in pending; email from auth then registration snapshot
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'full_name', s.full_name,
        'role', s.role,
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
