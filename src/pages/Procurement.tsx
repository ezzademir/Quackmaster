import { useEffect, useState } from 'react';
import { Plus, Search, CreditCard as Edit2, Trash2, ChevronRight, PackagePlus, AlertCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { supabase } from '../utils/supabase';
import { logActivity } from '../utils/activityLog';
import { writeLedgerEntry } from '../utils/ledger';
import { validateSupplier, validateRawMaterial, validatePurchaseOrder, validatePurchaseOrderItem, formatValidationErrors } from '../utils/validation';
import { retryWithBackoff } from '../utils/errorHandling';
import type { Supplier, RawMaterial, PurchaseOrder, PurchaseOrderItem } from '../types';

type Tab = 'orders' | 'suppliers' | 'materials';

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

// ---- Supplier Modal ----
function SupplierModal({
  supplier,
  onClose,
  onSave,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSave: () => void;
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
  const [error, setError] = useState('');

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

      await logActivity({
        action: supplier ? 'updated' : 'created',
        entityType: 'supplier',
        entityId: createdSupplierId,
        entityLabel: form.name,
      });

      await writeLedgerEntry({
        action: supplier ? 'updated' : 'created',
        entityType: 'supplier',
        entityId: createdSupplierId,
        module: 'procurement',
        operation: supplier ? 'update' : 'insert',
        afterData: form,
      });

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
    <Modal isOpen onClose={onClose} title={supplier ? 'Edit Supplier' : 'Add Supplier'} size="lg">
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
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
          Cancel
        </button>
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Raw Material Modal ----
function MaterialModal({
  material,
  onClose,
  onSave,
}: {
  material: RawMaterial | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const [form, setForm] = useState({
    name: material?.name ?? '',
    description: material?.description ?? '',
    unit_of_measure: material?.unit_of_measure ?? '',
    cost_price: material?.cost_price?.toString() ?? '',
    reorder_level: material?.reorder_level?.toString() ?? '10',
  });
  const [saving, setSaving] = useState(false);
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

      await logActivity({
        action: material ? 'updated' : 'created',
        entityType: 'raw_material',
        entityId: createdMaterialId,
        entityLabel: form.name,
      });

      await writeLedgerEntry({
        action: material ? 'updated' : 'created',
        entityType: 'raw_material',
        entityId: createdMaterialId,
        module: 'procurement',
        operation: material ? 'update' : 'insert',
        afterData: payload,
      });

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
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
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

function NewPOModal({
  suppliers,
  materials,
  existingNumbers,
  onClose,
  onSave,
}: {
  suppliers: Supplier[];
  materials: RawMaterial[];
  existingNumbers: string[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [supplier_id, setSupplierId] = useState('');
  const [order_date, setOrderDate] = useState(new Date().toISOString().split('T')[0]);
  const [expected_delivery_date, setExpectedDelivery] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<POLine[]>([{ raw_material_id: '', quantity_ordered: '', unit_price: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const total = lines.reduce((acc, l) => acc + (parseFloat(l.quantity_ordered) || 0) * (parseFloat(l.unit_price) || 0), 0);

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

    setSaving(true);

    try {
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

      const items = validLines.map((l) => ({
        purchase_order_id: po.id,
        raw_material_id: l.raw_material_id,
        quantity_ordered: parseFloat(l.quantity_ordered),
        quantity_received: 0,
        unit_price: parseFloat(l.unit_price),
        line_total: parseFloat(l.quantity_ordered) * parseFloat(l.unit_price),
      }));

      const { error: itemErr } = await retryWithBackoff(async () => await
        supabase.from('purchase_order_items').insert(items)
      );

      if (itemErr) {
        setError(itemErr.message);
        setSaving(false);
        return;
      }

      await logActivity({
        action: 'created',
        entityType: 'purchase_order',
        entityId: po.id,
        entityLabel: order_number,
        details: { supplier_id, total, item_count: items.length },
      });

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
          items: items.length,
        },
      });

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create purchase order');
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="New Purchase Order" size="xl">
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="space-y-5">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-gray-700">Supplier *</label>
            <select value={supplier_id} onChange={(e) => setSupplierId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="">Select supplier…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
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
                      <select value={line.raw_material_id} onChange={(e) => updateLine(i, 'raw_material_id', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
                        <option value="">Select…</option>
                        {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit_of_measure})</option>)}
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
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Create Order'}
        </button>
      </div>
    </Modal>
  );
}

// ---- PO Detail ----
type POWithDetails = PurchaseOrder & {
  supplier?: Supplier;
  items?: (PurchaseOrderItem & { material?: RawMaterial })[];
};

function PODetailModal({
  po,
  onClose,
  onStatusChange,
}: {
  po: POWithDetails;
  onClose: () => void;
  onStatusChange: () => void;
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

      // Second pass: apply updates with retry logic
      for (let i = 0; i < (po.items ?? []).length; i++) {
        const item = (po.items ?? [])[i];
        const update = updates[i];

        await retryWithBackoff(async () => {
          await supabase
            .from('purchase_order_items')
            .update({ quantity_received: update.qty, line_total: update.qty * item.unit_price })
            .eq('id', item.id);

          await writeLedgerEntry({
            action: 'updated',
            entityType: 'purchase_order_item',
            entityId: item.id,
            module: 'procurement',
            operation: 'update',
            beforeData: { quantity_received: item.quantity_received },
            afterData: { quantity_received: update.qty, line_total: update.qty * item.unit_price },
            referenceId: po.id,
          });

          // Upsert hub inventory
          const { data: existing, error: checkErr } = await supabase
            .from('hub_inventory')
            .select('id, quantity_on_hand, reserved_quantity')
            .eq('raw_material_id', item.raw_material_id)
            .maybeSingle();

          if (checkErr && checkErr.code !== 'PGRST116') {
            throw checkErr;
          }

          if (existing) {
            const newQty = existing.quantity_on_hand + update.qty;
            await supabase
              .from('hub_inventory')
              .update({
                quantity_on_hand: newQty,
                available_quantity: newQty - (existing.reserved_quantity || 0),
                last_updated: new Date().toISOString(),
              })
              .eq('id', existing.id);

            await writeLedgerEntry({
              action: 'updated',
              entityType: 'hub_inventory',
              entityId: existing.id,
              module: 'procurement',
              operation: 'update',
              beforeData: {
                quantity_on_hand: existing.quantity_on_hand,
                available_quantity: existing.quantity_on_hand - (existing.reserved_quantity || 0),
              },
              afterData: {
                quantity_on_hand: newQty,
                available_quantity: newQty - (existing.reserved_quantity || 0),
              },
              deltaData: { quantity_added: update.qty },
              referenceId: po.id,
            });
          } else {
            const { data: inserted, error: insertErr } = await supabase
              .from('hub_inventory')
              .insert({
                raw_material_id: item.raw_material_id,
                quantity_on_hand: update.qty,
                reserved_quantity: 0,
                available_quantity: update.qty,
                last_updated: new Date().toISOString(),
              })
              .select('id')
              .single();

            if (insertErr) throw insertErr;

            await writeLedgerEntry({
              action: 'created',
              entityType: 'hub_inventory',
              entityId: inserted?.id ?? '',
              module: 'procurement',
              operation: 'insert',
              afterData: {
                raw_material_id: item.raw_material_id,
                quantity_on_hand: update.qty,
                available_quantity: update.qty,
              },
              referenceId: po.id,
            });
          }
        });
      }

      // Update PO status
      const nextStatus = receivedTotal <= 0 ? 'ordered' : receivedTotal < orderedTotal ? 'partial' : 'received';
      await retryWithBackoff(async () => await
        supabase
          .from('purchase_orders')
          .update({
            status: nextStatus,
            actual_delivery_date: nextStatus === 'received' ? new Date().toISOString().split('T')[0] : null,
          })
          .eq('id', po.id)
      );

      await logActivity({
        action: nextStatus === 'received' ? 'received' : 'updated',
        entityType: 'purchase_order',
        entityId: po.id,
        entityLabel: po.order_number,
        details: { status: nextStatus, received_total: receivedTotal, ordered_total: orderedTotal },
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

      await logActivity({
        action: 'updated',
        entityType: 'purchase_order',
        entityId: po.id,
        entityLabel: po.order_number,
        details: { status },
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
        <div className="flex gap-2">
          {po.status === 'draft' && (
            <button onClick={() => changeStatus('ordered')} disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
              Mark as Ordered
            </button>
          )}
          {(po.status === 'ordered' || po.status === 'partial') && (
            <button onClick={handleMarkReceived} disabled={saving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
              {saving ? 'Processing…' : 'Mark Received & Update Stock'}
            </button>
          )}
        </div>
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Close</button>
      </div>
    </Modal>
  );
}

// ---- Main Procurement Page ----
export function Procurement() {
  const [tab, setTab] = useState<Tab>('orders');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [orders, setOrders] = useState<POWithDetails[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Modal state
  const [showNewPO, setShowNewPO] = useState(false);
  const [viewPO, setViewPO] = useState<POWithDetails | null>(null);
  const [editSupplier, setEditSupplier] = useState<Supplier | null | 'new'>('new' as never);
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [editMaterial, setEditMaterial] = useState<RawMaterial | null | 'new'>('new' as never);
  const [showMaterialModal, setShowMaterialModal] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [{ data: sups }, { data: mats }, { data: pos }] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('raw_materials').select('*').order('name'),
      supabase
        .from('purchase_orders')
        .select(`*, supplier:supplier_id(*), items:purchase_order_items(*, material:raw_material_id(*))`)
        .order('created_at', { ascending: false }),
    ]);
    setSuppliers(sups ?? []);
    setMaterials(mats ?? []);
    setOrders(pos as POWithDetails[] ?? []);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  async function deleteSupplier(id: string) {
    if (!confirm('Delete this supplier?')) return;
    const s = suppliers.find((x) => x.id === id);
    await supabase.from('suppliers').delete().eq('id', id);
    await logActivity({ action: 'deleted', entityType: 'supplier', entityId: id, entityLabel: s?.name ?? id });
    loadAll();
  }

  async function deleteMaterial(id: string) {
    if (!confirm('Delete this raw material?')) return;
    const m = materials.find((x) => x.id === id);
    await supabase.from('raw_materials').delete().eq('id', id);
    await logActivity({ action: 'deleted', entityType: 'raw_material', entityId: id, entityLabel: m?.name ?? id });
    loadAll();
  }

  const filteredOrders = orders.filter((o) =>
    o.order_number.toLowerCase().includes(search.toLowerCase()) ||
    (o.supplier as Supplier | null)?.name.toLowerCase().includes(search.toLowerCase())
  );

  const tabClass = (t: Tab) =>
    `border-b-2 px-1 py-4 text-sm font-medium transition-colors ${
      tab === t
        ? 'border-blue-600 text-blue-600'
        : 'border-transparent text-gray-500 hover:text-gray-700'
    }`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Procurement</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage suppliers, raw materials and purchase orders
          </p>
        </div>
        {tab === 'orders' && (
          <button onClick={() => setShowNewPO(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
            <Plus size={16} /> New Order
          </button>
        )}
        {tab === 'suppliers' && (
          <button onClick={() => { setEditSupplier(null); setShowSupplierModal(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
            <Plus size={16} /> Add Supplier
          </button>
        )}
        {tab === 'materials' && (
          <button onClick={() => { setEditMaterial(null); setShowMaterialModal(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
            <Plus size={16} /> Add Material
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6">
          <button className={tabClass('orders')} onClick={() => setTab('orders')}>Purchase Orders</button>
          <button className={tabClass('suppliers')} onClick={() => setTab('suppliers')}>Suppliers</button>
          <button className={tabClass('materials')} onClick={() => setTab('materials')}>Raw Materials</button>
        </nav>
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
                      <th className="w-16 px-4 md:px-6 py-3" />
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
                          <td className="px-4 md:px-6 py-4">
                            <button onClick={() => setViewPO(order)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800">
                              View <ChevronRight size={14} />
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

          {/* Suppliers Tab */}
          {tab === 'suppliers' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Name</th>
                    <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Contact</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Email</th>
                    <th className="hidden lg:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Phone</th>
                    <th className="hidden xl:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Payment Terms</th>
                    <th className="w-20 px-4 md:px-6 py-3" />
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
                        <td className="px-4 md:px-6 py-4">
                          <div className="flex items-center gap-2">
                            <button onClick={() => { setEditSupplier(s); setShowSupplierModal(true); }} className="text-gray-400 hover:text-blue-600 transition-colors"><Edit2 size={15} /></button>
                            <button onClick={() => deleteSupplier(s.id)} className="text-gray-400 hover:text-red-600 transition-colors"><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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
                    <th className="w-20 px-4 md:px-6 py-3" />
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
                        <td className="px-4 md:px-6 py-4">
                          <div className="flex items-center gap-2">
                            <button onClick={() => { setEditMaterial(m); setShowMaterialModal(true); }} className="text-gray-400 hover:text-blue-600 transition-colors"><Edit2 size={15} /></button>
                            <button onClick={() => deleteMaterial(m.id)} className="text-gray-400 hover:text-red-600 transition-colors"><Trash2 size={15} /></button>
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

      {/* Modals */}
      {showNewPO && (
        <NewPOModal
          suppliers={suppliers}
          materials={materials}
          existingNumbers={orders.map((o) => o.order_number)}
          onClose={() => setShowNewPO(false)}
          onSave={() => { setShowNewPO(false); loadAll(); }}
        />
      )}
      {viewPO && (
        <PODetailModal
          po={viewPO}
          onClose={() => setViewPO(null)}
          onStatusChange={() => { setViewPO(null); loadAll(); }}
        />
      )}
      {showSupplierModal && (
        <SupplierModal
          supplier={editSupplier as Supplier | null}
          onClose={() => setShowSupplierModal(false)}
          onSave={() => { setShowSupplierModal(false); loadAll(); }}
        />
      )}
      {showMaterialModal && (
        <MaterialModal
          material={editMaterial as RawMaterial | null}
          onClose={() => setShowMaterialModal(false)}
          onSave={() => { setShowMaterialModal(false); loadAll(); }}
        />
      )}
    </div>
  );
}
