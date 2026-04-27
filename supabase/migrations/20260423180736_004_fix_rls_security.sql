/*
  # Fix Critical RLS and Function Security Issues

  1. Problem Summary
    - All ERP tables use `WITH CHECK (true)` and `USING (true)` which bypass RLS
    - Activity logs INSERT policy allows unrestricted logging without ownership checks
    - `handle_new_user()` function has mutable search_path, causing security warnings

  2. Solution
    - Restrict all ERP table access to authenticated users only (no anonymous access)
    - Remove overly permissive policies that use `true` in all conditions
    - Implement role-based access control: admins full access, staff read-only
    - Activity logs: authenticated users can only insert (immutable), admins read only
    - Fix function security by setting search_path to 'public'

  3. Tables Fixed
    - All 12 ERP tables: suppliers, raw_materials, recipes, recipe_ingredients,
      purchase_orders, purchase_order_items, production_runs, production_run_materials,
      outlets, hub_inventory, outlet_inventory, supply_orders
    - activity_logs: proper ownership checking
    - handle_new_user(): security fixes

  4. Security Model
    - Admins (role='admin'): Full CRUD access to all ERP tables and audit logs
    - Staff (role='staff'): Read-only access to ERP tables, can insert activity logs
    - Anonymous: No access to protected tables
    - Activity logs: Append-only for authenticated users, read-only for admins

  5. Important Notes
    - This is a breaking change: staff users lose write access to ERP tables
    - Existing data remains untouched; only policies change
    - Activity logs remain immutable (no UPDATE or DELETE policies)
*/

-- Drop all overly permissive policies from ERP tables
DO $$
DECLARE
  tbl text;
  tbls text[] := ARRAY[
    'suppliers','raw_materials','recipes','recipe_ingredients',
    'purchase_orders','purchase_order_items','production_runs',
    'production_run_materials','outlets','hub_inventory',
    'outlet_inventory','supply_orders'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Allow full access to anon and authenticated" ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can view %s" ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can create %s" ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can update %s" ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can delete %s" ON %I', tbl, tbl);
  END LOOP;
END $$;

-- Recreate restrictive policies for all ERP tables
-- Admins: full CRUD; Staff: read-only
DO $$
DECLARE
  tbl text;
  tbls text[] := ARRAY[
    'suppliers','raw_materials','recipes','recipe_ingredients',
    'purchase_orders','purchase_order_items','production_runs',
    'production_run_materials','outlets','hub_inventory',
    'outlet_inventory','supply_orders'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    -- SELECT: authenticated users (admins + staff can view)
    EXECUTE format(
      'CREATE POLICY "Users can view %s" ON %I FOR SELECT TO authenticated USING (true)',
      tbl, tbl
    );
    
    -- INSERT: only admins
    EXECUTE format(
      'CREATE POLICY "Admins can create %s" ON %I FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = ''admin'')
      )',
      tbl, tbl
    );
    
    -- UPDATE: only admins
    EXECUTE format(
      'CREATE POLICY "Admins can update %s" ON %I FOR UPDATE TO authenticated 
       USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = ''admin''))
       WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = ''admin''))',
      tbl, tbl
    );
    
    -- DELETE: only admins
    EXECUTE format(
      'CREATE POLICY "Admins can delete %s" ON %I FOR DELETE TO authenticated 
       USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = ''admin''))',
      tbl, tbl
    );
  END LOOP;
END $$;

-- Fix activity_logs policies
DROP POLICY IF EXISTS "Authenticated users can insert activity logs" ON activity_logs;
DROP POLICY IF EXISTS "Admins can view all activity logs" ON activity_logs;

-- Authenticated users can insert their own logs (immutable audit trail)
CREATE POLICY "Authenticated users can insert activity logs"
  ON activity_logs FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Only admins can read activity logs
CREATE POLICY "Admins can view activity logs"
  ON activity_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Fix handle_new_user() function security_definer search_path
DROP FUNCTION IF EXISTS handle_new_user() CASCADE;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'staff')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
