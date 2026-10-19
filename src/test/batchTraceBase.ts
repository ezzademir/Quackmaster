/** Shared pglite fixture for the 078-080 migration tests. */

/** Minimal tables + stubs matching production columns used by the batch RPCs. */
export const BATCH_TRACE_BASE = `
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-0000000000aa'::uuid $$;
CREATE TABLE outlets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE production_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_number text, production_date date, created_at timestamptz DEFAULT now());
CREATE TABLE inventory_lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_batch_label text, expiry_date date,
  manufactured_at timestamptz, production_run_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE hub_inventory (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), raw_material_id uuid, product_batch text, lot_id uuid,
  quantity_on_hand numeric DEFAULT 0, reserved_quantity numeric DEFAULT 0, available_quantity numeric,
  last_updated timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE hub_inventory_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hub_inventory_id uuid NOT NULL, reference_type text NOT NULL,
  reference_id uuid NOT NULL, quantity numeric NOT NULL, reason text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (hub_inventory_id, reference_type, reference_id));
CREATE TABLE supply_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supply_order_number text, outlet_id uuid, dispatch_date date DEFAULT CURRENT_DATE,
  received_date date, status text DEFAULT 'pending', total_quantity numeric, notes text, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), supply_date date DEFAULT CURRENT_DATE);
CREATE TABLE supply_order_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supply_order_id uuid, hub_inventory_id uuid,
  product_batch text, quantity numeric, created_at timestamptz DEFAULT now());
CREATE TABLE outlet_inventory (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid, product_batch text, quantity_on_hand numeric DEFAULT 0,
  reserved_quantity numeric DEFAULT 0, available_quantity numeric, last_updated timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), lot_id uuid, raw_material_id uuid);
CREATE TABLE sales_journals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid NOT NULL, business_date date NOT NULL, status text DEFAULT 'posted',
  notes text, idempotency_key uuid, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), source text DEFAULT 'manual');
CREATE TABLE sales_journal_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_journal_id uuid NOT NULL, product_batch text NOT NULL, lot_id uuid,
  quantity_sold numeric NOT NULL, created_at timestamptz DEFAULT now(), outlet_inventory_id uuid);
CREATE TABLE waste_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_kind text NOT NULL, outlet_id uuid, waste_date date, status text DEFAULT 'posted',
  notes text, idempotency_key uuid, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE waste_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), waste_event_id uuid NOT NULL, hub_inventory_id uuid, outlet_id uuid,
  product_batch text NOT NULL, quantity numeric NOT NULL, waste_reason text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE outlet_stock_take_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outlet_id uuid NOT NULL, count_date date NOT NULL DEFAULT CURRENT_DATE, notes text,
  idempotency_key uuid, created_by uuid, created_at timestamptz DEFAULT now(), posted_at timestamptz DEFAULT now());
CREATE TABLE outlet_stock_take_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, outlet_inventory_id uuid NOT NULL,
  system_qoh_before numeric NOT NULL, counted_qty numeric NOT NULL, variance numeric NOT NULL, line_remark text);
CREATE TABLE ledger_calls (action text, entity_type text, after_data jsonb, metadata jsonb);
CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.is_supervisor_for_outlet(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.profile_can_post_outlet_stock_take(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.fg_recipe_sku(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'KT'::text $$;
CREATE TABLE movement_ctx (outlet_id uuid, movement_type text, business_date date, reference_type text, reference_id uuid, metadata jsonb);
CREATE FUNCTION public._set_outlet_movement_ctx(uuid, text, date, text, uuid, jsonb DEFAULT NULL) RETURNS void LANGUAGE sql
  AS $$ INSERT INTO movement_ctx VALUES ($1, $2, $3, $4, $5, $6) $$;
CREATE FUNCTION public._clear_outlet_movement_ctx() RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public._post_stock_take_snapshot_hook(uuid, date) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public._append_data_ledger(p_action text, p_entity_type text, p_entity_id text, p_module text, p_operation text,
  p_reference_id text, p_before jsonb, p_after jsonb, p_delta jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
  RETURNS void LANGUAGE sql AS $$ INSERT INTO ledger_calls VALUES (p_action, p_entity_type, p_after, p_metadata) $$;
`;
