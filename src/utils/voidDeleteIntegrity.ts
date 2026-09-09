/**
 * Pack 3 void/delete integrity helpers (audit PP-04/PP-05 + inventory P0-3).
 * Mirrors supabase/migrations/20260909120000_062_pack3_void_delete_integrity.sql.
 */

export type VoidHubIntegrityBlock = 'hub_missing' | 'hub_qty_mismatch';

/**
 * PP-04 / PP-05: void is only safe when the hub FG row still exists and its
 * on-hand quantity equals the run's original finished output (actual_output).
 * Otherwise refuse — never restore full RM against a partial/missing FG lot.
 */
export function voidBlockedIfHubNotIntact(opts: {
  hubPresent: boolean;
  hubQtyOnHand: number | null | undefined;
  originalFinishedQty: number | null | undefined;
}): VoidHubIntegrityBlock | null {
  if (!opts.hubPresent) return 'hub_missing';
  const hub = Number(opts.hubQtyOnHand ?? 0);
  const original = Number(opts.originalFinishedQty ?? 0);
  if (!Number.isFinite(hub) || !Number.isFinite(original) || hub !== original) {
    return 'hub_qty_mismatch';
  }
  return null;
}

export type SupplyDeleteReceivedBlock =
  | 'insufficient_outlet_on_hand'
  | 'insufficient_outlet_available';

export type SupplyDeleteReceivedReverse =
  | { ok: true; outletDebit: number; hubCredit: number }
  | { ok: false; reason: SupplyDeleteReceivedBlock };

/**
 * P0-3: received admin-delete must reverse outlet↔hub by the same amount.
 * Refuse when outlet cannot absorb the full line qty (no GREATEST floor + full hub restore).
 */
export function supplyDeleteReceivedReverseAmounts(opts: {
  outletQtyOnHand: number;
  outletReserved?: number;
  lineQty: number;
}): SupplyDeleteReceivedReverse {
  const onHand = Number(opts.outletQtyOnHand ?? 0);
  const reserved = Number(opts.outletReserved ?? 0);
  const line = Number(opts.lineQty ?? 0);

  if (!(line > 0) || !Number.isFinite(line)) {
    return { ok: false, reason: 'insufficient_outlet_on_hand' };
  }
  if (!(onHand >= line)) {
    return { ok: false, reason: 'insufficient_outlet_on_hand' };
  }
  if (!(onHand - reserved >= line)) {
    return { ok: false, reason: 'insufficient_outlet_available' };
  }
  return { ok: true, outletDebit: line, hubCredit: line };
}

/**
 * Legacy asymmetric behaviour (pre-062): outlet floored with GREATEST(0, qoh-qty)
 * while hub always got +full line qty → system-wide unit inflation.
 */
export function legacyAsymmetricReceivedReverse(opts: {
  outletQtyOnHand: number;
  lineQty: number;
}): { outletDebit: number; hubCredit: number; hubInflation: number } {
  const onHand = Math.max(0, Number(opts.outletQtyOnHand ?? 0));
  const line = Number(opts.lineQty ?? 0);
  const newOutlet = Math.max(0, onHand - line);
  const outletDebit = onHand - newOutlet;
  const hubCredit = line;
  return {
    outletDebit,
    hubCredit,
    hubInflation: Math.max(0, hubCredit - outletDebit),
  };
}
