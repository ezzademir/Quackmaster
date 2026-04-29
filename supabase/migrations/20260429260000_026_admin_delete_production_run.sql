/*
  # Admin-only delete for production runs

  Deletes a production run and (when status is completed) removes the matching hub
  finished-goods batch (`BATCH-{first UUID segment}`) and restores consumed raw materials.
  Blocks delete if the batch row has reserved_quantity > 0.

  Client-side inserts/updates on production_runs may be blocked by RLS; this RPC runs as
  SECURITY DEFINER so admins can delete consistently.
*/

CREATE OR REPLACE FUNCTION public.admin_delete_production_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run_status text;
  batch_label text;
  hub_pid uuid;
  hub_preserved numeric;
  mat RECORD;
  hm_id uuid;
  hm_qoh numeric;
  hm_res numeric;
  new_qoh numeric;
  new_avail numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT status INTO run_status
  FROM public.production_runs
  WHERE id = p_run_id;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'Production run not found';
  END IF;

  batch_label := 'BATCH-' || split_part(p_run_id::text, '-', 1);

  IF run_status = 'completed' THEN
    SELECT hi.id, hi.reserved_quantity
    INTO hub_pid, hub_preserved
    FROM public.hub_inventory hi
    WHERE hi.product_batch = batch_label
    LIMIT 1;

    IF hub_pid IS NOT NULL THEN
      IF COALESCE(hub_preserved, 0) > 0 THEN
        RAISE EXCEPTION 'Cannot delete: finished goods batch has reserved quantity (resolve distribution orders first)';
      END IF;

      DELETE FROM public.hub_inventory WHERE id = hub_pid;
    END IF;

    FOR mat IN
      SELECT prm.raw_material_id, prm.quantity_consumed
      FROM public.production_run_materials prm
      WHERE prm.production_run_id = p_run_id
    LOOP
      SELECT hi.id, hi.quantity_on_hand, COALESCE(hi.reserved_quantity, 0)
      INTO hm_id, hm_qoh, hm_res
      FROM public.hub_inventory hi
      WHERE hi.raw_material_id = mat.raw_material_id
      LIMIT 1;

      IF hm_id IS NOT NULL THEN
        new_qoh := COALESCE(hm_qoh, 0) + COALESCE(mat.quantity_consumed, 0);
        new_avail := new_qoh - hm_res;

        UPDATE public.hub_inventory
        SET
          quantity_on_hand = new_qoh,
          available_quantity = new_avail,
          last_updated = now(),
          updated_at = now()
        WHERE id = hm_id;
      END IF;
    END LOOP;
  END IF;

  DELETE FROM public.production_runs WHERE id = p_run_id;

  RETURN jsonb_build_object('ok', true, 'batch_label', batch_label);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_production_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_production_run(uuid) TO authenticated;
