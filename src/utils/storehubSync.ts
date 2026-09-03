import { supabase } from './supabase';

export type StorehubAction = 'status' | 'catalog' | 'sync' | 'report';

export type StorehubReportId =
  | 'sales_over_time'
  | 'sales_by_product'
  | 'sales_by_category'
  | 'sales_by_sku'
  | 'sales_by_payment'
  | 'sales_by_channel'
  | 'promotions'
  | 'tax'
  | 'employee'
  | 'offline_txns'
  | 'online_txns'
  | 'returns'
  | 'stock_value';

export type StorehubDiffStatus =
  | 'match'
  | 'qty_mismatch'
  | 'missing_in_dashboard'
  | 'extra_in_dashboard'
  | 'pos_only';

export interface StorehubReportOption {
  id: StorehubReportId | string;
  group: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
  snapshot?: boolean;
  posOnly?: boolean;
}

/** Full StoreHub BackOffice report map. Unavailable items stay visible but cannot be run. */
export const STOREHUB_REPORTS: StorehubReportOption[] = [
  { id: 'sales_by_sku', group: 'Sales & Transaction', label: 'Sales by Variant / SKU', available: true },
  { id: 'sales_over_time', group: 'Sales & Transaction', label: 'Sales Over Time', available: true },
  { id: 'sales_by_product', group: 'Sales & Transaction', label: 'Sales by Product', available: true },
  { id: 'sales_by_category', group: 'Sales & Transaction', label: 'Sales by Product Category', available: true },
  { id: 'sales_by_payment', group: 'Sales & Transaction', label: 'Sales by Payment Method', available: true, posOnly: true },
  { id: 'sales_by_channel', group: 'Sales & Transaction', label: 'Sales by Transaction Channel', available: true },
  { id: 'promotions', group: 'Sales & Transaction', label: 'Promotions', available: true, posOnly: true },
  { id: 'offline_txns', group: 'Transaction records', label: 'Offline Transactions', available: true },
  { id: 'online_txns', group: 'Transaction records', label: 'Online Orders', available: true },
  { id: 'returns', group: 'Transaction records', label: 'Returns', available: true },
  {
    id: 'employee',
    group: 'Team & Shift',
    label: 'Employee Performance',
    available: true,
    posOnly: true,
  },
  {
    id: 'shifts',
    group: 'Team & Shift',
    label: 'Shifts / Z-reading',
    available: false,
    unavailableReason: 'StoreHub does not expose shifts through the public API.',
  },
  { id: 'stock_value', group: 'Stock & Inventory', label: 'Stock Value', available: true, snapshot: true },
  {
    id: 'stock_loss',
    group: 'Stock & Inventory',
    label: 'Stock Loss Report',
    available: false,
    unavailableReason: 'StoreHub does not expose stock-loss through the public API.',
  },
  {
    id: 'wastage',
    group: 'Stock & Inventory',
    label: 'Wastage Insights',
    available: false,
    unavailableReason: 'StoreHub does not expose wastage insights through the public API.',
  },
  {
    id: 'goods_raw',
    group: 'Stock & Inventory',
    label: 'Goods & Raw Materials',
    available: false,
    unavailableReason: 'StoreHub does not expose this report through the public API.',
  },
  { id: 'tax', group: 'Tax & Compliance', label: 'Tax Report', available: true, posOnly: true },
  {
    id: 'bir',
    group: 'Tax & Compliance',
    label: 'BIR reports',
    available: false,
    unavailableReason: 'Philippines-only; not in the public API.',
  },
];

export interface StorehubReportRow {
  key: string;
  label: string;
  posQty: number | null;
  posRm: number | null;
  dashQty: number | null;
  status: StorehubDiffStatus;
  detail?: string;
}

export interface StorehubReportResult {
  report: string;
  from: string | null;
  to: string | null;
  viewBy?: string;
  snapshot?: boolean;
  posOnly: boolean;
  notice: string | null;
  error: string | null;
  rows: StorehubReportRow[];
  totals: {
    posQty: number;
    posRm: number;
    dashQty: number;
    match: number;
    qty_mismatch: number;
    missing_in_dashboard: number;
    extra_in_dashboard: number;
    pos_only: number;
  };
}

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

async function functionErrorMessage(
  error: { message: string; context?: unknown },
  data: { error?: string } | null
): Promise<string> {
  if (data && typeof data === 'object' && data.error) return String(data.error);
  const ctx = error.context;
  if (ctx && typeof ctx === 'object' && 'json' in ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body?.error) return String(body.error);
    } catch {
      /* body already consumed or not JSON */
    }
  }
  return error.message;
}

export async function invokeStorehub<T>(
  action: StorehubAction,
  extra?: { from?: string; to?: string; report?: string; storeId?: string; viewBy?: string }
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(
    'sync_storehub_sales',
    { body: { action, ...extra } }
  );
  if (error) {
    return { data: data ?? null, error: await functionErrorMessage(error, data) };
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    return { data, error: String(data.error) };
  }
  return { data: data as T, error: null };
}
