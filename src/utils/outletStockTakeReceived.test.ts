import { describe, expect, it } from 'vitest';
import {
  filterSheetToReceiptIds,
  inventoryRowReceivedInMonth,
  isMissingRpcError,
  lockedReceiptMonth,
  receiptMonthBounds,
} from './outletStockTakeService';

describe('receiptMonthBounds', () => {
  it('covers the first through the last day of the month, including a leap day', () => {
    expect(receiptMonthBounds('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(receiptMonthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(receiptMonthBounds('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(receiptMonthBounds('2026-13')).toBeNull();
  });
});

describe('lockedReceiptMonth', () => {
  it('keeps a month stored on the session, and does not widen when that lookup is all the browser has', () => {
    expect(lockedReceiptMonth('2026-10', null)).toBe('2026-10');
    expect(lockedReceiptMonth('2026-10', '2026-11')).toBe('2026-10');
    expect(lockedReceiptMonth(null, '2026-10')).toBe('2026-10');
    expect(lockedReceiptMonth(undefined, '2026-10-04')).toBe('2026-10');
    expect(lockedReceiptMonth(null, null)).toBe('');
    expect(lockedReceiptMonth(undefined, null)).toBe('');
  });
});

describe('filterSheetToReceiptIds', () => {
  const lines = [{ outlet_inventory_id: 'a' }, { outlet_inventory_id: 'b' }];

  it('keeps every line only when there is no id list', () => {
    expect(filterSheetToReceiptIds(lines, null)).toEqual(lines);
    expect(filterSheetToReceiptIds(lines, undefined)).toEqual(lines);
  });

  it('drops every line when the month matched nothing', () => {
    expect(filterSheetToReceiptIds(lines, [])).toEqual([]);
    expect(filterSheetToReceiptIds(lines, ['b'])).toEqual([{ outlet_inventory_id: 'b' }]);
  });
});

describe('isMissingRpcError', () => {
  it('recognises a function the database has not installed', () => {
    expect(isMissingRpcError('Could not find the function public.begin_outlet_stock_take in the schema cache')).toBe(true);
    expect(isMissingRpcError('no_lines')).toBe(false);
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
