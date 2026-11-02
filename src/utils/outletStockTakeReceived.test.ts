import { describe, expect, it } from 'vitest';
import { buildOutletStockTakeCsv, inventoryRowReceivedOn } from './outletStockTakeService';

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

describe('buildOutletStockTakeCsv variance', () => {
  const session = {
    id: 's',
    count_date: '2026-05-05',
    notes: null,
    posted_at: 't',
    outlet: { id: 'o', name: 'A' },
  };
  const lines = [
    {
      outlet_inventory_id: 'i',
      product_batch: 'b',
      lot_label: 'l',
      system_qoh_before: 10,
      counted_qty: 8,
      variance: -2,
      line_remark: null,
    },
  ];

  it('includes the variance column for admins', () => {
    const csv = buildOutletStockTakeCsv(session, lines, { includeVariance: true });
    expect(csv.split('\n')[0].split(',')).toContain('variance');
    expect(csv).toContain('-2');
  });

  it('omits the variance column for staff and supervisors', () => {
    const csv = buildOutletStockTakeCsv(session, lines, { includeVariance: false });
    expect(csv.split('\n')[0].split(',')).not.toContain('variance');
    expect(csv).not.toContain('-2');
    expect(csv).toContain('10');
    expect(csv).toContain('8');
  });
});
