import { describe, expect, it } from 'vitest';
import {
  displayLotFirst,
  displaySkuSecond,
  draftRunFgCanBeRemoved,
  fgIdentifierMatches,
  formatFgLotLabel,
  formatLotWithSku,
  isLegacyBatchCode,
  skuForDisplay,
  voidBlockedIfSupplied,
  voidConfirmMatches,
} from './lotLabel';

describe('formatFgLotLabel (complete-run lots)', () => {
  it('builds SKU-YYMMDD-RUN from recipe SKU, production date, and run number', () => {
    expect(formatFgLotLabel('QUACKTEOW', '2026-08-12', 'RUN-0082')).toBe('QUACKTEOW-260812-0082');
  });

  it('zero-pads trailing run digits to four places', () => {
    expect(formatFgLotLabel('QUACKTEOW', '2026-08-12', 'RUN-7')).toBe('QUACKTEOW-260812-0007');
  });

  it('does not rewrite an existing four-digit run suffix', () => {
    expect(formatFgLotLabel('KT-01', '2026-01-02', 'RUN-0082')).toBe('KT-01-260102-0082');
  });
});

describe('fgIdentifierMatches (sales FIFO SKU-or-lot)', () => {
  it('matches the recipe SKU stored on the inventory row', () => {
    expect(fgIdentifierMatches('QUACKTEOW', 'QUACKTEOW-260812-0082', 'QUACKTEOW')).toBe(true);
  });

  it('matches the printable lot even when product_batch is a legacy BATCH- uuid', () => {
    expect(
      fgIdentifierMatches('BATCH-e9a2296e-aaaa-bbbb-cccc-ddddeeeeffff', 'QUACKTEOW-260812-0082', 'QUACKTEOW-260812-0082')
    ).toBe(true);
  });

  it('does not treat a SKU query as a match against a legacy BATCH- column alone', () => {
    expect(fgIdentifierMatches('BATCH-e9a2296e', 'QUACKTEOW-260812-0082', 'QUACKTEOW')).toBe(false);
  });

  it('matches recipe SKU when the inventory column is still a leftover BATCH- code', () => {
    expect(fgIdentifierMatches('BATCH-e9a2296e', 'QUACKTEOW-260812-0082', 'QUACKTEOW', 'QUACKTEOW')).toBe(true);
  });

  it('still matches the printable lot when recipe SKU is passed', () => {
    expect(
      fgIdentifierMatches('BATCH-e9a2296e', 'QUACKTEOW-260812-0082', 'QUACKTEOW-260812-0082', 'QUACKTEOW')
    ).toBe(true);
  });

  it('rejects empty queries', () => {
    expect(fgIdentifierMatches('QUACKTEOW', 'QUACKTEOW-260812-0082', '  ')).toBe(false);
  });
});

describe('lot-first display', () => {
  it('prefers the lot over a legacy BATCH- code', () => {
    expect(displayLotFirst('QUACKTEOW-260812-0082', 'BATCH-e9a2296e')).toBe('QUACKTEOW-260812-0082');
    expect(displaySkuSecond('QUACKTEOW-260812-0082', 'BATCH-e9a2296e')).toBeNull();
    expect(isLegacyBatchCode('BATCH-e9a2296e')).toBe(true);
  });

  it('shows SKU second when product_batch is the sellable SKU', () => {
    expect(displayLotFirst('QUACKTEOW-260812-0082', 'QUACKTEOW')).toBe('QUACKTEOW-260812-0082');
    expect(displaySkuSecond('QUACKTEOW-260812-0082', 'QUACKTEOW')).toBe('QUACKTEOW');
    expect(formatLotWithSku('QUACKTEOW-260812-0082', 'QUACKTEOW')).toBe('QUACKTEOW-260812-0082 · QUACKTEOW');
  });

  it('skuForDisplay never returns a BATCH- code', () => {
    expect(skuForDisplay('QUACKTEOW-260812-0082', 'BATCH-e9a2296e')).toBeNull();
    expect(skuForDisplay('QUACKTEOW-260812-0082', 'BATCH-e9a2296e', 'QUACKTEOW')).toBe('QUACKTEOW');
    expect(skuForDisplay(null, 'BATCH-e9a2296e', null)).toBeNull();
    expect(skuForDisplay(null, 'QUACKTEOW', null)).toBe('QUACKTEOW');
  });
});

describe('void-if-supplied', () => {
  it('allows void when the lot is still only at the hub with no reservations', () => {
    expect(
      voidBlockedIfSupplied({
        reservedQty: 0,
        outletQty: 0,
        supplyLineCount: 0,
        salesLineCount: 0,
        wasteLineCount: 0,
      })
    ).toBeNull();
  });

  it('blocks void once the lot was used on a supply order', () => {
    expect(
      voidBlockedIfSupplied({
        reservedQty: 0,
        outletQty: 0,
        supplyLineCount: 1,
        salesLineCount: 0,
        wasteLineCount: 0,
      })
    ).toBe('supply_order');
  });

  it('blocks void when outlet stock, sales, waste, or hub reservations exist', () => {
    expect(voidBlockedIfSupplied({ reservedQty: 2, outletQty: 0, supplyLineCount: 0, salesLineCount: 0, wasteLineCount: 0 })).toBe(
      'reserved'
    );
    expect(voidBlockedIfSupplied({ reservedQty: 0, outletQty: 4, supplyLineCount: 0, salesLineCount: 0, wasteLineCount: 0 })).toBe(
      'outlet_stock'
    );
    expect(voidBlockedIfSupplied({ reservedQty: 0, outletQty: 0, supplyLineCount: 0, salesLineCount: 1, wasteLineCount: 0 })).toBe(
      'sales'
    );
    expect(voidBlockedIfSupplied({ reservedQty: 0, outletQty: 0, supplyLineCount: 0, salesLineCount: 0, wasteLineCount: 1 })).toBe(
      'waste'
    );
  });

  it('allows scrubbing draft FG that is still only at hub with no reservation', () => {
    expect(draftRunFgCanBeRemoved({ reservedQty: 0, outletQty: 0 })).toBe(true);
    expect(draftRunFgCanBeRemoved({ reservedQty: 1, outletQty: 0 })).toBe(false);
    expect(draftRunFgCanBeRemoved({ reservedQty: 0, outletQty: 2 })).toBe(false);
  });

  it('accepts typed run number or lot code', () => {
    expect(voidConfirmMatches('RUN-0082', 'RUN-0082', 'QUACKTEOW-260812-0082')).toBe(true);
    expect(voidConfirmMatches('quackteow-260812-0082', 'RUN-0082', 'QUACKTEOW-260812-0082')).toBe(true);
    expect(voidConfirmMatches('nope', 'RUN-0082', 'QUACKTEOW-260812-0082')).toBe(false);
  });
});
