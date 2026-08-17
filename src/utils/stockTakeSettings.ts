import { supabase } from './supabase';

const DEFAULT_THRESHOLD = 5;

/** Absolute |counted − system| above which staff/admin must recount before post. */
export async function fetchStockTakeVarianceThreshold(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('stock_take_settings')
      .select('variance_threshold')
      .eq('id', 1)
      .maybeSingle();
    if (error || data == null) return DEFAULT_THRESHOLD;
    const n = Number((data as { variance_threshold?: number }).variance_threshold);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

export async function saveStockTakeVarianceThreshold(threshold: number): Promise<{ ok: boolean; error?: string }> {
  const n = Number(threshold);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Threshold must be a non-negative number.' };
  const { error } = await supabase.from('stock_take_settings').upsert({
    id: 1,
    variance_threshold: n,
    updated_at: new Date().toISOString(),
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
