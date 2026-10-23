import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), auth: { getSession: vi.fn() } } }));
import { allocateHubProductItems, compareHubBatches, isBatchExpired, nestedRunNumber, runSequence } from './hubBatchPick';
import { malaysiaCalendarDate } from './dateRange';
import { allocateSkuCountToLots } from './outletStockTakeService';
import { expiredDispatchWarning } from './distributionService';

describe('hub batch ordering (b)', () => {
  it('orders by expiry, then run number ascending, then last_updated', () => {
    const rows = [
      { id: 'c', expiry_date: '2026-10-22', run_number: 'RUN-0113', last_updated: '2026-10-01' },
      { id: 'd', expiry_date: '2026-10-24', run_number: 'RUN-0114', last_updated: '2026-09-01' },
      { id: 'b', expiry_date: '2026-10-22', run_number: 'RUN-0112', last_updated: '2026-10-19' },
      { id: 'e', expiry_date: null, run_number: 'RUN-0001', last_updated: '2026-01-01' },
      { id: 'a', expiry_date: '2026-10-22', run_number: null, last_updated: '2026-01-01' },
    ];
    expect([...rows].sort(compareHubBatches).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('parses run sequences and nested run numbers', () => {
    expect(runSequence('RUN-0112')).toBe(112);
    expect(runSequence('RUN-10000')).toBe(10000);
    expect(runSequence(null)).toBeNull();
    expect(nestedRunNumber({ production_run: [{ run_number: 'RUN-0007' }] })).toBe('RUN-0007');
    expect(nestedRunNumber(null)).toBeNull();
  });
});

describe('creation-time preview (a)', () => {
  const today = '2026-10-19';
  const lots = [
    { id: 'h114', product_batch: 'KT', available: 566, expiry_date: '2026-10-24', run_number: 'RUN-0114', lot_label: 'KT-261017-0114' },
    { id: 'h113', product_batch: 'KT', available: 68, expiry_date: '2026-10-22', run_number: 'RUN-0113', lot_label: 'KT-261015-0113' },
    { id: 'h112', product_batch: 'KT', available: 48, expiry_date: '2026-10-22', run_number: 'RUN-0112', lot_label: 'KT-261015-0112' },
  ];

  it('splits across batches, tie on expiry broken by run number', () => {
    const out = allocateHubProductItems(lots, 150, today);
    expect(out?.map((l) => [l.hubInventoryId, l.quantity, l.expired])).toEqual([
      ['h112', 48, false],
      ['h113', 68, false],
      ['h114', 34, false],
    ]);
  });

  it('flags (does not skip) expired batches; expiry today is not expired', () => {
    const out = allocateHubProductItems(
      [
        { id: 'x', product_batch: 'KT', available: 10, expiry_date: '2026-10-18', run_number: 'RUN-0001' },
        { id: 'y', product_batch: 'KT', available: 10, expiry_date: '2026-10-19', run_number: 'RUN-0002' },
      ],
      15,
      today
    );
    expect(out?.map((l) => [l.hubInventoryId, l.expired])).toEqual([
      ['x', true],
      ['y', false],
    ]);
    expect(isBatchExpired('2026-10-18', today)).toBe(true);
    expect(isBatchExpired('2026-10-19', today)).toBe(false);
    expect(isBatchExpired(null, today)).toBe(false);
  });

  it('returns null on shortfall', () => {
    expect(allocateHubProductItems(lots, 10_000, today)).toBeNull();
  });
});

describe('Production date default (c): Malaysia calendar date', () => {
  it('00:00-08:00 MYT is already the next day while UTC is still the previous day', () => {
    const t = new Date('2026-10-01T16:29:00Z'); // 02 Oct 00:29 MYT (RUN-0108 entry time)
    expect(t.toISOString().split('T')[0]).toBe('2026-10-01'); // old default
    expect(malaysiaCalendarDate(t)).toBe('2026-10-02'); // new default
    expect(malaysiaCalendarDate(new Date('2026-10-02T00:00:00Z'))).toBe('2026-10-02'); // 08:00 MYT
    expect(malaysiaCalendarDate(new Date('2026-10-01T15:59:59Z'))).toBe('2026-10-01'); // 23:59 MYT
  });
});

describe('stock take SKU count allocation', () => {
  const lots = [
    { id: 'old', raw_material_id: null, product_batch: 'KT', quantity_on_hand: 150, reserved_quantity: 0, expiry_date: '2026-10-16', run_number: 'RUN-0110' },
    { id: 'new', raw_material_id: null, product_batch: 'KT', quantity_on_hand: 512, reserved_quantity: 0, expiry_date: '2026-10-22', run_number: 'RUN-0113' },
  ];

  it('fills the newest batch first, so the shortfall lands on the oldest (FIFO-consumed) batch', () => {
    expect(allocateSkuCountToLots(lots, 500)).toEqual([
      { outlet_inventory_id: 'old', counted_qty: 0 },
      { outlet_inventory_id: 'new', counted_qty: 500 },
    ]);
    expect(allocateSkuCountToLots(lots, 600)).toEqual([
      { outlet_inventory_id: 'old', counted_qty: 88 },
      { outlet_inventory_id: 'new', counted_qty: 512 },
    ]);
  });

  it('surplus over the system total lands on the newest batch', () => {
    expect(allocateSkuCountToLots(lots, 700)).toEqual([
      { outlet_inventory_id: 'old', counted_qty: 150 },
      { outlet_inventory_id: 'new', counted_qty: 550 },
    ]);
  });

  it('equal expiry: higher run number counts as newest', () => {
    const tie = [
      { ...lots[1], id: 'r113', run_number: 'RUN-0113' },
      { ...lots[1], id: 'r112', run_number: 'RUN-0112' },
    ];
    expect(allocateSkuCountToLots(tie, 600)).toEqual([
      { outlet_inventory_id: 'r112', counted_qty: 88 },
      { outlet_inventory_id: 'r113', counted_qty: 512 },
    ]);
  });
});

describe('dispatch expired warning', () => {
  it('builds a warning only when expired lines were shipped', () => {
    expect(expiredDispatchWarning({ success: true, expired_lines: 0 })).toBeUndefined();
    const w = expiredDispatchWarning({
      success: true,
      expired_lines: 1,
      expired_qty: 30,
      lines: [{ lot_label: 'KT-261001-0108', quantity: 30, expiry_date: '2026-10-08', expired: true }],
    });
    expect(w).toContain('KT-261001-0108');
    expect(w).toContain('30 units');
  });
});
