/*
  # Allow authenticated users to INSERT own pending_registrations

  signUp() with email confirmation disabled returns a session immediately; the
  Supabase client then uses the `authenticated` JWT role, not `anon`. Existing
  policies only allowed INSERT for `anon`, so the registration insert failed RLS,
  leaving admins with an empty Pending list and no row for PendingApproval to poll.
*/

CREATE POLICY "Authenticated users can create own pending registration"
  ON public.pending_registrations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.uid() = user_id
    AND email IS NOT NULL
    AND full_name IS NOT NULL
    AND status = 'pending'
  );
