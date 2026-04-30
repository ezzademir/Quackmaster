import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** False when build/runtime env was not injected — avoids crashing the whole app on import. */
export const isSupabaseConfigured = Boolean(url && anonKey);

/**
 * Placeholder values keep createClient() happy when env is missing so React can mount and show UI.
 * Auth/network calls will fail until real env vars are set at build time (or via .env locally).
 */
export const supabase = createClient(
  url ?? 'https://invalid-placeholder.supabase.co',
  anonKey ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid-placeholder-key'
);
