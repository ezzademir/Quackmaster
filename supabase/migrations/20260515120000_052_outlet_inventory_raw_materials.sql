/*
  Outlet inventory: raw materials at outlet (mirror hub_inventory pattern).
  Supply order lines: allow NULL product_batch for RM hub lines.
  receive_supply_order: credit outlet by raw_material_id when hub row is RM.
*/

-- supply_order_lines — nullable product_batch for raw-material hub lines
ALTER TABLE public.supply_order_lines
  ALTER COLUMN product_batch DROP NOT NULL;

COMMENT ON COLUMN public.supply_order_lines.product_batch IS 'Hub finished-goods batch code; NULL when line references a raw_material hub row.';

-- outlet_inventory — optional raw material; product_batch nullable when RM row
ALTER TABLE public.outlet_inventory
  ADD COLUMN IF NOT EXISTS raw_material_id uuid REFERENCES public.raw_materials(id) ON DELETE RESTRICT;

ALTER TABLE public.outlet_inventory
  ALTER COLUMN product_batch DROP NOT NULL;

COMMENT ON COLUMN public.outlet_inventory.raw_material_id IS 'When set, row is ingredient stock at outlet; product_batch must be NULL.';
COMMENT ON COLUMN public.outlet_inventory.product_batch IS 'Finished-goods batch code; NULL when raw_material_id is set.';

ALTER TABLE public.outlet_inventory
  DROP CONSTRAINT IF EXISTS either_raw_material_or_product_outlet;

ALTER TABLE public.outlet_inventory
  ADD CONSTRAINT either_raw_material_or_product_outlet CHECK (
    (
      raw_material_id IS NOT NULL
      AND (
        product_batch IS NULL
        OR trim(both from product_batch) = ''
      )
    )
    OR (
      raw_material_id IS NULL
      AND product_batch IS NOT NULL
      AND trim(both from product_batch) <> ''
    )
  );

DROP INDEX IF EXISTS idx_outlet_inventory_outlet_rm_unique;

CREATE UNIQUE INDEX idx_outlet_inventory_outlet_rm_unique
  ON public.outlet_inventory (outlet_id, raw_material_id)
  WHERE raw_material_id IS NOT NULL;

-- receive_supply_order — support hub raw_material rows
CREATE OR REPLACE FUNCTION public.receive_supply_order(
  p_supply_order_id uuid,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_so RECORD;
  line RECORD;
  v_hid uuid;
  v_rm uuid;
  v_pb text;
  v_hlot uuid;
  v_dest uuid;
  v_qoh numeric;
  v_res numeric;
  v_new_qoh numeric;
  v_iso timestamptz := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_authenticated_active_staff() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated_or_inactive');
  END IF;

  SELECT *
  INTO v_so
  FROM public.supply_orders so
  WHERE so.id = p_supply_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'supply_order_not_found');
  END IF;

  IF v_so.status IS DISTINCT FROM 'dispatched' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status_for_receive', 'status', v_so.status);
  END IF;

  FOR line IN
    SELECT sol.id, sol.quantity, sol.hub_inventory_id
    FROM public.supply_order_lines sol
    WHERE sol.supply_order_id = p_supply_order_id
    ORDER BY sol.id
  LOOP
    SELECT hi.id, hi.raw_material_id, hi.product_batch, hi.lot_id
    INTO v_hid, v_rm, v_pb, v_hlot
    FROM public.hub_inventory hi
    WHERE hi.id = line.hub_inventory_id;

    IF v_hid IS NULL THEN
      RETURN jsonb_build_object(
        'success',
        false,
        'error',
        'hub_inventory_missing',
        'hub_inventory_id',
        line.hub_inventory_id
      );
    END IF;

    v_dest := NULL;
    v_qoh := NULL;
    v_res := NULL;

    IF v_rm IS NOT NULL THEN
      -- Raw material at outlet: single row per (outlet, raw_material_id)
      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id
        AND oi.raw_material_id = v_rm
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET
          quantity_on_hand = v_new_qoh,
          available_quantity = v_new_qoh - v_res,
          last_updated = v_iso,
          updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id,
          raw_material_id,
          product_batch,
          lot_id,
          quantity_on_hand,
          reserved_quantity,
          available_quantity,
          last_updated,
          updated_at
        )
        VALUES (
          v_so.outlet_id,
          v_rm,
          NULL,
          NULL,
          line.quantity,
          0,
          line.quantity,
          v_iso,
          v_iso
        );
      END IF;
    ELSE
      v_pb := trim(both from COALESCE(v_pb::text, ''));

      IF v_pb = '' THEN
        RETURN jsonb_build_object(
          'success',
          false,
          'error',
          'hub_inventory_invalid_fg',
          'hub_inventory_id',
          line.hub_inventory_id,
          'message',
          'Finished-goods hub row must have product_batch'
        );
      END IF;

      SELECT oi.id, oi.quantity_on_hand, COALESCE(oi.reserved_quantity, 0)
      INTO v_dest, v_qoh, v_res
      FROM public.outlet_inventory oi
      WHERE oi.outlet_id = v_so.outlet_id
        AND oi.raw_material_id IS NULL
        AND trim(both from oi.product_batch) = v_pb
        AND (oi.lot_id IS NOT DISTINCT FROM v_hlot)
      ORDER BY oi.created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_dest IS NOT NULL THEN
        v_new_qoh := v_qoh + line.quantity;
        UPDATE public.outlet_inventory oi
        SET
          quantity_on_hand = v_new_qoh,
          available_quantity = v_new_qoh - v_res,
          last_updated = v_iso,
          updated_at = v_iso
        WHERE oi.id = v_dest;
      ELSE
        INSERT INTO public.outlet_inventory (
          outlet_id,
          raw_material_id,
          product_batch,
          lot_id,
          quantity_on_hand,
          reserved_quantity,
          available_quantity,
          last_updated,
          updated_at
        )
        VALUES (
          v_so.outlet_id,
          NULL,
          v_pb,
          v_hlot,
          line.quantity,
          0,
          line.quantity,
          v_iso,
          v_iso
        );
      END IF;
    END IF;
  END LOOP;

  UPDATE public.supply_orders
  SET
    status = 'received',
    received_date = CURRENT_DATE,
    updated_at = v_iso
  WHERE id = p_supply_order_id;

  PERFORM public._append_data_ledger(
    'received',
    'supply_order',
    p_supply_order_id::text,
    'distribution',
    'event',
    NULL,
    jsonb_build_object(
      'outlet_id',
      v_so.outlet_id,
      'received_date',
      CURRENT_DATE,
      'idempotency_key',
      p_idempotency_key
    ),
    NULL,
    NULL
  );

  RETURN jsonb_build_object('success', true, 'supply_order_id', p_supply_order_id);
END;
$$;
