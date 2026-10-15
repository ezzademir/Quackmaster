import { describe, expect, it } from 'vitest';
import {
  canInsertInventoryAdjustment,
  decideApplyInventoryAdjustment,
  legacyApplyInventoryAdjustment,
} from './inventoryAdjustmentIntegrity';

const hub = { quantityOnHand: 10, reservedQuantity: 0 };

describe('decideApplyInventoryAdjustment', () => {
  it('blocks a non-admin who inserted an approved addition', () => {
    const decision = decideApplyInventoryAdjustment({
      callerAuthenticated: true,
      callerIsAdmin: false,
      adjustment: {
        status: 'approved',
        applied: false,
        adjustmentType: 'addition',
        adjustedQuantity: 10000,
      },
      hub,
    });
    expect(decision).toEqual({ success: false, error: 'forbidden' });
  });

  it('blocks a non-admin deduction that would wipe a hub lot', () => {
    const decision = decideApplyInventoryAdjustment({
      callerAuthenticated: true,
      callerIsAdmin: false,
      adjustment: {
        status: 'approved',
        applied: false,
        adjustmentType: 'deduction',
        adjustedQuantity: 10,
      },
      hub,
    });
    expect(decision).toEqual({ success: false, error: 'forbidden' });
  });

  it('lets an admin add stock', () => {
    expect(
      decideApplyInventoryAdjustment({
        callerAuthenticated: true,
        callerIsAdmin: true,
        adjustment: {
          status: 'pending',
          applied: false,
          adjustmentType: 'addition',
          adjustedQuantity: 4,
        },
        hub,
      })
    ).toEqual({ success: true, alreadyApplied: false, quantityOnHand: 14 });
  });

  it('refuses a deduction larger than on-hand instead of flooring to zero', () => {
    expect(
      decideApplyInventoryAdjustment({
        callerAuthenticated: true,
        callerIsAdmin: true,
        adjustment: {
          status: 'approved',
          applied: false,
          adjustmentType: 'deduction',
          adjustedQuantity: 100,
        },
        hub,
      })
    ).toEqual({ success: false, error: 'insufficient_on_hand' });
  });

  it('refuses a deduction that would fall below reserved quantity', () => {
    expect(
      decideApplyInventoryAdjustment({
        callerAuthenticated: true,
        callerIsAdmin: true,
        adjustment: {
          status: 'approved',
          applied: false,
          adjustmentType: 'deduction',
          adjustedQuantity: 9,
        },
        hub: { quantityOnHand: 10, reservedQuantity: 2 },
      })
    ).toEqual({ success: false, error: 'on_hand_below_reserved' });
  });

  it('does not apply twice', () => {
    expect(
      decideApplyInventoryAdjustment({
        callerAuthenticated: true,
        callerIsAdmin: true,
        adjustment: {
          status: 'approved',
          applied: true,
          adjustmentType: 'addition',
          adjustedQuantity: 5,
        },
        hub,
      })
    ).toEqual({ success: true, alreadyApplied: true, quantityOnHand: null });
  });
});

describe('legacyApplyInventoryAdjustment', () => {
  it('used to let a non-admin apply a self-approved addition', () => {
    expect(
      legacyApplyInventoryAdjustment({
        callerAuthenticated: true,
        callerIsAdmin: false,
        adjustment: {
          status: 'approved',
          applied: false,
          adjustmentType: 'addition',
          adjustedQuantity: 10000,
        },
        hub,
      })
    ).toEqual({ success: true, alreadyApplied: false, quantityOnHand: 10010 });
  });

  it('used to floor an over-deduction to zero and report success', () => {
    expect(
      legacyApplyInventoryAdjustment({
        callerAuthenticated: true,
        callerIsAdmin: true,
        adjustment: {
          status: 'approved',
          applied: false,
          adjustmentType: 'deduction',
          adjustedQuantity: 100,
        },
        hub,
      })
    ).toEqual({ success: true, alreadyApplied: false, quantityOnHand: 0 });
  });
});

describe('canInsertInventoryAdjustment', () => {
  it('lets staff open a pending adjustment and blocks a pre-approved one', () => {
    expect(
      canInsertInventoryAdjustment({
        callerIsActiveStaff: true,
        callerIsAdmin: false,
        status: 'pending',
      })
    ).toBe(true);
    expect(
      canInsertInventoryAdjustment({
        callerIsActiveStaff: true,
        callerIsAdmin: false,
        status: 'approved',
      })
    ).toBe(false);
  });

  it('lets an admin insert an approved adjustment', () => {
    expect(
      canInsertInventoryAdjustment({
        callerIsActiveStaff: true,
        callerIsAdmin: true,
        status: 'approved',
      })
    ).toBe(true);
  });

  it('blocks pending and supervisor accounts', () => {
    expect(
      canInsertInventoryAdjustment({
        callerIsActiveStaff: false,
        callerIsAdmin: false,
        status: 'pending',
      })
    ).toBe(false);
  });
});
