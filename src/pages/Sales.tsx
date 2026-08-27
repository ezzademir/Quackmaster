import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, ChevronDown, CircleDollarSign, Eye, FileText, Package, Plus, Trash2 } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { Button, EmptyState, PageHeader, StatCard, Tabs } from '../components/ui';
import { Modal } from '../components/Modal';
import { supabase } from '../utils/supabase';
import { formatDateForInput, getLast7Days, type DateRange } from '../utils/dateRange';
import { hubRowAvailableQuantity } from '../utils/hubInventoryMath';
import { useAuth } from '../utils/auth';
import {
  postSalesJournal,
  postSalesJournalFifoBySku,
  replaceSalesJournal,
  voidSalesJournal,
  type SalesJournalLineInput,
} from '../utils/visibilityService';
import { displayLotFirst, formatLotWithSku, isLegacyBatchCode, nestedLotLabel, nestedRecipeSku, skuForDisplay } from '../utils/lotLabel';
import { applyLotIdentifierEdit, toPostableSalesLine } from '../utils/salesJournalLines';
import type { Outlet } from '../types';

interface LineRow extends SalesJournalLineInput {
  key: string;
  /** UI-only; from inventory_lots.manufactured_at when loaded */
  production_date_label: string | null;
  lot_label?: string | null;
  available_qty?: number;
}

const blankLines = (): LineRow[] => [
  { key: crypto.randomUUID(), product_batch: '', quantity_sold: 0, production_date_label: null },
];

/** Page size for Recent journals list; use Next to load more. */
const HISTORY_PAGE_SIZE = 25;

interface OutletInventoryLot {
  expiry_date: string | null;
  manufactured_at: string | null;
  product_batch_label?: string | null;
  production_run?: unknown;
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

function distinctSortedSkus(rows: OutletInventoryRowForSku[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const lot = nestedLotLabel(row.lot as never);
    const recipeSku = nestedRecipeSku(row.lot);
    const sku = skuForDisplay(lot, row.product_batch, recipeSku);
    if (sku) set.add(sku);
    if (lot && !isLegacyBatchCode(lot)) set.add(lot);
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
      product_batch: displayLotFirst(nestedLotLabel(lot as never), batch) || batch,
      quantity_sold: 0,
      outlet_inventory_id: row.id,
      production_date_label: formatProductionDateLabel(lot?.manufactured_at),
      lot_label: nestedLotLabel(lot as never),
      available_qty: avail,
    };
  });
}

interface ModalDraftLine extends SalesJournalLineInput {
  key: string;
  lot_label?: string | null;
}

interface SalesJournalHistoryRow {
  id: string;
  business_date: string;
  outlet_id: string;
  notes: string | null;
  status: string;
  lines: { product_batch: string; quantity_sold: number; lot_label: string | null }[];
}

function isVoidedSalesStatus(status: string | null | undefined): boolean {
  return status === 'voided' || status === 'cancelled';
}

const OVERVIEW_TOP_SKUS = 6;
const OVERVIEW_LINE_CHUNK = 80;

interface SalesSkuTotal {
  label: string;
  qty: number;
}

interface SalesOverview {
  postedJournals: number;
  voidedJournals: number;
  unitsSold: number;
  skuCount: number;
  lastBusinessDate: string | null;
  topSkus: SalesSkuTotal[];
}

function emptySalesOverview(): SalesOverview {
  return {
    postedJournals: 0,
    voidedJournals: 0,
    unitsSold: 0,
    skuCount: 0,
    lastBusinessDate: null,
    topSkus: [],
  };
}

function formatSoldQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function salesPeriodLabel(range: DateRange | null): string {
  if (!range) return 'All time';
  const a = formatDateForInput(range.start);
  const b = formatDateForInput(range.end);
  return a === b ? a : `${a} → ${b}`;
}

/** Group fetched lines under each journal id, ordered by created_at per journal. */
function linesByJournalFromDb(
  rows: {
    sales_journal_id: string;
    product_batch: string;
    quantity_sold: string | number;
    created_at: string;
    lot?: { product_batch_label?: string | null } | { product_batch_label?: string | null }[] | null;
  }[]
): Map<string, { product_batch: string; quantity_sold: number; lot_label: string | null }[]> {
  const buckets = new Map<
    string,
    { product_batch: string; quantity_sold: number; created_at: string; lot_label: string | null }[]
  >();
  for (const row of rows) {
    const jid = row.sales_journal_id;
    if (!buckets.has(jid)) buckets.set(jid, []);
    buckets.get(jid)!.push({
      product_batch: row.product_batch,
      quantity_sold: Number(row.quantity_sold),
      created_at: row.created_at,
      lot_label: nestedLotLabel(row.lot),
    });
  }
  const out = new Map<string, { product_batch: string; quantity_sold: number; lot_label: string | null }[]>();
  for (const [jid, arr] of buckets) {
    arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    out.set(
      jid,
      arr.map(({ product_batch, quantity_sold, lot_label }) => ({ product_batch, quantity_sold, lot_label }))
    );
  }
  return out;
}

export function Sales() {
  const { isAdmin, isSupervisor, profile } = useAuth();
  const [pageTab, setPageTab] = useState<'overview' | 'record'>('overview');
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [includeVoided, setIncludeVoided] = useState(false);
  const [overview, setOverview] = useState<SalesOverview>(() => emptySalesOverview());
  const [overviewLoading, setOverviewLoading] = useState(false);

  const [fifoSkus, setFifoSkus] = useState<string[]>([]);
  const [fifoSkusLoading, setFifoSkusLoading] = useState(false);
  const [fifoSku, setFifoSku] = useState('');
  const [fifoQtySold, setFifoQtySold] = useState(0);
  const [fifoPosting, setFifoPosting] = useState(false);
  const fifoSkusGenRef = useRef(0);
  const overviewGenRef = useRef(0);

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
  const [modalStatus, setModalStatus] = useState('');
  const [modalMessage, setModalMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [journalDateRange, setJournalDateRange] = useState<DateRange | null>(() => getLast7Days());

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
        .select('product_batch, lot:inventory_lots(product_batch_label, production_run:production_run_id(recipe:recipe_id(default_product_batch)))')
        .eq('outlet_id', oid)
        .is('raw_material_id', null)
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
      .select('id,business_date,outlet_id,notes,status')
      .eq('id', journalId)
      .maybeSingle();

    if (hErr || !header) {
      setModalMessage({ tone: 'err', text: hErr?.message ?? 'Journal not found.' });
      setModalLines([]);
      return false;
    }

    const { data: jl, error: lErr } = await supabase
      .from('sales_journal_lines')
      .select('product_batch,quantity_sold,outlet_inventory_id,lot:inventory_lots(product_batch_label)')
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
    setModalStatus(header.status ?? 'posted');
    if (isVoidedSalesStatus(header.status)) {
      setModalEditMode(false);
    }
    setModalLines(
      (jl ?? []).map((row) => ({
        key: crypto.randomUUID(),
        product_batch: row.product_batch,
        quantity_sold: Number(row.quantity_sold),
        outlet_inventory_id: row.outlet_inventory_id ?? undefined,
        lot_label: nestedLotLabel(
          (row as { lot?: { product_batch_label?: string | null } | { product_batch_label?: string | null }[] | null })
            .lot
        ),
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
      setModalStatus('');
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
    setModalStatus('');
  }, []);

  const loadOutlets = useCallback(async () => {
    if (isSupervisor) {
      const oid = profile?.assigned_outlet_id;
      if (!oid) {
        setOutlets([]);
        setOutletId('');
        setLoading(false);
        return;
      }
      const { data } = await supabase.from('outlets').select('*').eq('id', oid).maybeSingle();
      setOutlets(data ? [data as Outlet] : []);
      setOutletId(oid);
      setLoading(false);
      return;
    }
    const { data } = await supabase.from('outlets').select('*').order('name');
    setOutlets(data ?? []);
    if (data?.length && !outletId) setOutletId(data[0].id);
    setLoading(false);
  }, [outletId, isSupervisor, profile?.assigned_outlet_id]);

  const loadHistory = useCallback(
    async (opts?: { mode?: 'replace' | 'append'; beforeLength?: number }): Promise<boolean> => {
      const mode = opts?.mode ?? 'replace';
      if (mode === 'append' && opts?.beforeLength === undefined) {
        console.error('[Sales] loadHistory append requires beforeLength');
        return false;
      }
      const offset = mode === 'replace' ? 0 : Math.max(0, opts!.beforeLength!);

      if (!outletId) {
        if (mode === 'replace') {
          setHistory([]);
          setHistoryHasMore(false);
        }
        return true;
      }

      let q = supabase
        .from('sales_journals')
        .select('id, business_date, outlet_id, notes, status')
        .eq('outlet_id', outletId);

      if (includeVoided) {
        q = q.in('status', ['posted', 'voided', 'cancelled']);
      } else {
        q = q.eq('status', 'posted');
      }

      if (journalDateRange) {
        q = q
          .gte('business_date', formatDateForInput(journalDateRange.start))
          .lte('business_date', formatDateForInput(journalDateRange.end));
      }

      const { data: journals, error: jErr } = await q
        .order('business_date', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + HISTORY_PAGE_SIZE - 1);

      if (jErr) {
        console.error('[Sales] Failed to load sales journals:', jErr);
        return false;
      }

      const list = journals ?? [];
      const ids = list.map((j) => j.id);

      let lineMap = new Map<string, { product_batch: string; quantity_sold: number; lot_label: string | null }[]>();

      if (ids.length > 0) {
        const { data: jl, error: lErr } = await supabase
          .from('sales_journal_lines')
          .select('sales_journal_id,product_batch,quantity_sold,created_at,lot:inventory_lots(product_batch_label)')
          .in('sales_journal_id', ids);
        if (lErr) {
          console.error('[Sales] Failed to load sales journal lines:', lErr);
        }
        lineMap = linesByJournalFromDb(!lErr && jl ? jl : []);
      }

      const mapped = list.map((j) => ({
        ...j,
        status: j.status ?? 'posted',
        lines: lineMap.get(j.id) ?? [],
      }));

      if (mode === 'replace') {
        setHistory(mapped);
      } else {
        setHistory((prev) => [...prev, ...mapped]);
      }

      setHistoryHasMore(mapped.length === HISTORY_PAGE_SIZE);
      return true;
    },
    [journalDateRange, outletId, includeVoided]
  );

  const loadOverview = useCallback(async () => {
    const oid = outletId;
    const gen = ++overviewGenRef.current;
    if (!oid) {
      setOverview(emptySalesOverview());
      setOverviewLoading(false);
      return;
    }

    setOverviewLoading(true);
    try {
      let jq = supabase
        .from('sales_journals')
        .select('id, status, business_date')
        .eq('outlet_id', oid);
      if (journalDateRange) {
        jq = jq
          .gte('business_date', formatDateForInput(journalDateRange.start))
          .lte('business_date', formatDateForInput(journalDateRange.end));
      }
      const { data: journals, error: jErr } = await jq;
      if (jErr) throw jErr;
      if (gen !== overviewGenRef.current) return;

      const rows = journals ?? [];
      const posted = rows.filter((j) => j.status === 'posted');
      const voidedJournals = rows.filter((j) => isVoidedSalesStatus(j.status)).length;
      const postedIds = posted.map((j) => j.id);

      const lineRows: {
        product_batch: string;
        quantity_sold: string | number;
        lot?: { product_batch_label?: string | null; production_run?: unknown } | { product_batch_label?: string | null; production_run?: unknown }[] | null;
      }[] = [];

      for (let i = 0; i < postedIds.length; i += OVERVIEW_LINE_CHUNK) {
        const slice = postedIds.slice(i, i + OVERVIEW_LINE_CHUNK);
        const { data: jl, error: lErr } = await supabase
          .from('sales_journal_lines')
          .select(
            'product_batch,quantity_sold,lot:inventory_lots(product_batch_label, production_run:production_run_id(recipe:recipe_id(default_product_batch)))'
          )
          .in('sales_journal_id', slice);
        if (lErr) throw lErr;
        if (gen !== overviewGenRef.current) return;
        lineRows.push(...(jl ?? []));
      }

      const bySku = new Map<string, number>();
      let unitsSold = 0;
      for (const ln of lineRows) {
        const qty = Number(ln.quantity_sold);
        if (!Number.isFinite(qty) || qty === 0) continue;
        unitsSold += qty;
        const lotLabel = nestedLotLabel(ln.lot as never);
        const recipeSku = nestedRecipeSku(ln.lot);
        const label =
          skuForDisplay(lotLabel, ln.product_batch, recipeSku) ||
          displayLotFirst(lotLabel, ln.product_batch) ||
          String(ln.product_batch ?? '').trim() ||
          '—';
        bySku.set(label, (bySku.get(label) ?? 0) + qty);
      }

      const topSkus = [...bySku.entries()]
        .map(([label, qty]) => ({ label, qty }))
        .sort((a, b) => b.qty - a.qty || a.label.localeCompare(b.label))
        .slice(0, OVERVIEW_TOP_SKUS);

      let lastBusinessDate: string | null = null;
      for (const j of posted) {
        if (!lastBusinessDate || j.business_date > lastBusinessDate) lastBusinessDate = j.business_date;
      }

      if (gen !== overviewGenRef.current) return;
      setOverview({
        postedJournals: posted.length,
        voidedJournals,
        unitsSold,
        skuCount: bySku.size,
        lastBusinessDate,
        topSkus,
      });
    } catch (err) {
      console.error('[Sales] Failed to load overview:', err);
      if (gen !== overviewGenRef.current) return;
      setOverview(emptySalesOverview());
    } finally {
      if (gen === overviewGenRef.current) setOverviewLoading(false);
    }
  }, [outletId, journalDateRange]);

  async function handleLoadMoreHistory() {
    const start = history.length;
    setHistoryLoadingMore(true);
    try {
      await loadHistory({ mode: 'append', beforeLength: start });
    } finally {
      setHistoryLoadingMore(false);
    }
  }

  useEffect(() => {
    void loadOutlets();
  }, [loadOutlets]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    setHistoryLoadingMore(false);
  }, [journalDateRange, outletId, includeVoided]);

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
            'id, product_batch, quantity_on_hand, reserved_quantity, available_quantity, created_at, lot:inventory_lots(expiry_date, manufactured_at, product_batch_label, production_run:production_run_id(recipe:recipe_id(default_product_batch)))'
          )
          .eq('outlet_id', outletSnap)
          .is('raw_material_id', null)
          .gt('quantity_on_hand', 0);

        if (error) throw error;

        if (gen !== batchesFetchGenRef.current || outletSnap !== outletIdRef.current) {
          return true;
        }

        const next = outletInventoryFifoToLines((data ?? []) as OutletInventoryRowForFifo[]);
        const isEmpty = next.length === 1 && next[0].product_batch === '';
        setLines(next);
        setInventoryEmptyNotice(isEmpty);
        setAdvancedOpen(true);
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
          ? 'Sale already recorded.'
          : `Posted ${formatSoldQty(qty)} units`,
      });
      setFifoQtySold(0);
      void loadHistory();
      void loadOverview();
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
      .map((l) => toPostableSalesLine({ ...l, quantity_sold: Number(l.quantity_sold) }))
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
      const postedQty = cleaned.reduce((sum, l) => sum + l.quantity_sold, 0);
      setMessage({
        tone: 'ok',
        text: res.idempotentReplay
          ? 'Sale already recorded.'
          : `Posted ${formatSoldQty(postedQty)} units`,
      });
      setNotes('');
      const reloaded = await loadBatchesFromInventory({ afterPost: true });
      if (!reloaded) setLines(blankLines());
      void loadHistory();
      void loadOverview();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleModalDelete() {
    if (!modalJournalId) return;
    const journalIdToDelete = modalJournalId;
    if (
      !window.confirm(
        'Void this sale? Outlet stock will be restored. The sale stays on file as voided and leaves the posted list.'
      )
    )
      return;
    setModalMessage(null);
    setModalDeleting(true);
    try {
      const res = await voidSalesJournal({ salesJournalId: journalIdToDelete });
      if (!res.success) {
        setModalMessage({ tone: 'err', text: res.error ?? 'Failed to void sale.' });
        return;
      }
      setHistory((prev) => prev.filter((h) => h.id !== journalIdToDelete));
      const refreshed = await loadHistory();
      void loadOverview();
      void refreshFifoSkus();
      closeJournalModal();
      setMessage({
        tone: 'ok',
        text: refreshed
          ? 'Sale voided. Outlet stock restored.'
          : 'Sale voided and stock restored. If it still appears as posted, refresh the page.',
      });
    } finally {
      setModalDeleting(false);
    }
  }

  async function handleModalSave() {
    if (!modalJournalId) return;
    const cleaned = modalLines
      .map((l) => toPostableSalesLine({ ...l, quantity_sold: Number(l.quantity_sold) }))
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
        setModalMessage({ tone: 'err', text: res.error ?? 'Failed to update sale.' });
        return;
      }
      setHistory((prev) => prev.filter((h) => h.id !== modalJournalId));
      await loadHistory();
      void loadOverview();
      void refreshFifoSkus();
      closeJournalModal();
      setMessage({
        tone: 'ok',
        text: res.idempotentReplay
          ? 'Sale update replayed (idempotent).'
          : 'Sale updated. The previous version was voided and stock was re-posted with your changes.',
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
    return <div className="text-sm text-stone-500">Loading…</div>;
  }

  if (isSupervisor && !profile?.assigned_outlet_id) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 sm:p-4">
        No outlet is assigned to your account. Ask an admin to set your role and outlet under Users.
      </div>
    );
  }

  const outletPicker = (
    <div>
      <label className="mb-1 block text-xs font-medium text-stone-600">Outlet</label>
      {isSupervisor ? (
        <p className="min-w-[12rem] rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800">
          {outlets.find((o) => o.id === outletId)?.name ?? 'Your outlet'}
        </p>
      ) : (
        <select
          value={outletId}
          onChange={(e) => setOutletId(e.target.value)}
          className="min-w-[12rem] rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
        >
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Outlet sales"
        description={
          pageTab === 'overview'
            ? 'Posted sales for this outlet. Voided journals stay on file and are hidden unless included.'
            : 'Record a FIFO sale first. Business date is the day the sale happened.'
        }
        filters={
          <>
            {outletPicker}
            <div className={pageTab === 'overview' ? '' : 'hidden'}>
              <DateFilter
                defaultType="last7Days"
                onFilterChange={(range) => setJournalDateRange(range)}
                hint="Applies to overview totals and recent journals."
              />
            </div>
          </>
        }
      />

      <Tabs
        value={pageTab}
        onChange={setPageTab}
        items={[
          { id: 'overview', label: 'Overview' },
          { id: 'record', label: 'Record sale' },
        ]}
      />

      {pageTab === 'overview' && (
      <div className="space-y-4">
        <p className="text-xs text-stone-500">
          {outlets.find((o) => o.id === outletId)?.name ?? 'Outlet'} · {salesPeriodLabel(journalDateRange)}
          {overview.lastBusinessDate ? ` · last posted ${overview.lastBusinessDate}` : ''}
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={<CircleDollarSign size={18} />}
            tone="brand"
            label="Units sold"
            value={overviewLoading ? '…' : formatSoldQty(overview.unitsSold)}
            sub="Posted journals only"
          />
          <StatCard
            icon={<FileText size={18} />}
            label="Posted journals"
            value={overviewLoading ? '…' : overview.postedJournals.toLocaleString()}
            sub="Count in this period"
          />
          <StatCard
            icon={<Package size={18} />}
            label="SKUs sold"
            value={overviewLoading ? '…' : overview.skuCount.toLocaleString()}
            sub="Distinct SKUs / lots"
          />
          <StatCard
            icon={<Ban size={18} />}
            tone="muted"
            label="Voided"
            value={overviewLoading ? '…' : overview.voidedJournals.toLocaleString()}
            sub="Reversed, not in units sold"
          />
        </div>
        <div className="panel overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Top SKUs</th>
                <th className="text-right">Units</th>
                <th className="hidden w-28 text-right sm:table-cell">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {overviewLoading ? (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-stone-400">
                    Loading snapshot…
                  </td>
                </tr>
              ) : overview.topSkus.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <EmptyState title="No posted sales in this period" />
                  </td>
                </tr>
              ) : (
                overview.topSkus.map((sku) => {
                  const share = overview.unitsSold > 0 ? (sku.qty / overview.unitsSold) * 100 : 0;
                  return (
                    <tr key={sku.label}>
                      <td className="font-mono text-xs sm:text-sm">
                        <span className="break-all">{sku.label}</span>
                      </td>
                      <td className="text-right tabular-nums font-medium text-stone-900">
                        {formatSoldQty(sku.qty)}
                      </td>
                      <td className="hidden sm:table-cell">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-100">
                            <div
                              className="h-full rounded-full bg-brand-400"
                              style={{ width: `${Math.min(100, share)}%` }}
                            />
                          </div>
                          <span className="w-10 text-right text-xs tabular-nums text-stone-500">
                            {share.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {message && pageTab === 'record' && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            message.tone === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </div>
      )}

      {pageTab === 'record' && (
      <form onSubmit={(e) => void handleSubmit(e)} className="panel space-y-6 p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-stone-700">Business date</label>
          <input
            type="date"
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
            className="w-full max-w-xs rounded-lg border border-stone-300 px-3 py-2 text-sm"
            required
          />
        </div>

        <div className="rounded-lg border border-brand-100 bg-brand-50/40 p-4">
          <h2 className="text-sm font-semibold text-stone-900">FIFO sale by SKU</h2>
          <p className="mt-1 text-xs text-stone-600">
            Pick the SKU (or a specific lot). Consumption follows FEFO; the journal shows which lot was sold.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-700">SKU</label>
              <select
                value={fifoSku}
                onChange={(e) => setFifoSku(e.target.value)}
                disabled={!outletId || fifoSkusLoading || fifoSkus.length === 0}
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm disabled:bg-stone-100"
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
              <label className="mb-1 block text-xs font-medium text-stone-700">Qty sold</label>
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
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm tabular-nums"
              />
            </div>
            <div className="sm:pb-0.5">
              <Button
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
                className="w-full sm:w-auto"
              >
                {fifoPosting ? 'Posting…' : 'Post FIFO sale'}
              </Button>
            </div>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-left text-sm font-medium text-stone-800 hover:bg-stone-100"
          >
            Advanced: manual lines
            <ChevronDown size={16} className={`text-stone-500 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
          </button>
          {advancedOpen && (
            <div className="mt-3 space-y-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-stone-500">
              Edit batches line by line for splits or overrides. Qty sold starts at 0; available stock is shown as a
              helper.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                className="px-2 py-1 text-xs"
                onClick={() => void loadBatchesFromInventory()}
                disabled={!outletId || batchesLoading}
              >
                {batchesLoading ? 'Loading…' : 'Load batches from inventory'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="px-2 py-1 text-xs"
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
              >
                <Plus size={14} /> Add line
              </Button>
            </div>
          </div>
          {inventoryEmptyNotice && (
            <p className="mb-2 text-sm text-stone-500">No stocked batches for this outlet.</p>
          )}
          <div className="mb-1 hidden gap-2 sm:flex sm:items-end sm:gap-2 sm:px-1">
            <div className="min-w-[140px] flex-1 text-xs font-medium text-stone-500">Lot</div>
            <div className="w-28 min-w-[7rem] text-xs font-medium text-stone-500">Prod. date</div>
            <div className="w-28 text-xs font-medium text-stone-500">Qty sold</div>
            <div className="w-10 shrink-0" aria-hidden />
          </div>
          <div className="space-y-3">
            {lines.map((line, idx) => (
              <div key={line.key} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[140px] flex-1">
                  <span className="mb-1 block text-xs font-medium text-stone-500 sm:hidden">Lot</span>
                  <input
                    placeholder="Lot or SKU"
                    value={line.product_batch}
                    onChange={(e) => {
                      const v = e.target.value;
                      setLines((prev) =>
                        prev.map((r, i) =>
                          i === idx
                            ? { ...applyLotIdentifierEdit(r, v), production_date_label: null }
                            : r
                        )
                      );
                    }}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="w-full min-w-[7rem] sm:w-28">
                  <span className="mb-1 block text-xs font-medium text-stone-500 sm:hidden">Prod. date</span>
                  <div
                    className="flex min-h-[38px] items-center rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm tabular-nums text-stone-800"
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
                  <span className="mb-1 block text-xs font-medium text-stone-500 sm:hidden">Qty sold</span>
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
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm tabular-nums"
                  />
                  {line.available_qty != null ? (
                    <p className="mt-0.5 text-[11px] tabular-nums text-stone-400">
                      Available {formatSoldQty(line.available_qty)}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                  disabled={lines.length <= 1}
                  className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-red-600 disabled:opacity-30"
                  aria-label="Remove line"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-stone-700">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
        </div>

        {advancedOpen ? (
          <Button type="submit" disabled={submitting || batchesLoading || fifoPosting}>
            {submitting ? 'Posting…' : 'Post manual journal'}
          </Button>
        ) : null}
      </form>
      )}

      {pageTab === 'overview' && (
      <div>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Recent journals</h2>
            <p className="mt-0.5 max-w-md text-xs text-gray-500">
              Posted sales for{' '}
              <span className="font-medium text-gray-600">
                {outlets.find((o) => o.id === outletId)?.name ?? 'this outlet'}
              </span>
              . Voided sales are hidden unless you include them.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <label className="inline-flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={includeVoided}
                onChange={(e) => setIncludeVoided(e.target.checked)}
                className="rounded border-gray-300"
              />
              Include voided
            </label>
            <p className="max-w-xs text-xs text-gray-500 sm:text-right">
              Same outlet and business-date filter as the overview. Loads {HISTORY_PAGE_SIZE} at a time; use{' '}
              <strong className="font-medium text-gray-600">Next</strong> below for older journals.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white text-sm">
          <table className="w-full">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-stone-600">Date</th>
                <th className="px-4 py-2 text-left font-medium text-stone-600 min-w-[12rem]">Qty sold</th>
                <th className="px-4 py-2 text-left font-medium text-stone-600">Notes</th>
                <th className="px-4 py-2 text-right font-medium text-stone-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-stone-400">
                    {includeVoided ? 'No sales in this period' : 'No posted sales for this outlet'}
                  </td>
                </tr>
              ) : (
                history.map((h) => {
                  const voided = isVoidedSalesStatus(h.status);
                  return (
                  <tr key={h.id} className={voided ? 'bg-gray-50 text-gray-500' : undefined}>
                    <td className="whitespace-nowrap px-4 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{h.business_date}</span>
                        {voided ? (
                          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
                            Voided
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-2 align-top">
                      {h.lines.length === 0 ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <ul className={`space-y-1 font-mono text-xs sm:text-sm ${voided ? 'text-gray-500 line-through' : 'text-gray-800'}`}>
                          {h.lines.map((ln, i) => (
                            <li key={`${h.id}-${i}-${ln.product_batch}`}>
                              <span className="font-semibold">{ln.quantity_sold}</span>
                              <span className="mx-1 text-gray-400">×</span>
                              <span className="break-all">{formatLotWithSku(ln.lot_label, ln.product_batch)}</span>
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
                        className="inline-flex items-center gap-1 rounded-lg border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                      >
                        <Eye size={14} aria-hidden /> View
                      </button>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {history.length > 0 && historyHasMore ? (
            <div className="flex flex-col items-center gap-2 border-t border-gray-100 bg-gray-50/80 px-4 py-3 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => void handleLoadMoreHistory()}
                disabled={historyLoadingMore}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50 disabled:opacity-50"
              >
                {historyLoadingMore ? 'Loading…' : 'Next'}
              </button>
              <p className="text-xs text-gray-500">
                Showing {history.length} journal{history.length === 1 ? '' : 's'}
                {historyHasMore ? ' · more available' : ''}
              </p>
            </div>
          ) : history.length > 0 ? (
            <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-2 text-center text-xs text-gray-500">
              Showing all {history.length} loaded journal{history.length === 1 ? '' : 's'}
            </div>
          ) : null}
        </div>
      </div>
      )}

      <Modal
        isOpen={journalModalOpen}
        onClose={() => closeJournalModal()}
        title={
          modalJournalId
            ? `${isVoidedSalesStatus(modalStatus) ? 'Voided sale' : 'Sale'} ${modalJournalId.slice(0, 8)}…`
            : 'Sale'
        }
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
            {isVoidedSalesStatus(modalStatus) && (
              <p className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700">
                This sale is voided. Outlet stock was restored. The original lines are kept for history and cannot be
                edited.
              </p>
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
                        <th className="px-3 py-2 text-left font-medium text-gray-600">Lot</th>
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
                            <td className="px-3 py-2 font-medium text-gray-900">
                              {formatLotWithSku(ln.lot_label, ln.product_batch)}
                            </td>
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
                              prev.map((row, i) => (i === mi ? applyLotIdentifierEdit(row, v) : row))
                            );
                          }}
                          placeholder="Lot or SKU"
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
                  {isAdmin && !isVoidedSalesStatus(modalStatus) && (
                    <>
                      <button
                        type="button"
                        onClick={() => setModalEditMode(true)}
                        disabled={recentJournalBusy}
                        className="btn-secondary"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleModalDelete()}
                        disabled={recentJournalBusy}
                        className="btn-danger"
                      >
                        {modalDeleting ? 'Voiding…' : 'Void sale'}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => closeJournalModal()}
                    className="btn-ghost"
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
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => void handleModalSave()}
                      disabled={modalSaving}
                      className="btn-primary"
                    >
                      {modalSaving ? 'Saving…' : 'Save changes'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
