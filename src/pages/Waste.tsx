import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { postWasteEvent, type WasteLineHubInput, type WasteLineOutletInput } from '../utils/visibilityService';
import type { Outlet } from '../types';

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
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
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
    </div>
  );
}
