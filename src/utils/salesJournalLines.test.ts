import { describe, expect, it } from 'vitest';
import { applyLotIdentifierEdit, toPostableSalesLine } from './salesJournalLines';

describe('toPostableSalesLine', () => {
  it('keeps outlet_inventory_id so replace/post deducts the same lot row', () => {
    expect(
      toPostableSalesLine({
        product_batch: 'QUACKTEOW',
        quantity_sold: 6,
        outlet_inventory_id: 'oi-new-lot',
      })
    ).toEqual({
      product_batch: 'QUACKTEOW',
      quantity_sold: 6,
      outlet_inventory_id: 'oi-new-lot',
    });
  });

  it('omits blank ids so the RPC FEFO-matches by lot/SKU', () => {
    expect(
      toPostableSalesLine({
        product_batch: ' QUACKTEOW-260814-0082 ',
        quantity_sold: 2,
        outlet_inventory_id: '  ',
      })
    ).toEqual({
      product_batch: 'QUACKTEOW-260814-0082',
      quantity_sold: 2,
    });
  });
});

describe('applyLotIdentifierEdit', () => {
  const loaded = {
    product_batch: 'QUACKTEOW-260814-0082',
    quantity_sold: 5,
    outlet_inventory_id: 'oi-new-lot',
  };

  it('keeps the row pin when only qty will change (identifier untouched)', () => {
    expect(applyLotIdentifierEdit(loaded, 'QUACKTEOW-260814-0082').outlet_inventory_id).toBe(
      'oi-new-lot'
    );
  });

  it('drops the row pin when the typed lot/SKU changes', () => {
    const edited = applyLotIdentifierEdit(loaded, 'QUACKTEOW');
    expect(edited.product_batch).toBe('QUACKTEOW');
    expect(edited.outlet_inventory_id).toBeUndefined();
  });
});
