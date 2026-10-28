/**
 * Stock and cost math shared with the purchase-receipt and production posting rules.
 * Round half away from zero. Base quantity is rounded to the hub scale (4 decimal places).
 */

export function roundHalfAway(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  const factor = 10 ** decimals;
  const shifted = Math.abs(value) * factor;
  // Nudge past binary float error so 1.005 becomes 1.01, not 1.00.
  const rounded = Math.floor(shifted + 0.5 + 1e-8);
  return (sign * rounded) / factor;
}

/** Snapshotted ratio: quantity_ordered_base / quantity_ordered. Null when it cannot be used. */
export function purchaseRatio(quantityOrdered: number, quantityOrderedBase: number): number | null {
  if (!Number.isFinite(quantityOrdered) || quantityOrdered === 0) return null;
  const ratio = quantityOrderedBase / quantityOrdered;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return ratio;
}

/** Purchase quantity converted to stock units, rounded like hub quantity_on_hand (numeric 14,4). */
export function baseQuantity(purchaseQty: number, ratio: number): number {
  return roundHalfAway(purchaseQty * ratio, 4);
}

export function pricePerBase(unitPrice: number, ratio: number): number {
  if (!Number.isFinite(ratio) || ratio === 0) return unitPrice;
  return unitPrice / ratio;
}

/**
 * Moving average after a base-unit receipt change.
 * Increase: (stock × average + delta × price) / new stock.
 * Decrease: (stock × average − removed × price) / remaining, keeping the old average if that goes negative.
 * Removing the last units leaves the price per base unit.
 */
export function weightedAverage(input: {
  stockQty: number;
  average: number;
  deltaBase: number;
  pricePerBase: number;
}): number {
  const stockQty = input.stockQty;
  const average = input.average;
  const deltaBase = input.deltaBase;
  const price = input.pricePerBase;

  if (deltaBase > 0) {
    const next = stockQty + deltaBase;
    if (next <= 0) return average;
    if (stockQty <= 0) return price;
    return (stockQty * average + deltaBase * price) / next;
  }

  if (deltaBase < 0) {
    const remove = -deltaBase;
    const next = stockQty - remove;
    if (stockQty <= 0) return average;
    if (next <= 0) return price;
    const nextAvg = (average * stockQty - remove * price) / next;
    if (!Number.isFinite(nextAvg) || nextAvg < 0) return average;
    return nextAvg;
  }

  return average;
}
