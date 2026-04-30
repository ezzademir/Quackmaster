/*
  # Backfill outlet_inventory for dispatched-but-not-received orders

  Older clients credited outlet_inventory only on receipt. After switching to credit-at-dispatch,
  existing dispatched orders need outlet rows aligned so UI and inventory stay consistent.
*/

DO $$
DECLARE
  r RECORD;
  existing_id uuid;
  iso timestamptz := now();
BEGIN
  FOR r IN
    SELECT so.outlet_id,
           sol.product_batch,
           SUM(sol.quantity)::numeric AS qty
    FROM public.supply_order_lines sol
    INNER JOIN public.supply_orders so ON so.id = sol.supply_order_id
    WHERE so.status = 'dispatched'
    GROUP BY so.outlet_id, sol.product_batch
  LOOP
    SELECT oi.id INTO existing_id
    FROM public.outlet_inventory oi
    WHERE oi.outlet_id = r.outlet_id
      AND oi.product_batch = r.product_batch
    LIMIT 1;

    IF existing_id IS NOT NULL THEN
      UPDATE public.outlet_inventory
      SET
        quantity_on_hand = quantity_on_hand + r.qty,
        available_quantity = quantity_on_hand + r.qty - COALESCE(reserved_quantity, 0),
        last_updated = iso,
        updated_at = iso
      WHERE id = existing_id;
    ELSE
      INSERT INTO public.outlet_inventory (
        outlet_id,
        product_batch,
        quantity_on_hand,
        reserved_quantity,
        available_quantity,
        last_updated,
        updated_at
      )
      VALUES (
        r.outlet_id,
        r.product_batch,
        r.qty,
        0,
        r.qty,
        iso,
        iso
      );
    END IF;
  END LOOP;
END $$;
