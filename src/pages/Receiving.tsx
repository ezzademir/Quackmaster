import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, PageHeader } from '../components/ui';
import { supabase } from '../utils/supabase';

interface PoItem {
  id: string;
  quantity_ordered: number;
  quantity_received: number | null;
  unit_price: number | null;
  raw_materials: { name: string; unit: string | null } | null;
}
interface Po {
  id: string;
  order_number: string | null;
  status: string;
  entity_code: string | null;
  suppliers: { name: string } | null;
  purchase_order_items: PoItem[];
}

/** Receive deliveries against ordered POs (qty, invoice price, DO / invoice ref). Server: record_po_delivery. */
export function Receiving() {
  const [pos, setPos] = useState<Po[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, { qty: string; price: string }>>({});
  const [doNo, setDoNo] = useState('');
  const [invNo, setInvNo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('id, order_number, status, entity_code, suppliers(name), purchase_order_items(id, quantity_ordered, quantity_received, unit_price, raw_materials(name, unit))')
      .in('status', ['ordered', 'partial'])
      .order('created_at', { ascending: false });
    if (error) setMsg(error.message);
    else setPos((data ?? []) as unknown as Po[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(po: Po) {
    const p_lines = po.purchase_order_items
      .filter((i) => Number(lines[i.id]?.qty) > 0)
      .map((i) => ({
        purchase_order_item_id: i.id,
        quantity_received: Number(lines[i.id].qty),
        ...(lines[i.id].price !== '' && lines[i.id].price !== undefined ? { invoice_unit_price: Number(lines[i.id].price) } : {}),
      }));
    setBusy(true);
    const { data, error } = await supabase.rpc('record_po_delivery', {
      p_po_id: po.id,
      p_lines,
      p_do_number: doNo || null,
      p_invoice_number: invNo || null,
    });
    setBusy(false);
    const res = data as { success?: boolean; error?: string } | null;
    if (error || !res?.success) {
      setMsg(error?.message ?? res?.error ?? 'Receipt failed');
      return;
    }
    setMsg('Delivery recorded.');
    setOpen(null);
    setLines({});
    setDoNo('');
    setInvNo('');
    void load();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Receiving" description="Record deliveries against ordered POs. A DO number or invoice number is required." />
      {msg && <div className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">{msg}</div>}
      {pos.length === 0 ? (
        <EmptyState title="Nothing to receive" description="No ordered or part-received POs in your entities." />
      ) : (
        pos.map((po) => (
          <div key={po.id} className="rounded-xl border border-stone-200 bg-white p-3">
            <button type="button" className="flex w-full justify-between text-left" onClick={() => setOpen(open === po.id ? null : po.id)}>
              <span className="font-medium">{po.order_number ?? po.id.slice(0, 8)} · {po.suppliers?.name ?? '-'}</span>
              <span className="text-xs text-stone-500">{po.entity_code ?? 'untagged'} · {po.status}</span>
            </button>
            {open === po.id && (
              <div className="mt-3 space-y-2">
                {po.purchase_order_items.map((i) => (
                  <div key={i.id} className="grid grid-cols-[1fr_6rem_7rem] items-center gap-2 text-sm">
                    <span>
                      {i.raw_materials?.name ?? 'Item'} ({i.quantity_received ?? 0}/{i.quantity_ordered} {i.raw_materials?.unit ?? ''})
                    </span>
                    <input aria-label="Quantity received" inputMode="decimal" className="rounded border px-2 py-1" placeholder="Qty"
                      value={lines[i.id]?.qty ?? ''} onChange={(e) => setLines({ ...lines, [i.id]: { qty: e.target.value, price: lines[i.id]?.price ?? '' } })} />
                    <input aria-label="Invoice unit price" inputMode="decimal" className="rounded border px-2 py-1" placeholder="Invoice RM"
                      value={lines[i.id]?.price ?? ''} onChange={(e) => setLines({ ...lines, [i.id]: { qty: lines[i.id]?.qty ?? '', price: e.target.value } })} />
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <input aria-label="DO number" className="rounded border px-2 py-1" placeholder="DO number" value={doNo} onChange={(e) => setDoNo(e.target.value)} />
                  <input aria-label="Invoice number" className="rounded border px-2 py-1" placeholder="Invoice number" value={invNo} onChange={(e) => setInvNo(e.target.value)} />
                </div>
                <Button disabled={busy || (!doNo && !invNo)} onClick={() => void submit(po)}>Record delivery</Button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
