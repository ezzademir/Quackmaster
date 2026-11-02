import { describe, expect, it } from 'vitest';
import { inventoryRowReceivedOn } from './outletStockTakeService';

describe('inventoryRowReceivedOn', () => {
  const receipts = new Set(['mov-1']);

  it('keeps every row when no receipt day is chosen', () => {
    expect(inventoryRowReceivedOn('2026-01-01T00:00:00Z', 'x', '', receipts)).toBe(true);
  });

  it('matches a hub supply or transfer receipt on that business date', () => {
    expect(inventoryRowReceivedOn('2020-01-01T00:00:00Z', 'mov-1', '2026-05-05', receipts)).toBe(true);
  });

  it('matches the Malaysia calendar day the outlet line was first created', () => {
    // 2026-05-04 16:30Z is 2026-05-05 00:30 in Malaysia.
    expect(inventoryRowReceivedOn('2026-05-04T16:30:00.000Z', 'other', '2026-05-05', receipts)).toBe(true);
    expect(inventoryRowReceivedOn('2026-05-04T15:30:00.000Z', 'other', '2026-05-05', receipts)).toBe(false);
  });
});
