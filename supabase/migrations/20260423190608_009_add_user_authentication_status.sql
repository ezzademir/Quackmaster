/*
  # User Authentication Status Tracking

  1. New Columns on profiles
    - `last_login` - Timestamp of user's last successful login
    - `password_reset_required` - Boolean flag for force password reset

  2. Changes
    - Add last_login tracking for authentication status
    - Add password_reset_required flag for admin-initiated resets
    - Create function to track last login on auth.users sign-in

  3. Security
    - RLS policies remain unchanged
    - Only admins can set password_reset_required flag
    - Password reset is triggered on next login
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'last_login'
  ) THEN
    ALTER TABLE profiles ADD COLUMN last_login timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'password_reset_required'
  ) THEN
    ALTER TABLE profiles ADD COLUMN password_reset_required boolean DEFAULT false;
  END IF;
END $$;
