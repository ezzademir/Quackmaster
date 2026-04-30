import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, CreditCard as Edit2, Trash2, ChevronRight, Truck, MapPin, AlertCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DateFilter } from '../components/DateFilter';
import { supabase } from '../utils/supabase';
import { logActivity } from '../utils/activityLog';
import { isDateInRange, type DateRange } from '../utils/dateRange';
import {
  dispatchSupplyOrder,
  confirmSupplyOrderReceipt,
  createSupplyOrder,
  adminDeleteOutlet,
  adminDeleteSupplyOrder,
} from '../utils/distributionService';
import { validateSupplyOrder } from '../utils/validation';
import type { Outlet, SupplyOrder } from '../types';
import { useAuth } from '../utils/auth';

type Tab = 'orders' | 'outlets';

/** Calendar date from DB `date` or timestamptz — avoids UTC midnight shifting the displayed day */
function formatSupplyCalendarDate(value: string | undefined | null): string {
  if (value == null || value === '') return '—';
  const trimmed = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const mo = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const d = new Date(y, mo, day);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

/** Admin hard-delete is allowed for these statuses (RPC reverses inventory when applicable). */
function supplyOrderAllowsAdminHardDelete(status: string | undefined): boolean {
  const s = String(status ?? '').toLowerCase().trim();
  return s === 'pending' || s === 'cancelled' || s === 'dispatched' || s === 'received';
}

function supplyOrderAdminDeleteConfirmDetail(status: string | undefined): string {
  const stNorm = String(status ?? '').toLowerCase().trim();
  switch (stNorm) {
    case 'pending':
      return 'Reserved hub stock will be released.';
    case 'dispatched':
      return 'Hub shipment will be reversed (stock returned to hub batches). Outlet on-hand was not increased until receipt, so it is unchanged.';
    case 'received':
      return 'Outlet on-hand will be reduced and hub finished-goods stock will be restored for each line (admin correction).';
    case 'cancelled':
      return 'This removes the cancelled record only. Inventory is not adjusted automatically; if this order was dispatched before cancel, correct hub/outlet stock manually if needed.';
    default:
      return 'This order will be permanently removed.';
  }
}

function StatusBadge({ status }: { status: string }) {
  const key = String(status ?? '').toLowerCase().trim();
  const map: Record<string, string> = {
    pending: 'bg-blue-100 text-blue-700',
    dispatched: 'bg-amber-100 text-amber-700',
    received: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-gray-100 text-gray-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[key] ?? 'bg-gray-100 text-gray-700'}`}>
      {key.replace(/_/g, ' ') || '—'}
    </span>
  );
}

// ---- Outlet Modal ----
function OutletModal({
  outlet,
  onClose,
  onSave,
}: {
  outlet: Outlet | null;
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  const blank = { name: '', location_code: '', address: '', city: '', country: '', manager_name: '', manager_phone: '', manager_email: '' };
  const [form, setForm] = useState(outlet ? {
    name: outlet.name,
    location_code: outlet.location_code,
    address: outlet.address ?? '',
    city: outlet.city ?? '',
    country: outlet.country ?? '',
    manager_name: outlet.manager_name ?? '',
    manager_phone: outlet.manager_phone ?? '',
    manager_email: outlet.manager_email ?? '',
  } : blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!form.name.trim() || !form.location_code.trim()) { setError('Name and Location Code are required'); return; }
    setSaving(true);
    try {
      const payload = { ...form };
      let createdOutletId = outlet?.id ?? '';
      let err: { message: string } | null = null;
      if (outlet) {
        const { error } = await supabase.from('outlets').update(payload).eq('id', outlet.id);
        err = error;
      } else {
        const { data, error } = await supabase.from('outlets').insert(payload).select('id').single();
        err = error;
        createdOutletId = data?.id ?? '';
      }
      if (err) {
        setError(err.message);
        return;
      }
      await logActivity({
        action: outlet ? 'updated' : 'created',
        entityType: 'outlet',
        entityId: createdOutletId,
        entityLabel: form.name,
      });
      await onSave();
    } finally {
      setSaving(false);
    }
  }

  const field = (label: string, key: keyof typeof form, type = 'text') => (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
    </div>
  );

  return (
    <Modal isOpen onClose={onClose} title={outlet ? 'Edit Outlet' : 'Add Outlet'} size="lg">
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        {field('Outlet Name *', 'name')}
        {field('Location Code *', 'location_code')}
        {field('Address', 'address')}
        {field('City', 'city')}
        {field('Country', 'country')}
        <div className="sm:col-span-2 border-t border-gray-100 pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Manager Info</p>
        </div>
        {field('Manager Name', 'manager_name')}
        {field('Manager Phone', 'manager_phone')}
        {field('Manager Email', 'manager_email', 'email')}
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

/** Split requested qty across hub product batches (FIFO by last_updated). */
function allocateHubProductItems(
  batches: { id: string; product_batch: string | null; available: number; last_updated?: string }[],
  quantity: number
): { product_batch: string; hubInventoryId: string; quantity: number }[] | null {
  const sorted = [...batches]
    .filter((b) => b.available > 0)
    .sort(
      (a, b) =>
        new Date(a.last_updated ?? 0).getTime() - new Date(b.last_updated ?? 0).getTime()
    );
  let remaining = quantity;
  const items: { product_batch: string; hubInventoryId: string; quantity: number }[] = [];

  for (const b of sorted) {
    const take = Math.min(remaining, b.available);
    if (take <= 0) continue;
    items.push({
      product_batch: b.product_batch ?? 'PRODUCT',
      hubInventoryId: b.id,
      quantity: take,
    });
    remaining -= take;
    if (remaining <= 1e-9) break;
  }

  if (remaining > 1e-6) return null;
  return items.length > 0 ? items : null;
}

// ---- New Supply Order Modal ----
function NewSupplyOrderModal({
  outlets,
  hubProductQty,
  hubProductLines,
  onClose,
  onSave,
}: {
  outlets: Outlet[];
  hubProductQty: number;
  hubProductLines: { id: string; product_batch: string | null; available: number; last_updated?: string }[];
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  const [outlet_id, setOutletId] = useState('');
  const [supply_date, setSupplyDate] = useState(new Date().toISOString().split('T')[0]);
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    const qty = parseFloat(quantity);

    const validation = validateSupplyOrder({
      outlet_id,
      supply_date,
      total_quantity: qty,
    });

    if (!validation.isValid) {
      setError(validation.errors.map((e) => e.message).join('; '));
      return;
    }

    if (qty > hubProductQty) {
      setError(`Insufficient hub stock (${hubProductQty} units available)`);
      return;
    }

    setSaving(true);

    try {
      const items = allocateHubProductItems(hubProductLines, qty);
      if (!items?.length) {
        setError(
          hubProductQty <= 0
            ? 'No finished goods in hub inventory. Complete a production run first.'
            : `Insufficient hub stock (${hubProductQty} units available across batches)`
        );
        return;
      }

      const result = await createSupplyOrder({
        outletId: outlet_id,
        supplyDate: supply_date,
        items,
        notes,
      });

      if (!result.success) {
        setError(result.errors.join('; '));
        return;
      }

      await onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create supply order');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="New Supply Order" size="md">
      {error && (
        <div className="mb-4 flex items-start gap-3 rounded-lg bg-red-50 p-3">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0 text-red-600" />
          <div>
            <p className="text-sm font-medium text-red-900">Error</p>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        </div>
      )}
      <div className="space-y-4">
        <div className="rounded-lg bg-teal-50 px-4 py-3 text-sm text-teal-700">
          Hub product stock available: <strong>{hubProductQty} units</strong>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Outlet *</label>
          <select value={outlet_id} onChange={(e) => setOutletId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
            <option value="">Select outlet…</option>
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.location_code})</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Supply date *</label>
          <input type="date" value={supply_date} onChange={(e) => setSupplyDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <p className="mt-1 text-xs text-gray-500">Shown in the supply orders list; unchanged when the order is later dispatched.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Quantity *</label>
          <input type="number" min="0" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60 transition-colors">
          {saving ? 'Processing…' : 'Create Order'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Supply Order Detail Modal ----
type SOWithOutlet = SupplyOrder & { outlet?: Outlet };

function SODetailModal({
  so,
  onClose,
  onStatusChange,
  isAdmin,
  executeAdminDelete,
}: {
  so: SOWithOutlet;
  onClose: () => void;
  onStatusChange: () => void | Promise<void>;
  isAdmin: boolean;
  executeAdminDelete: (order: SOWithOutlet) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const canHardDelete = isAdmin && supplyOrderAllowsAdminHardDelete(so.status);

  async function askAdminDelete() {
    if (!canHardDelete) return;
    const detail = supplyOrderAdminDeleteConfirmDetail(so.status);
    if (!confirm(`Permanently delete supply order ${so.supply_order_number}?\n\n${detail}\n\nThis cannot be undone.`)) return;
    setSaving(true);
    try {
      const ok = await executeAdminDelete(so);
      if (ok) {
        await onStatusChange();
      }
    } finally {
      setSaving(false);
    }
  }

  async function markDispatched() {
    setSaving(true);
    try {
      const result = await dispatchSupplyOrder(so.id);

      if (!result.success) {
        alert(`Failed to dispatch: ${result.error}`);
        return;
      }

      await onStatusChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to dispatch');
    } finally {
      setSaving(false);
    }
  }

  async function markReceived() {
    setSaving(true);
    try {
      const result = await confirmSupplyOrderReceipt(so.id);

      if (!result.success) {
        alert(`Failed to receive: ${result.error}`);
        return;
      }

      await onStatusChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to receive');
    } finally {
      setSaving(false);
    }
  }

  const statusNorm = String(so.status ?? '').toLowerCase().trim();
  const showDispatchedOn = statusNorm === 'dispatched' || statusNorm === 'received';

  return (
    <Modal isOpen onClose={onClose} title={`Supply Order: ${so.supply_order_number}`} size="md">
      <div className="space-y-4">
        <div className="grid gap-4 rounded-lg bg-gray-50 p-4 grid-cols-1 sm:grid-cols-2">
          <div><p className="text-xs text-gray-500">Outlet</p><p className="font-semibold text-gray-900">{so.outlet?.name ?? '—'}</p></div>
          <div><p className="text-xs text-gray-500">Location</p><p className="font-semibold text-gray-900">{so.outlet?.location_code ?? '—'}</p></div>
          <div><p className="text-xs text-gray-500">Status</p><StatusBadge status={so.status} /></div>
          <div><p className="text-xs text-gray-500">Quantity</p><p className="font-semibold text-gray-900">{so.total_quantity} units</p></div>
          <div><p className="text-xs text-gray-500">Supply date</p><p className="font-semibold text-gray-900">{formatSupplyCalendarDate(so.supply_date ?? so.dispatch_date)}</p></div>
          <div><p className="text-xs text-gray-500">Dispatched on</p><p className="font-semibold text-gray-900">{showDispatchedOn ? formatSupplyCalendarDate(so.dispatch_date) : '—'}</p></div>
          {so.received_date && <div><p className="text-xs text-gray-500">Received date</p><p className="font-semibold text-gray-900">{formatSupplyCalendarDate(so.received_date)}</p></div>}
          {so.notes && <div className="sm:col-span-2"><p className="text-xs text-gray-500">Notes</p><p className="text-sm text-gray-900">{so.notes}</p></div>}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {canHardDelete && (
            <button
              type="button"
              onClick={() => void askAdminDelete()}
              disabled={saving}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
            >
              {saving ? 'Deleting…' : 'Delete order'}
            </button>
          )}
          {so.status === 'pending' && (
            <button onClick={markDispatched} disabled={saving}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60 transition-colors">
              {saving ? 'Dispatching…' : 'Dispatch'}
            </button>
          )}
          {so.status === 'dispatched' && (
            <button onClick={markReceived} disabled={saving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
              {saving ? 'Saving…' : 'Mark as Received by Outlet'}
            </button>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Close</button>
      </div>
    </Modal>
  );
}

// ---- Main Distribution Page ----
function normalizeSOStatus(status: string | undefined): string {
  return String(status ?? '').toLowerCase().trim();
}

/** Pending/cancelled: filter by supply_date (picker). Dispatched/received: actual dispatch_date. */
function supplyOrderDateForRangeFilter(so: SOWithOutlet): string {
  const st = normalizeSOStatus(so.status);
  const picker = (so.supply_date ?? so.dispatch_date)?.trim();
  if (st === 'pending' || st === 'cancelled') {
    if (picker) return picker.includes('T') ? picker : `${picker}T12:00:00`;
    return so.created_at ?? '';
  }
  const dispatched = so.dispatch_date?.trim();
  if (dispatched) return dispatched.includes('T') ? dispatched : `${dispatched}T12:00:00`;
  return so.created_at ?? '';
}

interface OutletStockRow {
  outletId: string;
  outletName: string;
  /** outlet_inventory — credited when the outlet confirms receipt */
  onHand: number;
  /** Dispatched, not yet received — in transit; not included in on hand until receipt */
  awaitingReceiptQty: number;
  /** Pending supply orders — hub reserved only */
  pendingSupplyQty: number;
}

interface StockMetrics {
  totalGenerated: number;
  /** Qty on orders that have left hub (dispatched or received), excludes pending/cancelled */
  totalDispatched: number;
  currentAvailable: number;
  /** Units tied up on pending supply orders (hub reservations only) */
  pendingSupplyUnits: number;
  outletInventory: OutletStockRow[];
}

export function Distribution() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('orders');
  const [orders, setOrders] = useState<SOWithOutlet[]>([]);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [hubProductQty, setHubProductQty] = useState(0);
  /** Finished-goods hub rows for reservations (real UUIDs). */
  const [hubProductLines, setHubProductLines] = useState<
    { id: string; product_batch: string | null; available: number; last_updated?: string }[]
  >([]);
  const [stockMetrics, setStockMetrics] = useState<StockMetrics>({
    totalGenerated: 0,
    totalDispatched: 0,
    currentAvailable: 0,
    pendingSupplyUnits: 0,
    outletInventory: [],
  });

  const outletStockById = useMemo(() => {
    const m = new Map<string, OutletStockRow>();
    for (const row of stockMetrics.outletInventory) {
      m.set(row.outletId, row);
    }
    return m;
  }, [stockMetrics.outletInventory]);
  const [loading, setLoading] = useState(true);

  const [showNewSO, setShowNewSO] = useState(false);
  const [viewSO, setViewSO] = useState<SOWithOutlet | null>(null);
  const [editOutlet, setEditOutlet] = useState<Outlet | null>(null);
  const [showOutletModal, setShowOutletModal] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);

  const loadAll = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const [{ data: sos }, { data: outs }, { data: prodRuns }, { data: outletInv }, { data: hubProducts }] =
      await Promise.all([
      supabase.from('supply_orders').select(`*, outlet:outlet_id(*)`).order('created_at', { ascending: false }),
      supabase.from('outlets').select('*').order('name'),
      supabase.from('production_runs').select('actual_output').eq('status', 'completed'),
      supabase.from('outlet_inventory').select('outlet_id, quantity_on_hand'),
      supabase
        .from('hub_inventory')
        .select('id, product_batch, available_quantity, quantity_on_hand, reserved_quantity, last_updated')
        .is('raw_material_id', null)
        .order('last_updated', { ascending: true }),
    ]);

    const orders = sos as SOWithOutlet[] ?? [];
    const outlets_list = outs ?? [];

    // Calculate total generated from production runs
    const totalGenerated = (prodRuns ?? []).reduce((sum, run) => sum + (run.actual_output || 0), 0);

    // Qty that has left hub toward outlets (dispatched or fully received), excludes pending/cancelled
    const totalDispatched = orders.reduce((sum, so) => {
      const st = normalizeSOStatus(so.status);
      if (st !== 'dispatched' && st !== 'received') return sum;
      return sum + Number(so.total_quantity ?? 0);
    }, 0);

    const awaitingReceiptByOutlet = new Map<string, number>();
    const pendingQtyByOutlet = new Map<string, number>();
    let pendingSupplyUnits = 0;
    for (const so of orders) {
      const st = normalizeSOStatus(so.status);
      const oid = so.outlet_id;
      const q = Number(so.total_quantity ?? 0);
      if (st === 'dispatched' && oid) {
        awaitingReceiptByOutlet.set(oid, (awaitingReceiptByOutlet.get(oid) ?? 0) + q);
      }
      if (st === 'pending' && oid) {
        pendingSupplyUnits += q;
        pendingQtyByOutlet.set(oid, (pendingQtyByOutlet.get(oid) ?? 0) + q);
      }
    }

    const hubLines = (hubProducts ?? []).map((row) => {
      const reserved = row.reserved_quantity ?? 0;
      const onHand = row.quantity_on_hand ?? 0;
      const avail =
        row.available_quantity != null && Number.isFinite(Number(row.available_quantity))
          ? Number(row.available_quantity)
          : Math.max(0, onHand - reserved);
      return {
        id: row.id,
        product_batch: row.product_batch,
        available: avail,
        last_updated: row.last_updated,
      };
    });

    // Hub available = actual finished-goods stock (matches Overview / Inventory)
    const currentAvailable = hubLines.reduce((sum, r) => sum + Math.max(0, r.available), 0);

    const qtyByOutlet = new Map<string, number>();
    for (const inv of outletInv ?? []) {
      const oid = (inv as { outlet_id: string }).outlet_id;
      if (!oid) continue;
      const q = Number((inv as { quantity_on_hand: number }).quantity_on_hand ?? 0);
      qtyByOutlet.set(oid, (qtyByOutlet.get(oid) ?? 0) + q);
    }

    const outletInventoryBreakdown = outlets_list
      .map((o) => ({
        outletId: o.id,
        outletName: o.name,
        onHand: qtyByOutlet.get(o.id) ?? 0,
        awaitingReceiptQty: awaitingReceiptByOutlet.get(o.id) ?? 0,
        pendingSupplyQty: pendingQtyByOutlet.get(o.id) ?? 0,
      }))
      .sort((a, b) => a.outletName.localeCompare(b.outletName));

    setOrders(orders);
    setOutlets(outlets_list);
    setHubProductLines(hubLines);
    setHubProductQty(currentAvailable);
    setStockMetrics({
      totalGenerated,
      totalDispatched,
      currentAvailable,
      pendingSupplyUnits,
      outletInventory: outletInventoryBreakdown,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();

    const channel = supabase
      .channel('distribution-hub-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'hub_inventory' },
        () => void loadAll({ silent: true })
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'supply_orders' },
        () => void loadAll({ silent: true })
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outlet_inventory' },
        () => void loadAll({ silent: true })
      )
      .subscribe();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadAll({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [loadAll]);

  const handleDateFilterChange = (range: DateRange | null) => {
    setDateRange(range);
  };

  const filteredOrders = dateRange
    ? orders.filter((o) => isDateInRange(supplyOrderDateForRangeFilter(o), dateRange))
    : orders;

  // Cards always show actual current state (all-time), not filtered
  const displayMetrics = {
    totalGenerated: stockMetrics.totalGenerated,
    totalDispatched: stockMetrics.totalDispatched,
    currentAvailable: stockMetrics.currentAvailable,
    pendingSupplyUnits: stockMetrics.pendingSupplyUnits,
    outletInventory: stockMetrics.outletInventory,
  };
  const totalOutletOnHand = displayMetrics.outletInventory.reduce((sum, o) => sum + o.onHand, 0);
  const totalAwaitingReceipt = displayMetrics.outletInventory.reduce((sum, o) => sum + o.awaitingReceiptQty, 0);

  async function executeAdminDeleteSupplyOrder(so: SOWithOutlet): Promise<boolean> {
    const result = await adminDeleteSupplyOrder({
      supplyOrderId: so.id,
      supplyOrderNumber: so.supply_order_number,
      status: so.status,
    });
    if (!result.success) {
      alert(result.error ?? 'Could not delete supply order');
      return false;
    }
    return true;
  }

  async function handleDeleteSupplyOrderRow(so: SOWithOutlet) {
    if (!isAdmin || !supplyOrderAllowsAdminHardDelete(so.status)) return;
    const detail = supplyOrderAdminDeleteConfirmDetail(so.status);
    if (
      !confirm(`Permanently delete supply order ${so.supply_order_number}?\n\n${detail}\n\nThis cannot be undone.`)
    ) {
      return;
    }
    if (await executeAdminDeleteSupplyOrder(so)) {
      if (viewSO?.id === so.id) setViewSO(null);
      void loadAll();
    }
  }

  async function deleteOutlet(id: string) {
    if (!isAdmin) return;
    const o = outlets.find((x) => x.id === id);
    const label = o?.name ?? id;
    if (
      !confirm(
        `Permanently delete outlet "${label}"?\n\nOutlet inventory rows will be removed. You cannot delete if any supply orders still reference this outlet.\n\nThis cannot be undone.`
      )
    ) {
      return;
    }
    const result = await adminDeleteOutlet({ outletId: id, outletName: label });
    if (!result.success) {
      alert(result.error ?? 'Could not delete outlet');
      return;
    }
    void loadAll();
  }

  const tabClass = (t: Tab) =>
    `border-b-2 px-1 py-4 text-sm font-medium transition-colors ${
      tab === t ? 'border-teal-600 text-teal-600' : 'border-transparent text-gray-500 hover:text-gray-700'
    }`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Distribution</h1>
          <p className="mt-1 text-sm text-gray-500">Manage Quackteow outlets and supply orders from Hub</p>
        </div>
        {tab === 'orders' && (
          <button onClick={() => setShowNewSO(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors">
            <Plus size={16} /> New Supply Order
          </button>
        )}
        {tab === 'outlets' && (
          <button onClick={() => { setEditOutlet(null); setShowOutletModal(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors">
            <Plus size={16} /> Add Outlet
          </button>
        )}
      </div>

      {/* Stock Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-medium uppercase text-blue-600">Total Generated</p>
          <p className="mt-2 text-2xl font-bold text-blue-900">{displayMetrics.totalGenerated.toLocaleString()}</p>
          <p className="mt-1 text-xs text-blue-600">from production runs</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-medium uppercase text-amber-600">Total Dispatched</p>
          <p className="mt-2 text-2xl font-bold text-amber-900">{displayMetrics.totalDispatched.toLocaleString()}</p>
          <p className="mt-1 text-xs text-amber-600">units left hub (dispatched or received orders)</p>
        </div>
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-4">
          <p className="text-xs font-medium uppercase text-teal-600">Hub Available</p>
          <p className="mt-2 text-2xl font-bold text-teal-900">{displayMetrics.currentAvailable.toLocaleString()}</p>
          <p className="mt-1 text-xs text-teal-600">
            Available (after reservations)
            {displayMetrics.pendingSupplyUnits > 0 && (
              <>
                {' '}
                · {displayMetrics.pendingSupplyUnits.toLocaleString()} reserved on pending orders
              </>
            )}
          </p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-medium uppercase text-emerald-600">At Outlets</p>
          <p className="mt-2 text-2xl font-bold text-emerald-900">{totalOutletOnHand.toLocaleString()}</p>
          <p className="mt-1 text-xs text-emerald-600">
            {displayMetrics.outletInventory.length} outlets · on-hand updates when receipt is confirmed
            {totalAwaitingReceipt > 0
              ? ` · ${totalAwaitingReceipt.toLocaleString()} dispatched, awaiting outlet receipt`
              : ''}
          </p>
        </div>
      </div>

      {/* Outlet Inventory Breakdown */}
      {displayMetrics.outletInventory.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Outlet Stock Levels</h3>
          <p className="mb-4 text-xs text-gray-500">
            On-hand totals update when the outlet <strong className="font-medium text-gray-700">confirms receipt</strong>. Dispatch removes stock from the hub; outlet inventory increases only after receive.
          </p>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {displayMetrics.outletInventory.map((inv) => (
              <div key={inv.outletId} className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-700">{inv.outletName}</span>
                  <span className="text-lg font-bold text-gray-900">{inv.onHand.toLocaleString()}</span>
                </div>
                <p className="text-xs text-gray-500">
                  On hand at outlet
                  {inv.pendingSupplyQty > 0 && (
                    <span className="text-blue-800">
                      {' '}
                      · {inv.pendingSupplyQty.toLocaleString()} reserved (pending orders)
                    </span>
                  )}
                  {inv.awaitingReceiptQty > 0 && (
                    <span className="text-amber-800">
                      {' '}
                      · {inv.awaitingReceiptQty.toLocaleString()} dispatched · moves into on hand after receipt
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-b border-gray-200">
        <nav className="flex items-center justify-between gap-6 mb-4">
          <div className="flex gap-6">
            <button className={tabClass('orders')} onClick={() => setTab('orders')}>Supply Orders</button>
            <button className={tabClass('outlets')} onClick={() => setTab('outlets')}>Outlets</button>
          </div>
          {tab === 'orders' && <DateFilter onFilterChange={handleDateFilterChange} />}
        </nav>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center text-gray-400 text-sm">Loading…</div>
      ) : (
        <>
          {tab === 'orders' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Order #</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Outlet</th>
                    <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Qty</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Supply</th>
                    <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Dispatch</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Received</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredOrders.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-6 py-12 text-center">
                        <Truck className="mx-auto mb-3 text-gray-300" size={40} />
                        <p className="text-gray-400">No supply orders yet</p>
                      </td>
                    </tr>
                  ) : (
                    filteredOrders.map((so) => (
                      <tr key={so.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{so.supply_order_number}</td>
                        <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{so.outlet?.name ?? '—'}</td>
                        <td className="px-4 md:px-6 py-4 text-right font-semibold text-gray-900 text-xs sm:text-sm">{so.total_quantity}</td>
                        <td className="px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">{formatSupplyCalendarDate(so.supply_date ?? so.dispatch_date)}</td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">
                          {['dispatched', 'received'].includes(normalizeSOStatus(so.status))
                            ? formatSupplyCalendarDate(so.dispatch_date)
                            : '—'}
                        </td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">{so.received_date ? formatSupplyCalendarDate(so.received_date) : '—'}</td>
                        <td className="px-4 md:px-6 py-4"><StatusBadge status={so.status} /></td>
                        <td className="px-4 md:px-6 py-4">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setViewSO(so)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                            >
                              View <ChevronRight size={14} />
                            </button>
                            {isAdmin && supplyOrderAllowsAdminHardDelete(so.status) && (
                              <button
                                type="button"
                                onClick={() => void handleDeleteSupplyOrderRow(so)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800"
                                title="Delete supply order (admin)"
                              >
                                <Trash2 size={14} aria-hidden />
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'outlets' && (
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {outlets.length === 0 ? (
                <div className="sm:col-span-3 rounded-xl border-2 border-dashed border-gray-200 px-6 py-12 text-center text-gray-400">
                  No outlets added yet
                </div>
              ) : (
                outlets.map((outlet) => {
                  const stock = outletStockById.get(outlet.id);
                  return (
                  <div key={outlet.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-teal-200 transition-all">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="rounded-lg bg-teal-100 p-2 text-teal-600"><MapPin size={18} /></div>
                        <div>
                          <h3 className="font-semibold text-gray-900">{outlet.name}</h3>
                          <p className="text-xs text-gray-400">{outlet.location_code}</p>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => { setEditOutlet(outlet); setShowOutletModal(true); }} className="p-1 text-gray-400 hover:text-blue-600 transition-colors"><Edit2 size={15} /></button>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => void deleteOutlet(outlet.id)}
                            className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                            title="Delete outlet (admin)"
                          >
                            <Trash2 size={15} aria-hidden />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/80 px-3 py-2 text-xs">
                      <p className="font-semibold text-emerald-900">
                        Stock on hand:{' '}
                        <span className="tabular-nums">{(stock?.onHand ?? 0).toLocaleString()}</span>
                      </p>
                      {(stock?.pendingSupplyQty ?? 0) > 0 && (
                        <p className="mt-0.5 text-blue-800">
                          Pending orders (hub reserved):{' '}
                          <span className="font-semibold tabular-nums">
                            {(stock?.pendingSupplyQty ?? 0).toLocaleString()}
                          </span>
                        </p>
                      )}
                      {(stock?.awaitingReceiptQty ?? 0) > 0 && (
                        <p className="mt-0.5 text-amber-800">
                          Dispatched, awaiting receipt:{' '}
                          <span className="font-semibold tabular-nums">
                            {(stock?.awaitingReceiptQty ?? 0).toLocaleString()}
                          </span>{' '}
                          <span className="font-normal text-gray-600">(not in on hand yet)</span>
                        </p>
                      )}
                    </div>
                    <div className="mt-4 space-y-1 text-xs text-gray-600">
                      {outlet.city && <p>{outlet.city}{outlet.country ? `, ${outlet.country}` : ''}</p>}
                      {outlet.address && <p className="text-gray-400 line-clamp-1">{outlet.address}</p>}
                      {outlet.manager_name && (
                        <div className="mt-2 border-t border-gray-100 pt-2">
                          <p className="font-medium text-gray-700">{outlet.manager_name}</p>
                          {outlet.manager_phone && <p>{outlet.manager_phone}</p>}
                          {outlet.manager_email && <p className="text-gray-400">{outlet.manager_email}</p>}
                        </div>
                      )}
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          )}
        </>
      )}

      {showNewSO && (
        <NewSupplyOrderModal
          outlets={outlets}
          hubProductQty={hubProductQty}
          hubProductLines={hubProductLines}
          onClose={() => setShowNewSO(false)}
          onSave={async () => {
            await loadAll({ silent: true });
            setShowNewSO(false);
          }}
        />
      )}
      {viewSO && (
        <SODetailModal
          so={viewSO}
          onClose={() => setViewSO(null)}
          onStatusChange={async () => {
            await loadAll({ silent: true });
            setViewSO(null);
          }}
          isAdmin={isAdmin}
          executeAdminDelete={executeAdminDeleteSupplyOrder}
        />
      )}
      {showOutletModal && (
        <OutletModal
          outlet={editOutlet}
          onClose={() => setShowOutletModal(false)}
          onSave={async () => {
            await loadAll({ silent: true });
            setShowOutletModal(false);
          }}
        />
      )}
    </div>
  );
}
