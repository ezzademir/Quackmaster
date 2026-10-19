import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Download, EyeOff } from 'lucide-react';
import type { Outlet } from '../../types';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../../utils/auth';
import {
  buildOutletStockTakeCsv,
  cancelBlindStockTake,
  getBlindStockTakeSheet,
  getOutletStockTakeSessionDetail,
  listOutletStockTakeSessions,
  startBlindStockTake,
  submitBlindStockTake,
  type OutletStockTakeLineRow,
  type OutletStockTakeSessionRow,
} from '../../utils/outletStockTakeService';
import { nestedLotLabel } from '../../utils/lotLabel';
import { parseCount, sheetToCountRows, type BlindCountRow } from './blindCount';
import { StickyActions } from '../ui/StickyActions';
import { malaysiaCalendarDate } from '../../utils/dateRange';

/**
 * Outlet stock take — BLIND COUNT ONLY (migration 080).
 *
 * The count sheet comes from the server (start_outlet_stock_take / get_outlet_stock_take_sheet) and
 * carries batch identity only: no system quantity, reserved quantity or variance is ever fetched for
 * the counter, inputs start empty, and every line must be counted before submit. While the count is
 * open the server hides the outlet's quantities from non-admins (RLS). Variance is computed at
 * submission; only admins see it (submit result, session CSV).
 */

function csvPrimaryLabel(inv: OutletStockTakeLineRow['outlet_inventory']): string {
  if (!inv) return '';
  const lot = nestedLotLabel(inv.lot);
  if (lot) return lot;
  const pb = typeof inv.product_batch === 'string' ? inv.product_batch.trim() : '';
  if (pb) return pb;
  const m = inv.raw_materials ?? inv.material;
  const n = [m?.name?.trim(), m?.unit_of_measure?.trim()].filter(Boolean).join(' · ');
  return n || 'Ingredient';
}

function describeError(code: string | undefined): string {
  switch (code) {
    case 'not_authenticated_or_inactive':
      return 'You must be signed in as active staff (or the outlet supervisor) to count stock.';
    case 'lines_required':
      return 'There are no lines to count.';
    case 'invalid_line':
      return 'Enter a valid counted quantity (0 or more) on every line.';
    case 'outlet_inventory_not_found':
      return 'A line no longer belongs to this outlet — reload the count sheet.';
    case 'duplicate_outlet_inventory_id':
      return 'Duplicate line in the submission — reload the count sheet.';
    case 'session_not_open':
      return 'This count is no longer open (it was submitted or cancelled elsewhere).';
    case 'session_not_found':
      return 'Count session not found.';
    case 'forbidden':
      return 'Only the person who started this count or an admin can cancel it.';
    default:
      return code ?? 'Stock take could not be saved.';
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

function sessionStatusLabel(s: OutletStockTakeSessionRow): { text: string; cls: string } {
  if (s.status === 'open') return { text: 'Open', cls: 'bg-amber-100 text-amber-900' };
  if (s.status === 'cancelled') return { text: 'Cancelled', cls: 'bg-stone-200 text-stone-700' };
  return { text: 'Posted', cls: 'bg-emerald-100 text-emerald-800' };
}

interface Props {
  outlets: Outlet[];
  onApplied?: () => void;
  /** When set, locks counting to this outlet (hides outlet picker). */
  lockedOutletId?: string | null;
  /** Pre-select outlet from deep link (e.g. reconciliation / audit). */
  initialOutletId?: string;
}

type AdminVariance = Array<{ label: string; system: number; counted: number; variance: number; atOpen: number | null; moved: number | null }>;

export function OutletStockTakeTab({ outlets, onApplied, lockedOutletId, initialOutletId }: Props) {
  const { isAdmin } = useAuth();
  const [outletId, setOutletId] = useState('');
  const [countDate, setCountDate] = useState(() => malaysiaCalendarDate());
  const [sessionNotes, setSessionNotes] = useState('');
  const [session, setSession] = useState<{ id: string; count_date: string } | null>(null);
  const [rows, setRows] = useState<BlindCountRow[]>([]);
  const [loadingSheet, setLoadingSheet] = useState(false);
  const [sessions, setSessions] = useState<OutletStockTakeSessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [adminVariance, setAdminVariance] = useState<AdminVariance | null>(null);

  const refreshSessions = useCallback(async (oid?: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadingSessions(true);
    try {
      const list = await listOutletStockTakeSessions(oid || undefined);
      setSessions(list);
      return list;
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Failed to load sessions.' });
      return [];
    } finally {
      if (!opts?.silent) setLoadingSessions(false);
    }
  }, []);

  /** Load the outlet's open count (if any) and its sheet. */
  const loadOpenCount = useCallback(
    async (oid: string) => {
      setSession(null);
      setRows([]);
      if (!oid) return;
      setLoadingSheet(true);
      try {
        const list = await refreshSessions(oid, { silent: true });
        const open = list.find((s) => s.outlet_id === oid && s.status === 'open');
        if (!open) return;
        const sheet = await getBlindStockTakeSheet(open.id);
        if (!sheet.success) {
          setMessage({ tone: 'err', text: describeError(sheet.error) });
          return;
        }
        setSession({ id: sheet.session_id, count_date: sheet.count_date });
        setRows(sheetToCountRows(sheet.lines));
      } finally {
        setLoadingSheet(false);
      }
    },
    [refreshSessions]
  );

  useEffect(() => {
    if (lockedOutletId) setOutletId(lockedOutletId);
  }, [lockedOutletId]);

  useEffect(() => {
    if (lockedOutletId || !initialOutletId) return;
    if (outlets.some((o) => o.id === initialOutletId)) setOutletId(initialOutletId);
  }, [initialOutletId, lockedOutletId, outlets]);

  useEffect(() => {
    setMessage(null);
    setAdminVariance(null);
    void loadOpenCount(outletId);
    if (!outletId) void refreshSessions(undefined);
  }, [outletId, loadOpenCount, refreshSessions]);

  useEffect(() => {
    const channel = supabase
      .channel('outlet-stock-take-sessions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outlet_stock_take_sessions' }, (payload) => {
        if (outletId) {
          const nid = (payload.new as { outlet_id?: string } | null)?.outlet_id;
          const oid = (payload.old as { outlet_id?: string } | null)?.outlet_id;
          const affected = nid ?? oid;
          if (affected && affected !== outletId) return;
        }
        void refreshSessions(outletId || undefined, { silent: true });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [outletId, refreshSessions]);

  const fgRows = useMemo(() => rows.filter((r) => !r.isIngredient), [rows]);
  const rmRows = useMemo(() => rows.filter((r) => r.isIngredient), [rows]);
  const countedCount = rows.filter((r) => parseCount(r.countedStr) !== null).length;
  const canSubmit = !!session && rows.length > 0 && countedCount === rows.length && !submitting && !loadingSheet;

  const handleStart = async () => {
    if (!outletId) return;
    setSubmitting(true);
    setMessage(null);
    setAdminVariance(null);
    try {
      const res = await startBlindStockTake(outletId, countDate, sessionNotes);
      if (!res.success) {
        setMessage({ tone: 'err', text: describeError(res.error) });
        return;
      }
      setSession({ id: res.session_id, count_date: res.count_date });
      setRows(sheetToCountRows(res.lines));
      setMessage({
        tone: 'ok',
        text: res.resumed
          ? 'Resumed the count already open for this outlet.'
          : 'Blind count started. Count every line; system quantities stay hidden until an admin reviews the result.',
      });
      void refreshSessions(outletId, { silent: true });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!session) return;
    if (!window.confirm('Cancel this count? Nothing you entered will be saved.')) return;
    setSubmitting(true);
    try {
      const res = await cancelBlindStockTake(session.id, 'cancelled from stock take screen');
      if (!res.success) {
        setMessage({ tone: 'err', text: describeError(res.error) });
        return;
      }
      setSession(null);
      setRows([]);
      setMessage({ tone: 'ok', text: 'Count cancelled.' });
      void refreshSessions(outletId, { silent: true });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!session) return;
    const lines = rows.map((r) => ({
      outlet_inventory_id: r.id,
      counted_qty: parseCount(r.countedStr),
      line_remark: r.remark.trim() || null,
    }));
    if (lines.some((l) => l.counted_qty === null)) {
      setMessage({ tone: 'err', text: 'Enter a counted quantity on every line (0 if none) before submitting.' });
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await submitBlindStockTake({
        sessionId: session.id,
        lines: lines.map((l) => ({ ...l, counted_qty: l.counted_qty as number })),
        notes: sessionNotes,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!res.success) {
        setMessage({ tone: 'err', text: describeError(res.error) });
        return;
      }
      const labelById = new Map(rows.map((r) => [r.id, r.item_label]));
      if (res.lines && isAdmin) {
        setAdminVariance(
          res.lines.map((l) => ({
            label: labelById.get(l.outlet_inventory_id) ?? l.outlet_inventory_id,
            system: Number(l.system_qoh_before),
            counted: Number(l.counted_qty),
            variance: Number(l.variance),
            atOpen: l.system_qoh_at_open == null ? null : Number(l.system_qoh_at_open),
            moved: l.qty_moved_during_count == null ? null : Number(l.qty_moved_during_count),
          }))
        );
      }
      setMessage({
        tone: 'ok',
        text: isAdmin
          ? 'Count submitted and stock updated. Variance is shown below.'
          : 'Count submitted and stock updated. Variance is reviewed by an admin.',
      });
      setSession(null);
      setRows([]);
      setSessionNotes('');
      void refreshSessions(outletId, { silent: true });
      onApplied?.();
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
        product_batch: csvPrimaryLabel(l.outlet_inventory),
        lot_label: l.outlet_inventory?.lot?.product_batch_label ?? '',
        system_qoh_before: Number(l.system_qoh_before),
        counted_qty: Number(l.counted_qty),
        variance: Number(l.variance),
        line_remark: l.line_remark,
        system_qoh_at_open: l.system_qoh_at_open ?? null,
        qty_moved_during_count: l.qty_moved_during_count ?? null,
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

  const setRow = (id: string, patch: Partial<BlindCountRow>) =>
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const renderSection = (title: string, subset: BlindCountRow[]) =>
    subset.length === 0 ? null : (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-stone-800">
          {title} <span className="font-normal text-stone-500">({subset.length})</span>
        </h3>
        <div className="hidden max-h-[min(28rem,55vh)] overflow-auto rounded-lg border border-stone-200 md:block">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-stone-700">Item / batch</th>
                <th className="px-3 py-2 text-left font-semibold text-stone-700">Expiry</th>
                <th className="px-3 py-2 text-right font-semibold text-stone-700">Counted</th>
                <th className="min-w-[8rem] px-3 py-2 text-left font-semibold text-stone-700">Line remark</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {subset.map((r) => {
                const missing = parseCount(r.countedStr) === null;
                return (
                  <tr key={r.id} className={missing ? 'bg-amber-50/40' : 'hover:bg-stone-50'}>
                    <td className="px-3 py-2 text-stone-900">
                      <div className="font-medium">{r.item_label}</div>
                      {r.item_detail ? <div className="text-xs text-stone-500">{r.item_detail}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums text-stone-600">{r.expiry_date ?? '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`Counted ${r.item_label}`}
                        value={r.countedStr}
                        onChange={(e) => setRow(r.id, { countedStr: e.target.value })}
                        className="w-24 rounded border border-stone-300 px-2 py-1 text-right text-sm tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={r.remark}
                        onChange={(e) => setRow(r.id, { remark: e.target.value })}
                        placeholder="Optional"
                        autoComplete="off"
                        className="w-full min-w-[6rem] rounded border border-stone-300 px-2 py-1 text-xs"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="max-h-[min(28rem,55vh)] space-y-3 overflow-y-auto overscroll-y-contain md:hidden">
          {subset.map((r) => (
            <div key={r.id} className="panel p-3">
              <p className="font-medium leading-snug text-stone-900">{r.item_label}</p>
              <p className="mt-0.5 text-xs text-stone-500">
                {[r.item_detail, r.expiry_date ? `Exp ${r.expiry_date}` : ''].filter(Boolean).join(' · ')}
              </p>
              <label className="mt-2 block text-xs font-medium text-stone-600" htmlFor={`count-${r.id}`}>
                Counted quantity
              </label>
              <input
                id={`count-${r.id}`}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                autoComplete="off"
                value={r.countedStr}
                onChange={(e) => setRow(r.id, { countedStr: e.target.value })}
                className="min-h-11 w-full rounded-lg border border-stone-300 px-3 py-2 text-right text-base tabular-nums"
              />
              <input
                value={r.remark}
                onChange={(e) => setRow(r.id, { remark: e.target.value })}
                placeholder="Line remark (optional)"
                autoComplete="off"
                className="mt-2 min-h-11 w-full rounded-lg border border-stone-300 px-3 py-2 text-base"
              />
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="rounded-lg border border-amber-100 bg-amber-50/80 px-3 py-2.5 text-xs text-amber-950 sm:px-4 sm:py-3 sm:text-sm">
        <span className="inline-flex items-center gap-2 font-semibold text-amber-900">
          <ClipboardList size={18} className="size-[1.125rem] shrink-0 sm:size-[18px]" />
          Outlet stock take — blind count
        </span>
        <p className="mt-1.5 leading-relaxed text-amber-900/90">
          Count every batch physically and enter what you see. System quantities and variance are never shown while
          counting; while a count is open, this outlet&apos;s stock levels are hidden from everyone except admins. Variance is
          worked out by the server when you submit and is visible to admins only.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-4 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-stone-800">{session ? 'Count in progress' : 'New count'}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-medium text-stone-600">Outlet</label>
              {lockedOutletId ? (
                <p className="min-h-11 w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-base text-stone-800 sm:min-h-0 sm:py-2 sm:text-sm">
                  {(outletName || outlets.find((o) => o.id === lockedOutletId)?.name) ?? 'Your outlet'}
                </p>
              ) : (
                <select
                  value={outletId}
                  onChange={(e) => setOutletId(e.target.value)}
                  disabled={submitting}
                  className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base sm:min-h-0 sm:py-2 sm:text-sm"
                >
                  <option value="">Select outlet…</option>
                  {outlets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-medium text-stone-600">Count date</label>
              {session ? (
                <p className="min-h-11 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-base tabular-nums sm:min-h-0 sm:py-2 sm:text-sm">
                  {session.count_date}
                </p>
              ) : (
                <input
                  type="date"
                  value={countDate}
                  onChange={(e) => setCountDate(e.target.value)}
                  className="min-h-11 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-base sm:min-h-0 sm:w-auto sm:py-2 sm:text-sm"
                />
              )}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">Session notes (optional)</label>
            <input
              value={sessionNotes}
              onChange={(e) => setSessionNotes(e.target.value)}
              placeholder="e.g. Month-end count, cycle count chiller…"
              autoComplete="off"
              className="min-h-11 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-base sm:min-h-0 sm:py-2 sm:text-sm"
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

          {adminVariance && adminVariance.length > 0 ? (
            <div className="rounded-lg border border-stone-200">
              <p className="border-b border-stone-200 bg-stone-50 px-3 py-2 text-xs font-semibold text-stone-700">
                Variance (admin only) — counted minus system at submission. “Moved” = sales, receipts or waste
                posted while the count was open; a variance close to −moved usually means a sale was posted for
                goods sold before they were counted.
              </p>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-stone-100">
                  {adminVariance.map((v, i) => (
                    <tr key={`${v.label}-${i}`}>
                      <td className="px-3 py-1.5 text-stone-800">{v.label}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-stone-500">sys {v.system}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-stone-500">cnt {v.counted}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-stone-500">
                        {v.moved ? `moved ${v.moved > 0 ? '+' : ''}${v.moved} (open ${v.atOpen ?? 0})` : ''}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${v.variance !== 0 ? 'font-semibold text-amber-800' : 'text-stone-500'}`}
                      >
                        {v.variance > 0 ? `+${v.variance}` : v.variance}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {!outletId ? (
            <p className="text-sm text-stone-500">Choose an outlet.</p>
          ) : loadingSheet ? (
            <div className="py-8 text-center text-sm text-stone-400">Loading count sheet…</div>
          ) : !session ? (
            <StickyActions>
              <button type="button" onClick={() => void handleStart()} disabled={submitting} className="btn-primary w-full md:w-auto">
                {submitting ? 'Starting…' : 'Start blind count'}
              </button>
            </StickyActions>
          ) : rows.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-amber-800">No batches on this outlet&apos;s count sheet. Cancel this count.</p>
              <button type="button" onClick={() => void handleCancel()} disabled={submitting} className="btn-secondary">
                Cancel count
              </button>
            </div>
          ) : (
            <>
              <p className="inline-flex items-center gap-1.5 text-xs text-stone-500">
                <EyeOff size={14} aria-hidden /> Quantities hidden. {countedCount} of {rows.length} lines counted.
              </p>
              {renderSection('Finished goods', fgRows)}
              {renderSection('Ingredients', rmRows)}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={() => void handleCancel()} disabled={submitting} className="btn-secondary w-full md:w-auto">
                  Cancel count
                </button>
                <StickyActions>
                  <button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit} className="btn-primary w-full md:w-auto">
                    {submitting ? 'Submitting…' : 'Submit count'}
                  </button>
                </StickyActions>
              </div>
            </>
          )}
        </div>

        <div className="panel space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-stone-800">Recent sessions</h2>
            {loadingSessions && <span className="text-xs text-stone-400">Loading…</span>}
          </div>
          <p className="text-xs leading-relaxed text-stone-500">
            {outletId ? 'Filtered to the selected outlet. ' : 'All outlets (latest 100). '}
            {isAdmin ? 'CSV export includes system quantity, variance and remarks.' : 'Variance detail is available to admins.'}
          </p>
          <ul className="max-h-[min(28rem,55vh)] space-y-2 overflow-y-auto overscroll-y-contain text-sm sm:max-h-[28rem]">
            {sessions.length === 0 ? (
              <li className="text-stone-400">No sessions yet.</li>
            ) : (
              sessions.map((s) => {
                const st = sessionStatusLabel(s);
                const posted = s.status == null || s.status === 'posted';
                return (
                  <li
                    key={s.id}
                    className="flex flex-col gap-2 rounded-lg border border-stone-100 bg-stone-50/80 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium text-stone-900">
                        {s.outlet?.name ?? 'Outlet'}{' '}
                        <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${st.cls}`}>{st.text}</span>
                      </p>
                      <p className="mt-0.5 break-words text-xs text-stone-500">
                        {s.count_date}
                        {posted ? ` · posted ${new Date(s.posted_at).toLocaleString()}` : ''}
                        {s.notes ? ` · ${s.notes}` : ''}
                      </p>
                    </div>
                    {isAdmin && posted ? (
                      <button
                        type="button"
                        onClick={() => void exportSession(s.id)}
                        disabled={exportingId === s.id}
                        className="inline-flex min-h-10 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50 sm:min-h-0 sm:w-auto sm:py-1.5"
                      >
                        <Download size={14} className="shrink-0" aria-hidden />
                        {exportingId === s.id ? '…' : 'CSV'}
                      </button>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
