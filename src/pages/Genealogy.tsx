import { useEffect, useState } from 'react';
import { supabase } from '../utils/supabase';

interface LotRow {
  id: string;
  product_batch_label: string;
  expiry_date: string | null;
  manufactured_at: string | null;
  parent_lot_id: string | null;
  purchase_order_item_id: string | null;
  production_run_id: string | null;
}

export function Genealogy() {
  const [lots, setLots] = useState<LotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('inventory_lots')
        .select('id, product_batch_label, expiry_date, manufactured_at, parent_lot_id, purchase_order_item_id, production_run_id')
        .order('created_at', { ascending: false })
        .limit(200);
      if (!cancelled) {
        setLots((data ?? []) as LotRow[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = lots.filter((l) =>
    q.trim() ? l.product_batch_label.toLowerCase().includes(q.trim().toLowerCase()) : true
  );

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading lots…</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Lot traceability</h1>
        <p className="mt-1 text-sm text-gray-500">
          Inventory lots linked to PO lines or production runs (expand Compliance data entry over time).
        </p>
      </div>
      <input
        type="search"
        placeholder="Filter by batch label…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-semibold text-gray-700">Batch label</th>
              <th className="px-4 py-2 text-left font-semibold text-gray-700">Expiry</th>
              <th className="px-4 py-2 text-left font-semibold text-gray-700">Parent lot</th>
              <th className="px-4 py-2 text-left font-semibold text-gray-700">PO item</th>
              <th className="px-4 py-2 text-left font-semibold text-gray-700">Production run</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No lots recorded yet — create lots via admin workflows as Compliance rolls out.
                </td>
              </tr>
            ) : (
              filtered.map((l) => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{l.product_batch_label}</td>
                  <td className="px-4 py-2 text-gray-600">{l.expiry_date ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{l.parent_lot_id?.slice(0, 8) ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{l.purchase_order_item_id?.slice(0, 8) ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{l.production_run_id?.slice(0, 8) ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
