-- BREAK-GLASS (migration 090): the only active admin is lost or locked out. Run ONLY on Ezzad's explicit word.
-- PRIMARY path, with 090 STILL LIVE (last-admin guard on, fully ledgered, no rollback): promote a replacement, then demote the lost account,
-- in ONE transaction that aborts unless at least one active admin remains.
--
-- 1. Replace the two UUIDs below (profiles.id of the replacement and of the lost admin). The replacement must be an ACTIVE, approved user who is
--    NOT a procurement user (a promoted procurement user would keep stale business-tag rows). A typo in either id aborts the whole thing.
-- 2. Send the whole file as ONE batch (Supabase SQL editor "Run", or psql -v ON_ERROR_STOP=1 -f; the file has its own BEGIN/COMMIT).
--    Never paste it a line at a time, never plain psql -f without ON_ERROR_STOP.
-- 3. Afterwards: SELECT id, role, is_active FROM public.profiles WHERE role = 'admin';  and check data_ledger has role_changed (x2) and deactivated.
--    If anything raises, the transaction is aborted and NOTHING has changed (in an interactive session type ROLLBACK;).
--    The transaction-local claim below is the same state a service-key request has; it ends at COMMIT/ROLLBACK.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $$
DECLARE
  v_new  uuid := '00000000-0000-0000-0000-000000000000'::uuid;   -- REPLACEMENT admin: profiles.id
  v_lost uuid := '00000000-0000-0000-0000-000000000000'::uuid;   -- LOST / locked admin: profiles.id
  v_n integer;
BEGIN
  IF v_new = v_lost OR v_new = '00000000-0000-0000-0000-000000000000'::uuid OR v_lost = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'break-glass: set two different real profile ids (replacement, lost) before running';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_new AND is_active AND role IN ('staff', 'supervisor', 'admin')) THEN
    RAISE EXCEPTION 'break-glass: replacement % must exist, be active and be a staff / supervisor / admin user (not procurement, not pending)', v_new;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_lost AND role = 'admin') THEN
    RAISE EXCEPTION 'break-glass: lost account % must exist and currently be an admin', v_lost;
  END IF;

  UPDATE public.profiles SET role = 'admin' WHERE id = v_new AND role <> 'admin';
  UPDATE public.profiles SET role = 'staff', is_active = false, deactivated_at = now() WHERE id = v_lost;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'break-glass: expected to demote exactly one account, changed %', v_n; END IF;
  DELETE FROM auth.sessions WHERE user_id = v_lost;
  DELETE FROM auth.refresh_tokens WHERE user_id = v_lost::text;

  -- the post-condition: the replacement is an active admin, so at least one active admin remains. Otherwise abort EVERYTHING.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_new AND role = 'admin' AND is_active)
     OR (SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active) < 1 THEN
    RAISE EXCEPTION 'break-glass: no active admin would remain; nothing was changed';
  END IF;
END $$;

COMMIT;
