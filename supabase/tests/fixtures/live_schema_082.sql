-- Live column dump of fknrfntqycfrkaihwngg (read-only, 24 Oct 2026 ~1:30am MYT, after 081).
-- Types, NOT NULL and defaults exactly as pg_attribute/format_type report them. FKs, checks, RLS omitted.
-- Regenerate with the pg_attribute query in supabase/tests/fixtures/README_live_schema_082.md.

CREATE TABLE public.hub_inventory (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "raw_material_id" uuid,
  "product_batch" text,
  "quantity_on_hand" numeric(10,2) DEFAULT 0 NOT NULL,
  "reserved_quantity" numeric(10,2) DEFAULT 0,
  "available_quantity" numeric(10,2),
  "last_updated" timestamp with time zone DEFAULT now(),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "lot_id" uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.hub_inventory_reservations (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "hub_inventory_id" uuid NOT NULL,
  "reference_type" text NOT NULL,
  "reference_id" uuid NOT NULL,
  "quantity" numeric(12,2) NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (hub_inventory_id, reference_type, reference_id)
);
CREATE TABLE public.inventory_adjustments (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "hub_inventory_id" uuid NOT NULL,
  "adjustment_type" text NOT NULL,
  "adjusted_quantity" numeric(10,2) NOT NULL,
  "adjustment_reason" text NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "notes" text,
  "created_by" uuid NOT NULL,
  "reviewed_by" uuid,
  "reviewed_at" timestamp with time zone,
  "review_notes" text,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.inventory_lots (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "product_batch_label" text NOT NULL,
  "expiry_date" date,
  "manufactured_at" timestamp with time zone,
  "parent_lot_id" uuid,
  "purchase_order_item_id" uuid,
  "production_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE public.outlet_inventory (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "outlet_id" uuid NOT NULL,
  "product_batch" text,
  "quantity_on_hand" numeric(10,2) DEFAULT 0 NOT NULL,
  "reserved_quantity" numeric(10,2) DEFAULT 0,
  "available_quantity" numeric(10,2),
  "last_updated" timestamp with time zone DEFAULT now(),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "lot_id" uuid,
  "raw_material_id" uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.outlet_stock_take_lines (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "outlet_inventory_id" uuid NOT NULL,
  "system_qoh_before" numeric(14,4) NOT NULL,
  "counted_qty" numeric(14,4) NOT NULL,
  "variance" numeric(14,4) NOT NULL,
  "line_remark" text,
  "lot_id" uuid,
  "system_qoh_at_open" numeric,
  "qty_moved_during_count" numeric,
  PRIMARY KEY (id)
);
CREATE TABLE public.outlet_stock_take_sessions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "outlet_id" uuid NOT NULL,
  "count_date" date DEFAULT (timezone('Asia/Kuala_Lumpur'::text, now()))::date NOT NULL,
  "notes" text,
  "idempotency_key" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text,
  "opened_at" timestamp with time zone,
  "opened_by" uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.outlets (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "location_code" text NOT NULL,
  "address" text,
  "city" text,
  "country" text,
  "manager_name" text,
  "manager_phone" text,
  "manager_email" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.production_run_materials (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "production_run_id" uuid NOT NULL,
  "raw_material_id" uuid NOT NULL,
  "quantity_consumed" numeric(10,2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.production_runs (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "run_number" text NOT NULL,
  "recipe_id" uuid NOT NULL,
  "production_date" date DEFAULT CURRENT_DATE NOT NULL,
  "planned_output" numeric(10,2) NOT NULL,
  "actual_output" numeric(10,2) NOT NULL,
  "yield_percentage" numeric(5,2),
  "status" text DEFAULT 'in_progress'::text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "planned_batch_id" uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.purchase_order_items (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "purchase_order_id" uuid NOT NULL,
  "raw_material_id" uuid NOT NULL,
  "quantity_ordered" numeric(14,4) NOT NULL,
  "quantity_received" numeric(14,4) DEFAULT 0,
  "unit_price" numeric(12,4) NOT NULL,
  "line_total" numeric(15,2),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "purchase_uom" text,
  "quantity_ordered_base" numeric(14,4) NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE public.purchase_orders (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "order_number" text NOT NULL,
  "supplier_id" uuid NOT NULL,
  "status" text DEFAULT 'draft'::text NOT NULL,
  "order_date" date DEFAULT CURRENT_DATE NOT NULL,
  "expected_delivery_date" date,
  "actual_delivery_date" date,
  "total_amount" numeric(15,2),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.raw_materials (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "unit_of_measure" text NOT NULL,
  "cost_price" numeric(12,2),
  "reorder_level" numeric(10,2) DEFAULT 10,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "weighted_avg_unit_cost" numeric(14,4) DEFAULT 0 NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE public.recipe_ingredients (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "recipe_id" uuid NOT NULL,
  "raw_material_id" uuid NOT NULL,
  "quantity_required" numeric(10,2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.recipes (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "target_yield_percentage" numeric(5,2) DEFAULT 100,
  "standard_batch_size" numeric(10,2) NOT NULL,
  "batch_unit" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "default_product_batch" text,
  "shelf_life_days" integer,
  PRIMARY KEY (id)
);
CREATE TABLE public.sales_journal_lines (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "sales_journal_id" uuid NOT NULL,
  "product_batch" text NOT NULL,
  "lot_id" uuid,
  "quantity_sold" numeric(12,4) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "outlet_inventory_id" uuid,
  "expired_at_sale" boolean,
  PRIMARY KEY (id)
);
CREATE TABLE public.sales_journals (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "outlet_id" uuid NOT NULL,
  "business_date" date NOT NULL,
  "status" text DEFAULT 'posted'::text NOT NULL,
  "notes" text,
  "idempotency_key" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source" text DEFAULT 'manual'::text NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE public.suppliers (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "contact_person" text,
  "email" text,
  "phone" text,
  "address" text,
  "city" text,
  "country" text,
  "payment_terms" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.supply_order_lines (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "supply_order_id" uuid NOT NULL,
  "hub_inventory_id" uuid NOT NULL,
  "product_batch" text,
  "quantity" numeric(10,2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "lot_id" uuid,
  "expired_at_dispatch" boolean,
  PRIMARY KEY (id)
);
CREATE TABLE public.supply_orders (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "supply_order_number" text NOT NULL,
  "outlet_id" uuid NOT NULL,
  "dispatch_date" date DEFAULT CURRENT_DATE NOT NULL,
  "received_date" date,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "total_quantity" numeric(10,2) NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "supply_date" date DEFAULT (timezone('Asia/Kuala_Lumpur'::text, now()))::date NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE public.waste_events (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "location_kind" text NOT NULL,
  "outlet_id" uuid,
  "waste_date" date DEFAULT CURRENT_DATE NOT NULL,
  "status" text DEFAULT 'posted'::text NOT NULL,
  "notes" text,
  "idempotency_key" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE public.waste_lines (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "waste_event_id" uuid NOT NULL,
  "hub_inventory_id" uuid,
  "outlet_id" uuid,
  "product_batch" text NOT NULL,
  "quantity" numeric(12,4) NOT NULL,
  "waste_reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "outlet_inventory_id" uuid,
  "lot_id" uuid,
  PRIMARY KEY (id)
);

CREATE VIEW public.recipe_variance_by_run AS
 SELECT pr.id AS production_run_id,
    pr.recipe_id,
    r.name AS recipe_name,
    pri.raw_material_id,
    rm.name AS raw_material_name,
    COALESCE(pri.quantity_required * (pr.actual_output / NULLIF(r.standard_batch_size, 0::numeric)), 0::numeric) AS theoretical_qty,
    COALESCE(prm.quantity_consumed, 0::numeric) AS actual_qty,
    COALESCE(prm.quantity_consumed, 0::numeric) - COALESCE(pri.quantity_required * (pr.actual_output / NULLIF(r.standard_batch_size, 0::numeric)), 0::numeric) AS variance_qty
   FROM production_runs pr
     JOIN recipes r ON r.id = pr.recipe_id
     JOIN recipe_ingredients pri ON pri.recipe_id = pr.recipe_id
     JOIN raw_materials rm ON rm.id = pri.raw_material_id
     LEFT JOIN production_run_materials prm ON prm.production_run_id = pr.id AND prm.raw_material_id = pri.raw_material_id
  WHERE pr.status <> 'cancelled'::text;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipe_variance_by_run TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.recipe_variance_by_run TO service_role;
