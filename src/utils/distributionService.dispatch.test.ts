import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('./supabase', () => ({
  supabase: {
    rpc,
    from: vi.fn(),
    auth: { getSession: vi.fn() },
  },
}));

vi.mock('./ledger', () => ({
  writeLedgerEntry: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./inventory', () => ({
  checkInventoryAvailability: vi.fn(),
  reserveInventory: vi.fn(),
  releaseReservation: vi.fn(),
}));

vi.mock('./errorHandling', () => ({
  retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import {
  cancelSupplyOrder,
  dispatchSupplyOrder,
  parseSupplyMutationRpc,
} from './distributionService';

describe('parseSupplyMutationRpc', () => {
  it('surfaces transport errors', () => {
    expect(parseSupplyMutationRpc(null, { message: 'boom' }, 'fallback')).toEqual({
      success: false,
      error: 'boom',
    });
  });

  it('surfaces soft-fail jsonb payloads with optional status', () => {
    expect(
      parseSupplyMutationRpc(
        { success: false, error: 'invalid_status', status: 'dispatched' },
        null,
        'fallback'
      )
    ).toEqual({
      success: false,
      error: 'invalid_status (status: dispatched)',
    });
  });

  it('treats missing success flag as ok when no transport error', () => {
    expect(parseSupplyMutationRpc({ success: true }, null, 'fallback')).toEqual({
      success: true,
    });
    expect(parseSupplyMutationRpc(null, null, 'fallback')).toEqual({ success: true });
  });
});

describe('dispatchSupplyOrder', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('calls atomic dispatch_supply_order RPC (no client fulfill loop)', async () => {
    rpc.mockResolvedValueOnce({ data: { success: true, dispatch_date: '2026-09-09' }, error: null });

    const result = await dispatchSupplyOrder('11111111-1111-1111-1111-111111111111');

    expect(result).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('dispatch_supply_order', {
      p_supply_order_id: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('returns RPC soft-fail errors', async () => {
    rpc.mockResolvedValueOnce({
      data: { success: false, error: 'invalid_status', status: 'received' },
      error: null,
    });

    const result = await dispatchSupplyOrder('11111111-1111-1111-1111-111111111111');
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid_status');
  });
});

describe('cancelSupplyOrder', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('calls atomic cancel_supply_order RPC with reason', async () => {
    rpc.mockResolvedValueOnce({ data: { success: true }, error: null });

    const result = await cancelSupplyOrder('11111111-1111-1111-1111-111111111111', 'ops mistake');

    expect(result).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledWith('cancel_supply_order', {
      p_supply_order_id: '11111111-1111-1111-1111-111111111111',
      p_reason: 'ops mistake',
    });
  });

  it('maps dispatched invalid_status to operator-facing message', async () => {
    rpc.mockResolvedValueOnce({
      data: { success: false, error: 'invalid_status', status: 'dispatched' },
      error: null,
    });

    const result = await cancelSupplyOrder('11111111-1111-1111-1111-111111111111', 'n/a');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Dispatched orders cannot be cancelled/i);
  });
});
