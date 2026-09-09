/** Sum waste quantities that target the same hub/outlet inventory row. */

export function sumRequestedQtyById(
  lines: Array<{ inventoryId: string; quantity: number }>
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const id = line.inventoryId.trim();
    if (!id || !Number.isFinite(line.quantity) || line.quantity <= 0) continue;
    totals.set(id, (totals.get(id) ?? 0) + line.quantity);
  }
  return totals;
}

export function firstOverAllocatedInventory(
  requested: Map<string, number>,
  availableById: Map<string, number>
): { inventoryId: string; requested: number; available: number } | null {
  for (const [inventoryId, qty] of requested) {
    const available = availableById.get(inventoryId);
    if (available == null) continue;
    if (qty > available) {
      return { inventoryId, requested: qty, available };
    }
  }
  return null;
}
