/*
  Atomic supplier catalog link sync.

  The client previously deleted all supplier_raw_materials rows and then inserted
  replacements with separate REST calls. Keep the destructive step inside one DB
  transaction so a failed insert rolls the delete back.
*/

CREATE OR REPLACE FUNCTION public.sync_supplier_raw_materials(
  p_supplier_id uuid,
  p_raw_material_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[] := ARRAY[]::uuid[];
  v_missing_id uuid;
  v_supplier_found boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;

  IF p_supplier_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'supplier_required');
  END IF;

  SELECT true
  INTO v_supplier_found
  FROM public.suppliers
  WHERE id = p_supplier_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'supplier_not_found');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT raw_material_id), ARRAY[]::uuid[])
  INTO v_ids
  FROM unnest(COALESCE(p_raw_material_ids, ARRAY[]::uuid[])) AS requested(raw_material_id)
  WHERE raw_material_id IS NOT NULL;

  SELECT requested.raw_material_id
  INTO v_missing_id
  FROM unnest(v_ids) AS requested(raw_material_id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.raw_materials rm
    WHERE rm.id = requested.raw_material_id
  )
  LIMIT 1;

  IF v_missing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'raw_material_not_found',
      'raw_material_id', v_missing_id
    );
  END IF;

  DELETE FROM public.supplier_raw_materials srm
  WHERE srm.supplier_id = p_supplier_id
    AND NOT (srm.raw_material_id = ANY(v_ids));

  INSERT INTO public.supplier_raw_materials (supplier_id, raw_material_id)
  SELECT p_supplier_id, requested.raw_material_id
  FROM unnest(v_ids) AS requested(raw_material_id)
  ON CONFLICT (supplier_id, raw_material_id) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'supplier_id', p_supplier_id,
    'linked_count', COALESCE(array_length(v_ids, 1), 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_supplier_raw_materials(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_supplier_raw_materials(uuid, uuid[]) TO authenticated;
