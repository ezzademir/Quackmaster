import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { supabase } from '../utils/supabase';

interface LotRow {
  id: string;
  product_batch_label: string;
  expiry_date: string | null;
  manufactured_at: string | null;
  parent_lot_id: string | null;
  purchase_order_item_id: string | null;
  production_run_id: string | null;
  created_at?: string;
}

interface LotDetail {
  hubQty: number;
  outletQty: number;
  runNumber?: string | null;
  recentSales: number;
}

export function Genealogy() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [lots, setLots] = useState<LotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LotDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('inventory_lots')
        .select(
          'id, product_batch_label, expiry_date, manufactured_at, parent_lot_id, purchase_order_item_id, production_run_id, created_at'
        )
        .order('created_at', { ascending: false })
        .limit(500);
      if (!cancelled) {
        setLots((data ?? []) as LotRow[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [{ data: hub }, { data: outlet }, { data: run }, { data: sales }] = await Promise.all([
        supabase.from('hub_inventory').select('quantity_on_hand').eq('lot_id', selectedId),
        supabase.from('outlet_inventory').select('quantity_on_hand').eq('lot_id', selectedId),
        supabase
          .from('production_runs')
          .select('run_number')
          .eq('id', lots.find((l) => l.id === selectedId)?.production_run_id ?? '00000000-0000-0000-0000-000000000000')
          .maybeSingle(),
        supabase
          .from('sales_journal_lines')
          .select('quantity_sold, outlet_inventory:outlet_inventory_id(lot_id)')
          .limit(200),
      ]);
      if (cancelled) return;
      const hubQty = (hub ?? []).reduce((a, r) => a + Number(r.quantity_on_hand ?? 0), 0);
      const outletQty = (outlet ?? []).reduce((a, r) => a + Number(r.quantity_on_hand ?? 0), 0);
      let recentSales = 0;
      for (const s of sales ?? []) {
        const inv = s.outlet_inventory as { lot_id?: string } | null;
        if (inv?.lot_id === selectedId) recentSales += Number(s.quantity_sold ?? 0);
      }
      setDetail({
        hubQty,
        outletQty,
        runNumber: (run as { run_number?: string } | null)?.run_number ?? null,
        recentSales,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, lots]);

  useEffect(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || lots.length === 0) return;
    const exact = lots.find((l) => l.product_batch_label.toLowerCase() === needle);
    const partial = lots.find((l) => l.product_batch_label.toLowerCase().includes(needle));
    const match = exact ?? partial;
    if (match) setSelectedId(match.id);
  }, [q, lots]);

  const childrenOf = useMemo(() => {
    const m = new Map<string, LotRow[]>();
    for (const lot of lots) {
      if (!lot.parent_lot_id) continue;
      const arr = m.get(lot.parent_lot_id) ?? [];
      arr.push(lot);
      m.set(lot.parent_lot_id, arr);
    }
    return m;
  }, [lots]);

  const roots = useMemo(() => {
    const ids = new Set(lots.map((l) => l.id));
    return lots.filter((l) => !l.parent_lot_id || !ids.has(l.parent_lot_id));
  }, [lots]);

  const filteredRoots = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return roots;
    const matchIds = new Set(
      lots.filter((l) => l.product_batch_label.toLowerCase().includes(needle)).map((l) => l.id)
    );
    // Include ancestors of matches
    const keep = new Set(matchIds);
    for (const id of matchIds) {
      let cur = lots.find((l) => l.id === id);
      while (cur?.parent_lot_id) {
        keep.add(cur.parent_lot_id);
        cur = lots.find((l) => l.id === cur!.parent_lot_id);
      }
    }
    return roots.filter((r) => keep.has(r.id) || matchSubtree(r.id, keep, childrenOf));
  }, [q, roots, lots, childrenOf]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function renderNode(lot: LotRow, depth: number): React.ReactNode {
    const kids = childrenOf.get(lot.id) ?? [];
    const open = expanded.has(lot.id);
    const selected = selectedId === lot.id;
    return (
      <div key={lot.id} className="select-none">
        <button
          type="button"
          onClick={() => {
            setSelectedId(lot.id);
            if (kids.length) toggle(lot.id);
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-50 ${
            selected ? 'bg-teal-50 ring-1 ring-teal-200' : ''
          }`}
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          {kids.length > 0 ? (
            open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />
          ) : (
            <span className="inline-block w-3.5" />
          )}
          <span className="font-medium text-gray-900">{lot.product_batch_label}</span>
          <span className="text-xs text-gray-400">{lot.expiry_date ?? 'no expiry'}</span>
        </button>
        {open && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading lots…</div>;
  }

  const selected = lots.find((l) => l.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
          <GitBranch size={24} className="text-teal-600" />
          Lot traceability
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Search the lot code from the ink label. Tree shows parent ingredients, production run, and hub/outlet on-hand.
        </p>
      </div>
      <input
        type="search"
        placeholder="Paste printed lot code…"
        value={q}
        onChange={(e) => {
          const next = e.target.value;
          setQ(next);
          const trimmed = next.trim();
          if (trimmed) setSearchParams({ q: trimmed }, { replace: true });
          else setSearchParams({}, { replace: true });
        }}
        className="max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-800">Lot tree</h2>
          <div className="max-h-[32rem] overflow-y-auto">
            {filteredRoots.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">No lots recorded yet.</p>
            ) : (
              filteredRoots.map((r) => renderNode(r, 0))
            )}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-800">Lot detail</h2>
          {!selected ? (
            <p className="text-sm text-gray-400">Select a lot in the tree.</p>
          ) : (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Batch</dt>
                <dd className="font-mono font-medium text-gray-900">{selected.product_batch_label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Expiry</dt>
                <dd>{selected.expiry_date ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Manufactured</dt>
                <dd>{selected.manufactured_at ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Parent lot</dt>
                <dd className="font-mono text-xs">{selected.parent_lot_id?.slice(0, 8) ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">PO item</dt>
                <dd className="font-mono text-xs">{selected.purchase_order_item_id?.slice(0, 8) ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Production run</dt>
                <dd>{detail?.runNumber ?? selected.production_run_id?.slice(0, 8) ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4 border-t pt-2">
                <dt className="text-gray-500">Hub on hand</dt>
                <dd className="tabular-nums font-semibold">{detail?.hubQty ?? '…'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Outlet on hand</dt>
                <dd className="tabular-nums font-semibold">{detail?.outletQty ?? '…'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Recent sales (sample)</dt>
                <dd className="tabular-nums">{detail?.recentSales ?? '…'}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

function matchSubtree(id: string, keep: Set<string>, childrenOf: Map<string, LotRow[]>): boolean {
  if (keep.has(id)) return true;
  for (const c of childrenOf.get(id) ?? []) {
    if (matchSubtree(c.id, keep, childrenOf)) return true;
  }
  return false;
}
