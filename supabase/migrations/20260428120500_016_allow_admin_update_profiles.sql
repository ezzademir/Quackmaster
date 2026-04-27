/*
  # Allow admins to update user profiles

  This fixes approval flow where admin approval updates pending_registrations,
  but fails to promote profiles.role due to missing UPDATE policy for admins.
*/

CREATE POLICY "Admins can update all profiles"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );
