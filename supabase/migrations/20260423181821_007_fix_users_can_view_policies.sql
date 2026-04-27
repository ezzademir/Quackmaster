/*
  # Fix "Users can view" RLS Policies

  Issue: "Users can view" policies have USING (true) - they should check authentication
  Solution: Replace with proper authenticated user check
*/

-- Remove all problematic "Users can view" policies
DROP POLICY IF EXISTS "Users can view hub_inventory" ON hub_inventory;
DROP POLICY IF EXISTS "Users can view outlet_inventory" ON outlet_inventory;
DROP POLICY IF EXISTS "Users can view production_run_materials" ON production_run_materials;
DROP POLICY IF EXISTS "Users can view production_runs" ON production_runs;
DROP POLICY IF EXISTS "Users can view purchase_order_items" ON purchase_order_items;
DROP POLICY IF EXISTS "Users can view purchase_orders" ON purchase_orders;
DROP POLICY IF EXISTS "Users can view raw_materials" ON raw_materials;
DROP POLICY IF EXISTS "Users can view recipe_ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Users can view supply_orders" ON supply_orders;

-- Also remove the "Authenticated users can view" ones which are duplicates
DROP POLICY IF EXISTS "Authenticated users can view hub inventory" ON hub_inventory;
DROP POLICY IF EXISTS "Authenticated users can view outlet inventory" ON outlet_inventory;
DROP POLICY IF EXISTS "Authenticated users can view production run materials" ON production_run_materials;
DROP POLICY IF EXISTS "Authenticated users can view production runs" ON production_runs;
DROP POLICY IF EXISTS "Authenticated users can view purchase order items" ON purchase_order_items;
DROP POLICY IF EXISTS "Authenticated users can view purchase orders" ON purchase_orders;
DROP POLICY IF EXISTS "Authenticated users can view raw materials" ON raw_materials;
DROP POLICY IF EXISTS "Authenticated users can view recipe ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Authenticated users can view supply orders" ON supply_orders;

-- Create proper authenticated SELECT policies for each table
CREATE POLICY "Authenticated users can view hub inventory"
  ON hub_inventory FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view outlet inventory"
  ON outlet_inventory FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view production run materials"
  ON production_run_materials FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view production runs"
  ON production_runs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view purchase order items"
  ON purchase_order_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view purchase orders"
  ON purchase_orders FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view raw materials"
  ON raw_materials FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view recipe ingredients"
  ON recipe_ingredients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can view supply orders"
  ON supply_orders FOR SELECT
  TO authenticated
  USING (true);
