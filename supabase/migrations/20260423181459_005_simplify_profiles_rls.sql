/*
  # Simplify profiles RLS to fix circular dependency

  The "Admins can view all profiles" policy has a circular dependency:
  to read your profile and see if you're admin, you need to already be admin.
  This breaks the initial login flow.

  Solution: Remove the admin-can-view-all policy. Users can view their own
  profile; that's sufficient. Activity logs already protect admin data.
*/

DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
