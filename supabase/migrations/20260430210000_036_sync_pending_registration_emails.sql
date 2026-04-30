/*
  # Sync pending_registrations.email from auth.users

  Canonical signup email lives on auth.users. Rows may have blank or stale email;
  admin Pending tab reads pending_registrations.email — align from Auth.
*/

UPDATE public.pending_registrations pr
SET email = trim(u.email::text)
FROM auth.users u
WHERE u.id = pr.user_id
  AND NULLIF(trim(u.email::text), '') IS NOT NULL
  AND (
    NULLIF(trim(pr.email), '') IS NULL
    OR trim(pr.email) IS DISTINCT FROM trim(u.email::text)
  );

INSERT INTO public.pending_registrations (user_id, email, full_name, status, requested_at)
SELECT
  p.id,
  trim(u.email::text),
  p.full_name,
  'pending',
  p.created_at
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.role = 'pending'
  AND NULLIF(trim(u.email::text), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.pending_registrations pr
    WHERE pr.user_id = p.id
  )
ON CONFLICT (user_id) DO NOTHING;
