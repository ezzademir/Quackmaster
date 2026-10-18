import { describe, expect, it } from 'vitest';
import {
  cancelPurchaseOrderErrorMessage,
  extractAtomicRpcErrorCode,
  outletTransferErrorMessage,
  salesJournalErrorMessage,
} from './atomicRpcErrors';

describe('extractAtomicRpcErrorCode', () => {
  it('prefers soft-return error codes', () => {
    expect(extractAtomicRpcErrorCode('hub_below_reserved', 'something else')).toBe('hub_below_reserved');
  });

  it('extracts RAISE EXCEPTION codes from PostgREST messages', () => {
    expect(extractAtomicRpcErrorCode(null, 'insufficient_hub_quantity')).toBe('insufficient_hub_quantity');
    expect(extractAtomicRpcErrorCode(undefined, 'ERROR: insufficient_raw_material')).toBe(
      'insufficient_raw_material'
    );
    expect(extractAtomicRpcErrorCode(null, 'hub_inventory_missing')).toBe('hub_inventory_missing');
  });

  it('falls back to the raw message when no known code matches', () => {
    expect(extractAtomicRpcErrorCode(null, 'totally_new_failure')).toBe('totally_new_failure');
  });
});

describe('cancelPurchaseOrderErrorMessage', () => {
  it('maps insufficient hub quantity to an operator-facing sentence', () => {
    expect(cancelPurchaseOrderErrorMessage('insufficient_hub_quantity')).toMatch(/hub no longer holds/i);
  });

  it('includes unknown codes in the fallback', () => {
    expect(cancelPurchaseOrderErrorMessage('weird')).toContain('weird');
  });
});

describe('salesJournalErrorMessage', () => {
  it('maps mid-post RAISE codes', () => {
    expect(salesJournalErrorMessage('fifo_alloc_internal_error')).toMatch(/allocated/i);
    expect(salesJournalErrorMessage('outlet_inventory_row_missing_mid_post')).toMatch(/inventory/i);
  });

  it('maps failed replace so the original posted journal is described as unchanged', () => {
    expect(salesJournalErrorMessage('replace_sales_journal_repost_failed')).toMatch(/unchanged/i);
    expect(salesJournalErrorMessage('insufficient_stock')).toMatch(/not enough/i);
  });
});

describe('outletTransferErrorMessage', () => {
  it('maps pending-blocked auth', () => {
    expect(outletTransferErrorMessage('not_authenticated_or_inactive')).toMatch(/active staff/i);
  });
});
