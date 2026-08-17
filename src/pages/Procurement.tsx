import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, PackagePlus, AlertCircle, ChevronRight, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DateFilter } from '../components/DateFilter';
import { Button, PageHeader, Tabs } from '../components/ui';
import { supabase } from '../utils/supabase';
import { writeLedgerEntry } from '../utils/ledger';
import { validateSupplier, validateRawMaterial, validatePurchaseOrder, validatePurchaseOrderItem, validatePoLinesAgainstSupplierCatalog, formatValidationErrors } from '../utils/validation';
import { retryWithBackoff } from '../utils/errorHandling';
import { isCalendarDateInRange, type DateRange } from '../utils/dateRange';
import { useAuth } from '../utils/auth';
import type { Supplier, RawMaterial, PurchaseOrder, PurchaseOrderItem } from '../types';

type Tab = 'orders' | 'suppliers' | 'materials';

interface SupplierScoreRow {
  supplier_id: string;
  supplier_name: string;
  completed_orders: number | null;
  otif_rate: number | string | null;
  avg_fill_rate: number | string | null;
}

// ---- Helpers ----
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    ordered: 'bg-blue-100 text-blue-700',
    partial: 'bg-amber-100 text-amber-700',
    received: 'bg-emerald-100 text-emerald-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status}
    </span>
  );
}

function nextOrderNumber(existing: string[]): string {
  const nums = existing.map((n) => parseInt(n.replace('PO-', ''), 10)).filter(Boolean);
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `PO-${String(max + 1).padStart(4, '0')}`;
}

function dateInputFromIso(value: string | undefined): string {
  if (!value) return '';
  const s = String(value).trim();
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// ---- Supplier Modal ----
function SupplierModal({
  supplier,
  allMaterials,
  initialLinkedMaterialIds,
  onClose,
  onSave,
  onDelete,
}: {
  supplier: Supplier | null;
  allMaterials: RawMaterial[];
  /** Raw material IDs this supplier already supplies — must stay in sync when parent loads links. */
  initialLinkedMaterialIds: string[];
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => Promise<boolean>;
}) {
  const blank = { name: '', contact_person: '', email: '', phone: '', address: '', city: '', country: '', payment_terms: '' };
  const [form, setForm] = useState(supplier ? {
    name: supplier.name,
    contact_person: supplier.contact_person ?? '',
    email: supplier.email ?? '',
    phone: supplier.phone ?? '',
    address: supplier.address ?? '',
    city: supplier.city ?? '',
    country: supplier.country ?? '',
    payment_terms: supplier.payment_terms ?? '',
  } : blank);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<Set<string>>(() => new Set(initialLinkedMaterialIds));

  useEffect(() => {
    setSelectedMaterialIds(new Set(initialLinkedMaterialIds));
  }, [supplier?.id, initialLinkedMaterialIds]);

  function toggleMaterialLink(id: string) {
    setSelectedMaterialIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sortedMaterials = useMemo(
    () => [...allMaterials].sort((a, b) => a.name.localeCompare(b.name)),
    [allMaterials]
  );

  async function handleSave() {
    // Validate using validation utilities
    const validation = validateSupplier(form);
    if (!validation.isValid) {
      setError(formatValidationErrors(validation.errors));
      return;
    }

    setSaving(true);
    const payload = { ...form };
    let createdSupplierId = supplier?.id ?? '';
    let err: { message: string } | null = null;

    try {
      if (supplier) {
        const { error } = await retryWithBackoff(async () => await
          supabase.from('suppliers').update(payload).eq('id', supplier.id)
        );
        err = error;
      } else {
        const { data, error } = await retryWithBackoff(async () => await
          supabase.from('suppliers').insert(payload).select('id').single()
        );
        err = error;
        createdSupplierId = data?.id ?? '';
      }

      if (err) {
        setError(err.message);
        setSaving(false);
        return;
      }

      await writeLedgerEntry({
        action: supplier ? 'updated' : 'created',
        entityType: 'supplier',
        entityId: createdSupplierId,
        module: 'procurement',
        operation: supplier ? 'update' : 'insert',
        afterData: form,
        metadata: { entity_label: form.name },
      });

      const { error: delLinkErr } = await retryWithBackoff(
        async () => await supabase.from('supplier_raw_materials').delete().eq('supplier_id', createdSupplierId)
      );
      if (delLinkErr) {
        setError(delLinkErr.message);
        setSaving(false);
        return;
      }

      const linkRows = Array.from(selectedMaterialIds).map((raw_material_id) => ({
        supplier_id: createdSupplierId,
        raw_material_id,
      }));
      if (linkRows.length > 0) {
        const { error: insLinkErr } = await retryWithBackoff(
          async () => await supabase.from('supplier_raw_materials').insert(linkRows)
        );
        if (insLinkErr) {
          setError(insLinkErr.message);
          setSaving(false);
          return;
        }
      }

      setSaving(false);
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save supplier');
      setSaving(false);
    }
  }

  const field = (label: string, key: keyof typeof form, type = 'text') => (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );

  return (
    <Modal isOpen onClose={onClose} title={supplier ? 'Edit Supplier' : 'Add Supplier'} size="xl">
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        {field('Supplier Name *', 'name')}
        {field('Contact Person', 'contact_person')}
        {field('Email', 'email', 'email')}
        {field('Phone', 'phone')}
        {field('Address', 'address')}
        {field('City', 'city')}
        {field('Country', 'country')}
        {field('Payment Terms', 'payment_terms')}
        <div className="sm:col-span-2">
          <label className="mb-2 block text-sm font-medium text-gray-700">Raw materials this supplier sells</label>
          <p className="mb-2 text-xs text-gray-500">
            Only checked materials appear when creating a purchase order for this supplier.
          </p>
          <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50/60 p-3">
            {sortedMaterials.length === 0 ? (
              <p className="text-sm text-gray-400">No raw materials defined yet — add them under Raw Materials.</p>
            ) : (
              sortedMaterials.map((m) => (
                <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-white">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300"
                    checked={selectedMaterialIds.has(m.id)}
                    onChange={() => toggleMaterialLink(m.id)}
                  />
                  <span>
                    <span className="font-medium text-gray-900">{m.name}</span>{' '}
                    <span className="text-gray-500">({m.unit_of_measure})</span>
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          {supplier && onDelete && (
            <button
              type="button"
              disabled={saving || deleting}
              onClick={async () => {
                setDeleting(true);
                try {
                  const ok = await onDelete();
                  if (ok) onClose();
                } finally {
                  setDeleting(false);
                }
              }}
              className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
            >
              {deleting ? 'Deleting…' : 'Delete supplier'}
            </button>
          )}
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || deleting} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Raw Material Modal ----
function MaterialModal({
  material,
  onClose,
  onSave,
  onDelete,
}: {
  material: RawMaterial | null;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => Promise<boolean>;
}) {
  const [form, setForm] = useState({
    name: material?.name ?? '',
    description: material?.description ?? '',
    unit_of_measure: material?.unit_of_measure ?? '',
    cost_price: material?.cost_price?.toString() ?? '',
    reorder_level: material?.reorder_level?.toString() ?? '10',
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    // Validate using validation utilities
    const validation = validateRawMaterial(form);
    if (!validation.isValid) {
      setError(formatValidationErrors(validation.errors));
      return;
    }

    setSaving(true);
    const payload = {
      name: form.name,
      description: form.description || null,
      unit_of_measure: form.unit_of_measure,
      cost_price: parseFloat(form.cost_price) || null,
      reorder_level: parseFloat(form.reorder_level) || 10,
    };
    let createdMaterialId = material?.id ?? '';
    let err: { message: string } | null = null;

    try {
      if (material) {
        const { error } = await retryWithBackoff(async () => await
          supabase.from('raw_materials').update(payload).eq('id', material.id)
        );
        err = error;
      } else {
        const { data, error } = await retryWithBackoff(async () => await
          supabase.from('raw_materials').insert(payload).select('id').single()
        );
        err = error;
        createdMaterialId = data?.id ?? '';
      }

      if (err) {
        setError(err.message);
        setSaving(false);
        return;
      }

      await writeLedgerEntry({
        action: material ? 'updated' : 'created',
        entityType: 'raw_material',
        entityId: createdMaterialId,
        module: 'procurement',
        operation: material ? 'update' : 'insert',
        afterData: payload,
        metadata: { entity_label: form.name },
      });

      setSaving(false);
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save material');
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={material ? 'Edit Raw Material' : 'Add Raw Material'}>
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Name *</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Unit *</label>
            <input value={form.unit_of_measure} onChange={(e) => setForm({ ...form, unit_of_measure: e.target.value })}
              placeholder="kg, L, pcs…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Cost Price (MYR)</label>
            <input type="number" min="0" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Reorder Level</label>
            <input type="number" min="0" step="0.01" value={form.reorder_level} onChange={(e) => setForm({ ...form, reorder_level: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          {material && onDelete && (
            <button
              type="button"
              disabled={saving || deleting}
              onClick={async () => {
                setDeleting(true);
                try {
                  const ok = await onDelete();
                  if (ok) onClose();
                } finally {
                  setDeleting(false);
                }
              }}
              className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
            >
              {deleting ? 'Deleting…' : 'Delete material'}
            </button>
          )}
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={saving || deleting} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- PO Modal ----
interface POLine {
  raw_material_id: string;
  quantity_ordered: string;
  unit_price: string;
}

type POWithDetails = PurchaseOrder & {
  supplier?: Supplier;
  items?: (PurchaseOrderItem & { material?: RawMaterial })[];
};

function purchaseOrderNeedsStockReversal(po: POWithDetails): boolean {
  return (po.items ?? []).some((i) => (Number(i.quantity_received) || 0) > 0);
}

/** Drafts; or ordered with no receipts (plain DELETE, no RPC). */
function purchaseOrderCanSimpleDelete(po: POWithDetails): boolean {
  const status = String(po.status ?? '').trim().toLowerCase();
  if (status === 'draft') return true;
  if (status !== 'ordered') return false;
  const items = po.items ?? [];
  return items.every((i) => (Number(i.quantity_received) || 0) === 0);
}

/** Use DB RPC: receipt reversal was applied, or status is partial/received (delete after optional no-op reversal). */
function purchaseOrderUseCancelRpc(po: POWithDetails): boolean {
  if (purchaseOrderNeedsStockReversal(po)) return true;
  const st = String(po.status ?? '').trim().toLowerCase();
  return st === 'partial' || st === 'received';
}

/** Row / modal Delete is allowed whenever simple delete or cancel RPC applies. */
function purchaseOrderCanRemove(po: POWithDetails): boolean {
  return purchaseOrderCanSimpleDelete(po) || purchaseOrderUseCancelRpc(po);
}

function rpcCancelPoErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not_authenticated':
      return 'You must be signed in to cancel a purchase order.';
    case 'insufficient_hub_quantity':
      return 'Cannot cancel: hub no longer holds enough quantity to undo receipts (inventory may have been used). Reduce usage or reverse manually before deleting.';
    case 'hub_below_reserved':
      return 'Cannot cancel: reversing receipts would drop hub stock below reserved quantity.';
    case 'cannot_cancel_missing_hub_row':
      return 'Cannot cancel: hub inventory row is missing for a received material.';
    case 'po_not_found':
      return 'This purchase order no longer exists.';
    default:
      return code ? `Could not cancel purchase order (${code}).` : 'Could not cancel purchase order.';
  }
}

function NewPOModal({
  suppliers,
  materials,
  materialsForSupplier,
  existingNumbers,
  existingOrder,
  onClose,
  onSave,
}: {
  suppliers: Supplier[];
  materials: RawMaterial[];
  materialsForSupplier: (supplierId: string) => RawMaterial[];
  existingNumbers: string[];
  /** When set, form updates this draft PO (header + replaced line items). */
  existingOrder?: POWithDetails | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const editing = Boolean(existingOrder);
  const initialLines: POLine[] =
    existingOrder?.items?.length ?
      existingOrder.items.map((i) => ({
        raw_material_id: i.raw_material_id,
        quantity_ordered: String(i.quantity_ordered),
        unit_price: String(i.unit_price),
      }))
    : [{ raw_material_id: '', quantity_ordered: '', unit_price: '' }];

  const [supplier_id, setSupplierId] = useState(existingOrder?.supplier_id ?? '');
  const [order_date, setOrderDate] = useState(
    editing && existingOrder ? dateInputFromIso(existingOrder.order_date) : new Date().toISOString().split('T')[0]
  );
  const [expected_delivery_date, setExpectedDelivery] = useState(
    existingOrder?.expected_delivery_date ? dateInputFromIso(existingOrder.expected_delivery_date) : ''
  );
  const [notes, setNotes] = useState(existingOrder?.notes ?? '');
  const [lines, setLines] = useState<POLine[]>(initialLines);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const total = lines.reduce((acc, l) => acc + (parseFloat(l.quantity_ordered) || 0) * (parseFloat(l.unit_price) || 0), 0);

  const catalogMaterials = supplier_id ? materialsForSupplier(supplier_id) : [];
  const catalogBlocked = Boolean(supplier_id && catalogMaterials.length === 0);

  function addLine() { setLines([...lines, { raw_material_id: '', quantity_ordered: '', unit_price: '' }]); }
  function removeLine(i: number) { setLines(lines.filter((_, idx) => idx !== i)); }
  function updateLine(i: number, key: keyof POLine, val: string) {
    const next = [...lines];
    next[i] = { ...next[i], [key]: val };
    // Auto-fill unit price from material cost_price
    if (key === 'raw_material_id') {
      const mat = materials.find((m) => m.id === val);
      if (mat?.cost_price) next[i].unit_price = mat.cost_price.toString();
    }
    setLines(next);
  }

  async function handleSave() {
    // Validate PO header
    const headerValidation = validatePurchaseOrder({
      supplier_id,
      expected_delivery_date: expected_delivery_date || undefined,
      total_amount: total,
    });

    if (!headerValidation.isValid) {
      setError(formatValidationErrors(headerValidation.errors));
      return;
    }

    // Validate line items
    const validLines = lines.filter((l) => l.raw_material_id && parseFloat(l.quantity_ordered) > 0 && parseFloat(l.unit_price) >= 0);

    if (validLines.length === 0) {
      setError('Add at least one valid line item');
      return;
    }

    // Validate each line item
    for (const line of validLines) {
      const lineValidation = validatePurchaseOrderItem({
        raw_material_id: line.raw_material_id,
        quantity_ordered: parseFloat(line.quantity_ordered),
        unit_price: parseFloat(line.unit_price),
        quantity_received: 0,
      });

      if (!lineValidation.isValid) {
        setError(`Line item error: ${formatValidationErrors(lineValidation.errors)}`);
        return;
      }
    }

    const allowedIds = new Set(catalogMaterials.map((m) => m.id));
    const catalogValidation = validatePoLinesAgainstSupplierCatalog(
      validLines.map((l) => ({ raw_material_id: l.raw_material_id })),
      allowedIds
    );
    if (!catalogValidation.isValid) {
      setError(formatValidationErrors(catalogValidation.errors));
      return;
    }

    setSaving(true);

    try {
      const buildItems = (purchaseOrderId: string) =>
        validLines.map((l) => {
          const qty = parseFloat(l.quantity_ordered);
          const price = parseFloat(l.unit_price);
          return {
            purchase_order_id: purchaseOrderId,
            raw_material_id: l.raw_material_id,
            quantity_ordered: qty,
            quantity_ordered_base: qty,
            quantity_received: 0,
            unit_price: price,
            line_total: qty * price,
          };
        });

      if (editing && existingOrder) {
        if (existingOrder.status !== 'draft') {
          setError('Only draft orders can be edited.');
          setSaving(false);
          return;
        }

        const { error: updErr } = await retryWithBackoff(async () =>
          await supabase
            .from('purchase_orders')
            .update({
              supplier_id,
              order_date,
              expected_delivery_date: expected_delivery_date || null,
              notes: notes || null,
              total_amount: total,
            })
            .eq('id', existingOrder.id)
        );

        if (updErr) {
          setError(updErr.message);
          setSaving(false);
          return;
        }

        const { error: delErr } = await retryWithBackoff(async () =>
          await supabase.from('purchase_order_items').delete().eq('purchase_order_id', existingOrder.id)
        );

        if (delErr) {
          setError(delErr.message);
          setSaving(false);
          return;
        }

        const items = buildItems(existingOrder.id);
        const { error: itemErr } = await retryWithBackoff(async () => await supabase.from('purchase_order_items').insert(items));

        if (itemErr) {
          setError(itemErr.message);
          setSaving(false);
          return;
        }

        await writeLedgerEntry({
          action: 'updated',
          entityType: 'purchase_order',
          entityId: existingOrder.id,
          module: 'procurement',
          operation: 'update',
          afterData: {
            order_number: existingOrder.order_number,
            supplier_id,
            total_amount: total,
            item_count: items.length,
          },
          metadata: { entity_label: existingOrder.order_number },
        });

        onSave();
        return;
      }

      const order_number = nextOrderNumber(existingNumbers);
      const { data: po, error: poErr } = await retryWithBackoff(async () => await
        supabase
          .from('purchase_orders')
          .insert({
            order_number,
            supplier_id,
            order_date,
            expected_delivery_date: expected_delivery_date || null,
            notes: notes || null,
            status: 'draft',
            total_amount: total,
          })
          .select()
          .single()
      );

      if (poErr || !po) {
        setError(poErr?.message ?? 'Failed to create order');
        setSaving(false);
        return;
      }

      const items = buildItems(po.id);

      const { error: itemErr } = await retryWithBackoff(async () => await
        supabase.from('purchase_order_items').insert(items)
      );

      if (itemErr) {
        setError(itemErr.message);
        setSaving(false);
        return;
      }

      await writeLedgerEntry({
        action: 'created',
        entityType: 'purchase_order',
        entityId: po.id,
        module: 'procurement',
        operation: 'insert',
        afterData: {
          order_number,
          supplier_id,
          status: 'draft',
          total_amount: total,
          item_count: items.length,
        },
        metadata: { entity_label: order_number },
      });

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save purchase order');
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing && existingOrder ? `Edit Purchase Order · ${existingOrder.order_number}` : 'New Purchase Order'}
      size="xl"
    >
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="space-y-5">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-gray-700">Supplier *</label>
            <select
              value={supplier_id}
              onChange={(e) => {
                const next = e.target.value;
                setSupplierId(next);
                setLines((prev) =>
                  prev.map((line) => {
                    if (!next) return { ...line, raw_material_id: '', unit_price: '' };
                    const allowed = new Set(materialsForSupplier(next).map((m) => m.id));
                    if (line.raw_material_id && !allowed.has(line.raw_material_id))
                      return { ...line, raw_material_id: '', unit_price: '' };
                    return line;
                  }),
                );
              }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Select supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {supplier_id ? (
              catalogMaterials.length === 0 ? (
                <p className="mt-2 text-xs text-amber-800">
                  No linked materials for this supplier. Use Purchase Orders → Suppliers → Manage supplier and tick raw materials before ordering.
                </p>
              ) : (
                <p className="mt-2 text-xs text-gray-500">
                  {catalogMaterials.length} material{catalogMaterials.length !== 1 ? 's' : ''} linked to this supplier.
                </p>
              )
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Order Date</label>
            <input type="date" value={order_date} onChange={(e) => setOrderDate(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Expected Delivery</label>
            <input type="date" value={expected_delivery_date} onChange={(e) => setExpectedDelivery(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Line Items</h3>
            <button onClick={addLine} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800">
              <Plus size={14} /> Add Line
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-700">Material</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-700">Qty</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-700">Unit Price (MYR)</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-700">Total</th>
                  <th className="w-8 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2">
                      <select
                        value={line.raw_material_id}
                        onChange={(e) => updateLine(i, 'raw_material_id', e.target.value)}
                        disabled={!supplier_id}
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
                      >
                        <option value="">
                          {!supplier_id ? 'Choose supplier first' : catalogMaterials.length === 0 ? 'No materials linked' : 'Select…'}
                        </option>
                        {catalogMaterials.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({m.unit_of_measure})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" min="0" step="0.01" value={line.quantity_ordered} onChange={(e) => updateLine(i, 'quantity_ordered', e.target.value)}
                        className="w-24 rounded border border-gray-300 px-2 py-1.5 text-right text-sm focus:border-blue-500 focus:outline-none" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" min="0" step="0.01" value={line.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)}
                        className="w-28 rounded border border-gray-300 px-2 py-1.5 text-right text-sm focus:border-blue-500 focus:outline-none" />
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-gray-900">
                      {((parseFloat(line.quantity_ordered) || 0) * (parseFloat(line.unit_price) || 0)).toFixed(2)}
                    </td>
                    <td className="px-2 py-2">
                      <button onClick={() => removeLine(i)} className="text-gray-300 hover:text-red-500 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-gray-200 bg-gray-50">
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-right text-sm font-semibold text-gray-900">Total</td>
                  <td className="px-3 py-2 text-right text-sm font-bold text-gray-900">MYR {total.toFixed(2)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || catalogBlocked}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Order'}
        </button>
      </div>
    </Modal>
  );
}

// ---- PO Detail ----

function PODetailModal({
  po,
  onClose,
  onStatusChange,
  onEdit,
  onDelete,
}: {
  po: POWithDetails;
  onClose: () => void;
  onStatusChange: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(
    Object.fromEntries((po.items ?? []).map((item) => [item.id, item.quantity_received?.toString() ?? '0']))
  );

  async function handleMarkReceived() {
    setSaving(true);
    try {
      let orderedTotal = 0;
      let receivedTotal = 0;
      const updates: Array<{ id: string; qty: number }> = [];

      // First pass: validate all quantities
      for (const item of po.items ?? []) {
        const enteredQty = parseFloat(receivedQtys[item.id] ?? '0');
        const qty = Math.max(0, Math.min(item.quantity_ordered, Number.isFinite(enteredQty) ? enteredQty : 0));

        // Validate: quantity received cannot exceed quantity ordered
        if (qty > item.quantity_ordered) {
          setError(`Item ${item.material?.name ?? 'Unknown'}: quantity received exceeds quantity ordered`);
          setSaving(false);
          return;
        }

        orderedTotal += item.quantity_ordered;
        receivedTotal += qty;
        updates.push({ id: item.id, qty });
      }

      if (receivedTotal === 0) {
        setError('At least one item must be marked as received');
        setSaving(false);
        return;
      }

      const payload = updates.map((u) => ({
        purchase_order_item_id: u.id,
        quantity_received: u.qty,
      }));

      const nextStatus =
        receivedTotal <= 0 ? 'ordered' : receivedTotal < orderedTotal ? 'partial' : 'received';

      const { data: rpcData, error: rpcErr } = await retryWithBackoff(async () =>
        supabase.rpc('receive_po_shipment', {
          p_po_id: po.id,
          p_lines: payload,
        })
      );

      if (rpcErr) {
        throw rpcErr;
      }

      const rpcResult = rpcData as { success?: boolean; error?: string } | null;
      if (rpcResult && rpcResult.success === false) {
        setError(rpcResult.error ?? 'Receive shipment failed');
        setSaving(false);
        return;
      }

      await writeLedgerEntry({
        action: nextStatus === 'received' ? 'received' : 'updated',
        entityType: 'purchase_order',
        entityId: po.id,
        module: 'procurement',
        operation: 'update',
        afterData: {
          rpc: 'receive_po_shipment',
          lines: payload,
        },
        metadata: { entity_label: po.order_number },
      });

      setSaving(false);
      onStatusChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark received');
      setSaving(false);
    }
  }

  async function changeStatus(status: string) {
    setSaving(true);
    try {
      await retryWithBackoff(async () => await
        supabase.from('purchase_orders').update({ status }).eq('id', po.id)
      );

      await writeLedgerEntry({
        action: 'updated',
        entityType: 'purchase_order',
        entityId: po.id,
        module: 'procurement',
        operation: 'update',
        afterData: { status },
        metadata: { entity_label: po.order_number },
      });

      setSaving(false);
      onStatusChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Purchase Order: ${po.order_number}`} size="xl">
      {error && (
        <div className="mb-4 flex items-start gap-3 rounded-lg bg-red-50 p-3">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0 text-red-600" />
          <div>
            <p className="text-sm font-medium text-red-900">Error</p>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        </div>
      )}
      <div className="space-y-5">
        <div className="grid gap-4 rounded-lg bg-gray-50 p-4 grid-cols-1 sm:grid-cols-3">
          <div><p className="text-xs text-gray-500">Supplier</p><p className="font-semibold text-gray-900">{po.supplier?.name ?? '—'}</p></div>
          <div><p className="text-xs text-gray-500">Status</p><StatusBadge status={po.status} /></div>
          <div><p className="text-xs text-gray-500">Order Date</p><p className="font-semibold text-gray-900">{new Date(po.order_date).toLocaleDateString()}</p></div>
          <div><p className="text-xs text-gray-500">Expected Delivery</p><p className="font-semibold text-gray-900">{po.expected_delivery_date ? new Date(po.expected_delivery_date).toLocaleDateString() : '—'}</p></div>
          <div><p className="text-xs text-gray-500">Total Amount</p><p className="font-semibold text-gray-900">MYR {po.total_amount?.toFixed(2) ?? '0.00'}</p></div>
          {po.notes && <div className="sm:col-span-3"><p className="text-xs text-gray-500">Notes</p><p className="text-sm text-gray-900">{po.notes}</p></div>}
        </div>

        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-semibold text-gray-700">Material</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-700">Ordered</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-700">Received</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-700">Unit Price</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-700">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(po.items ?? []).map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-2 font-medium text-gray-900">{item.material?.name ?? '—'}<span className="ml-1 text-xs text-gray-400">({item.material?.unit_of_measure})</span></td>
                  <td className="px-4 py-2 text-right text-gray-700">{item.quantity_ordered}</td>
                  <td className="px-4 py-2 text-right">
                    {po.status !== 'received' ? (
                      <input type="number" min="0" max={item.quantity_ordered} step="0.01"
                        value={receivedQtys[item.id] ?? '0'}
                        onChange={(e) => setReceivedQtys({ ...receivedQtys, [item.id]: e.target.value })}
                        className="w-20 rounded border border-gray-300 px-2 py-1 text-right text-sm focus:border-blue-500 focus:outline-none" />
                    ) : (
                      <span>{item.quantity_received}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700">MYR {item.unit_price.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-medium text-gray-900">MYR {(item.line_total ?? item.quantity_ordered * item.unit_price).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {po.status === 'draft' && (
            <button type="button" onClick={() => changeStatus('ordered')} disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
              Mark as Ordered
            </button>
          )}
          {(po.status === 'ordered' || po.status === 'partial') && (
            <button type="button" onClick={handleMarkReceived} disabled={saving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
              {saving ? 'Processing…' : 'Mark Received & Update Stock'}
            </button>
          )}
          {po.status === 'draft' && onEdit && (
            <button type="button" onClick={onEdit} disabled={saving}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors">
              Edit order
            </button>
          )}
          {purchaseOrderCanRemove(po) && onDelete && (
            <button type="button" onClick={onDelete} disabled={saving}
              className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors">
              {purchaseOrderUseCancelRpc(po) ? 'Cancel & delete order' : 'Delete order'}
            </button>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Close</button>
      </div>
    </Modal>
  );
}

// ---- Main Procurement Page ----
export function Procurement() {
  const { isAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab: Tab =
    tabParam === 'suppliers' || tabParam === 'materials' || tabParam === 'orders' ? tabParam : 'orders';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierScores, setSupplierScores] = useState<SupplierScoreRow[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [supplierMaterialLinks, setSupplierMaterialLinks] = useState<Array<{ supplier_id: string; raw_material_id: string }>>(
    []
  );
  const [orders, setOrders] = useState<POWithDetails[]>([]);
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [showNewPO, setShowNewPO] = useState(false);
  const [editPO, setEditPO] = useState<POWithDetails | null>(null);
  const [viewPO, setViewPO] = useState<POWithDetails | null>(null);
  const [editSupplier, setEditSupplier] = useState<Supplier | null | 'new'>('new' as never);
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [editMaterial, setEditMaterial] = useState<RawMaterial | null | 'new'>('new' as never);
  const [showMaterialModal, setShowMaterialModal] = useState(false);

  const materialsForSupplierCatalog = useMemo(() => {
    const map = new Map<string, RawMaterial[]>();
    for (const l of supplierMaterialLinks) {
      const m = materials.find((x) => x.id === l.raw_material_id);
      if (!m) continue;
      const arr = map.get(l.supplier_id) ?? [];
      if (!arr.some((x) => x.id === m.id)) arr.push(m);
      map.set(l.supplier_id, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return (supplierId: string) => map.get(supplierId) ?? [];
  }, [supplierMaterialLinks, materials]);

  const supplierModalInitialLinkedMaterialIds = useMemo(() => {
    if (!editSupplier || typeof editSupplier !== 'object') return [];
    return supplierMaterialLinks
      .filter((l) => l.supplier_id === editSupplier.id)
      .map((l) => l.raw_material_id);
  }, [editSupplier, supplierMaterialLinks]);

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'suppliers' || t === 'materials' || t === 'orders') {
      setTab(t);
    }
  }, [searchParams]);

  function selectTab(next: Tab) {
    setTab(next);
    setSearchParams(next === 'orders' ? {} : { tab: next }, { replace: true });
  }

  async function loadAll() {
    setLoading(true);
    const [{ data: sups }, { data: mats }, { data: pos }, { data: links }, { data: scores }] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('raw_materials').select('*').order('name'),
      supabase
        .from('purchase_orders')
        .select(`*, supplier:supplier_id(*), items:purchase_order_items(*, material:raw_material_id(*))`)
        .order('created_at', { ascending: false }),
      supabase.from('supplier_raw_materials').select('supplier_id, raw_material_id'),
      supabase.from('supplier_scorecard_metrics').select('*').order('supplier_name'),
    ]);
    setSuppliers(sups ?? []);
    setSupplierScores((scores ?? []) as SupplierScoreRow[]);
    setMaterials(mats ?? []);
    setSupplierMaterialLinks(links ?? []);
    setOrders(pos as POWithDetails[] ?? []);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  async function deleteSupplier(id: string): Promise<boolean> {
    if (!confirm('Delete this supplier?')) return false;
    const s = suppliers.find((x) => x.id === id);
    const { error } = await supabase.from('suppliers').delete().eq('id', id);
    if (error) {
      alert(error.message);
      return false;
    }
    await writeLedgerEntry({
      action: 'deleted',
      entityType: 'supplier',
      entityId: id,
      module: 'procurement',
      operation: 'delete',
      beforeData: s ? { name: s.name } : {},
      metadata: { entity_label: s?.name ?? id },
    });
    await loadAll();
    return true;
  }

  async function deleteMaterial(id: string): Promise<boolean> {
    if (!confirm('Delete this raw material?')) return false;
    const m = materials.find((x) => x.id === id);
    const { error } = await supabase.from('raw_materials').delete().eq('id', id);
    if (error) {
      alert(error.message);
      return false;
    }
    await writeLedgerEntry({
      action: 'deleted',
      entityType: 'raw_material',
      entityId: id,
      module: 'procurement',
      operation: 'delete',
      beforeData: m ? { name: m.name } : {},
      metadata: { entity_label: m?.name ?? id },
    });
    await loadAll();
    return true;
  }

  async function deletePurchaseOrder(po: POWithDetails) {
    if (!purchaseOrderCanRemove(po)) {
      alert('This purchase order cannot be removed in its current state.');
      return;
    }

    if (purchaseOrderUseCancelRpc(po)) {
      const lines = po.items ?? [];
      const qty = lines.reduce((a, i) => a + (Number(i.quantity_received) || 0), 0);
      const hint =
        qty > 0
          ? ' Received quantities will be deducted from hub inventory and weighted-average raw material costs will be adjusted.'
          : '';
      if (
        !confirm(
          `Cancel and permanently delete purchase order ${po.order_number}?${hint} You cannot undo this.`
        )
      )
        return;

      type CancelPoResult = { success?: boolean; error?: string; reversal_lines?: unknown };
      let rpcPayload: CancelPoResult | null = null;
      const { data: rpcRaw, error: rpcErr } = await retryWithBackoff(async () =>
        supabase.rpc('cancel_purchase_order', { p_po_id: po.id })
      );

      if (rpcErr) {
        alert(rpcErr.message);
        return;
      }

      if (rpcRaw != null && typeof rpcRaw === 'object' && !Array.isArray(rpcRaw)) {
        rpcPayload = rpcRaw as CancelPoResult;
      }

      if (rpcPayload?.success !== true) {
        alert(rpcCancelPoErrorMessage(rpcPayload?.error));
        return;
      }

      if (viewPO?.id === po.id) setViewPO(null);
      if (editPO?.id === po.id) setEditPO(null);
      loadAll();
      return;
    }

    if (!purchaseOrderCanSimpleDelete(po)) return;

    const isDraft = String(po.status ?? '').trim().toLowerCase() === 'draft';
    const message = isDraft
      ? `Delete draft purchase order ${po.order_number}? You cannot undo this.`
      : `Delete purchase order ${po.order_number}? It has not received any stock yet. You cannot undo this.`;
    if (!confirm(message)) return;

    const { error } = await retryWithBackoff(async () => await supabase.from('purchase_orders').delete().eq('id', po.id));

    if (error) {
      alert(error.message);
      return;
    }

    await writeLedgerEntry({
      action: 'deleted',
      entityType: 'purchase_order',
      entityId: po.id,
      module: 'procurement',
      operation: 'delete',
      beforeData: { order_number: po.order_number, status: po.status },
      metadata: { entity_label: po.order_number },
    });

    if (viewPO?.id === po.id) setViewPO(null);
    if (editPO?.id === po.id) setEditPO(null);
    loadAll();
  }

  const filteredOrders = useMemo(() => {
    let list = orders.filter(
      (o) =>
        o.order_number.toLowerCase().includes(search.toLowerCase()) ||
        (o.supplier as Supplier | null)?.name.toLowerCase().includes(search.toLowerCase())
    );
    if (dateRange) {
      list = list.filter((o) => isCalendarDateInRange(o.order_date, dateRange));
    }
    return list;
  }, [orders, search, dateRange]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Procurement"
        description="Manage suppliers, raw materials and purchase orders"
        actions={
          <>
            {tab === 'orders' && (
              <Button onClick={() => setShowNewPO(true)}>
                <Plus size={16} /> New Order
              </Button>
            )}
            {tab === 'suppliers' && (
              <Button
                onClick={() => {
                  setEditSupplier(null);
                  setShowSupplierModal(true);
                }}
              >
                <Plus size={16} /> Add Supplier
              </Button>
            )}
            {tab === 'materials' && (
              <Button
                onClick={() => {
                  setEditMaterial(null);
                  setShowMaterialModal(true);
                }}
              >
                <Plus size={16} /> Add Material
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <Tabs
          value={tab}
          onChange={selectTab}
          items={[
            { id: 'orders', label: 'Purchase Orders' },
            { id: 'suppliers', label: 'Suppliers' },
            { id: 'materials', label: 'Raw Materials' },
          ]}
        />
        {tab === 'orders' && (
          <DateFilter
            onFilterChange={(range) => setDateRange(range)}
            hint="Filters purchase orders by order date."
          />
        )}
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center text-gray-400 text-sm">Loading…</div>
      ) : (
        <>
          {/* Purchase Orders Tab */}
          {tab === 'orders' && (
            <div className="space-y-4">
              <div className="relative max-w-sm">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search orders…"
                  className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50">
                    <tr>
                      <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Order #</th>
                      <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Supplier</th>
                      <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Date</th>
                      <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Amount</th>
                      <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
                      <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Items</th>
                      <th className="whitespace-nowrap px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredOrders.length === 0 ? (
                      <tr><td colSpan={7} className="px-6 py-12 text-center text-gray-400">No purchase orders found</td></tr>
                    ) : (
                      filteredOrders.map((order) => (
                        <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{order.order_number}</td>
                          <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{(order.supplier as Supplier | null)?.name ?? '—'}</td>
                          <td className="px-4 md:px-6 py-4 text-gray-500 text-xs sm:text-sm">{new Date(order.order_date).toLocaleDateString()}</td>
                          <td className="px-4 md:px-6 py-4 text-right font-medium text-gray-900 text-xs sm:text-sm">MYR {order.total_amount?.toFixed(2) ?? '0.00'}</td>
                          <td className="px-4 md:px-6 py-4"><StatusBadge status={order.status} /></td>
                          <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs sm:text-sm">{(order.items ?? []).length} line(s)</td>
                          <td className="whitespace-nowrap px-4 md:px-6 py-4 text-right">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setViewPO(order)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                              >
                                Manage <ChevronRight size={14} aria-hidden />
                              </button>
                              {isAdmin && purchaseOrderCanRemove(order) && (
                                <button
                                  type="button"
                                  onClick={() => deletePurchaseOrder(order)}
                                  className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800"
                                  title={
                                    purchaseOrderUseCancelRpc(order)
                                      ? 'Cancel purchase order and reverse hub receipts (admin)'
                                      : 'Delete purchase order (admin)'
                                  }
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
            </div>
          )}

          {/* Suppliers Tab */}
          {tab === 'suppliers' && (
            <div className="space-y-6">
              {supplierScores.filter((s) => (s.completed_orders ?? 0) > 0).length > 0 && (
                <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-5 shadow-sm">
                  <h2 className="mb-1 text-sm font-semibold text-gray-900">Supplier performance</h2>
                  <p className="mb-4 text-xs text-gray-600">
                    OTIF and fill-rate from completed or partial purchase order history.
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-200 bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-gray-700">Supplier</th>
                          <th className="px-4 py-3 text-right font-semibold text-gray-700">Completed POs</th>
                          <th className="px-4 py-3 text-right font-semibold text-gray-700">OTIF rate</th>
                          <th className="px-4 py-3 text-right font-semibold text-gray-700">Avg fill rate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {supplierScores
                          .filter((s) => (s.completed_orders ?? 0) > 0)
                          .map((s) => {
                            const otif = s.otif_rate != null ? Number(s.otif_rate) : null;
                            const fill = s.avg_fill_rate != null ? Number(s.avg_fill_rate) : null;
                            return (
                              <tr key={s.supplier_id} className="hover:bg-gray-50/80">
                                <td className="px-4 py-3 font-medium text-gray-900">{s.supplier_name}</td>
                                <td className="px-4 py-3 text-right tabular-nums">{s.completed_orders ?? 0}</td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {otif != null && Number.isFinite(otif) ? `${(otif * 100).toFixed(0)}%` : '—'}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums">
                                  {fill != null && Number.isFinite(fill) ? `${(fill * 100).toFixed(0)}%` : '—'}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Name</th>
                    <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Contact</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Email</th>
                    <th className="hidden lg:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Phone</th>
                    <th className="hidden xl:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Payment Terms</th>
                    <th className="whitespace-nowrap px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {suppliers.length === 0 ? (
                    <tr><td colSpan={6} className="px-6 py-12 text-center text-gray-400">No suppliers yet</td></tr>
                  ) : (
                    suppliers.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-sm">{s.name}</td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-gray-600 text-xs sm:text-sm">{s.contact_person ?? '—'}</td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-600 text-xs sm:text-sm">{s.email ?? '—'}</td>
                        <td className="hidden lg:table-cell px-4 md:px-6 py-4 text-gray-600 text-xs sm:text-sm">{s.phone ?? '—'}</td>
                        <td className="hidden xl:table-cell px-4 md:px-6 py-4 text-gray-600 text-xs sm:text-sm">{s.payment_terms ?? '—'}</td>
                        <td className="whitespace-nowrap px-4 md:px-6 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setEditSupplier(s);
                              setShowSupplierModal(true);
                            }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                          >
                            Manage <ChevronRight size={14} aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            </div>
          )}

          {/* Raw Materials Tab */}
          {tab === 'materials' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Name</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Unit</th>
                    <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Cost Price</th>
                    <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Reorder</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Description</th>
                    <th className="whitespace-nowrap px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {materials.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 md:px-6 py-12 text-center">
                        <PackagePlus className="mx-auto mb-3 text-gray-300" size={40} />
                        <p className="text-gray-400">No raw materials yet</p>
                      </td>
                    </tr>
                  ) : (
                    materials.map((m) => (
                      <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-sm">{m.name}</td>
                        <td className="px-4 md:px-6 py-4 text-gray-600 text-xs sm:text-sm">{m.unit_of_measure}</td>
                        <td className="px-4 md:px-6 py-4 text-right text-gray-900 text-xs sm:text-sm">MYR {m.cost_price != null ? m.cost_price.toFixed(2) : '—'}</td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-right text-gray-600 text-xs sm:text-sm">{m.reorder_level ?? 10}</td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs sm:text-sm max-w-xs truncate">{m.description ?? '—'}</td>
                        <td className="whitespace-nowrap px-4 md:px-6 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setEditMaterial(m);
                              setShowMaterialModal(true);
                            }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                          >
                            Manage <ChevronRight size={14} aria-hidden />
                          </button>
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

      {/* Modals */}
      {showNewPO && (
        <NewPOModal
          key="new-po"
          suppliers={suppliers}
          materials={materials}
          materialsForSupplier={materialsForSupplierCatalog}
          existingNumbers={orders.map((o) => o.order_number)}
          onClose={() => setShowNewPO(false)}
          onSave={() => { setShowNewPO(false); loadAll(); }}
        />
      )}
      {editPO && (
        <NewPOModal
          key={editPO.id}
          suppliers={suppliers}
          materials={materials}
          materialsForSupplier={materialsForSupplierCatalog}
          existingNumbers={orders.map((o) => o.order_number)}
          existingOrder={editPO}
          onClose={() => setEditPO(null)}
          onSave={() => { setEditPO(null); loadAll(); }}
        />
      )}
      {viewPO && (
        <PODetailModal
          po={viewPO}
          onClose={() => setViewPO(null)}
          onStatusChange={() => {
            setViewPO(null);
            loadAll();
          }}
          onEdit={() => {
            const p = viewPO;
            setViewPO(null);
            if (p) setEditPO(p);
          }}
          onDelete={() => deletePurchaseOrder(viewPO)}
        />
      )}
      {showSupplierModal && (
        <SupplierModal
          supplier={editSupplier && typeof editSupplier === 'object' ? editSupplier : null}
          allMaterials={materials}
          initialLinkedMaterialIds={supplierModalInitialLinkedMaterialIds}
          onClose={() => setShowSupplierModal(false)}
          onSave={() => { setShowSupplierModal(false); loadAll(); }}
          onDelete={
            typeof editSupplier === 'object' && editSupplier
              ? async () => deleteSupplier(editSupplier.id)
              : undefined
          }
        />
      )}
      {showMaterialModal && (
        <MaterialModal
          material={editMaterial as RawMaterial | null}
          onClose={() => setShowMaterialModal(false)}
          onSave={() => { setShowMaterialModal(false); loadAll(); }}
          onDelete={
            typeof editMaterial === 'object' && editMaterial
              ? async () => deleteMaterial(editMaterial.id)
              : undefined
          }
        />
      )}
    </div>
  );
}
