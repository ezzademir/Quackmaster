import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Scale, Download, AlertTriangle } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { supabase } from '../utils/supabase';
import type { Outlet } from '../types';
import type { DateRange } from '../utils/dateRange';
import {
  reconcileOutletStock,
  getOutletBalanceAsOf,
  fetchOutletMovements,
  movementsToCsv,
  defaultReconcileRange,
  type ReconcileOutletStockResult,
  type BalanceAsOfResult,
} from '../utils/reconciliationService';
import { formatDateForInput } from '../utils/dateRange';

function fmt(n: number | undefined): string {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function MovementRow({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  const negative = value < 0;
  return (
    <div className={`flex items-center justify-between rounded-lg border px-4 py-3 ${emphasize ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <span className="text-sm text-gray-700">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${negative ? 'text-red-700' : 'text-gray-900'}`}>
        {value >= 0 ? '+' : ''}{fmt(value)}
      </span>
    </div>
  );
}

export function Reconciliation() {
  const [searchParams] = useSearchParams();
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState(searchParams.get('outlet') ?? '');
  const [dateRange, setDateRange] = useState<DateRange | null>(defaultReconcileRange());
  const [includeRm, setIncludeRm] = useState(true);
  const [asOfDate, setAsOfDate] = useState(formatDateForInput(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReconcileOutletStockResult | null>(null);
  const [asOfResult, setAsOfResult] = useState<BalanceAsOfResult | null>(null);

  useEffect(() => {
    void (async () => {
      const { data, error: e } = await supabase.from('outlets').select('*').order('name');
      if (e) setError(e.message);
      setOutlets(data ?? []);
      setOutletId((prev) => prev || data?.[0]?.id || '');
    })();
  }, []);

  const load = useCallback(async () => {
    if (!outletId || !dateRange) return;
    setError(null);
    setLoading(true);
    try {
      const [recon, asOf] = await Promise.all([
        reconcileOutletStock({
          outletId,
          from: dateRange.start,
          to: dateRange.end,
          includeRawMaterials: includeRm,
        }),
        getOutletBalanceAsOf({
          outletId,
          asOf: new Date(asOfDate + 'T12:00:00'),
          includeRawMaterials: includeRm,
        }),
      ]);
      if (!recon.success) throw new Error(recon.error ?? 'Reconciliation failed');
      setResult(recon);
      setAsOfResult(asOf.success ? asOf : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reconciliation');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [outletId, dateRange, includeRm, asOfDate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportMovementsCsv() {
    if (!outletId || !dateRange) return;
    const outletName = outlets.find((o) => o.id === outletId)?.name ?? outletId;
    const rows = await fetchOutletMovements({ outletId, from: dateRange.start, to: dateRange.end });
    const csv = movementsToCsv(rows, outletName);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `movements-${outletName.replace(/\s+/g, '-')}-${formatDateForInput(dateRange.start)}-${formatDateForInput(dateRange.end)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const variance = Number(result?.unexplained_variance ?? 0);
  const varianceBad = Math.abs(variance) > 0.001;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Scale size={24} className="text-teal-600" />
            Stock Reconciliation
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Movement equation for one outlet over a period. Compare computed closing to live on-hand; use with physical stock takes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/audit" className="text-sm font-medium text-teal-600 hover:text-teal-700">
            Cross-outlet audit dashboard →
          </Link>
          <button
            type="button"
            onClick={() => void exportMovementsCsv()}
            disabled={!outletId || !dateRange}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Download size={16} /> Export movements CSV
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Outlet</label>
          <select
            value={outletId}
            onChange={(e) => setOutletId(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>
        <DateFilter
          onFilterChange={(range) => setDateRange(range ?? defaultReconcileRange())}
          hint="Reconciliation period (movement business dates)."
        />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={includeRm} onChange={(e) => setIncludeRm(e.target.checked)} />
          Include raw materials
        </label>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Balance as of</label>
          <input
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">Loading reconciliation…</div>
      ) : result?.success ? (
        <>
          {varianceBad && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">Unexplained variance: {fmt(variance)} units</p>
                <p className="mt-1 text-amber-800">
                  Live on-hand differs from opening + movements. Run a stock take or review the movement ledger.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-5">
              <h2 className="text-sm font-semibold text-gray-900">Movement equation</h2>
              <p className="text-xs text-gray-500">
                Period: {result.period_from} → {result.period_to}
              </p>
              <MovementRow label="Opening (before period)" value={Number(result.opening_qoh ?? 0)} />
              <MovementRow label="Supply received" value={Number(result.supply_in ?? 0)} />
              <MovementRow label="Transfers in" value={Number(result.transfers_in ?? 0)} />
              <MovementRow label="Transfers out" value={Number(result.transfers_out ?? 0)} />
              <MovementRow label="Sales" value={Number(result.sales ?? 0)} />
              <MovementRow label="Waste" value={Number(result.waste ?? 0)} />
              <MovementRow label="Stock take adjustments" value={Number(result.stock_take_adjustments ?? 0)} />
              <MovementRow label="Reversals" value={Number(result.reversals ?? 0)} />
              <MovementRow label="Computed closing" value={Number(result.computed_closing ?? 0)} emphasize />
              <MovementRow label="Live on-hand now" value={Number(result.live_on_hand ?? 0)} emphasize />
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-gray-900">In transit (not in outlet QOH)</h2>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-600">Supply dispatched, awaiting receipt</dt>
                    <dd className="font-semibold tabular-nums">{fmt(result.in_transit_supply)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-600">Inter-outlet transfer in transit</dt>
                    <dd className="font-semibold tabular-nums">{fmt(result.in_transit_transfer)}</dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-gray-900">Last stock take</h2>
                {result.last_stock_take && result.last_stock_take !== null && typeof result.last_stock_take === 'object' ? (
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-gray-600">Count date</dt>
                      <dd>{String(result.last_stock_take.count_date ?? '—')}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-gray-600">Total variance</dt>
                      <dd className="font-semibold tabular-nums">{fmt(Number(result.last_stock_take.total_variance ?? 0))}</dd>
                    </div>
                    <p className="text-xs text-gray-500">
                      <Link to="/inventory" className="text-teal-600 hover:underline">Inventory → Outlet stock take</Link> for session history.
                    </p>
                  </dl>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">No stock take recorded for this outlet.</p>
                )}
              </div>

              {asOfResult?.success && (
                <div className="rounded-xl border border-teal-200 bg-teal-50/80 p-5">
                  <h2 className="text-sm font-semibold text-teal-900">Balance as of {asOfResult.as_of}</h2>
                  <p className="mt-2 text-2xl font-bold tabular-nums text-teal-900">{fmt(asOfResult.total_on_hand)} units</p>
                  <p className="mt-1 text-xs text-teal-800">
                    Snapshot base {fmt(asOfResult.from_snapshot_base)} + movements {fmt(asOfResult.movements_delta)}
                    {asOfResult.snapshot_date ? ` (from snapshot ${asOfResult.snapshot_date})` : ' (movements only)'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
