import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Plus, Trash2 } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { Modal } from '../components/Modal';
import { supabase } from '../utils/supabase';
import { formatDateForInput, type DateRange } from '../utils/dateRange';
import { hubRowAvailableQuantity } from '../utils/hubInventoryMath';
import {
  postSalesJournal,
  postSalesJournalFifoBySku,
  replaceSalesJournal,
  voidSalesJournal,
  type SalesJournalLineInput,
} from '../utils/visibilityService';
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

interface OutletInventoryLotWithLabel extends OutletInventoryLot {
  product_batch_label?: string | null;
}

interface OutletInventoryRowForSku {
  product_batch: string;
  lot: OutletInventoryLotWithLabel | OutletInventoryLotWithLabel[] | null;
}

function normalizeLot(lot: OutletInventoryRowForFifo['lot']): OutletInventoryLot | null {
  if (lot == null) return null;
  return Array.isArray(lot) ? (lot[0] ?? null) : lot;
}

function normalizeLotWithLabel(
  lot: OutletInventoryRowForSku['lot']
): OutletInventoryLotWithLabel | null {
  if (lot == null) return null;
  return Array.isArray(lot) ? (lot[0] ?? null) : lot;
}

/** Matches server / plan: COALESCE(lot.product_batch_label, product_batch) with trim. */
function displaySkuFromOutletRow(row: OutletInventoryRowForSku): string {
  const lot = normalizeLotWithLabel(row.lot);
  const fromLabel =
    lot?.product_batch_label != null ? String(lot.product_batch_label).trim() : '';
  if (fromLabel !== '') return fromLabel;
  return String(row.product_batch ?? '').trim();
}

function distinctSortedSkus(rows: OutletInventoryRowForSku[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const k = displaySkuFromOutletRow(row);
    if (k) set.add(k);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
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

interface ModalDraftLine extends SalesJournalLineInput {
  key: string;
}

interface SalesJournalHistoryRow {
  id: string;
  business_date: string;
  outlet_id: string;
  notes: string | null;
  lines: { product_batch: string; quantity_sold: number }[];
}

/** Group fetched lines under each journal id, ordered by created_at per journal. */
function linesByJournalFromDb(
  rows: {
    sales_journal_id: string;
    product_batch: string;
    quantity_sold: string | number;
    created_at: string;
  }[]
): Map<string, { product_batch: string; quantity_sold: number }[]> {
  const buckets = new Map<
    string,
    { product_batch: string; quantity_sold: number; created_at: string }[]
  >();
  for (const row of rows) {
    const jid = row.sales_journal_id;
    if (!buckets.has(jid)) buckets.set(jid, []);
    buckets.get(jid)!.push({
      product_batch: row.product_batch,
      quantity_sold: Number(row.quantity_sold),
      created_at: row.created_at,
    });
  }
  const out = new Map<string, { product_batch: string; quantity_sold: number }[]>();
  for (const [jid, arr] of buckets) {
    arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    out.set(
      jid,
      arr.map(({ product_batch, quantity_sold }) => ({ product_batch, quantity_sold }))
    );
  }
  return out;
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
  const [history, setHistory] = useState<SalesJournalHistoryRow[]>([]);

  const [fifoSkus, setFifoSkus] = useState<string[]>([]);
  const [fifoSkusLoading, setFifoSkusLoading] = useState(false);
  const [fifoSku, setFifoSku] = useState('');
  const [fifoQtySold, setFifoQtySold] = useState(0);
  const [fifoPosting, setFifoPosting] = useState(false);
  const fifoSkusGenRef = useRef(0);

  const [journalModalOpen, setJournalModalOpen] = useState(false);
  const [modalJournalId, setModalJournalId] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalDeleting, setModalDeleting] = useState(false);
  const [modalEditMode, setModalEditMode] = useState(false);
  const [modalOutletId, setModalOutletId] = useState('');
  const [modalBusinessDate, setModalBusinessDate] = useState('');
  const [modalNotes, setModalNotes] = useState('');
  const [modalLines, setModalLines] = useState<ModalDraftLine[]>([]);
  const [modalMessage, setModalMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [journalDateRange, setJournalDateRange] = useState<DateRange | null>(null);

  /** Latest outlet id — compare after awaits so overlapping batch loads can't apply wrong outlet rows. */
  const outletIdRef = useRef(outletId);
  outletIdRef.current = outletId;
  /** Invalidate older in-flight batch fetches when a newer load starts or outlet changes intent. */
  const batchesFetchGenRef = useRef(0);
  const inventoryBatchLoadsInFlightRef = useRef(0);

  const refreshFifoSkus = useCallback(async () => {
    const oid = outletIdRef.current;
    if (!oid) {
      setFifoSkus([]);
      setFifoSku('');
      setFifoSkusLoading(false);
      return;
    }
    const gen = ++fifoSkusGenRef.current;
    setFifoSkusLoading(true);
    try {
      const { data, error } = await supabase
        .from('outlet_inventory')
        .select('product_batch, lot:inventory_lots(product_batch_label)')
        .eq('outlet_id', oid)
        .gt('quantity_on_hand', 0);
      if (error) throw error;
      if (gen !== fifoSkusGenRef.current) return;
      const opts = distinctSortedSkus((data ?? []) as OutletInventoryRowForSku[]);
      setFifoSkus(opts);
      setFifoSku((prev) => (prev && opts.includes(prev) ? prev : ''));
    } catch {
      if (gen !== fifoSkusGenRef.current) return;
      setFifoSkus([]);
      setFifoSku('');
    } finally {
      if (gen === fifoSkusGenRef.current) setFifoSkusLoading(false);
    }
  }, []);

  const recentJournalBusy = modalLoading || modalSaving || modalDeleting;

  const populateModalFromJournal = useCallback(async (journalId: string): Promise<boolean> => {
    const { data: header, error: hErr } = await supabase
      .from('sales_journals')
      .select('id,business_date,outlet_id,notes')
      .eq('id', journalId)
      .maybeSingle();

    if (hErr || !header) {
      setModalMessage({ tone: 'err', text: hErr?.message ?? 'Journal not found.' });
      setModalLines([]);
      return false;
    }

    const { data: jl, error: lErr } = await supabase
      .from('sales_journal_lines')
      .select('product_batch,quantity_sold')
      .eq('sales_journal_id', journalId)
      .order('created_at');

    if (lErr) {
      setModalMessage({ tone: 'err', text: lErr.message });
      setModalLines([]);
      return false;
    }

    setModalMessage(null);
    setModalOutletId(header.outlet_id);
    setModalBusinessDate(header.business_date);
    setModalNotes(header.notes ?? '');
    setModalLines(
      (jl ?? []).map((row) => ({
        key: crypto.randomUUID(),
        product_batch: row.product_batch,
        quantity_sold: Number(row.quantity_sold),
      }))
    );
    return true;
  }, []);

  const loadJournalIntoModal = useCallback(
    async (journalId: string) => {
      setJournalModalOpen(true);
      setModalJournalId(journalId);
      setModalLoading(true);
      setModalMessage(null);
      setModalEditMode(false);
      setModalOutletId('');
      setModalBusinessDate('');
      setModalNotes('');
      setModalLines([]);
      try {
        await populateModalFromJournal(journalId);
      } finally {
        setModalLoading(false);
      }
    },
    [populateModalFromJournal]
  );

  const closeJournalModal = useCallback(() => {
    setJournalModalOpen(false);
    setModalJournalId(null);
    setModalLoading(false);
    setModalSaving(false);
    setModalDeleting(false);
    setModalEditMode(false);
    setModalMessage(null);
    setModalOutletId('');
    setModalBusinessDate('');
    setModalNotes('');
    setModalLines([]);
  }, []);

  const loadOutlets = useCallback(async () => {
    const { data } = await supabase.from('outlets').select('*').order('name');
    setOutlets(data ?? []);
    if (data?.length && !outletId) setOutletId(data[0].id);
    setLoading(false);
  }, [outletId]);

  const loadHistory = useCallback(async () => {
    let q = supabase.from('sales_journals').select('id, business_date, outlet_id, notes');

    if (journalDateRange) {
      q = q
        .gte('business_date', formatDateForInput(journalDateRange.start))
        .lte('business_date', formatDateForInput(journalDateRange.end));
    }

    const { data: journals, error: jErr } = await q
      .order('business_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(journalDateRange ? 500 : 25);

    if (jErr) return;

    const list = journals ?? [];
    const ids = list.map((j) => j.id);

    let lineMap = new Map<string, { product_batch: string; quantity_sold: number }[]>();

    if (ids.length > 0) {
      const { data: jl, error: lErr } = await supabase
        .from('sales_journal_lines')
        .select('sales_journal_id,product_batch,quantity_sold,created_at')
        .in('sales_journal_id', ids);
      lineMap = linesByJournalFromDb(!lErr && jl ? jl : []);
    }

    setHistory(
      list.map((j) => ({
        ...j,
        lines: lineMap.get(j.id) ?? [],
      }))
    );
  }, [journalDateRange]);

  useEffect(() => {
    void loadOutlets();
  }, [loadOutlets]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    setInventoryEmptyNotice(false);
    batchesFetchGenRef.current += 1;
  }, [outletId]);

  useEffect(() => {
    void refreshFifoSkus();
  }, [outletId, refreshFifoSkus]);

  const loadBatchesFromInventory = useCallback(
    async (opts?: { afterPost?: boolean }) => {
      const outletSnap = outletIdRef.current;
      if (!outletSnap) {
        setMessage({ tone: 'err', text: 'Select an outlet.' });
        return false;
      }

      const gen = ++batchesFetchGenRef.current;
      inventoryBatchLoadsInFlightRef.current += 1;
      setBatchesLoading(true);
      if (!opts?.afterPost) setMessage(null);
      try {
        const { data, error } = await supabase
          .from('outlet_inventory')
          .select(
            'id, product_batch, quantity_on_hand, reserved_quantity, available_quantity, created_at, lot:inventory_lots(expiry_date, manufactured_at)'
          )
          .eq('outlet_id', outletSnap)
          .gt('quantity_on_hand', 0);

        if (error) throw error;

        if (gen !== batchesFetchGenRef.current || outletSnap !== outletIdRef.current) {
          return true;
        }

        const next = outletInventoryFifoToLines((data ?? []) as OutletInventoryRowForFifo[]);
        const isEmpty = next.length === 1 && next[0].product_batch === '';
        setLines(next);
        setInventoryEmptyNotice(isEmpty);
        return true;
      } catch (err) {
        const text = err instanceof Error ? err.message : 'Failed to load outlet inventory.';
        if (gen === batchesFetchGenRef.current && outletSnap === outletIdRef.current) {
          setMessage({ tone: 'err', text });
        }
        return false;
      } finally {
        inventoryBatchLoadsInFlightRef.current -= 1;
        if (inventoryBatchLoadsInFlightRef.current <= 0) {
          inventoryBatchLoadsInFlightRef.current = 0;
          setBatchesLoading(false);
        }
      }
    },
    []
  );

  async function handleFifoPost() {
    setMessage(null);
    if (!outletId) {
      setMessage({ tone: 'err', text: 'Select an outlet.' });
      return;
    }
    if (!fifoSku) {
      setMessage({ tone: 'err', text: 'Select a SKU with stock at this outlet.' });
      return;
    }
    const qty = Number(fifoQtySold);
    if (!Number.isFinite(qty) || qty <= 0) {
      setMessage({ tone: 'err', text: 'Enter a quantity greater than zero.' });
      return;
    }
    setFifoPosting(true);
    try {
      const res = await postSalesJournalFifoBySku({
        outletId,
        businessDate,
        sku: fifoSku,
        quantitySold: qty,
        notes: notes.trim() || undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error ?? 'Failed to post FIFO sale.' });
        return;
      }
      setMessage({
        tone: 'ok',
        text: res.idempotentReplay
          ? 'FIFO sale already recorded (idempotent replay).'
          : `Posted FIFO sale${res.salesJournalId ? ` ${res.salesJournalId.slice(0, 8)}…` : ''}.`,
      });
      setFifoQtySold(0);
      void loadHistory();
      await loadBatchesFromInventory({ afterPost: true });
      await refreshFifoSkus();
    } finally {
      setFifoPosting(false);
    }
  }

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

  async function handleModalDelete() {
    if (!modalJournalId) return;
    if (
      !window.confirm(
        'Delete this journal? Outlet stock will be restored for each line.'
      )
    )
      return;
    setModalMessage(null);
    setModalDeleting(true);
    try {
      const res = await voidSalesJournal({ salesJournalId: modalJournalId });
      if (!res.success) {
        setModalMessage({ tone: 'err', text: res.error ?? 'Failed to void journal.' });
        return;
      }
      await loadHistory();
      closeJournalModal();
      setMessage({ tone: 'ok', text: 'Sales journal deleted and stock restored.' });
    } finally {
      setModalDeleting(false);
    }
  }

  async function handleModalSave() {
    if (!modalJournalId) return;
    const cleaned = modalLines
      .map((l) => ({
        product_batch: l.product_batch.trim(),
        quantity_sold: Number(l.quantity_sold),
      }))
      .filter((l) => l.product_batch && Number.isFinite(l.quantity_sold) && l.quantity_sold > 0);
    if (!cleaned.length) {
      setModalMessage({ tone: 'err', text: 'Keep at least one line with batch and quantity.' });
      return;
    }

    setModalMessage(null);
    setModalSaving(true);
    try {
      const res = await replaceSalesJournal({
        existingSalesJournalId: modalJournalId,
        businessDate: modalBusinessDate,
        lines: cleaned,
        notes: modalNotes.trim() || undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!res.success) {
        setModalMessage({ tone: 'err', text: res.error ?? 'Failed to update journal.' });
        return;
      }
      await loadHistory();
      closeJournalModal();
      setMessage({
        tone: 'ok',
        text: res.idempotentReplay
          ? 'Journal update replayed (idempotent).'
          : `Sales journal updated${res.salesJournalId ? ` (${res.salesJournalId.slice(0, 8)}…)` : ''}.`,
      });
    } finally {
      setModalSaving(false);
    }
  }

  async function cancelModalEdit() {
    if (!modalJournalId) return;
    setModalLoading(true);
    setModalMessage(null);
    try {
      await populateModalFromJournal(modalJournalId);
    } finally {
      setModalEditMode(false);
      setModalLoading(false);
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
          Post a <span className="font-medium text-gray-700">FIFO sale by SKU</span> for quick outlet
          depletion, or use manual lines below for specific batches or non-FIFO corrections.
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

        <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-4">
          <h2 className="text-sm font-semibold text-gray-900">FIFO sale by SKU</h2>
          <p className="mt-1 text-xs text-gray-600">
            Chooses outlet stock in FIFO order (expiry, manufacture date, then receipt). Uses the same
            SKU label as inventory: lot label when linked, otherwise the stored product batch string.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">SKU</label>
              <select
                value={fifoSku}
                onChange={(e) => setFifoSku(e.target.value)}
                disabled={!outletId || fifoSkusLoading || fifoSkus.length === 0}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-100"
              >
                <option value="">
                  {fifoSkusLoading
                    ? 'Loading SKUs…'
                    : fifoSkus.length === 0
                      ? 'No SKUs with stock'
                      : 'Select SKU'}
                </option>
                {fifoSkus.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-full sm:w-32">
              <label className="mb-1 block text-xs font-medium text-gray-700">Qty sold</label>
              <input
                type="number"
                min={0}
                step="0.0001"
                placeholder="Qty"
                value={Number.isFinite(fifoQtySold) ? fifoQtySold : ''}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setFifoQtySold(Number.isFinite(v) ? v : 0);
                }}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <div className="sm:pb-0.5">
              <button
                type="button"
                onClick={() => void handleFifoPost()}
                disabled={
                  !outletId ||
                  !fifoSku ||
                  fifoSkusLoading ||
                  fifoPosting ||
                  fifoSkus.length === 0 ||
                  !Number.isFinite(fifoQtySold) ||
                  fifoQtySold <= 0
                }
                className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 sm:w-auto"
              >
                {fifoPosting ? 'Posting…' : 'Post FIFO sale'}
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <label className="text-sm font-medium text-gray-700">Manual lines</label>
              <p className="mt-0.5 text-xs text-gray-500">
                Advanced: edit batches and quantities line by line—for splits, overrides, or when FIFO
                by SKU is not what you need.
              </p>
            </div>
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
                    value={Number.isFinite(line.quantity_sold) ? line.quantity_sold : ''}
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
          disabled={submitting || batchesLoading || fifoPosting}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? 'Posting…' : 'Post manual journal'}
        </button>
      </form>

      <div>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Recent journals</h2>
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <DateFilter onFilterChange={(range) => setJournalDateRange(range)} />
            <p className="max-w-xs text-xs text-gray-500 sm:text-right">
              Filters the list by each journal&apos;s <strong className="font-medium text-gray-600">business date</strong>.
              {!journalDateRange && ' With no filter, the 25 most recent journals are shown.'}
            </p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white text-sm">
          <table className="w-full">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Date</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Outlet</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 min-w-[12rem]">Qty sold</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Notes</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                    No journals yet
                  </td>
                </tr>
              ) : (
                history.map((h) => (
                  <tr key={h.id}>
                    <td className="whitespace-nowrap px-4 py-2 align-top">{h.business_date}</td>
                    <td className="px-4 py-2 align-top whitespace-nowrap">
                      {outlets.find((o) => o.id === h.outlet_id)?.name ?? h.outlet_id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-2 align-top">
                      {h.lines.length === 0 ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <ul className="space-y-1 font-mono text-xs text-gray-800 sm:text-sm">
                          {h.lines.map((ln, i) => (
                            <li key={`${h.id}-${i}-${ln.product_batch}`}>
                              <span className="font-semibold">{ln.quantity_sold}</span>
                              <span className="mx-1 text-gray-400">×</span>
                              <span className="break-all">{ln.product_batch}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="max-w-[10rem] px-4 py-2 align-top text-gray-600 sm:max-w-xs">
                      {h.notes ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right align-top">
                      <button
                        type="button"
                        onClick={() => void loadJournalIntoModal(h.id)}
                        disabled={recentJournalBusy}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <Eye size={14} aria-hidden /> View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={journalModalOpen}
        onClose={() => closeJournalModal()}
        title={modalJournalId ? `Journal ${modalJournalId.slice(0, 8)}…` : 'Journal'}
        size="lg"
      >
        {modalLoading && modalLines.length === 0 ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-4">
            {modalMessage && (
              <div
                className={`rounded-lg px-3 py-2 text-sm ${
                  modalMessage.tone === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800'
                }`}
              >
                {modalMessage.text}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-gray-500">Outlet</p>
                <p className="text-sm text-gray-900">
                  {outlets.find((o) => o.id === modalOutletId)?.name ??
                    (modalOutletId ? modalOutletId.slice(0, 8) + '…' : '—')}
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Business date</label>
                <input
                  type="date"
                  value={modalBusinessDate}
                  onChange={(e) => setModalBusinessDate(e.target.value)}
                  disabled={!modalEditMode}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-600"
                  required={modalEditMode}
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Notes</label>
              <textarea
                value={modalNotes}
                onChange={(e) => setModalNotes(e.target.value)}
                disabled={!modalEditMode}
                rows={2}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-600"
              />
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <label className="text-sm font-medium text-gray-700">Lines</label>
                {modalEditMode && (
                  <button
                    type="button"
                    onClick={() =>
                      setModalLines((prev) => [
                        ...prev,
                        { key: crypto.randomUUID(), product_batch: '', quantity_sold: 0 },
                      ])
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <Plus size={14} /> Add line
                  </button>
                )}
              </div>
              {!modalEditMode ? (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">Product batch</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-600">Qty sold</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {modalLines.length === 0 ? (
                        <tr>
                          <td colSpan={2} className="px-3 py-4 text-center text-gray-400">
                            No lines
                          </td>
                        </tr>
                      ) : (
                        modalLines.map((ln) => (
                          <tr key={ln.key}>
                            <td className="px-3 py-2 font-medium text-gray-900">{ln.product_batch}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                              {ln.quantity_sold}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-2">
                  {modalLines.map((ln, mi) => (
                    <div key={ln.key} className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[120px] flex-1">
                        <input
                          value={ln.product_batch}
                          onChange={(e) => {
                            const v = e.target.value;
                            setModalLines((prev) =>
                              prev.map((row, i) => (i === mi ? { ...row, product_batch: v } : row))
                            );
                          }}
                          placeholder="Product batch"
                          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div className="w-28">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={ln.quantity_sold || ''}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setModalLines((prev) =>
                              prev.map((row, i) =>
                                i === mi ? { ...row, quantity_sold: Number.isFinite(v) ? v : 0 } : row
                              )
                            );
                          }}
                          placeholder="Qty"
                          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={modalLines.length <= 1}
                        onClick={() => setModalLines((prev) => prev.filter((_, i) => i !== mi))}
                        className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-30"
                        aria-label="Remove line"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-4">
              {!modalEditMode ? (
                <>
                  <button
                    type="button"
                    onClick={() => setModalEditMode(true)}
                    disabled={recentJournalBusy}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleModalDelete()}
                    disabled={recentJournalBusy}
                    className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {modalDeleting ? 'Deleting…' : 'Delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => closeJournalModal()}
                    className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-200"
                  >
                    Close
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void cancelModalEdit()}
                    disabled={modalSaving}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleModalSave()}
                    disabled={modalSaving}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {modalSaving ? 'Saving…' : 'Save changes'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
