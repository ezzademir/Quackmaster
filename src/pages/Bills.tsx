import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Ban, Banknote, Check, Circle, Plus, Receipt, Tag, type LucideIcon } from 'lucide-react';
import { Button, EmptyState, ListRow, PageHeader, Status, Tabs } from '../components/ui';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { defaultEntityCode, type MyEntity } from '../utils/procurementPayloads';
import { useRegisterRefresh } from '../utils/pageRefresh';

interface BillRow {
  id: string;
  entity_code: string;
  supplier_name: string;
  purchase_order_id: string | null;
  bill_number: string;
  bill_date: string;
  due_date: string | null;
  amount_rm: number;
  paid_rm: number;
  balance_rm: number;
  payment_status: 'paid' | 'overdue' | 'part_paid' | 'unpaid' | 'void';
}

interface BillLine {
  id: string;
  purchase_order_id: string;
  raw_material_id: string;
  quantity_ordered: number;
  quantity_received: number | null;
  unit_price: number;
  line_total: number | null;
}

interface ItemPrice {
  supplier_name: string | null;
  item_name: string | null;
  unit_of_measure: string | null;
  unit_price_rm: number;
  price_source: string;
  order_number: string | null;
}

interface PaymentRow {
  id: string;
  bill_id: string;
  amount_rm: number;
  paid_on: string;
}

type BillsTab = 'bills' | 'prices';

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

/** Supplier bills. Procurement records bills and sees payment status read-only; only admins record (part) payments into supplier_payments (DB-enforced). */
export function Bills() {
  const { isAdmin, isProcurement } = useAuth();
  const [rows, setRows] = useState<BillRow[]>([]);
  const [lines, setLines] = useState<BillLine[]>([]);
  const [prices, setPrices] = useState<ItemPrice[]>([]);
  const [orderNumbers, setOrderNumbers] = useState<Record<string, string>>({});
  const [invoiceNumbers, setInvoiceNumbers] = useState<Record<string, string[]>>({});
  const [itemNames, setItemNames] = useState<Record<string, { name: string; unit: string | null }>>({});
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [entities, setEntities] = useState<MyEntity[]>([]);
  const [form, setForm] = useState({ supplier_id: '', entity_code: '', bill_number: '', bill_date: '', due_date: '', amount_rm: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const emptyPay = { bill_id: '', amount_rm: '', paid_on: '', method: 'bank_transfer', reference: '', document_path: '', notes: '' };
  const [pay, setPay] = useState(emptyPay);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [voidReason, setVoidReason] = useState<Record<string, string>>({});
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const voidingRef = useRef<string | null>(null);
  const [tab, setTab] = useState<BillsTab>('bills');
  const [openBillId, setOpenBillId] = useState<string | null>(null);
  const [showBillForm, setShowBillForm] = useState(false);
  const [showPayForm, setShowPayForm] = useState(false);
  const payFormRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [b, s, e, p, priceRows, catalog] = await Promise.all([
      supabase.from('v_supplier_bill_status').select('*').order('bill_date', { ascending: false }),
      // only approved suppliers can be billed (085 _supplier_is_active)
      supabase.from('suppliers').select('id, name').eq('status', 'active').order('name'),
      // procurement cannot read business_entities; this view returns only the caller's own entities
      supabase.from('v_my_entities').select('code, name, procurement_tag').order('code'),
      supabase.from('supplier_payments').select('id, bill_id, amount_rm, paid_on').order('paid_on', { ascending: false }),
      supabase.from('v_supplier_order_prices').select('supplier_name, item_name, unit_of_measure, unit_price_rm, price_source, order_number').order('supplier_name').order('item_name'),
      supabase.from('v_raw_material_catalog').select('id, name, unit_of_measure'),
    ]);
    if (b.error) setMsg(b.error.message);
    else if (priceRows.error) setMsg(priceRows.error.message);
    const bills = (b.data ?? []) as BillRow[];
    setRows(bills);
    setPrices((priceRows.data ?? []) as ItemPrice[]);
    setPayments((p.data ?? []) as PaymentRow[]);
    setItemNames(Object.fromEntries(
      ((catalog.data ?? []) as Array<{ id: string; name: string; unit_of_measure: string | null }>).map((item) => [
        item.id,
        { name: item.name, unit: item.unit_of_measure },
      ]),
    ));
    const poIds = [...new Set(bills.map((bill) => bill.purchase_order_id).filter((id): id is string => Boolean(id)))];
    if (poIds.length === 0) {
      setLines([]);
      setOrderNumbers({});
      setInvoiceNumbers({});
    } else {
      const [lineRows, orderRows, receiptRows] = await Promise.all([
        supabase.from('purchase_order_items').select('id, purchase_order_id, raw_material_id, quantity_ordered, quantity_received, unit_price, line_total').in('purchase_order_id', poIds),
        supabase.from('purchase_orders').select('id, order_number').in('id', poIds),
        supabase.from('po_receipt_records').select('purchase_order_id, invoice_number, entered_at').in('purchase_order_id', poIds).order('entered_at'),
      ]);
      if (lineRows.error) setMsg(lineRows.error.message);
      else if (receiptRows.error) setMsg(receiptRows.error.message);
      setLines((lineRows.data ?? []) as BillLine[]);
      setOrderNumbers(Object.fromEntries(
        ((orderRows.data ?? []) as Array<{ id: string; order_number: string | null }>).map((order) => [order.id, order.order_number ?? order.id.slice(0, 8)]),
      ));
      const invoices: Record<string, string[]> = {};
      for (const receipt of (receiptRows.data ?? []) as Array<{ purchase_order_id: string; invoice_number: string | null }>) {
        const number = receipt.invoice_number?.trim();
        if (!number) continue;
        const seen = invoices[receipt.purchase_order_id] ?? [];
        if (!seen.includes(number)) seen.push(number);
        invoices[receipt.purchase_order_id] = seen;
      }
      setInvoiceNumbers(invoices);
    }
    setSuppliers((s.data ?? []) as Array<{ id: string; name: string }>);
    const ents = (e.data ?? []) as MyEntity[];
    setEntities(ents);
    setForm((f) => ({ ...f, entity_code: defaultEntityCode(ents, f.entity_code) }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (showPayForm) payFormRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showPayForm, pay.bill_id]);
  useRegisterRefresh(() => load());

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
    setShowBillForm(false);
    setForm({ supplier_id: '', entity_code: defaultEntityCode(entities), bill_number: '', bill_date: '', due_date: '', amount_rm: '' });
    void load();
  }

  function openPayment(bill: BillRow) {
    setPay({ ...emptyPay, bill_id: bill.id, amount_rm: Number(bill.balance_rm).toFixed(2) });
    setShowBillForm(false);
    setShowPayForm(true);
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
    setShowPayForm(false);
    setPay(emptyPay);
    void load();
  }

  async function voidBill(bill: BillRow) {
    if (voidingRef.current) return;
    const reason = (voidReason[bill.id] ?? '').trim();
    if (!reason) {
      setMsg('A reason is required.');
      return;
    }
    voidingRef.current = bill.id;
    setVoidingId(bill.id);
    const { error } = await supabase.rpc('void_supplier_bill', { p_bill_id: bill.id, p_reason: reason });
    voidingRef.current = null;
    setVoidingId(null);
    if (error) {
      setMsg(voidFailure(error.message));
      return;
    }
    setMsg(`${bill.bill_number} voided. The purchase order can now be cancelled.`);
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

  const payValid = pay.bill_id && Number(pay.amount_rm) > 0 && pay.paid_on;
  const valid = form.supplier_id && form.entity_code && form.bill_number.trim() && form.bill_date && Number(form.amount_rm) >= 0 && form.amount_rm !== '';

  if (!isAdmin && !isProcurement) {
    return <EmptyState title="No access" description="Supplier bills are visible to admins and procurement only." />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bills"
        description={isAdmin
          ? 'An accepted purchase order becomes a bill. Payment status is unpaid until you record a payment.'
          : 'An accepted purchase order becomes a bill. Payment status is read-only.'}
        actions={
          <>
            <Button
              variant={showBillForm ? 'primary' : 'secondary'}
              onClick={() => {
                setShowBillForm((open) => !open);
                setShowPayForm(false);
              }}
            >
              <Plus size={16} aria-hidden />
              Record bill
            </Button>
            {isAdmin ? (
              <Button
                variant={showPayForm ? 'primary' : 'secondary'}
                onClick={() => {
                  setShowPayForm((open) => !open);
                  setShowBillForm(false);
                }}
              >
                <Banknote size={16} aria-hidden />
                Record payment
              </Button>
            ) : null}
          </>
        }
      />
      {msg && <div className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">{msg}</div>}
      {showBillForm ? (
        <div className="grid gap-2 rounded-xl border border-stone-200 bg-white p-3 text-sm sm:grid-cols-3" data-no-swipe>
          <select aria-label="Supplier" className="min-h-11 rounded-xl border border-stone-200 px-3" value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
            <option value="">Supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select aria-label="Entity" className="min-h-11 rounded-xl border border-stone-200 px-3" value={form.entity_code} onChange={(e) => setForm({ ...form, entity_code: e.target.value })}>
            <option value="">Entity…</option>
            {entities.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </select>
          <input aria-label="Bill number" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Bill number" value={form.bill_number} onChange={(e) => setForm({ ...form, bill_number: e.target.value })} />
          <input aria-label="Bill date" type="date" className="min-h-11 rounded-xl border border-stone-200 px-3" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} />
          <input aria-label="Due date" type="date" className="min-h-11 rounded-xl border border-stone-200 px-3" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          <input aria-label="Amount RM" inputMode="decimal" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Amount RM" value={form.amount_rm} onChange={(e) => setForm({ ...form, amount_rm: e.target.value })} />
          <div className="flex gap-2">
            <Button disabled={!valid} onClick={() => void addBill()}>Record bill</Button>
            <Button variant="ghost" onClick={() => setShowBillForm(false)}>Close</Button>
          </div>
        </div>
      ) : null}
      {isAdmin && showPayForm ? (
        <div ref={payFormRef} className="grid gap-2 rounded-xl border border-stone-200 bg-white p-3 text-sm sm:grid-cols-4" data-no-swipe>
          <select aria-label="Bill to pay" className="min-h-11 rounded-xl border border-stone-200 px-3" value={pay.bill_id} onChange={(e) => setPay({ ...pay, bill_id: e.target.value })}>
            <option value="">Bill…</option>
            {rows.filter((r) => r.payment_status !== 'void' && Number(r.balance_rm) > 0).map((r) => (
              <option key={r.id} value={r.id}>{r.supplier_name} {r.bill_number} (bal {Number(r.balance_rm).toFixed(2)})</option>
            ))}
          </select>
          <input aria-label="Payment amount RM" inputMode="decimal" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Amount RM" value={pay.amount_rm} onChange={(e) => setPay({ ...pay, amount_rm: e.target.value })} />
          <input aria-label="Paid on" type="date" className="min-h-11 rounded-xl border border-stone-200 px-3" value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} />
          <select aria-label="Method" className="min-h-11 rounded-xl border border-stone-200 px-3" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
            {['bank_transfer', 'cash', 'cheque', 'card', 'duitnow', 'other'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
          <input aria-label="Reference" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
          <input aria-label="Attachment path" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Attachment (storage path)" value={pay.document_path} onChange={(e) => setPay({ ...pay, document_path: e.target.value })} />
          <input aria-label="Notes" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Notes" value={pay.notes} onChange={(e) => setPay({ ...pay, notes: e.target.value })} />
          <div className="flex gap-2">
            <Button disabled={!payValid} onClick={() => void recordPayment()}>Record payment</Button>
            <Button variant="ghost" onClick={() => setShowPayForm(false)}>Close</Button>
          </div>
        </div>
      ) : null}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            id: 'bills',
            label: <span className="inline-flex items-center gap-1.5"><Receipt size={14} aria-hidden /> Bills</span>,
          },
          {
            id: 'prices',
            label: <span className="inline-flex items-center gap-1.5"><Tag size={14} aria-hidden /> Item prices</span>,
          },
        ]}
      />
      {tab === 'prices' ? (
        prices.length === 0 ? (
          <EmptyState title="No item prices" description="Prices appear here after an order is accepted, one price for each item from each supplier." />
        ) : (
          <div className="ios-group">
            {prices.map((price) => (
              <ListRow
                key={`${price.supplier_name}-${price.item_name}-${price.order_number}`}
                title={
                  <span className="inline-flex items-center gap-2">
                    <Tag size={16} className="shrink-0 text-stone-400" aria-hidden />
                    {price.item_name ?? 'Item'} · {price.supplier_name ?? 'Supplier'}
                  </span>
                }
                meta={`${price.order_number ?? '—'} · ${price.price_source === 'invoice' ? 'Invoice' : 'Order'}${price.unit_of_measure ? ` · ${price.unit_of_measure}` : ''}`}
                aside={<span className="font-medium tabular-nums">{Number(price.unit_price_rm).toFixed(2)}</span>}
              />
            ))}
          </div>
        )
      ) : rows.length === 0 ? (
        <EmptyState title="No bills" description="Accept a purchase order, or record a supplier invoice that is not an order." />
      ) : (
        <div className="ios-group">
          {rows.map((r) => {
            const orderNo = r.purchase_order_id ? orderNumbers[r.purchase_order_id] : null;
            const billLines = r.purchase_order_id ? lines.filter((line) => line.purchase_order_id === r.purchase_order_id) : [];
            const invoices = r.purchase_order_id ? (invoiceNumbers[r.purchase_order_id] ?? []) : [];
            const invoiceText = invoices.join(', ');
            const status = billStatus(r.payment_status);
            const StatusIcon = status.icon;
            const open = openBillId === r.id;
            const payable = isAdmin && r.payment_status !== 'void' && Number(r.balance_rm) > 0;
            return (
              <ListRow
                key={r.id}
                onClick={() => setOpenBillId(open ? null : r.id)}
                title={
                  <span className="inline-flex items-center gap-2">
                    <Receipt size={16} className="shrink-0 text-stone-400" aria-hidden />
                    {r.supplier_name}
                  </span>
                }
                meta={`${orderNo ?? r.bill_number}${invoiceText ? ` · ${invoiceText}` : ''} · due ${r.due_date ?? '—'}`}
                aside={
                  <span className="flex flex-col items-end gap-1">
                    <span className="font-medium tabular-nums">{Number(r.balance_rm).toFixed(2)}</span>
                    <Status tone={status.tone}>
                      <StatusIcon size={12} aria-hidden />
                      {status.label}
                    </Status>
                  </span>
                }
                body={open || payable ? (
                  <div className="space-y-2">
                    {open ? (
                      <p className="text-[13px] text-stone-500">
                        Amount {Number(r.amount_rm).toFixed(2)} · paid {Number(r.paid_rm).toFixed(2)}
                        {invoiceText ? ` · ${invoiceText}` : ''}
                        {orderNo && orderNo !== r.bill_number ? ` · ${r.bill_number}` : ''}
                      </p>
                    ) : null}
                    {open && billLines.length > 0 ? (
                      <ul className="space-y-1 text-[13px] text-stone-600">
                        {billLines.map((line) => {
                          const item = itemNames[line.raw_material_id];
                          const qty = Number(line.quantity_ordered) || 0;
                          const price = Number(line.unit_price) || 0;
                          const total = line.line_total != null ? Number(line.line_total) : qty * price;
                          const received = Number(line.quantity_received) || 0;
                          return (
                            <li key={line.id}>
                              {item?.name ?? 'Item'} · {qty}{item?.unit ? ` ${item.unit}` : ''} × {price.toFixed(2)} = {total.toFixed(2)}
                              {received > 0 && received !== qty ? ` · received ${received}` : ''}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    {open && isAdmin && r.payment_status === 'void' ? <p className="text-[13px] text-stone-400">Void</p> : null}
                    {payable ? (
                      <Button variant="secondary" onClick={() => openPayment(r)}>
                        <Banknote size={16} aria-hidden />
                        Record payment
                      </Button>
                    ) : null}
                    {open && isAdmin && r.payment_status !== 'void' && Number(r.paid_rm) > 0 ? (
                      <div className="space-y-1">
                        <p className="text-[13px] text-stone-500">Remove payments before voiding.</p>
                        {payments.filter((payment) => payment.bill_id === r.id).map((payment) => (
                          <button
                            key={payment.id}
                            type="button"
                            className="inline-flex min-h-11 items-center text-[15px] font-medium text-red-700"
                            onClick={() => void removePayment(payment)}
                          >
                            Remove {Number(payment.amount_rm).toFixed(2)} ({payment.paid_on})
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {open && isAdmin && r.payment_status !== 'void' && Number(r.paid_rm) <= 0 ? (
                      <div className="flex flex-col gap-2" data-no-swipe>
                        <input
                          aria-label={`Void reason for ${r.bill_number}`}
                          className="min-h-11 rounded-xl border border-stone-200 px-3 text-[15px]"
                          placeholder="Reason"
                          value={voidReason[r.id] ?? ''}
                          onChange={(event) => setVoidReason((current) => ({ ...current, [r.id]: event.target.value }))}
                        />
                        <Button variant="danger" disabled={voidingId !== null} onClick={() => void voidBill(r)}>
                          <Ban size={16} aria-hidden />
                          Void
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
