/**
 * Finished-goods batch ordering shared by the supply-order preview and the hub lot list.
 * Mirrors dispatch_supply_order (079): oldest expiry first, ties by production run number
 * ascending, then oldest last_updated. Batches with no expiry sort last.
 */

/** RUN-0112 -> 112. Null when there is no run number or no trailing digits. */
export function runSequence(runNumber: string | null | undefined): number | null {
  const m = /(\d+)$/.exec(String(runNumber ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export interface OrderableBatch {
  expiry_date?: string | null;
  run_number?: string | null;
  last_updated?: string | null;
}

export function compareHubBatches(a: OrderableBatch, b: OrderableBatch): number {
  const ae = a.expiry_date ? Date.parse(a.expiry_date) : Number.POSITIVE_INFINITY;
  const be = b.expiry_date ? Date.parse(b.expiry_date) : Number.POSITIVE_INFINITY;
  if (ae !== be) return ae - be;
  const ar = runSequence(a.run_number);
  const br = runSequence(b.run_number);
  if (ar !== br) {
    if (ar === null) return 1;
    if (br === null) return -1;
    return ar - br;
  }
  return (a.last_updated ?? '').localeCompare(b.last_updated ?? '');
}

/** Expired = expiry date strictly before today's Malaysia calendar date (YYYY-MM-DD strings). */
export function isBatchExpired(expiryDate: string | null | undefined, todayMyt: string): boolean {
  const e = (expiryDate ?? '').slice(0, 10);
  return e !== '' && e < todayMyt.slice(0, 10);
}

export interface PreviewBatch extends OrderableBatch {
  id: string;
  product_batch: string | null;
  available: number;
  lot_label?: string | null;
}

export interface PreviewLine {
  product_batch: string;
  hubInventoryId: string;
  quantity: number;
  lot_label?: string | null;
  expiry_date?: string | null;
  expired: boolean;
}

/**
 * Creation-time PREVIEW (and quantity hold) of which hub batches would ship.
 * The real pick happens again at dispatch; expired batches are included and flagged, not skipped.
 */
export function allocateHubProductItems(
  batches: PreviewBatch[],
  quantity: number,
  todayMyt: string
): PreviewLine[] | null {
  const sorted = [...batches].filter((b) => b.available > 0).sort(compareHubBatches);
  let remaining = quantity;
  const items: PreviewLine[] = [];
  for (const b of sorted) {
    const take = Math.min(remaining, b.available);
    if (take <= 0) continue;
    items.push({
      product_batch: b.product_batch ?? 'PRODUCT',
      hubInventoryId: b.id,
      quantity: take,
      lot_label: b.lot_label ?? null,
      expiry_date: b.expiry_date ?? null,
      expired: isBatchExpired(b.expiry_date, todayMyt),
    });
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-6) return null;
  return items.length > 0 ? items : null;
}

/** run_number via lot -> production_run (PostgREST embed, object or array). */
export function nestedRunNumber(lot: unknown): string | null {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Record<string, unknown> | null | undefined;
  const l = one(lot);
  const run = one(l?.production_run ?? l?.production_runs);
  const n = run?.run_number != null ? String(run.run_number).trim() : '';
  return n || null;
}
