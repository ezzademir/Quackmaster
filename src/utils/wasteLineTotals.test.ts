import { describe, expect, it } from 'vitest';
import { firstOverAllocatedInventory, sumRequestedQtyById } from './wasteLineTotals';

describe('sumRequestedQtyById', () => {
  it('adds quantities when two waste reasons target the same lot', () => {
    const totals = sumRequestedQtyById([
      { inventoryId: 'lot-a', quantity: 8 },
      { inventoryId: 'lot-b', quantity: 1 },
      { inventoryId: 'lot-a', quantity: 8 },
    ]);
    expect(totals.get('lot-a')).toBe(16);
    expect(totals.get('lot-b')).toBe(1);
  });

  it('ignores empty ids and non-positive qty', () => {
    const totals = sumRequestedQtyById([
      { inventoryId: '', quantity: 4 },
      { inventoryId: 'lot-a', quantity: 0 },
      { inventoryId: 'lot-a', quantity: 2 },
    ]);
    expect(totals.get('lot-a')).toBe(2);
    expect(totals.size).toBe(1);
  });
});

describe('firstOverAllocatedInventory', () => {
  it('flags when combined lines exceed on-hand', () => {
    const requested = sumRequestedQtyById([
      { inventoryId: 'lot-a', quantity: 8 },
      { inventoryId: 'lot-a', quantity: 8 },
    ]);
    const hit = firstOverAllocatedInventory(requested, new Map([['lot-a', 10]]));
    expect(hit).toEqual({ inventoryId: 'lot-a', requested: 16, available: 10 });
  });

  it('allows split reasons that still fit on-hand', () => {
    const requested = sumRequestedQtyById([
      { inventoryId: 'lot-a', quantity: 4 },
      { inventoryId: 'lot-a', quantity: 6 },
    ]);
    expect(firstOverAllocatedInventory(requested, new Map([['lot-a', 10]]))).toBeNull();
  });
});
