import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { hubRowAvailableQuantity } from '../utils/hubInventoryMath';
import { postSalesJournal, type SalesJournalLineInput } from '../utils/visibilityService';
import type { Outlet } from '../types';

interface LineRow extends SalesJournalLineInput {
  key: string;
  /** UI-only; from inventory_lots.manufactured_at when loaded */
  production_date_label: string | null;
}

const blankLines = (): LineRow[] => [
  { key: crypto.randomUUID(), product_batch: '', quantity_sold: 0, production_date_label: null },
];

interface OutletInventoryLot {
  expiry_date: string | null;
  manufactured_at: string | null;
}

interface OutletInventoryRowForFifo {
  id: string;
  product_batch: string;
  quantity_on_hand: number;
  reserved_quantity: number | null;
  available_quantity: number | null;
  created_at: string | null;
  lot: OutletInventoryLot | OutletInventoryLot[] | null;
}

function normalizeLot(lot: OutletInventoryRowForFifo['lot']): OutletInventoryLot | null {
  if (lot == null) return null;
  return Array.isArray(lot) ? (lot[0] ?? null) : lot;
}

function formatProductionDateLabel(manufacturedAt: string | null | undefined): string | null {
  if (manufacturedAt == null || manufacturedAt === '') return null;
  const d = new Date(manufacturedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { dateStyle: 'short' });
}

/** Ascending with null/empty last (FIFO: unknown dates after known). */
function compareNullableStringAsc(a: string | null | undefined, b: string | null | undefined): number {
  const emptyA = a == null || a === '';
  const emptyB = b == null || b === '';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;
  return a.localeCompare(b);
}

function outletInventoryFifoToLines(rows: OutletInventoryRowForFifo[]): LineRow[] {
  const parsed = rows
    .map((row) => {
      const batch = row.product_batch.trim();
      if (!batch) return null;
      return { row, batch, lot: normalizeLot(row.lot) };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  if (parsed.length === 0) return blankLines();

  parsed.sort((a, b) => {
    const byExpiry = compareNullableStringAsc(a.lot?.expiry_date, b.lot?.expiry_date);
    if (byExpiry !== 0) return byExpiry;
    const byMfg = compareNullableStringAsc(a.lot?.manufactured_at, b.lot?.manufactured_at);
    if (byMfg !== 0) return byMfg;
    const byCreated = compareNullableStringAsc(a.row.created_at, b.row.created_at);
    if (byCreated !== 0) return byCreated;
    return a.row.id.localeCompare(b.row.id);
  });

  return parsed.map(({ row, batch, lot }) => {
    const qoh = Number(row.quantity_on_hand ?? 0);
    const res = Number(row.reserved_quantity ?? 0);
    const avail = hubRowAvailableQuantity(qoh, res, row.available_quantity);
    return {
      key: crypto.randomUUID(),
      product_batch: batch,
      quantity_sold: avail,
      production_date_label: formatProductionDateLabel(lot?.manufactured_at),
    };
  });
}

export function Sales() {
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState('');
  const [businessDate, setBusinessDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [lines, setLines] = useState<LineRow[]>(() => blankLines());
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [inventoryEmptyNotice, setInventoryEmptyNotice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [history, setHistory] = useState<
    { id: string; business_date: string; outlet_id: string; notes: string | null }[]
  >([]);

  const loadOutlets = useCallback(async () => {
    const { data } = await supabase.from('outlets').select('*').order('name');
    setOutlets(data ?? []);
    if (data?.length && !outletId) setOutletId(data[0].id);
    setLoading(false);
  }, [outletId]);

  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from('sales_journals')
      .select('id, business_date, outlet_id, notes')
      .order('created_at', { ascending: false })
      .limit(25);
    setHistory((data ?? []) as typeof history);
  }, []);

  useEffect(() => {
    void loadOutlets();
    void loadHistory();
  }, [loadOutlets, loadHistory]);

  useEffect(() => {
    setInventoryEmptyNotice(false);
  }, [outletId]);

  const loadBatchesFromInventory = useCallback(
    async (opts?: { afterPost?: boolean }) => {
      if (!outletId) {
        setMessage({ tone: 'err', text: 'Select an outlet.' });
        return false;
      }
      setBatchesLoading(true);
      if (!opts?.afterPost) setMessage(null);
      try {
        const { data, error } = await supabase
          .from('outlet_inventory')
          .select(
            'id, product_batch, quantity_on_hand, reserved_quantity, available_quantity, created_at, lot:inventory_lots(expiry_date, manufactured_at)'
          )
          .eq('outlet_id', outletId)
          .gt('quantity_on_hand', 0);

        if (error) throw error;

        const next = outletInventoryFifoToLines((data ?? []) as OutletInventoryRowForFifo[]);
        const isEmpty = next.length === 1 && next[0].product_batch === '';
        setLines(next);
        setInventoryEmptyNotice(isEmpty);
        return true;
      } catch (err) {
        const text = err instanceof Error ? err.message : 'Failed to load outlet inventory.';
        setMessage({ tone: 'err', text });
        return false;
      } finally {
        setBatchesLoading(false);
      }
    },
    [outletId]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (!outletId) {
      setMessage({ tone: 'err', text: 'Select an outlet.' });
      return;
    }
    const cleaned = lines
      .map((l) => ({
        product_batch: l.product_batch.trim(),
        quantity_sold: Number(l.quantity_sold),
      }))
      .filter((l) => l.product_batch && Number.isFinite(l.quantity_sold) && l.quantity_sold > 0);
    if (!cleaned.length) {
      setMessage({ tone: 'err', text: 'Add at least one line with batch and quantity.' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await postSalesJournal({
        outletId,
        businessDate,
        lines: cleaned,
        notes: notes.trim() || undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error ?? 'Failed to post sales journal.' });
        return;
      }
      setMessage({
        tone: 'ok',
        text: res.idempotentReplay
          ? 'Journal already recorded (idempotent replay).'
          : `Posted sales journal${res.salesJournalId ? ` ${res.salesJournalId.slice(0, 8)}…` : ''}.`,
      });
      setNotes('');
      const reloaded = await loadBatchesFromInventory({ afterPost: true });
      if (!reloaded) setLines(blankLines());
      void loadHistory();
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
        <h1 className="text-2xl font-bold text-gray-900">Outlet sales journal</h1>
        <p className="mt-1 text-sm text-gray-500">
          Record manual sales depletion by product batch (same identifiers as outlet inventory).
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
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Outlet</label>
            <select
              value={outletId}
              onChange={(e) => setOutletId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              required
            >
              {outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Business date</label>
            <input
              type="date"
              value={businessDate}
              onChange={(e) => setBusinessDate(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              required
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm font-medium text-gray-700">Lines</label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void loadBatchesFromInventory()}
                disabled={!outletId || batchesLoading}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {batchesLoading ? 'Loading…' : 'Load batches from inventory'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setInventoryEmptyNotice(false);
                  setLines((prev) => [
                    ...prev,
                    {
                      key: crypto.randomUUID(),
                      product_batch: '',
                      quantity_sold: 0,
                      production_date_label: null,
                    },
                  ]);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Plus size={14} /> Add line
              </button>
            </div>
          </div>
          {inventoryEmptyNotice && (
            <p className="mb-2 text-sm text-gray-500">No stocked batches for this outlet.</p>
          )}
          <p className="mb-2 text-sm text-gray-500">
            Loading batches pulls outlet stock in FIFO order (earliest expiry and lot dates first) and prefills{' '}
            <span className="font-medium text-gray-600">Qty sold</span> with available stock—change each row to units
            actually sold before posting.
          </p>
          <div className="mb-1 hidden gap-2 sm:flex sm:items-end sm:gap-2 sm:px-1">
            <div className="min-w-[140px] flex-1 text-xs font-medium text-gray-500">Product batch</div>
            <div className="w-28 min-w-[7rem] text-xs font-medium text-gray-500">Prod. date</div>
            <div className="w-28 text-xs font-medium text-gray-500">Qty sold</div>
            <div className="w-10 shrink-0" aria-hidden />
          </div>
          <div className="space-y-3">
            {lines.map((line, idx) => (
              <div key={line.key} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[140px] flex-1">
                  <span className="mb-1 block text-xs font-medium text-gray-500 sm:hidden">Product batch</span>
                  <input
                    placeholder="Product batch"
                    value={line.product_batch}
                    onChange={(e) => {
                      const v = e.target.value;
                      setLines((prev) =>
                        prev.map((r, i) =>
                          i === idx ? { ...r, product_batch: v, production_date_label: null } : r
                        )
                      );
                    }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="w-full min-w-[7rem] sm:w-28">
                  <span className="mb-1 block text-xs font-medium text-gray-500 sm:hidden">Prod. date</span>
                  <div
                    className="flex min-h-[38px] items-center rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm tabular-nums text-gray-800"
                    title={
                      line.production_date_label
                        ? `Production date ${line.production_date_label}`
                        : 'No production date on file for this lot'
                    }
                  >
                    {line.production_date_label ?? '—'}
                  </div>
                </div>
                <div className="w-28">
                  <span className="mb-1 block text-xs font-medium text-gray-500 sm:hidden">Qty sold</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Qty sold"
                    value={line.quantity_sold || ''}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setLines((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, quantity_sold: Number.isFinite(v) ? v : 0 } : r))
                      );
                    }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                  disabled={lines.length <= 1}
                  className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-30"
                  aria-label="Remove line"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        </div>

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
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? 'Posting…' : 'Post journal'}
        </button>
      </form>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Recent journals</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white text-sm">
          <table className="w-full">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Date</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Outlet</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-gray-400">
                    No journals yet
                  </td>
                </tr>
              ) : (
                history.map((h) => (
                  <tr key={h.id}>
                    <td className="px-4 py-2">{h.business_date}</td>
                    <td className="px-4 py-2">
                      {outlets.find((o) => o.id === h.outlet_id)?.name ?? h.outlet_id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-2 text-gray-600">{h.notes ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
