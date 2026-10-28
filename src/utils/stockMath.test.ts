import { describe, expect, it } from 'vitest';
import { baseQuantity, pricePerBase, purchaseRatio, roundHalfAway, weightedAverage } from './stockMath';

describe('roundHalfAway', () => {
  it('rounds half away from zero to 2 decimal places', () => {
    expect(roundHalfAway(1.005, 2)).toBe(1.01);
    expect(roundHalfAway(1.004, 2)).toBe(1);
    expect(roundHalfAway(-1.005, 2)).toBe(-1.01);
  });
});

describe('purchase units', () => {
  it('uses the snapshotted ratio and converts to base units', () => {
    expect(purchaseRatio(2, 24)).toBe(12);
    expect(purchaseRatio(0, 0)).toBeNull();
    expect(baseQuantity(2, 12)).toBe(24);
    expect(baseQuantity(1, 1.23456)).toBe(1.2346);
    expect(pricePerBase(24, 12)).toBe(2);
  });
});

describe('weightedAverage', () => {
  it('blends an increase and unwinds a decrease at the receipt price', () => {
    const afterIncrease = weightedAverage({
      stockQty: 10,
      average: 2,
      deltaBase: 10,
      pricePerBase: 4,
    });
    expect(afterIncrease).toBe(3);

    const afterDecrease = weightedAverage({
      stockQty: 20,
      average: 3,
      deltaBase: -4,
      pricePerBase: 4,
    });
    expect(afterDecrease).toBe(2.75);
  });

  it('keeps the previous average when a decrease would go negative', () => {
    expect(
      weightedAverage({
        stockQty: 10,
        average: 2,
        deltaBase: -4,
        pricePerBase: 20,
      })
    ).toBe(2);
  });
});
