import { useCallback, useEffect, useState } from 'react';
import { Plus, CreditCard as Edit2, Trash2, ChevronRight, Truck, MapPin, AlertCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DateFilter } from '../components/DateFilter';
import { supabase } from '../utils/supabase';
import { logActivity } from '../utils/activityLog';
import { isDateInRange, type DateRange } from '../utils/dateRange';
import { dispatchSupplyOrder, confirmSupplyOrderReceipt, createSupplyOrder } from '../utils/distributionService';
import { validateSupplyOrder } from '../utils/validation';
import type { Outlet, SupplyOrder } from '../types';

type Tab = 'orders' | 'outlets';

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-blue-100 text-blue-700',
    dispatched: 'bg-amber-100 text-amber-700',
    received: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-gray-100 text-gray-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status}
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
  onSave: () => void;
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
    if (err) { setError(err.message); setSaving(false); return; }
    await logActivity({
      action: outlet ? 'updated' : 'created',
      entityType: 'outlet',
      entityId: createdOutletId,
      entityLabel: form.name,
    });
    onSave();
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
  onSave: () => void;
}) {
  const [outlet_id, setOutletId] = useState('');
  const [dispatch_date, setDispatchDate] = useState(new Date().toISOString().split('T')[0]);
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    const qty = parseFloat(quantity);

    const validation = validateSupplyOrder({
      outlet_id,
      dispatch_date,
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
        setSaving(false);
        return;
      }

      const result = await createSupplyOrder({
        outletId: outlet_id,
        dispatchDate: dispatch_date,
        items,
        notes,
      });

      if (!result.success) {
        setError(result.errors.join('; '));
        setSaving(false);
        return;
      }

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create supply order');
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
          <label className="mb-1 block text-sm font-medium text-gray-700">Dispatch Date</label>
          <input type="date" value={dispatch_date} onChange={(e) => setDispatchDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
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

function SODetailModal({ so, onClose, onStatusChange }: { so: SOWithOutlet; onClose: () => void; onStatusChange: () => void }) {
  const [saving, setSaving] = useState(false);

  async function markDispatched() {
    setSaving(true);
    try {
      const result = await dispatchSupplyOrder(so.id);
      
      if (!result.success) {
        // We need an error state in SODetailModal. I'll add a simple alert for now.
        alert(`Failed to dispatch: ${result.error}`);
        setSaving(false);
        return;
      }
      
      setSaving(false);
      onStatusChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to dispatch');
      setSaving(false);
    }
  }

  async function markReceived() {
    setSaving(true);
    try {
      const result = await confirmSupplyOrderReceipt(so.id);
      
      if (!result.success) {
        alert(`Failed to receive: ${result.error}`);
        setSaving(false);
        return;
      }
      
      setSaving(false);
      onStatusChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to receive');
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Supply Order: ${so.supply_order_number}`} size="md">
      <div className="space-y-4">
        <div className="grid gap-4 rounded-lg bg-gray-50 p-4 grid-cols-1 sm:grid-cols-2">
          <div><p className="text-xs text-gray-500">Outlet</p><p className="font-semibold text-gray-900">{so.outlet?.name ?? '—'}</p></div>
          <div><p className="text-xs text-gray-500">Location</p><p className="font-semibold text-gray-900">{so.outlet?.location_code ?? '—'}</p></div>
          <div><p className="text-xs text-gray-500">Status</p><StatusBadge status={so.status} /></div>
          <div><p className="text-xs text-gray-500">Quantity</p><p className="font-semibold text-gray-900">{so.total_quantity} units</p></div>
          <div><p className="text-xs text-gray-500">Dispatch Date</p><p className="font-semibold text-gray-900">{so.dispatch_date ? new Date(so.dispatch_date).toLocaleDateString() : '—'}</p></div>
          {so.received_date && <div><p className="text-xs text-gray-500">Received Date</p><p className="font-semibold text-gray-900">{new Date(so.received_date).toLocaleDateString()}</p></div>}
          {so.notes && <div className="sm:col-span-2"><p className="text-xs text-gray-500">Notes</p><p className="text-sm text-gray-900">{so.notes}</p></div>}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap justify-between gap-3">
        <div className="flex gap-2">
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
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Close</button>
      </div>
    </Modal>
  );
}

// ---- Main Distribution Page ----
interface StockMetrics {
  totalGenerated: number;
  totalDispatched: number;
  currentAvailable: number;
  outletInventory: { outletId: string; outletName: string; quantity: number }[];
}

export function Distribution() {
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
    outletInventory: [],
  });
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

    // Calculate total dispatched (pending + dispatched + received)
    const totalDispatched = orders.reduce((sum, so) => sum + (so.total_quantity || 0), 0);

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
        quantity: qtyByOutlet.get(o.id) ?? 0,
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
    ? orders.filter((o) => isDateInRange(o.dispatch_date ?? o.created_at ?? '', dateRange))
    : orders;

  // Cards always show actual current state (all-time), not filtered
  const displayMetrics = {
    totalGenerated: stockMetrics.totalGenerated,
    totalDispatched: stockMetrics.totalDispatched,
    currentAvailable: stockMetrics.currentAvailable,
    outletInventory: stockMetrics.outletInventory,
  };

  async function deleteOutlet(id: string) {
    if (!confirm('Delete this outlet?')) return;
    const o = outlets.find((x) => x.id === id);
    await supabase.from('outlets').delete().eq('id', id);
    await logActivity({ action: 'deleted', entityType: 'outlet', entityId: id, entityLabel: o?.name ?? id });
    loadAll();
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
          <p className="mt-1 text-xs text-amber-600">via supply orders</p>
        </div>
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-4">
          <p className="text-xs font-medium uppercase text-teal-600">Hub Available</p>
          <p className="mt-2 text-2xl font-bold text-teal-900">{displayMetrics.currentAvailable.toLocaleString()}</p>
          <p className="mt-1 text-xs text-teal-600">Available (after reservations)</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-medium uppercase text-emerald-600">At Outlets</p>
          <p className="mt-2 text-2xl font-bold text-emerald-900">{displayMetrics.outletInventory.reduce((sum, o) => sum + o.quantity, 0).toLocaleString()}</p>
          <p className="mt-1 text-xs text-emerald-600">{displayMetrics.outletInventory.length} outlets</p>
        </div>
      </div>

      {/* Outlet Inventory Breakdown */}
      {displayMetrics.outletInventory.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-900">Outlet Stock Levels</h3>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {displayMetrics.outletInventory.map((inv) => (
              <div key={inv.outletId} className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <span className="text-sm font-medium text-gray-700">{inv.outletName}</span>
                <span className="text-lg font-bold text-gray-900">{inv.quantity.toLocaleString()}</span>
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
                    <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Dispatch</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Received</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="w-12 px-4 md:px-6 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredOrders.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center">
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
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs">{new Date(so.dispatch_date).toLocaleDateString()}</td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs">{so.received_date ? new Date(so.received_date).toLocaleDateString() : '—'}</td>
                        <td className="px-4 md:px-6 py-4"><StatusBadge status={so.status} /></td>
                        <td className="px-4 md:px-6 py-4">
                          <button onClick={() => setViewSO(so)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800">
                            View <ChevronRight size={14} />
                          </button>
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
                outlets.map((outlet) => (
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
                        <button onClick={() => deleteOutlet(outlet.id)} className="p-1 text-gray-400 hover:text-red-600 transition-colors"><Trash2 size={15} /></button>
                      </div>
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
                ))
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
          onSave={() => { setShowNewSO(false); loadAll(); }}
        />
      )}
      {viewSO && (
        <SODetailModal
          so={viewSO}
          onClose={() => setViewSO(null)}
          onStatusChange={() => { setViewSO(null); loadAll(); }}
        />
      )}
      {showOutletModal && (
        <OutletModal
          outlet={editOutlet}
          onClose={() => setShowOutletModal(false)}
          onSave={() => { setShowOutletModal(false); loadAll(); }}
        />
      )}
    </div>
  );
}
