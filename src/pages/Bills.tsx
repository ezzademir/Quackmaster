import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, PageHeader } from '../components/ui';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { defaultEntityCode, type MyEntity } from '../utils/procurementPayloads';

interface BillRow {
  id: string;
  entity_code: string;
  supplier_name: string;
  bill_number: string;
  bill_date: string;
  due_date: string | null;
  amount_rm: number;
  paid_rm: number;
  balance_rm: number;
  payment_status: 'paid' | 'overdue' | 'part_paid' | 'unpaid';
}

/** Supplier bills. Procurement records bills and sees payment status read-only; only admins record (part) payments into supplier_payments (DB-enforced). */
export function Bills() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<BillRow[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [entities, setEntities] = useState<MyEntity[]>([]);
  const [form, setForm] = useState({ supplier_id: '', entity_code: '', bill_number: '', bill_date: '', due_date: '', amount_rm: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const emptyPay = { bill_id: '', amount_rm: '', paid_on: '', method: 'bank_transfer', reference: '', document_path: '', notes: '' };
  const [pay, setPay] = useState(emptyPay);

  const load = useCallback(async () => {
    const [b, s, e] = await Promise.all([
      supabase.from('v_supplier_bill_status').select('*').order('bill_date', { ascending: false }),
      // only approved suppliers can be billed (085 _supplier_is_active)
      supabase.from('suppliers').select('id, name').eq('status', 'active').order('name'),
      // procurement cannot read business_entities; this view returns only the caller's own entities
      supabase.from('v_my_entities').select('code, name, procurement_tag').order('code'),
    ]);
    if (b.error) setMsg(b.error.message);
    setRows((b.data ?? []) as BillRow[]);
    setSuppliers((s.data ?? []) as Array<{ id: string; name: string }>);
    const ents = (e.data ?? []) as MyEntity[];
    setEntities(ents);
    setForm((f) => ({ ...f, entity_code: defaultEntityCode(ents, f.entity_code) }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addBill() {
    const { error } = await supabase.from('supplier_bills').insert({
      supplier_id: form.supplier_id,
      entity_code: form.entity_code,
      bill_number: form.bill_number.trim(),
      bill_date: form.bill_date,
      due_date: form.due_date || null,
      amount_rm: Number(form.amount_rm),
    });
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg('Bill recorded.');
    setForm({ supplier_id: '', entity_code: defaultEntityCode(entities), bill_number: '', bill_date: '', due_date: '', amount_rm: '' });
    void load();
  }

  async function recordPayment() {
    const { error } = await supabase.from('supplier_payments').insert({
      bill_id: pay.bill_id,
      amount_rm: Number(pay.amount_rm),
      paid_on: pay.paid_on,
      method: pay.method,
      reference: pay.reference.trim() || null,
      document_path: pay.document_path.trim() || null,
      notes: pay.notes.trim() || null,
    });
    if (error) {
      setMsg(error.message.includes('payment_exceeds_bill_balance') ? 'Payment is more than the bill balance.' : error.message);
      return;
    }
    setMsg('Payment recorded.');
    setPay(emptyPay);
    void load();
  }

  const payValid = pay.bill_id && Number(pay.amount_rm) > 0 && pay.paid_on;
  const valid = form.supplier_id && form.entity_code && form.bill_number.trim() && form.bill_date && Number(form.amount_rm) >= 0 && form.amount_rm !== '';

  return (
    <div className="space-y-4">
      <PageHeader title="Bills" description={isAdmin ? 'Supplier bills and payment status.' : 'Record supplier bills. Payment status is read-only.'} />
      {msg && <div className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">{msg}</div>}
      <div className="grid gap-2 rounded-xl border border-stone-200 bg-white p-3 text-sm sm:grid-cols-3">
        <select aria-label="Supplier" className="rounded border px-2 py-1" value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
          <option value="">Supplier…</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Entity" className="rounded border px-2 py-1" value={form.entity_code} onChange={(e) => setForm({ ...form, entity_code: e.target.value })}>
          <option value="">Entity…</option>
          {entities.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
        </select>
        <input aria-label="Bill number" className="rounded border px-2 py-1" placeholder="Bill number" value={form.bill_number} onChange={(e) => setForm({ ...form, bill_number: e.target.value })} />
        <input aria-label="Bill date" type="date" className="rounded border px-2 py-1" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} />
        <input aria-label="Due date" type="date" className="rounded border px-2 py-1" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        <input aria-label="Amount RM" inputMode="decimal" className="rounded border px-2 py-1" placeholder="Amount RM" value={form.amount_rm} onChange={(e) => setForm({ ...form, amount_rm: e.target.value })} />
        <Button disabled={!valid} onClick={() => void addBill()}>Record bill</Button>
      </div>
      {isAdmin && (
        <div className="grid gap-2 rounded-xl border border-stone-200 bg-white p-3 text-sm sm:grid-cols-4">
          <select aria-label="Bill to pay" className="rounded border px-2 py-1" value={pay.bill_id} onChange={(e) => setPay({ ...pay, bill_id: e.target.value })}>
            <option value="">Bill…</option>
            {rows.filter((r) => Number(r.balance_rm) > 0).map((r) => (
              <option key={r.id} value={r.id}>{r.supplier_name} {r.bill_number} (bal {Number(r.balance_rm).toFixed(2)})</option>
            ))}
          </select>
          <input aria-label="Payment amount RM" inputMode="decimal" className="rounded border px-2 py-1" placeholder="Amount RM" value={pay.amount_rm} onChange={(e) => setPay({ ...pay, amount_rm: e.target.value })} />
          <input aria-label="Paid on" type="date" className="rounded border px-2 py-1" value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} />
          <select aria-label="Method" className="rounded border px-2 py-1" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
            {['bank_transfer', 'cash', 'cheque', 'card', 'duitnow', 'other'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
          <input aria-label="Reference" className="rounded border px-2 py-1" placeholder="Reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
          <input aria-label="Attachment path" className="rounded border px-2 py-1" placeholder="Attachment (storage path)" value={pay.document_path} onChange={(e) => setPay({ ...pay, document_path: e.target.value })} />
          <input aria-label="Notes" className="rounded border px-2 py-1" placeholder="Notes" value={pay.notes} onChange={(e) => setPay({ ...pay, notes: e.target.value })} />
          <Button disabled={!payValid} onClick={() => void recordPayment()}>Record payment</Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No bills" description="Bills you record appear here with their payment status." />
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th>Supplier</th><th>Bill</th><th>Entity</th><th>Due</th><th className="text-right">Amount</th><th className="text-right">Paid</th><th className="text-right">Balance</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-stone-100">
                <td>{r.supplier_name}</td><td>{r.bill_number}</td><td>{r.entity_code}</td><td>{r.due_date ?? '-'}</td>
                <td className="text-right">{Number(r.amount_rm).toFixed(2)}</td><td className="text-right">{Number(r.paid_rm).toFixed(2)}</td><td className="text-right">{Number(r.balance_rm).toFixed(2)}</td>
                <td>{r.payment_status.replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
