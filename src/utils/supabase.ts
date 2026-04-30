import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();

/** Prefer Dashboard “Publishable” key; fall back to legacy anon JWT. Never use service_role/secret in the app. */
const browserSafeApiKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** False when build/runtime env was not injected — avoids crashing the whole app on import. */
export const isSupabaseConfigured = Boolean(url && browserSafeApiKey);

/**
 * Placeholder values keep createClient() happy when env is missing so React can mount and show UI.
 * Auth/network calls will fail until real env vars are set at build time (or via .env locally).
 */
export const supabase = createClient(
  url ?? 'https://invalid-placeholder.supabase.co',
  browserSafeApiKey ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid-placeholder-key'
);
