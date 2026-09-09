import { describe, expect, it } from 'vitest';
import {
  cancelPurchaseOrderErrorMessage,
  extractAtomicRpcErrorCode,
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
