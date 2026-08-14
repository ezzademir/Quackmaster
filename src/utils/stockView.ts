export type StockView = 'in_stock' | 'all';

/** On-hand > 0. Reserved lots still show because reserved is part of on-hand. */
export function rowHasStock(quantityOnHand: number | null | undefined): boolean {
  return Number(quantityOnHand ?? 0) > 0;
}

export function filterByStockView<T>(
  rows: T[],
  view: StockView,
  quantityOnHand: (row: T) => number | null | undefined
): T[] {
  if (view === 'all') return rows;
  return rows.filter((row) => rowHasStock(quantityOnHand(row)));
}
