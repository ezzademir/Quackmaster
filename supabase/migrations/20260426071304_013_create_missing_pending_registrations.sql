/*
  # Create Missing Pending Registration Records

  ## Issue
  Users who registered created profiles with 'pending' role but no corresponding
  entries in pending_registrations table. This prevents admins from seeing them
  in the "Pending Approvals" tab.

  ## Solution
  Backfill pending_registrations table with entries for all pending users that
  don't have a registration record yet.
*/

INSERT INTO public.pending_registrations (user_id, email, full_name, status, requested_at)
SELECT 
  p.id,
  u.email,
  p.full_name,
  'pending',
  p.created_at
FROM profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.role = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM pending_registrations pr
    WHERE pr.user_id = p.id
  )
ON CONFLICT DO NOTHING;
