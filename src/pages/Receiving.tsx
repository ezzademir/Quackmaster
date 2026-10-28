import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, ListRow, PageHeader } from '../components/ui';
import { supabase } from '../utils/supabase';
import { buildDeliveryLines, receivingErrorMessage } from '../utils/receiving';
import { receivingUom } from '../utils/procurementPayloads';
import { useRegisterRefresh } from '../utils/pageRefresh';

interface PoItem {
  id: string;
  quantity_ordered: number;
  quantity_received: number | null;
  unit_price: number | null;
  purchase_uom: string | null;
  raw_material_id: string;
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
  const [catalog, setCatalog] = useState<Record<string, { name: string; unit_of_measure: string | null }>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, { qty: string; price: string }>>({});
  const [doNo, setDoNo] = useState('');
  const [invNo, setInvNo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('id, order_number, status, entity_code, suppliers(name), purchase_order_items(id, quantity_ordered, quantity_received, unit_price, purchase_uom, raw_material_id)')
      .in('status', ['ordered', 'partial'])
      .order('created_at', { ascending: false });
    if (error) setMsg(error.message);
    else setPos((data ?? []) as unknown as Po[]);
    // names / units from the cost-free catalogue (procurement cannot read raw_materials)
    const cat = await supabase.from('v_raw_material_catalog').select('id, name, unit_of_measure');
    setCatalog(Object.fromEntries(((cat.data ?? []) as Array<{ id: string; name: string; unit_of_measure: string | null }>).map((m) => [m.id, m])));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterRefresh(() => load());

  async function submit(po: Po) {
    // the screen asks for what arrived in THIS delivery; the server wants the new cumulative total per line
    const p_lines = buildDeliveryLines(
      po.purchase_order_items.map((i) => ({
        id: i.id,
        quantity_received: i.quantity_received,
        // unit recorded with the receipt: the PO line's own unit as-is (server compares it with the line), else the normalised catalogue unit
        uom: receivingUom(i.purchase_uom, catalog[i.raw_material_id]?.unit_of_measure),
      })),
      lines,
    );
    if (p_lines.length === 0) {
      setMsg('Enter the quantity that arrived on at least one line.');
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('record_po_delivery', {
      p_po_id: po.id,
      p_lines,
      p_do_number: doNo || null,
      p_invoice_number: invNo || null,
    });
    setBusy(false);
    const res = data as { success?: boolean; error?: string; message?: string; current_received?: number } | null;
    if (error || !res?.success) {
      setMsg(error?.message ?? receivingErrorMessage(res, 'Receipt failed'));
      if (res?.error === 'stale_received_quantity') void load();
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
      <PageHeader title="Receiving" description="Record deliveries against ordered POs. Enter only what arrived in this delivery; a DO number or invoice number is required." />
      {msg && <div className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">{msg}</div>}
      {pos.length === 0 ? (
        <EmptyState title="Nothing to receive" description="No ordered or part-received POs in your entities." />
      ) : (
        <div className="ios-group">
        {pos.map((po) => (
          <ListRow
            key={po.id}
            title={`${po.order_number ?? po.id.slice(0, 8)} · ${po.suppliers?.name ?? '-'}`}
            meta={`${po.entity_code ?? 'untagged'} · ${po.status}`}
            onClick={() => setOpen(open === po.id ? null : po.id)}
            body={open === po.id ? (
              <div className="space-y-2" data-no-swipe>
                {po.purchase_order_items.map((i) => (
                  <div key={i.id} className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[1fr_8rem_7rem] sm:items-center">
                    <span>
                      {catalog[i.raw_material_id]?.name ?? 'Item'} ({i.quantity_received ?? 0}/{i.quantity_ordered} {catalog[i.raw_material_id]?.unit_of_measure ?? ''})
                    </span>
                    <input aria-label="Quantity in this delivery" inputMode="decimal" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Qty this delivery"
                      value={lines[i.id]?.qty ?? ''} onChange={(e) => setLines({ ...lines, [i.id]: { qty: e.target.value, price: lines[i.id]?.price ?? '' } })} />
                    <input aria-label="Invoice unit price" inputMode="decimal" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Invoice RM"
                      value={lines[i.id]?.price ?? ''} onChange={(e) => setLines({ ...lines, [i.id]: { qty: lines[i.id]?.qty ?? '', price: e.target.value } })} />
                  </div>
                ))}
                <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <input aria-label="DO number" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="DO number" value={doNo} onChange={(e) => setDoNo(e.target.value)} />
                  <input aria-label="Invoice number" className="min-h-11 rounded-xl border border-stone-200 px-3" placeholder="Invoice number" value={invNo} onChange={(e) => setInvNo(e.target.value)} />
                </div>
                <Button disabled={busy || (!doNo && !invNo)} onClick={() => void submit(po)}>Record delivery</Button>
              </div>
            ) : null}
          />
        ))}
        </div>
      )}
    </div>
  );
}
