/*
  # Atomic production run numbers

  Client-generated RUN-nnnn values race under concurrent inserts and can duplicate.
  A Postgres sequence + RPC guarantees uniqueness.
*/

CREATE SEQUENCE IF NOT EXISTS public.production_run_number_seq;

SELECT setval(
  'public.production_run_number_seq',
  COALESCE(
    (
      SELECT MAX((regexp_match(run_number, '^RUN-(\d+)$'))[1]::bigint)
      FROM public.production_runs
    ),
    0
  )
);

CREATE OR REPLACE FUNCTION public.next_production_run_number()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT 'RUN-' || lpad(nextval('public.production_run_number_seq')::text, 4, '0');
$$;

REVOKE ALL ON FUNCTION public.next_production_run_number() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_production_run_number() TO authenticated;
