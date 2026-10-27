/*
  Per-user page and feature grants.

  Admins bypass grants in has_feature() and in the client.
  Users, Change log, and Settings are not grantable.
  Existing staff and supervisors are backfilled to the pages they can open today.
  Destructive features stay off unless an admin grants them.

  Keep keys in sync with src/utils/accessCatalog.ts.
*/

CREATE TABLE public.profile_access (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('page', 'feature')),
  key text NOT NULL CHECK (key ~ '^[a-z0-9._-]+$'),
  PRIMARY KEY (profile_id, kind, key)
);

ALTER TABLE public.profile_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY profile_access_select_own
  ON public.profile_access
  FOR SELECT
  TO authenticated
  USING (profile_id = auth.uid());

REVOKE ALL ON TABLE public.profile_access FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.profile_access TO authenticated;

CREATE OR REPLACE FUNCTION public.has_feature(p_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ok boolean;
BEGIN
  IF auth.uid() IS NULL OR p_key IS NULL OR btrim(p_key) = '' THEN
    RETURN false;
  END IF;

  IF public.is_profiles_admin() THEN
    RETURN true;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.profile_access pa
    WHERE pa.profile_id = auth.uid()
      AND pa.kind = 'feature'
      AND pa.key = p_key
  )
  INTO ok;

  RETURN COALESCE(ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.has_feature(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_feature(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_access()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'pages', COALESCE(
      (
        SELECT jsonb_agg(pa.key ORDER BY pa.key)
        FROM public.profile_access pa
        WHERE pa.profile_id = auth.uid()
          AND pa.kind = 'page'
      ),
      '[]'::jsonb
    ),
    'features', COALESCE(
      (
        SELECT jsonb_agg(pa.key ORDER BY pa.key)
        FROM public.profile_access pa
        WHERE pa.profile_id = auth.uid()
          AND pa.kind = 'feature'
      ),
      '[]'::jsonb
    )
  );
$$;

REVOKE ALL ON FUNCTION public.get_my_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_access() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_profile_access(p_target_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated', 'message', 'You must be signed in');
  END IF;

  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only admins can read access grants');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'pages', COALESCE(
      (
        SELECT jsonb_agg(pa.key ORDER BY pa.key)
        FROM public.profile_access pa
        WHERE pa.profile_id = p_target_user_id
          AND pa.kind = 'page'
      ),
      '[]'::jsonb
    ),
    'features', COALESCE(
      (
        SELECT jsonb_agg(pa.key ORDER BY pa.key)
        FROM public.profile_access pa
        WHERE pa.profile_id = p_target_user_id
          AND pa.kind = 'feature'
      ),
      '[]'::jsonb
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_profile_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_profile_access(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_profile_access(
  p_target_user_id uuid,
  p_pages text[],
  p_features text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pages text[];
  v_features text[];
  v_jwt_role text;
BEGIN
  v_jwt_role := coalesce(auth.jwt() ->> 'role', '');

  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'unauthenticated', 'message', 'You must be signed in');
    END IF;
    IF NOT public.is_profiles_admin() THEN
      RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only admins can set access grants');
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_target_user_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found', 'message', 'User profile not found');
  END IF;

  v_pages := ARRAY[]::text[];
  v_features := ARRAY[]::text[];

  SELECT COALESCE(array_agg(DISTINCT btrim(item)), ARRAY[]::text[])
  INTO v_pages
  FROM unnest(COALESCE(p_pages, ARRAY[]::text[])) AS item
  WHERE btrim(item) <> '';

  SELECT COALESCE(array_agg(DISTINCT btrim(item)), ARRAY[]::text[])
  INTO v_features
  FROM unnest(COALESCE(p_features, ARRAY[]::text[])) AS item
  WHERE btrim(item) <> '';

  v_pages := COALESCE(v_pages, ARRAY[]::text[]);
  v_features := COALESCE(v_features, ARRAY[]::text[]);

  IF EXISTS (
    SELECT 1
    FROM unnest(v_pages) AS item
    WHERE item NOT IN (
      'overview', 'procurement', 'production', 'inventory', 'distribution',
      'sales', 'waste', 'stock-take', 'genealogy', 'pos-compare', 'audit', 'reconciliation'
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_page', 'message', 'One or more pages cannot be granted');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_features) AS item
    WHERE item NOT IN (
      'sales.void', 'sales.replace', 'procurement.cancel_po', 'production.void_run',
      'production.qc_override', 'production.plan', 'distribution.hard_delete'
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_feature', 'message', 'One or more features cannot be granted');
  END IF;

  IF 'sales.replace' = ANY(v_features) AND NOT ('sales.void' = ANY(v_features)) THEN
    v_features := array_append(v_features, 'sales.void');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_features) AS feature_key
    WHERE NOT (
      CASE feature_key
        WHEN 'sales.void' THEN 'sales'
        WHEN 'sales.replace' THEN 'sales'
        WHEN 'procurement.cancel_po' THEN 'procurement'
        WHEN 'production.void_run' THEN 'production'
        WHEN 'production.qc_override' THEN 'production'
        WHEN 'production.plan' THEN 'production'
        WHEN 'distribution.hard_delete' THEN 'distribution'
        ELSE NULL
      END = ANY(v_pages)
    )
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'feature_without_page',
      'message', 'Turn on the page before granting a feature on it'
    );
  END IF;

  DELETE FROM public.profile_access WHERE profile_id = p_target_user_id;

  INSERT INTO public.profile_access (profile_id, kind, key)
  SELECT p_target_user_id, 'page', item
  FROM unnest(v_pages) AS item;

  INSERT INTO public.profile_access (profile_id, kind, key)
  SELECT p_target_user_id, 'feature', item
  FROM unnest(v_features) AS item;

  RETURN jsonb_build_object(
    'success', true,
    'pages', to_jsonb(v_pages),
    'features', to_jsonb(v_features)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_profile_access(uuid, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_profile_access(uuid, text[], text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_profile_access(uuid, text[], text[]) TO service_role;

INSERT INTO public.profile_access (profile_id, kind, key)
SELECT p.id, 'page', page.key
FROM public.profiles p
CROSS JOIN (
  VALUES
    ('overview'),
    ('procurement'),
    ('production'),
    ('inventory'),
    ('distribution'),
    ('sales'),
    ('waste'),
    ('stock-take'),
    ('genealogy')
) AS page(key)
WHERE p.role = 'staff'
ON CONFLICT DO NOTHING;

INSERT INTO public.profile_access (profile_id, kind, key)
SELECT p.id, 'page', page.key
FROM public.profiles p
CROSS JOIN (
  VALUES ('sales'), ('waste'), ('stock-take')
) AS page(key)
WHERE p.role = 'supervisor'
ON CONFLICT DO NOTHING;

-- Widen the admin-only guards on destructive RPCs to the matching feature.
-- StoreHub sale voids stay admin-only (the second check in void_sales_journal).
CREATE FUNCTION pg_temp.patch_function_source(p_proc regprocedure, p_old text, p_new text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  def text;
  updated text;
  hits integer;
BEGIN
  def := pg_get_functiondef(p_proc);
  hits := (length(def) - length(replace(def, p_old, ''))) / length(p_old);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'expected 1 occurrence of guard in %, found %', p_proc::text, hits;
  END IF;
  updated := replace(def, p_old, p_new);
  EXECUTE updated;
END;
$$;

SELECT pg_temp.patch_function_source(
  'public.void_sales_journal(uuid)'::regprocedure,
  $old$  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;$old$,
  $new$  IF NOT public.has_feature('sales.void') THEN
    RETURN jsonb_build_object('success', false, 'error', 'feature_required');
  END IF;$new$
);

SELECT pg_temp.patch_function_source(
  'public.admin_void_production_run(uuid, text)'::regprocedure,
  $old$  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;$old$,
  $new$  IF NOT public.has_feature('production.void_run') THEN
    RAISE EXCEPTION 'You do not have permission to manage production runs';
  END IF;$new$
);

SELECT pg_temp.patch_function_source(
  'public.admin_restore_voided_production_run(uuid, text)'::regprocedure,
  $old$  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;$old$,
  $new$  IF NOT public.has_feature('production.void_run') THEN
    RAISE EXCEPTION 'You do not have permission to manage production runs';
  END IF;$new$
);

SELECT pg_temp.patch_function_source(
  'public.admin_delete_production_run(uuid)'::regprocedure,
  $old$  IF NOT public.is_profiles_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;$old$,
  $new$  IF NOT public.has_feature('production.void_run') THEN
    RAISE EXCEPTION 'You do not have permission to manage production runs';
  END IF;$new$
);

SELECT pg_temp.patch_function_source(
  'public.admin_delete_supply_order(uuid)'::regprocedure,
  $old$  IF NOT public.is_profiles_admin() THEN RAISE EXCEPTION 'Admin privileges required'; END IF;$old$,
  $new$  IF NOT public.has_feature('distribution.hard_delete') THEN RAISE EXCEPTION 'You do not have permission to delete supply orders'; END IF;$new$
);

-- cancel_purchase_order and replace_sales_journal differ between a fresh replay of
-- this repo and databases that already tightened those guards. Patch whichever shape is present.
DO $$
DECLARE
  def text;
  updated text;
  live_cancel text := $old$  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only an admin can cancel a purchase order');
  END IF;$old$;
  repo_cancel text := $old$  IF p_po_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_po_id');
  END IF;$old$;
  live_replace text := $old$  IF NOT public.is_profiles_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden', 'message', 'Only admins can edit posted sales journals');
  END IF;$old$;
  repo_replace text := $old$  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;$old$;
BEGIN
  def := pg_get_functiondef('public.cancel_purchase_order(uuid)'::regprocedure);
  IF position('has_feature(''procurement.cancel_po'')' in def) = 0 THEN
    IF position(live_cancel in def) > 0 THEN
      updated := replace(def, live_cancel, $new$  IF NOT public.has_feature('procurement.cancel_po') THEN
    RETURN jsonb_build_object('success', false, 'error', 'feature_required');
  END IF;$new$);
    ELSIF position(repo_cancel in def) > 0 THEN
      updated := replace(def, repo_cancel, $new$  IF NOT public.has_feature('procurement.cancel_po') THEN
    RETURN jsonb_build_object('success', false, 'error', 'feature_required');
  END IF;

  IF p_po_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_po_id');
  END IF;$new$);
    ELSE
      RAISE EXCEPTION 'cancel_purchase_order has an unrecognized guard';
    END IF;
    EXECUTE updated;
  END IF;

  def := pg_get_functiondef('public.replace_sales_journal(uuid, date, jsonb, text, uuid)'::regprocedure);
  IF position('has_feature(''sales.replace'')' in def) = 0 THEN
    IF position(live_replace in def) > 0 THEN
      updated := replace(def, live_replace, $new$  IF NOT public.has_feature('sales.replace') THEN
    RETURN jsonb_build_object('success', false, 'error', 'feature_required');
  END IF;$new$);
    ELSIF position(repo_replace in def) > 0 THEN
      updated := replace(def, repo_replace, $new$  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.has_feature('sales.replace') THEN
    RETURN jsonb_build_object('success', false, 'error', 'feature_required');
  END IF;$new$);
    ELSE
      RAISE EXCEPTION 'replace_sales_journal has an unrecognized guard';
    END IF;
    EXECUTE updated;
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Feature holders can manage production_resources" ON public.production_resources;
CREATE POLICY "Feature holders can manage production_resources"
  ON public.production_resources
  FOR ALL
  TO authenticated
  USING (public.has_feature('production.plan'))
  WITH CHECK (public.has_feature('production.plan'));

DROP POLICY IF EXISTS "Feature holders can manage planned_batches" ON public.planned_batches;
CREATE POLICY "Feature holders can manage planned_batches"
  ON public.planned_batches
  FOR ALL
  TO authenticated
  USING (public.has_feature('production.plan'))
  WITH CHECK (public.has_feature('production.plan'));
