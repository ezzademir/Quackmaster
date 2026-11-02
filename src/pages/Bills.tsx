import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Ban, Banknote, Check, Circle, Plus, Receipt, Search, Tag, type LucideIcon } from 'lucide-react';
import { DateFilter } from '../components/DateFilter';
import { Button, EmptyState, ListRow, PageHeader, Status, Tabs } from '../components/ui';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { isCalendarDateInRange, type DateRange } from '../utils/dateRange';
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

interface ItemPrice {
  supplier_name: string | null;
  item_name: string | null;
  unit_of_measure: string | null;
  unit_price_rm: number;
  price_source: string;
  order_number: string | null;
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

/** Supplier bills. Procurement records bills and sees payment status read-only; only admins record (part) payments into supplier_payments (DB-enforced). */
export function Bills() {
  const navigate = useNavigate();
  const { isAdmin, isProcurement } = useAuth();
  const [rows, setRows] = useState<BillRow[]>([]);
  const [prices, setPrices] = useState<ItemPrice[]>([]);
  const [orderNumbers, setOrderNumbers] = useState<Record<string, string>>({});
  const [invoiceNumbers, setInvoiceNumbers] = useState<Record<string, string[]>>({});
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [entities, setEntities] = useState<MyEntity[]>([]);
  const [form, setForm] = useState({ supplier_id: '', entity_code: '', bill_number: '', bill_date: '', due_date: '', amount_rm: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<BillsTab>('bills');
  const [showBillForm, setShowBillForm] = useState(false);
  const [query, setQuery] = useState('');
  const [showUnpaid, setShowUnpaid] = useState(true);
  const [showPaid, setShowPaid] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);

  const load = useCallback(async () => {
    const [b, s, e, priceRows] = await Promise.all([
      supabase.from('v_supplier_bill_status').select('*').order('bill_date', { ascending: false }),
      // only approved suppliers can be billed (085 _supplier_is_active)
      supabase.from('suppliers').select('id, name').eq('status', 'active').order('name'),
      // procurement cannot read business_entities; this view returns only the caller's own entities
      supabase.from('v_my_entities').select('code, name, procurement_tag').order('code'),
      supabase.from('v_supplier_order_prices').select('supplier_name, item_name, unit_of_measure, unit_price_rm, price_source, order_number').order('supplier_name').order('item_name'),
    ]);
    if (b.error) setMsg(b.error.message);
    else if (priceRows.error) setMsg(priceRows.error.message);
    const bills = (b.data ?? []) as BillRow[];
    setRows(bills);
    setPrices((priceRows.data ?? []) as ItemPrice[]);
    const poIds = [...new Set(bills.map((bill) => bill.purchase_order_id).filter((id): id is string => Boolean(id)))];
    if (poIds.length === 0) {
      setOrderNumbers({});
      setInvoiceNumbers({});
    } else {
      const [orderRows, receiptRows] = await Promise.all([
        supabase.from('purchase_orders').select('id, order_number').in('id', poIds),
        supabase.from('po_receipt_records').select('purchase_order_id, invoice_number, entered_at').in('purchase_order_id', poIds).order('entered_at'),
      ]);
      if (receiptRows.error) setMsg(receiptRows.error.message);
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

  const valid = form.supplier_id && form.entity_code && form.bill_number.trim() && form.bill_date && Number(form.amount_rm) >= 0 && form.amount_rm !== '';
  const needle = query.trim().toLowerCase();
  const visibleBills = useMemo(() => rows.filter((bill) => {
    const orderNo = bill.purchase_order_id ? orderNumbers[bill.purchase_order_id] : null;
    const invoices = bill.purchase_order_id ? (invoiceNumbers[bill.purchase_order_id] ?? []) : [];
    if (dateRange && !isCalendarDateInRange(bill.bill_date, dateRange)) return false;
    const status = billStatus(bill.payment_status);
    const settled = bill.payment_status === 'paid' || bill.payment_status === 'void';
    if (settled ? !showPaid : !showUnpaid) return false;
    if (!needle) return true;
    const haystack = [
      bill.supplier_name, bill.bill_number, bill.entity_code, orderNo, status.label, bill.due_date,
      Number(bill.amount_rm).toFixed(2), Number(bill.balance_rm).toFixed(2), Number(bill.paid_rm).toFixed(2),
      ...invoices,
    ];
    return haystack.some((part) => (part ?? '').toLowerCase().includes(needle));
  }), [rows, orderNumbers, invoiceNumbers, needle, showUnpaid, showPaid, dateRange]);
  const visiblePrices = useMemo(() => prices.filter((price) => {
    if (!needle) return true;
    const haystack = [price.supplier_name, price.item_name, price.order_number, price.unit_of_measure, price.price_source, Number(price.unit_price_rm).toFixed(2)];
    return haystack.some((part) => (part ?? '').toLowerCase().includes(needle));
  }), [prices, needle]);

  if (!isAdmin && !isProcurement) {
    return <EmptyState title="No access" description="Supplier bills are visible to admins and procurement only." />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bills"
        description={isAdmin
          ? 'Open a bill to record a payment, edit it, or void it.'
          : 'An accepted purchase order becomes a bill. Payment status is read-only.'}
        actions={
          <Button
            variant={showBillForm ? 'primary' : 'secondary'}
            onClick={() => setShowBillForm((open) => !open)}
          >
            <Plus size={16} aria-hidden />
            Record bill
          </Button>
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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
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
        {tab === 'bills' ? (
          <DateFilter
            onFilterChange={(range) => setDateRange(range)}
            hint="Filters bills by bill date."
          />
        ) : null}
      </div>
      {tab === 'bills' ? (
        <div className="flex flex-wrap gap-x-4" data-no-swipe>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={showUnpaid} onChange={(event) => setShowUnpaid(event.target.checked)} />
            Unpaid
          </label>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={showPaid} onChange={(event) => setShowPaid(event.target.checked)} />
            Paid
          </label>
        </div>
      ) : null}
      <div className="relative" data-no-swipe>
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" aria-hidden />
        <input
          aria-label="Search bills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search supplier, invoice, PO, or amount"
          className="min-h-11 w-full rounded-xl border border-stone-200 bg-white py-2 pl-9 pr-3 text-sm"
        />
      </div>
      {tab === 'prices' ? (
        prices.length === 0 ? (
          <EmptyState title="No item prices" description="Prices appear here after an order is accepted, one price for each item from each supplier." />
        ) : visiblePrices.length === 0 ? (
          <EmptyState title="No matches" description="Try a supplier, item, or order number." />
        ) : (
          <div className="ios-group">
            {visiblePrices.map((price) => (
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
      ) : visibleBills.length === 0 ? (
        <EmptyState
          title="No matches"
          description={needle
            ? 'Try a supplier, invoice number, purchase order number, or amount.'
            : !showUnpaid && !showPaid
              ? 'Tick Unpaid or Paid to show those bills.'
              : 'Nothing in this view.'}
        />
      ) : (
        <div className="ios-group">
          {visibleBills.map((r) => {
            const orderNo = r.purchase_order_id ? orderNumbers[r.purchase_order_id] : null;
            const invoices = r.purchase_order_id ? (invoiceNumbers[r.purchase_order_id] ?? []) : [];
            const invoiceText = invoices.join(', ');
            const status = billStatus(r.payment_status);
            const StatusIcon = status.icon;
            return (
              <ListRow
                key={r.id}
                onClick={() => navigate(`/bills/${r.id}`)}
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
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
