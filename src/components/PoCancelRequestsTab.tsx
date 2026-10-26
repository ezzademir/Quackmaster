import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, ListRow, Status } from './ui';
import { EntityChip } from './EntityChip';
import { CancelFailureAlert } from './PoCancelPanel';
import {
  CANCEL_REASON_MAX,
  formatMytDateTime,
  normaliseCancelFailure,
  validateCancelReason,
  type NormalisedCancelFailure,
  type PoCancelRequestStatus,
} from '../utils/poCancelUi';
import {
  approvePoCancelRequest,
  listAllCancelRequests,
  oneRelation,
  rejectPoCancelRequest,
  type PoCancelRequestJoined,
} from '../utils/poCancelRpc';

function requestStatusTone(status: PoCancelRequestStatus): 'warning' | 'success' | 'danger' {
  switch (status) {
    case 'pending':
      return 'warning';
    case 'approved':
      return 'success';
    case 'rejected':
      return 'danger';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function supplierName(row: PoCancelRequestJoined): string {
  const po = oneRelation(row.purchase_order);
  return oneRelation(po?.supplier)?.name ?? '—';
}

function requesterName(row: PoCancelRequestJoined): string {
  return oneRelation(row.requester)?.full_name ?? '—';
}

function deciderName(row: PoCancelRequestJoined): string {
  return oneRelation(row.decider)?.full_name ?? '—';
}

export function usePoCancelPendingCount(enabled: boolean, refreshKey = 0): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let live = true;
    void listAllCancelRequests({ status: 'pending' }).then((r) => {
      if (live) setCount((r.data ?? []).length);
    });
    return () => {
      live = false;
    };
  }, [enabled, refreshKey]);
  return count;
}

export function PoCancelRequestsTab({
  uid,
  onChanged,
}: {
  uid: string;
  onChanged?: () => void;
}) {
  const [pending, setPending] = useState<PoCancelRequestJoined[]>([]);
  const [decided, setDecided] = useState<PoCancelRequestJoined[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [failure, setFailure] = useState<NormalisedCancelFailure | null>(null);
  const [clientError, setClientError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [p, d] = await Promise.all([
      listAllCancelRequests({ status: 'pending', orderBy: 'requested_at' }),
      listAllCancelRequests({
        status: ['approved', 'rejected'],
        orderBy: 'decided_at',
        limit: 20,
      }),
    ]);
    if (p.error || d.error) {
      setError('Could not load requests');
      setPending([]);
      setDecided([]);
      setLoading(false);
      return;
    }
    setPending((p.data ?? []) as PoCancelRequestJoined[]);
    setDecided((d.data ?? []) as PoCancelRequestJoined[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(row: PoCancelRequestJoined) {
    if (busyId) return;
    if (
      !confirm(
        `Approve cancellation of ${oneRelation(row.purchase_order)?.order_number ?? 'this order'}? Received quantities will be deducted from hub inventory, tagged like the originals. The order will be marked cancelled. You cannot undo this.`
      )
    ) {
      return;
    }
    setBusyId(row.id);
    setFailure(null);
    const { data, error: rpcErr } = await approvePoCancelRequest(row.id);
    const normalised = normaliseCancelFailure({
      data,
      error: rpcErr
        ? {
            message: rpcErr.message,
            details: 'details' in rpcErr ? String((rpcErr as { details?: string }).details ?? '') : '',
            hint: 'hint' in rpcErr ? String((rpcErr as { hint?: string }).hint ?? '') : '',
          }
        : null,
    });
    const payload = data && typeof data === 'object' ? (data as { success?: boolean }) : null;
    setBusyId(null);
    if (rpcErr || payload?.success === false) {
      setFailure(normalised);
      if (normalised.code === 'request_already_decided') await load();
      return;
    }
    onChanged?.();
    await load();
  }

  async function reject(row: PoCancelRequestJoined) {
    if (busyId) return;
    const parsed = validateCancelReason(rejectReason);
    if (!parsed.ok) {
      setClientError(parsed.message);
      return;
    }
    setBusyId(row.id);
    setFailure(null);
    setClientError('');
    const { data, error: rpcErr } = await rejectPoCancelRequest(row.id, parsed.reason);
    const normalised = normaliseCancelFailure({
      data,
      error: rpcErr
        ? {
            message: rpcErr.message,
            details: 'details' in rpcErr ? String((rpcErr as { details?: string }).details ?? '') : '',
            hint: 'hint' in rpcErr ? String((rpcErr as { hint?: string }).hint ?? '') : '',
          }
        : null,
    });
    const payload = data && typeof data === 'object' ? (data as { success?: boolean }) : null;
    setBusyId(null);
    if (rpcErr || payload?.success === false) {
      setFailure(normalised);
      if (normalised.code === 'request_already_decided') await load();
      return;
    }
    setRejectId(null);
    setRejectReason('');
    onChanged?.();
    await load();
  }

  function decideControls(row: PoCancelRequestJoined) {
    if (row.requested_by === uid) {
      return <p className="text-sm text-amber-800">Another admin must decide this</p>;
    }
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={busyId === row.id}
            onClick={() => void approve(row)}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busyId === row.id}
            onClick={() => {
              setRejectId(row.id);
              setRejectReason('');
              setClientError('');
            }}
          >
            Reject
          </Button>
        </div>
        {rejectId === row.id ? (
          <div className="space-y-2">
            <label className="block text-sm text-stone-700">
              Rejection reason
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                aria-label="Rejection reason"
              />
            </label>
            <p className="text-right text-xs text-stone-500">
              {rejectReason.trim().length}/{CANCEL_REASON_MAX}
            </p>
            {clientError ? <p className="text-sm text-red-700">{clientError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="danger" disabled={busyId === row.id} onClick={() => void reject(row)}>
                Confirm reject
              </Button>
              <Button type="button" variant="secondary" onClick={() => setRejectId(null)}>
                Back
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (loading) {
    return <div className="flex h-48 items-center justify-center text-sm text-stone-400">Loading…</div>;
  }

  if (error) {
    return (
      <div className="panel space-y-3 p-5">
        <p className="text-sm text-red-700">Could not load requests</p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {failure ? <CancelFailureAlert failure={failure} /> : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-900">Pending requests</h2>
        {pending.length === 0 ? (
          <div className="panel py-2">
            <EmptyState title="No pending cancellation requests." />
          </div>
        ) : (
          <>
            <div className="ios-group">
              {pending.map((row) => {
                const po = oneRelation(row.purchase_order);
                return (
                  <ListRow
                    key={row.id}
                    title={po?.order_number ?? '—'}
                    meta={`${supplierName(row)} · ${requesterName(row)} · ${formatMytDateTime(row.requested_at)}`}
                    aside={<EntityChip code={po?.entity_code} />}
                    body={
                      <div className="space-y-2">
                        <p className="text-sm text-stone-700">{row.reason}</p>
                        <p className="text-xs text-stone-500">
                          {po?.status ?? '—'}
                          {po?.total_amount != null ? ` · MYR ${Number(po.total_amount).toFixed(2)}` : ''}
                        </p>
                        {decideControls(row)}
                      </div>
                    }
                  />
                );
              })}
            </div>
            <div className="hidden">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Supplier</th>
                    <th>Entity</th>
                    <th>Requester</th>
                    <th>Reason</th>
                    <th>Requested</th>
                    <th>PO</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((row) => {
                    const po = oneRelation(row.purchase_order);
                    return (
                      <tr key={row.id}>
                        <td className="font-medium">{po?.order_number ?? '—'}</td>
                        <td>{supplierName(row)}</td>
                        <td>
                          <EntityChip code={po?.entity_code} />
                        </td>
                        <td>{requesterName(row)}</td>
                        <td className="max-w-xs text-sm">{row.reason}</td>
                        <td className="whitespace-nowrap text-sm text-stone-500">
                          {formatMytDateTime(row.requested_at)}
                        </td>
                        <td className="text-sm text-stone-500">
                          {po?.status ?? '—'}
                          {po?.total_amount != null ? ` · MYR ${Number(po.total_amount).toFixed(2)}` : ''}
                        </td>
                        <td>{decideControls(row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-900">Recently decided</h2>
        {decided.length === 0 ? (
          <p className="text-sm text-stone-500">No recent decisions.</p>
        ) : (
          <div className="panel overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Status</th>
                  <th>Decider</th>
                  <th>Decision reason</th>
                  <th>Decided</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((row) => {
                  const po = oneRelation(row.purchase_order);
                  return (
                    <tr key={row.id}>
                      <td className="font-medium">
                        <span className="mr-2">{po?.order_number ?? '—'}</span>
                        <EntityChip code={po?.entity_code} />
                      </td>
                      <td>
                        <Status tone={requestStatusTone(row.status)}>{row.status}</Status>
                      </td>
                      <td>{deciderName(row)}</td>
                      <td className="text-sm text-stone-600">{row.decision_reason ?? '—'}</td>
                      <td className="whitespace-nowrap text-sm text-stone-500">
                        {formatMytDateTime(row.decided_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
