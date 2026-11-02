import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, eq, inFn, order, limit, select, from } = vi.hoisted(() => ({
  rpc: vi.fn(),
  eq: vi.fn(),
  inFn: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { rpc, from },
}));

import {
  approvePoCancelRequest,
  listAllCancelRequests,
  listOwnCancelRequests,
  oneRelation,
  rejectPoCancelRequest,
  requestCancelPurchaseOrder,
} from './poCancelRpc';

function chain() {
  const q = { select, eq, in: inFn, order, limit };
  select.mockReturnValue(q);
  eq.mockReturnValue(q);
  inFn.mockReturnValue(q);
  order.mockReturnValue(q);
  limit.mockResolvedValue({ data: [], error: null });
  from.mockReturnValue(q);
  return q;
}

beforeEach(() => {
  rpc.mockReset();
  eq.mockReset();
  inFn.mockReset();
  order.mockReset();
  limit.mockReset();
  select.mockReset();
  from.mockReset();
});

describe('RPC wrappers', () => {
  it('calls only the three 089 request/decide RPCs', async () => {
    rpc.mockResolvedValue({ data: { success: true }, error: null });
    await requestCancelPurchaseOrder('po-1', 'wrong qty');
    await approvePoCancelRequest('req-1');
    await rejectPoCancelRequest('req-1', 'keep it');
    expect(rpc.mock.calls).toEqual([
      ['request_cancel_purchase_order', { p_po_id: 'po-1', p_reason: 'wrong qty' }],
      ['approve_po_cancel_request', { p_request_id: 'req-1' }],
      ['reject_po_cancel_request', { p_request_id: 'req-1', p_reason: 'keep it' }],
    ]);
  });
});

describe('read queries', () => {
  it('lists own requests filtered by requester and optional status', async () => {
    chain();
    await listOwnCancelRequests('buyer-qt', { status: 'pending', purchaseOrderId: 'po-1' });
    expect(from).toHaveBeenCalledWith('po_cancel_requests');
    expect(eq).toHaveBeenCalledWith('requested_by', 'buyer-qt');
    expect(eq).toHaveBeenCalledWith('purchase_order_id', 'po-1');
    expect(eq).toHaveBeenCalledWith('status', 'pending');
    expect(order).toHaveBeenCalledWith('requested_at', { ascending: false });
  });

  it('lists all requests with a status filter and decided_at order', async () => {
    chain();
    await listAllCancelRequests({ status: ['approved', 'rejected'], limit: 20, orderBy: 'decided_at' });
    expect(from).toHaveBeenCalledWith('po_cancel_requests');
    expect(inFn).toHaveBeenCalledWith('status', ['approved', 'rejected']);
    expect(order).toHaveBeenCalledWith('decided_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(20);
    expect(eq.mock.calls.some((c) => c[0] === 'requested_by')).toBe(false);
  });
});

describe('oneRelation', () => {
  it('unwraps a PostgREST embed that may be an object or a one-row array', () => {
    expect(oneRelation({ id: 'a', full_name: 'Ada' })).toEqual({ id: 'a', full_name: 'Ada' });
    expect(oneRelation([{ id: 'a', full_name: 'Ada' }])).toEqual({ id: 'a', full_name: 'Ada' });
    expect(oneRelation([])).toBeNull();
    expect(oneRelation(null)).toBeNull();
  });
});

describe('source contract', () => {
  const files = import.meta.glob('../**/*.{ts,tsx}', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;

  const rpcNames = [
    'request_cancel_purchase_order',
    'approve_po_cancel_request',
    'reject_po_cancel_request',
  ];

  it('never writes po_cancel_requests from the client', () => {
    const write = /\.from\(\s*['"]po_cancel_requests['"]\s*\)[\s\S]{0,800}\.(insert|update|delete|upsert)\s*\(/;
    const hits: string[] = [];
    for (const [path, src] of Object.entries(files)) {
      if (write.test(src)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });

  it('calls the three RPCs only from poCancelRpc.ts (and tests)', () => {
    const hits: string[] = [];
    for (const [path, src] of Object.entries(files)) {
      const allowed = /poCancelRpc\.ts$/.test(path) || /\.test\.tsx?$/.test(path);
      if (allowed) continue;
      if (rpcNames.some((name) => src.includes(name))) hits.push(path);
    }
    expect(hits).toEqual([]);
  });

  it('does not invent a bill-reversal path in the 089 UI modules', () => {
    const forbidden = /void or reverse|reverse bill|void the bill|void\/reverse/i;
    const hits: string[] = [];
    for (const [path, src] of Object.entries(files)) {
      if (/\.test\.tsx?$/.test(path)) continue;
      if (!/poCancel|PoCancel|Procurement\.tsx$/.test(path)) continue;
      if (forbidden.test(src)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });
});
