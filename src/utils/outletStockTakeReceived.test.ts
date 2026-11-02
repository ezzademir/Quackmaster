import { describe, expect, it } from 'vitest';
import { inventoryRowReceivedInMonth, receiptMonthBounds } from './outletStockTakeService';

describe('receiptMonthBounds', () => {
  it('covers the first through the last day of the month', () => {
    expect(receiptMonthBounds('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(receiptMonthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('inventoryRowReceivedInMonth', () => {
  const receipts = new Set(['mov-1']);

  it('keeps every row when no month is chosen', () => {
    expect(inventoryRowReceivedInMonth('2026-01-01T00:00:00Z', 'x', '', receipts)).toBe(true);
  });

  it('matches a hub supply or transfer receipt anywhere in that month', () => {
    expect(inventoryRowReceivedInMonth('2020-01-01T00:00:00Z', 'mov-1', '2026-10', receipts)).toBe(true);
  });

  it('matches a line first created on any Malaysia day in the month', () => {
    // 2026-09-30 16:30Z is 2026-10-01 00:30 in Malaysia.
    expect(inventoryRowReceivedInMonth('2026-09-30T16:30:00.000Z', 'other', '2026-10', receipts)).toBe(true);
    // 2026-10-31 16:30Z is 2026-11-01 00:30 in Malaysia.
    expect(inventoryRowReceivedInMonth('2026-10-31T16:30:00.000Z', 'other', '2026-10', receipts)).toBe(false);
    expect(inventoryRowReceivedInMonth('2026-10-15T04:00:00.000Z', 'other', '2026-10', receipts)).toBe(true);
  });
});
