/*
  # VOLATILE required for SET / set_config inside functions

  Postgres error 0A000: "SET is not allowed in a non-volatile function".
  Any function using SET LOCAL or set_config('row_security', ...) must be VOLATILE, not STABLE.

  Apply if migrations 018/020 were already deployed with STABLE.
*/

ALTER FUNCTION public.is_profiles_admin() VOLATILE;

DO $$
BEGIN
  ALTER FUNCTION public.get_users_management_data() VOLATILE;
EXCEPTION
  WHEN SQLSTATE '42883' THEN
    NULL;
END;
$$;
