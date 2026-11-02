import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from './ui';
import {
  CANCEL_REASON_MAX,
  formatMytDateTime,
  latestRequestByPo,
  normaliseCancelFailure,
  poCancelActions,
  poUsesCancelRpc,
  validateCancelReason,
  type NormalisedCancelFailure,
  type PoCancelNotice,
  type PoCancelRequestRow,
} from '../utils/poCancelUi';
import {
  listAllCancelRequests,
  listOwnCancelRequests,
  requestCancelPurchaseOrder,
  type PoCancelRequestJoined,
} from '../utils/poCancelRpc';

export function CancelFailureAlert({ failure }: { failure: NormalisedCancelFailure }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-red-50 p-3" role="alert">
      <AlertCircle size={18} className="mt-0.5 flex-shrink-0 text-red-600" />
      <div className="space-y-1 text-sm text-red-800">
        <p className="font-medium text-red-900">{failure.message}</p>
        {failure.detail ? <p>DETAIL: {failure.detail}</p> : null}
        {failure.hint ? <p>HINT: {failure.hint}</p> : null}
        {failure.billNumbers.length > 0 ? (
          <p>Bills: {failure.billNumbers.join(', ')}</p>
        ) : null}
      </div>
    </div>
  );
}

function renderNotice(notice: PoCancelNotice) {
  switch (notice.kind) {
    case 'pending':
      return (
        <p>
          Cancellation requested on {formatMytDateTime(notice.requestedAt)}, waiting for an admin.
          Your reason: {notice.reason}
        </p>
      );
    case 'rejected':
      return (
        <p>
          Cancellation rejected on {formatMytDateTime(notice.decidedAt)}: {notice.decisionReason}
        </p>
      );
    case 'decide_pending_first':
      return <p>Decide the pending request first</p>;
    case 'own_request':
      return <p>Another admin must decide this</p>;
    default: {
      const _exhaustive: never = notice.kind;
      return _exhaustive;
    }
  }
}

export function PoCancelPanel({
  po,
  role,
  uid,
  disabled = false,
  onCancelled,
}: {
  po: { id: string; order_number: string; status?: string | null; items?: Array<{ quantity_received?: number | null }> };
  role: 'admin' | 'procurement';
  uid: string;
  disabled?: boolean;
  onCancelled?: () => void;
}) {
  const [rows, setRows] = useState<PoCancelRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<NormalisedCancelFailure | null>(null);
  const [clientError, setClientError] = useState('');

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    const result =
      role === 'admin'
        ? await listAllCancelRequests({ purchaseOrderId: po.id })
        : await listOwnCancelRequests(uid, { purchaseOrderId: po.id });
    if (result.error) {
      setLoadError(result.error.message ?? 'Could not load requests');
      setRows([]);
      setLoading(false);
      return;
    }
    setRows((result.data ?? []) as PoCancelRequestJoined[]);
    setLoading(false);
  }, [po.id, role, uid]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  const latest = useMemo(
    () => latestRequestByPo(rows).get(po.id) ?? null,
    [rows, po.id]
  );
  const actions = poCancelActions({ role, uid, po, latestRequest: latest });
  const trimmedLen = reason.trim().length;
  const canShow = poUsesCancelRpc(po) && (role === 'admin' || role === 'procurement');

  async function submit() {
    if (saving) return;
    const parsed = validateCancelReason(reason);
    if (!parsed.ok) {
      setClientError(parsed.message);
      setFailure(null);
      return;
    }
    if (role === 'admin') {
      const qty = (po.items ?? []).reduce((a, i) => a + (Number(i.quantity_received) || 0), 0);
      const hint =
        qty > 0
          ? ' Received quantities will be deducted from hub inventory, tagged like the originals.'
          : '';
      if (
        !confirm(
          `Cancel purchase order ${po.order_number}?${hint} The order will be marked cancelled. You cannot undo this.`
        )
      ) {
        return;
      }
    }
    setSaving(true);
    setClientError('');
    setFailure(null);
    const { data, error } = await requestCancelPurchaseOrder(po.id, parsed.reason);
    const pgError = error
      ? {
          message: error.message,
          details: 'details' in error ? String((error as { details?: string }).details ?? '') : '',
          hint: 'hint' in error ? String((error as { hint?: string }).hint ?? '') : '',
        }
      : null;
    const normalised = normaliseCancelFailure({ data, error: pgError });
    const payload = data && typeof data === 'object' ? (data as { success?: boolean; status?: string }) : null;
    const rejected = Boolean(error) || payload?.success === false;
    setSaving(false);
    if (rejected) {
      setFailure(normalised);
      return;
    }
    setReason('');
    setFormOpen(false);
    if (role === 'admin' && payload?.status !== 'pending') {
      onCancelled?.();
      return;
    }
    await loadRequests();
  }

  if (!canShow) return null;

  return (
    <div className="w-full max-w-xl space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
      <p className="text-sm font-medium text-stone-800">
        {role === 'admin' ? 'Cancel this order' : 'Request cancellation'}
      </p>
      {loading ? <p className="text-sm text-stone-500">Loading cancellation status…</p> : null}
      {loadError ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-700">
          <span>Could not load requests</span>
          <Button type="button" variant="secondary" onClick={() => void loadRequests()}>
            Retry
          </Button>
        </div>
      ) : null}
      {actions.notices.map((notice) => (
        <div
          key={notice.kind}
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
        >
          {renderNotice(notice)}
        </div>
      ))}
      {clientError ? <p className="text-sm text-red-700">{clientError}</p> : null}
      {failure ? <CancelFailureAlert failure={failure} /> : null}
      {(actions.requestCancel || actions.directCancel) && !formOpen ? (
        <Button
          type="button"
          variant="danger"
          disabled={disabled || saving || loading}
          onClick={() => {
            setFormOpen(true);
            setFailure(null);
            setClientError('');
          }}
        >
          {actions.directCancel ? 'Cancel order' : 'Request cancellation'}
        </Button>
      ) : null}
      {(actions.requestCancel || actions.directCancel) && formOpen ? (
        <div className="space-y-2">
          <label className="block text-sm text-stone-700">
            Reason
            <textarea
              value={reason}
              autoFocus
              data-initial-focus
              onChange={(e) => {
                setReason(e.target.value);
                setClientError('');
              }}
              rows={3}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
              aria-label="Cancellation reason"
            />
          </label>
          <p className="text-right text-xs text-stone-500">
            {trimmedLen}/{CANCEL_REASON_MAX}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" disabled={disabled || saving} onClick={() => void submit()}>
              {saving ? 'Submitting…' : actions.directCancel ? 'Cancel order' : 'Submit request'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => {
                setFormOpen(false);
                setFailure(null);
                setClientError('');
              }}
            >
              Back
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
