-- Quackmaster only.
-- Void posted journals that came from StoreHub ingest (even if earlier rewired to source=manual).
-- True staff-keyed manuals have no storehub_sync_events row and are left alone (e.g. 1Utama).

DO $$
DECLARE
  j RECORD;
  r RECORD;
  v_voided int := 0;
  leg_id uuid;
BEGIN
  FOR j IN
    SELECT DISTINCT sj.id, sj.outlet_id, sj.business_date, sj.idempotency_key
    FROM public.sales_journals sj
    WHERE sj.status = 'posted'
      AND EXISTS (
        SELECT 1
        FROM public.storehub_sync_events e
        WHERE e.sales_journal_id = sj.id
      )
    ORDER BY sj.business_date, sj.id
  LOOP
    FOR r IN
      SELECT product_batch, quantity_sold, outlet_inventory_id
      FROM public.sales_journal_lines
      WHERE sales_journal_id = j.id
      ORDER BY created_at, id
    LOOP
      leg_id := r.outlet_inventory_id;
      IF leg_id IS NULL THEN
        SELECT oi.id INTO leg_id
        FROM public.outlet_inventory oi
        WHERE oi.outlet_id = j.outlet_id
          AND trim(both from oi.product_batch) = trim(both from r.product_batch)
        ORDER BY oi.created_at ASC NULLS LAST
        LIMIT 1;
      END IF;

      IF leg_id IS NULL THEN
        RAISE EXCEPTION 'outlet_stock_missing_for_reversal journal=% batch=%', j.id, r.product_batch;
      END IF;

      PERFORM public._set_outlet_movement_ctx(
        j.outlet_id,
        'reversal',
        j.business_date,
        'sales_journal',
        j.id,
        jsonb_build_object('source', 'void_former_storehub_ingest', 'product_batch', r.product_batch)
      );

      UPDATE public.outlet_inventory oi
      SET
        quantity_on_hand = oi.quantity_on_hand + r.quantity_sold,
        available_quantity = (oi.quantity_on_hand + r.quantity_sold) - COALESCE(oi.reserved_quantity, 0),
        last_updated = now(),
        updated_at = now()
      WHERE oi.id = leg_id;

      PERFORM public._clear_outlet_movement_ctx();
    END LOOP;

    UPDATE public.sales_journals
    SET
      status = 'voided',
      source = 'storehub',
      notes = 'Voided: was StoreHub ingest, not a manual batch sale',
      updated_at = now()
    WHERE id = j.id;

    UPDATE public.storehub_sync_events
    SET
      status = 'voided',
      error = 'void_former_storehub_ingest',
      payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('voided_as_ingest', true),
      updated_at = now()
    WHERE sales_journal_id = j.id
       OR (j.idempotency_key IS NOT NULL AND ref_id = j.idempotency_key);

    v_voided := v_voided + 1;
  END LOOP;

  RAISE NOTICE 'void_former_storehub_ingested_sales: voided_journals=%', v_voided;
END;
$$;
