import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { supabase } from '../utils/supabase';
import { postWasteEvent, type WasteLineHubInput, type WasteLineOutletInput } from '../utils/visibilityService';
import type { Outlet } from '../types';
import type { DateRange } from '../utils/dateRange';

const HISTORY_PAGE_SIZE = 25;

interface WasteHistoryRow {
  id: string;
  location_kind: 'hub' | 'outlet';
  waste_date: string;
  notes: string | null;
  created_at: string;
  outlet?: { name: string } | { name: string }[] | null;
  line_count: number;
  total_qty: number;
}

type Kind = 'hub' | 'outlet';

interface HubPickRow {
  id: string;
  product_batch: string | null;
  label: string;
}

interface LineHub {
  key: string;
  hub_inventory_id: string;
  product_batch: string;
  quantity: number;
  waste_reason: string;
}

interface LineOutlet {
  key: string;
  product_batch: string;
  quantity: number;
  waste_reason: string;
}

const REASONS = ['spoilage', 'damage', 'expiry', 'sampling', 'quality_issue', 'other'];

export function Waste() {
  const [kind, setKind] = useState<Kind>('outlet');
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState('');
  const [hubRows, setHubRows] = useState<HubPickRow[]>([]);
  const [wasteDate, setWasteDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [linesHub, setLinesHub] = useState<LineHub[]>([
    { key: crypto.randomUUID(), hub_inventory_id: '', product_batch: '', quantity: 0, waste_reason: 'spoilage' },
  ]);
  const [linesOutlet, setLinesOutlet] = useState<LineOutlet[]>([
    { key: crypto.randomUUID(), product_batch: '', quantity: 0, waste_reason: 'spoilage' },
  ]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [historyRange, setHistoryRange] = useState<DateRange | null>(null);
  const [history, setHistory] = useState<WasteHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);

  const load = useCallback(async () => {
    const [{ data: outs }, { data: hub }] = await Promise.all([
      supabase.from('outlets').select('*').order('name'),
      supabase
        .from('hub_inventory')
        .select('id, product_batch, raw_material_id, material:raw_material_id(name)')
        .order('last_updated', { ascending: false }),
    ]);
    setOutlets(outs ?? []);
    if (outs?.length && !outletId) setOutletId(outs[0].id);

    const picks: HubPickRow[] = (hub ?? []).map((row) => {
      const r = row as {
        id: string;
        product_batch: string | null;
        material?: { name: string } | { name: string }[] | null;
      };
      const mat = Array.isArray(r.material) ? r.material[0] : r.material;
      const pb = r.product_batch?.trim();
      const mn = mat?.name?.trim();
      return {
        id: r.id,
        product_batch: r.product_batch,
        label: pb || mn || `Hub row ${r.id.slice(0, 8)}`,
      };
    });
    setHubRows(picks);
    setLoading(false);
  }, [outletId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadHistory = useCallback(
    async (page: number, append: boolean) => {
      setHistoryLoading(true);
      try {
        let query = supabase
          .from('waste_events')
          .select('id, location_kind, waste_date, notes, created_at, outlet:outlet_id(name)')
          .eq('status', 'posted')
          .order('waste_date', { ascending: false })
          .order('created_at', { ascending: false })
          .range(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE - 1);

        if (historyRange) {
          const from = historyRange.start.toISOString().slice(0, 10);
          const to = historyRange.end.toISOString().slice(0, 10);
          query = query.gte('waste_date', from).lte('waste_date', to);
        }

        const { data: events, error } = await query;
        if (error) throw error;

        const ids = (events ?? []).map((e) => e.id as string);
        const { data: lines } =
          ids.length > 0
            ? await supabase.from('waste_lines').select('waste_event_id, quantity').in('waste_event_id', ids)
            : { data: [] as { waste_event_id: string; quantity: number }[] };

        const qtyByEvent = new Map<string, { count: number; total: number }>();
        for (const line of lines ?? []) {
          const eid = line.waste_event_id as string;
          const prev = qtyByEvent.get(eid) ?? { count: 0, total: 0 };
          prev.count += 1;
          prev.total += Number(line.quantity ?? 0);
          qtyByEvent.set(eid, prev);
        }

        const mapped: WasteHistoryRow[] = (events ?? []).map((e) => {
          const agg = qtyByEvent.get(e.id as string) ?? { count: 0, total: 0 };
          return {
            id: e.id as string,
            location_kind: e.location_kind as 'hub' | 'outlet',
            waste_date: String(e.waste_date),
            notes: e.notes as string | null,
            created_at: String(e.created_at),
            outlet: e.outlet as WasteHistoryRow['outlet'],
            line_count: agg.count,
            total_qty: agg.total,
          };
        });

        setHistory((prev) => (append ? [...prev, ...mapped] : mapped));
        setHistoryHasMore(mapped.length === HISTORY_PAGE_SIZE);
      } finally {
        setHistoryLoading(false);
      }
    },
    [historyRange]
  );

  useEffect(() => {
    setHistoryPage(0);
  }, [historyRange]);

  useEffect(() => {
    void loadHistory(historyPage, historyPage > 0);
  }, [historyPage, loadHistory]);

  function syncHubBatch(idx: number, hubInvId: string) {
    const row = hubRows.find((h) => h.id === hubInvId);
    const batchText = row?.product_batch?.trim() || row?.label || 'HUB';
    setLinesHub((prev) =>
      prev.map((l, i) =>
        i === idx ? { ...l, hub_inventory_id: hubInvId, product_batch: batchText } : l
      )
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setSubmitting(true);
    try {
      if (kind === 'hub') {
        const payload: WasteLineHubInput[] = linesHub
          .filter((l) => l.hub_inventory_id && l.quantity > 0 && l.waste_reason)
          .map((l) => ({
            hub_inventory_id: l.hub_inventory_id,
            product_batch: l.product_batch.trim() || '—',
            quantity: l.quantity,
            waste_reason: l.waste_reason,
          }));
        if (!payload.length) {
          setMessage({ tone: 'err', text: 'Add valid hub waste lines.' });
          return;
        }
        const res = await postWasteEvent({
          locationKind: 'hub',
          outletId: null,
          wasteDate,
          lines: payload,
          notes: notes.trim() || undefined,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!res.success) {
          setMessage({ tone: 'err', text: res.error ?? 'Failed to post waste.' });
          return;
        }
        setMessage({ tone: 'ok', text: 'Hub waste recorded.' });
      } else {
        if (!outletId) {
          setMessage({ tone: 'err', text: 'Select an outlet.' });
          return;
        }
        const payload: WasteLineOutletInput[] = linesOutlet
          .filter((l) => l.product_batch.trim() && l.quantity > 0 && l.waste_reason)
          .map((l) => ({
            outlet_id: outletId,
            product_batch: l.product_batch.trim(),
            quantity: l.quantity,
            waste_reason: l.waste_reason,
          }));
        if (!payload.length) {
          setMessage({ tone: 'err', text: 'Add valid outlet waste lines.' });
          return;
        }
        const res = await postWasteEvent({
          locationKind: 'outlet',
          outletId,
          wasteDate,
          lines: payload,
          notes: notes.trim() || undefined,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!res.success) {
          setMessage({ tone: 'err', text: res.error ?? 'Failed to post waste.' });
          return;
        }
        setMessage({ tone: 'ok', text: 'Outlet waste recorded.' });
      }
      void load();
      setHistoryPage(0);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Waste & spoilage</h1>
        <p className="mt-1 text-sm text-gray-500">
          Post hub or outlet waste; quantities respect reserved stock (available only).
        </p>
      </div>

      {message && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            message.tone === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="kind" checked={kind === 'outlet'} onChange={() => setKind('outlet')} />
            Outlet
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="kind" checked={kind === 'hub'} onChange={() => setKind('hub')} />
            Hub
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {kind === 'outlet' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Outlet</label>
              <select
                value={outletId}
                onChange={(e) => setOutletId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {outlets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Event date</label>
            <input
              type="date"
              value={wasteDate}
              onChange={(e) => setWasteDate(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        {kind === 'hub' ? (
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-sm font-medium text-gray-700">Hub lines</span>
              <button
                type="button"
                onClick={() =>
                  setLinesHub((p) => [
                    ...p,
                    {
                      key: crypto.randomUUID(),
                      hub_inventory_id: '',
                      product_batch: '',
                      quantity: 0,
                      waste_reason: 'spoilage',
                    },
                  ])
                }
                className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
              >
                <Plus size={14} /> Add
              </button>
            </div>
            {linesHub.map((line, idx) => (
              <div key={line.key} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                <select
                  value={line.hub_inventory_id}
                  onChange={(e) => syncHubBatch(idx, e.target.value)}
                  className="min-w-[200px] flex-1 rounded border px-2 py-2 text-sm"
                >
                  <option value="">Hub inventory row…</option>
                  {hubRows.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Qty"
                  value={line.quantity || ''}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setLinesHub((p) =>
                      p.map((l, i) => (i === idx ? { ...l, quantity: Number.isFinite(v) ? v : 0 } : l))
                    );
                  }}
                  className="w-24 rounded border px-2 py-2 text-sm"
                />
                <select
                  value={line.waste_reason}
                  onChange={(e) =>
                    setLinesHub((p) => p.map((l, i) => (i === idx ? { ...l, waste_reason: e.target.value } : l)))
                  }
                  className="rounded border px-2 py-2 text-sm"
                >
                  {REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setLinesHub((p) => p.filter((_, i) => i !== idx))}
                  disabled={linesHub.length <= 1}
                  className="p-2 text-gray-400 hover:text-red-600 disabled:opacity-30"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-sm font-medium text-gray-700">Outlet lines</span>
              <button
                type="button"
                onClick={() =>
                  setLinesOutlet((p) => [
                    ...p,
                    { key: crypto.randomUUID(), product_batch: '', quantity: 0, waste_reason: 'spoilage' },
                  ])
                }
                className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
              >
                <Plus size={14} /> Add
              </button>
            </div>
            {linesOutlet.map((line, idx) => (
              <div key={line.key} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                <input
                  placeholder="Product batch"
                  value={line.product_batch}
                  onChange={(e) =>
                    setLinesOutlet((p) => p.map((l, i) => (i === idx ? { ...l, product_batch: e.target.value } : l)))
                  }
                  className="min-w-[120px] flex-1 rounded border px-2 py-2 text-sm"
                />
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Qty"
                  value={line.quantity || ''}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setLinesOutlet((p) =>
                      p.map((l, i) => (i === idx ? { ...l, quantity: Number.isFinite(v) ? v : 0 } : l))
                    );
                  }}
                  className="w-24 rounded border px-2 py-2 text-sm"
                />
                <select
                  value={line.waste_reason}
                  onChange={(e) =>
                    setLinesOutlet((p) =>
                      p.map((l, i) => (i === idx ? { ...l, waste_reason: e.target.value } : l))
                    )
                  }
                  className="rounded border px-2 py-2 text-sm"
                >
                  {REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setLinesOutlet((p) => p.filter((_, i) => i !== idx))}
                  disabled={linesOutlet.length <= 1}
                  className="p-2 text-gray-400 hover:text-red-600 disabled:opacity-30"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
        >
          {submitting ? 'Posting…' : 'Post waste event'}
        </button>
      </form>

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Posted waste events</h2>
            <p className="mt-1 text-xs text-gray-500">History of posted hub and outlet waste (newest first).</p>
          </div>
          <DateFilter onFilterChange={(range) => setHistoryRange(range)} />
        </div>

        {historyLoading && history.length === 0 ? (
          <p className="text-sm text-gray-400">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-gray-400">No posted waste events in this period.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-100">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-700">Date</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Location</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-700">Lines</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-700">Total qty</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {history.map((row) => {
                  const outlet = Array.isArray(row.outlet) ? row.outlet[0] : row.outlet;
                  const loc =
                    row.location_kind === 'hub'
                      ? 'Hub'
                      : outlet?.name ?? 'Outlet';
                  return (
                    <tr key={row.id} className="hover:bg-gray-50/80">
                      <td className="px-3 py-2 text-gray-900">{row.waste_date}</td>
                      <td className="px-3 py-2 capitalize text-gray-700">{loc}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.line_count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.total_qty.toLocaleString()}</td>
                      <td className="max-w-[200px] truncate px-3 py-2 text-gray-500">{row.notes?.trim() || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {historyHasMore && (
          <button
            type="button"
            disabled={historyLoading}
            onClick={() => setHistoryPage((p) => p + 1)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {historyLoading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>
    </div>
  );
}
