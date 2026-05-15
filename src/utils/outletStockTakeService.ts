/**
 * Outlet physical stock take — post via RPC, list sessions/lines for history & CSV.
 */

import { supabase } from './supabase';
import type { Outlet } from '../types';

export interface OutletStockTakeLineInput {
  outlet_inventory_id: string;
  counted_qty: number;
  line_remark?: string | null;
}

export interface PostOutletStockTakeParams {
  outletId: string;
  countDate?: string;
  notes?: string | null;
  lines: OutletStockTakeLineInput[];
  idempotencyKey?: string | null;
}

export type PostOutletStockTakeResult =
  | {
      success: true;
      session_id: string;
      lines?: unknown;
      idempotent_replay?: boolean;
    }
  | { success: false; error: string; [k: string]: unknown };

export async function postOutletStockTake(params: PostOutletStockTakeParams): Promise<PostOutletStockTakeResult> {
  const { data, error } = await supabase.rpc('post_outlet_stock_take', {
    p_outlet_id: params.outletId,
    p_count_date: params.countDate ?? null,
    p_notes: params.notes?.trim() || null,
    p_lines: params.lines.map((l) => ({
      outlet_inventory_id: l.outlet_inventory_id,
      counted_qty: l.counted_qty,
      line_remark: l.line_remark ?? null,
    })),
    p_idempotency_key: params.idempotencyKey ?? null,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as PostOutletStockTakeResult | null;
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'empty_response' };
  }
  return payload;
}

export interface OutletStockTakeSessionRow {
  id: string;
  outlet_id: string;
  count_date: string;
  notes: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
  posted_at: string;
  outlet?: Pick<Outlet, 'id' | 'name'> | null;
}

export async function listOutletStockTakeSessions(outletId?: string) {
  let q = supabase
    .from('outlet_stock_take_sessions')
    .select('*, outlet:outlet_id(id, name)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (outletId) {
    q = q.eq('outlet_id', outletId);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as OutletStockTakeSessionRow[];
}

export interface OutletStockTakeLineRow {
  id: string;
  session_id: string;
  outlet_inventory_id: string;
  system_qoh_before: number;
  counted_qty: number;
  variance: number;
  line_remark: string | null;
  outlet_inventory?: {
    product_batch?: string | null;
    raw_material_id?: string | null;
    material?: { name?: string | null; unit_of_measure?: string | null } | null;
    lot?: { product_batch_label: string | null; expiry_date: string | null } | null;
  } | null;
}

export interface OutletStockTakeSessionDetail extends OutletStockTakeSessionRow {
  lines: OutletStockTakeLineRow[];
}

export async function getOutletStockTakeSessionDetail(sessionId: string): Promise<OutletStockTakeSessionDetail | null> {
  const { data: session, error: sErr } = await supabase
    .from('outlet_stock_take_sessions')
    .select('*, outlet:outlet_id(id, name)')
    .eq('id', sessionId)
    .maybeSingle();

  if (sErr) throw sErr;
  if (!session) return null;

  const { data: lines, error: lErr } = await supabase
    .from('outlet_stock_take_lines')
    .select(
      `
      *,
      outlet_inventory:outlet_inventory_id (
        product_batch,
        raw_material_id,
        material:raw_material_id ( name, unit_of_measure ),
        lot:inventory_lots ( product_batch_label, expiry_date )
      )
    `
    )
    .eq('session_id', sessionId)
    .order('id', { ascending: true });

  if (lErr) throw lErr;

  return {
    ...(session as OutletStockTakeSessionRow),
    lines: (lines ?? []) as OutletStockTakeLineRow[],
  };
}

const CSV_ESC = /["\r\n,]/;

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (CSV_ESC.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build CSV for a posted session (header + lines with variance & remarks). */
export function buildOutletStockTakeCsv(
  session: Pick<OutletStockTakeSessionRow, 'id' | 'count_date' | 'notes' | 'posted_at' | 'outlet'>,
  lines: Array<{
    outlet_inventory_id: string;
    product_batch?: string;
    lot_label?: string | null;
    system_qoh_before: number;
    counted_qty: number;
    variance: number;
    line_remark?: string | null;
  }>
): string {
  const outletName = session.outlet?.name ?? '';
  const header = [
    'session_id',
    'outlet',
    'count_date',
    'posted_at',
    'session_notes',
    'outlet_inventory_id',
    'product_batch',
    'lot_label',
    'system_qoh_before',
    'counted_qty',
    'variance',
    'line_remark',
  ];
  const rows = lines.map((l) =>
    [
      session.id,
      outletName,
      session.count_date,
      session.posted_at,
      session.notes ?? '',
      l.outlet_inventory_id,
      l.product_batch ?? '',
      l.lot_label ?? '',
      l.system_qoh_before,
      l.counted_qty,
      l.variance,
      l.line_remark ?? '',
    ].map(csvCell)
  );

  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
}
