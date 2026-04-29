/*
  # Allow admins to SELECT all profiles

  Migration 005 removed "Admins can view all profiles" to fix a circular dependency on first login.
  Migration 016 added admin UPDATE on profiles, but without SELECT the Users page cannot list
  approved staff — RLS only allowed reading one's own row.

  This policy mirrors 016: the EXISTS subquery reads only the current user's profile row (allowed by
  "Users can view own profile"), then permits SELECT on every profile row for admins.
*/

CREATE POLICY "Admins can view all profiles"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );
