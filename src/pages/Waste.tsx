import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { Button, EmptyState, PageHeader, StatCard, Tabs } from '../components/ui';
import { supabase } from '../utils/supabase';
import { postWasteEvent, type WasteLineHubInput, type WasteLineOutletInput } from '../utils/visibilityService';
import type { Outlet } from '../types';
import { getLast7Days, type DateRange } from '../utils/dateRange';
import { formatLotWithSku, nestedLotLabel, nestedRecipeSku } from '../utils/lotLabel';
import { hubRowAvailableQuantity } from '../utils/hubInventoryMath';
import { firstOverAllocatedInventory, sumRequestedQtyById } from '../utils/wasteLineTotals';
import { useAuth } from '../utils/auth';

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
  lot_summary: string;
}

type Kind = 'hub' | 'outlet';

interface HubPickRow {
  id: string;
  product_batch: string | null;
  lot_label: string | null;
  label: string;
  available: number;
}

interface OutletPickRow {
  id: string;
  product_batch: string;
  lot_label: string | null;
  recipe_sku: string | null;
  label: string;
  available: number;
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
  outlet_inventory_id: string;
  product_batch: string;
  quantity: number;
  waste_reason: string;
}

const REASONS = ['spoilage', 'damage', 'expiry', 'sampling', 'quality_issue', 'other'];

interface WasteOverview {
  postedEvents: number;
  totalQty: number;
  hubEvents: number;
  outletEvents: number;
}

function emptyWasteOverview(): WasteOverview {
  return { postedEvents: 0, totalQty: 0, hubEvents: 0, outletEvents: 0 };
}

export function Waste() {
  const { isSupervisor, profile } = useAuth();
  const [pageTab, setPageTab] = useState<'overview' | 'record'>('overview');
  const [kind, setKind] = useState<Kind>('outlet');
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState('');
  const [hubRows, setHubRows] = useState<HubPickRow[]>([]);
  const [outletRows, setOutletRows] = useState<OutletPickRow[]>([]);
  const [wasteDate, setWasteDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [linesHub, setLinesHub] = useState<LineHub[]>([
    { key: crypto.randomUUID(), hub_inventory_id: '', product_batch: '', quantity: 0, waste_reason: 'spoilage' },
  ]);
  const [linesOutlet, setLinesOutlet] = useState<LineOutlet[]>([
    { key: crypto.randomUUID(), product_batch: '', outlet_inventory_id: '', quantity: 0, waste_reason: 'spoilage' },
  ]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [historyRange, setHistoryRange] = useState<DateRange | null>(() => getLast7Days());
  const [history, setHistory] = useState<WasteHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [overview, setOverview] = useState<WasteOverview>(() => emptyWasteOverview());
  const [overviewLoading, setOverviewLoading] = useState(false);
  const overviewGenRef = useRef(0);

  const load = useCallback(async () => {
    if (isSupervisor) {
      const oid = profile?.assigned_outlet_id;
      setKind('outlet');
      if (!oid) {
        setOutlets([]);
        setOutletId('');
        setHubRows([]);
        setLoading(false);
        return;
      }
      const { data: out } = await supabase.from('outlets').select('*').eq('id', oid).maybeSingle();
      setOutlets(out ? [out as Outlet] : []);
      setOutletId(oid);
      setHubRows([]);
      setLoading(false);
      return;
    }
    const [{ data: outs }, { data: hub }] = await Promise.all([
      supabase.from('outlets').select('*').order('name'),
      supabase
        .from('hub_inventory')
        .select(
          'id, product_batch, raw_material_id, quantity_on_hand, reserved_quantity, available_quantity, material:raw_material_id(name), lot:inventory_lots(product_batch_label)'
        )
        .order('last_updated', { ascending: false }),
    ]);
    setOutlets(outs ?? []);
    if (outs?.length && !outletId) setOutletId(outs[0].id);

    const picks: HubPickRow[] = (hub ?? []).map((row) => {
      const r = row as {
        id: string;
        product_batch: string | null;
        quantity_on_hand?: number | null;
        reserved_quantity?: number | null;
        available_quantity?: number | null;
        material?: { name: string } | { name: string }[] | null;
        lot?: { product_batch_label?: string | null } | { product_batch_label?: string | null }[] | null;
      };
      const mat = Array.isArray(r.material) ? r.material[0] : r.material;
      const lotLabel = nestedLotLabel(r.lot);
      const pb = r.product_batch?.trim();
      const mn = mat?.name?.trim();
      return {
        id: r.id,
        product_batch: r.product_batch,
        lot_label: lotLabel,
        label: mn || formatLotWithSku(lotLabel, pb) || `Hub row ${r.id.slice(0, 8)}`,
        available: hubRowAvailableQuantity(
          Number(r.quantity_on_hand ?? 0),
          Number(r.reserved_quantity ?? 0),
          r.available_quantity
        ),
      };
    });
    setHubRows(picks);
    setLoading(false);
  }, [outletId, isSupervisor, profile?.assigned_outlet_id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!outletId) {
      setOutletRows([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('outlet_inventory')
        .select(
          'id, product_batch, quantity_on_hand, reserved_quantity, available_quantity, lot:inventory_lots(product_batch_label, production_run:production_run_id(recipe:recipe_id(default_product_batch)))'
        )
        .eq('outlet_id', outletId)
        .is('raw_material_id', null)
        .gt('quantity_on_hand', 0);
      if (cancelled) return;
      const picks: OutletPickRow[] = (data ?? []).map((row) => {
        const r = row as {
          id: string;
          product_batch: string | null;
          quantity_on_hand?: number | null;
          reserved_quantity?: number | null;
          available_quantity?: number | null;
          lot?: unknown;
        };
        const pb = r.product_batch?.trim() || '';
        const lotLabel = nestedLotLabel(r.lot as { product_batch_label?: string | null } | { product_batch_label?: string | null }[] | null);
        const recipeSku = nestedRecipeSku(r.lot);
        return {
          id: r.id,
          product_batch: pb,
          lot_label: lotLabel,
          recipe_sku: recipeSku,
          label: formatLotWithSku(lotLabel, pb, recipeSku) || pb,
          available: hubRowAvailableQuantity(
            Number(r.quantity_on_hand ?? 0),
            Number(r.reserved_quantity ?? 0),
            r.available_quantity
          ),
        };
      });
      picks.sort((a, b) => a.label.localeCompare(b.label));
      setOutletRows(picks);
    })();
    return () => {
      cancelled = true;
    };
  }, [outletId]);

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

        if (isSupervisor && profile?.assigned_outlet_id) {
          query = query.eq('location_kind', 'outlet').eq('outlet_id', profile.assigned_outlet_id);
        }

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
            ? await supabase
                .from('waste_lines')
                .select('waste_event_id, quantity, product_batch, hub_inventory_id')
                .in('waste_event_id', ids)
            : { data: [] as { waste_event_id: string; quantity: number; product_batch?: string; hub_inventory_id?: string | null }[] };

        const hubIds = [
          ...new Set(
            (lines ?? [])
              .map((l) => l.hub_inventory_id as string | null | undefined)
              .filter((id): id is string => !!id)
          ),
        ];
        const lotByHub = new Map<string, string | null>();
        if (hubIds.length > 0) {
          const { data: hubLots } = await supabase
            .from('hub_inventory')
            .select('id, product_batch, lot:inventory_lots(product_batch_label)')
            .in('id', hubIds);
          for (const h of hubLots ?? []) {
            const row = h as {
              id: string;
              product_batch?: string | null;
              lot?: { product_batch_label?: string | null } | { product_batch_label?: string | null }[] | null;
            };
            lotByHub.set(row.id, nestedLotLabel(row.lot) ?? row.product_batch?.trim() ?? null);
          }
        }

        const batches = [
          ...new Set(
            (lines ?? [])
              .map((l) => String(l.product_batch ?? '').trim())
              .filter(Boolean)
          ),
        ];
        const lotByBatch = new Map<string, string | null>();
        if (batches.length > 0) {
          const { data: oiLots } = await supabase
            .from('outlet_inventory')
            .select('product_batch, lot:inventory_lots(product_batch_label)')
            .in('product_batch', batches);
          for (const row of oiLots ?? []) {
            const r = row as {
              product_batch?: string | null;
              lot?: { product_batch_label?: string | null } | { product_batch_label?: string | null }[] | null;
            };
            const pb = r.product_batch?.trim();
            if (pb && !lotByBatch.has(pb)) lotByBatch.set(pb, nestedLotLabel(r.lot));
          }
        }

        const qtyByEvent = new Map<string, { count: number; total: number; lots: string[] }>();
        for (const line of lines ?? []) {
          const eid = line.waste_event_id as string;
          const prev = qtyByEvent.get(eid) ?? { count: 0, total: 0, lots: [] };
          prev.count += 1;
          prev.total += Number(line.quantity ?? 0);
          const hubId = line.hub_inventory_id as string | null | undefined;
          const pb = (line.product_batch as string | undefined) ?? null;
          const fromHub = hubId ? lotByHub.get(hubId) : null;
          const fromOutlet = pb ? lotByBatch.get(pb) : null;
          prev.lots.push(formatLotWithSku(fromHub ?? fromOutlet ?? null, pb));
          qtyByEvent.set(eid, prev);
        }

        const mapped: WasteHistoryRow[] = (events ?? []).map((e) => {
          const agg = qtyByEvent.get(e.id as string) ?? { count: 0, total: 0, lots: [] };
          return {
            id: e.id as string,
            location_kind: e.location_kind as 'hub' | 'outlet',
            waste_date: String(e.waste_date),
            notes: e.notes as string | null,
            created_at: String(e.created_at),
            outlet: e.outlet as WasteHistoryRow['outlet'],
            line_count: agg.count,
            total_qty: agg.total,
            lot_summary: agg.lots.filter(Boolean).join(', ') || '—',
          };
        });

        setHistory((prev) => (append ? [...prev, ...mapped] : mapped));
        setHistoryHasMore(mapped.length === HISTORY_PAGE_SIZE);
      } finally {
        setHistoryLoading(false);
      }
    },
    [historyRange, isSupervisor, profile?.assigned_outlet_id]
  );

  const loadOverview = useCallback(async () => {
    const gen = ++overviewGenRef.current;
    setOverviewLoading(true);
    try {
      let q = supabase.from('waste_events').select('id, location_kind, outlet_id').eq('status', 'posted');
      if (isSupervisor && profile?.assigned_outlet_id) {
        q = q.eq('location_kind', 'outlet').eq('outlet_id', profile.assigned_outlet_id);
      }
      if (historyRange) {
        const from = historyRange.start.toISOString().slice(0, 10);
        const to = historyRange.end.toISOString().slice(0, 10);
        q = q.gte('waste_date', from).lte('waste_date', to);
      }
      const { data: events, error } = await q;
      if (error) throw error;
      if (gen !== overviewGenRef.current) return;
      const rows = events ?? [];
      const ids = rows.map((e) => e.id as string);
      let totalQty = 0;
      for (let i = 0; i < ids.length; i += 80) {
        const slice = ids.slice(i, i + 80);
        const { data: lines, error: lErr } = await supabase
          .from('waste_lines')
          .select('quantity')
          .in('waste_event_id', slice);
        if (lErr) throw lErr;
        if (gen !== overviewGenRef.current) return;
        for (const ln of lines ?? []) totalQty += Number(ln.quantity ?? 0);
      }
      setOverview({
        postedEvents: rows.length,
        totalQty,
        hubEvents: rows.filter((e) => e.location_kind === 'hub').length,
        outletEvents: rows.filter((e) => e.location_kind === 'outlet').length,
      });
    } catch {
      if (gen !== overviewGenRef.current) return;
      setOverview(emptyWasteOverview());
    } finally {
      if (gen === overviewGenRef.current) setOverviewLoading(false);
    }
  }, [historyRange, isSupervisor, profile?.assigned_outlet_id]);

  useEffect(() => {
    setHistoryPage(0);
  }, [historyRange]);

  useEffect(() => {
    void loadHistory(historyPage, historyPage > 0);
  }, [historyPage, loadHistory]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  function syncHubBatch(idx: number, hubInvId: string) {
    const row = hubRows.find((h) => h.id === hubInvId);
    const batchText = row?.product_batch?.trim() || row?.lot_label || row?.label || 'HUB';
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
      if (isSupervisor) {
        setKind('outlet');
      }
      if (kind === 'hub') {
        if (isSupervisor) {
          setMessage({ tone: 'err', text: 'Supervisors can only record outlet waste.' });
          return;
        }
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
        const overHub = firstOverAllocatedInventory(
          sumRequestedQtyById(payload.map((l) => ({ inventoryId: l.hub_inventory_id, quantity: l.quantity }))),
          new Map(hubRows.map((r) => [r.id, r.available]))
        );
        if (overHub) {
          const label = hubRows.find((r) => r.id === overHub.inventoryId)?.label ?? 'that lot';
          setMessage({
            tone: 'err',
            text: `Combined waste on ${label} is ${overHub.requested} but only ${overHub.available} is available.`,
          });
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
        setMessage({ tone: 'ok', text: `Posted ${payload.reduce((s, l) => s + l.quantity, 0).toLocaleString()} units` });
      } else {
        if (!outletId) {
          setMessage({ tone: 'err', text: 'Select an outlet.' });
          return;
        }
        const payload: WasteLineOutletInput[] = linesOutlet
          .filter((l) => l.outlet_inventory_id && l.quantity > 0 && l.waste_reason)
          .map((l) => ({
            outlet_id: outletId,
            outlet_inventory_id: l.outlet_inventory_id,
            product_batch: l.product_batch.trim(),
            quantity: l.quantity,
            waste_reason: l.waste_reason,
          }));
        if (!payload.length) {
          setMessage({ tone: 'err', text: 'Add valid outlet waste lines.' });
          return;
        }
        const overOutlet = firstOverAllocatedInventory(
          sumRequestedQtyById(
            payload.map((l) => ({ inventoryId: l.outlet_inventory_id ?? '', quantity: l.quantity }))
          ),
          new Map(outletRows.map((r) => [r.id, r.available]))
        );
        if (overOutlet) {
          const label = outletRows.find((r) => r.id === overOutlet.inventoryId)?.label ?? 'that lot';
          setMessage({
            tone: 'err',
            text: `Combined waste on ${label} is ${overOutlet.requested} but only ${overOutlet.available} is available.`,
          });
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
        setMessage({ tone: 'ok', text: `Posted ${payload.reduce((s, l) => s + l.quantity, 0).toLocaleString()} units` });
      }
      void load();
      setHistoryPage(0);
      void loadOverview();
    } finally {
      setSubmitting(false);
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Waste & spoilage"
        description={
          pageTab === 'overview'
            ? 'Posted waste for the selected view period. Quantities come from available stock only.'
            : 'Record hub or outlet waste. Event date is when the waste happened.'
        }
        filters={
          <div className={pageTab === 'overview' ? '' : 'hidden'}>
            <DateFilter
              defaultType="last7Days"
              onFilterChange={(range) => setHistoryRange(range)}
              hint="Applies to overview totals and posted events."
            />
          </div>
        }
      />

      <Tabs
        value={pageTab}
        onChange={setPageTab}
        items={[
          { id: 'overview', label: 'Overview' },
          { id: 'record', label: 'Record waste' },
        ]}
      />

      {pageTab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              tone="brand"
              label="Units wasted"
              value={overviewLoading ? '…' : overview.totalQty.toLocaleString()}
              sub="Posted events only"
            />
            <StatCard
              label="Posted events"
              value={overviewLoading ? '…' : overview.postedEvents.toLocaleString()}
              sub="Count in this period"
            />
            {!isSupervisor ? (
              <StatCard
                label="Hub events"
                value={overviewLoading ? '…' : overview.hubEvents.toLocaleString()}
                sub="Hub spoilage / write-off"
              />
            ) : null}
            <StatCard
              label="Outlet events"
              value={overviewLoading ? '…' : overview.outletEvents.toLocaleString()}
              sub={isSupervisor ? 'Your outlet' : 'Outlet spoilage / write-off'}
            />
          </div>

          <section className="panel space-y-4 p-6">
            <div>
              <h2 className="text-sm font-semibold text-stone-900">Posted waste events</h2>
              <p className="mt-1 text-xs text-stone-500">Newest first. Same view period as the totals above.</p>
            </div>
            {historyLoading && history.length === 0 ? (
              <p className="text-sm text-stone-400">Loading history…</p>
            ) : history.length === 0 ? (
              <EmptyState title="No posted waste events in this period" />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-stone-100">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Location</th>
                      <th className="text-right">Lines</th>
                      <th className="text-right">Total qty</th>
                      <th>Lots</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {history.map((row) => {
                      const outlet = Array.isArray(row.outlet) ? row.outlet[0] : row.outlet;
                      const loc = row.location_kind === 'hub' ? 'Hub' : outlet?.name ?? 'Outlet';
                      return (
                        <tr key={row.id} className="hover:bg-stone-50/80">
                          <td>{row.waste_date}</td>
                          <td className="capitalize">{loc}</td>
                          <td className="text-right tabular-nums">{row.line_count}</td>
                          <td className="text-right tabular-nums">{row.total_qty.toLocaleString()}</td>
                          <td className="max-w-[220px] truncate font-mono text-xs" title={row.lot_summary}>
                            {row.lot_summary}
                          </td>
                          <td className="max-w-[200px] truncate text-stone-500">{row.notes?.trim() || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {historyHasMore && (
              <Button variant="secondary" disabled={historyLoading} onClick={() => setHistoryPage((p) => p + 1)}>
                {historyLoading ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </section>
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
        {!isSupervisor && (
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
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {kind === 'outlet' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-stone-700">Outlet</label>
              {isSupervisor ? (
                <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800">
                  {outlets.find((o) => o.id === outletId)?.name ?? 'Your outlet'}
                </p>
              ) : (
                <select
                  value={outletId}
                  onChange={(e) => setOutletId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                >
                  {outlets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Event date</label>
            <input
              type="date"
              value={wasteDate}
              onChange={(e) => setWasteDate(e.target.value)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
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
                className="btn-secondary px-2 py-1 text-xs"
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
                    { key: crypto.randomUUID(), product_batch: '', outlet_inventory_id: '', quantity: 0, waste_reason: 'spoilage' },
                  ])
                }
                className="btn-secondary px-2 py-1 text-xs"
              >
                <Plus size={14} /> Add
              </button>
            </div>
            {linesOutlet.map((line, idx) => (
              <div key={line.key} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                <select
                  value={line.outlet_inventory_id}
                  onChange={(e) => {
                    const id = e.target.value;
                    const pick = outletRows.find((r) => r.id === id);
                    setLinesOutlet((p) =>
                      p.map((l, i) =>
                        i === idx
                          ? {
                              ...l,
                              outlet_inventory_id: id,
                              product_batch: pick?.product_batch ?? '',
                            }
                          : l
                      )
                    );
                  }}
                  className="min-w-[200px] flex-1 rounded border px-2 py-2 text-sm"
                >
                  <option value="">Lot at outlet…</option>
                  {outletRows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
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

        <Button type="submit" disabled={submitting}>
          {submitting ? 'Posting…' : 'Post waste event'}
        </Button>
      </form>
      )}
    </div>
  );
}
