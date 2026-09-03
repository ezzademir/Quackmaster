import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, CircleDollarSign, Package, Scale, Truck } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { Button, EmptyState, PageHeader, StatCard } from '../components/ui';
import { supabase } from '../utils/supabase';
import { formatDateForInput, getLast7Days, type DateRange } from '../utils/dateRange';
import {
  STOREHUB_REPORTS,
  invokeStorehub,
  type StorehubReportResult,
  type StorehubDiffStatus,
  type StorehubReportRow,
} from '../utils/storehubSync';

type StoreOpt = { id: string; name: string };
type RowFilter = 'gaps' | 'all';
type ProductPick = { sku: string; name: string; fg: boolean };

const SKU_PICK_KEY = 'qm-sold-vs-supplied-skus';

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

const fieldClass = 'w-full min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm sm:w-auto sm:min-w-[9rem]';

const PERIOD_BUCKET_REPORTS = new Set(['sales_over_time', 'sales_by_product', 'sales_by_sku', 'sales_by_category']);

function readStoredSkus(): string[] | null {
  try {
    const raw = localStorage.getItem(SKU_PICK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((s) => String(s).trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export function PosCompare() {
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [reportId, setReportId] = useState('sold_vs_supplied');
  const [storeId, setStoreId] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | null>(() => getLast7Days());
  const [viewBy, setViewBy] = useState<'day' | 'week' | 'month' | 'hour'>('day');
  const [busy, setBusy] = useState(false);
  const [rowFilter, setRowFilter] = useState<RowFilter>('gaps');
  const [result, setResult] = useState<StorehubReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<ProductPick[]>([]);
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [pickerReady, setPickerReady] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const selected = STOREHUB_REPORTS.find((r) => r.id === reportId);
  const snapshot = Boolean(selected?.snapshot);
  const tally = reportId === 'sold_vs_supplied';
  const canRun = Boolean(selected?.available) && (!tally || selectedSkus.length > 0);
  const showViewBy = PERIOD_BUCKET_REPORTS.has(reportId);
  const showHour = reportId === 'sales_over_time';
  const effectiveViewBy = reportId !== 'sales_over_time' && viewBy === 'hour' ? 'day' : viewBy;

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

  useEffect(() => {
    void (async () => {
      const [{ data: maps }, { data: recipes }] = await Promise.all([
        supabase
          .from('storehub_product_map')
          .select('quackmaster_sku, storehub_name, storehub_sku')
          .order('storehub_name'),
        supabase.from('recipes').select('default_product_batch'),
      ]);
      const fg = new Set(
        (recipes ?? [])
          .map((r) => String(r.default_product_batch ?? '').trim())
          .filter(Boolean)
      );
      const bySku = new Map<string, ProductPick>();
      for (const row of maps ?? []) {
        const sku = String(row.quackmaster_sku ?? '').trim();
        if (!sku) continue;
        const name = (row.storehub_name as string) || (row.storehub_sku as string) || sku;
        const cur = bySku.get(sku);
        if (cur) {
          if (!cur.name.includes(name)) cur.name = `${cur.name}, ${name}`;
        } else {
          bySku.set(sku, { sku, name, fg: fg.has(sku) });
        }
      }
      const list = [...bySku.values()].sort((a, b) => a.name.localeCompare(b.name));
      setPicks(list);
      const stored = readStoredSkus();
      if (stored) {
        const allowed = new Set(list.map((p) => p.sku));
        setSelectedSkus(stored.filter((s) => allowed.has(s)));
      } else {
        setSelectedSkus(list.filter((p) => p.fg).map((p) => p.sku));
      }
      setPickerReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!pickerReady) return;
    localStorage.setItem(SKU_PICK_KEY, JSON.stringify(selectedSkus));
  }, [pickerReady, selectedSkus]);

  async function run() {
    if (!canRun) return;
    if (tally && selectedSkus.length === 0) {
      setError('Pick at least one product.');
      return;
    }
    setBusy(true);
    setError(null);
    setRowFilter(tally ? 'all' : 'gaps');
    setExpanded(new Set());
    const period = snapshot ? {} : periodIso(dateRange);
    const { data, error: err } = await invokeStorehub<StorehubReportResult>('report', {
      report: reportId,
      ...period,
      storeId: storeId || undefined,
      viewBy: showViewBy ? effectiveViewBy : undefined,
      skus: tally ? selectedSkus : undefined,
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
    if (rowFilter === 'all' || result.posOnly || tally) {
      if (rowFilter === 'gaps' && tally) {
        return result.rows.filter((r) => r.status !== 'match' && r.status !== 'pos_only');
      }
      return result.rows;
    }
    return result.rows.filter((r) => r.status !== 'match' && r.status !== 'pos_only');
  }, [result, rowFilter, tally]);

  const unavailable = STOREHUB_REPORTS.filter((r) => !r.available);
  const visiblePicks = picks.filter((p) => {
    if (!pickQuery.trim()) return true;
    const q = pickQuery.trim().toLowerCase();
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
  });

  function toggleSku(sku: string) {
    setSelectedSkus((prev) => (prev.includes(sku) ? prev.filter((s) => s !== sku) : [...prev, sku]));
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="SHPOS vs QMERP"
        description={
          tally
            ? 'Sold vs supplied: pick products, then compare POS sold to ERP sold and hub dispatch (with lots).'
            : 'Compare StoreHub POS tickets to Quackmaster journals. Units should match; ringgit stays on POS.'
        }
        filters={
          <>
            <label className="w-full min-w-0 text-sm sm:w-auto">
              <span className="mb-1 block text-xs text-stone-500">Report</span>
              <select
                value={reportId}
                onChange={(e) => {
                  const next = e.target.value;
                  setReportId(next);
                  if (next !== 'sales_over_time' && viewBy === 'hour') setViewBy('day');
                  setResult(null);
                  setError(null);
                }}
                className={`${fieldClass} sm:min-w-[16rem]`}
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
            <label className="w-full min-w-0 text-sm sm:w-auto">
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
            <div className={snapshot ? 'hidden' : 'w-full min-w-0 sm:w-auto'}>
              <DateFilter
                defaultType="last7Days"
                onFilterChange={(range) => setDateRange(range)}
                hint={
                  tally
                    ? 'Applies to POS tickets, posted Outlet sales, and hub dispatch. All time is the last 2 years.'
                    : 'Applies to POS tickets and QMERP journals. All time is the last 2 years.'
                }
              />
            </div>
            {showViewBy && (
              <label className="w-full min-w-0 text-sm sm:w-auto">
                <span className="mb-1 block text-xs text-stone-500">View by</span>
                <select
                  value={effectiveViewBy}
                  onChange={(e) => setViewBy(e.target.value as typeof viewBy)}
                  className={fieldClass}
                >
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                  {showHour && <option value="hour">Hour</option>}
                </select>
              </label>
            )}
            <Button className="w-full sm:w-auto" disabled={busy || !canRun} onClick={() => void run()}>
              {busy ? 'Comparing…' : snapshot ? 'Compare now' : 'Compare'}
            </Button>
          </>
        }
      />

      {tally && (
        <div className="panel space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-stone-800">
              Products on this tally
              <span className="ml-2 font-normal text-stone-400">
                {selectedSkus.length} selected
              </span>
            </p>
            <div className="flex flex-wrap gap-2 text-xs">
              <button
                type="button"
                className="rounded-md border border-stone-200 px-2 py-1 text-stone-600 hover:bg-stone-50"
                onClick={() => setSelectedSkus(picks.filter((p) => p.fg).map((p) => p.sku))}
              >
                Finished goods
              </button>
              <button
                type="button"
                className="rounded-md border border-stone-200 px-2 py-1 text-stone-600 hover:bg-stone-50"
                onClick={() => setSelectedSkus(picks.map((p) => p.sku))}
              >
                All mapped
              </button>
              <button
                type="button"
                className="rounded-md border border-stone-200 px-2 py-1 text-stone-600 hover:bg-stone-50"
                onClick={() => setSelectedSkus([])}
              >
                None
              </button>
            </div>
          </div>
          <input
            type="search"
            value={pickQuery}
            onChange={(e) => setPickQuery(e.target.value)}
            placeholder="Find product or SKU"
            className={`${fieldClass} w-full max-w-sm`}
          />
          {picks.length === 0 ? (
            <p className="text-sm text-stone-500">
              Map StoreHub products to recipe SKUs in{' '}
              <Link to="/settings" className="font-medium underline">
                Settings
              </Link>{' '}
              first.
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-stone-100">
              {visiblePicks.map((p) => (
                <label
                  key={p.sku}
                  className="flex cursor-pointer items-center gap-2 border-b border-stone-50 px-3 py-1.5 text-sm last:border-b-0 hover:bg-stone-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedSkus.includes(p.sku)}
                    onChange={() => toggleSku(p.sku)}
                  />
                  <span className="font-medium text-stone-800">{p.name}</span>
                  <span className="text-stone-400">{p.sku}</span>
                  {p.fg && <span className="ml-auto text-[10px] uppercase tracking-wide text-stone-400">FG</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

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
            description={
              tally
                ? 'Tick the products to watch, set the period, then Compare. Leftover is supplied minus posted Outlet sales.'
                : 'Choose a StoreHub report, set the period, then Compare. Gaps show tickets or units that are not in Quackmaster.'
            }
          />
        </div>
      )}

      {result && !result.error && (
        <div className="space-y-4">
          {result.notice && <p className="text-sm text-stone-500">{result.notice}</p>}

          <div className={`grid grid-cols-2 gap-3 ${tally ? 'lg:grid-cols-4' : 'lg:grid-cols-4'}`}>
            <StatCard
              icon={<Package size={18} />}
              tone="brand"
              label={tally ? 'SHPOS sold' : 'SHPOS qty'}
              value={fmtQty(result.totals.posQty)}
              sub={result.snapshot ? 'On hand now' : 'Units on POS tickets'}
            />
            {tally ? (
              <StatCard
                icon={<Scale size={18} />}
                label="QMERP sold"
                value={fmtQty(result.totals.dashQty)}
                sub="Posted outlet sales units"
              />
            ) : (
              <StatCard
                icon={<CircleDollarSign size={18} />}
                label="SHPOS RM"
                value={fmtRm(result.totals.posRm)}
                sub="POS only"
              />
            )}
            <StatCard
              icon={tally ? <Truck size={18} /> : <Scale size={18} />}
              label={tally ? 'QMERP supplied' : 'QMERP qty'}
              value={
                result.posOnly
                  ? '—'
                  : fmtQty(tally ? result.totals.suppliedQty : result.totals.dashQty)
              }
              sub={
                result.posOnly
                  ? 'Not stored in journals'
                  : tally
                    ? 'Dispatched to outlet'
                    : 'Posted outlet sales units'
              }
            />
            <StatCard
              icon={<AlertTriangle size={18} />}
              tone={gapCount > 0 ? 'danger' : 'muted'}
              label="Gaps"
              value={String(gapCount)}
              sub={
                tally
                  ? `${result.totals.match} POS vs sold match · leftover is not a gap`
                  : `${result.totals.match} match · ${result.totals.pos_only} SHPOS only`
              }
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
              {tally ? (
                <TallyTable
                  rows={visibleRows}
                  expanded={expanded}
                  onToggle={toggleExpand}
                />
              ) : (
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
              )}
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

function TallyTable({
  rows,
  expanded,
  onToggle,
}: {
  rows: StorehubReportRow[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <table className="data-table min-w-[52rem]">
      <thead>
        <tr>
          <th>Product</th>
          <th className="text-right">SHPOS sold</th>
          <th className="text-right">QMERP sold</th>
          <th className="text-right">QMERP supplied</th>
          <th className="text-right">Leftover</th>
          <th className="text-right">POS vs sold</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {rows.map((row) => {
          const open = expanded.has(row.key);
          const hasLots = (row.lots?.length ?? 0) > 0;
          return (
            <Fragment key={row.key}>
              <tr
                className={
                  row.status === 'qty_mismatch' || row.status === 'missing_in_dashboard'
                    ? 'bg-amber-50/60'
                    : 'hover:bg-stone-50'
                }
              >
                <td>
                  {hasLots ? (
                    <button
                      type="button"
                      onClick={() => onToggle(row.key)}
                      className="inline-flex items-center gap-1 text-left font-medium text-stone-800"
                    >
                      <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                      {row.label}
                    </button>
                  ) : (
                    row.label
                  )}
                </td>
                <td className="text-right tabular-nums">{fmtQty(row.posQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.dashQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.suppliedQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.leftoverQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.posVsSold)}</td>
                <td>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[row.status]}`}>
                    {STATUS_LABEL[row.status]}
                  </span>
                </td>
              </tr>
              {open &&
                (row.lots ?? []).map((lot) => (
                  <tr key={`${row.key}:${lot.label}`} className="bg-stone-50/80 text-stone-600">
                    <td className="pl-8 text-xs">{lot.label}</td>
                    <td className="text-right text-xs text-stone-400">—</td>
                    <td className="text-right text-xs tabular-nums">{fmtQty(lot.sold)}</td>
                    <td className="text-right text-xs tabular-nums">{fmtQty(lot.supplied)}</td>
                    <td className="text-right text-xs tabular-nums">{fmtQty(lot.supplied - lot.sold)}</td>
                    <td className="text-right text-xs text-stone-400">—</td>
                    <td />
                  </tr>
                ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
