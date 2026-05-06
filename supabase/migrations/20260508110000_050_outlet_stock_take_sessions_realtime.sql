-- Enable Realtime broadcast for session list subscriptions (postgres_changes).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'outlet_stock_take_sessions'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.outlet_stock_take_sessions;
  END IF;
END $do$;
