import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { supabase } from '../utils/supabase';
import {
  invokeStorehub,
  type StorehubProduct,
  type StorehubStore,
  type StorehubSyncEvent,
  type StorehubSyncRun,
} from '../utils/storehubSync';
type OutletOpt = { id: string; name: string };

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function StorehubSettings() {
  const [outlets, setOutlets] = useState<OutletOpt[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [lastRun, setLastRun] = useState<StorehubSyncRun | null>(null);
  const [lastSuccessTo, setLastSuccessTo] = useState<string | null>(null);
  const [stores, setStores] = useState<StorehubStore[]>([]);
  const [products, setProducts] = useState<StorehubProduct[]>([]);
  const [storeOutlet, setStoreOutlet] = useState<Record<string, string>>({});
  const [productSku, setProductSku] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<StorehubSyncEvent[]>([]);
  const [from, setFrom] = useState(daysAgoIso(6));
  const [to, setTo] = useState(todayIso());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  async function loadLocal() {
    const [{ data: outs }, { data: sm }, { data: pm }, { data: ev }] = await Promise.all([
      supabase.from('outlets').select('id, name').order('name'),
      supabase.from('storehub_store_map').select('storehub_store_id, outlet_id, storehub_store_name'),
      supabase.from('storehub_product_map').select('storehub_product_id, quackmaster_sku, storehub_sku, storehub_name'),
      supabase
        .from('storehub_sync_events')
        .select('id, ref_id, invoice_number, event_type, status, error, outlet_id, created_at, payload')
        .in('status', ['failed', 'needs_review'])
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    setOutlets((outs ?? []) as OutletOpt[]);
    const storeDraft: Record<string, string> = {};
    const storeList: StorehubStore[] = [];
    for (const row of sm ?? []) {
      storeDraft[row.storehub_store_id as string] = row.outlet_id as string;
      storeList.push({
        id: row.storehub_store_id as string,
        name: (row.storehub_store_name as string) || (row.storehub_store_id as string),
      });
    }
    setStoreOutlet((prev) => ({ ...storeDraft, ...prev }));
    if (storeList.length) {
      setStores((prev) => (prev.length ? prev : storeList));
    }
    const skuDraft: Record<string, string> = {};
    const productList: StorehubProduct[] = [];
    for (const row of pm ?? []) {
      skuDraft[row.storehub_product_id as string] = row.quackmaster_sku as string;
      productList.push({
        id: row.storehub_product_id as string,
        name: (row.storehub_name as string) || '',
        sku: (row.storehub_sku as string) || '',
        isParentProduct: false,
      });
    }
    setProductSku((prev) => ({ ...skuDraft, ...prev }));
    if (productList.length) {
      setProducts((prev) => (prev.length ? prev : productList));
    }
    setEvents((ev ?? []) as StorehubSyncEvent[]);
  }

  async function loadStatus() {
    const { data, error } = await invokeStorehub<{
      configured: boolean;
      lastRun: StorehubSyncRun | null;
      lastSuccessTo: string | null;
    }>('status');
    if (error && !data) {
      setNotice({ tone: 'err', text: error });
      return;
    }
    setConfigured(Boolean(data?.configured));
    setLastRun(data?.lastRun ?? null);
    setLastSuccessTo(data?.lastSuccessTo ?? null);
  }

  useEffect(() => {
    void loadLocal();
    void loadStatus();
  }, []);

  async function loadCatalog() {
    setBusy('catalog');
    setNotice(null);
    const { data, error } = await invokeStorehub<{ stores: StorehubStore[]; products: StorehubProduct[] }>(
      'catalog'
    );
    setBusy(null);
    if (error || !data) {
      setNotice({ tone: 'err', text: error ?? 'Could not load StoreHub catalog.' });
      return;
    }
    setStores(data.stores);
    setProducts(data.products.filter((p) => !p.isParentProduct));
    setProductSku((prev) => {
      const next = { ...prev };
      for (const p of data.products) {
        if (!next[p.id] && p.sku.trim()) next[p.id] = p.sku.trim();
      }
      return next;
    });
    setNotice({ tone: 'ok', text: `Loaded ${data.stores.length} stores and ${data.products.length} products.` });
  }

  async function saveMaps() {
    setBusy('save');
    setNotice(null);
    try {
      const storeRows = stores
        .filter((s) => storeOutlet[s.id])
        .map((s) => ({
          storehub_store_id: s.id,
          outlet_id: storeOutlet[s.id],
          storehub_store_name: s.name,
          updated_at: new Date().toISOString(),
        }));
      const productRows = products
        .filter((p) => (productSku[p.id] ?? '').trim())
        .map((p) => ({
          storehub_product_id: p.id,
          quackmaster_sku: productSku[p.id].trim(),
          storehub_sku: p.sku || null,
          storehub_name: p.name || null,
          updated_at: new Date().toISOString(),
        }));
      if (storeRows.length === 0) {
        throw new Error('Pick an outlet for at least one StoreHub store, then Save maps.');
      }
      const { error: storeErr } = await supabase.from('storehub_store_map').upsert(storeRows);
      if (storeErr) throw storeErr;
      if (productRows.length === 0) {
        throw new Error('Enter a Quackmaster SKU for at least one product (e.g. QUACKTEOW), then Save maps.');
      }
      const { error: productErr } = await supabase.from('storehub_product_map').upsert(productRows);
      if (productErr) throw productErr;
      setNotice({
        tone: 'ok',
        text: `Saved ${storeRows.length} store map(s) and ${productRows.length} product map(s).`,
      });
      await loadLocal();
    } catch (e) {
      setNotice({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const mappedStoreCount = Object.values(storeOutlet).filter(Boolean).length;
  const mappedProductCount = Object.values(productSku).filter((v) => v.trim()).length;

  async function runSync() {
    if (mappedStoreCount === 0 || mappedProductCount === 0) {
      setNotice({
        tone: 'err',
        text: 'Map stores to outlets and products to SKUs, click Save maps, then Sync now.',
      });
      return;
    }
    setBusy('sync');
    setNotice(null);
    const { data, error } = await invokeStorehub<{
      sales_ingested?: number;
      cancelled?: number;
      returns_flagged?: number;
      failed?: number;
      from?: string;
      to?: string;
      error?: string;
    }>('sync', { from, to });
    setBusy(null);
    if (error) {
      setNotice({ tone: 'err', text: error });
      await loadStatus();
      await loadLocal();
      return;
    }
    setNotice({
      tone: 'ok',
      text: `Sync ${data?.from} → ${data?.to}: ${data?.sales_ingested ?? 0} sales, ${data?.cancelled ?? 0} cancelled, ${data?.returns_flagged ?? 0} returns to review, ${data?.failed ?? 0} failed.`,
    });
    await loadStatus();
    await loadLocal();
  }

  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/30 p-5 shadow-sm space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900">StoreHub POS sync</h2>
        <p className="mt-1 text-sm text-gray-600">
          Pull cashier sales into Quackmaster FIFO journals. StoreHub stock is cashier-facing only; lots and
          counts stay here. Secrets live on the Edge Function, not in this app.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${
            configured ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
          }`}
        >
          {configured == null ? 'Checking connection…' : configured ? 'API secrets set' : 'API secrets missing'}
        </span>
        {lastSuccessTo && <span className="text-gray-500">Last window through {lastSuccessTo}</span>}
      </div>

      {lastRun && (
        <p className="text-xs text-gray-600">
          Last run {new Date(lastRun.started_at).toLocaleString('en-MY')}: {lastRun.sales_ingested} ingested,{' '}
          {lastRun.failed} failed
          {lastRun.error ? ` — ${lastRun.error}` : ''}
        </p>
      )}

      {notice && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === 'ok' ? 'border-green-200 bg-green-50 text-green-900' : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void loadCatalog()}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
        >
          <RefreshCw size={14} className={busy === 'catalog' ? 'animate-spin' : ''} />
          {busy === 'catalog' ? 'Loading catalog…' : 'Load stores & products'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void saveMaps()}
          className="rounded-lg border border-teal-700 px-3 py-2 text-sm font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-60"
        >
          {busy === 'save' ? 'Saving…' : 'Save maps'}
        </button>
      </div>

      {stores.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-gray-800">Stores → outlets</h3>
          <ul className="space-y-2">
            {stores.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-[8rem] font-medium text-gray-800">{s.name}</span>
                <select
                  value={storeOutlet[s.id] ?? ''}
                  onChange={(e) => setStoreOutlet((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                >
                  <option value="">— not mapped —</option>
                  {outlets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}

      {products.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-gray-800">Products → Quackmaster SKU</h3>
          <p className="mb-2 text-xs text-gray-500">Use the recipe SKU (e.g. QUACKTEOW), not the printable lot code.</p>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-600">StoreHub</th>
                  <th className="px-3 py-2 font-medium text-gray-600">POS SKU</th>
                  <th className="px-3 py-2 font-medium text-gray-600">Quackmaster SKU</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {products.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-1.5 text-gray-800">{p.name || p.id}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-500">{p.sku || '—'}</td>
                    <td className="px-3 py-1.5">
                      <input
                        value={productSku[p.id] ?? ''}
                        onChange={(e) => setProductSku((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder="QUACKTEOW"
                        className="w-full rounded border border-gray-200 px-2 py-1 font-mono"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 border-t border-teal-100 pt-4">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void runSync()}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
        >
          {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </button>
        <p className="text-xs text-gray-500">
          {mappedStoreCount} store{mappedStoreCount === 1 ? '' : 's'} and {mappedProductCount} product
          {mappedProductCount === 1 ? '' : 's'} mapped — save before syncing.
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-800">Failed / needs review</h3>
        {events.length === 0 ? (
          <p className="text-xs text-gray-500">No failed or return-review events.</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {events.map((ev) => (
              <li key={ev.id} className="rounded border border-gray-200 bg-white px-3 py-2">
                <span className="font-semibold uppercase text-gray-700">{ev.status}</span>
                {ev.invoice_number ? ` · ${ev.invoice_number}` : ''}
                {ev.error ? ` · ${ev.error}` : ''}
                <span className="mt-0.5 block text-gray-400">{new Date(ev.created_at).toLocaleString('en-MY')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
