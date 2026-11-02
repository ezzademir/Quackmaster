import { describe, expect, it } from 'vitest';
import { planReceipt, rpcLines, toleranceLimit } from './poReceipt';
import PROC from '../pages/Procurement.tsx?raw';

const line = (entered: string, extra: Partial<{ reason: string; previous: number }> = {}) => ({
  id: 'a', name: 'G', ordered: 315, previous: extra.previous ?? 0, entered, reason: extra.reason,
});

describe('planReceipt', () => {
  it('never clamps an over-receipt within tolerance', () => {
    const p = planReceipt([line('320')], { tolerancePct: 10, isAdmin: false });
    expect(p.ok && p.lines[0].qty).toBe(320);
    expect(p.ok && p.status).toBe('received');
    expect(p.ok && p.warnings[0]).toContain('5 more');
  });
  it('blocks beyond tolerance unless admin with reason', () => {
    expect(planReceipt([line('400')], { tolerancePct: 10, isAdmin: false }).ok).toBe(false);
    expect(planReceipt([line('400')], { tolerancePct: 10, isAdmin: true }).ok).toBe(false);
    const p = planReceipt([line('400', { reason: 'extra' })], { tolerancePct: 10, isAdmin: true });
    expect(p.ok && rpcLines(p)[0]).toEqual({ purchase_order_item_id: 'a', quantity_received: 400, reason: 'extra' });
  });
  it('warns on short and reports partial with delta from previous', () => {
    const p = planReceipt([line('313', { previous: 300 })], { tolerancePct: 10, isAdmin: false });
    expect(p.ok && p.status).toBe('partial');
    expect(p.ok && p.lines[0].delta).toBe(13);
    expect(p.ok && p.warnings[0]).toContain('2 less');
  });
  it('rejects negatives and all-zero', () => {
    expect(planReceipt([line('-1')], { tolerancePct: 10, isAdmin: false }).ok).toBe(false);
    expect(planReceipt([line('0')], { tolerancePct: 10, isAdmin: false }).ok).toBe(false);
  });
  it('keeps 4 decimals', () => {
    const p = planReceipt([line('314.3135')], { tolerancePct: 10, isAdmin: false });
    expect(p.ok && p.lines[0].qty).toBe(314.3135);
    expect(toleranceLimit(315, 10)).toBe(346.5);
  });
});

describe('Procurement page receive path', () => {
  it('has no silent clamp or max cap', () => {
    expect(PROC).not.toMatch(/Math\.min\(item\.quantity_ordered/);
    expect(PROC).not.toMatch(/max=\{item\.quantity_ordered\}/);
  });
  it('writes no page-side ledger row for receive / close short / adjust', () => {
    const start = PROC.indexOf('async function handleMarkReceived');
    const end = PROC.indexOf('async function changeStatus');
    expect(start).toBeGreaterThan(0);
    expect(PROC.slice(start, end)).not.toContain('writeLedgerEntry');
  });
});
