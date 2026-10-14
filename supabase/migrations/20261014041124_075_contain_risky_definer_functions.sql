-- APPLIED to prod 14 Oct 2026 ~12:11 MYT (version 20261014041124) as containment, cleared by Clive with Ezzad's approval.
-- Rollback: GRANT EXECUTE ON FUNCTION public._hub_adjust_raw_material(uuid, numeric), public.invoke_storehub_sync_cron() TO PUBLIC, anon, authenticated;
-- Callers unaffected: cron job 1 runs as postgres (owner); admin_void_production_run / admin_restore_voided_production_run are SECURITY DEFINER owned by postgres.
REVOKE EXECUTE ON FUNCTION public._hub_adjust_raw_material(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invoke_storehub_sync_cron() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._hub_adjust_raw_material(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoke_storehub_sync_cron() TO service_role;
