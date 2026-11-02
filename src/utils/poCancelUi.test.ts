import { describe, expect, it } from 'vitest';
import {
  CANCEL_REASON_MAX,
  cancelFailureText,
  entityChip,
  formatMytDateTime,
  latestRequestByPo,
  normaliseCancelFailure,
  parseBillNumbers,
  poCancelActions,
  poUsesCancelRpc,
  validateCancelReason,
  type PoCancelRequestRow,
} from './poCancelUi';

const PO_RECEIVED = {
  status: 'received',
  items: [{ quantity_received: 4 }],
};

const PO_PARTIAL = {
  status: 'partial',
  items: [{ quantity_received: 2 }],
};

const PO_DRAFT = {
  status: 'draft',
  items: [{ quantity_received: 0 }],
};

const PO_ORDERED_EMPTY = {
  status: 'ordered',
  items: [{ quantity_received: 0 }],
};

const PO_BILLED = {
  status: 'received',
  items: [{ quantity_received: 10 }],
};

function req(partial: Partial<PoCancelRequestRow> & Pick<PoCancelRequestRow, 'id' | 'status'>): PoCancelRequestRow {
  return {
    purchase_order_id: 'po-1',
    requested_by: 'buyer-qt',
    requested_at: '2026-10-20T02:00:00.000Z',
    reason: 'wrong qty',
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    ...partial,
  };
}

describe('cancelFailureText', () => {
  it('maps every 089 cancel-request code to plain text', () => {
    expect(cancelFailureText('pending_request_exists')).toBe(
      'A cancellation request is already pending on this order.'
    );
    expect(cancelFailureText('bills_on_po')).toMatch(/supplier bill/);
    expect(cancelFailureText('bills_on_po')).not.toMatch(/void/i);
    expect(cancelFailureText('not_authorized')).toMatch(/MH \/ QT/);
    expect(cancelFailureText('forbidden')).toMatch(/not allowed/i);
    expect(cancelFailureText('already_cancelled')).toMatch(/already cancelled/);
    expect(cancelFailureText('po_not_found')).toMatch(/no longer exists/);
    expect(cancelFailureText('reason_required')).toBe('A reason is required');
    expect(cancelFailureText('reason_too_long')).toBe('Reason must be at most 1000 characters');
    expect(cancelFailureText('request_already_decided')).toMatch(/already been decided/);
    expect(cancelFailureText('request_not_found')).toMatch(/no longer exists/);
    expect(cancelFailureText('cannot_decide_own_request')).toBe('Another admin must decide this');
    expect(cancelFailureText('not_authenticated')).toBe('You must be signed in to do that.');
    expect(cancelFailureText('po_entity_required')).toMatch(/business tag \(MH \/ QT\)/);
    expect(cancelFailureText('stock_entity_tag_required')).toMatch(/untagged received stock/);
    expect(cancelFailureText('insufficient_hub_quantity')).toBe(
      'Hub stock is too low to reverse the received quantities.'
    );
    expect(cancelFailureText('hub_below_reserved')).toMatch(/below the reserved quantity/);
    expect(cancelFailureText('insufficient_tagged_stock')).toMatch(/Tagged hub stock is too low/);
    expect(cancelFailureText('cannot_cancel_missing_hub_row')).toMatch(/Hub stock for a received material is missing/);
    expect(cancelFailureText('missing_raw_material')).toMatch(/no raw material/);
  });
});

describe('validateCancelReason', () => {
  it('trims and requires a reason', () => {
    expect(validateCancelReason('')).toEqual({
      ok: false,
      code: 'reason_required',
      message: 'A reason is required',
    });
    expect(validateCancelReason('   ')).toEqual({
      ok: false,
      code: 'reason_required',
      message: 'A reason is required',
    });
    expect(validateCancelReason('  keep it  ')).toEqual({ ok: true, reason: 'keep it' });
  });

  it('accepts 1000 characters and refuses 1001', () => {
    const ok = 'x'.repeat(CANCEL_REASON_MAX);
    const tooLong = 'x'.repeat(CANCEL_REASON_MAX + 1);
    expect(validateCancelReason(ok)).toEqual({ ok: true, reason: ok });
    expect(validateCancelReason(tooLong)).toEqual({
      ok: false,
      code: 'reason_too_long',
      message: 'Reason must be at most 1000 characters',
    });
    expect(validateCancelReason(`  ${ok}  `)).toEqual({ ok: true, reason: ok });
    expect(validateCancelReason(`  ${tooLong}`)).toEqual({
      ok: false,
      code: 'reason_too_long',
      message: 'Reason must be at most 1000 characters',
    });
  });
});

describe('parseBillNumbers / normaliseCancelFailure', () => {
  const accounting = 'Handle the bill through accounting first. Nothing was cancelled.';

  it('reads bill numbers from a soft-return jsonb (bill_numbers + HINT array)', () => {
    const n = normaliseCancelFailure({
      data: {
        success: false,
        error: 'bills_on_po',
        message: accounting,
        detail: accounting,
        hint: '["G1-SOFT","G1-2"]',
        bill_numbers: ['G1-SOFT', 'G1-2'],
        bill_count: 2,
      },
    });
    expect(n).toEqual({
      code: 'bills_on_po',
      message: accounting,
      detail: accounting,
      hint: '["G1-SOFT","G1-2"]',
      billNumbers: ['G1-SOFT', 'G1-2'],
    });
  });

  it('reads bill numbers from a PostgREST RAISE (message/details/hint)', () => {
    const n = normaliseCancelFailure({
      error: {
        message: 'bills_on_po',
        details: accounting,
        hint: '["G1-1","G1-2"]',
      },
    });
    expect(n.code).toBe('bills_on_po');
    expect(n.detail).toBe(accounting);
    expect(n.hint).toBe('["G1-1","G1-2"]');
    expect(n.billNumbers).toEqual(['G1-1', 'G1-2']);
    expect(n.message).toBe(cancelFailureText('bills_on_po'));
  });

  it('parses a HINT JSON array when bill_numbers is absent', () => {
    expect(parseBillNumbers('["A","B"]')).toEqual(['A', 'B']);
    expect(parseBillNumbers(['C', ' D '])).toEqual(['C', 'D']);
    const n = normaliseCancelFailure({
      data: { success: false, error: 'bills_on_po', hint: ['HINT-ONLY'] },
    });
    expect(n.billNumbers).toEqual(['HINT-ONLY']);
  });

  it('merges a soft return with a transport error (soft wins for code/message)', () => {
    const n = normaliseCancelFailure({
      data: { success: false, error: 'already_cancelled', message: 'This purchase order is already cancelled.' },
      error: { message: 'forbidden', details: 'ignored', hint: '' },
    });
    expect(n.code).toBe('already_cancelled');
    expect(n.message).toBe('This purchase order is already cancelled.');
  });

  it('maps a bare RAISE code to the clean reason_too_long text', () => {
    const n = normaliseCancelFailure({ error: { message: 'reason_too_long', details: 'The reason must be at most 1000 characters.' } });
    expect(n).toMatchObject({
      code: 'reason_too_long',
      message: 'Reason must be at most 1000 characters',
      detail: 'The reason must be at most 1000 characters.',
    });
  });

  it('maps the eight previously-unmapped RAISE codes and keeps DETAIL/HINT', () => {
    const cases: Array<{ code: string; details: string; hint: string }> = [
      { code: 'not_authenticated', details: '', hint: '' },
      {
        code: 'po_entity_required',
        details: 'Set the PO entity (QT / MH) before cancelling a received PO.',
        hint: '',
      },
      {
        code: 'stock_entity_tag_required',
        details: 'Part of this PO was received before stock tags existed and cannot be reversed while tags are enforced.',
        hint: '',
      },
      {
        code: 'insufficient_hub_quantity',
        details:
          'Stock received on this PO has already been partly used (on hand 2, needed 5). Nothing was cancelled; reverse the usage first.',
        hint: '{"raw_material_id":"rm-1","on_hand":2,"required_return":5}',
      },
      { code: 'hub_below_reserved', details: '', hint: '' },
      {
        code: 'insufficient_tagged_stock',
        details:
          'Stock received on this PO has already been partly used (QT balance 1, needed 4). Nothing was cancelled.',
        hint: '{"raw_material_id":"rm-1","entity_code":"QT","on_hand":1,"required_return":4}',
      },
      { code: 'cannot_cancel_missing_hub_row', details: '', hint: '' },
      { code: 'missing_raw_material', details: '', hint: '' },
    ];
    for (const c of cases) {
      const n = normaliseCancelFailure({
        error: { message: c.code, details: c.details, hint: c.hint },
      });
      expect(n.code).toBe(c.code);
      expect(n.message).toBe(cancelFailureText(c.code));
      expect(n.message).not.toMatch(/Could not complete cancellation/);
      expect(n.detail).toBe(c.details);
      expect(n.hint).toBe(c.hint);
    }
  });

  it('shows the server message for an unknown code instead of the generic wrapper', () => {
    const raise = normaliseCancelFailure({
      error: {
        message: 'warehouse_closed',
        details: 'The hub is shut for stocktake.',
        hint: 'Retry after 18:00 MYT.',
      },
    });
    expect(raise.code).toBe('warehouse_closed');
    expect(raise.message).toBe('warehouse_closed');
    expect(raise.message).not.toMatch(/Could not complete cancellation/);
    expect(raise.detail).toBe('The hub is shut for stocktake.');
    expect(raise.hint).toBe('Retry after 18:00 MYT.');

    const human = normaliseCancelFailure({
      error: { message: 'The warehouse is closed today.' },
    });
    expect(human.code).toBe('The warehouse is closed today.');
    expect(human.message).toBe('The warehouse is closed today.');
    expect(human.message).not.toMatch(/Could not complete cancellation/);

    const soft = normaliseCancelFailure({
      data: { success: false, error: 'brand_new_code', message: 'Please phone the warehouse.' },
    });
    expect(soft.code).toBe('brand_new_code');
    expect(soft.message).toBe('Please phone the warehouse.');
    expect(soft.message).not.toMatch(/Could not complete cancellation/);
  });
});

describe('formatMytDateTime', () => {
  it('formats a fixed instant in Asia/Kuala_Lumpur', () => {
    // 2026-10-20T02:00:00.000Z = 20 Oct 2026, 10:00 MYT (UTC+8)
    expect(formatMytDateTime('2026-10-20T02:00:00.000Z')).toBe('20 Oct 2026, 10:00 am');
  });
});

describe('latestRequestByPo', () => {
  it('keeps the newest requested_at per PO', () => {
    const older = req({ id: 'r1', purchase_order_id: 'po-1', requested_at: '2026-10-01T00:00:00Z', status: 'rejected' });
    const newer = req({ id: 'r2', purchase_order_id: 'po-1', requested_at: '2026-10-20T00:00:00Z', status: 'pending' });
    const other = req({ id: 'r3', purchase_order_id: 'po-2', requested_at: '2026-10-05T00:00:00Z', status: 'approved' });
    const map = latestRequestByPo([older, other, newer]);
    expect(map.get('po-1')?.id).toBe('r2');
    expect(map.get('po-2')?.id).toBe('r3');
  });
});

describe('poUsesCancelRpc', () => {
  it('is true for receipts or partial/received; false for draft and ordered-with-no-receipts', () => {
    expect(poUsesCancelRpc(PO_RECEIVED)).toBe(true);
    expect(poUsesCancelRpc(PO_PARTIAL)).toBe(true);
    expect(poUsesCancelRpc({ status: 'ordered', items: [{ quantity_received: 1 }] })).toBe(true);
    expect(poUsesCancelRpc({ status: 'partial', items: [] })).toBe(true);
    expect(poUsesCancelRpc(PO_DRAFT)).toBe(false);
    expect(poUsesCancelRpc(PO_ORDERED_EMPTY)).toBe(false);
  });
});

describe('poCancelActions role matrix', () => {
  it('hides cancel-request controls on drafts and ordered-with-no-receipts', () => {
    for (const po of [PO_DRAFT, PO_ORDERED_EMPTY]) {
      expect(poCancelActions({ role: 'procurement', uid: 'buyer-qt', po, latestRequest: null })).toEqual({
        requestCancel: false,
        directCancel: false,
        approve: false,
        reject: false,
        notices: [],
      });
      expect(poCancelActions({ role: 'admin', uid: 'admin', po, latestRequest: null })).toMatchObject({
        requestCancel: false,
        directCancel: false,
      });
    }
  });

  it('procurement own tag: request form when none or rejected; pending notice only while pending', () => {
    expect(poCancelActions({ role: 'procurement', uid: 'buyer-qt', po: PO_RECEIVED, latestRequest: null })).toEqual({
      requestCancel: true,
      directCancel: false,
      approve: false,
      reject: false,
      notices: [],
    });
    const pending = req({ id: 'p1', status: 'pending', requested_at: '2026-10-21T01:00:00Z', reason: 'please cancel' });
    const pendingFlags = poCancelActions({
      role: 'procurement',
      uid: 'buyer-qt',
      po: PO_RECEIVED,
      latestRequest: pending,
    });
    expect(pendingFlags).toMatchObject({ requestCancel: false, directCancel: false, approve: false, reject: false });
    expect(pendingFlags.notices).toEqual([
      { kind: 'pending', requestedAt: pending.requested_at, reason: 'please cancel' },
    ]);
    const rejected = req({
      id: 'p2',
      status: 'rejected',
      decided_at: '2026-10-22T01:00:00Z',
      decision_reason: 'keep it',
    });
    const rejectedFlags = poCancelActions({
      role: 'procurement',
      uid: 'buyer-qt',
      po: PO_RECEIVED,
      latestRequest: rejected,
    });
    expect(rejectedFlags.requestCancel).toBe(true);
    expect(rejectedFlags.notices).toEqual([
      { kind: 'rejected', decidedAt: '2026-10-22T01:00:00Z', decisionReason: 'keep it' },
    ]);
  });

  it('admin: direct cancel when none/rejected; hide it and show decide while pending', () => {
    expect(poCancelActions({ role: 'admin', uid: 'admin', po: PO_PARTIAL, latestRequest: null })).toEqual({
      requestCancel: false,
      directCancel: true,
      approve: false,
      reject: false,
      notices: [],
    });
    const pending = req({ id: 'p1', status: 'pending', requested_by: 'buyer-qt' });
    const flags = poCancelActions({ role: 'admin', uid: 'admin', po: PO_PARTIAL, latestRequest: pending });
    expect(flags.directCancel).toBe(false);
    expect(flags.approve).toBe(true);
    expect(flags.reject).toBe(true);
    expect(flags.notices.map((n) => n.kind)).toEqual(['pending', 'decide_pending_first']);
  });

  it('requester promoted to admin cannot decide their own pending request', () => {
    const pending = req({ id: 'p1', status: 'pending', requested_by: 'buyer-qt' });
    const flags = poCancelActions({
      role: 'admin',
      uid: 'buyer-qt',
      po: PO_RECEIVED,
      latestRequest: pending,
    });
    expect(flags).toMatchObject({ requestCancel: false, directCancel: false, approve: false, reject: false });
    expect(flags.notices.map((n) => n.kind)).toEqual(['pending', 'decide_pending_first', 'own_request']);
  });

  it('billed received PO still offers the same controls (refusal is on submit)', () => {
    expect(poCancelActions({ role: 'procurement', uid: 'buyer-qt', po: PO_BILLED, latestRequest: null }).requestCancel).toBe(
      true
    );
    expect(poCancelActions({ role: 'admin', uid: 'admin', po: PO_BILLED, latestRequest: null }).directCancel).toBe(true);
  });

  it('staff and other roles get no cancel-request controls', () => {
    expect(poCancelActions({ role: 'staff', uid: 's', po: PO_RECEIVED, latestRequest: null })).toEqual({
      requestCancel: false,
      directCancel: false,
      approve: false,
      reject: false,
      notices: [],
    });
  });
});

describe('entityChip', () => {
  it('returns MH, QT or Untagged', () => {
    expect(entityChip('MH')).toEqual({ label: 'MH', tone: 'mh' });
    expect(entityChip('qt')).toEqual({ label: 'QT', tone: 'qt' });
    expect(entityChip(null)).toEqual({ label: 'Untagged', tone: 'untagged' });
    expect(entityChip('')).toEqual({ label: 'Untagged', tone: 'untagged' });
    expect(entityChip('xx')).toEqual({ label: 'Untagged', tone: 'untagged' });
  });
});
