/*
  # Fix Pending Registrations RLS for Insert During Registration

  ## Issue
  The current RLS policy for anonymous users requires the user to exist in auth.users
  with a specific user_id. However, during the registration flow, we're inserting as
  an anonymous user (before authentication), so we need a more flexible approach.

  ## Solution
  Replace the overly restrictive policy with one that allows any anonymous user to
  create a pending registration record as long as basic validations are met.
*/

DROP POLICY IF EXISTS "Anon users can create their pending registration" ON public.pending_registrations;

CREATE POLICY "Anon users can create pending registrations"
  ON public.pending_registrations
  FOR INSERT
  TO anon
  WITH CHECK (
    user_id IS NOT NULL
    AND email IS NOT NULL
    AND full_name IS NOT NULL
    AND status = 'pending'
  );
