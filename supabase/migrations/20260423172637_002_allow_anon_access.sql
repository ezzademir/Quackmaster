/*
  # Allow anon role access to all ERP tables

  The ERP app uses the anon key without authentication, so all existing
  policies scoped to `authenticated` were blocking all writes. This migration
  drops and recreates all policies to include the `anon` role so the app
  can read and write without requiring a login session.

  Tables updated:
    suppliers, raw_materials, recipes, recipe_ingredients,
    purchase_orders, purchase_order_items, production_runs,
    production_run_materials, outlets, hub_inventory,
    outlet_inventory, supply_orders
*/

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
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can view %s" ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can create %s" ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can update %s" ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated users can delete %s" ON %I', tbl, tbl);

    EXECUTE format('CREATE POLICY "Allow full access to anon and authenticated" ON %I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)', tbl);
  END LOOP;
END $$;
