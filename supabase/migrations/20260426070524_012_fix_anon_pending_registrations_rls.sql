/*
  # Fix Overly Permissive RLS Policy on pending_registrations

  ## Issue
  The `Anon users can create pending registration` policy allowed unrestricted INSERT access with `WITH CHECK (true)`.
  This bypasses row-level security for anonymous users.

  ## Solution
  Replace the overly permissive policy with one that:
  1. Validates the user_id matches an actual auth.users entry (user must exist)
  2. Ensures the status is always set to 'pending' for new registrations
  3. Prevents bypassing the registration workflow

  ## Security Changes
  - Drop: `Anon users can create pending registration` (WITH CHECK true)
  - Add: `Anon users can create their pending registration` (validates user_id and status)
*/

DROP POLICY IF EXISTS "Anon users can create pending registration" ON public.pending_registrations;

CREATE POLICY "Anon users can create their pending registration"
  ON public.pending_registrations
  FOR INSERT
  TO anon
  WITH CHECK (
    user_id IS NOT NULL
    AND status = 'pending'
    AND (
      SELECT id FROM auth.users WHERE id = pending_registrations.user_id
    ) IS NOT NULL
  );
