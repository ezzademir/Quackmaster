/*
  # Fix RLS Security Vulnerabilities

  1. Problem
    - Multiple tables had "Authenticated users can" RLS policies with USING (true) and WITH CHECK (true)
    - This effectively disabled RLS for authenticated users
    - Any authenticated user could read, insert, update, or delete any row without restrictions

  2. Solution
    - Remove all "Authenticated users can" policies with true conditions
    - Keep only "Admins can" policies (these should properly check admin role)
    - For SELECT: Allow authenticated users to read (org-wide data sharing)
    - For INSERT/UPDATE/DELETE: Restrict to admins only via existing admin policies

  3. Tables Fixed
    - hub_inventory
    - outlet_inventory
    - production_run_materials
    - production_runs
    - purchase_order_items
    - purchase_orders
    - raw_materials
    - recipe_ingredients
    - supply_orders

  4. Security Model
    - All staff can READ operational/inventory data (shared org data)
    - Only ADMINS can WRITE (insert/update/delete) - enforced by admin policies
    - Anonymous users cannot access anything (RLS still enabled)
*/

-- hub_inventory
DROP POLICY IF EXISTS "Authenticated users can create hub inventory" ON hub_inventory;
DROP POLICY IF EXISTS "Authenticated users can delete hub inventory" ON hub_inventory;
DROP POLICY IF EXISTS "Authenticated users can update hub inventory" ON hub_inventory;

-- outlet_inventory
DROP POLICY IF EXISTS "Authenticated users can create outlet inventory" ON outlet_inventory;
DROP POLICY IF EXISTS "Authenticated users can delete outlet inventory" ON outlet_inventory;
DROP POLICY IF EXISTS "Authenticated users can update outlet inventory" ON outlet_inventory;

-- production_run_materials
DROP POLICY IF EXISTS "Authenticated users can create production run materials" ON production_run_materials;
DROP POLICY IF EXISTS "Authenticated users can delete production run materials" ON production_run_materials;
DROP POLICY IF EXISTS "Authenticated users can update production run materials" ON production_run_materials;

-- production_runs
DROP POLICY IF EXISTS "Authenticated users can create production runs" ON production_runs;
DROP POLICY IF EXISTS "Authenticated users can delete production runs" ON production_runs;
DROP POLICY IF EXISTS "Authenticated users can update production runs" ON production_runs;

-- purchase_order_items
DROP POLICY IF EXISTS "Authenticated users can create purchase order items" ON purchase_order_items;
DROP POLICY IF EXISTS "Authenticated users can delete purchase order items" ON purchase_order_items;
DROP POLICY IF EXISTS "Authenticated users can update purchase order items" ON purchase_order_items;

-- purchase_orders
DROP POLICY IF EXISTS "Authenticated users can create purchase orders" ON purchase_orders;
DROP POLICY IF EXISTS "Authenticated users can delete purchase orders" ON purchase_orders;
DROP POLICY IF EXISTS "Authenticated users can update purchase orders" ON purchase_orders;

-- raw_materials
DROP POLICY IF EXISTS "Authenticated users can create raw materials" ON raw_materials;
DROP POLICY IF EXISTS "Authenticated users can delete raw materials" ON raw_materials;
DROP POLICY IF EXISTS "Authenticated users can update raw materials" ON raw_materials;

-- recipe_ingredients
DROP POLICY IF EXISTS "Authenticated users can create recipe ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Authenticated users can delete recipe ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Authenticated users can update recipe ingredients" ON recipe_ingredients;

-- supply_orders
DROP POLICY IF EXISTS "Authenticated users can create supply orders" ON supply_orders;
DROP POLICY IF EXISTS "Authenticated users can delete supply orders" ON supply_orders;
DROP POLICY IF EXISTS "Authenticated users can update supply orders" ON supply_orders;
