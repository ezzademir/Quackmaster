import { Shield, RefreshCw, Download } from 'lucide-react';
import { useAuth } from '../utils/auth';
import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { writeLedgerEntry } from '../utils/ledger';
import { fetchQCAuditCriteria, saveQCAuditCriteria } from '../utils/qcSettings';
import { downloadCsv } from '../utils/exportCsv';

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
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            System configuration, preferences, and data exports.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg bg-gray-600 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          Refresh Profile
        </button>
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
              <div className="flex justify-between"><span>Latest roadmap migrations</span><span className="font-medium text-gray-700">056–059</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
