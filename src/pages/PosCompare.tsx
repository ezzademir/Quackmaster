import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, CircleDollarSign, HelpCircle, Package, Scale, Truck } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { Button, EmptyState, PageHeader, StatCard } from '../components/ui';
import { supabase } from '../utils/supabase';
import {
  formatDateForInput,
  getLast7Days,
  malaysiaCalendarDate,
  rangeFromPeriodBucket,
  type DateRange,
} from '../utils/dateRange';
import type { DateFilterType } from '../components/DateFilter';
import {
  STOREHUB_REPORTS,
  invokeStorehub,
  type StorehubReportResult,
  type StorehubDiffStatus,
  type StorehubReportRow,
  type StorehubProduct,
} from '../utils/storehubSync';

type StoreOpt = { id: string; name: string };
type RowFilter = 'gaps' | 'all';
type ProductPick = { id: string; sku: string; name: string; fg: boolean };

const SKU_PICK_KEY = 'qm-sold-vs-supplied-skus';
const PRODUCT_PICK_KEY = 'qm-sold-vs-supplied-product-ids';

function isLegacyBatch(value: string): boolean {
  return /^BATCH-[0-9a-f-]+$/i.test(value.trim());
}

function displayProductLabel(sku: string, fallback: string, picks: ProductPick[]): string {
  if (fallback.includes(' · ')) return fallback;
  const names = [
    ...new Set(
      picks
        .filter((p) => p.sku === sku || p.sku.toLowerCase() === sku.toLowerCase())
        .map((p) => p.name.trim())
        .filter((n) => n && n.toLowerCase() !== sku.toLowerCase())
    ),
  ];
  if (names.length === 0) return fallback;
  if (sku.startsWith('unmapped:')) return names[0];
  return `${sku} · ${names.join(', ')}`;
}

function resolvePickSku(productId: string, mappedSku: string, storehubSku: string): string {
  const mapped = mappedSku.trim();
  if (mapped && !isLegacyBatch(mapped)) return mapped;
  const sh = storehubSku.trim();
  if (sh && !isLegacyBatch(sh)) return sh;
  return `unmapped:${productId}`;
}

function readStoredIds(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((s) => String(s).trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function periodIso(range: DateRange | null): { from: string; to: string } {
  if (range) {
    return { from: formatDateForInput(range.start), to: formatDateForInput(range.end) };
  }
  const to = malaysiaCalendarDate();
  const [y, m, d] = to.split('-').map(Number);
  const fromDt = new Date(Date.UTC(y - 2, m - 1, d));
  const from = fromDt.toISOString().slice(0, 10);
  return { from, to };
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

/** Plain-language help for status chips (title tooltip). */
const STATUS_HELP: Record<StorehubDiffStatus, string> = {
  match: 'SHPOS sold matches QMERP sold from StoreHub ingest for this row.',
  qty_mismatch: 'SHPOS sold and QMERP StoreHub-ingested sold both exist but the unit counts differ.',
  missing_in_dashboard:
    'SHPOS has sales here, but QMERP has no StoreHub-ingested journal for this row (manual journals do not count as a match).',
  extra_in_dashboard:
    'QMERP has posted sales here (often manual or StoreHub ingest) with no matching SHPOS tickets in this period.',
  pos_only: 'This report has no QMERP journal side — POS tickets only.',
};

const STATUS_CLASS: Record<StorehubDiffStatus, string> = {
  match: 'bg-emerald-100 text-emerald-800',
  qty_mismatch: 'bg-amber-100 text-amber-900',
  missing_in_dashboard: 'bg-red-100 text-red-800',
  extra_in_dashboard: 'bg-sky-100 text-sky-800',
  pos_only: 'bg-stone-100 text-stone-600',
};

function StatusChip({ status }: { status: StorehubDiffStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[status]}`}
      title={STATUS_HELP[status]}
    >
      {STATUS_LABEL[status]}
      <HelpCircle size={11} className="opacity-70" aria-hidden />
    </span>
  );
}

const groups = [...new Set(STOREHUB_REPORTS.map((r) => r.group))];

const fieldClass = 'w-full min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm sm:w-auto sm:min-w-[9rem]';

const PERIOD_BUCKET_REPORTS = new Set(['sales_over_time', 'sales_by_product', 'sales_by_sku', 'sales_by_category']);

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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pickerReady, setPickerReady] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState<DateFilterType>('last7Days');
  const [filterSyncKey, setFilterSyncKey] = useState(0);
  const [drillLabel, setDrillLabel] = useState<string | null>(null);
  const [parentViewBy, setParentViewBy] = useState<'week' | 'month' | null>(null);
  const [preDrillRange, setPreDrillRange] = useState<DateRange | null>(null);
  const [preDrillFilterType, setPreDrillFilterType] = useState<DateFilterType>('last7Days');

  const selected = STOREHUB_REPORTS.find((r) => r.id === reportId);
  const snapshot = Boolean(selected?.snapshot);
  const tally = reportId === 'sold_vs_supplied';
  const selectedSkus = [...new Set(picks.filter((p) => selectedIds.includes(p.id)).map((p) => p.sku))];
  const canRun = Boolean(selected?.available) && (!tally || selectedIds.length > 0);
  const showViewBy = PERIOD_BUCKET_REPORTS.has(reportId);
  const showHour = reportId === 'sales_over_time';
  const effectiveViewBy = reportId !== 'sales_over_time' && viewBy === 'hour' ? 'day' : viewBy;
  const showSplitSold = reportId === 'sales_over_time' || reportId === 'sold_vs_supplied';

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
      const [{ data: maps }, { data: recipes }, catalog] = await Promise.all([
        supabase
          .from('storehub_product_map')
          .select('storehub_product_id, quackmaster_sku, storehub_name, storehub_sku'),
        supabase.from('recipes').select('name, default_product_batch'),
        invokeStorehub<{ products: StorehubProduct[] }>('catalog'),
      ]);
      const fgSkus = new Set(
        (recipes ?? [])
          .map((r) => String(r.default_product_batch ?? '').trim())
          .filter(Boolean)
      );
      const fgNames = new Set(
        (recipes ?? [])
          .map((r) => String(r.name ?? '').trim().toLowerCase())
          .filter(Boolean)
      );
      const mapped = new Map<string, { sku: string; name: string; shSku: string }>();
      for (const row of maps ?? []) {
        const id = String(row.storehub_product_id ?? '').trim();
        if (!id) continue;
        mapped.set(id, {
          sku: String(row.quackmaster_sku ?? '').trim(),
          name: (row.storehub_name as string) || '',
          shSku: (row.storehub_sku as string) || '',
        });
      }

      const byId = new Map<string, ProductPick>();
      function addPick(id: string, name: string, shSku: string, mappedSku: string) {
        const sku = resolvePickSku(id, mappedSku, shSku);
        const label = name.trim() || shSku.trim() || sku;
        const fg = fgSkus.has(sku) || fgNames.has(label.toLowerCase());
        byId.set(id, { id, sku, name: label, fg });
      }

      for (const p of catalog.data?.products ?? []) {
        const m = mapped.get(p.id);
        addPick(p.id, p.name, p.sku, m?.sku ?? '');
      }
      for (const [id, m] of mapped) {
        if (!byId.has(id)) addPick(id, m.name, m.shSku, m.sku);
      }

      const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
      setPicks(list);
      const allowed = new Set(list.map((p) => p.id));
      const storedIds = readStoredIds(PRODUCT_PICK_KEY)?.filter((id) => allowed.has(id));
      const storedSkus = readStoredIds(SKU_PICK_KEY);
      if (storedIds && storedIds.length) {
        setSelectedIds(storedIds);
      } else if (storedSkus?.length) {
        setSelectedIds(list.filter((p) => storedSkus.includes(p.sku)).map((p) => p.id));
      } else {
        setSelectedIds(list.filter((p) => p.fg).map((p) => p.id));
      }
      setPickerReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!pickerReady) return;
    localStorage.setItem(PRODUCT_PICK_KEY, JSON.stringify(selectedIds));
  }, [pickerReady, selectedIds]);

  async function run() {
    if (!canRun) return;
    if (tally && selectedIds.length === 0) {
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

  function toggleProduct(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const canDrill =
    showViewBy && (effectiveViewBy === 'week' || effectiveViewBy === 'month');

  async function runWith(
    nextReport: string,
    nextRange: DateRange | null,
    nextViewBy: typeof viewBy,
    nextStoreId: string,
    nextSkus: string[] | undefined,
  ) {
    if (!STOREHUB_REPORTS.find((r) => r.id === nextReport)?.available) return;
    if (nextReport === 'sold_vs_supplied' && (!nextSkus || nextSkus.length === 0)) {
      setError('Pick at least one product.');
      return;
    }
    setBusy(true);
    setError(null);
    setRowFilter(nextReport === 'sold_vs_supplied' ? 'all' : 'gaps');
    setExpanded(new Set());
    const snap = Boolean(STOREHUB_REPORTS.find((r) => r.id === nextReport)?.snapshot);
    const period = snap ? {} : periodIso(nextRange);
    const showVb = PERIOD_BUCKET_REPORTS.has(nextReport);
    const eff = nextReport !== 'sales_over_time' && nextViewBy === 'hour' ? 'day' : nextViewBy;
    const { data, error: err } = await invokeStorehub<StorehubReportResult>('report', {
      report: nextReport,
      ...period,
      storeId: nextStoreId || undefined,
      viewBy: showVb ? eff : undefined,
      skus: nextSkus,
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

  function drillToDay(row: StorehubReportRow) {
    if (!canDrill) return;
    const bucketRange = rangeFromPeriodBucket(row.key, effectiveViewBy);
    if (!bucketRange) return;
    const fromGrain = effectiveViewBy === 'month' ? 'month' : 'week';
    if (!drillLabel) {
      setPreDrillRange(dateRange);
      setPreDrillFilterType(filterType);
    }
    setParentViewBy(fromGrain);
    setDrillLabel(row.label.includes(' · ') ? row.label.slice(0, row.label.indexOf(' · ')) : row.label);
    setDateRange(bucketRange);
    setFilterType('custom');
    setFilterSyncKey((k) => k + 1);
    setViewBy('day');
    void runWith(
      reportId,
      bucketRange,
      'day',
      storeId,
      tally ? selectedSkus : undefined,
    );
  }

  function clearDrill() {
    const restoreView = parentViewBy ?? 'day';
    const restoreRange = preDrillRange;
    const restoreType = preDrillFilterType;
    setDrillLabel(null);
    setParentViewBy(null);
    setPreDrillRange(null);
    setViewBy(restoreView);
    setFilterType(restoreType);
    setDateRange(restoreRange);
    setFilterSyncKey((k) => k + 1);
    void runWith(
      reportId,
      restoreRange,
      restoreView,
      storeId,
      tally ? selectedSkus : undefined,
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="SHPOS vs QMERP"
        description={
          tally
            ? 'Sold vs supplied: compare SHPOS tickets to QMERP sold (StoreHub vs manual) and hub dispatch by supply date. Finished goods are pre-selected when possible.'
            : 'Compare StoreHub POS tickets to Quackmaster journals. Sales Over Time splits QMERP sold into StoreHub-ingested vs manual so period gaps (e.g. TTDI 923 vs 1498) are explainable.'
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
                <option value="">{tally ? 'All QMERP outlets' : 'All mapped stores'}</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className={snapshot ? 'hidden' : 'w-full min-w-0 sm:w-auto'}>
              <DateFilter
                defaultType={filterType}
                defaultRange={filterType === 'custom' ? dateRange : null}
                syncKey={filterSyncKey}
                onFilterChange={(range, type) => {
                  setFilterType(type);
                  setDateRange(range);
                  if (type !== 'custom') {
                    setDrillLabel(null);
                    setParentViewBy(null);
                  }
                }}
                hint={
                  tally
                    ? 'Malaysia calendar (Asia/Kuala_Lumpur). Applies to POS tickets, posted Outlet sales, and hub dispatch by supply date. Weeks are Mon–Sun. All time is the last 2 years.'
                    : 'Malaysia calendar (Asia/Kuala_Lumpur). Applies to POS tickets and QMERP journals. Weeks are Mon–Sun. All time is the last 2 years.'
                }
              />
            </div>
            {showViewBy && (
              <label className="w-full min-w-0 text-sm sm:w-auto">
                <span className="mb-1 block text-xs text-stone-500">Bucket</span>
                <select
                  value={effectiveViewBy}
                  onChange={(e) => {
                    const next = e.target.value as typeof viewBy;
                    setViewBy(next);
                    setDrillLabel(null);
                    setParentViewBy(null);
                  }}
                  className={fieldClass}
                >
                  <option value="day">Daily</option>
                  <option value="week">Weekly</option>
                  <option value="month">Monthly</option>
                  {showHour && <option value="hour">Hourly</option>}
                </select>
              </label>
            )}
            <Button
              className="w-full sm:w-auto"
              disabled={busy || !canRun}
              title={
                tally && selectedIds.length === 0
                  ? 'Pick at least one product (Finished goods is a one-click default).'
                  : undefined
              }
              onClick={() => void run()}
            >
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
                {selectedIds.length} selected
                {pickerReady && selectedIds.length === 0
                  ? ' · click Finished goods, then Compare'
                  : pickerReady && picks.some((x) => x.fg)
                    ? ' · FG pre-selected by default'
                    : ''}
              </span>
            </p>
            <div className="flex flex-wrap gap-2 text-xs">
              <button
                type="button"
                className="rounded-md border border-stone-200 px-2 py-1 text-stone-600 hover:bg-stone-50"
                onClick={() => setSelectedIds(picks.filter((p) => p.fg).map((p) => p.id))}
              >
                Finished goods
              </button>
              <button
                type="button"
                className="rounded-md border border-stone-200 px-2 py-1 text-stone-600 hover:bg-stone-50"
                onClick={() => setSelectedIds(picks.map((p) => p.id))}
              >
                All products
              </button>
              <button
                type="button"
                className="rounded-md border border-stone-200 px-2 py-1 text-stone-600 hover:bg-stone-50"
                onClick={() => setSelectedIds([])}
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
          {!pickerReady ? (
            <p className="text-sm text-stone-500">Loading StoreHub products…</p>
          ) : picks.length === 0 ? (
            <p className="text-sm text-stone-500">
              Could not load StoreHub products. Check Settings → StoreHub POS sync, then refresh this page.
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-stone-100">
              {visiblePicks.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-stone-50 px-3 py-1.5 text-sm last:border-b-0 hover:bg-stone-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.id)}
                    onChange={() => toggleProduct(p.id)}
                  />
                  <span className="font-medium text-stone-800">{p.name}</span>
                  <span className="text-stone-400">
                    {p.sku.startsWith('unmapped:') ? 'not mapped' : p.sku}
                  </span>
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

      {drillLabel && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-950">
          <span>
            Day drill-down for <span className="font-semibold">{drillLabel}</span>
            {dateRange
              ? ` (${formatDateForInput(dateRange.start)} → ${formatDateForInput(dateRange.end)})`
              : ''}
            . Click a week/month row again from the parent bucket after clearing.
          </span>
          <button
            type="button"
            className="rounded-md border border-sky-300 bg-white px-2 py-1 text-xs font-medium text-sky-900 hover:bg-sky-100"
            onClick={() => {
              clearDrill();
            }}
          >
            Back to {parentViewBy === 'month' ? 'monthly' : 'weekly'}
          </button>
        </div>
      )}

      {!result && !error && !busy && (
        <div className="panel">
          <EmptyState
            title="Nothing compared yet"
            description={
              tally
                ? selectedIds.length === 0
                  ? 'Next: click Finished goods (or tick products), set the Malaysia period, then Compare.'
                  : 'Next: set the Malaysia period if needed, then click Compare. Columns show SHPOS sold, QMERP sold (StoreHub / manual / all), supplied, and leftover.'
                : reportId === 'sales_over_time'
                  ? 'Next: pick store (or all), set the period + Daily/Weekly/Monthly bucket, then Compare — no product pick needed. Manual QMERP sold explains totals above SHPOS.'
                  : 'Next: choose a report, set the period, then Compare. Gaps are SHPOS vs QMERP StoreHub-ingested sold where that split applies.'
            }
            action={
              canRun ? (
                <Button onClick={() => void run()} disabled={busy}>
                  Compare now
                </Button>
              ) : tally ? (
                <Button
                  variant="secondary"
                  onClick={() => setSelectedIds(picks.filter((x) => x.fg).map((x) => x.id))}
                  disabled={!pickerReady || !picks.some((x) => x.fg)}
                >
                  Select finished goods
                </Button>
              ) : undefined
            }
          />
        </div>
      )}

      {result && !result.error && (
        <div className="space-y-4">
          {result.notice && <p className="text-sm text-stone-500">{result.notice}</p>}
          {!result.posOnly && (
            <details className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-2 text-sm text-stone-600">
              <summary className="cursor-pointer font-medium text-stone-800">What do the status chips mean?</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-stone-600">
                {(Object.keys(STATUS_HELP) as StorehubDiffStatus[]).map((k) => (
                  <li key={k}>
                    <span className="font-medium">{STATUS_LABEL[k]}:</span> {STATUS_HELP[k]}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {(() => {
            const hasSplit =
              showSplitSold &&
              !result.posOnly &&
              (result.totals.dashStorehubQty != null ||
                result.totals.dashManualQty != null ||
                result.rows.some((r) => r.dashStorehubQty != null || r.dashManualQty != null));
            const shSold = result.totals.dashStorehubQty ?? null;
            const manSold = result.totals.dashManualQty ?? null;
            return (
          <div className={`grid grid-cols-2 gap-3 ${hasSplit || tally ? 'lg:grid-cols-3 xl:grid-cols-6' : 'lg:grid-cols-4'}`}>
            <StatCard
              icon={<Package size={18} />}
              tone="brand"
              label="SHPOS sold"
              value={fmtQty(result.totals.posQty)}
              sub={result.snapshot ? 'On hand now' : 'Units on completed POS tickets'}
            />
            {hasSplit ? (
              <>
                <StatCard
                  icon={<Scale size={18} />}
                  label="QMERP sold (StoreHub)"
                  value={fmtQty(shSold)}
                  sub="source = storehub"
                />
                <StatCard
                  icon={<Scale size={18} />}
                  label="QMERP sold (manual)"
                  value={fmtQty(manSold)}
                  sub="null / manual / other"
                />
                <StatCard
                  icon={<Scale size={18} />}
                  label="QMERP sold (all)"
                  value={fmtQty(result.totals.dashQty)}
                  sub="StoreHub + manual posted"
                />
              </>
            ) : tally ? (
              <StatCard
                icon={<Scale size={18} />}
                label="QMERP sold (all)"
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
            {!hasSplit && (
            <StatCard
              icon={tally ? <Truck size={18} /> : <Scale size={18} />}
              label={tally ? 'QMERP supplied' : 'QMERP sold (all)'}
              value={
                result.posOnly
                  ? '—'
                  : fmtQty(tally ? result.totals.suppliedQty : result.totals.dashQty)
              }
              sub={
                result.posOnly
                  ? 'Not stored in journals'
                  : tally
                    ? 'Dispatched to outlet (supply date)'
                    : 'Posted outlet sales units'
              }
            />
            )}
            {tally && (
              <StatCard
                icon={<Truck size={18} />}
                label="QMERP supplied"
                value={fmtQty(result.totals.suppliedQty)}
                sub="Dispatched to outlet (supply date)"
              />
            )}
            {hasSplit && !tally && (
              <StatCard
                icon={<CircleDollarSign size={18} />}
                label="SHPOS RM"
                value={fmtRm(result.totals.posRm)}
                sub="POS only"
              />
            )}
            <StatCard
              icon={<AlertTriangle size={18} />}
              tone={gapCount > 0 ? 'danger' : 'muted'}
              label="Gaps"
              value={String(gapCount)}
              sub={
                tally
                  ? `${result.totals.match} SHPOS vs StoreHub sold match · leftover is not a gap`
                  : hasSplit
                    ? `${result.totals.match} match (vs StoreHub sold) · manual explains all−SHPOS`
                    : `${result.totals.match} match · ${result.totals.pos_only} SHPOS only`
              }
            />
          </div>
            );
          })()}

          {result.rows.length === 0 ? (
            <div className="panel">
              <EmptyState
                title="No rows in this range"
                description="Next: widen the Malaysia date range, pick another store, or (for Sold vs supplied) include more products."
              />
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
                  picks={picks}
                  expanded={expanded}
                  onToggle={toggleExpand}
                  showSplit={result.rows.some((r) => r.dashStorehubQty != null || r.dashManualQty != null)}
                />
              ) : (
                <PeriodTable
                  rows={visibleRows}
                  canDrill={canDrill}
                  showSplit={
                    showSplitSold &&
                    !result.posOnly &&
                    result.rows.some((r) => r.dashStorehubQty != null || r.dashManualQty != null)
                  }
                  onDrill={drillToDay}
                />
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

function PeriodTable({
  rows,
  canDrill,
  showSplit,
  onDrill,
}: {
  rows: StorehubReportRow[];
  canDrill: boolean;
  showSplit: boolean;
  onDrill: (row: StorehubReportRow) => void;
}) {
  return (
    <table className={`data-table ${showSplit ? 'min-w-[52rem]' : 'min-w-[40rem]'}`}>
      <thead>
        <tr>
          <th>
            Row
            {canDrill ? (
              <span className="ml-2 font-normal text-stone-400">· click bucket for days</span>
            ) : null}
          </th>
          <th className="text-right">SHPOS sold</th>
          <th className="text-right">SHPOS RM</th>
          {showSplit ? (
            <>
              <th className="text-right">QMERP sold (StoreHub)</th>
              <th className="text-right">QMERP sold (manual)</th>
              <th className="text-right">QMERP sold (all)</th>
            </>
          ) : (
            <th className="text-right">QMERP sold (all)</th>
          )}
          <th>Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {rows.map((row) => (
          <tr
            key={row.key}
            className={
              row.status === 'qty_mismatch' || row.status === 'missing_in_dashboard'
                ? 'bg-amber-50/60'
                : 'hover:bg-stone-50'
            }
          >
            <td>
              {canDrill ? (
                <button
                  type="button"
                  onClick={() => onDrill(row)}
                  className="inline-flex items-center gap-1 text-left font-medium text-sky-900 underline-offset-2 hover:underline"
                  title="Show daily rows for this bucket"
                >
                  {row.label}
                  <ChevronRight size={14} className="shrink-0 text-sky-700" />
                </button>
              ) : (
                row.label
              )}
            </td>
            <td className="text-right tabular-nums">{fmtQty(row.posQty)}</td>
            <td className="text-right tabular-nums">{fmtRm(row.posRm)}</td>
            {showSplit ? (
              <>
                <td className="text-right tabular-nums">{fmtQty(row.dashStorehubQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.dashManualQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.dashQty)}</td>
              </>
            ) : (
              <td className="text-right tabular-nums">{fmtQty(row.dashQty)}</td>
            )}
            <td>
              <StatusChip status={row.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TallyTable({
  rows,
  picks,
  expanded,
  onToggle,
  showSplit,
}: {
  rows: StorehubReportRow[];
  picks: ProductPick[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  showSplit: boolean;
}) {
  return (
    <table className={`data-table ${showSplit ? 'min-w-[64rem]' : 'min-w-[52rem]'}`}>
      <thead>
        <tr>
          <th>Product</th>
          <th className="text-right">SHPOS sold</th>
          {showSplit ? (
            <>
              <th className="text-right">QMERP sold (StoreHub)</th>
              <th className="text-right">QMERP sold (manual)</th>
              <th className="text-right">QMERP sold (all)</th>
            </>
          ) : (
            <th className="text-right">QMERP sold (all)</th>
          )}
          <th className="text-right">QMERP supplied</th>
          <th className="text-right">Leftover</th>
          <th className="text-right">{showSplit ? 'POS vs StoreHub' : 'POS vs sold'}</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {rows.map((row) => {
          const open = expanded.has(row.key);
          const hasLots = (row.lots?.length ?? 0) > 0;
          const label = displayProductLabel(row.key, row.label, picks);
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
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                </td>
                <td className="text-right tabular-nums">{fmtQty(row.posQty)}</td>
                {showSplit ? (
                  <>
                    <td className="text-right tabular-nums">{fmtQty(row.dashStorehubQty)}</td>
                    <td className="text-right tabular-nums">{fmtQty(row.dashManualQty)}</td>
                    <td className="text-right tabular-nums">{fmtQty(row.dashQty)}</td>
                  </>
                ) : (
                  <td className="text-right tabular-nums">{fmtQty(row.dashQty)}</td>
                )}
                <td className="text-right tabular-nums">{fmtQty(row.suppliedQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.leftoverQty)}</td>
                <td className="text-right tabular-nums">{fmtQty(row.posVsSold)}</td>
                <td>
                  <StatusChip status={row.status} />
                </td>
              </tr>
              {open &&
                (row.lots ?? []).map((lot) => (
                  <tr key={`${row.key}:${lot.label}`} className="bg-stone-50/80 text-stone-600">
                    <td className="pl-8 text-xs">{lot.label}</td>
                    <td className="text-right text-xs text-stone-400">—</td>
                    {showSplit ? (
                      <>
                        <td className="text-right text-xs text-stone-400">—</td>
                        <td className="text-right text-xs text-stone-400">—</td>
                        <td className="text-right text-xs tabular-nums">{fmtQty(lot.sold)}</td>
                      </>
                    ) : (
                      <td className="text-right text-xs tabular-nums">{fmtQty(lot.sold)}</td>
                    )}
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
