import { useCallback, useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { supabase } from '../utils/supabase';
import type { Outlet } from '../types';
import { hubRowAvailableQuantity } from '../utils/hubInventoryMath';

/**
 * Admin snapshot: compare live outlet inventory to recent movement totals (sales, waste).
 * Helps spot unexplained variance; does not replace cycle counts.
 */
export function Reconciliation() {
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onHand, setOnHand] = useState(0);
  const [available, setAvailable] = useState(0);
  const [sales30d, setSales30d] = useState(0);
  const [waste30d, setWaste30d] = useState(0);

  useEffect(() => {
    void (async () => {
      const { data, error: e } = await supabase.from('outlets').select('*').order('name');
      if (e) setError(e.message);
      setOutlets(data ?? []);
      setOutletId((prev) => prev || data?.[0]?.id || '');
    })();
  }, []);

  const loadSnapshot = useCallback(async () => {
    if (!outletId) return;
    setError(null);
    setLoading(true);
    try {
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const startIso = start.toISOString().slice(0, 10);

      const { data: inv, error: iErr } = await supabase
        .from('outlet_inventory')
        .select('quantity_on_hand, reserved_quantity, available_quantity')
        .eq('outlet_id', outletId)
        .is('raw_material_id', null);

      if (iErr) throw new Error(iErr.message);

      let sumQ = 0;
      let sumA = 0;
      for (const row of inv ?? []) {
        const q = Number(row.quantity_on_hand ?? 0);
        const r = Number(row.reserved_quantity ?? 0);
        const a = hubRowAvailableQuantity(q, r, row.available_quantity);
        sumQ += q;
        sumA += Math.max(0, a);
      }
      setOnHand(sumQ);
      setAvailable(sumA);

      const { data: sj, error: sjErr } = await supabase
        .from('sales_journals')
        .select('id')
        .eq('outlet_id', outletId)
        .eq('status', 'posted')
        .gte('business_date', startIso);

      if (sjErr) throw new Error(sjErr.message);

      const sjIds = (sj ?? []).map((r) => r.id);
      let sold = 0;
      if (sjIds.length > 0) {
        const { data: lines, error: lErr } = await supabase
          .from('sales_journal_lines')
          .select('quantity_sold')
          .in('sales_journal_id', sjIds);
        if (lErr) throw new Error(lErr.message);
        sold = (lines ?? []).reduce((s, l) => s + Number(l.quantity_sold ?? 0), 0);
      }
      setSales30d(sold);

      const { data: we, error: wErr } = await supabase
        .from('waste_events')
        .select('id')
        .eq('outlet_id', outletId)
        .eq('status', 'posted')
        .eq('location_kind', 'outlet')
        .gte('waste_date', startIso);

      if (wErr) throw new Error(wErr.message);
      const weIds = (we ?? []).map((r) => r.id);
      let wu = 0;
      if (weIds.length > 0) {
        const { data: wl, error: wlErr } = await supabase
          .from('waste_lines')
          .select('quantity')
          .in('waste_event_id', weIds);
        if (wlErr) throw new Error(wlErr.message);
        wu = (wl ?? []).reduce((s, l) => s + Number(l.quantity ?? 0), 0);
      }
      setWaste30d(wu);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [outletId]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-white">
          <Scale size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Stock reconciliation</h1>
          <p className="mt-1 text-sm text-gray-500">
            Live outlet inventory vs recorded sales and waste (last 30 days). Use with physical counts; totals exclude supply
            in transit and inter-outlet transfers unless you analyze those separately.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <label className="mb-2 block text-xs font-medium uppercase text-gray-500">Outlet</label>
        <select
          value={outletId}
          onChange={(e) => {
            setOutletId(e.target.value);
            setLoading(true);
          }}
          className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-xs font-medium uppercase text-gray-500">On hand (live)</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900">{onHand.toLocaleString()}</p>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-xs font-medium uppercase text-emerald-700">Available to sell</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-900">{available.toLocaleString()}</p>
          </div>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-xs font-medium uppercase text-blue-700">Sales units (30d)</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-blue-900">{sales30d.toLocaleString()}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-medium uppercase text-amber-700">Waste units (30d)</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-amber-900">{waste30d.toLocaleString()}</p>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Export detailed ledger from <strong className="font-medium text-gray-600">Data Ledger</strong> for audit trails.
      </p>
    </div>
  );
}
