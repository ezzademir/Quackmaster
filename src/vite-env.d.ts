/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** Legacy JWT anon/public key from Dashboard → API */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Preferred: publishable key (`sb_publishable_…`) from Dashboard → API */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
