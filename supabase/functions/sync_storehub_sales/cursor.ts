/**
 * StoreHub sync cursor policy (Pack5).
 *
 * Permanent mapping gaps (unmapped_sku / unmapped_store) must not freeze
 * last_success_to — ops map them in Settings; replaying forever never helps.
 * Retryable ingest failures (insufficient_stock and similar) still hold the
 * cursor so the same window is fetched again after restock.
 */

export const HARD_SYNC_FAILURES = new Set(["unmapped_sku", "unmapped_store"]);

export type SyncProcessKind =
  | "ingested"
  | "cancelled"
  | "return"
  | "failed"
  | "failed_hard"
  | "skipped";

export function isHardSyncFailure(error: string | null | undefined): boolean {
  return HARD_SYNC_FAILURES.has(String(error ?? "").trim());
}

/** Advance last_success_to only when no retryable ticket failures remain. */
export function shouldAdvanceStorehubCursor(opts: {
  failedRetryable: number;
  runError?: string | null;
}): boolean {
  return opts.failedRetryable === 0 && !opts.runError;
}

export function tallyProcessKind(
  kind: SyncProcessKind,
  counts: {
    sales_ingested: number;
    cancelled: number;
    returns_flagged: number;
    failed: number;
    failed_retryable: number;
    failed_hard: number;
  },
): void {
  if (kind === "ingested") counts.sales_ingested += 1;
  else if (kind === "cancelled") counts.cancelled += 1;
  else if (kind === "return") counts.returns_flagged += 1;
  else if (kind === "failed") {
    counts.failed += 1;
    counts.failed_retryable += 1;
  } else if (kind === "failed_hard") {
    counts.failed += 1;
    counts.failed_hard += 1;
  }
}
