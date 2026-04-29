/*
  # Align pending_registrations admin policies with is_profiles_admin()

  Migration 008 used EXISTS (SELECT … FROM profiles …) for admin checks on pending_registrations.
  After profiles RLS changes, using the same helper as profiles (018) keeps behavior consistent
  and avoids brittle policy combinations.

  Requires: public.is_profiles_admin() from migration 018.
*/

DROP POLICY IF EXISTS "Admins can view pending registrations" ON public.pending_registrations;
DROP POLICY IF EXISTS "Admins can update pending registrations" ON public.pending_registrations;

CREATE POLICY "Admins can view pending registrations"
  ON public.pending_registrations FOR SELECT
  TO authenticated
  USING (public.is_profiles_admin());

CREATE POLICY "Admins can update pending registrations"
  ON public.pending_registrations FOR UPDATE
  TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());
