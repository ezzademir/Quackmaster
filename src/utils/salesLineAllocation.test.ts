import { describe, expect, it } from 'vitest';
import { firstSalesOverAllocation } from './salesLineAllocation';

describe('firstSalesOverAllocation', () => {
  it('flags two SKU lines that together exceed the loaded lot pool', () => {
    const hit = firstSalesOverAllocation([
      {
        product_batch: 'QUACKTEOW',
        quantity_sold: 8,
        outlet_inventory_id: 'lot-a',
        available_qty: 10,
        lot_label: 'QUACKTEOW-260817-0001',
        recipe_sku: 'QUACKTEOW',
        inventory_product_batch: 'QUACKTEOW',
      },
      { product_batch: 'QUACKTEOW', quantity_sold: 8 },
    ]);
    expect(hit).toEqual({ identifier: 'QUACKTEOW', requested: 8, available: 2 });
  });

  it('flags two pinned lines on the same lot that exceed on-hand', () => {
    const hit = firstSalesOverAllocation([
      {
        product_batch: 'QUACKTEOW-260817-0001',
        quantity_sold: 8,
        outlet_inventory_id: 'lot-a',
        available_qty: 10,
        lot_label: 'QUACKTEOW-260817-0001',
        recipe_sku: 'QUACKTEOW',
        inventory_product_batch: 'QUACKTEOW',
      },
      {
        product_batch: 'QUACKTEOW-260817-0001',
        quantity_sold: 8,
        outlet_inventory_id: 'lot-a',
        available_qty: 10,
        lot_label: 'QUACKTEOW-260817-0001',
        recipe_sku: 'QUACKTEOW',
        inventory_product_batch: 'QUACKTEOW',
      },
    ]);
    expect(hit).toEqual({ identifier: 'QUACKTEOW-260817-0001', requested: 8, available: 2 });
  });

  it('allows a pin plus a SKU line that still fit the pool', () => {
    const hit = firstSalesOverAllocation([
      {
        product_batch: 'QUACKTEOW-260817-0001',
        quantity_sold: 4,
        outlet_inventory_id: 'lot-a',
        available_qty: 10,
        lot_label: 'QUACKTEOW-260817-0001',
        recipe_sku: 'QUACKTEOW',
        inventory_product_batch: 'QUACKTEOW',
      },
      { product_batch: 'QUACKTEOW', quantity_sold: 6 },
    ]);
    expect(hit).toBeNull();
  });

  it('matches leftover BATCH lots via recipe SKU', () => {
    const hit = firstSalesOverAllocation([
      {
        product_batch: 'QUACKTEOW-260812-0003',
        quantity_sold: 8,
        outlet_inventory_id: 'lot-leftover',
        available_qty: 10,
        lot_label: 'QUACKTEOW-260812-0003',
        recipe_sku: 'QUACKTEOW',
        inventory_product_batch: 'BATCH-e9a2296e',
      },
      { product_batch: 'QUACKTEOW', quantity_sold: 5 },
    ]);
    expect(hit).toEqual({ identifier: 'QUACKTEOW', requested: 5, available: 2 });
  });

  it('does not guess when unpinned lines have no loaded lots', () => {
    expect(
      firstSalesOverAllocation([
        { product_batch: 'QUACKTEOW', quantity_sold: 8 },
        { product_batch: 'QUACKTEOW', quantity_sold: 8 },
      ])
    ).toBeNull();
  });
});
