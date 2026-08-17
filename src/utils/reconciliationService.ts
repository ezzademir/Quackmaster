/**
 * Outlet stock reconciliation and audit RPC wrappers.
 */

import { supabase } from './supabase';
import { formatDateForInput } from './dateRange';
import type { DateRange } from './dateRange';

export interface ReconcileOutletStockResult {
  success: boolean;
  error?: string;
  outlet_id?: string;
  period_from?: string;
  period_to?: string;
  include_raw_materials?: boolean;
  opening_qoh?: number;
  supply_in?: number;
  transfers_in?: number;
  transfers_out?: number;
  sales?: number;
  waste?: number;
  stock_take_adjustments?: number;
  reversals?: number;
  computed_closing?: number;
  live_on_hand?: number;
  unexplained_variance?: number;
  in_transit_supply?: number;
  in_transit_transfer?: number;
  last_stock_take?: {
    session_id?: string;
    count_date?: string;
    total_variance?: number;
  } | null;
}

export interface BalanceAsOfResult {
  success: boolean;
  error?: string;
  outlet_id?: string;
  as_of?: string;
  snapshot_date?: string | null;
  total_on_hand?: number;
  from_snapshot_base?: number;
  movements_delta?: number;
  current_live_lines?: Array<{
    outlet_inventory_id: string;
    product_batch?: string | null;
    raw_material_id?: string | null;
    quantity_on_hand: number;
  }>;
}

export interface OutletMovementRow {
  id: string;
  outlet_id: string;
  outlet_inventory_id: string;
  movement_type: string;
  signed_qty: number;
  business_date: string;
  reference_type: string;
  reference_id: string;
  qoh_after: number | null;
  created_at: string;
}

export async function reconcileOutletStock(options: {
  outletId: string;
  from: Date;
  to: Date;
  includeRawMaterials?: boolean;
}): Promise<ReconcileOutletStockResult> {
  const { data, error } = await supabase.rpc('reconcile_outlet_stock', {
    p_outlet_id: options.outletId,
    p_from: formatDateForInput(options.from),
    p_to: formatDateForInput(options.to),
    p_include_raw_materials: options.includeRawMaterials ?? true,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as ReconcileOutletStockResult | null;
  if (!payload || payload.success === false) {
    return { success: false, error: payload?.error ?? 'reconcile_failed' };
  }

  return payload;
}

export async function getOutletBalanceAsOf(options: {
  outletId: string;
  asOf: Date;
  includeRawMaterials?: boolean;
}): Promise<BalanceAsOfResult> {
  const { data, error } = await supabase.rpc('get_outlet_balance_as_of', {
    p_outlet_id: options.outletId,
    p_as_of: formatDateForInput(options.asOf),
    p_include_raw_materials: options.includeRawMaterials ?? true,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as BalanceAsOfResult | null;
  if (!payload || payload.success === false) {
    return { success: false, error: payload?.error ?? 'balance_lookup_failed' };
  }

  return payload;
}

export async function fetchOutletMovements(options: {
  outletId: string;
  from: Date;
  to: Date;
  outletInventoryId?: string;
}): Promise<OutletMovementRow[]> {
  let q = supabase
    .from('outlet_stock_movements')
    .select('*')
    .eq('outlet_id', options.outletId)
    .gte('business_date', formatDateForInput(options.from))
    .lte('business_date', formatDateForInput(options.to))
    .order('business_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (options.outletInventoryId) {
    q = q.eq('outlet_inventory_id', options.outletInventoryId);
  }

  const { data, error } = await q;

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as OutletMovementRow[];
}

export interface SkuReconcileRow {
  sku_key: string;
  kind: string;
  label: string;
  raw_material_id?: string | null;
  product_batch?: string | null;
  opening_qoh: number;
  supply_in: number;
  transfers_in: number;
  transfers_out: number;
  sales: number;
  waste: number;
  stock_take_adjustments: number;
  reversals: number;
  computed_closing: number;
  live_on_hand: number;
  unexplained_variance: number;
}

export async function reconcileOutletStockBySku(options: {
  outletId: string;
  from: Date;
  to: Date;
  includeRawMaterials?: boolean;
}): Promise<{ success: boolean; error?: string; rows?: SkuReconcileRow[] }> {
  const { data, error } = await supabase.rpc('reconcile_outlet_stock_by_sku', {
    p_outlet_id: options.outletId,
    p_from: formatDateForInput(options.from),
    p_to: formatDateForInput(options.to),
    p_include_raw_materials: options.includeRawMaterials ?? true,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as { success?: boolean; error?: string; rows?: SkuReconcileRow[] } | null;
  if (!payload || payload.success === false) {
    return { success: false, error: payload?.error ?? 'reconcile_by_sku_failed' };
  }

  return { success: true, rows: payload.rows ?? [] };
}

export function movementsToCsv(rows: OutletMovementRow[], outletName: string): string {
  const header = ['outlet', 'business_date', 'movement_type', 'signed_qty', 'reference_type', 'reference_id', 'outlet_inventory_id', 'qoh_after', 'created_at'];
  const lines = rows.map((r) =>
    [
      outletName,
      r.business_date,
      r.movement_type,
      String(r.signed_qty),
      r.reference_type,
      r.reference_id,
      r.outlet_inventory_id,
      r.qoh_after != null ? String(r.qoh_after) : '',
      r.created_at,
    ]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(',')
  );
  return [header.join(','), ...lines].join('\n');
}

export function defaultReconcileRange(): DateRange {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setDate(start.getDate() - 30);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

export async function snapshotAllOutletsDaily(): Promise<{ count: number; error?: string }> {
  const { data, error } = await supabase.rpc('snapshot_all_outlets_daily');
  if (error) return { count: 0, error: error.message };
  return { count: Number(data ?? 0) };
}
