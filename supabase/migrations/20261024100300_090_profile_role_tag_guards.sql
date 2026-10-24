/*
  090: role and business-tag changes are enforced in the DATABASE (not the screen), audited, and cannot lock out the last admin.
  Own change set: NOT in the 089 cancel-request work. The bill void/reverse route is a separate PR (not here, not in 089).

  APPLY ORDER: 084, 085, 087, 088, 090, then 089 (089 must be stamped after this file).
  Depends on 085 (user_entities, 'procurement' role, procurement_exposure_allow) and 087 (is_profiles_admin); the pre-check below refuses to run
  without either one. Independent of 084/088 data.
  ROLLBACK ORDER (newest first): 089 -> 090 -> 088 -> 087 -> 085 -> 084. supabase/rollbacks/090_rollback.sql is independent of
  084/085/087/088: it restores the live definitions verbatim, and it tolerates user_entities already being gone.
  Keep the order anyway: 090's get_users_management_data reads user_entities, so 085 must not be rolled back while 090 is live.

  SNAPSHOT (live, read-only metadata, 24 Oct 2026, project fknrfntqycfrkaihwngg), what this file was written against:
    profiles: RLS on (not forced); policies "Admins can view all profiles" (SELECT), "Admins can update all profiles" (UPDATE),
      "Users can insert own profile", "Users can update own profile" (UPDATE, auth.uid() = id), "Users can view own profile";
      authenticated holds INSERT/SELECT/UPDATE/DELETE (no DELETE policy, so no delete); ONE trigger:
      trg_profiles_enforce_privileged_columns (BEFORE INSERT OR UPDATE) -> profiles_enforce_privileged_columns().
    user_entities does not exist live yet (085 is not applied); its definition here is 085's.
    is_profiles_admin() = active admin; _append_data_ledger() executable by postgres/service_role only (definer callers).
  Differences from the migration files: none found for profiles / trigger / functions (the live bodies are pinned verbatim in
    src/utils/__fixtures__/live_profiles_guard_20261024.sql and compared in the tests). The live admin_set_profile_role_and_outlet role list is
    still admin/staff/supervisor because 085 is not applied; 085 patches it.

  PRE-APPLY REQUIREMENT: a run on a SEEDED COPY of live with REAL JWTs (an admin, a staff user, a procurement user, and the only admin)
  must pass before this is applied to live: the PGlite tests simulate auth.uid() and cannot prove the PostgREST/JWT path.
  Checklist: procurement and staff each fail to change their own role/tags (RPC and direct update); admin changes another user's role and
  tags and both appear in data_ledger with old and new values; the sole active admin cannot be demoted, deactivated or deleted. ALSO, on that copy:
    a. the owner of each new SECURITY DEFINER function has BYPASSRLS (pg_roles.rolbypassrls) and the functions carry search_path = public, pg_temp;
    b. authenticated and anon hold NO privilege at all on user_entities except SELECT for authenticated (no TRUNCATE, REFERENCES, TRIGGER);
    c. get_users_management_data() contains the 'email' line exactly once (the in-place patch did not duplicate it);
    d. data_ledger ACCEPTS the new rows (role_changed and tags_changed, operation 'update'): one real role change and one tag change as admin, both ledgered;
    e. a reverse-order ROLLBACK REHEARSAL: 090, 088, 087, 085, 084 in that order (and 085 refuses while 090 is live), then apply 084, 085, 087, 088, 090 again;
    f. a same-day count of exactly 32 untagged purchase orders (the number the tag backfill was written against) before 084/085 are applied.

  What it does
    1. profiles BEFORE UPDATE/DELETE trigger trg_profiles_role_guard:
         - role / assigned_outlet_id change: signed-in callers must be an active admin AND not the row's own user. Applies to the
           admin RPC AND to direct table updates (the existing 062/071 trigger stays; this closes the admin self-edit gap).
         - the last ACTIVE admin cannot be demoted, deactivated or deleted, for ANY caller (including service_role and the owner),
           and the quackmaster.bypass_profile_privilege_guard flag does not skip it. Recovery is the written BREAK-GLASS step below
           (never an improvised trigger drop).
         - an admin cannot deactivate their OWN row on any path (direct UPDATE or RPC); another admin still can. A direct is_active change
           (not through the 071 RPC, which writes its own entry) is ledgered by this trigger (deactivated / reactivated, fail closed).
    2. profiles AFTER UPDATE trigger trg_profiles_role_audit: every role / outlet change writes one data_ledger entry
       (action role_changed, operation 'update') with before/after role, outlet and tags. Moving a user AWAY from procurement
       CLEARS their tags (each removal is its own ledgered entry, below).
    3. user_entities: BEFORE trigger (signed-in callers: admin only, never their own row, target must be a procurement user) and
       AFTER statement triggers (one ledger entry per user per statement: action tags_changed, operation 'update', before/after full tag lists;
       a replace that both adds and removes is two statements, so two chained entries).
       ALL privileges are revoked from PUBLIC/anon/authenticated (no INSERT/UPDATE/DELETE, and no TRUNCATE/REFERENCES/TRIGGER) and only SELECT is
       granted back: clients change tags only through admin_set_procurement_tags().
    4. admin_set_procurement_tags(user, tags[]): admin only, not self, target must be a procurement user, at least one tag,
       every tag must exist in procurement_tags; replaces the set.
    5. get_users_management_data(): each approved user also carries entity_tags (patched in place, nothing else changes).
       NOTE: 090_rollback.sql puts the live get_users_management_data back by OVERWRITING THE WHOLE FUNCTION with the captured live text; it does
       not reverse the patch. Any later migration that changes that function must be rolled back (or re-based) before 090 is rolled back.
    All new SECURITY DEFINER functions pin search_path = public, pg_temp (pg_temp last).
  BREAK-GLASS (the only active admin is lost or locked out and must be removed or replaced). Run ONLY on Ezzad's explicit word; never improvise a
  trigger drop, a DISABLE TRIGGER, or a bypass flag (the flag does not skip this guard anyway).
    1. Confirm in SQL (read-only) that exactly one active admin exists and that the account is really unreachable.
    2. Run supabase/rollbacks/090_rollback.sql (restores the pre-090 guard; the last-admin rule is gone with it).
    3. As service_role / the owner, in one transaction: promote the replacement (UPDATE profiles SET role='admin' WHERE id = <replacement>), then
       demote or deactivate the lost account. This goes through the existing 062/071 guard, which stays in place.
    4. Check: SELECT count(*) FROM profiles WHERE role='admin' AND is_active  -> at least 1 (the replacement), then RE-APPLY this file (090 is re-runnable).
    5. Write down who, when and why: 090's audit triggers are off between steps 2 and 4, so the role changes made in step 3 get NO data_ledger row.
  (Note, tested: with 090 live, a service_role promote of a replacement admin is itself allowed; only demoting/deactivating/deleting the LAST active admin
  is refused. If a replacement can be promoted first, the lost account can then be demoted with 090 still live and the rollback is not needed.)
  Ledger (fail closed): only the allowed operations (insert/update/delete/event) are used, and the audit triggers (role/outlet, tags, direct is_active) INSERT INTO
  data_ledger DIRECTLY (not through _append_data_ledger, which swallows a failed insert into a WARNING and is left untouched). If the
  ledger insert fails, the role / outlet / tag change is rolled back with it, on every path (role RPC, direct update, admin_set_procurement_tags,
  clearing tags on leaving procurement, direct deactivate/reactivate, service_role). Consequence to know: if data_ledger is broken, role and tag changes stop until it is fixed.
*/

DO $$ BEGIN
  IF to_regclass('public.user_entities') IS NULL THEN
    RAISE EXCEPTION '090 depends on 085 (public.user_entities is missing)';
  END IF;
  -- 087: is_profiles_admin() must carry its function-level SET row_security = off. Without it the live body (SET LOCAL row_security = off)
  -- leaks into the rest of the transaction, and the 090 triggers call is_profiles_admin() inside every role/tag write.
  IF to_regprocedure('public.is_profiles_admin()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.is_profiles_admin()'::regprocedure
                    AND EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c WHERE c = 'row_security=off')) THEN
    RAISE EXCEPTION '090 depends on 087 (public.is_profiles_admin() must be the 087 version with SET row_security = off)';
  END IF;
END $$;

-- ---------------------------------------------------------------- shared caller classification
-- A "signed-in caller" has an auth.uid(), or a client JWT role without one. service_role / the table owner (migrations, edge
-- functions with the service key) have neither and are not subject to the admin-only / own-row rules (the audit still runs).

-- ---------------------------------------------------------------- profiles: role / outlet guard + last-admin guard
CREATE OR REPLACE FUNCTION public.profiles_guard_role_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_jwt_role text := coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true), '');
  v_others integer;
  v_email text := '';
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.assigned_outlet_id IS DISTINCT FROM OLD.assigned_outlet_id)
     AND (v_uid IS NOT NULL OR v_jwt_role IN ('authenticated', 'anon')) THEN
    IF v_uid IS NULL OR NOT public.is_profiles_admin() THEN
      RAISE EXCEPTION 'profiles: only an admin can change a role or outlet' USING ERRCODE = '42501';
    END IF;
    IF OLD.id = v_uid THEN
      RAISE EXCEPTION 'profiles: you cannot change your own role or outlet' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF OLD.role = 'admin' AND OLD.is_active
     AND (TG_OP = 'DELETE' OR NEW.role IS DISTINCT FROM 'admin' OR NOT NEW.is_active) THEN
    -- lock the OTHER active admins so two admins cannot remove each other at the same time (a deadlock aborts one of them)
    PERFORM 1 FROM public.profiles p WHERE p.role = 'admin' AND p.is_active AND p.id <> OLD.id FOR UPDATE;
    SELECT count(*)::integer INTO v_others FROM public.profiles p WHERE p.role = 'admin' AND p.is_active AND p.id <> OLD.id;
    IF v_others < 1 THEN
      RAISE EXCEPTION 'last_active_admin: the last active administrator cannot be demoted, deactivated or removed' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- H10: an admin cannot deactivate their OWN row on any path (direct UPDATE, RPC, ...). Another admin still can (and the last one is protected above).
  -- The bypass flag does not skip this; service_role / the owner have no auth.uid() and are not affected.
  IF TG_OP = 'UPDATE' AND v_uid IS NOT NULL AND OLD.id = v_uid AND OLD.role = 'admin' AND OLD.is_active AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'profiles: you cannot deactivate your own account' USING ERRCODE = '42501';
  END IF;

  -- H10: a direct is_active change (not the 071 RPC, which sets the bypass flag and writes its own entry) is ledgered here. Direct insert, so a
  -- failed audit aborts the change (fail closed).
  IF TG_OP = 'UPDATE' AND NEW.is_active IS DISTINCT FROM OLD.is_active
     AND coalesce(current_setting('quackmaster.bypass_profile_privilege_guard', true), '') <> 'on' THEN
    IF v_uid IS NOT NULL THEN
      BEGIN   -- only the e-mail lookup is best-effort; the ledger insert below is not
        SELECT COALESCE(u.email::text, '') INTO v_email FROM auth.users u WHERE u.id = v_uid;
      EXCEPTION WHEN OTHERS THEN v_email := '';
      END;
    END IF;
    INSERT INTO public.data_ledger (user_id, user_email, action, entity_type, entity_id, module, operation, before_data, after_data, metadata)
    VALUES (v_uid, COALESCE(v_email, ''), CASE WHEN NEW.is_active THEN 'reactivated' ELSE 'deactivated' END, 'profile', OLD.id::text, 'users', 'update',
      jsonb_build_object('is_active', OLD.is_active, 'deactivated_at', OLD.deactivated_at),
      jsonb_build_object('is_active', NEW.is_active, 'deactivated_at', NEW.deactivated_at),
      CASE WHEN v_uid IS NULL THEN jsonb_build_object('source', 'profiles_trigger', 'actor', 'system') ELSE jsonb_build_object('source', 'profiles_trigger') END);
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.profiles_guard_role_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_role_guard ON public.profiles;
CREATE TRIGGER trg_profiles_role_guard BEFORE UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_role_change();

-- ---------------------------------------------------------------- profiles: audit + clear tags when leaving procurement
CREATE OR REPLACE FUNCTION public.profiles_audit_role_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old_tags text[] := ARRAY[]::text[];
  v_cleared text[] := ARRAY[]::text[];
  v_uid uuid := auth.uid();
  v_email text := '';
  v_meta jsonb := jsonb_build_object('source', 'profiles_trigger');
BEGIN
  IF to_regclass('public.user_entities') IS NOT NULL THEN
    EXECUTE 'SELECT COALESCE(array_agg(procurement_tag ORDER BY procurement_tag), ARRAY[]::text[]) FROM public.user_entities WHERE user_id = $1'
      INTO v_old_tags USING OLD.id;
    IF OLD.role = 'procurement' AND NEW.role IS DISTINCT FROM 'procurement' AND cardinality(v_old_tags) > 0 THEN
      v_cleared := v_old_tags;
      -- each removal is audited by the user_entities trigger (old and new tag list)
      EXECUTE 'DELETE FROM public.user_entities WHERE user_id = $1' USING OLD.id;
    END IF;
  END IF;

  v_meta := v_meta || jsonb_build_object('tags_cleared', to_jsonb(v_cleared));
  IF v_uid IS NULL THEN
    v_meta := v_meta || jsonb_build_object('actor', 'system');
  ELSE
    BEGIN   -- only the e-mail lookup is best-effort; the ledger insert below is not
      SELECT COALESCE(u.email::text, '') INTO v_email FROM auth.users u WHERE u.id = v_uid;
    EXCEPTION WHEN OTHERS THEN v_email := '';
    END;
  END IF;
  -- direct insert: a failure aborts the role change (fail closed)
  INSERT INTO public.data_ledger (user_id, user_email, action, entity_type, entity_id, module, operation, before_data, after_data, metadata)
  VALUES (v_uid, COALESCE(v_email, ''), 'role_changed', 'profile', OLD.id::text, 'users', 'update',
    jsonb_build_object('role', OLD.role, 'assigned_outlet_id', OLD.assigned_outlet_id, 'tags', to_jsonb(v_old_tags)),
    jsonb_build_object('role', NEW.role, 'assigned_outlet_id', NEW.assigned_outlet_id,
                       'tags', CASE WHEN cardinality(v_cleared) > 0 THEN '[]'::jsonb ELSE to_jsonb(v_old_tags) END),
    v_meta);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.profiles_audit_role_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_role_audit ON public.profiles;
CREATE TRIGGER trg_profiles_role_audit AFTER UPDATE ON public.profiles
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.assigned_outlet_id IS DISTINCT FROM NEW.assigned_outlet_id)
  EXECUTE FUNCTION public.profiles_audit_role_change();

-- ---------------------------------------------------------------- user_entities: guard + audit
CREATE OR REPLACE FUNCTION public.user_entities_guard_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_jwt_role text := coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true), '');
  v_target uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
  IF v_uid IS NOT NULL OR v_jwt_role IN ('authenticated', 'anon') THEN
    IF v_uid IS NULL OR NOT public.is_profiles_admin() THEN
      RAISE EXCEPTION 'user_entities: only an admin can change business tags' USING ERRCODE = '42501';
    END IF;
    IF v_target = v_uid OR (TG_OP = 'UPDATE' AND OLD.user_id = v_uid) THEN
      RAISE EXCEPTION 'user_entities: you cannot change your own business tags' USING ERRCODE = '42501';
    END IF;
    IF TG_OP <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND lower(trim(p.role)) = 'procurement') THEN
      RAISE EXCEPTION 'user_entities: tags can only be assigned to a procurement user' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_entities: user_id cannot be changed (remove and add instead)' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.user_entities_guard_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.user_entities_audit_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_rows jsonb;
  v_added text[];
  v_removed text[];
  v_new text[];
  v_old text[];
  v_uid uuid := auth.uid();
  v_email text := '';
  v_sys boolean := auth.uid() IS NULL;
BEGIN
  -- STATEMENT-level AFTER trigger with transition tables: a statement that touches several tag rows of one user
  -- (clearing a two-tag set, or the RPC's replace) is audited once per user with the exact list before and after.
  -- (A row-level AFTER trigger fires after the whole statement, so every row would see the same final list.)
  -- Each branch names only the transition table that exists for its event.
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('u', g.user_id, 'added', g.tags, 'removed', '[]'::jsonb)), '[]'::jsonb) INTO v_rows
    FROM (SELECT user_id, to_jsonb(array_agg(procurement_tag ORDER BY procurement_tag)) AS tags FROM new_rows GROUP BY user_id) g;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('u', g.user_id, 'added', '[]'::jsonb, 'removed', g.tags)), '[]'::jsonb) INTO v_rows
    FROM (SELECT user_id, to_jsonb(array_agg(procurement_tag ORDER BY procurement_tag)) AS tags FROM old_rows GROUP BY user_id) g;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('u', g.user_id, 'added', g.a, 'removed', g.d)), '[]'::jsonb) INTO v_rows
    FROM (SELECT COALESCE(n.user_id, o.user_id) AS user_id,
                 COALESCE(n.tags, '[]'::jsonb) AS a, COALESCE(o.tags, '[]'::jsonb) AS d
          FROM (SELECT user_id, to_jsonb(array_agg(procurement_tag ORDER BY procurement_tag)) AS tags FROM new_rows GROUP BY user_id) n
          FULL JOIN (SELECT user_id, to_jsonb(array_agg(procurement_tag ORDER BY procurement_tag)) AS tags FROM old_rows GROUP BY user_id) o
            ON o.user_id = n.user_id) g;
  END IF;
  FOR r IN SELECT (e->>'u')::uuid AS user_id, e->'added' AS added, e->'removed' AS removed FROM jsonb_array_elements(v_rows) e
  LOOP
    SELECT COALESCE(array_agg(x), ARRAY[]::text[]) INTO v_added FROM jsonb_array_elements_text(r.added) x;
    SELECT COALESCE(array_agg(x), ARRAY[]::text[]) INTO v_removed FROM jsonb_array_elements_text(r.removed) x;
    SELECT COALESCE(array_agg(ue.procurement_tag ORDER BY ue.procurement_tag), ARRAY[]::text[]) INTO v_new
    FROM public.user_entities ue WHERE ue.user_id = r.user_id;
    -- old list = (new list without what this statement added) + what it removed
    SELECT COALESCE(array_agg(DISTINCT z.t ORDER BY z.t), ARRAY[]::text[]) INTO v_old
    FROM (SELECT x AS t FROM unnest(v_new) x WHERE NOT (x = ANY (v_added))
          UNION SELECT x FROM unnest(v_removed) x) z;
    CONTINUE WHEN v_old = v_new;
    IF NOT v_sys AND v_email = '' THEN
      BEGIN   -- only the e-mail lookup is best-effort; the ledger insert below is not
        SELECT COALESCE(u.email::text, '') INTO v_email FROM auth.users u WHERE u.id = v_uid;
      EXCEPTION WHEN OTHERS THEN v_email := '';
      END;
    END IF;
    -- direct insert: a failure aborts the tag change (fail closed)
    INSERT INTO public.data_ledger (user_id, user_email, action, entity_type, entity_id, module, operation, before_data, after_data, metadata)
    VALUES (v_uid, COALESCE(v_email, ''), 'tags_changed', 'profile', r.user_id::text, 'users', 'update',
      jsonb_build_object('tags', to_jsonb(v_old)), jsonb_build_object('tags', to_jsonb(v_new)),
      jsonb_build_object('source', 'user_entities_trigger',
                         'change', CASE TG_OP WHEN 'INSERT' THEN 'added' WHEN 'DELETE' THEN 'removed' ELSE 'changed' END,
                         'tags_added', to_jsonb(ARRAY(SELECT x FROM unnest(v_new) x WHERE NOT (x = ANY (v_old)))),
                         'tags_removed', to_jsonb(ARRAY(SELECT x FROM unnest(v_old) x WHERE NOT (x = ANY (v_new)))))
        || CASE WHEN v_sys THEN jsonb_build_object('actor', 'system') ELSE '{}'::jsonb END);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.user_entities_audit_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_user_entities_guard ON public.user_entities;
CREATE TRIGGER trg_user_entities_guard BEFORE INSERT OR UPDATE OR DELETE ON public.user_entities
  FOR EACH ROW EXECUTE FUNCTION public.user_entities_guard_write();
DROP TRIGGER IF EXISTS trg_user_entities_audit_ins ON public.user_entities;
DROP TRIGGER IF EXISTS trg_user_entities_audit_upd ON public.user_entities;
DROP TRIGGER IF EXISTS trg_user_entities_audit_del ON public.user_entities;
CREATE TRIGGER trg_user_entities_audit_ins AFTER INSERT ON public.user_entities
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.user_entities_audit_write();
CREATE TRIGGER trg_user_entities_audit_upd AFTER UPDATE ON public.user_entities
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.user_entities_audit_write();
CREATE TRIGGER trg_user_entities_audit_del AFTER DELETE ON public.user_entities
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.user_entities_audit_write();

-- Clients no longer write this table directly: tag changes go through admin_set_procurement_tags (085 granted all four).
-- REVOKE ALL, not just INSERT/UPDATE/DELETE: Supabase's default privileges on public also hand authenticated TRUNCATE, REFERENCES and
-- TRIGGER, and TRUNCATE skips RLS, row triggers and the audit triggers above. Then give back the one verb clients need (own-row
-- and admin SELECT is filtered by the 085 policies).
REVOKE ALL ON public.user_entities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_entities TO authenticated;

-- ---------------------------------------------------------------- admin RPC: replace a procurement user's tags
CREATE OR REPLACE FUNCTION public.admin_set_procurement_tags(p_target_user_id uuid, p_tags text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_new text[];
  v_old text[];
  v_role text;
  v_unknown text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated', 'message', 'You must be signed in');
  END IF;
  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only admins can change business tags');
  END IF;
  IF p_target_user_id IS NULL OR p_target_user_id = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target', 'message', 'You cannot change your own business tags');
  END IF;

  SELECT lower(trim(role)) INTO v_role FROM public.profiles WHERE id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found', 'message', 'User profile not found');
  END IF;
  IF v_role IS DISTINCT FROM 'procurement' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_procurement', 'message', 'Business tags can only be assigned to a procurement user');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT lower(trim(t)) ORDER BY lower(trim(t))), ARRAY[]::text[]) INTO v_new
  FROM unnest(COALESCE(p_tags, ARRAY[]::text[])) t WHERE trim(COALESCE(t, '')) <> '';
  IF cardinality(v_new) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'tags_required', 'message', 'Pick at least one business tag');
  END IF;
  SELECT COALESCE(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_unknown
  FROM unnest(v_new) t WHERE NOT EXISTS (SELECT 1 FROM public.procurement_tags pt WHERE pt.tag = t);
  IF cardinality(v_unknown) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown_tag', 'unknown_tags', to_jsonb(v_unknown), 'message', 'Unknown business tag');
  END IF;

  SELECT COALESCE(array_agg(procurement_tag ORDER BY procurement_tag), ARRAY[]::text[]) INTO v_old
  FROM public.user_entities WHERE user_id = p_target_user_id;

  DELETE FROM public.user_entities WHERE user_id = p_target_user_id AND NOT (procurement_tag = ANY (v_new));
  INSERT INTO public.user_entities (user_id, procurement_tag)
  SELECT p_target_user_id, t FROM unnest(v_new) t
  ON CONFLICT (user_id, procurement_tag) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'old_tags', to_jsonb(v_old), 'tags', to_jsonb(v_new), 'unchanged', v_old = v_new);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_procurement_tags(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_procurement_tags(uuid, text[]) TO authenticated;
INSERT INTO public.procurement_exposure_allow (kind, name, note)
VALUES ('function', 'admin_set_procurement_tags', 'admin only: refuses unless is_profiles_admin() (a procurement user is never an admin); never the caller''s own row')
ON CONFLICT (kind, name) DO UPDATE SET note = EXCLUDED.note;

-- ---------------------------------------------------------------- management payload: entity_tags per approved user
-- Patched in place on the live definition (exactly one occurrence expected), so nothing else in the function changes.
DO $$
DECLARE
  v_def text;
  v_old text := '''email'', s.email_out';
  v_new text := '''email'', s.email_out,
        ''entity_tags'', COALESCE((SELECT jsonb_agg(ue.procurement_tag ORDER BY ue.procurement_tag) FROM public.user_entities ue WHERE ue.user_id = s.id), ''[]''::jsonb)';
BEGIN
  IF to_regprocedure('public.get_users_management_data()') IS NULL THEN
    RAISE EXCEPTION '090: get_users_management_data() not found';
  END IF;
  v_def := pg_get_functiondef('public.get_users_management_data()'::regprocedure);
  IF position('''entity_tags''' IN v_def) > 0 THEN RETURN; END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '090: get_users_management_data email line not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;
