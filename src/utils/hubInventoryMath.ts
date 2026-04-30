/**
 * Shared hub finished-goods math so Overview, Distribution, and Inventory stay aligned.
 */

export function hubRowAvailableQuantity(
  quantityOnHand: number,
  reservedQuantity: number,
  availableQuantityFromDb: number | null | undefined
): number {
  if (availableQuantityFromDb != null && Number.isFinite(Number(availableQuantityFromDb))) {
    return Math.max(0, Number(availableQuantityFromDb));
  }
  return Math.max(0, Number(quantityOnHand ?? 0) - Number(reservedQuantity ?? 0));
}

export interface FinishedHubTotals {
  onHand: number;
  reserved: number;
  available: number;
}

/** Aggregate finished-goods hub rows (`raw_material_id` must be null — caller filters). */
export function aggregateFinishedGoodsHubTotals(
  rows: Array<{
    quantity_on_hand?: number | null;
    reserved_quantity?: number | null;
    available_quantity?: number | null;
  }>
): FinishedHubTotals {
  let onHand = 0;
  let reserved = 0;
  let available = 0;
  for (const row of rows) {
    const qoh = Number(row.quantity_on_hand ?? 0);
    const res = Number(row.reserved_quantity ?? 0);
    const avail = hubRowAvailableQuantity(qoh, res, row.available_quantity);
    onHand += qoh;
    reserved += res;
    available += avail;
  }
  return { onHand, reserved, available };
}
