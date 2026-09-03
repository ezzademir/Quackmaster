import { Shield, RefreshCw, Download } from 'lucide-react';
import { useAuth } from '../utils/auth';
import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, PageHeader } from '../components/ui';
import { supabase } from '../utils/supabase';
import { writeLedgerEntry } from '../utils/ledger';
import { fetchQCAuditCriteria, saveQCAuditCriteria } from '../utils/qcSettings';
import { downloadCsv } from '../utils/exportCsv';
import {
  fetchStockTakeVarianceThreshold,
  saveStockTakeVarianceThreshold,
} from '../utils/stockTakeSettings';
import {
  deleteOutletPar,
  listOutletPar,
  upsertOutletPar,
  type OutletParRow,
} from '../utils/parService';
import { StorehubSettings } from '../components/StorehubSettings';

export function Settings() {
  const { refetchProfile, isAdmin } = useAuth();
  const location = useLocation();
  const [refreshing, setRefreshing] = useState(false);
  const [qcMin, setQcMin] = useState('85');
  const [qcMax, setQcMax] = useState('110');
  const [qcVariance, setQcVariance] = useState('5');
  const [qcLoading, setQcLoading] = useState(true);
  const [qcSaving, setQcSaving] = useState(false);
  const [qcNotice, setQcNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [stThreshold, setStThreshold] = useState('5');
  const [stSaving, setStSaving] = useState(false);
  const [stNotice, setStNotice] = useState<string | null>(null);
  const [parOutlets, setParOutlets] = useState<{ id: string; name: string }[]>([]);
  const [parOutletId, setParOutletId] = useState('');
  const [parRows, setParRows] = useState<OutletParRow[]>([]);
  const [parKey, setParKey] = useState('');
  const [parTarget, setParTarget] = useState('0');
  const [parSafety, setParSafety] = useState('0');
  const [parMsg, setParMsg] = useState<string | null>(null);

  async function exportTableCsv(table: string, filename: string) {
    setExportBusy(table);
    try {
      const { data, error } = await supabase.from(table).select('*').limit(5000);
      if (error) throw error;
      const rows = data ?? [];
      if (!rows.length) {
        downloadCsv(filename, ['message'], [['No rows']]);
        return;
      }
      const headers = Object.keys(rows[0] as Record<string, unknown>);
      const body = rows.map((row) =>
        headers.map((h) => (row as Record<string, unknown>)[h] as string | number | null | undefined)
      );
      downloadCsv(filename, headers, body);
    } finally {
      setExportBusy(null);
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetchProfile();
    setRefreshing(false);
  };

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setQcLoading(true);
    setQcNotice(null);
    fetchQCAuditCriteria()
      .then((c) => {
        if (cancelled) return;
        setQcMin(String(c.minYieldPercentage));
        setQcMax(String(c.maxYieldPercentage));
        setQcVariance(String(c.allowableVariance));
      })
      .catch(() => {
        if (!cancelled) {
          setQcNotice({
            tone: 'err',
            text: 'Could not load QC settings from the server. Using defaults; save may fail until the database migration is applied.',
          });
        }
      })
      .finally(() => {
        if (!cancelled) setQcLoading(false);
      });

    void fetchStockTakeVarianceThreshold().then((t) => {
      if (!cancelled) setStThreshold(String(t));
    });

    void supabase
      .from('outlets')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        if (cancelled) return;
        const list = (data ?? []) as { id: string; name: string }[];
        setParOutlets(list);
        setParOutletId((prev) => prev || list[0]?.id || '');
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || !parOutletId) return;
    void listOutletPar(parOutletId)
      .then(setParRows)
      .catch(() => setParRows([]));
  }, [isAdmin, parOutletId]);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('section') !== 'qc') return;
    const el = document.getElementById('qc-audit-settings');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.search]);

  async function saveQCSettings() {
    const min = parseFloat(qcMin);
    const max = parseFloat(qcMax);
    const variance = parseFloat(qcVariance);
    setQcNotice(null);

    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(variance)) {
      setQcNotice({ tone: 'err', text: 'Enter valid numbers for all fields.' });
      return;
    }
    if (min < 0 || max > 200 || variance < 0 || variance > 100) {
      setQcNotice({ tone: 'err', text: 'Min/max yield must be 0–200; allowable variance 0–100.' });
      return;
    }
    if (min >= max) {
      setQcNotice({ tone: 'err', text: 'Minimum yield must be less than maximum yield.' });
      return;
    }

    setQcSaving(true);
    try {
      const { error } = await saveQCAuditCriteria({
        minYieldPercentage: min,
        maxYieldPercentage: max,
        allowableVariance: variance,
      });
      if (error) {
        setQcNotice({ tone: 'err', text: error.message });
        return;
      }
      await writeLedgerEntry({
        action: 'updated',
        entityType: 'qc_audit_settings',
        entityId: '1',
        module: 'settings',
        operation: 'update',
        afterData: {
          min_yield_percentage: min,
          max_yield_percentage: max,
          allowable_variance: variance,
        },
      });
      setQcNotice({ tone: 'ok', text: 'QC audit parameters saved. They apply to new production completions.' });
    } finally {
      setQcSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="System configuration, preferences, and data exports."
        actions={
          <Button variant="secondary" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            Refresh Profile
          </Button>
        }
      />

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="font-semibold text-gray-900">SKU vs lot</h2>
        <p className="mt-1 text-sm text-gray-600">
          Two identifiers, one story. Do not invent a third code.
        </p>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-gray-700">
          <li>
            <span className="font-medium">SKU</span> = recipe product code (what you sell, PAR, and FIFO against).
            Current finished-goods SKU is <span className="font-mono text-xs">QUACKTEOW</span>.
          </li>
          <li>
            <span className="font-medium">Lot</span> = unique printable code inked on packs (
            <span className="font-mono text-xs">SKU-YYMMDD-RUN</span>), and what outlets receive.
          </li>
          <li>
            Older rows may still store a legacy <span className="font-mono text-xs">BATCH-…</span> column. Screens
            show the lot first; that legacy string is not the label staff should use.
          </li>
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          Set shelf life on the recipe so EXP prints on lot labels. Shortening SKU (optional) only applies to new lots.
        </p>
      </div>

      {isAdmin && (
        <div
          id="qc-audit-settings"
          className="scroll-mt-24 rounded-xl border border-indigo-200 bg-indigo-50/40 p-6 shadow-sm"
        >
          <h2 className="mb-1 font-semibold text-gray-900 flex flex-wrap items-center gap-2">
            <Shield size={20} className="text-indigo-600" />
            QC audit parameters
            {qcLoading && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-normal text-indigo-800">Loading…</span>
            )}
          </h2>
          <p className="mb-5 text-sm text-gray-600">
            Thresholds used when completing production runs: yields outside min/max are rejected; deviation from the recipe target yield beyond allowable variance triggers a warning (staff may need admin approval).
          </p>

          {qcNotice && (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                qcNotice.tone === 'ok'
                  ? 'border-green-200 bg-green-50 text-green-900'
                  : 'border-red-200 bg-red-50 text-red-900'
              }`}
              role="status"
            >
              {qcNotice.text}
            </div>
          )}

          <div className={`grid gap-4 sm:grid-cols-3 ${qcLoading ? 'opacity-70' : ''}`}>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Minimum yield (%)</label>
              <input
                type="number"
                min={0}
                max={200}
                step={0.1}
                value={qcMin}
                onChange={(e) => setQcMin(e.target.value)}
                disabled={qcLoading}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed"
              />
              <p className="mt-1 text-xs text-gray-500">Below this is rejected</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Maximum yield (%)</label>
              <input
                type="number"
                min={0}
                max={200}
                step={0.1}
                value={qcMax}
                onChange={(e) => setQcMax(e.target.value)}
                disabled={qcLoading}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed"
              />
              <p className="mt-1 text-xs text-gray-500">Above this is rejected</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Allowable variance from target (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={qcVariance}
                onChange={(e) => setQcVariance(e.target.value)}
                disabled={qcLoading}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed"
              />
              <p className="mt-1 text-xs text-gray-500">Beyond recipe target yield triggers warning</p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={saveQCSettings}
              disabled={qcLoading || qcSaving}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors"
            >
              {qcSaving ? 'Saving…' : 'Save QC parameters'}
            </button>
            <span className="text-xs text-gray-500">Admin only · applies to new production run completions</span>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-gray-900">Stock take variance threshold</h2>
          <p className="mt-1 text-xs text-gray-500">
            Absolute |counted − system| above this value requires a matching recount before staff/admin can post.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Threshold (units)</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={stThreshold}
                onChange={(e) => setStThreshold(e.target.value)}
                className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <button
              type="button"
              disabled={stSaving}
              onClick={() => {
                void (async () => {
                  setStSaving(true);
                  setStNotice(null);
                  const res = await saveStockTakeVarianceThreshold(parseFloat(stThreshold));
                  setStNotice(res.ok ? 'Saved.' : res.error ?? 'Save failed');
                  setStSaving(false);
                })();
              }}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {stSaving ? 'Saving…' : 'Save threshold'}
            </button>
          </div>
          {stNotice && <p className="mt-2 text-sm text-gray-600">{stNotice}</p>}
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-gray-900">Outlet PAR levels</h2>
          <p className="mt-1 text-xs text-gray-500">
            Finished goods: use the <span className="font-medium">SKU</span> as par_key (not the printable lot). Raw materials: use <code className="text-[11px]">rm:&lt;uuid&gt;</code>.
            Suggested reorder = target + safety − available on hand.
          </p>
          <div className="mt-3">
            <select
              value={parOutletId}
              onChange={(e) => setParOutletId(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {parOutlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {parRows.length === 0 ? (
              <li className="text-gray-400">No PAR rows for this outlet.</li>
            ) : (
              parRows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-2">
                  <span className="font-mono text-xs text-gray-800">{r.par_key}</span>
                  <span className="text-gray-600">
                    target {r.target_qty} · safety {r.safety_stock}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-red-700 hover:underline"
                    onClick={() => {
                      void deleteOutletPar(r.id).then(() => listOutletPar(parOutletId).then(setParRows));
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={parKey}
              onChange={(e) => setParKey(e.target.value)}
              placeholder="par_key"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={parTarget}
              onChange={(e) => setParTarget(e.target.value)}
              placeholder="Target"
              className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={parSafety}
              onChange={(e) => setParSafety(e.target.value)}
              placeholder="Safety"
              className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  if (!parOutletId || !parKey.trim()) {
                    setParMsg('Outlet and par_key required.');
                    return;
                  }
                  const res = await upsertOutletPar({
                    outlet_id: parOutletId,
                    par_key: parKey.trim(),
                    target_qty: parseFloat(parTarget) || 0,
                    safety_stock: parseFloat(parSafety) || 0,
                  });
                  setParMsg(res.ok ? 'Saved.' : res.error ?? 'Failed');
                  if (res.ok) {
                    setParKey('');
                    setParRows(await listOutletPar(parOutletId));
                  }
                })();
              }}
              className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white"
            >
              Add / update PAR
            </button>
          </div>
          {parMsg && <p className="mt-2 text-sm text-gray-600">{parMsg}</p>}
        </div>
      )}

      {isAdmin && <StorehubSettings />}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-2 font-semibold text-gray-900">Accounting / tax exports</h2>
            <p className="mb-4 text-xs text-gray-500">
              CSV snapshots (first 5k rows per table). Run after migrations so new columns exist.
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { table: 'raw_materials', label: 'Raw materials' },
                  { table: 'suppliers', label: 'Suppliers' },
                  { table: 'purchase_orders', label: 'Purchase orders' },
                  { table: 'sales_journals', label: 'Sales journals' },
                  { table: 'waste_events', label: 'Waste events' },
                ] as const
              ).map(({ table, label }) => (
                <button
                  key={table}
                  type="button"
                  disabled={exportBusy !== null}
                  onClick={() => void exportTableCsv(table, `${table}_export`)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Download size={14} />
                  {exportBusy === table ? 'Exporting…' : label}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-2 font-semibold text-gray-900">System Info</h2>
            <div className="space-y-2 text-xs text-gray-500">
              <div className="flex justify-between"><span>Version</span><span className="font-medium text-gray-700">1.0.0</span></div>
              <div className="flex justify-between"><span>Database</span><span className="font-medium text-gray-700">Supabase</span></div>
              <div className="flex justify-between"><span>Latest roadmap migrations</span><span className="font-medium text-gray-700">061 StoreHub sync</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
