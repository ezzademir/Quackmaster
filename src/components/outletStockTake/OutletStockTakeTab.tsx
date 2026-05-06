import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Download } from 'lucide-react';
import type { Outlet } from '../../types';
import { supabase } from '../../utils/supabase';
import { hubRowAvailableQuantity } from '../../utils/hubInventoryMath';
import {
  buildOutletStockTakeCsv,
  getOutletStockTakeSessionDetail,
  listOutletStockTakeSessions,
  postOutletStockTake,
  type OutletStockTakeSessionRow,
} from '../../utils/outletStockTakeService';

type InvRow = {
  id: string;
  product_batch: string;
  lot_label: string;
  quantity_on_hand: number;
  reserved_quantity: number;
  available_quantity: number;
};

function parseCount(raw: string): number | null {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function describePostError(payload: { error?: string; [k: string]: unknown }): string {
  const code = payload.error;
  switch (code) {
    case 'not_authenticated_or_inactive':
      return 'You must be signed in as active staff to post a stock take.';
    case 'outlet_required':
      return 'Select an outlet.';
    case 'lines_required':
      return 'Add at least one inventory row (this outlet has no stock lines to count).';
    case 'invalid_line':
      return 'Each line needs a valid counted quantity (non‑negative number).';
    case 'outlet_inventory_not_found':
      return 'An inventory row no longer matches this outlet — refresh and try again.';
    case 'counted_below_reserved':
      return 'Counted quantity cannot be below reserved quantity for a line.';
    case 'duplicate_outlet_inventory_id':
      return 'Duplicate inventory row in submission — refresh and try again.';
    default:
      return typeof code === 'string' ? code : 'Stock take could not be posted.';
  }
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface DraftRow extends InvRow {
  countedStr: string;
  remark: string;
}

interface Props {
  outlets: Outlet[];
  onApplied?: () => void;
}

export function OutletStockTakeTab({ outlets, onApplied }: Props) {
  const [outletId, setOutletId] = useState('');
  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sessionNotes, setSessionNotes] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [loadingInv, setLoadingInv] = useState(false);
  const [sessions, setSessions] = useState<OutletStockTakeSessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const loadInventory = useCallback(async (oid: string) => {
    if (!oid) {
      setRows([]);
      return;
    }
    setLoadingInv(true);
    setMessage(null);
    try {
      const { data, error } = await supabase
        .from('outlet_inventory')
        .select(
          `
          id,
          product_batch,
          quantity_on_hand,
          reserved_quantity,
          available_quantity,
          lot:inventory_lots ( product_batch_label, expiry_date )
        `
        )
        .eq('outlet_id', oid)
        .order('product_batch', { ascending: true });

      if (error) throw error;

      const mapped: DraftRow[] = (data ?? []).map((r: Record<string, unknown>) => {
        const qoh = Number(r.quantity_on_hand ?? 0);
        const res = Number(r.reserved_quantity ?? 0);
        const lot = r.lot as { product_batch_label?: string | null } | null | undefined;
        const lotLabel = lot?.product_batch_label?.trim() || '';
        const av = hubRowAvailableQuantity(qoh, res, r.available_quantity != null ? Number(r.available_quantity) : null);
        return {
          id: String(r.id),
          product_batch: String(r.product_batch ?? ''),
          lot_label: lotLabel,
          quantity_on_hand: qoh,
          reserved_quantity: res,
          available_quantity: av,
          countedStr: String(qoh),
          remark: '',
        };
      });
      setRows(mapped);
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Failed to load outlet inventory.' });
      setRows([]);
    } finally {
      setLoadingInv(false);
    }
  }, []);

  const refreshSessions = useCallback(async (oid?: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadingSessions(true);
    try {
      const list = await listOutletStockTakeSessions(oid || undefined);
      setSessions(list);
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Failed to load sessions.' });
    } finally {
      if (!opts?.silent) setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    void loadInventory(outletId);
  }, [outletId, loadInventory]);

  useEffect(() => {
    void refreshSessions(outletId || undefined);
  }, [outletId, refreshSessions]);

  useEffect(() => {
    const channel = supabase
      .channel('outlet-stock-take-sessions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outlet_stock_take_sessions' },
        (payload) => {
          if (outletId) {
            const nid = (payload.new as { outlet_id?: string } | null)?.outlet_id;
            const oid = (payload.old as { outlet_id?: string } | null)?.outlet_id;
            const affected = nid ?? oid;
            if (affected && affected !== outletId) return;
          }
          void refreshSessions(outletId || undefined, { silent: true });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [outletId, refreshSessions]);

  const varianceOf = (r: DraftRow) => {
    const c = parseCount(r.countedStr);
    if (c === null) return null;
    return c - r.quantity_on_hand;
  };

  const canSubmit =
    outletId &&
    rows.length > 0 &&
    !submitting &&
    !loadingInv &&
    rows.every((r) => {
      const c = parseCount(r.countedStr);
      return c !== null && c >= (r.reserved_quantity ?? 0);
    });

  const handleSubmit = async () => {
    if (!outletId || rows.length === 0) return;
    setSubmitting(true);
    setMessage(null);
    const idem = crypto.randomUUID();
    try {
      const lines = rows.map((r) => {
        const c = parseCount(r.countedStr);
        if (c === null) throw new Error('invalid_counts');
        return {
          outlet_inventory_id: r.id,
          counted_qty: c,
          line_remark: r.remark.trim() || null,
        };
      });

      const result = await postOutletStockTake({
        outletId,
        countDate,
        notes: sessionNotes.trim() || null,
        lines,
        idempotencyKey: idem,
      });

      if (!result.success) {
        setMessage({ tone: 'err', text: describePostError(result as { error?: string }) });
        return;
      }

      const sessionId = result.session_id;
      setMessage({
        tone: 'ok',
        text: result.idempotent_replay ? 'Replayed existing stock take (same idempotency key).' : 'Stock take posted and inventory updated.',
      });

      const detail = await getOutletStockTakeSessionDetail(sessionId);
      if (detail) {
        const csvLines = detail.lines.map((l) => ({
          outlet_inventory_id: l.outlet_inventory_id,
          product_batch: l.outlet_inventory?.product_batch,
          lot_label: l.outlet_inventory?.lot?.product_batch_label ?? '',
          system_qoh_before: Number(l.system_qoh_before),
          counted_qty: Number(l.counted_qty),
          variance: Number(l.variance),
          line_remark: l.line_remark,
        }));
        const csv = buildOutletStockTakeCsv(detail, csvLines);
        const safeDate = (detail.count_date ?? countDate).replace(/[^\d-]/g, '');
        downloadCsv(`outlet-stock-take-${detail.id.slice(0, 8)}-${safeDate}.csv`, csv);
      }

      setSessionNotes('');
      void loadInventory(outletId);
      void refreshSessions(outletId, { silent: true });
      onApplied?.();
    } catch (e) {
      if ((e as Error).message === 'invalid_counts') {
        setMessage({ tone: 'err', text: 'Fix invalid counted quantities before submitting.' });
      } else {
        setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Submit failed.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const exportSession = async (sessionId: string) => {
    setExportingId(sessionId);
    setMessage(null);
    try {
      const detail = await getOutletStockTakeSessionDetail(sessionId);
      if (!detail) {
        setMessage({ tone: 'err', text: 'Session not found.' });
        return;
      }
      const csvLines = detail.lines.map((l) => ({
        outlet_inventory_id: l.outlet_inventory_id,
        product_batch: l.outlet_inventory?.product_batch,
        lot_label: l.outlet_inventory?.lot?.product_batch_label ?? '',
        system_qoh_before: Number(l.system_qoh_before),
        counted_qty: Number(l.counted_qty),
        variance: Number(l.variance),
        line_remark: l.line_remark,
      }));
      const csv = buildOutletStockTakeCsv(detail, csvLines);
      const safeDate = (detail.count_date ?? '').replace(/[^\d-]/g, '');
      downloadCsv(`outlet-stock-take-${detail.id.slice(0, 8)}-${safeDate}.csv`, csv);
      setMessage({ tone: 'ok', text: 'CSV downloaded.' });
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Export failed.' });
    } finally {
      setExportingId(null);
    }
  };

  const outletName = useMemo(() => outlets.find((o) => o.id === outletId)?.name ?? '', [outlets, outletId]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-100 bg-amber-50/80 px-4 py-3 text-sm text-amber-950">
        <span className="inline-flex items-center gap-2 font-semibold text-amber-900">
          <ClipboardList size={18} className="shrink-0" />
          Outlet stock take
        </span>
        <p className="mt-1 text-amber-900/90">
          Count physical stock per outlet inventory row. Submitting updates on-hand and available quantities via the server, writes a session + lines, and records a data ledger entry. Counted quantity cannot be below reserved.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-800">New count</h2>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Outlet</label>
              <select
                value={outletId}
                onChange={(e) => setOutletId(e.target.value)}
                className="min-w-[12rem] rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                <option value="">Select outlet…</option>
                {outlets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Count date</label>
              <input
                type="date"
                value={countDate}
                onChange={(e) => setCountDate(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Session notes (optional)</label>
            <input
              value={sessionNotes}
              onChange={(e) => setSessionNotes(e.target.value)}
              placeholder="e.g. Year-end count, cycle count Aisle 2…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>

          {message && (
            <p
              className={`rounded-lg px-3 py-2 text-sm ${
                message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
              }`}
            >
              {message.text}
            </p>
          )}

          {loadingInv ? (
            <div className="py-8 text-center text-sm text-gray-400">Loading inventory…</div>
          ) : !outletId ? (
            <p className="text-sm text-gray-500">Choose an outlet to load rows.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-amber-800">No outlet inventory rows — receive stock before running a stock take.</p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700">Batch</th>
                      <th className="hidden sm:table-cell px-3 py-2 text-left font-semibold text-gray-700">Lot label</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-700">System QoH</th>
                      <th className="hidden md:table-cell px-3 py-2 text-right font-semibold text-gray-700">Reserved</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-700">Counted</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-700">Variance</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700 min-w-[8rem]">Line remark</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((r) => {
                      const v = varianceOf(r);
                      const bad = (() => {
                        const c = parseCount(r.countedStr);
                        if (c === null) return true;
                        return c < (r.reserved_quantity ?? 0);
                      })();
                      return (
                        <tr key={r.id} className={bad ? 'bg-red-50/40' : 'hover:bg-gray-50'}>
                          <td className="px-3 py-2 font-medium text-gray-900">{r.product_batch}</td>
                          <td className="hidden sm:table-cell px-3 py-2 text-gray-600 text-xs">{r.lot_label || '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.quantity_on_hand}</td>
                          <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums text-gray-600">{r.reserved_quantity}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={r.countedStr}
                              onChange={(e) => {
                                const v = e.target.value;
                                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, countedStr: v } : x)));
                              }}
                              className="w-24 rounded border border-gray-300 px-2 py-1 text-right text-sm tabular-nums"
                            />
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums ${v != null && v !== 0 ? 'font-semibold text-amber-800' : 'text-gray-600'}`}>
                            {v === null ? '—' : v}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={r.remark}
                              onChange={(e) => {
                                const v = e.target.value;
                                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, remark: v } : x)));
                              }}
                              placeholder="Optional"
                              className="w-full min-w-[6rem] rounded border border-gray-300 px-2 py-1 text-xs"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-gray-500">
                  {outletName ? (
                    <>
                      Outlet: <span className="font-medium text-gray-700">{outletName}</span> · {rows.length} row{rows.length !== 1 ? 's' : ''}
                    </>
                  ) : null}
                </p>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                  className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? 'Posting…' : 'Post stock take'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-800">Recent sessions</h2>
            {loadingSessions && <span className="text-xs text-gray-400">Loading…</span>}
          </div>
          <p className="text-xs text-gray-500">
            {outletId ? 'Filtered to the selected outlet. ' : 'All outlets (latest 100). '}
            Export CSV includes session metadata, variance, and line remarks.
          </p>
          <ul className="max-h-[28rem] space-y-2 overflow-y-auto text-sm">
            {sessions.length === 0 ? (
              <li className="text-gray-400">No sessions yet.</li>
            ) : (
              sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50/80 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">{s.outlet?.name ?? 'Outlet'}</p>
                    <p className="text-xs text-gray-500">
                      {s.count_date} · posted {new Date(s.posted_at).toLocaleString()}
                      {s.notes ? ` · ${s.notes}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void exportSession(s.id)}
                    disabled={exportingId === s.id}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <Download size={14} />
                    {exportingId === s.id ? '…' : 'CSV'}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
