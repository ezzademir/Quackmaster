import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CircleDollarSign, Package, Scale } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { Button, EmptyState, PageHeader, StatCard } from '../components/ui';
import { supabase } from '../utils/supabase';
import { formatDateForInput, getLast7Days, type DateRange } from '../utils/dateRange';
import {
  STOREHUB_REPORTS,
  invokeStorehub,
  type StorehubReportResult,
  type StorehubDiffStatus,
} from '../utils/storehubSync';

type StoreOpt = { id: string; name: string };
type RowFilter = 'gaps' | 'all';

function periodIso(range: DateRange | null): { from: string; to: string } {
  if (range) {
    return { from: formatDateForInput(range.start), to: formatDateForInput(range.end) };
  }
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 2);
  return { from: formatDateForInput(from), to: formatDateForInput(to) };
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
  missing_in_dashboard: 'Missing in QMERP',
  extra_in_dashboard: 'Only in QMERP',
  pos_only: 'SHPOS only',
};

const STATUS_CLASS: Record<StorehubDiffStatus, string> = {
  match: 'bg-emerald-100 text-emerald-800',
  qty_mismatch: 'bg-amber-100 text-amber-900',
  missing_in_dashboard: 'bg-red-100 text-red-800',
  extra_in_dashboard: 'bg-sky-100 text-sky-800',
  pos_only: 'bg-stone-100 text-stone-600',
};

const groups = [...new Set(STOREHUB_REPORTS.map((r) => r.group))];

const fieldClass = 'min-w-[9rem] rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm';

export function PosCompare() {
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [reportId, setReportId] = useState(STOREHUB_REPORTS.find((r) => r.available)?.id ?? 'sales_over_time');
  const [storeId, setStoreId] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | null>(() => getLast7Days());
  const [viewBy, setViewBy] = useState<'day' | 'week' | 'month' | 'hour'>('day');
  const [busy, setBusy] = useState(false);
  const [rowFilter, setRowFilter] = useState<RowFilter>('gaps');
  const [result, setResult] = useState<StorehubReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = STOREHUB_REPORTS.find((r) => r.id === reportId);
  const snapshot = Boolean(selected?.snapshot);
  const canRun = Boolean(selected?.available);

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
    if (!canRun) return;
    setBusy(true);
    setError(null);
    setRowFilter('gaps');
    const period = snapshot ? {} : periodIso(dateRange);
    const { data, error: err } = await invokeStorehub<StorehubReportResult>('report', {
      report: reportId,
      ...period,
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
    if (data?.posOnly) setRowFilter('all');
  }

  const gapCount = result
    ? result.totals.qty_mismatch + result.totals.missing_in_dashboard + result.totals.extra_in_dashboard
    : 0;

  const visibleRows = useMemo(() => {
    if (!result) return [];
    if (rowFilter === 'all' || result.posOnly) return result.rows;
    return result.rows.filter((r) => r.status !== 'match' && r.status !== 'pos_only');
  }, [result, rowFilter]);

  const unavailable = STOREHUB_REPORTS.filter((r) => !r.available);

  return (
    <div className="space-y-6">
      <PageHeader
        title="SHPOS vs QMERP"
        description="Compare StoreHub POS tickets to Quackmaster journals. Units should match; ringgit stays on POS."
        filters={
          <>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-stone-500">Report</span>
              <select
                value={reportId}
                onChange={(e) => {
                  setReportId(e.target.value);
                  setResult(null);
                  setError(null);
                }}
                className={`${fieldClass} min-w-[16rem]`}
              >
                {groups.map((group) => (
                  <optgroup key={group} label={group}>
                    {STOREHUB_REPORTS.filter((r) => r.group === group).map((r) => (
                      <option key={r.id} value={r.id} disabled={!r.available}>
                        {r.label}
                        {r.available ? '' : ' (not in API)'}
                        {r.posOnly ? ' · SHPOS only' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-stone-500">Store</span>
              <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={fieldClass}>
                <option value="">All mapped stores</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className={snapshot ? 'hidden' : ''}>
              <DateFilter
                defaultType="last7Days"
                onFilterChange={(range) => setDateRange(range)}
                hint="Applies to POS tickets and QMERP journals. All time is the last 2 years."
              />
            </div>
            {reportId === 'sales_over_time' && (
              <label className="text-sm">
                <span className="mb-1 block text-xs text-stone-500">View by</span>
                <select
                  value={viewBy}
                  onChange={(e) => setViewBy(e.target.value as typeof viewBy)}
                  className={fieldClass}
                >
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                  <option value="hour">Hour</option>
                </select>
              </label>
            )}
            <Button disabled={busy || !canRun} onClick={() => void run()}>
              {busy ? 'Comparing…' : snapshot ? 'Compare now' : 'Compare'}
            </Button>
          </>
        }
      />

      {selected && !selected.available && (
        <p className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-2 text-sm text-stone-600">
          {selected.unavailableReason}
        </p>
      )}

      {stores.length === 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Map StoreHub stores in{' '}
          <Link to="/settings" className="font-medium underline">
            Settings → StoreHub POS sync
          </Link>{' '}
          before comparing.
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
      )}

      {!result && !error && !busy && (
        <div className="panel">
          <EmptyState
            title="Nothing compared yet"
            description="Choose a StoreHub report, set the period, then Compare. Gaps show tickets or units that are not in Quackmaster."
          />
        </div>
      )}

      {result && !result.error && (
        <div className="space-y-4">
          {result.notice && <p className="text-sm text-stone-500">{result.notice}</p>}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              icon={<Package size={18} />}
              tone="brand"
              label="SHPOS qty"
              value={fmtQty(result.totals.posQty)}
              sub={result.snapshot ? 'On hand now' : 'Units on POS tickets'}
            />
            <StatCard
              icon={<CircleDollarSign size={18} />}
              label="SHPOS RM"
              value={fmtRm(result.totals.posRm)}
              sub="POS only"
            />
            <StatCard
              icon={<Scale size={18} />}
              label="QMERP qty"
              value={result.posOnly ? '—' : fmtQty(result.totals.dashQty)}
              sub={result.posOnly ? 'Not stored in journals' : 'Posted journal units'}
            />
            <StatCard
              icon={<AlertTriangle size={18} />}
              tone={gapCount > 0 ? 'danger' : 'muted'}
              label="Gaps"
              value={String(gapCount)}
              sub={`${result.totals.match} match · ${result.totals.pos_only} SHPOS only`}
            />
          </div>

          {result.rows.length === 0 ? (
            <div className="panel">
              <EmptyState title="No rows in this range" description="Try a wider date range or another store." />
            </div>
          ) : (
            <div className="panel overflow-x-auto">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 px-4 py-2">
                <p className="text-sm font-medium text-stone-800">
                  {selected?.label ?? 'Report'}
                  <span className="ml-2 font-normal text-stone-400">
                    {result.snapshot ? 'Snapshot' : `${result.from} → ${result.to}`}
                    {result.viewBy ? ` · ${result.viewBy}` : ''}
                  </span>
                </p>
                {!result.posOnly && gapCount > 0 && gapCount < result.rows.length && (
                  <div className="flex rounded-lg border border-stone-200 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setRowFilter('gaps')}
                      className={`rounded-md px-2.5 py-1 font-medium ${
                        rowFilter === 'gaps' ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-50'
                      }`}
                    >
                      Gaps ({gapCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setRowFilter('all')}
                      className={`rounded-md px-2.5 py-1 font-medium ${
                        rowFilter === 'all' ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-50'
                      }`}
                    >
                      All ({result.rows.length})
                    </button>
                  </div>
                )}
              </div>
              <table className="data-table min-w-[40rem]">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th className="text-right">SHPOS qty</th>
                    <th className="text-right">SHPOS RM</th>
                    <th className="text-right">QMERP qty</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {visibleRows.map((row) => (
                    <tr
                      key={row.key}
                      className={
                        row.status === 'qty_mismatch' || row.status === 'missing_in_dashboard'
                          ? 'bg-amber-50/60'
                          : 'hover:bg-stone-50'
                      }
                    >
                      <td>{row.label}</td>
                      <td className="text-right tabular-nums">{fmtQty(row.posQty)}</td>
                      <td className="text-right tabular-nums">{fmtRm(row.posRm)}</td>
                      <td className="text-right tabular-nums">{fmtQty(row.dashQty)}</td>
                      <td>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[row.status]}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rowFilter === 'gaps' && !result.posOnly && visibleRows.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-stone-500">No gaps in this report.</p>
              )}
            </div>
          )}

          {unavailable.length > 0 && (
            <p className="text-xs text-stone-400">
              Not in the StoreHub API: {unavailable.map((r) => r.label).join(', ')}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
