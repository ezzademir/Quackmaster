import { describe, expect, it } from 'vitest';

/**
 * Documents the pack4 minimal reference_id ledger invariants used by
 * release_inventory_reservation / fulfill_inventory_reservation.
 * (SQL is the source of truth; these assert the intended math.)
 */
function applyRelease(args: {
  hubReserved: number;
  ledgerQty: number;
  releaseQty: number;
}): { hubReserved: number; ledgerQty: number } | { error: string } {
  const { hubReserved, ledgerQty, releaseQty } = args;
  if (releaseQty <= 0) return { error: 'Release quantity must be positive' };
  if (ledgerQty < releaseQty) return { error: 'Cannot release more than reserved for this reference' };
  if (hubReserved < releaseQty) return { error: 'Hub reserved_quantity lower than reference reservation' };
  const nextLedger = ledgerQty - releaseQty;
  return {
    hubReserved: hubReserved - releaseQty,
    ledgerQty: nextLedger,
  };
}

describe('reservation reference_id release invariants', () => {
  it('releases only this reference share and leaves sibling reserved intact on hub', () => {
    // Order A reserved 5, order B reserved 3 → hub reserved 8
    const afterA = applyRelease({ hubReserved: 8, ledgerQty: 5, releaseQty: 5 });
    expect(afterA).toEqual({ hubReserved: 3, ledgerQty: 0 });
  });

  it('refuses cancel-after-partial-fulfill from stealing another order', () => {
    // After partial fulfill of A, A's ledger is 0 but hub reserved still has B's 3.
    // Blind GREATEST(0, reserved-5) would steal B; ledger gate blocks it.
    const steal = applyRelease({ hubReserved: 3, ledgerQty: 0, releaseQty: 5 });
    expect(steal).toEqual({ error: 'Cannot release more than reserved for this reference' });
  });

  it('refuses over-release against remaining ledger qty', () => {
    const over = applyRelease({ hubReserved: 10, ledgerQty: 2, releaseQty: 5 });
    expect(over).toEqual({ error: 'Cannot release more than reserved for this reference' });
  });
});
