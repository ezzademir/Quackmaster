-- [HOLD] Sign-up: create pending registration server-side. NOT APPLIED — pending Clive/Ezzad review.
-- Root cause: email confirmation is on, so supabase.auth.signUp() returns no session and the
-- Register page's follow-up inserts run as `anon`. profiles / pending_registrations INSERT
-- policies are `authenticated` only → RLS rejects (401) and no pending_registrations row exists,
-- so the user never shows in Users > Pending (get_users_management_data reads that table).
-- Fix: the existing auth.users AFTER INSERT trigger (on_auth_user_created → handle_new_user)
-- now also creates the pending_registrations row. Idempotent; role is never taken from metadata.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name text := COALESCE(NULLIF(trim(both from NEW.raw_user_meta_data->>'full_name'), ''), '');
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (NEW.id, v_name, 'pending')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.pending_registrations (user_id, email, full_name, status, requested_at)
  VALUES (NEW.id, COALESCE(NEW.email, ''), v_name, 'pending', COALESCE(NEW.created_at, now()))
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- Backfill: users whose profile is still 'pending' but who have no pending_registrations row
-- at all (hidden from Users > Pending). Previously approved/rejected rows are left untouched.
INSERT INTO public.pending_registrations (user_id, email, full_name, status, requested_at)
SELECT u.id, COALESCE(u.email, ''), COALESCE(p.full_name, ''), 'pending', COALESCE(u.created_at, now())
FROM auth.users u
JOIN public.profiles p ON p.id = u.id
WHERE p.role = 'pending'
  AND NOT EXISTS (SELECT 1 FROM public.pending_registrations r WHERE r.user_id = u.id)
ON CONFLICT (user_id) DO NOTHING;
