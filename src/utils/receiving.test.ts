import { describe, expect, it } from 'vitest';
import { buildDeliveryLines, cumulativeReceived, receivingErrorMessage } from './receiving';

describe('receiving cumulative totals', () => {
  it('adds the typed delivery to what is already received (4 more on 5 -> 9)', () => {
    expect(cumulativeReceived(5, 4)).toBe(9);
    expect(cumulativeReceived(null, 4)).toBe(4);
    expect(cumulativeReceived(5.1, 0.2)).toBe(5.3);
    expect(cumulativeReceived(0.0001, 0.0002)).toBe(0.0003);
  });

  it('builds record_po_delivery lines with cumulative totals, the stale-guard value and optional price', () => {
    const items = [
      { id: 'a', quantity_received: 5 },
      { id: 'b', quantity_received: null },
      { id: 'c', quantity_received: 2 },
      { id: 'd', quantity_received: 1 },
    ];
    const lines = buildDeliveryLines(items, {
      a: { qty: '4', price: '10.5' },
      b: { qty: '3', price: '' },
      c: { qty: '0' },
      d: { qty: 'abc', price: '1' },
    });
    expect(lines).toEqual([
      { purchase_order_item_id: 'a', quantity_received: 9, expected_previous_received: 5, invoice_unit_price: 10.5 },
      { purchase_order_item_id: 'b', quantity_received: 3, expected_previous_received: 0 },
    ]);
  });

  it('drops a non-numeric or negative price instead of sending NaN / null', () => {
    const [l] = buildDeliveryLines([{ id: 'a', quantity_received: 0 }], { a: { qty: '1', price: 'x' } });
    expect('invoice_unit_price' in l).toBe(false);
    const [m] = buildDeliveryLines([{ id: 'a', quantity_received: 0 }], { a: { qty: '1', price: '-2' } });
    expect('invoice_unit_price' in m).toBe(false);
  });

  it('maps server errors to readable messages', () => {
    expect(receivingErrorMessage({ error: 'cannot_reduce_received', current_received: 5 }, 'x')).toMatch(/already 5/);
    expect(receivingErrorMessage({ error: 'stale_received_quantity' }, 'x')).toMatch(/reloaded/);
    expect(receivingErrorMessage(null, 'Receipt failed')).toBe('Receipt failed');
  });
});
