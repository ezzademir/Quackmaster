import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, PackageCheck, CreditCard as Edit2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DateFilter, type DateFilterType } from '../components/DateFilter';
import { supabase } from '../utils/supabase';
import { logActivity } from '../utils/activityLog';
import { writeLedgerEntry } from '../utils/ledger';
import { isDateInRange, type DateRange } from '../utils/dateRange';
import type { RawMaterial, Outlet } from '../types';

type Tab = 'hub' | 'outlets';

interface HubRow {
  id: string;
  type: 'material' | 'product';
  name: string;
  unit: string;
  quantity_on_hand: number;
  reserved_quantity: number;
  available_quantity: number;
  reorder_level?: number;
  last_updated: string;
  raw_material_id?: string;
  product_batch?: string;
}

interface OutletRow {
  id: string;
  outlet_name: string;
  product_batch: string;
  quantity_on_hand: number;
  reserved_quantity: number;
  available_quantity: number;
  last_updated: string;
}

function StockStatus({ qty, reorder }: { qty: number; reorder?: number }) {
  if (qty === 0) return <span className="inline-flex rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700">Out of stock</span>;
  if (reorder != null && qty <= reorder) return <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">Low stock</span>;
  return <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">In stock</span>;
}

function AdjustModal({
  row,
  onClose,
  onSave,
}: {
  row: HubRow;
  onClose: () => void;
  onSave: () => void;
}) {
  const [qty, setQty] = useState(row.quantity_on_hand.toString());
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    const newQty = parseFloat(qty);
    await supabase
      .from('hub_inventory')
      .update({ quantity_on_hand: newQty, available_quantity: newQty, last_updated: new Date().toISOString() })
      .eq('id', row.id);
    await writeLedgerEntry({
      action: 'updated',
      entityType: row.type === 'material' ? 'hub_inventory_material' : 'hub_inventory_product',
      entityId: row.id,
      module: 'inventory',
      operation: 'update',
      beforeData: { quantity_on_hand: row.quantity_on_hand, available_quantity: row.available_quantity },
      afterData: { quantity_on_hand: newQty, available_quantity: newQty },
      deltaData: { quantity_on_hand: newQty - row.quantity_on_hand },
      metadata: { reason },
    });
    await logActivity({ action: 'updated', entityType: 'inventory_adjustment', entityId: row.id, entityLabel: row.name, details: { from: row.quantity_on_hand, to: newQty, reason } });
    setSaving(false);
    onSave();
  }

  return (
    <Modal isOpen onClose={onClose} title="Adjust Stock" size="sm">
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-gray-700">{row.name}</p>
          <p className="text-xs text-gray-400">Current: {row.quantity_on_hand} {row.unit}</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">New Quantity ({row.unit})</label>
          <input type="number" min="0" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Reason</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Adjustment reason…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Apply Adjustment'}
        </button>
      </div>
    </Modal>
  );
}

export function Inventory() {
  const [tab, setTab] = useState<Tab>('hub');
  const [hubRows, setHubRows] = useState<HubRow[]>([]);
  const [outletRows, setOutletRows] = useState<OutletRow[]>([]);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedOutlet, setSelectedOutlet] = useState('');
  const [loading, setLoading] = useState(true);
  const [adjustRow, setAdjustRow] = useState<HubRow | null>(null);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);

  async function loadAll() {
    setLoading(true);
    const [{ data: hubInv }, { data: outs }] = await Promise.all([
      supabase.from('hub_inventory').select(`*, material:raw_material_id(*)`).order('last_updated', { ascending: false }),
      supabase.from('outlets').select('*').order('name'),
    ]);
    setOutlets(outs ?? []);

    const rows: HubRow[] = (hubInv ?? []).map((inv) => {
      const mat = inv.material as RawMaterial | null;
      return {
        id: inv.id,
        type: inv.raw_material_id ? 'material' : 'product',
        name: mat?.name ?? inv.product_batch ?? '—',
        unit: mat?.unit_of_measure ?? 'units',
        quantity_on_hand: inv.quantity_on_hand,
        reserved_quantity: inv.reserved_quantity ?? 0,
        available_quantity: inv.available_quantity ?? inv.quantity_on_hand,
        reorder_level: mat?.reorder_level ?? undefined,
        last_updated: inv.last_updated,
        raw_material_id: inv.raw_material_id ?? undefined,
        product_batch: inv.product_batch ?? undefined,
      };
    });
    setHubRows(rows);
    setLoading(false);
  }

  async function loadOutletInventory(outletId?: string) {
    const query = supabase.from('outlet_inventory').select(`*, outlet:outlet_id(*)`).order('last_updated', { ascending: false });
    if (outletId) query.eq('outlet_id', outletId);
    const { data } = await query;
    const rows: OutletRow[] = (data ?? []).map((inv) => ({
      id: inv.id,
      outlet_name: (inv.outlet as Outlet | null)?.name ?? '—',
      product_batch: inv.product_batch,
      quantity_on_hand: inv.quantity_on_hand,
      reserved_quantity: inv.reserved_quantity ?? 0,
      available_quantity: inv.available_quantity ?? inv.quantity_on_hand,
      last_updated: inv.last_updated,
    }));
    setOutletRows(rows);
  }

  useEffect(() => { loadAll(); loadOutletInventory(); }, []);

  useEffect(() => { loadOutletInventory(selectedOutlet || undefined); }, [selectedOutlet]);

  const handleDateFilterChange = (range: DateRange | null, _newFilterType: DateFilterType) => {
    setDateRange(range);
  };

  const filteredHubRows = dateRange
    ? hubRows.filter((r) => isDateInRange(r.last_updated, dateRange))
    : hubRows;

  const filteredOutletRows = dateRange
    ? outletRows.filter((r) => isDateInRange(r.last_updated, dateRange))
    : outletRows;

  const tabClass = (t: Tab) =>
    `border-b-2 px-1 py-4 text-sm font-medium transition-colors ${
      tab === t ? 'border-amber-500 text-amber-600' : 'border-transparent text-gray-500 hover:text-gray-700'
    }`;

  const lowStockCount = filteredHubRows.filter((r) => r.type === 'material' && r.quantity_on_hand <= (r.reorder_level ?? 10)).length;
  const totalProductHub = filteredHubRows.filter((r) => r.type === 'product').reduce((a, r) => a + r.quantity_on_hand, 0);
  const totalOutletStock = filteredOutletRows.reduce((a, r) => a + r.quantity_on_hand, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="mt-1 text-sm text-gray-500">Hub (Quackmaster) and Outlet (Quackteow) stock levels</p>
        </div>
        <button onClick={() => { loadAll(); loadOutletInventory(selectedOutlet || undefined); }}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-50 p-2 text-amber-600"><PackageCheck size={20} /></div>
            <div>
              <p className="text-xs text-gray-500">Hub Product Stock</p>
              <p className="text-xl font-bold text-gray-900">{totalProductHub.toLocaleString()} units</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className={`rounded-lg p-2 ${lowStockCount > 0 ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-400'}`}><AlertTriangle size={20} /></div>
            <div>
              <p className="text-xs text-gray-500">Low Stock Alerts</p>
              <p className="text-xl font-bold text-gray-900">{lowStockCount} material{lowStockCount !== 1 ? 's' : ''}</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-teal-50 p-2 text-teal-600"><PackageCheck size={20} /></div>
            <div>
              <p className="text-xs text-gray-500">Total Outlet Stock</p>
              <p className="text-xl font-bold text-gray-900">{totalOutletStock.toLocaleString()} units</p>
            </div>
          </div>
        </div>
      </div>

      <div className="border-b border-gray-200">
        <nav className="flex items-center justify-between gap-6 mb-4">
          <div className="flex gap-6">
            <button className={tabClass('hub')} onClick={() => setTab('hub')}>Hub Inventory</button>
            <button className={tabClass('outlets')} onClick={() => setTab('outlets')}>Outlet Inventory</button>
          </div>
          <DateFilter onFilterChange={handleDateFilterChange} />
        </nav>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center text-gray-400 text-sm">Loading…</div>
      ) : (
        <>
          {tab === 'hub' && (
            <div className="space-y-4">
              {/* Raw Materials */}
              <div>
                <h2 className="mb-3 text-sm font-semibold text-gray-700">Raw Materials</h2>
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full text-sm">
                    <thead className="border-b border-gray-200 bg-gray-50">
                      <tr>
                        <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Material</th>
                        <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">On Hand</th>
                        <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Reserved</th>
                        <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Available</th>
                        <th className="hidden md:table-cell px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Reorder</th>
                        <th className="hidden lg:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
                        <th className="hidden xl:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Updated</th>
                        <th className="w-12 px-4 md:px-6 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filteredHubRows.filter((r) => r.type === 'material').length === 0 ? (
                        <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-400">No raw material stock — receive a purchase order to add stock</td></tr>
                      ) : (
                        filteredHubRows.filter((r) => r.type === 'material').map((row) => (
                          <tr key={row.id} className={`hover:bg-gray-50 transition-colors ${row.quantity_on_hand === 0 ? 'bg-red-50/30' : row.quantity_on_hand <= (row.reorder_level ?? 10) ? 'bg-amber-50/30' : ''}`}>
                            <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{row.name}</td>
                            <td className="px-4 md:px-6 py-4 text-right font-semibold text-gray-900 text-xs sm:text-sm">{row.quantity_on_hand}</td>
                            <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-right text-gray-600 text-xs">{row.reserved_quantity}</td>
                            <td className="px-4 md:px-6 py-4 text-right font-medium text-gray-900 text-xs sm:text-sm">{row.available_quantity}</td>
                            <td className="hidden md:table-cell px-4 md:px-6 py-4 text-right text-gray-500 text-xs">{row.reorder_level ?? 10}</td>
                            <td className="hidden lg:table-cell px-4 md:px-6 py-4"><StockStatus qty={row.quantity_on_hand} reorder={row.reorder_level} /></td>
                            <td className="hidden xl:table-cell px-4 md:px-6 py-4 text-gray-400 text-xs">{new Date(row.last_updated).toLocaleDateString()}</td>
                            <td className="px-4 md:px-6 py-4">
                              <button onClick={() => setAdjustRow(row)} className="text-gray-400 hover:text-blue-600 transition-colors p-1" title="Adjust stock">
                                <Edit2 size={14} />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Finished Product */}
              <div>
                <h2 className="mb-3 text-sm font-semibold text-gray-700">Finished Product</h2>
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full text-sm">
                    <thead className="border-b border-gray-200 bg-gray-50">
                      <tr>
                        <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Batch</th>
                        <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">On Hand</th>
                        <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Reserved</th>
                        <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Available</th>
                        <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Updated</th>
                        <th className="w-12 px-4 md:px-6 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filteredHubRows.filter((r) => r.type === 'product').length === 0 ? (
                        <tr><td colSpan={6} className="px-6 py-8 text-center text-gray-400">No product stock — complete a production run to add product</td></tr>
                      ) : (
                        filteredHubRows.filter((r) => r.type === 'product').map((row) => (
                          <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{row.name}</td>
                            <td className="px-4 md:px-6 py-4 text-right font-semibold text-gray-900 text-xs sm:text-sm">{row.quantity_on_hand}</td>
                            <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-right text-gray-600 text-xs">{row.reserved_quantity}</td>
                            <td className="px-4 md:px-6 py-4 text-right font-medium text-gray-900 text-xs sm:text-sm">{row.available_quantity}</td>
                            <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-400 text-xs">{new Date(row.last_updated).toLocaleDateString()}</td>
                            <td className="px-4 md:px-6 py-4">
                              <button onClick={() => setAdjustRow(row)} className="text-gray-400 hover:text-blue-600 transition-colors p-1" title="Adjust stock">
                                <Edit2 size={14} />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {tab === 'outlets' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-700">Filter by Outlet:</label>
                <select value={selectedOutlet} onChange={(e) => setSelectedOutlet(e.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="">All outlets</option>
                  {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50">
                    <tr>
                      <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Outlet</th>
                      <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Batch</th>
                      <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">On Hand</th>
                      <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Reserved</th>
                      <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Available</th>
                      <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredOutletRows.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 md:px-6 py-8 text-center text-gray-400 text-xs sm:text-sm">No outlet stock yet</td></tr>
                    ) : (
                      filteredOutletRows.map((row) => (
                        <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{row.outlet_name}</td>
                          <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{row.product_batch}</td>
                          <td className="px-4 md:px-6 py-4 text-right font-semibold text-gray-900 text-xs sm:text-sm">{row.quantity_on_hand}</td>
                          <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-right text-gray-600 text-xs">{row.reserved_quantity}</td>
                          <td className="px-4 md:px-6 py-4 text-right font-medium text-gray-900 text-xs sm:text-sm">{row.available_quantity}</td>
                          <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-400 text-xs">{new Date(row.last_updated).toLocaleDateString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {adjustRow && (
        <AdjustModal
          row={adjustRow}
          onClose={() => setAdjustRow(null)}
          onSave={() => { setAdjustRow(null); loadAll(); }}
        />
      )}
    </div>
  );
}
