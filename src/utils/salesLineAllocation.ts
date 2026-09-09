import { fgIdentifierMatches } from './lotLabel';

/** One sales journal line as the Record-sale form sends it to the RPC. */
export interface SalesAllocLine {
  product_batch: string;
  quantity_sold: number;
  outlet_inventory_id?: string;
  available_qty?: number;
  lot_label?: string | null;
  /** Recipe SKU via lot → run → recipe; used to match leftover BATCH lots. */
  recipe_sku?: string | null;
  /** Hub/outlet `product_batch` column when the line was loaded from inventory. */
  inventory_product_batch?: string | null;
}

export interface SalesOverAllocation {
  identifier: string;
  requested: number;
  available: number;
}

function lineIdentifier(line: SalesAllocLine): string {
  return line.product_batch.trim();
}

function matchingLotIds(
  query: string,
  remaining: Map<string, number>,
  meta: Map<string, { lot_label: string | null; product_batch: string; recipe_sku: string | null }>
): string[] {
  const ids: string[] = [];
  for (const id of remaining.keys()) {
    const m = meta.get(id);
    if (!m) continue;
    if (fgIdentifierMatches(m.product_batch, m.lot_label, query, m.recipe_sku)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Walk lines in post order and subtract from known on-hand, matching
 * `post_sales_journal` (pinned row first, else FEFO across matching lots).
 *
 * Lines without an available hint are skipped (server still enforces).
 */
export function firstSalesOverAllocation(lines: SalesAllocLine[]): SalesOverAllocation | null {
  const remaining = new Map<string, number>();
  const meta = new Map<
    string,
    { lot_label: string | null; product_batch: string; recipe_sku: string | null }
  >();

  for (const line of lines) {
    const id = line.outlet_inventory_id?.trim();
    if (!id) continue;
    if (remaining.has(id)) continue;
    if (line.available_qty == null || !Number.isFinite(line.available_qty)) continue;
    remaining.set(id, line.available_qty);
    meta.set(id, {
      lot_label: line.lot_label ?? null,
      product_batch: (line.inventory_product_batch ?? line.product_batch).trim(),
      recipe_sku: line.recipe_sku ?? null,
    });
  }

  for (const line of lines) {
    const qty = Number(line.quantity_sold);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const identifier = lineIdentifier(line);
    if (!identifier) continue;
    const id = line.outlet_inventory_id?.trim();

    if (id) {
      if (!remaining.has(id)) continue;
      const left = remaining.get(id) ?? 0;
      if (qty > left) {
        return { identifier, requested: qty, available: left };
      }
      remaining.set(id, left - qty);
      continue;
    }

    const matching = matchingLotIds(identifier, remaining, meta);
    if (matching.length === 0) continue;

    const pool = matching.reduce((sum, lotId) => sum + Math.max(remaining.get(lotId) ?? 0, 0), 0);
    if (qty > pool) {
      return { identifier, requested: qty, available: pool };
    }

    let need = qty;
    for (const lotId of matching) {
      if (need <= 0) break;
      const left = Math.max(remaining.get(lotId) ?? 0, 0);
      const take = Math.min(left, need);
      remaining.set(lotId, left - take);
      need -= take;
    }
  }

  return null;
}
