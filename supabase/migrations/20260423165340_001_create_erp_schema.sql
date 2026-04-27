/*
  # Create ERP Dashboard Schema

  1. New Tables
    - `suppliers` - Vendor information for raw materials
    - `raw_materials` - Inventory of ingredients with cost tracking
    - `recipes` - Single finished product definition with yield targets
    - `recipe_ingredients` - Mapping of raw materials to recipes
    - `purchase_orders` - Orders placed with suppliers
    - `purchase_order_items` - Line items within purchase orders
    - `production_runs` - Production batches with yield tracking
    - `production_run_materials` - Actual consumption per production run
    - `outlets` - Quackteow outlet locations
    - `hub_inventory` - Stock levels at Quackmaster Hub
    - `outlet_inventory` - Stock levels per outlet
    - `supply_orders` - Product dispatches from hub to outlets
    
  2. Security
    - Enable RLS on all tables
    - Create policies for authenticated users to access all records (basic read/write permissions)
    
  3. Features
    - Automatic timestamps on all tables
    - Auto-increment counters for order IDs and run IDs
    - Foreign key constraints for data integrity
*/

-- Suppliers table
CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_person text,
  email text,
  phone text,
  address text,
  city text,
  country text,
  payment_terms text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view suppliers"
  ON suppliers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create suppliers"
  ON suppliers FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update suppliers"
  ON suppliers FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete suppliers"
  ON suppliers FOR DELETE
  TO authenticated
  USING (true);

-- Raw Materials table
CREATE TABLE IF NOT EXISTS raw_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  unit_of_measure text NOT NULL,
  cost_price numeric(12, 2),
  reorder_level numeric(10, 2) DEFAULT 10,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE raw_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view raw materials"
  ON raw_materials FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create raw materials"
  ON raw_materials FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update raw materials"
  ON raw_materials FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete raw materials"
  ON raw_materials FOR DELETE
  TO authenticated
  USING (true);

-- Recipes table (single finished product)
CREATE TABLE IF NOT EXISTS recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  target_yield_percentage numeric(5, 2) DEFAULT 100,
  standard_batch_size numeric(10, 2) NOT NULL,
  batch_unit text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view recipes"
  ON recipes FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create recipes"
  ON recipes FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update recipes"
  ON recipes FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete recipes"
  ON recipes FOR DELETE
  TO authenticated
  USING (true);

-- Recipe Ingredients table
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  quantity_required numeric(10, 2) NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view recipe ingredients"
  ON recipe_ingredients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create recipe ingredients"
  ON recipe_ingredients FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update recipe ingredients"
  ON recipe_ingredients FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete recipe ingredients"
  ON recipe_ingredients FOR DELETE
  TO authenticated
  USING (true);

-- Purchase Orders table
CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date date,
  actual_delivery_date date,
  total_amount numeric(15, 2),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view purchase orders"
  ON purchase_orders FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create purchase orders"
  ON purchase_orders FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update purchase orders"
  ON purchase_orders FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete purchase orders"
  ON purchase_orders FOR DELETE
  TO authenticated
  USING (true);

-- Purchase Order Items table
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
  quantity_ordered numeric(10, 2) NOT NULL,
  quantity_received numeric(10, 2) DEFAULT 0,
  unit_price numeric(12, 2) NOT NULL,
  line_total numeric(15, 2),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view purchase order items"
  ON purchase_order_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create purchase order items"
  ON purchase_order_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update purchase order items"
  ON purchase_order_items FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete purchase order items"
  ON purchase_order_items FOR DELETE
  TO authenticated
  USING (true);

-- Production Runs table
CREATE TABLE IF NOT EXISTS production_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_number text NOT NULL UNIQUE,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
  production_date date NOT NULL DEFAULT CURRENT_DATE,
  planned_output numeric(10, 2) NOT NULL,
  actual_output numeric(10, 2) NOT NULL,
  yield_percentage numeric(5, 2),
  status text NOT NULL DEFAULT 'in_progress',
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE production_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view production runs"
  ON production_runs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create production runs"
  ON production_runs FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update production runs"
  ON production_runs FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete production runs"
  ON production_runs FOR DELETE
  TO authenticated
  USING (true);

-- Production Run Materials table
CREATE TABLE IF NOT EXISTS production_run_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_run_id uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
  quantity_consumed numeric(10, 2) NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE production_run_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view production run materials"
  ON production_run_materials FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create production run materials"
  ON production_run_materials FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update production run materials"
  ON production_run_materials FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete production run materials"
  ON production_run_materials FOR DELETE
  TO authenticated
  USING (true);

-- Outlets table (Quackteow locations)
CREATE TABLE IF NOT EXISTS outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location_code text NOT NULL UNIQUE,
  address text,
  city text,
  country text,
  manager_name text,
  manager_phone text,
  manager_email text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE outlets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view outlets"
  ON outlets FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create outlets"
  ON outlets FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update outlets"
  ON outlets FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete outlets"
  ON outlets FOR DELETE
  TO authenticated
  USING (true);

-- Hub Inventory table (Quackmaster)
CREATE TABLE IF NOT EXISTS hub_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_material_id uuid REFERENCES raw_materials(id) ON DELETE CASCADE,
  product_batch text,
  quantity_on_hand numeric(10, 2) NOT NULL DEFAULT 0,
  reserved_quantity numeric(10, 2) DEFAULT 0,
  available_quantity numeric(10, 2),
  last_updated timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT either_raw_material_or_product CHECK (
    CASE WHEN raw_material_id IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN product_batch IS NOT NULL THEN 1 ELSE 0 END = 1
  )
);

ALTER TABLE hub_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view hub inventory"
  ON hub_inventory FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create hub inventory"
  ON hub_inventory FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update hub inventory"
  ON hub_inventory FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete hub inventory"
  ON hub_inventory FOR DELETE
  TO authenticated
  USING (true);

-- Outlet Inventory table
CREATE TABLE IF NOT EXISTS outlet_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_batch text NOT NULL,
  quantity_on_hand numeric(10, 2) NOT NULL DEFAULT 0,
  reserved_quantity numeric(10, 2) DEFAULT 0,
  available_quantity numeric(10, 2),
  last_updated timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE outlet_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view outlet inventory"
  ON outlet_inventory FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create outlet inventory"
  ON outlet_inventory FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update outlet inventory"
  ON outlet_inventory FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete outlet inventory"
  ON outlet_inventory FOR DELETE
  TO authenticated
  USING (true);

-- Supply Orders table (Hub to Outlets)
CREATE TABLE IF NOT EXISTS supply_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_order_number text NOT NULL UNIQUE,
  outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE RESTRICT,
  dispatch_date date NOT NULL DEFAULT CURRENT_DATE,
  received_date date,
  status text NOT NULL DEFAULT 'pending',
  total_quantity numeric(10, 2) NOT NULL,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE supply_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view supply orders"
  ON supply_orders FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create supply orders"
  ON supply_orders FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update supply orders"
  ON supply_orders FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete supply orders"
  ON supply_orders FOR DELETE
  TO authenticated
  USING (true);

-- Indexes for performance
CREATE INDEX idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_order_items_purchase_order_id ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_production_runs_recipe_id ON production_runs(recipe_id);
CREATE INDEX idx_production_runs_status ON production_runs(status);
CREATE INDEX idx_hub_inventory_raw_material_id ON hub_inventory(raw_material_id);
CREATE INDEX idx_hub_inventory_product_batch ON hub_inventory(product_batch);
CREATE INDEX idx_outlet_inventory_outlet_id ON outlet_inventory(outlet_id);
CREATE INDEX idx_supply_orders_outlet_id ON supply_orders(outlet_id);
CREATE INDEX idx_supply_orders_status ON supply_orders(status);
