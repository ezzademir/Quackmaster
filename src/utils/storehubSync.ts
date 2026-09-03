import { supabase } from './supabase';

export type StorehubAction = 'status' | 'catalog' | 'sync';

export interface StorehubStore {
  id: string;
  name: string;
}

export interface StorehubProduct {
  id: string;
  name: string;
  sku: string;
  isParentProduct: boolean;
}

export interface StorehubSyncRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  window_from: string | null;
  window_to: string | null;
  triggered_by: string;
  stores_synced: number;
  sales_ingested: number;
  cancelled: number;
  returns_flagged: number;
  failed: number;
  error: string | null;
}

export interface StorehubSyncEvent {
  id: string;
  ref_id: string;
  invoice_number: string | null;
  event_type: string;
  status: string;
  error: string | null;
  outlet_id: string | null;
  created_at: string;
  payload: Record<string, unknown> | null;
}

export async function invokeStorehub<T>(
  action: StorehubAction,
  extra?: { from?: string; to?: string }
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(
    'sync_storehub_sales',
    { body: { action, ...extra } }
  );
  if (error) {
    return { data: null, error: error.message };
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    return { data, error: String(data.error) };
  }
  return { data: data as T, error: null };
}
