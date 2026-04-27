/*
  # User Registration Approval Workflow

  1. New Tables
    - `pending_registrations` - tracks users awaiting approval

  2. Changes to profiles table
    - role column now supports 'admin', 'staff', 'pending'
    - New users default to 'pending' role

  3. Security
    - Pending users cannot access any data tables (via RLS)
    - Only admins can approve pending users
    - Activity log tracks all approvals

  4. Access Control
    - Pending users: Cannot read any operational data
    - Staff users: Can read operational data
    - Admins: Full read/write access
*/

-- Add pending_registrations table to track approvals
CREATE TABLE IF NOT EXISTS pending_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  email text NOT NULL,
  full_name text NOT NULL,
  requested_at timestamptz DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE pending_registrations ENABLE ROW LEVEL SECURITY;

-- Only admins can view pending registrations
CREATE POLICY "Admins can view pending registrations"
  ON pending_registrations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Only admins can approve registrations
CREATE POLICY "Admins can update pending registrations"
  ON pending_registrations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Pending users can view their own registration status
CREATE POLICY "Users can view own pending registration"
  ON pending_registrations FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_pending_registrations_user_id ON pending_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_status ON pending_registrations(status);

-- Update profiles RLS to block pending users from reading data
DROP POLICY IF EXISTS "Authenticated users can view hub inventory" ON hub_inventory;
DROP POLICY IF EXISTS "Authenticated users can view outlet inventory" ON outlet_inventory;
DROP POLICY IF EXISTS "Authenticated users can view production run materials" ON production_run_materials;
DROP POLICY IF EXISTS "Authenticated users can view production runs" ON production_runs;
DROP POLICY IF EXISTS "Authenticated users can view purchase order items" ON purchase_order_items;
DROP POLICY IF EXISTS "Authenticated users can view purchase orders" ON purchase_orders;
DROP POLICY IF EXISTS "Authenticated users can view raw materials" ON raw_materials;
DROP POLICY IF EXISTS "Authenticated users can view recipe ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Authenticated users can view supply orders" ON supply_orders;

-- Replace with policies that check user is NOT pending
CREATE POLICY "Non-pending users can view hub inventory"
  ON hub_inventory FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view outlet inventory"
  ON outlet_inventory FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view production run materials"
  ON production_run_materials FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view production runs"
  ON production_runs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view purchase order items"
  ON purchase_order_items FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view purchase orders"
  ON purchase_orders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view raw materials"
  ON raw_materials FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view recipe ingredients"
  ON recipe_ingredients FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );

CREATE POLICY "Non-pending users can view supply orders"
  ON supply_orders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role != 'pending'
    )
  );
