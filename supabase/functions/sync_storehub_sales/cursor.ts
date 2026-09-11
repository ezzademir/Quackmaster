/**
 * StoreHub sync cursor policy (Pack5 + #56 + never-stall stock).
 *
 * Permanent mapping gaps (unmapped_sku / unmapped_store) must not freeze
 * last_success_to — ops map them in Settings; replaying forever never helps.
 *
 * Stock/ops soft failures (insufficient_stock and similar) also must not
 * stall the cursor (Ezzad veto): sync must work regardless. Shortfalls are
 * posted by ingest_storehub_sale (negative ATP + needs_review) or logged as
 * failed sync_events — never by holding last_success_to.
 *
 * Only a run-level error (exception before/during the window) holds the cursor.
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

/**
 * Advance last_success_to whenever the run itself did not error.
 * Ticket-level failures (hard or retryable/stock) are ignored for cursor.
 * failedRetryable is accepted for call-site compat but intentionally unused.
 */
export function shouldAdvanceStorehubCursor(opts: {
  failedRetryable?: number;
  runError?: string | null;
}): boolean {
  return !opts.runError;
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
