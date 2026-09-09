import { describe, expect, it } from 'vitest';
import {
  legacyAsymmetricReceivedReverse,
  supplyDeleteReceivedReverseAmounts,
  voidBlockedIfHubNotIntact,
} from './voidDeleteIntegrity';

describe('voidBlockedIfHubNotIntact (PP-04 / PP-05)', () => {
  it('allows void when hub FG remains equal to original finished qty', () => {
    expect(
      voidBlockedIfHubNotIntact({
        hubPresent: true,
        hubQtyOnHand: 100,
        originalFinishedQty: 100,
      })
    ).toBeNull();
  });

  it('refuses void when hub FG row is missing (PP-05)', () => {
    expect(
      voidBlockedIfHubNotIntact({
        hubPresent: false,
        hubQtyOnHand: null,
        originalFinishedQty: 100,
      })
    ).toBe('hub_missing');
  });

  it('refuses void when hub FG was reduced below original output (PP-04)', () => {
    expect(
      voidBlockedIfHubNotIntact({
        hubPresent: true,
        hubQtyOnHand: 40,
        originalFinishedQty: 100,
      })
    ).toBe('hub_qty_mismatch');
  });

  it('refuses void when hub FG was increased above original output', () => {
    expect(
      voidBlockedIfHubNotIntact({
        hubPresent: true,
        hubQtyOnHand: 120,
        originalFinishedQty: 100,
      })
    ).toBe('hub_qty_mismatch');
  });
});

describe('supplyDeleteReceivedReverseAmounts (P0-3)', () => {
  it('reverses symmetrically when outlet has full line qty available', () => {
    expect(
      supplyDeleteReceivedReverseAmounts({
        outletQtyOnHand: 50,
        outletReserved: 0,
        lineQty: 50,
      })
    ).toEqual({ ok: true, outletDebit: 50, hubCredit: 50 });
  });

  it('refuses when outlet on-hand is below line qty (no hub inflation)', () => {
    expect(
      supplyDeleteReceivedReverseAmounts({
        outletQtyOnHand: 40,
        outletReserved: 0,
        lineQty: 100,
      })
    ).toEqual({ ok: false, reason: 'insufficient_outlet_on_hand' });
  });

  it('refuses when outlet available is below line qty due to reservations', () => {
    expect(
      supplyDeleteReceivedReverseAmounts({
        outletQtyOnHand: 100,
        outletReserved: 70,
        lineQty: 50,
      })
    ).toEqual({ ok: false, reason: 'insufficient_outlet_available' });
  });

  it('documents legacy GREATEST asymmetry that inflated hub', () => {
    const legacy = legacyAsymmetricReceivedReverse({ outletQtyOnHand: 40, lineQty: 100 });
    expect(legacy.outletDebit).toBe(40);
    expect(legacy.hubCredit).toBe(100);
    expect(legacy.hubInflation).toBe(60);

    const fixed = supplyDeleteReceivedReverseAmounts({
      outletQtyOnHand: 40,
      lineQty: 100,
    });
    expect(fixed.ok).toBe(false);
  });
});
