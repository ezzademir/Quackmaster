import { describe, expect, it } from 'vitest';
import { filterByStockView, rowHasStock } from './stockView';

describe('rowHasStock', () => {
  it('keeps on-hand greater than zero', () => {
    expect(rowHasStock(1)).toBe(true);
    expect(rowHasStock(0.5)).toBe(true);
  });

  it('drops zeros and non-numeric values', () => {
    expect(rowHasStock(0)).toBe(false);
    expect(rowHasStock(-1)).toBe(false);
    expect(rowHasStock(null)).toBe(false);
    expect(rowHasStock(undefined)).toBe(false);
  });
});

describe('filterByStockView', () => {
  const rows = [
    { id: 'zero', quantity_on_hand: 0, reserved_quantity: 0 },
    { id: 'stock', quantity_on_hand: 12, reserved_quantity: 0 },
    { id: 'reserved', quantity_on_hand: 8, reserved_quantity: 8 },
  ];

  it('drops zeros in in_stock and keeps reserved lots that still have on-hand', () => {
    const visible = filterByStockView(rows, 'in_stock', (r) => r.quantity_on_hand);
    expect(visible.map((r) => r.id)).toEqual(['stock', 'reserved']);
  });

  it('keeps zeros in all', () => {
    const visible = filterByStockView(rows, 'all', (r) => r.quantity_on_hand);
    expect(visible.map((r) => r.id)).toEqual(['zero', 'stock', 'reserved']);
  });
});
