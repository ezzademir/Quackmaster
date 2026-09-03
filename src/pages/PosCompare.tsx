import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, PageHeader, StatCard } from '../components/ui';
import { supabase } from '../utils/supabase';
import {
  STOREHUB_REPORTS,
  invokeStorehub,
  type StorehubReportResult,
  type StorehubDiffStatus,
} from '../utils/storehubSync';

type StoreOpt = { id: string; name: string };

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtQty(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtRm(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_LABEL: Record<StorehubDiffStatus, string> = {
  match: 'Match',
  qty_mismatch: 'Qty differs',
  missing_in_dashboard: 'Missing in dashboard',
  extra_in_dashboard: 'Only in dashboard',
  pos_only: 'POS only',
};

const STATUS_CLASS: Record<StorehubDiffStatus, string> = {
  match: 'bg-emerald-100 text-emerald-800',
  qty_mismatch: 'bg-amber-100 text-amber-900',
  missing_in_dashboard: 'bg-red-100 text-red-800',
  extra_in_dashboard: 'bg-sky-100 text-sky-900',
  pos_only: 'bg-stone-100 text-stone-600',
};

const groups = [...new Set(STOREHUB_REPORTS.map((r) => r.group))];

export function PosCompare() {
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [reportId, setReportId] = useState(STOREHUB_REPORTS.find((r) => r.available)?.id ?? 'sales_over_time');
  const [storeId, setStoreId] = useState('');
  const [from, setFrom] = useState(daysAgoIso(6));
  const [to, setTo] = useState(todayIso());
  const [viewBy, setViewBy] = useState<'day' | 'week' | 'month' | 'hour'>('day');
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [result, setResult] = useState<StorehubReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = STOREHUB_REPORTS.find((r) => r.id === reportId);
  const snapshot = Boolean(selected?.snapshot);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('storehub_store_map')
        .select('storehub_store_id, storehub_store_name')
        .order('storehub_store_name');
      setStores(
        (data ?? []).map((r) => ({
          id: r.storehub_store_id as string,
          name: (r.storehub_store_name as string) || (r.storehub_store_id as string),
        }))
      );
    })();
  }, []);

  async function run() {
    if (!selected?.available) return;
    setBusy(true);
    setError(null);
    setShowAll(false);
    const { data, error: err } = await invokeStorehub<StorehubReportResult>('report', {
      report: reportId,
      from: snapshot ? undefined : from,
      to: snapshot ? undefined : to,
      storeId: storeId || undefined,
      viewBy: reportId === 'sales_over_time' ? viewBy : undefined,
    });
    setBusy(false);
    if (err && !data) {
      setResult(null);
      setError(err);
      return;
    }
    setResult(data);
    setError(data?.error || err);
  }

  const mismatchRows = useMemo(
    () => (result?.rows ?? []).filter((r) => r.status !== 'match' && r.status !== 'pos_only'),
    [result]
  );
  const visibleRows = result
    ? showAll || mismatchRows.length === 0 || result.posOnly
      ? result.rows
      : mismatchRows
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="POS vs dashboard"
        description="Rebuild a StoreHub BackOffice report from the POS API and flag rows that are missing or different in Quackmaster journals."
      />

      <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm space-y-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-500">Choose a StoreHub report</p>
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group}>
                <p className="mb-1.5 text-sm font-medium text-stone-800">{group}</p>
                <div className="flex flex-wrap gap-2">
                  {STOREHUB_REPORTS.filter((r) => r.group === group).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      disabled={!r.available}
                      title={r.unavailableReason}
                      onClick={() => setReportId(r.id)}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${
                        r.id === reportId
                          ? 'border-brand-700 bg-brand-700 text-white'
                          : r.available
                            ? 'border-stone-200 bg-white text-stone-800 hover:border-brand-400'
                            : 'cursor-not-allowed border-stone-100 bg-stone-50 text-stone-400'
                      }`}
                    >
                      {r.label}
                      {r.posOnly ? <span className="ml-1 text-[10px] opacity-80">POS</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {selected && !selected.available && (
            <p className="mt-2 text-sm text-stone-500">{selected.unavailableReason}</p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3 border-t border-stone-100 pt-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-stone-500">Store</span>
            <select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm"
            >
              <option value="">All mapped stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {!snapshot && (
            <>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-stone-500">From</span>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-stone-500">To</span>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm"
                />
              </label>
            </>
          )}
          {reportId === 'sales_over_time' && (
            <label className="text-sm">
              <span className="mb-1 block text-xs text-stone-500">View by</span>
              <select
                value={viewBy}
                onChange={(e) => setViewBy(e.target.value as typeof viewBy)}
                className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm"
              >
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
                <option value="hour">Hour of day</option>
              </select>
            </label>
          )}
          <Button disabled={busy || !selected?.available} onClick={() => void run()}>
            {busy ? 'Comparing…' : snapshot ? 'Compare snapshot' : 'Compare'}
          </Button>
        </div>
        {stores.length === 0 && (
          <p className="text-sm text-amber-800">
            No stores mapped yet.{' '}
            <Link to="/settings" className="underline">
              Settings → StoreHub POS sync
            </Link>{' '}
            to load the catalog and save maps.
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</div>
      )}

      {result && !result.error && (
        <>
          {result.notice && <p className="text-sm text-stone-500">{result.notice}</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="POS qty" value={fmtQty(result.totals.posQty)} sub={result.snapshot ? 'On hand now' : undefined} />
            <StatCard label="POS RM" value={fmtRm(result.totals.posRm)} />
            <StatCard label="Dashboard qty" value={result.posOnly ? '—' : fmtQty(result.totals.dashQty)} />
            <StatCard
              label="Mismatches"
              value={String(
                result.totals.qty_mismatch + result.totals.missing_in_dashboard + result.totals.extra_in_dashboard
              )}
              sub={`${result.totals.match} match · ${result.totals.pos_only} POS-only`}
            />
          </div>

          {result.rows.length === 0 ? (
            <div className="rounded-xl border border-stone-200 bg-white">
              <EmptyState title="No rows in this range" description="Try a wider date range or another store." />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Row</th>
                    <th className="px-3 py-2 font-medium text-right">POS qty</th>
                    <th className="px-3 py-2 font-medium text-right">POS RM</th>
                    <th className="px-3 py-2 font-medium text-right">Dashboard qty</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {visibleRows.map((row) => (
                    <tr key={row.key}>
                      <td className="px-3 py-2 text-stone-800">{row.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(row.posQty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtRm(row.posRm)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(row.dashQty)}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[row.status]}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mismatchRows.length > 0 && mismatchRows.length < result.rows.length && !result.posOnly && (
                <div className="border-t border-stone-100 px-3 py-2 text-xs text-stone-500">
                  {showAll
                    ? `Showing all ${result.rows.length} rows.`
                    : `Showing ${mismatchRows.length} mismatch rows of ${result.rows.length}.`}{' '}
                  <button type="button" className="underline" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show mismatches only' : 'Show all rows'}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
