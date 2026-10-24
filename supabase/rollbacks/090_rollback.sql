-- Rollback 090 (profile role / tag guards). ROLLBACK ORDER (newest first): 089 -> 090 -> 088 -> 087 -> 085 -> 084.
-- Independent of 084/085/087/088: nothing here depends on their rollbacks having run or not. If 085 was rolled back first,
-- user_entities is already gone and its triggers went with it (the DO block below tolerates that). Still run 090 BEFORE 085: while 090's
-- get_users_management_data (it reads user_entities) is live, rolling 085 back first leaves the Users screen without its data until this runs.
--
-- EXACT restore: the profiles guard function, its trigger and get_users_management_data() are re-created VERBATIM from the live
-- definitions captured read-only (pg_get_functiondef / pg_get_triggerdef) on project fknrfntqycfrkaihwngg on 2026-10-24, the
-- same way 087_rollback restores is_profiles_admin(). 090 itself did not change the profiles guard function or its trigger,
-- so re-creating them is idempotent and guarantees the post-rollback state equals live.
-- What this removes: trg_profiles_role_guard / trg_profiles_role_audit (profiles), trg_user_entities_guard / _audit, their four
-- functions, admin_set_procurement_tags and its allow-list row. What it restores: authenticated INSERT/UPDATE/DELETE on user_entities (085's own explicit grant set, with SELECT). It deliberately does NOT
-- hand back TRUNCATE/REFERENCES/TRIGGER, which only Supabase default privileges ever gave (090 revoked them) and which 085 never granted.
-- Tags cleared by 090 when a user left procurement, and the ledger rows 090 wrote, are NOT restored/deleted (the ledger is append-only).

DROP TRIGGER IF EXISTS trg_profiles_role_audit ON public.profiles;
DROP TRIGGER IF EXISTS trg_profiles_role_guard ON public.profiles;
DO $$ BEGIN
  IF to_regclass('public.user_entities') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_user_entities_audit_ins ON public.user_entities';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_user_entities_audit_upd ON public.user_entities';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_user_entities_audit_del ON public.user_entities';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_user_entities_guard ON public.user_entities';
    EXECUTE 'GRANT INSERT, UPDATE, DELETE ON public.user_entities TO authenticated';
  END IF;
  IF to_regclass('public.procurement_exposure_allow') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.procurement_exposure_allow WHERE kind = ''function'' AND name = ''admin_set_procurement_tags''';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.admin_set_procurement_tags(uuid, text[]);
DROP FUNCTION IF EXISTS public.user_entities_audit_write();
DROP FUNCTION IF EXISTS public.user_entities_guard_write();
DROP FUNCTION IF EXISTS public.profiles_audit_role_change();
DROP FUNCTION IF EXISTS public.profiles_guard_role_change();

-- live profiles guard function (verbatim) and its trigger
CREATE OR REPLACE FUNCTION public.profiles_enforce_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bypass text;
  jwt_role text;
BEGIN
  bypass := current_setting('quackmaster.bypass_profile_privilege_guard', true);
  IF bypass = 'on' THEN
    RETURN NEW;
  END IF;

  jwt_role := coalesce(
    auth.jwt() ->> 'role',
    current_setting('request.jwt.claim.role', true),
    ''
  );

  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NULL THEN
      NEW.role := 'pending';
      NEW.assigned_outlet_id := NULL;
      NEW.is_active := true;
      NEW.deactivated_at := NULL;
      NEW.deactivated_by := NULL;
      RETURN NEW;
    END IF;

    IF public.is_profiles_admin() THEN
      RETURN NEW;
    END IF;

    NEW.role := 'pending';
    NEW.assigned_outlet_id := NULL;
    NEW.password_reset_required := false;
    NEW.is_active := true;
    NEW.deactivated_at := NULL;
    NEW.deactivated_by := NULL;
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.assigned_outlet_id IS DISTINCT FROM OLD.assigned_outlet_id
     OR NEW.password_reset_required IS DISTINCT FROM OLD.password_reset_required
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
     OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by THEN
    IF public.is_profiles_admin() THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'profiles: cannot change role, assigned_outlet_id, password_reset_required, or active status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_profiles_enforce_privileged_columns ON public.profiles;
CREATE TRIGGER trg_profiles_enforce_privileged_columns BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION profiles_enforce_privileged_columns();

-- live get_users_management_data (verbatim; without entity_tags)
CREATE OR REPLACE FUNCTION public.get_users_management_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  is_admin boolean;
  approved jsonb;
  pending jsonb;
  approved_regs jsonb;
  rejected_regs jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND is_active
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
        'password_reset_required', s.password_reset_required, 'is_active', s.is_active, 'deactivated_at', s.deactivated_at,
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
      p.password_reset_required, p.is_active, p.deactivated_at,
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
$function$;
