import { supabase } from './supabase';
import type { PoCancelRequestRow, PoCancelRequestStatus } from './poCancelUi';

export const PO_CANCEL_REQUEST_SELECT = `
  id,
  purchase_order_id,
  requested_by,
  requested_at,
  reason,
  status,
  decided_by,
  decided_at,
  decision_reason,
  purchase_order:purchase_order_id(
    id,
    order_number,
    status,
    entity_code,
    total_amount,
    supplier:supplier_id(id, name)
  ),
  requester:requested_by(id, full_name),
  decider:decided_by(id, full_name)
`;

export type PoCancelRequestJoined = PoCancelRequestRow & {
  purchase_order?: {
    id: string;
    order_number: string;
    status: string;
    entity_code?: string | null;
    total_amount?: number | null;
    supplier?: { id: string; name: string } | { id: string; name: string }[] | null;
  } | null;
  requester?: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
  decider?: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
};

export type ListCancelRequestsOpts = {
  purchaseOrderId?: string;
  status?: PoCancelRequestStatus | PoCancelRequestStatus[];
  limit?: number;
  orderBy?: 'requested_at' | 'decided_at';
};

type CancelRequestQuery = {
  select: (cols: string) => CancelRequestQuery;
  eq: (col: string, value: string) => CancelRequestQuery;
  in: (col: string, values: string[]) => CancelRequestQuery;
  order: (col: string, opts: { ascending: boolean }) => CancelRequestQuery;
  limit: (n: number) => PromiseLike<{ data: PoCancelRequestJoined[] | null; error: { message?: string } | null }>;
};

function requestTable(): CancelRequestQuery {
  return supabase.from('po_cancel_requests') as unknown as CancelRequestQuery;
}

function applyCancelRequestFilters(
  query: CancelRequestQuery,
  opts: ListCancelRequestsOpts & { requestedBy?: string }
): PromiseLike<{ data: PoCancelRequestJoined[] | null; error: { message?: string } | null }> {
  let q = query.select(PO_CANCEL_REQUEST_SELECT);
  if (opts.requestedBy) q = q.eq('requested_by', opts.requestedBy);
  if (opts.purchaseOrderId) q = q.eq('purchase_order_id', opts.purchaseOrderId);
  if (typeof opts.status === 'string') q = q.eq('status', opts.status);
  else if (Array.isArray(opts.status) && opts.status.length) q = q.in('status', opts.status);
  const orderBy = opts.orderBy ?? (opts.status === 'pending' ? 'requested_at' : 'decided_at');
  q = q.order(orderBy, { ascending: false });
  return q.limit(opts.limit ?? 100);
}

/** Requester-visible rows (RLS already limits to own; the filter makes the intent explicit). */
export function listOwnCancelRequests(uid: string, opts: ListCancelRequestsOpts = {}) {
  return applyCancelRequestFilters(requestTable(), { ...opts, requestedBy: uid });
}

/** Admin-visible rows (RLS allows all). */
export function listAllCancelRequests(opts: ListCancelRequestsOpts = {}) {
  return applyCancelRequestFilters(requestTable(), opts);
}

export function requestCancelPurchaseOrder(poId: string, reason: string) {
  return supabase.rpc('request_cancel_purchase_order', { p_po_id: poId, p_reason: reason });
}

export function approvePoCancelRequest(requestId: string) {
  return supabase.rpc('approve_po_cancel_request', { p_request_id: requestId });
}

export function rejectPoCancelRequest(requestId: string, reason: string) {
  return supabase.rpc('reject_po_cancel_request', { p_request_id: requestId, p_reason: reason });
}

export function oneRelation<T extends { id?: string }>(
  value: T | T[] | null | undefined
): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
