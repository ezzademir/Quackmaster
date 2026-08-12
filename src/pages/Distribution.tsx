import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, CreditCard as Edit2, Trash2, ChevronRight, Truck, MapPin, AlertCircle, ArrowLeftRight } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DateFilter } from '../components/DateFilter';
import { HubAtpCompact } from '../components/HubAtpCompact';
import { supabase } from '../utils/supabase';
import { logActivity } from '../utils/activityLog';
import { isDateInRange, isCalendarDateInRange, type DateRange } from '../utils/dateRange';
import {
  dispatchSupplyOrder,
  confirmSupplyOrderReceipt,
  createSupplyOrder,
  cancelSupplyOrder,
  adminDeleteOutlet,
  adminDeleteSupplyOrder,
  createOutletTransfer,
  dispatchOutletTransfer,
  receiveOutletTransfer,
  cancelOutletTransfer,
} from '../utils/distributionService';
import { validateSupplyOrder } from '../utils/validation';
import type { Outlet, OutletTransfer, OutletInventory, OutletTransferLine, SupplyOrder } from '../types';
import { useAuth } from '../utils/auth';
import {
  aggregateFinishedGoodsHubTotals,
  hubRowAvailableQuantity,
  type FinishedHubTotals,
} from '../utils/hubInventoryMath';

type Tab = 'orders' | 'outlets' | 'transfers';

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

/** Split requested qty across hub product batches (FEFO by expiry then last_updated). */
function allocateHubProductItems(
  batches: {
    id: string;
    product_batch: string | null;
    available: number;
    last_updated?: string;
    expiry_date?: string | null;
  }[],
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
  hubProductLines: {
    id: string;
    product_batch: string | null;
    available: number;
    last_updated?: string;
    expiry_date?: string | null;
  }[];
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  const [outlet_id, setOutletId] = useState('');
  const [supply_date, setSupplyDate] = useState(new Date().toISOString().split('T')[0]);
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const qtyParsed = parseFloat(quantity);
  const allocationPreview = useMemo(() => {
    const q = parseFloat(quantity);
    if (!Number.isFinite(q) || q <= 0) return null;
    return allocateHubProductItems(hubProductLines, q);
  }, [quantity, hubProductLines]);

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
    <Modal isOpen onClose={onClose} title="New Supply Order" size="lg">
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
          {allocationPreview != null && allocationPreview.length > 0 && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">FEFO allocation preview</p>
              <p className="mt-1 text-xs text-gray-500">Uses hub batches sorted by expiry date first (FEFO), then oldest last_updated.</p>
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm">
                {allocationPreview.map((line, i) => (
                  <li key={`${line.hubInventoryId}-${i}`} className="flex justify-between gap-3 border-b border-gray-100 pb-1 text-gray-700 last:border-0">
                    <span className="truncate font-medium">{line.product_batch}</span>
                    <span className="flex-shrink-0 font-semibold tabular-nums text-gray-900">{line.quantity}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Number.isFinite(qtyParsed) && qtyParsed > 0 && allocationPreview === null && (
            <p className="mt-2 text-xs text-amber-700">
              This quantity cannot be covered by FEFO allocation across current hub batches (insufficient available).
            </p>
          )}
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

type HubRmLineRow = {
  id: string;
  raw_material_id: string;
  label: string;
  unit: string;
  available: number;
};

/** Supply hub raw materials to an outlet (parallel to finished-goods supply orders). */
function NewRawMaterialSupplyModal({
  outlets,
  hubRmLines,
  onClose,
  onSave,
}: {
  outlets: Outlet[];
  hubRmLines: HubRmLineRow[];
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  const [outlet_id, setOutletId] = useState('');
  const [supply_date, setSupplyDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [qtyByHubId, setQtyByHubId] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setQtyByHubId(Object.fromEntries(hubRmLines.map((l) => [l.id, ''])));
  }, [hubRmLines]);

  async function handleSave() {
    setError('');
    const validation = validateSupplyOrder({
      outlet_id,
      supply_date,
      total_quantity: 1,
    });
    if (!validation.isValid) {
      setError(validation.errors.map((e) => e.message).join('; '));
      return;
    }

    const items: { hubInventoryId: string; quantity: number; product_batch: null }[] = [];
    for (const line of hubRmLines) {
      const raw = qtyByHubId[line.id]?.trim() ?? '';
      if (raw === '') continue;
      const q = parseFloat(raw);
      if (!Number.isFinite(q) || q <= 0) {
        setError(`Invalid quantity for ${line.label}`);
        return;
      }
      if (q > line.available + 1e-9) {
        setError(`${line.label}: cannot exceed ${line.available.toFixed(2)} available at hub`);
        return;
      }
      items.push({ hubInventoryId: line.id, quantity: q, product_batch: null });
    }

    if (items.length === 0) {
      setError('Enter a quantity greater than zero for at least one ingredient.');
      return;
    }

    setSaving(true);
    try {
      const result = await createSupplyOrder({
        outletId: outlet_id,
        supplyDate: supply_date,
        items,
        notes: notes.trim() || undefined,
      });
      if (!result.success) {
        setError(result.errors.join('; '));
        return;
      }
      await onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create order');
    } finally {
      setSaving(false);
    }
  }

  const anyRmStock = hubRmLines.some((l) => l.available > 1e-9);

  return (
    <Modal isOpen onClose={onClose} title="Ingredient supply order" size="lg">
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
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Ships raw materials from hub inventory to the outlet. Lines use the same dispatch / receive flow as
          finished-goods supply orders.
        </div>
        {!anyRmStock && (
          <p className="text-sm text-gray-600">No raw material stock recorded at hub. Receive purchases or adjust hub inventory first.</p>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Outlet *</label>
          <select
            value={outlet_id}
            onChange={(e) => setOutletId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Select outlet…</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.location_code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Supply date *</label>
          <input
            type="date"
            value={supply_date}
            onChange={(e) => setSupplyDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Quantities</label>
          <p className="mb-2 text-xs text-gray-500">Enter quantity to ship per hub ingredient row (only non-zero rows are included).</p>
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-gray-200">
            {hubRmLines.length === 0 ? (
              <p className="p-4 text-sm text-gray-500">No hub ingredient rows.</p>
            ) : (
              hubRmLines.map((line) => (
                <div key={line.id} className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">{line.label}</p>
                    <p className="text-xs text-gray-500">
                      Hub avail {line.available.toFixed(2)} {line.unit || ''}
                    </p>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={qtyByHubId[line.id] ?? ''}
                    disabled={line.available <= 1e-9}
                    onChange={(e) => setQtyByHubId((p) => ({ ...p, [line.id]: e.target.value }))}
                    className="w-28 rounded-lg border border-gray-300 px-2 py-1 text-sm tabular-nums disabled:opacity-50"
                  />
                </div>
              ))
            )}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !anyRmStock}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60 transition-colors"
        >
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
  const [cancelReason, setCancelReason] = useState('');
  const canHardDelete = isAdmin && supplyOrderAllowsAdminHardDelete(so.status);

  async function askCancelOrder() {
    const st = normalizeSOStatus(so.status);
    if (st !== 'pending') return;
    const detail = supplyOrderAdminDeleteConfirmDetail('pending');
    if (
      !confirm(
        `Cancel supply order ${so.supply_order_number}?\n\n${detail}\n\nThe order will stay in the list with status Cancelled (audit trail).`
      )
    )
      return;
    setSaving(true);
    try {
      const result = await cancelSupplyOrder(so.id, cancelReason.trim());
      if (!result.success) {
        alert(result.error ?? 'Could not cancel order');
        return;
      }
      setCancelReason('');
      await onStatusChange();
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not cancel order');
    } finally {
      setSaving(false);
    }
  }

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
  const isPending = normalizeSOStatus(so.status) === 'pending';

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
        {isPending && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Cancellation reason (optional)</label>
            <input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="e.g. Outlet requested hold, wrong batch selected…"
              disabled={saving}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
        )}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex max-w-full flex-col gap-2">
          {canHardDelete && isPending && (
            <p className="text-xs text-gray-500 max-w-prose">
              Prefer <span className="font-medium text-gray-700">Cancel order</span> to keep a cancelled record with history;{' '}
              <span className="font-medium text-gray-700">Delete order</span> removes the row entirely (admin).
            </p>
          )}
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
          {isPending && (
            <button
              type="button"
              onClick={() => void askCancelOrder()}
              disabled={saving}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60 transition-colors"
            >
              {saving ? 'Cancelling…' : 'Cancel order'}
            </button>
          )}
          {isPending && (
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
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Close</button>
      </div>
    </Modal>
  );
}

type OTWithOutlets = OutletTransfer & { from_outlet?: Outlet; to_outlet?: Outlet };

function outletTransferDateForRangeFilter(ot: OTWithOutlets): string {
  const st = normalizeSOStatus(ot.status);
  const created = ot.created_at?.trim?.() ?? '';
  if (st === 'pending' || st === 'cancelled') return created.includes('T') ? created : `${created}`;
  const d = ot.dispatch_date?.trim?.();
  if (d && d !== '') return d.includes('T') ? d : `${d}T12:00:00`;
  return created;
}

function normalizeTransferLinesForRpc(
  raw: Array<{ outletInventoryId: string; qtyStr: string }>
): { outletInventoryId: string; quantity: number }[] | null {
  const qtyByInv = new Map<string, number>();
  for (const row of raw) {
    const id = row.outletInventoryId.trim();
    const q = parseFloat(row.qtyStr);
    if (!id || !Number.isFinite(q) || q <= 0) continue;
    qtyByInv.set(id, (qtyByInv.get(id) ?? 0) + q);
  }
  if (qtyByInv.size === 0) return null;
  return [...qtyByInv.entries()].map(([outletInventoryId, quantity]) => ({
    outletInventoryId,
    quantity,
  }));
}

/** New outlet-to-outlet stock transfer */
function NewOutletTransferModal({
  outlets,
  onClose,
  onSave,
}: {
  outlets: Outlet[];
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  const [from_outlet_id, setFromOutletId] = useState('');
  const [to_outlet_id, setToOutletId] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState([{ outletInventoryId: '', qtyStr: '' }]);
  const [invRows, setInvRows] = useState<OutletInventory[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!from_outlet_id) {
        setInvRows([]);
        return;
      }
      const { data, error: e } = await supabase
        .from('outlet_inventory')
        .select(
          'id, outlet_id, product_batch, quantity_on_hand, reserved_quantity, available_quantity'
        )
        .eq('outlet_id', from_outlet_id)
        .is('raw_material_id', null)
        .order('product_batch');

      if (!cancelled) {
        if (e) setInvRows([]);
        else setInvRows((data ?? []) as OutletInventory[]);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [from_outlet_id]);

  function availableFor(row: OutletInventory): number {
    const r = Number(row.reserved_quantity ?? 0);
    const q = Number(row.quantity_on_hand ?? 0);
    const a = row.available_quantity;
    if (a != null && Number.isFinite(Number(a))) return Math.max(0, Number(a));
    return Math.max(0, q - r);
  }

  async function handleSave() {
    setError('');
    if (!from_outlet_id || !to_outlet_id || from_outlet_id === to_outlet_id) {
      setError('Select two different outlets');
      return;
    }
    const lines = normalizeTransferLinesForRpc(rows);
    if (!lines?.length) {
      setError('Add at least one line with a batch row and quantity');
      return;
    }
    setSaving(true);
    try {
      const result = await createOutletTransfer({
        fromOutletId: from_outlet_id,
        toOutletId: to_outlet_id,
        lines,
        notes,
      });
      if (!result.success) {
        setError(result.error ?? 'Failed to create transfer');
        return;
      }
      await onSave();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="New outlet transfer" size="lg">
      {error && (
        <div className="mb-4 flex items-start gap-3 rounded-lg bg-red-50 p-3">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0 text-red-600" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}
      <div className="space-y-4">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">From outlet *</label>
            <select
              value={from_outlet_id}
              onChange={(e) => {
                setFromOutletId(e.target.value);
                setRows([{ outletInventoryId: '', qtyStr: '' }]);
              }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Select…</option>
              {outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.location_code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">To outlet *</label>
            <select
              value={to_outlet_id}
              onChange={(e) => setToOutletId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Select…</option>
              {outlets.map((o) =>
                o.id !== from_outlet_id ? (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.location_code})
                  </option>
                ) : null
              )}
            </select>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Lines *</label>
          <p className="mb-2 text-xs text-gray-500">
            Pick source inventory rows at the from outlet; quantity cannot exceed available (on hand minus reserved).
          </p>
          {!from_outlet_id ? (
            <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
              Choose a source outlet to load batches.
            </p>
          ) : invRows.length === 0 ? (
            <p className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-4 text-sm text-amber-900">
              No outlet inventory for this outlet yet. Receive stock from a supply order first.
            </p>
          ) : (
            <div className="space-y-2">
              {rows.map((line, idx) => (
                <div key={`${idx}-${line.outletInventoryId}`} className="flex flex-wrap items-end gap-2">
                  <select
                    value={line.outletInventoryId}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], outletInventoryId: e.target.value };
                      setRows(next);
                    }}
                    className="min-w-[12rem] flex-1 rounded-lg border border-gray-300 px-2 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">Batch…</option>
                    {invRows.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.product_batch} (avail {availableFor(r).toFixed(2)})
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Qty"
                    value={line.qtyStr}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], qtyStr: e.target.value };
                      setRows(next);
                    }}
                    className="w-28 rounded-lg border border-gray-300 px-2 py-2 text-right text-sm focus:border-blue-500 focus:outline-none"
                  />
                  {rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                      className="rounded-lg border border-gray-200 px-2 py-2 text-xs text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setRows([...rows, { outletInventoryId: '', qtyStr: '' }])}
                className="text-xs font-medium text-teal-600 hover:text-teal-800"
              >
                + Add line
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60 transition-colors"
        >
          {saving ? 'Creating…' : 'Create transfer'}
        </button>
      </div>
    </Modal>
  );
}

function TransferDetailModal({
  transfer,
  onClose,
  onStatusChange,
}: {
  transfer: OTWithOutlets;
  onClose: () => void;
  onStatusChange: () => void | Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [lines, setLines] = useState<OutletTransferLine[]>([]);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadErr('');
      const { data, error } = await supabase
        .from('outlet_transfer_lines')
        .select('*')
        .eq('outlet_transfer_id', transfer.id)
        .order('created_at');
      if (cancelled) return;
      if (error) setLoadErr(error.message);
      else setLines((data ?? []) as OutletTransferLine[]);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [transfer.id]);

  async function runDispatch() {
    setSaving(true);
    try {
      const r = await dispatchOutletTransfer(transfer.id);
      if (!r.success) {
        alert(r.error ?? 'Dispatch failed');
        return;
      }
      await onStatusChange();
    } finally {
      setSaving(false);
    }
  }

  async function runReceive() {
    setSaving(true);
    try {
      const r = await receiveOutletTransfer(transfer.id);
      if (!r.success) {
        alert(r.error ?? 'Receive failed');
        return;
      }
      await onStatusChange();
    } finally {
      setSaving(false);
    }
  }

  async function runCancel() {
    const st = normalizeSOStatus(transfer.status);
    const detail =
      st === 'pending'
        ? 'Reserved quantity at the source outlet will be released.'
        : 'Stock that left the source on dispatch will be returned to the source outlet (nothing was received at destination).';
    if (!confirm(`Cancel transfer ${transfer.transfer_number}?\n\n${detail}`)) return;
    setSaving(true);
    try {
      const r = await cancelOutletTransfer(transfer.id);
      if (!r.success) {
        alert(r.error ?? 'Cancel failed');
        return;
      }
      await onStatusChange();
    } finally {
      setSaving(false);
    }
  }

  const statusNorm = normalizeSOStatus(transfer.status);
  const showDispatchDate = statusNorm === 'dispatched' || statusNorm === 'received';

  return (
    <Modal isOpen onClose={onClose} title={`Transfer: ${transfer.transfer_number}`} size="xl">
      {loadErr && <p className="mb-3 text-sm text-red-600">{loadErr}</p>}
      <div className="space-y-4">
        <div className="grid gap-4 rounded-lg bg-gray-50 p-4 grid-cols-1 sm:grid-cols-2">
          <div>
            <p className="text-xs text-gray-500">From</p>
            <p className="font-semibold text-gray-900">{transfer.from_outlet?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">To</p>
            <p className="font-semibold text-gray-900">{transfer.to_outlet?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Status</p>
            <StatusBadge status={transfer.status} />
          </div>
          <div>
            <p className="text-xs text-gray-500">Total qty</p>
            <p className="font-semibold text-gray-900">{Number(transfer.total_quantity ?? 0).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Dispatched</p>
            <p className="font-semibold text-gray-900">
              {showDispatchDate ? formatSupplyCalendarDate(transfer.dispatch_date) : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Received</p>
            <p className="font-semibold text-gray-900">
              {transfer.received_date ? formatSupplyCalendarDate(transfer.received_date) : '—'}
            </p>
          </div>
          {transfer.notes && (
            <div className="sm:col-span-2">
              <p className="text-xs text-gray-500">Notes</p>
              <p className="text-sm text-gray-900">{transfer.notes}</p>
            </div>
          )}
        </div>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Product batch</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-700">Qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-3 py-6 text-center text-gray-400">
                    No lines loaded
                  </td>
                </tr>
              ) : (
                lines.map((ln) => (
                  <tr key={ln.id}>
                    <td className="px-3 py-2 font-medium text-gray-900">{ln.product_batch}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-800">{Number(ln.quantity).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {transfer.status === 'pending' && (
            <>
              <button
                type="button"
                onClick={() => void runDispatch()}
                disabled={saving}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60 transition-colors"
              >
                {saving ? 'Dispatching…' : 'Dispatch'}
              </button>
              <button
                type="button"
                onClick={() => void runCancel()}
                disabled={saving}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
              >
                Cancel transfer
              </button>
            </>
          )}
          {transfer.status === 'dispatched' && (
            <>
              <button
                type="button"
                onClick={() => void runReceive()}
                disabled={saving}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors"
              >
                {saving ? 'Saving…' : 'Mark received at destination'}
              </button>
              <button
                type="button"
                onClick={() => void runCancel()}
                disabled={saving}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
              >
                Undo dispatch (return to source)
              </button>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Close
        </button>
      </div>
    </Modal>
  );
}

// ---- Main Distribution Page ----
function normalizeSOStatus(status: string | undefined): string {
  return String(status ?? '').toLowerCase().trim();
}

/** Filter by supply_date — matches the Supply column in the orders table. */
function supplyOrderDateForRangeFilter(so: SOWithOutlet): string {
  const supplyDate = (so.supply_date ?? so.dispatch_date)?.trim();
  if (supplyDate) return supplyDate.includes('T') ? supplyDate : `${supplyDate}T12:00:00`;
  return so.created_at ?? '';
}

interface OutletStockRow {
  outletId: string;
  outletName: string;
  /** Period view: units received in range; all-time view: on-hand at outlet */
  onHand: number;
  /** Sum of sellable quantity (available) across outlet_inventory rows — after reservations */
  availableSellable: number;
  /** Dispatched, not yet received — in transit; not included in on hand until receipt */
  awaitingReceiptQty: number;
  /** Pending supply orders — hub reserved only */
  pendingSupplyQty: number;
  /** Live outlet_inventory total (only when date filter is active) */
  currentOnHandSnapshot?: number;
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

type CompletedProdRun = { actual_output: number | null; production_date: string };

export function Distribution() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('orders');
  const [orders, setOrders] = useState<SOWithOutlet[]>([]);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [hubProductQty, setHubProductQty] = useState(0);
  /** Finished-goods hub rows for reservations (real UUIDs). */
  const [hubProductLines, setHubProductLines] = useState<
    {
      id: string;
      product_batch: string | null;
      available: number;
      last_updated?: string;
      expiry_date?: string | null;
    }[]
  >([]);
  const [hubFinishedAtp, setHubFinishedAtp] = useState<FinishedHubTotals>({
    onHand: 0,
    reserved: 0,
    available: 0,
  });
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
  const [transfers, setTransfers] = useState<OTWithOutlets[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewSO, setShowNewSO] = useState(false);
  const [showNewRMSO, setShowNewRMSO] = useState(false);
  const [hubRmLines, setHubRmLines] = useState<HubRmLineRow[]>([]);
  const [showNewTransfer, setShowNewTransfer] = useState(false);
  const [viewSO, setViewSO] = useState<SOWithOutlet | null>(null);
  const [viewTransfer, setViewTransfer] = useState<OTWithOutlets | null>(null);
  const [editOutlet, setEditOutlet] = useState<Outlet | null>(null);
  const [showOutletModal, setShowOutletModal] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [completedProductionRuns, setCompletedProductionRuns] = useState<CompletedProdRun[]>([]);

  const loadAll = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const [
      { data: sos },
      { data: outs },
      { data: prodRuns },
      { data: outletInv },
      { data: hubProducts },
      { data: hubRmRaw },
      { data: ots },
    ] = await Promise.all([
      supabase.from('supply_orders').select(`*, outlet:outlet_id(*)`).order('created_at', { ascending: false }),
      supabase.from('outlets').select('*').order('name'),
      supabase.from('production_runs').select('actual_output, production_date').eq('status', 'completed'),
      supabase
        .from('outlet_inventory')
        .select('outlet_id, quantity_on_hand, reserved_quantity, available_quantity')
        .is('raw_material_id', null),
      supabase
        .from('hub_inventory')
        .select(
          'id, product_batch, lot_id, available_quantity, quantity_on_hand, reserved_quantity, last_updated, lot:inventory_lots(expiry_date)'
        )
        .is('raw_material_id', null),
      supabase
        .from('hub_inventory')
        .select(
          'id, raw_material_id, available_quantity, quantity_on_hand, reserved_quantity, last_updated, material:raw_material_id(name, unit_of_measure)'
        )
        .not('raw_material_id', 'is', null),
      supabase
        .from('outlet_transfers')
        .select(`*, from_outlet:from_outlet_id(*), to_outlet:to_outlet_id(*)`)
        .order('created_at', { ascending: false }),
    ]);

    const orders = sos as SOWithOutlet[] ?? [];
    const outlets_list = outs ?? [];
    setCompletedProductionRuns((prodRuns ?? []) as CompletedProdRun[]);

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
      const reserved = Number(row.reserved_quantity ?? 0);
      const onHand = Number(row.quantity_on_hand ?? 0);
      const avail = hubRowAvailableQuantity(onHand, reserved, row.available_quantity);
      const lot = row.lot as { expiry_date?: string | null } | null;
      return {
        id: row.id,
        product_batch: row.product_batch,
        available: avail,
        last_updated: row.last_updated,
        expiry_date: lot?.expiry_date ?? null,
      };
    });

    hubLines.sort((a, b) => {
      const ad = a.expiry_date ? Date.parse(a.expiry_date) : Number.POSITIVE_INFINITY;
      const bd = b.expiry_date ? Date.parse(b.expiry_date) : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return (a.last_updated ?? '').localeCompare(b.last_updated ?? '');
    });

    const rmLinesForModal: HubRmLineRow[] = (hubRmRaw ?? []).map((row: Record<string, unknown>) => {
      const mat = row.material as { name?: string; unit_of_measure?: string } | null;
      const reserved = Number(row.reserved_quantity ?? 0);
      const onHand = Number(row.quantity_on_hand ?? 0);
      const avail = hubRowAvailableQuantity(
        onHand,
        reserved,
        row.available_quantity != null ? Number(row.available_quantity) : null
      );
      const name = mat?.name?.trim() || 'Ingredient';
      return {
        id: String(row.id),
        raw_material_id: String(row.raw_material_id),
        label: name,
        unit: mat?.unit_of_measure?.trim() ?? '',
        available: avail,
      };
    });
    rmLinesForModal.sort((a, b) => a.label.localeCompare(b.label));
    setHubRmLines(rmLinesForModal);

    setHubFinishedAtp(aggregateFinishedGoodsHubTotals(hubProducts ?? []));

    // Hub available = actual finished-goods stock (matches Overview / Inventory)
    const currentAvailable = hubLines.reduce((sum, r) => sum + Math.max(0, r.available), 0);

    const qtyByOutlet = new Map<string, number>();
    const availByOutlet = new Map<string, number>();
    for (const inv of outletInv ?? []) {
      const oid = (inv as { outlet_id: string }).outlet_id;
      if (!oid) continue;
      const q = Number((inv as { quantity_on_hand: number }).quantity_on_hand ?? 0);
      const res = Number((inv as { reserved_quantity?: number }).reserved_quantity ?? 0);
      const stored = (inv as { available_quantity?: number | null }).available_quantity;
      const avail = hubRowAvailableQuantity(q, res, stored);
      qtyByOutlet.set(oid, (qtyByOutlet.get(oid) ?? 0) + q);
      availByOutlet.set(oid, (availByOutlet.get(oid) ?? 0) + Math.max(0, avail));
    }

    const outletInventoryBreakdown = outlets_list
      .map((o) => ({
        outletId: o.id,
        outletName: o.name,
        onHand: qtyByOutlet.get(o.id) ?? 0,
        availableSellable: availByOutlet.get(o.id) ?? 0,
        awaitingReceiptQty: awaitingReceiptByOutlet.get(o.id) ?? 0,
        pendingSupplyQty: pendingQtyByOutlet.get(o.id) ?? 0,
        currentOnHandSnapshot: undefined,
      }))
      .sort((a, b) => a.outletName.localeCompare(b.outletName));

    setOrders(orders);
    setOutlets(outlets_list);
    setTransfers((ots ?? []) as OTWithOutlets[]);
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outlet_transfers' },
        () => void loadAll({ silent: true })
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'production_runs' },
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

  const filteredTransfers = dateRange
    ? transfers.filter((t) => isDateInRange(outletTransferDateForRangeFilter(t), dateRange))
    : transfers;

  const snapshotOutletOnHandById = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of stockMetrics.outletInventory) {
      m.set(row.outletId, row.onHand);
    }
    return m;
  }, [stockMetrics.outletInventory]);

  const snapshotOutletAvailableById = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of stockMetrics.outletInventory) {
      m.set(row.outletId, row.availableSellable);
    }
    return m;
  }, [stockMetrics.outletInventory]);

  const distributionDisplay = useMemo(() => {
    if (!dateRange) {
      const totalAwaiting = stockMetrics.outletInventory.reduce((s, o) => s + o.awaitingReceiptQty, 0);
      const totalOnHand = stockMetrics.outletInventory.reduce((s, o) => s + o.onHand, 0);
      return {
        isFiltered: false as const,
        totalGenerated: stockMetrics.totalGenerated,
        totalDispatched: stockMetrics.totalDispatched,
        hubAvailableNow: stockMetrics.currentAvailable,
        pendingSupplyUnits: stockMetrics.pendingSupplyUnits,
        totalOutletReceivedPeriod: totalOnHand,
        totalOutletOnHandNow: totalOnHand,
        totalAwaitingReceipt: totalAwaiting,
        outletInventory: stockMetrics.outletInventory,
      };
    }

    const totalGenerated = completedProductionRuns.reduce((sum, r) => {
      if (!isCalendarDateInRange(r.production_date, dateRange)) return sum;
      return sum + Number(r.actual_output ?? 0);
    }, 0);

    const ordersInPeriod = orders.filter((o) =>
      isDateInRange(supplyOrderDateForRangeFilter(o), dateRange)
    );

    const totalDispatched = ordersInPeriod.reduce((sum, so) => {
      const st = normalizeSOStatus(so.status);
      if (st !== 'dispatched' && st !== 'received') return sum;
      return sum + Number(so.total_quantity ?? 0);
    }, 0);

    const pendingSupplyUnits = ordersInPeriod.reduce((sum, so) => {
      if (normalizeSOStatus(so.status) !== 'pending') return sum;
      return sum + Number(so.total_quantity ?? 0);
    }, 0);

    const awaitingReceiptByOutlet = new Map<string, number>();
    const pendingQtyByOutlet = new Map<string, number>();
    const receivedInPeriodByOutlet = new Map<string, number>();

    for (const so of ordersInPeriod) {
      const st = normalizeSOStatus(so.status);
      const oid = so.outlet_id;
      if (!oid) continue;
      const q = Number(so.total_quantity ?? 0);

      if (st === 'dispatched') {
        awaitingReceiptByOutlet.set(oid, (awaitingReceiptByOutlet.get(oid) ?? 0) + q);
      }
      if (st === 'pending') {
        pendingQtyByOutlet.set(oid, (pendingQtyByOutlet.get(oid) ?? 0) + q);
      }
      if (st === 'received' && isCalendarDateInRange(so.received_date, dateRange)) {
        receivedInPeriodByOutlet.set(oid, (receivedInPeriodByOutlet.get(oid) ?? 0) + q);
      }
    }

    const outletsSorted = outlets.slice().sort((a, b) => a.name.localeCompare(b.name));
    const outletInventory: OutletStockRow[] = outletsSorted.map((o) => ({
      outletId: o.id,
      outletName: o.name,
      onHand: receivedInPeriodByOutlet.get(o.id) ?? 0,
      availableSellable: snapshotOutletAvailableById.get(o.id) ?? 0,
      awaitingReceiptQty: awaitingReceiptByOutlet.get(o.id) ?? 0,
      pendingSupplyQty: pendingQtyByOutlet.get(o.id) ?? 0,
      currentOnHandSnapshot: snapshotOutletOnHandById.get(o.id) ?? 0,
    }));

    const totalOutletReceivedPeriod = outletInventory.reduce((s, o) => s + o.onHand, 0);
    const totalOutletOnHandNow = outletInventory.reduce((s, o) => s + (o.currentOnHandSnapshot ?? 0), 0);
    const totalAwaitingReceipt = outletInventory.reduce((s, o) => s + o.awaitingReceiptQty, 0);

    return {
      isFiltered: true as const,
      totalGenerated,
      totalDispatched,
      hubAvailableNow: stockMetrics.currentAvailable,
      pendingSupplyUnits,
      totalOutletReceivedPeriod,
      totalOutletOnHandNow,
      totalAwaitingReceipt,
      outletInventory,
    };
  }, [dateRange, orders, outlets, completedProductionRuns, stockMetrics, snapshotOutletOnHandById, snapshotOutletAvailableById]);

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
          <p className="mt-1 text-sm text-gray-500">
            Manage outlets, hub supply orders, and outlet-to-outlet stock transfers
          </p>
        </div>
        {tab === 'orders' && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNewRMSO(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-teal-600 bg-white px-4 py-2 text-sm font-medium text-teal-800 hover:bg-teal-50 transition-colors"
            >
              <Plus size={16} /> Ingredient supply
            </button>
            <button
              type="button"
              onClick={() => setShowNewSO(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors"
            >
              <Plus size={16} /> New Supply Order
            </button>
          </div>
        )}
        {tab === 'outlets' && (
          <button onClick={() => { setEditOutlet(null); setShowOutletModal(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors">
            <Plus size={16} /> Add Outlet
          </button>
        )}
        {tab === 'transfers' && (
          <button onClick={() => setShowNewTransfer(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors">
            <Plus size={16} /> New transfer
          </button>
        )}
      </div>

      <div className="border-b border-gray-200">
        <nav className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div className="flex gap-6">
            <button type="button" className={tabClass('orders')} onClick={() => setTab('orders')}>Supply Orders</button>
            <button type="button" className={tabClass('transfers')} onClick={() => setTab('transfers')}>Outlet transfers</button>
            <button type="button" className={tabClass('outlets')} onClick={() => setTab('outlets')}>Outlets</button>
          </div>
          {tab !== 'outlets' && (
            <DateFilter
              onFilterChange={handleDateFilterChange}
              hint="Supply orders: supply date. Transfers: dispatch date. Summary cards use production, supply, and receipt dates."
            />
          )}
        </nav>
      </div>

      {dateRange && (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-700">
          Order list uses <strong className="font-medium">supply date</strong>. &quot;Received (range)&quot; uses{' '}
          <strong className="font-medium">receipt date</strong>. Hub available and outlet &quot;on hand now&quot; are live snapshots.
        </p>
      )}

      <HubAtpCompact totals={hubFinishedAtp} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-600" />

      {/* Stock Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-medium uppercase text-blue-600">
            {distributionDisplay.isFiltered ? 'Generated (in range)' : 'Total Generated'}
          </p>
          <p className="mt-2 text-2xl font-bold text-blue-900">{distributionDisplay.totalGenerated.toLocaleString()}</p>
          <p className="mt-1 text-xs text-blue-600">
            {distributionDisplay.isFiltered
              ? 'Completed runs with production date in range'
              : 'from production runs'}
          </p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-medium uppercase text-amber-600">
            {distributionDisplay.isFiltered ? 'Dispatched (supply date in range)' : 'Total Dispatched'}
          </p>
          <p className="mt-2 text-2xl font-bold text-amber-900">{distributionDisplay.totalDispatched.toLocaleString()}</p>
          <p className="mt-1 text-xs text-amber-600">
            {distributionDisplay.isFiltered
              ? 'Units on filtered orders (dispatched or received)'
              : 'units left hub (dispatched or received orders)'}
          </p>
        </div>
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-4">
          <p className="text-xs font-medium uppercase text-teal-600">Hub Available</p>
          {distributionDisplay.isFiltered ? (
            <>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs font-medium text-teal-700">Available now</p>
                  <p className="text-xl font-bold tabular-nums text-teal-900">{distributionDisplay.hubAvailableNow.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-teal-700">Pending (range)</p>
                  <p className="text-xl font-bold tabular-nums text-teal-900">{distributionDisplay.pendingSupplyUnits.toLocaleString()}</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-teal-600">Pending = hub reservations from filtered pending orders.</p>
            </>
          ) : (
            <>
              <p className="mt-2 text-2xl font-bold text-teal-900">{distributionDisplay.hubAvailableNow.toLocaleString()}</p>
              <p className="mt-1 text-xs text-teal-600">
                Available (after reservations)
                {distributionDisplay.pendingSupplyUnits > 0 && (
                  <>
                    {' '}
                    · {distributionDisplay.pendingSupplyUnits.toLocaleString()} reserved on pending orders
                  </>
                )}
              </p>
            </>
          )}
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-medium uppercase text-emerald-600">
            {distributionDisplay.isFiltered ? 'At Outlets — received vs live' : 'At Outlets'}
          </p>
          {distributionDisplay.isFiltered ? (
            <>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs font-medium text-emerald-700">Received (range)</p>
                  <p className="text-xl font-bold tabular-nums text-emerald-900">{distributionDisplay.totalOutletReceivedPeriod.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-emerald-700">On hand now</p>
                  <p className="text-xl font-bold tabular-nums text-emerald-900">{distributionDisplay.totalOutletOnHandNow.toLocaleString()}</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-emerald-600">
                {distributionDisplay.outletInventory.length} outlets
                {distributionDisplay.totalAwaitingReceipt > 0
                  ? ` · ${distributionDisplay.totalAwaitingReceipt.toLocaleString()} in transit (filtered orders)`
                  : ''}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-2xl font-bold text-emerald-900">{distributionDisplay.totalOutletOnHandNow.toLocaleString()}</p>
              <p className="mt-1 text-xs text-emerald-600">
                {distributionDisplay.outletInventory.length} outlets · on-hand updates when receipt is confirmed
                {distributionDisplay.totalAwaitingReceipt > 0
                  ? ` · ${distributionDisplay.totalAwaitingReceipt.toLocaleString()} dispatched, awaiting outlet receipt`
                  : ''}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Outlet Inventory Breakdown */}
      {outlets.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Outlet Stock Levels</h3>
          <p className="mb-4 text-xs text-gray-500">
            {distributionDisplay.isFiltered ? (
              <>
                Pending and in-transit lines follow filtered supply orders. The large figure is{' '}
                <strong className="font-medium text-gray-700">units received</strong> with receipt date in range.{' '}
                <strong className="font-medium text-gray-700">On hand now</strong> is live inventory.
              </>
            ) : (
              <>
              On-hand totals update when the outlet <strong className="font-medium text-gray-700">confirms receipt</strong>.
              Dispatch removes stock from the hub; outlet inventory increases only after receive. Large number is physical on hand;
              smaller line is <strong className="font-medium text-gray-700">available to sell</strong> (after transfers/supply reservations).
            </>
            )}
          </p>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {distributionDisplay.outletInventory.map((inv) => (
              <div key={inv.outletId} className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-700">{inv.outletName}</span>
                  <span className="text-lg font-bold text-gray-900">{inv.onHand.toLocaleString()}</span>
                </div>
                <p className="text-[11px] leading-snug text-gray-600">
                  Available to sell (after reservations):{' '}
                  <span className="font-semibold tabular-nums text-gray-800">
                    {inv.availableSellable.toLocaleString()}
                  </span>
                </p>
                <p className="text-xs text-gray-500">
                  {distributionDisplay.isFiltered ? (
                    <>
                      Received in range
                      {inv.currentOnHandSnapshot != null && (
                        <span className="mt-0.5 block text-gray-600">
                          On hand now:{' '}
                          <span className="font-semibold tabular-nums text-gray-800">{inv.currentOnHandSnapshot.toLocaleString()}</span>
                        </span>
                      )}
                    </>
                  ) : (
                    <>On hand at outlet</>
                  )}
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
                              Manage <ChevronRight size={14} />
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

          {tab === 'transfers' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Transfer #</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">From</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">To</th>
                    <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Qty</th>
                    <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Dispatch</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Received</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredTransfers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-6 py-12 text-center">
                        <ArrowLeftRight className="mx-auto mb-3 text-gray-300" size={40} />
                        <p className="text-gray-400">No outlet transfers yet</p>
                      </td>
                    </tr>
                  ) : (
                    filteredTransfers.map((tx) => (
                      <tr key={tx.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{tx.transfer_number}</td>
                        <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{tx.from_outlet?.name ?? '—'}</td>
                        <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{tx.to_outlet?.name ?? '—'}</td>
                        <td className="px-4 md:px-6 py-4 text-right font-semibold text-gray-900 text-xs sm:text-sm">
                          {Number(tx.total_quantity).toLocaleString()}
                        </td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">
                          {tx.dispatch_date ? formatSupplyCalendarDate(tx.dispatch_date) : '—'}
                        </td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">
                          {tx.received_date ? formatSupplyCalendarDate(tx.received_date) : '—'}
                        </td>
                        <td className="px-4 md:px-6 py-4">
                          <StatusBadge status={tx.status} />
                        </td>
                        <td className="px-4 md:px-6 py-4">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setViewTransfer(tx)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                            >
                              Manage <ChevronRight size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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
      {showNewRMSO && (
        <NewRawMaterialSupplyModal
          outlets={outlets}
          hubRmLines={hubRmLines}
          onClose={() => setShowNewRMSO(false)}
          onSave={async () => {
            await loadAll({ silent: true });
            setShowNewRMSO(false);
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
      {showNewTransfer && (
        <NewOutletTransferModal
          outlets={outlets}
          onClose={() => setShowNewTransfer(false)}
          onSave={async () => {
            await loadAll({ silent: true });
            setShowNewTransfer(false);
          }}
        />
      )}
      {viewTransfer && (
        <TransferDetailModal
          transfer={viewTransfer}
          onClose={() => setViewTransfer(null)}
          onStatusChange={async () => {
            await loadAll({ silent: true });
            setViewTransfer(null);
          }}
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
