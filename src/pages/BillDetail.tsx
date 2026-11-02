import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Ban, Banknote, Check, ChevronLeft, Circle, Pencil, type LucideIcon } from 'lucide-react';
import { Button, EmptyState, PageHeader, Status } from '../components/ui';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { type MyEntity } from '../utils/procurementPayloads';
import { useRegisterRefresh } from '../utils/pageRefresh';

interface BillRow {
  id: string;
  entity_code: string;
  supplier_id: string;
  supplier_name: string;
  purchase_order_id: string | null;
  bill_number: string;
  bill_date: string;
  due_date: string | null;
  amount_rm: number;
  paid_rm: number;
  balance_rm: number;
  payment_status: 'paid' | 'overdue' | 'part_paid' | 'unpaid' | 'void';
  void_reason: string | null;
}

interface BillLine {
  id: string;
  raw_material_id: string;
  quantity_ordered: number;
  quantity_received: number | null;
  unit_price: number;
  line_total: number | null;
}

interface PaymentRow {
  id: string;
  amount_rm: number;
  paid_on: string;
}

const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque', 'card', 'duitnow', 'other'] as const;

function billStatus(status: BillRow['payment_status']): {
  tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
  label: string;
  icon: LucideIcon;
} {
  switch (status) {
    case 'unpaid':
      return { tone: 'warning', label: 'Unpaid', icon: Circle };
    case 'part_paid':
      return { tone: 'brand', label: 'Part paid', icon: Banknote };
    case 'paid':
      return { tone: 'success', label: 'Paid', icon: Check };
    case 'overdue':
      return { tone: 'danger', label: 'Overdue', icon: AlertTriangle };
    case 'void':
      return { tone: 'neutral', label: 'Void', icon: Ban };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function voidFailure(message: string): string {
  if (message.includes('bill_has_payments')) return 'This bill has payments. Remove them first, then void it.';
  if (message.includes('bill_already_void')) return 'This bill is already void.';
  if (message.includes('reason_required')) return 'A reason is required.';
  if (message.includes('forbidden')) return 'Only an admin can void a bill.';
  return message;
}

function editFailure(message: string): string {
  if (message.includes('bill_amount_below_paid')) return 'Amount cannot be less than what is already paid.';
  if (message.includes('supplier_not_approved')) return 'That supplier is not approved.';
  return message;
}

/** One supplier bill. Procurement can read it. Admins record payments, edit, remove payments, and void. */
export function BillDetail() {
  const { billId } = useParams();
  const navigate = useNavigate();
  const { isAdmin, isProcurement } = useAuth();
  const [bill, setBill] = useState<BillRow | null>(null);
  const [missing, setMissing] = useState(false);
  const [notes, setNotes] = useState('');
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<string[]>([]);
  const [lines, setLines] = useState<BillLine[]>([]);
  const [itemNames, setItemNames] = useState<Record<string, { name: string; unit: string | null }>>({});
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [entities, setEntities] = useState<MyEntity[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [showPay, setShowPay] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  const voidingRef = useRef(false);
  const emptyPay = { amount_rm: '', paid_on: '', method: 'bank_transfer', reference: '', document_path: '', notes: '' };
  const [pay, setPay] = useState(emptyPay);
  const [edit, setEdit] = useState({ supplier_id: '', entity_code: '', bill_number: '', bill_date: '', due_date: '', amount_rm: '', notes: '' });

  const load = useCallback(async () => {
    if (!billId) return;
    const [billRes, noteRes, paymentRes, supplierRes, entityRes, catalogRes] = await Promise.all([
      supabase.from('v_supplier_bill_status').select('*').eq('id', billId).maybeSingle(),
      supabase.from('supplier_bills').select('notes').eq('id', billId).maybeSingle(),
      supabase.from('supplier_payments').select('id, amount_rm, paid_on').eq('bill_id', billId).order('paid_on', { ascending: false }),
      supabase.from('suppliers').select('id, name').eq('status', 'active').order('name'),
      supabase.from('v_my_entities').select('code, name, procurement_tag').order('code'),
      supabase.from('v_raw_material_catalog').select('id, name, unit_of_measure'),
    ]);
    if (billRes.error) {
      setMsg(billRes.error.message);
      setBill(null);
      setMissing(true);
      return;
    }
    const row = (billRes.data ?? null) as BillRow | null;
    setBill(row);
    setMissing(!row);
    setNotes(((noteRes.data as { notes: string | null } | null)?.notes ?? '').trim());
    setPayments((paymentRes.data ?? []) as PaymentRow[]);
    setSuppliers((supplierRes.data ?? []) as Array<{ id: string; name: string }>);
    setEntities((entityRes.data ?? []) as MyEntity[]);
    setItemNames(Object.fromEntries(
      ((catalogRes.data ?? []) as Array<{ id: string; name: string; unit_of_measure: string | null }>).map((item) => [
        item.id,
        { name: item.name, unit: item.unit_of_measure },
      ]),
    ));
    const poId = row?.purchase_order_id;
    if (!poId) {
      setLines([]);
      setOrderNo(null);
      setInvoices([]);
      return;
    }
    const [lineRows, orderRows, receiptRows] = await Promise.all([
      supabase.from('purchase_order_items').select('id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total').eq('purchase_order_id', poId),
      supabase.from('purchase_orders').select('id, order_number').eq('id', poId).maybeSingle(),
      supabase.from('po_receipt_records').select('invoice_number, entered_at').eq('purchase_order_id', poId).order('entered_at'),
    ]);
    if (lineRows.error) setMsg(lineRows.error.message);
    else if (receiptRows.error) setMsg(receiptRows.error.message);
    setLines((lineRows.data ?? []) as BillLine[]);
    const order = orderRows.data as { order_number: string | null } | null;
    setOrderNo(order?.order_number ?? poId.slice(0, 8));
    const seen: string[] = [];
    for (const receipt of (receiptRows.data ?? []) as Array<{ invoice_number: string | null }>) {
      const number = receipt.invoice_number?.trim();
      if (number && !seen.includes(number)) seen.push(number);
    }
    setInvoices(seen);
  }, [billId]);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterRefresh(() => load());

  function openPay() {
    if (!bill) return;
    setPay({ ...emptyPay, amount_rm: Number(bill.balance_rm).toFixed(2) });
    setShowEdit(false);
    setShowVoid(false);
    setShowPay(true);
  }

  function openEdit() {
    if (!bill) return;
    setEdit({
      supplier_id: bill.supplier_id,
      entity_code: bill.entity_code,
      bill_number: bill.bill_number,
      bill_date: bill.bill_date,
      due_date: bill.due_date ?? '',
      amount_rm: String(Number(bill.amount_rm)),
      notes,
    });
    setShowPay(false);
    setShowVoid(false);
    setShowEdit(true);
  }

  async function recordPayment() {
    if (!bill) return;
    const { error } = await supabase.from('supplier_payments').insert({
      bill_id: bill.id,
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
    setShowPay(false);
    setPay(emptyPay);
    void load();
  }

  async function saveEdit() {
    if (!bill) return;
    const amount = Number(edit.amount_rm);
    if (amount < Number(bill.paid_rm)) {
      setMsg('Amount cannot be less than what is already paid.');
      return;
    }
    const { error } = await supabase.from('supplier_bills').update({
      supplier_id: edit.supplier_id,
      entity_code: edit.entity_code,
      bill_number: edit.bill_number.trim(),
      bill_date: edit.bill_date,
      due_date: edit.due_date || null,
      amount_rm: amount,
      notes: edit.notes.trim() || null,
    }).eq('id', bill.id);
    if (error) {
      setMsg(editFailure(error.message));
      return;
    }
    setMsg('Bill updated.');
    setShowEdit(false);
    void load();
  }

  async function removePayment(payment: PaymentRow) {
    if (!confirm(`Remove the RM ${Number(payment.amount_rm).toFixed(2)} payment from ${payment.paid_on}?`)) return;
    const { error } = await supabase.from('supplier_payments').delete().eq('id', payment.id);
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg('Payment removed.');
    void load();
  }

  async function voidBill() {
    if (!bill || voidingRef.current) return;
    const reason = voidReason.trim();
    if (!reason) {
      setMsg('A reason is required.');
      return;
    }
    voidingRef.current = true;
    setVoiding(true);
    const { error } = await supabase.rpc('void_supplier_bill', { p_bill_id: bill.id, p_reason: reason });
    voidingRef.current = false;
    setVoiding(false);
    if (error) {
      setMsg(voidFailure(error.message));
      return;
    }
    setMsg(`${bill.bill_number} voided. The purchase order can now be cancelled.`);
    setShowVoid(false);
    setVoidReason('');
    void load();
  }

  if (!isAdmin && !isProcurement) {
    return <EmptyState title="No access" description="Supplier bills are visible to admins and procurement only." />;
  }
  if (missing || !bill) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate('/bills')}>
          <ChevronLeft size={16} aria-hidden />
          Bills
        </Button>
        {msg && <div className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">{msg}</div>}
        {missing ? <EmptyState title="Bill not found" description="This bill is not available." /> : <p className="text-sm text-stone-500">Loading…</p>}
      </div>
    );
  }

  const status = billStatus(bill.payment_status);
  const StatusIcon = status.icon;
  const invoiceText = invoices.join(', ');
  const payable = isAdmin && bill.payment_status !== 'void' && Number(bill.balance_rm) > 0;
  const canEdit = isAdmin && bill.payment_status !== 'void';
  const canVoid = isAdmin && bill.payment_status !== 'void' && Number(bill.paid_rm) <= 0;
  const payValid = Number(pay.amount_rm) > 0 && pay.paid_on;
  const editValid = edit.supplier_id && edit.entity_code && edit.bill_number.trim() && edit.bill_date && Number(edit.amount_rm) >= 0 && edit.amount_rm !== '';
  const ref = orderNo ?? bill.bill_number;

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={() => navigate('/bills')}>
        <ChevronLeft size={16} aria-hidden />
        Bills
      </Button>
      <PageHeader
        title={bill.supplier_name}
        description={`${ref}${invoiceText ? ` · ${invoiceText}` : ''} · due ${bill.due_date ?? '—'}`}
        actions={
          <span className="flex flex-col items-end gap-1">
            <span className="text-lg font-semibold tabular-nums">{Number(bill.balance_rm).toFixed(2)}</span>
            <Status tone={status.tone}>
              <StatusIcon size={12} aria-hidden />
              {status.label}
            </Status>
          </span>
        }
      />
      {msg && <div className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">{msg}</div>}
      <div className="rounded-xl border border-stone-200 bg-white p-4 text-sm text-stone-600">
        <p>Amount {Number(bill.amount_rm).toFixed(2)} · paid {Number(bill.paid_rm).toFixed(2)}</p>
        <p className="mt-1">{bill.entity_code} · {bill.bill_date}{bill.due_date ? ` · due ${bill.due_date}` : ''}</p>
        {orderNo && orderNo !== bill.bill_number ? <p className="mt-1">Bill {bill.bill_number}</p> : null}
        {invoiceText ? <p className="mt-1">Invoice {invoiceText}</p> : null}
        {notes ? <p className="mt-1">{notes}</p> : null}
        {bill.payment_status === 'void' && bill.void_reason ? <p className="mt-1 text-stone-400">Void · {bill.void_reason}</p> : null}
      </div>
      {lines.length > 0 ? (
        <ul className="ios-group">
          {lines.map((line) => {
            const item = itemNames[line.raw_material_id];
            const qty = Number(line.quantity_ordered) || 0;
            const price = Number(line.unit_price) || 0;
            const total = line.line_total != null ? Number(line.line_total) : qty * price;
            const received = Number(line.quantity_received) || 0;
            return (
              <li key={line.id} className="bg-white px-4 py-3 text-[15px] text-stone-700">
                {item?.name ?? 'Item'} · {qty}{item?.unit ? ` ${item.unit}` : ''} × {price.toFixed(2)} = {total.toFixed(2)}
                {received > 0 && received !== qty ? ` · received ${received}` : ''}
              </li>
            );
          })}
        </ul>
      ) : null}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-stone-700">Payments</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-stone-500">No payments yet.</p>
        ) : (
          <div className="ios-group">
            {payments.map((payment) => (
              <div key={payment.id} className="flex items-center justify-between gap-3 bg-white px-4 py-3">
                <span className="text-[15px] text-stone-700">
                  {Number(payment.amount_rm).toFixed(2)} · {payment.paid_on}
                </span>
                {isAdmin ? (
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center text-[15px] font-medium text-red-700"
                    onClick={() => void removePayment(payment)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
      {isAdmin ? (
        <div className="flex flex-wrap gap-2">
          {payable ? (
            <Button variant={showPay ? 'primary' : 'secondary'} onClick={openPay}>
              <Banknote size={16} aria-hidden />
              Record payment
            </Button>
          ) : null}
          {canEdit ? (
            <Button variant={showEdit ? 'primary' : 'secondary'} onClick={openEdit}>
              <Pencil size={16} aria-hidden />
              Edit
            </Button>
          ) : null}
          {canVoid ? (
            <Button variant={showVoid ? 'danger' : 'secondary'} onClick={() => { setShowVoid((open) => !open); setShowPay(false); setShowEdit(false); }}>
              <Ban size={16} aria-hidden />
              Void
            </Button>
          ) : null}
        </div>
      ) : null}
      {showPay ? (
        <div className="grid gap-2 rounded-xl border border-stone-200 bg-white p-3 text-sm sm:grid-cols-2" data-no-swipe>
          <input aria-label="Payment amount RM" inputMode="decimal" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Amount RM" value={pay.amount_rm} onChange={(e) => setPay({ ...pay, amount_rm: e.target.value })} />
          <input aria-label="Paid on" type="date" className="min-h-11 rounded-xl border border-stone-200 px-3" value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} />
          <select aria-label="Method" className="min-h-11 rounded-xl border border-stone-200 px-3" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method.replace('_', ' ')}</option>)}
          </select>
          <input aria-label="Reference" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
          <input aria-label="Attachment path" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Attachment (storage path)" value={pay.document_path} onChange={(e) => setPay({ ...pay, document_path: e.target.value })} />
          <input aria-label="Notes" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Notes" value={pay.notes} onChange={(e) => setPay({ ...pay, notes: e.target.value })} />
          <div className="flex gap-2">
            <Button disabled={!payValid} onClick={() => void recordPayment()}>Record payment</Button>
            <Button variant="ghost" onClick={() => setShowPay(false)}>Close</Button>
          </div>
        </div>
      ) : null}
      {showEdit ? (
        <div className="grid gap-2 rounded-xl border border-stone-200 bg-white p-3 text-sm sm:grid-cols-2" data-no-swipe>
          <select aria-label="Supplier" className="min-h-11 rounded-xl border border-stone-200 px-3" value={edit.supplier_id} onChange={(e) => setEdit({ ...edit, supplier_id: e.target.value })}>
            <option value="">Supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!suppliers.some((s) => s.id === edit.supplier_id) && edit.supplier_id ? <option value={edit.supplier_id}>{bill.supplier_name}</option> : null}
          </select>
          <select aria-label="Entity" className="min-h-11 rounded-xl border border-stone-200 px-3" value={edit.entity_code} onChange={(e) => setEdit({ ...edit, entity_code: e.target.value })}>
            <option value="">Entity…</option>
            {entities.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            {!entities.some((x) => x.code === edit.entity_code) && edit.entity_code ? <option value={edit.entity_code}>{edit.entity_code}</option> : null}
          </select>
          <input aria-label="Bill number" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Bill number" value={edit.bill_number} onChange={(e) => setEdit({ ...edit, bill_number: e.target.value })} />
          <input aria-label="Bill date" type="date" className="min-h-11 rounded-xl border border-stone-200 px-3" value={edit.bill_date} onChange={(e) => setEdit({ ...edit, bill_date: e.target.value })} />
          <input aria-label="Due date" type="date" className="min-h-11 rounded-xl border border-stone-200 px-3" value={edit.due_date} onChange={(e) => setEdit({ ...edit, due_date: e.target.value })} />
          <input aria-label="Amount RM" inputMode="decimal" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Amount RM" value={edit.amount_rm} onChange={(e) => setEdit({ ...edit, amount_rm: e.target.value })} />
          <input aria-label="Bill notes" className="min-h-11 rounded-xl border border-stone-200 px-3 sm:col-span-2" placeholder="Notes" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
          <div className="flex gap-2">
            <Button disabled={!editValid} onClick={() => void saveEdit()}>Save</Button>
            <Button variant="ghost" onClick={() => setShowEdit(false)}>Close</Button>
          </div>
        </div>
      ) : null}
      {showVoid ? (
        <div className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-white p-3" data-no-swipe>
          <input
            aria-label={`Void reason for ${bill.bill_number}`}
            className="min-h-11 rounded-xl border border-stone-200 px-3 text-[15px]"
            placeholder="Reason"
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="danger" disabled={voiding} onClick={() => void voidBill()}>
              <Ban size={16} aria-hidden />
              Void
            </Button>
            <Button variant="ghost" onClick={() => setShowVoid(false)}>Close</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
