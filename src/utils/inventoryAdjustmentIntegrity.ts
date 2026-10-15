/**
 * Mirrors supabase/migrations/20261005110200_apply_inventory_adjustment_admin_only.sql.
 * Hub quantity changes go through apply_inventory_adjustment, which is
 * SECURITY DEFINER. Only admins may apply, and a deduction may not floor
 * on-hand to zero when the request exceeds what is there.
 */

export type InventoryAdjustmentStatus = 'pending' | 'approved' | 'rejected';
export type InventoryAdjustmentType = 'addition' | 'deduction';

export type ApplyInventoryAdjustmentBlock =
  | 'not_authenticated'
  | 'forbidden'
  | 'pending_requires_admin'
  | 'adjustment_not_found'
  | 'rejected_adjustment'
  | 'hub_inventory_not_found'
  | 'insufficient_on_hand'
  | 'on_hand_below_reserved';

export type ApplyInventoryAdjustmentDecision =
  | { success: true; alreadyApplied: boolean; quantityOnHand: number | null }
  | { success: false; error: ApplyInventoryAdjustmentBlock };

export function decideApplyInventoryAdjustment(opts: {
  callerAuthenticated: boolean;
  callerIsAdmin: boolean;
  adjustment: {
    status: InventoryAdjustmentStatus;
    applied: boolean;
    adjustmentType: InventoryAdjustmentType;
    adjustedQuantity: number;
  } | null;
  hub: { quantityOnHand: number; reservedQuantity: number } | null;
}): ApplyInventoryAdjustmentDecision {
  if (!opts.callerAuthenticated) {
    return { success: false, error: 'not_authenticated' };
  }
  if (!opts.callerIsAdmin) {
    return { success: false, error: 'forbidden' };
  }
  if (!opts.adjustment) {
    return { success: false, error: 'adjustment_not_found' };
  }
  if (opts.adjustment.applied) {
    return { success: true, alreadyApplied: true, quantityOnHand: null };
  }
  if (opts.adjustment.status === 'rejected') {
    return { success: false, error: 'rejected_adjustment' };
  }
  if (!opts.hub) {
    return { success: false, error: 'hub_inventory_not_found' };
  }

  const onHand = opts.hub.quantityOnHand;
  const reserved = opts.hub.reservedQuantity;
  const qty = opts.adjustment.adjustedQuantity;
  const next =
    opts.adjustment.adjustmentType === 'addition' ? onHand + qty : onHand - qty;

  if (next < 0) {
    return { success: false, error: 'insufficient_on_hand' };
  }
  if (next < reserved) {
    return { success: false, error: 'on_hand_below_reserved' };
  }
  return { success: true, alreadyApplied: false, quantityOnHand: next };
}

/**
 * Previous apply body: non-admins could apply a row they inserted as
 * 'approved', and deductions below zero were stored as zero.
 */
export function legacyApplyInventoryAdjustment(opts: {
  callerAuthenticated: boolean;
  callerIsAdmin: boolean;
  adjustment: {
    status: InventoryAdjustmentStatus;
    applied: boolean;
    adjustmentType: InventoryAdjustmentType;
    adjustedQuantity: number;
  } | null;
  hub: { quantityOnHand: number; reservedQuantity: number } | null;
}): ApplyInventoryAdjustmentDecision {
  if (!opts.callerAuthenticated) {
    return { success: false, error: 'not_authenticated' };
  }
  if (!opts.adjustment) {
    return { success: false, error: 'adjustment_not_found' };
  }
  if (opts.adjustment.applied) {
    return { success: true, alreadyApplied: true, quantityOnHand: null };
  }
  if (opts.adjustment.status === 'rejected') {
    return { success: false, error: 'rejected_adjustment' };
  }
  if (opts.adjustment.status === 'pending' && !opts.callerIsAdmin) {
    return { success: false, error: 'pending_requires_admin' };
  }
  if (!opts.hub) {
    return { success: false, error: 'hub_inventory_not_found' };
  }

  let next = opts.hub.quantityOnHand;
  if (opts.adjustment.adjustmentType === 'addition') {
    next += opts.adjustment.adjustedQuantity;
  } else {
    next -= opts.adjustment.adjustedQuantity;
    if (next < 0) next = 0;
  }
  if (next < opts.hub.reservedQuantity) {
    return { success: false, error: 'on_hand_below_reserved' };
  }
  return { success: true, alreadyApplied: false, quantityOnHand: next };
}

export function canInsertInventoryAdjustment(opts: {
  callerIsActiveStaff: boolean;
  callerIsAdmin: boolean;
  status: InventoryAdjustmentStatus;
}): boolean {
  if (!opts.callerIsActiveStaff) return false;
  if (opts.status === 'pending') return true;
  return opts.status === 'approved' && opts.callerIsAdmin;
}
