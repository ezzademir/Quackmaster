/** Inclusive ISO date arithmetic (YYYY-MM-DD) using UTC calendar days. */
export function addIsoDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Default StoreHub sync window start when the caller does not pass `from`.
 *
 * Cron always writes last_success_to even when tickets fail (insufficient
 * stock, unmapped SKU). Without a lookbehind, the next day's first successful
 * run advances last_success_to, and yesterday's failed POS sales are never
 * fetched again — FIFO is never consumed after morning restock.
 */
export function autoSyncWindowFrom(
  lastSuccessTo: string | null | undefined,
  to: string,
): string {
  const last = lastSuccessTo?.trim() || "";
  let from = last || addIsoDays(to, -6);
  const retryFrom = addIsoDays(to, -1);
  if (from > retryFrom) from = retryFrom;
  return from;
}
