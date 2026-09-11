import { describe, expect, it } from 'vitest';
import {
  isHardSyncFailure,
  shouldAdvanceStorehubCursor,
  tallyProcessKind,
} from '../../supabase/functions/sync_storehub_sales/cursor.ts';

describe('isHardSyncFailure', () => {
  it('treats unmapped_sku and unmapped_store as hard', () => {
    expect(isHardSyncFailure('unmapped_sku')).toBe(true);
    expect(isHardSyncFailure('unmapped_store')).toBe(true);
  });

  it('treats insufficient_stock and other ingest errors as retryable', () => {
    expect(isHardSyncFailure('insufficient_stock')).toBe(false);
    expect(isHardSyncFailure('ingest_failed')).toBe(false);
    expect(isHardSyncFailure('')).toBe(false);
    expect(isHardSyncFailure(null)).toBe(false);
  });
});

describe('shouldAdvanceStorehubCursor', () => {
  it('advances when only hard/unmapped failures occurred', () => {
    expect(
      shouldAdvanceStorehubCursor({ failedRetryable: 0, runError: null }),
    ).toBe(true);
  });

  it('holds the cursor when any retryable failure remains', () => {
    expect(
      shouldAdvanceStorehubCursor({ failedRetryable: 1, runError: null }),
    ).toBe(false);
    expect(
      shouldAdvanceStorehubCursor({ failedRetryable: 12, runError: null }),
    ).toBe(false);
  });

  it('holds the cursor when the run itself errored', () => {
    expect(
      shouldAdvanceStorehubCursor({
        failedRetryable: 0,
        runError: 'boom',
      }),
    ).toBe(false);
  });
});

describe('tallyProcessKind', () => {
  it('splits failed vs failed_hard for cursor decision', () => {
    const counts = {
      sales_ingested: 0,
      cancelled: 0,
      returns_flagged: 0,
      failed: 0,
      failed_retryable: 0,
      failed_hard: 0,
    };
    tallyProcessKind('failed_hard', counts);
    tallyProcessKind('failed_hard', counts);
    tallyProcessKind('failed', counts);
    tallyProcessKind('ingested', counts);
    expect(counts).toEqual({
      sales_ingested: 1,
      cancelled: 0,
      returns_flagged: 0,
      failed: 3,
      failed_retryable: 1,
      failed_hard: 2,
    });
    expect(
      shouldAdvanceStorehubCursor({
        failedRetryable: counts.failed_retryable,
        runError: null,
      }),
    ).toBe(false);

    counts.failed_retryable = 0;
    expect(
      shouldAdvanceStorehubCursor({
        failedRetryable: counts.failed_retryable,
        runError: null,
      }),
    ).toBe(true);
  });
});
