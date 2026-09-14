import { describe, expect, it } from 'vitest';
import { posVsQmerpSoldStatus, qtyEq } from '../../supabase/functions/sync_storehub_sales/posQmerpStatus.ts';

describe('qtyEq', () => {
  it('treats near-equal quantities as equal', () => {
    expect(qtyEq(50, 50)).toBe(true);
    expect(qtyEq(50, 50.00005)).toBe(true);
    expect(qtyEq(50, 49.5)).toBe(false);
    expect(qtyEq(null, 0)).toBe(false);
  });
});

describe('posVsQmerpSoldStatus', () => {
  it('treats keyed manuals as a match when StoreHub ingest sold is zero', () => {
    const posQty = 50;
    const storehubSold = 0;
    const manualSold = 50;
    const allSold = storehubSold + manualSold;
    expect(posVsQmerpSoldStatus(posQty, allSold)).toBe('match');
    expect(posVsQmerpSoldStatus(posQty, storehubSold)).toBe('missing_in_dashboard');
  });

  it('flags true missing POS tickets when nothing is posted in QMERP', () => {
    expect(posVsQmerpSoldStatus(12, 0)).toBe('missing_in_dashboard');
  });

  it('flags a qty mismatch when manuals under- or over-key POS', () => {
    expect(posVsQmerpSoldStatus(50, 40)).toBe('qty_mismatch');
    expect(posVsQmerpSoldStatus(50, 100)).toBe('qty_mismatch');
  });

  it('flags extra QMERP sold with no POS tickets', () => {
    expect(posVsQmerpSoldStatus(0, 8)).toBe('extra_in_dashboard');
  });
});
