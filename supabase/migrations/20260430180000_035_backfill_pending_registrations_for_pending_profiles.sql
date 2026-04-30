/*
  # Backfill pending_registrations for pending profiles

  Replays the same intent as 013 for users who registered after that migration
  but before authenticated INSERT was allowed (migration 034): pending profile in
  `profiles`, no row in `pending_registrations`. Email comes from `auth.users`.
*/

INSERT INTO public.pending_registrations (user_id, email, full_name, status, requested_at)
SELECT
  p.id,
  u.email,
  p.full_name,
  'pending',
  p.created_at
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.role = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM public.pending_registrations pr
    WHERE pr.user_id = p.id
  )
ON CONFLICT (user_id) DO NOTHING;
