/**
 * Sales journal line helpers: pin deductions to an outlet_inventory row
 * unless the typed lot/SKU identifier changed.
 */

export type SalesLineIdentifier = {
  product_batch: string;
  quantity_sold: number;
  outlet_inventory_id?: string;
};

/** Payload for post_sales_journal / replace_sales_journal. */
export function toPostableSalesLine(line: {
  product_batch: string;
  quantity_sold: number;
  outlet_inventory_id?: string | null;
}): SalesLineIdentifier {
  const product_batch = line.product_batch.trim();
  const id = (line.outlet_inventory_id ?? '').trim();
  if (id) {
    return { product_batch, quantity_sold: line.quantity_sold, outlet_inventory_id: id };
  }
  return { product_batch, quantity_sold: line.quantity_sold };
}

/**
 * Keep outlet_inventory_id only while the typed identifier is unchanged.
 * Editing lot/SKU must not keep deducting the previously loaded row.
 */
export function applyLotIdentifierEdit<T extends { product_batch: string; outlet_inventory_id?: string }>(
  row: T,
  nextIdentifier: string
): T {
  const prev = (row.product_batch ?? '').trim();
  const nextTrim = nextIdentifier.trim();
  if (nextTrim === prev) {
    return { ...row, product_batch: nextIdentifier };
  }
  return { ...row, product_batch: nextIdentifier, outlet_inventory_id: undefined };
}
