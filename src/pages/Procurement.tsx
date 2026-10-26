import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, AlertCircle, ChevronRight, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DateFilter } from '../components/DateFilter';
import { EntityChip } from '../components/EntityChip';
import { PoCancelPanel } from '../components/PoCancelPanel';
import { PoCancelRequestsTab, usePoCancelPendingCount } from '../components/PoCancelRequestsTab';
import { Button, EmptyState, ListRow, PageHeader, Tabs } from '../components/ui';
import { supabase } from '../utils/supabase';
import { writeLedgerEntry } from '../utils/ledger';
import { validateSupplier, validateRawMaterial, validatePurchaseOrder, validatePurchaseOrderItem, validatePoLinesAgainstSupplierCatalog, formatValidationErrors } from '../utils/validation';
import { retryWithBackoff } from '../utils/errorHandling';
import { isCalendarDateInRange, type DateRange } from '../utils/dateRange';
import { useAuth } from '../utils/auth';
import { useRegisterRefresh } from '../utils/pageRefresh';
import { DEFAULT_OVER_RECEIPT_TOLERANCE_PCT, planReceipt, rpcLines } from '../utils/poReceipt';
import { extractAtomicRpcErrorCode } from '../utils/atomicRpcErrors';
import { defaultEntityCode, poSelectableSuppliers, purchaseOrderInsertPayload, supplierInsertPayload, type MyEntity } from '../utils/procurementPayloads';
import type { Supplier, RawMaterial, PurchaseOrder, PurchaseOrderItem } from '../types';

type Tab = 'orders' | 'suppliers' | 'materials' | 'cancellations';

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
    draft: 'bg-stone-100 text-stone-700',
    pending_approval: 'bg-violet-100 text-violet-700',
    ordered: 'bg-blue-100 text-blue-700',
    partial: 'bg-amber-100 text-amber-700',
    received: 'bg-emerald-100 text-emerald-700',
    closed_short: 'bg-orange-100 text-orange-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[status] ?? 'bg-stone-100 text-stone-700'}`}>
      {status === 'closed_short' ? 'closed short' : status === 'pending_approval' ? 'pending approval' : status}
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
  isProcurement = false,
  onClose,
  onSave,
  onDelete,
}: {
  supplier: Supplier | null;
  /** procurement users create suppliers as 'pending' (085 RLS); an admin approves */
  isProcurement?: boolean;
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
          supabase.from('suppliers').insert(supplierInsertPayload(payload, isProcurement)).select('id').single()
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
      <label className="mb-1 block text-sm font-medium text-stone-700">{label}</label>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
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
          <label className="mb-2 block text-sm font-medium text-stone-700">Raw materials this supplier sells</label>
          <p className="mb-2 text-xs text-stone-500">
            Only checked materials appear when creating a purchase order for this supplier.
          </p>
          <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/60 p-3">
            {sortedMaterials.length === 0 ? (
              <p className="text-sm text-stone-400">No raw materials defined yet — add them under Raw Materials.</p>
            ) : (
              sortedMaterials.map((m) => (
                <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-white">
                  <input
                    type="checkbox"
                    className="rounded border-stone-300"
                    checked={selectedMaterialIds.has(m.id)}
                    onChange={() => toggleMaterialLink(m.id)}
                  />
                  <span>
                    <span className="font-medium text-stone-900">{m.name}</span>{' '}
                    <span className="text-stone-500">({m.unit_of_measure})</span>
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
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
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
          <label className="mb-1 block text-sm font-medium text-stone-700">Name *</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-stone-700">Description</label>
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
        </div>
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Unit *</label>
            <input value={form.unit_of_measure} onChange={(e) => setForm({ ...form, unit_of_measure: e.target.value })}
              placeholder="kg, L, pcs…"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Cost Price (MYR)</label>
            <input type="number" min="0" step="0.0001" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Reorder Level</label>
            <input type="number" min="0" step="0.0001" value={form.reorder_level} onChange={(e) => setForm({ ...form, reorder_level: e.target.value })}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
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
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
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

function NewPOModal({
  suppliers,
  entities,
  materials,
  materialsForSupplier,
  existingNumbers,
  existingOrder,
  onClose,
  onSave,
}: {
  suppliers: Supplier[];
  /** entities the user may post to (v_my_entities); a PO must carry one */
  entities: MyEntity[];
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
  const [entity_code, setEntityCode] = useState(() => defaultEntityCode(entities, existingOrder?.entity_code));
  useEffect(() => {
    setEntityCode((cur) => defaultEntityCode(entities, cur));
  }, [entities]);
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

    if (!entity_code) {
      setError('Choose the entity (Quackteow / Merdeka House) this order is for.');
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
              entity_code,
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
          .insert(purchaseOrderInsertPayload({
            order_number,
            supplier_id,
            order_date,
            expected_delivery_date: expected_delivery_date || null,
            notes: notes || null,
            total_amount: total,
          }, entity_code))
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
            <label className="mb-1 block text-sm font-medium text-stone-700">Supplier *</label>
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
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
            >
              <option value="">Select supplier…</option>
              {poSelectableSuppliers(suppliers, existingOrder?.supplier_id).map((s) => (
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
                <p className="mt-2 text-xs text-stone-500">
                  {catalogMaterials.length} material{catalogMaterials.length !== 1 ? 's' : ''} linked to this supplier.
                </p>
              )
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Entity *</label>
            <select
              aria-label="Entity"
              value={entity_code}
              onChange={(e) => setEntityCode(e.target.value)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
            >
              <option value="">Select entity…</option>
              {entities.map((x) => (
                <option key={x.code} value={x.code}>{x.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Order Date</label>
            <input type="date" value={order_date} onChange={(e) => setOrderDate(e.target.value)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">Expected Delivery</label>
            <input type="date" value={expected_delivery_date} onChange={(e) => setExpectedDelivery(e.target.value)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-stone-700">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-stone-900">Line Items</h3>
            <button onClick={addLine} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800">
              <Plus size={14} /> Add Line
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-stone-200">
            <table className="w-full text-sm">
              <thead className="border-b border-stone-200 bg-stone-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-stone-700">Material</th>
                  <th className="px-3 py-2 text-right font-semibold text-stone-700">Qty</th>
                  <th className="px-3 py-2 text-right font-semibold text-stone-700">Unit Price (MYR)</th>
                  <th className="px-3 py-2 text-right font-semibold text-stone-700">Total</th>
                  <th className="w-8 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2">
                      <select
                        value={line.raw_material_id}
                        onChange={(e) => updateLine(i, 'raw_material_id', e.target.value)}
                        disabled={!supplier_id}
                        className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-stone-100"
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
                      <input type="number" min="0" step="0.0001" value={line.quantity_ordered} onChange={(e) => updateLine(i, 'quantity_ordered', e.target.value)}
                        className="w-24 rounded border border-stone-300 px-2 py-1.5 text-right text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" min="0" step="0.0001" value={line.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)}
                        className="w-28 rounded border border-stone-300 px-2 py-1.5 text-right text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-stone-900">
                      {((parseFloat(line.quantity_ordered) || 0) * (parseFloat(line.unit_price) || 0)).toFixed(2)}
                    </td>
                    <td className="px-2 py-2">
                      <button onClick={() => removeLine(i)} className="text-stone-300 hover:text-red-500 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-stone-200 bg-stone-50">
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-right text-sm font-semibold text-stone-900">Total</td>
                  <td className="px-3 py-2 text-right text-sm font-bold text-stone-900">MYR {total.toFixed(2)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
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
  isAdmin = false,
  isProcurement = false,
}: {
  po: POWithDetails;
  isAdmin?: boolean;
  isProcurement?: boolean;
  onClose: () => void;
  onStatusChange: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(
    Object.fromEntries((po.items ?? []).map((item) => [item.id, item.quantity_received?.toString() ?? '0']))
  );

  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [tolerancePct, setTolerancePct] = useState(DEFAULT_OVER_RECEIPT_TOLERANCE_PCT);
  const [closeReason, setCloseReason] = useState('');
  const [adjustItem, setAdjustItem] = useState<string | null>(null);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustKeepTotal, setAdjustKeepTotal] = useState(false);

  useEffect(() => {
    let live = true;
    void supabase
      .from('procurement_settings')
      .select('over_receipt_tolerance_pct')
      .maybeSingle()
      .then(({ data }) => {
        const v = Number(data?.over_receipt_tolerance_pct);
        if (live && Number.isFinite(v)) setTolerancePct(v);
      });
    return () => { live = false; };
  }, []);

  const receiptInputs = (po.items ?? []).map((item) => ({
    id: item.id,
    name: item.material?.name ?? 'Unknown',
    ordered: Number(item.quantity_ordered) || 0,
    previous: Number(item.quantity_received) || 0,
    entered: receivedQtys[item.id] ?? '0',
    reason: reasons[item.id],
  }));
  const preview = planReceipt(receiptInputs, { tolerancePct, isAdmin });

  function rpcFailure(rpcData: unknown, rpcErr: { message?: string } | null, fallback: string): string | null {
    if (rpcErr) return extractAtomicRpcErrorCode(undefined, rpcErr.message) ?? rpcErr.message ?? fallback;
    const r = rpcData as { success?: boolean; error?: string } | null;
    if (r && r.success === false) return extractAtomicRpcErrorCode(r.error) ?? r.error ?? fallback;
    return null;
  }

  async function handleMarkReceived() {
    setSaving(true);
    setError('');
    try {
      const plan = planReceipt(receiptInputs, { tolerancePct, isAdmin });
      if (!plan.ok) {
        setError(plan.error);
        setSaving(false);
        return;
      }
      // Ledger row is written server-side by receive_po_shipment (entered, delta, reason).
      const { data: rpcData, error: rpcErr } = await retryWithBackoff(async () =>
        supabase.rpc('receive_po_shipment', { p_po_id: po.id, p_lines: rpcLines(plan) })
      );
      const fail = rpcFailure(rpcData, rpcErr, 'Receive shipment failed');
      if (fail) {
        setError(fail);
        setSaving(false);
        return;
      }
      setSaving(false);
      onStatusChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark received');
      setSaving(false);
    }
  }

  async function handleCloseShort() {
    if (!isAdmin) {
      setError('Only an admin can close an order short');
      return;
    }
    if (!closeReason.trim()) {
      setError('Enter a reason to close this order short');
      return;
    }
    setSaving(true);
    setError('');
    const { data, error: rpcErr } = await supabase.rpc('close_po_short', { p_po_id: po.id, p_reason: closeReason.trim() });
    const fail = rpcFailure(data, rpcErr, 'Close short failed');
    setSaving(false);
    if (fail) setError(fail);
    else onStatusChange();
  }

  async function handleAdjustReceipt() {
    if (!adjustItem) return;
    const qty = Number(adjustQty);
    if (adjustQty.trim() === '' || !Number.isFinite(qty) || qty < 0) {
      setError('Enter a corrected quantity of 0 or more');
      return;
    }
    if (!adjustReason.trim()) {
      setError('Enter a reason for the receipt correction');
      return;
    }
    setSaving(true);
    setError('');
    const { data, error: rpcErr } = await supabase.rpc('adjust_po_receipt', {
      p_item_id: adjustItem,
      p_new_qty: qty,
      p_reason: adjustReason.trim(),
      p_keep_line_total: adjustKeepTotal,
    });
    const fail = rpcFailure(data, rpcErr, 'Receipt correction failed');
    setSaving(false);
    if (fail) setError(fail);
    else onStatusChange();
  }

  async function changeStatus(status: string) {
    setSaving(true);
    try {
      const { error: upErr } = await retryWithBackoff(async () => await
        supabase.from('purchase_orders').update({ status }).eq('id', po.id)
      );
      if (upErr) {
        // DB rules surface here: supplier_not_approved, po_cannot_approve_own, po_approval_admin_only, ...
        setError(upErr.message);
        setSaving(false);
        return;
      }

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
    <Modal
      isOpen
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          Purchase Order: {po.order_number}
          <EntityChip code={po.entity_code} />
        </span>
      }
      size="xl"
    >
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
        <div className="detail-meta sm:grid-cols-3">
          <div><p className="text-xs text-stone-500">Supplier</p><p className="font-semibold text-stone-900">{po.supplier?.name ?? '—'}</p></div>
          <div><p className="text-xs text-stone-500">Status</p><StatusBadge status={po.status} /></div>
          <div><p className="text-xs text-stone-500">Order Date</p><p className="font-semibold text-stone-900">{new Date(po.order_date).toLocaleDateString()}</p></div>
          <div><p className="text-xs text-stone-500">Expected Delivery</p><p className="font-semibold text-stone-900">{po.expected_delivery_date ? new Date(po.expected_delivery_date).toLocaleDateString() : '—'}</p></div>
          <div><p className="text-xs text-stone-500">Total Amount</p><p className="font-semibold text-stone-900">MYR {po.total_amount?.toFixed(2) ?? '0.00'}</p></div>
          {po.notes && <div className="sm:col-span-3"><p className="text-xs text-stone-500">Notes</p><p className="text-sm text-stone-900">{po.notes}</p></div>}
        </div>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-right">Ordered</th>
                <th className="text-right">Received</th>
                <th className="text-right">Unit Price</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {(po.items ?? []).map((item) => (
                <tr key={item.id}>
                  <td className="font-medium">{item.material?.name ?? '—'}<span className="ml-1 text-xs text-stone-400">({item.material?.unit_of_measure})</span></td>
                  <td className="text-right">{item.quantity_ordered}</td>
                  <td className="text-right">
                    {po.status === 'ordered' || po.status === 'partial' ? (
                      <div className="flex flex-col items-end gap-1">
                        <input type="number" min="0" step="0.0001"
                          value={receivedQtys[item.id] ?? '0'}
                          onChange={(e) => setReceivedQtys({ ...receivedQtys, [item.id]: e.target.value })}
                          className="w-24 rounded border border-stone-300 px-2 py-1 text-right text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20" />
                        {Number(receivedQtys[item.id] ?? 0) > item.quantity_ordered * (1 + tolerancePct / 100) && (
                          <input type="text" placeholder="Reason (admin)"
                            value={reasons[item.id] ?? ''}
                            onChange={(e) => setReasons({ ...reasons, [item.id]: e.target.value })}
                            className="w-40 rounded border border-amber-400 px-2 py-1 text-xs" />
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-end gap-1">
                        <span>{item.quantity_received}</span>
                        {isAdmin && (po.status === 'received' || po.status === 'closed_short') && (
                          <button type="button" className="text-xs text-brand-700 underline"
                            onClick={() => { setAdjustItem(item.id); setAdjustQty(String(item.quantity_received ?? 0)); setAdjustReason(''); }}>
                            Edit receipt
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="text-right">MYR {item.unit_price.toFixed(2)}</td>
                  <td className="text-right font-medium">MYR {(item.line_total ?? item.quantity_ordered * item.unit_price).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(po.status === 'ordered' || po.status === 'partial') && preview.ok && preview.warnings.length > 0 && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            <p className="font-medium">Received differs from ordered — stock will post what you entered:</p>
            <ul className="list-disc pl-5">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
        {isAdmin && po.status === 'partial' && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-stone-50 p-3">
            <input type="text" placeholder="Reason for closing short (admin)" value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              className="min-w-[14rem] flex-1 rounded border border-stone-300 px-2 py-1 text-sm" />
            <Button type="button" variant="secondary" onClick={handleCloseShort} disabled={saving}>
              Close short (no more stock expected)
            </Button>
          </div>
        )}
        {adjustItem && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-stone-50 p-3">
            <span className="text-sm font-medium">Correct received quantity</span>
            <input type="number" min="0" step="0.0001" value={adjustQty}
              onChange={(e) => setAdjustQty(e.target.value)}
              className="w-28 rounded border border-stone-300 px-2 py-1 text-right text-sm" />
            <input type="text" placeholder="Reason (required)" value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              className="min-w-[14rem] flex-1 rounded border border-stone-300 px-2 py-1 text-sm" />
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={adjustKeepTotal} onChange={(e) => setAdjustKeepTotal(e.target.checked)} />
              Invoice total unchanged (reprice unit cost)
            </label>
            <Button type="button" onClick={handleAdjustReceipt} disabled={saving}>Save correction</Button>
            <Button type="button" variant="secondary" onClick={() => setAdjustItem(null)} disabled={saving}>Cancel</Button>
          </div>
        )}
      </div>

      {user && (isAdmin || isProcurement) && purchaseOrderUseCancelRpc(po) && (
        <div className="mt-6">
          <PoCancelPanel
            po={po}
            role={isAdmin ? 'admin' : 'procurement'}
            uid={user.id}
            disabled={saving}
            onCancelled={onStatusChange}
          />
        </div>
      )}

      <div className="mt-6 flex flex-wrap justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {po.status === 'draft' && isProcurement && (
            <button type="button" onClick={() => changeStatus('pending_approval')} disabled={saving}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-60">
              Submit for approval
            </button>
          )}
          {po.status === 'pending_approval' && isAdmin && (
            <button type="button" onClick={() => changeStatus('ordered')} disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60">
              Approve &amp; mark ordered
            </button>
          )}
          {po.status === 'pending_approval' && !isAdmin && (
            <span className="self-center text-sm text-stone-500">Waiting for admin approval.</span>
          )}
          {(po.status === 'ordered' || po.status === 'partial') && isProcurement && (
            <span className="self-center text-sm text-stone-500">Record deliveries on the Receiving page.</span>
          )}
          {po.status === 'draft' && !isProcurement && (
            <button type="button" onClick={() => changeStatus('ordered')} disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60">
              Mark as Ordered
            </button>
          )}
          {(po.status === 'ordered' || po.status === 'partial') && !isProcurement && (
            <button type="button" onClick={handleMarkReceived} disabled={saving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60">
              {saving ? 'Processing…' : 'Mark Received & Update Stock'}
            </button>
          )}
          {po.status === 'draft' && onEdit && (
            <Button type="button" variant="secondary" onClick={onEdit} disabled={saving}>
              Edit order
            </Button>
          )}
          {purchaseOrderCanSimpleDelete(po) && onDelete && (
            <Button type="button" variant="danger" onClick={onDelete} disabled={saving}>
              Delete order
            </Button>
          )}
        </div>
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

// ---- Main Procurement Page ----
export function Procurement() {
  const { isAdmin, isProcurement, user } = useAuth();
  useRegisterRefresh(() => loadAll());
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab: Tab =
    tabParam === 'suppliers' || tabParam === 'materials' || tabParam === 'orders' || tabParam === 'cancellations'
      ? tabParam
      : 'orders';
  const [cancelTick, setCancelTick] = useState(0);
  const pendingCancelCount = usePoCancelPendingCount(isAdmin, cancelTick);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierScores, setSupplierScores] = useState<SupplierScoreRow[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [supplierMaterialLinks, setSupplierMaterialLinks] = useState<Array<{ supplier_id: string; raw_material_id: string }>>(
    []
  );
  const [orders, setOrders] = useState<POWithDetails[]>([]);
  const [entities, setEntities] = useState<MyEntity[]>([]);
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
    } else if (t === 'cancellations' && isAdmin) {
      setTab('cancellations');
    } else if (t === 'cancellations' && !isAdmin) {
      setTab('orders');
    }
  }, [searchParams, isAdmin]);

  function selectTab(next: Tab) {
    setTab(next);
    setSearchParams(next === 'orders' ? {} : { tab: next }, { replace: true });
  }

  async function loadAll() {
    setLoading(true);
    const [{ data: sups }, { data: mats }, { data: pos }, { data: links }, { data: scores }, { data: ents }] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      // procurement cannot read raw_materials (cost columns); it gets the cost-free catalogue view
      isProcurement
        ? supabase.from('v_raw_material_catalog').select('*').order('name')
        : supabase.from('raw_materials').select('*').order('name'),
      supabase
        .from('purchase_orders')
        .select(`*, supplier:supplier_id(*), items:purchase_order_items(*, material:raw_material_id(*))`)
        .order('created_at', { ascending: false }),
      supabase.from('supplier_raw_materials').select('supplier_id, raw_material_id'),
      supabase.from('supplier_scorecard_metrics').select('*').order('supplier_name'),
      // procurement cannot read business_entities; this view returns only the caller's own entities
      supabase.from('v_my_entities').select('code, name, procurement_tag').order('code'),
    ]);
    setEntities((ents ?? []) as MyEntity[]);
    setSuppliers(sups ?? []);
    setSupplierScores((scores ?? []) as SupplierScoreRow[]);
    setMaterials((mats ?? []) as typeof materials);
    setSupplierMaterialLinks(links ?? []);
    const matById = new Map((mats ?? []).map((m: { id: string }) => [m.id, m]));
    // embedded material is null for procurement (raw_materials denied); fill it from the catalogue
    setOrders(((pos ?? []) as POWithDetails[]).map((po) => ({
      ...po,
      items: (po.items ?? []).map((it) => ({ ...it, material: it.material ?? (matById.get(it.raw_material_id) as typeof it.material) ?? it.material })),
    })));
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
    if (!purchaseOrderCanSimpleDelete(po)) {
      alert('This purchase order cannot be removed in its current state.');
      return;
    }

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
            ...(isAdmin
              ? [{ id: 'cancellations' as const, label: `Cancellations (${pendingCancelCount})` }]
              : []),
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
        <div className="flex h-48 items-center justify-center text-stone-400 text-sm">Loading…</div>
      ) : (
        <>
          {/* Purchase Orders Tab */}
          {tab === 'orders' && (
            <div className="space-y-4">
              <div className="relative max-w-sm">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search orders…"
                  className="w-full rounded-lg border border-stone-300 py-2 pl-9 pr-4 text-sm"
                />
              </div>
              {filteredOrders.length === 0 ? (
                <div className="panel py-2">
                  <EmptyState title="No purchase orders found" />
                </div>
              ) : (
                <>
                  <div className="ios-group">
                    {filteredOrders.map((order) => (
                      <ListRow
                        key={order.id}
                        title={
                          <span className="inline-flex items-center gap-2">
                            {order.order_number}
                            <EntityChip code={order.entity_code} />
                          </span>
                        }
                        meta={`${(order.supplier as Supplier | null)?.name ?? '—'} · ${new Date(order.order_date).toLocaleDateString()} · MYR ${order.total_amount?.toFixed(2) ?? '0.00'}`}
                        aside={<StatusBadge status={order.status} />}
                        body={
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => setViewPO(order)}
                              className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-stone-700"
                            >
                              Manage <ChevronRight size={14} aria-hidden />
                            </button>
                            {isAdmin && purchaseOrderCanSimpleDelete(order) && (
                              <button
                                type="button"
                                onClick={() => deletePurchaseOrder(order)}
                                className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700"
                              >
                                <Trash2 size={14} aria-hidden />
                                Delete
                              </button>
                            )}
                          </div>
                        }
                      />
                    ))}
                  </div>
                  <div className="hidden">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Order #</th>
                          <th>Supplier</th>
                          <th>Date</th>
                          <th className="text-right">Amount</th>
                          <th>Status</th>
                          <th className="hidden sm:table-cell">Items</th>
                          <th className="text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredOrders.map((order) => (
                          <tr key={order.id}>
                            <td className="font-medium">
                              <span className="inline-flex items-center gap-2">
                                {order.order_number}
                                <EntityChip code={order.entity_code} />
                              </span>
                            </td>
                            <td>{(order.supplier as Supplier | null)?.name ?? '—'}</td>
                            <td className="text-stone-500">{new Date(order.order_date).toLocaleDateString()}</td>
                            <td className="text-right font-medium">
                              MYR {order.total_amount?.toFixed(2) ?? '0.00'}
                            </td>
                            <td>
                              <StatusBadge status={order.status} />
                            </td>
                            <td className="hidden text-stone-500 sm:table-cell">
                              {(order.items ?? []).length} line(s)
                            </td>
                            <td className="text-right">
                              <div className="flex flex-wrap items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setViewPO(order)}
                                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-800 hover:underline"
                                >
                                  Manage <ChevronRight size={14} aria-hidden />
                                </button>
                                {isAdmin && purchaseOrderCanSimpleDelete(order) && (
                                  <button
                                    type="button"
                                    onClick={() => deletePurchaseOrder(order)}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
                                    title="Delete purchase order (admin)"
                                  >
                                    <Trash2 size={14} aria-hidden />
                                    Delete
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'cancellations' && isAdmin && user && (
            <PoCancelRequestsTab
              uid={user.id}
              onChanged={() => {
                setCancelTick((n) => n + 1);
                void loadAll();
              }}
            />
          )}

          {/* Suppliers Tab */}
          {tab === 'suppliers' && (
            <div className="space-y-6">
              {supplierScores.filter((s) => (s.completed_orders ?? 0) > 0).length > 0 && (
                <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-5">
                  <h2 className="mb-1 text-sm font-semibold text-stone-900">Supplier performance</h2>
                  <p className="mb-4 text-xs text-stone-600">
                    OTIF and fill-rate from completed or partial purchase order history.
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
                    <table className="w-full text-sm">
                      <thead className="border-b border-stone-200 bg-stone-50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-stone-700">Supplier</th>
                          <th className="px-4 py-3 text-right font-semibold text-stone-700">Completed POs</th>
                          <th className="px-4 py-3 text-right font-semibold text-stone-700">OTIF rate</th>
                          <th className="px-4 py-3 text-right font-semibold text-stone-700">Avg fill rate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100">
                        {supplierScores
                          .filter((s) => (s.completed_orders ?? 0) > 0)
                          .map((s) => {
                            const otif = s.otif_rate != null ? Number(s.otif_rate) : null;
                            const fill = s.avg_fill_rate != null ? Number(s.avg_fill_rate) : null;
                            return (
                              <tr key={s.supplier_id} className="hover:bg-stone-50/80">
                                <td className="px-4 py-3 font-medium text-stone-900">{s.supplier_name}</td>
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
            <div className="ios-group">
              {suppliers.length === 0 ? (
                <EmptyState title="No suppliers yet" />
              ) : (
                suppliers.map((s) => (
                  <ListRow
                    key={s.id}
                    title={s.name}
                    meta={[s.contact_person, s.email, s.phone, s.payment_terms].filter(Boolean).join(' · ') || 'No contact details'}
                    body={
                      <button
                        type="button"
                        onClick={() => {
                          setEditSupplier(s);
                          setShowSupplierModal(true);
                        }}
                        className="inline-flex min-h-11 items-center gap-1 text-[15px] font-medium text-brand-800"
                      >
                        Manage <ChevronRight size={16} aria-hidden />
                      </button>
                    }
                  />
                ))
              )}
            </div>
            </div>
          )}

          {/* Raw Materials Tab */}
          {tab === 'materials' && (
            materials.length === 0 ? (
              <div className="panel py-2">
                <EmptyState title="No raw materials yet" />
              </div>
            ) : (
              <div className="ios-group">
                {materials.map((m) => (
                  <ListRow
                    key={m.id}
                    title={m.name}
                    meta={`${m.unit_of_measure} · reorder ${m.reorder_level ?? 10}${m.description ? ` · ${m.description}` : ''}`}
                    aside={<span className="font-medium tabular-nums">MYR {m.cost_price != null ? m.cost_price.toFixed(2) : '—'}</span>}
                    body={
                      <button
                        type="button"
                        onClick={() => {
                          setEditMaterial(m);
                          setShowMaterialModal(true);
                        }}
                        className="inline-flex min-h-11 items-center gap-1 text-[15px] font-medium text-brand-800"
                      >
                        Manage <ChevronRight size={16} aria-hidden />
                      </button>
                    }
                  />
                ))}
              </div>
            )
          )}
        </>
      )}

      {/* Modals */}
      {showNewPO && (
        <NewPOModal
          key="new-po"
          suppliers={suppliers}
          entities={entities}
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
          entities={entities}
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
          isAdmin={isAdmin}
          isProcurement={isProcurement}
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
          isProcurement={isProcurement}
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
