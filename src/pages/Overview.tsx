import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Package,
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  Truck,
  FlaskConical,
  ArrowRight,
  Activity,
} from 'lucide-react';
import { supabase } from '../utils/supabase';
import { aggregateFinishedGoodsHubTotals } from '../utils/hubInventoryMath';

interface KPIs {
  rawMaterialValue: number;
  hubProductStock: number;
  outstandingPOs: number;
  avgYield: number | null;
  lowStockCount: number;
  totalOutlets: number;
}

interface ActivityItem {
  id: string;
  type: 'purchase' | 'production' | 'supply';
  label: string;
  detail: string;
  time: string;
}

interface LowStockItem {
  id: string;
  name: string;
  quantity: number;
  reorder_level: number;
  unit: string;
}

interface SupplierScoreRow {
  supplier_id: string;
  supplier_name: string;
  completed_orders: number | null;
  otif_rate: number | string | null;
  avg_fill_rate: number | string | null;
}

export function Overview() {
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);
  const [supplierScores, setSupplierScores] = useState<SupplierScoreRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [
          { data: hubRaw },
          { data: hubProducts },
          { data: openPOs },
          { data: runs },
          { data: outlets },
          { data: pos },
          { data: prodRuns },
          { data: supplies },
          { data: scoreRows },
        ] = await Promise.all([
          supabase
            .from('hub_inventory')
            .select('quantity_on_hand, material:raw_material_id(cost_price, reorder_level, unit_of_measure, name)')
            .not('raw_material_id', 'is', null),
          supabase
            .from('hub_inventory')
            .select('available_quantity, quantity_on_hand, reserved_quantity')
            .is('raw_material_id', null),
          supabase
            .from('purchase_orders')
            .select('id')
            .in('status', ['draft', 'ordered', 'partial']),
          supabase
            .from('production_runs')
            .select('yield_percentage')
            .eq('status', 'completed')
            .order('production_date', { ascending: false })
            .limit(30),
          supabase.from('outlets').select('id'),
          supabase
            .from('purchase_orders')
            .select('id, order_number, status, created_at, supplier:supplier_id(name)')
            .order('created_at', { ascending: false })
            .limit(4),
          supabase
            .from('production_runs')
            .select('id, run_number, status, yield_percentage, created_at, recipe:recipe_id(name), actual_output')
            .eq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(4),
          supabase
            .from('supply_orders')
            .select('id, supply_order_number, status, created_at, outlet:outlet_id(name)')
            .order('created_at', { ascending: false })
            .limit(4),
          supabase.from('supplier_scorecard_metrics').select('*').order('supplier_name').limit(20),
        ]);

        // Raw material value
        const rawValue = (hubRaw || []).reduce((acc, row) => {
          const mat = row.material as { cost_price?: number } | null;
          return acc + row.quantity_on_hand * (mat?.cost_price ?? 0);
        }, 0);

        // Finished goods at hub: ATP total (aligned with Inventory hub KPI and Distribution hub strip)
        const productStock = aggregateFinishedGoodsHubTotals(hubProducts ?? []).available;

        // Low stock items
        const lowItems: LowStockItem[] = (hubRaw || [])
          .filter((row) => {
            const mat = row.material as { reorder_level?: number } | null;
            return row.quantity_on_hand <= (mat?.reorder_level ?? 10);
          })
          .map((row) => {
            const mat = row.material as unknown as {
              name: string;
              reorder_level?: number;
              unit_of_measure: string;
            } | null;
            return {
              id: Math.random().toString(),
              name: mat?.name ?? 'Unknown',
              quantity: row.quantity_on_hand,
              reorder_level: mat?.reorder_level ?? 10,
              unit: mat?.unit_of_measure ?? '',
            };
          });

        setLowStock(lowItems);

        setSupplierScores((scoreRows ?? []) as SupplierScoreRow[]);

        // Average yield (Postgres numeric may arrive as string — coerce for math)
        const yieldVals = (runs || [])
          .map((r) => Number(r.yield_percentage))
          .filter((n): n is number => Number.isFinite(n));
        const avgYield =
          yieldVals.length > 0
            ? yieldVals.reduce((a, b) => a + b, 0) / yieldVals.length
            : null;

        setKpis({
          rawMaterialValue: rawValue,
          hubProductStock: productStock,
          outstandingPOs: openPOs?.length ?? 0,
          avgYield,
          lowStockCount: lowItems.length,
          totalOutlets: outlets?.length ?? 0,
        });

        // Build activity feed
        const items: ActivityItem[] = [];
        for (const po of pos ?? []) {
          const supplier = po.supplier as unknown as { name: string } | null;
          items.push({
            id: `po-${po.id}`,
            type: 'purchase',
            label: po.order_number,
            detail: `Purchase order · ${supplier?.name ?? 'Unknown supplier'} · ${po.status}`,
            time: po.created_at,
          });
        }
        for (const run of prodRuns ?? []) {
          const recipe = run.recipe as unknown as { name: string } | null;
          const yRaw = run.yield_percentage;
          const yNum =
            yRaw != null && yRaw !== '' ? Number(yRaw) : NaN;
          const yieldLabel = Number.isFinite(yNum) ? `${yNum.toFixed(1)}` : '—';
          items.push({
            id: `run-${run.id}`,
            type: 'production',
            label: run.run_number,
            detail: `Production run · ${recipe?.name ?? 'Unknown recipe'} · Yield ${yieldLabel}%`,
            time: run.created_at,
          });
        }
        for (const s of supplies ?? []) {
          const outlet = s.outlet as unknown as { name: string } | null;
          items.push({
            id: `so-${s.id}`,
            type: 'supply',
            label: s.supply_order_number,
            detail: `Supply order · ${outlet?.name ?? 'Unknown outlet'} · ${s.status}`,
            time: s.created_at,
          });
        }
        items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
        setActivity(items.slice(0, 8));
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const activityIcon = {
    purchase: <ShoppingCart size={16} />,
    production: <FlaskConical size={16} />,
    supply: <Truck size={16} />,
  };

  const activityColor = {
    purchase: 'bg-blue-100 text-blue-600',
    production: 'bg-emerald-100 text-emerald-600',
    supply: 'bg-teal-100 text-teal-600',
  };

  function timeAgo(iso: string) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const diff = Date.now() - t;
    const mins = Math.floor(diff / 60000);
    if (mins < 0) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center text-gray-400">
        Loading dashboard…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Quackmaster Hub — live overview of operations
        </p>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {[
          {
            icon: <Package size={20} />,
            color: 'bg-blue-50 text-blue-600',
            label: 'Quackmaster',
            value: `MYR ${(kpis?.rawMaterialValue ?? 0).toLocaleString('en-MY', { minimumFractionDigits: 2 })}`,
            sub: 'Hub stock value',
            to: '/inventory',
          },
          {
            icon: <Activity size={20} />,
            color: 'bg-emerald-50 text-emerald-600',
            label: 'Hub Product Stock',
            value: (kpis?.hubProductStock ?? 0).toLocaleString(),
            sub: 'Units ready to dispatch',
            to: '/inventory',
          },
          {
            icon: <ShoppingCart size={20} />,
            color: 'bg-amber-50 text-amber-600',
            label: 'Outstanding POs',
            value: kpis?.outstandingPOs ?? 0,
            sub: 'Awaiting delivery',
            to: '/procurement',
          },
          {
            icon: <TrendingUp size={20} />,
            color: 'bg-teal-50 text-teal-600',
            label: 'Avg Production Yield',
            value:
              kpis?.avgYield != null && Number.isFinite(kpis.avgYield)
                ? `${kpis.avgYield.toFixed(1)}%`
                : '—',
            sub: 'Last 30 completed runs',
            to: '/production',
          },
          {
            icon: <AlertTriangle size={20} />,
            color:
              (kpis?.lowStockCount ?? 0) > 0
                ? 'bg-red-50 text-red-600'
                : 'bg-gray-50 text-gray-400',
            label: 'Low Stock Alerts',
            value: kpis?.lowStockCount ?? 0,
            sub: 'Materials below reorder',
            to: '/inventory',
          },
          {
            icon: <Truck size={20} />,
            color: 'bg-sky-50 text-sky-600',
            label: 'Active Outlets',
            value: kpis?.totalOutlets ?? 0,
            sub: 'Quackteow locations',
            to: '/distribution',
          },
        ].map((card) => (
          <Link
            key={card.label}
            to={card.to}
            className="group rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-blue-300 hover:shadow-md transition-all"
          >
            <div className="flex items-start justify-between">
              <div className={`rounded-lg p-2 ${card.color}`}>{card.icon}</div>
              <ArrowRight
                size={16}
                className="text-gray-300 group-hover:text-blue-500 transition-colors mt-1"
              />
            </div>
            <div className="mt-3">
              <div className="text-2xl font-bold text-gray-900">{card.value}</div>
              <div className="mt-0.5 text-sm font-medium text-gray-700">{card.label}</div>
              <div className="text-xs text-gray-400">{card.sub}</div>
            </div>
          </Link>
        ))}
      </div>

      {supplierScores.filter((s) => (s.completed_orders ?? 0) > 0).length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 font-semibold text-gray-900">Supplier performance (snapshot)</h2>
          <p className="mb-4 text-xs text-gray-500">
            OTIF and fill-rate from purchase history (requires completed/partial PO lines).{' '}
            <Link to="/procurement" className="text-blue-600 hover:underline">
              Procurement
            </Link>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-700">Supplier</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Completed POs</th>
                  <th className="px-3 py-2 font-medium text-gray-700">OTIF rate</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Avg fill rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {supplierScores
                  .filter((s) => (s.completed_orders ?? 0) > 0)
                  .slice(0, 10)
                  .map((s) => {
                    const otif = s.otif_rate != null ? Number(s.otif_rate) : null;
                    const fill = s.avg_fill_rate != null ? Number(s.avg_fill_rate) : null;
                    return (
                      <tr key={s.supplier_id}>
                        <td className="px-3 py-2 font-medium text-gray-900">{s.supplier_name}</td>
                        <td className="px-3 py-2 tabular-nums text-gray-700">{s.completed_orders ?? 0}</td>
                        <td className="px-3 py-2 tabular-nums text-gray-700">
                          {otif != null && Number.isFinite(otif) ? `${(otif * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-gray-700">
                          {fill != null && Number.isFinite(fill) ? `${(fill * 100).toFixed(0)}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        {/* Recent Activity */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="font-semibold text-gray-900">Recent Activity</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {activity.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-gray-400">
                No activity yet — start by adding suppliers and creating a purchase order.
              </div>
            ) : (
              activity.map((item) => (
                <div key={item.id} className="flex items-start gap-3 px-6 py-3.5">
                  <div
                    className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
                      activityColor[item.type]
                    }`}
                  >
                    {activityIcon[item.type]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {item.label}
                      </span>
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {timeAgo(item.time)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate">{item.detail}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Low Stock Alerts */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
            <h2 className="font-semibold text-gray-900">Low Stock Alerts</h2>
            <Link
              to="/inventory"
              className="text-xs font-medium text-blue-600 hover:text-blue-800"
            >
              View all
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {lowStock.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-gray-400">
                All materials are sufficiently stocked.
              </div>
            ) : (
              lowStock.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-6 py-3.5"
                >
                  <div>
                    <div className="text-sm font-medium text-gray-900">{item.name}</div>
                    <div className="text-xs text-gray-400">
                      Reorder at {item.reorder_level} {item.unit}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-sm font-semibold ${
                        item.quantity === 0 ? 'text-red-600' : 'text-amber-600'
                      }`}
                    >
                      {item.quantity} {item.unit}
                    </div>
                    <div
                      className={`text-xs ${
                        item.quantity === 0 ? 'text-red-400' : 'text-amber-400'
                      }`}
                    >
                      {item.quantity === 0 ? 'Out of stock' : 'Low stock'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-semibold text-gray-900">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/procurement"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <ShoppingCart size={16} />
            New Purchase Order
          </Link>
          <Link
            to="/production"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors"
          >
            <FlaskConical size={16} />
            Start Production Run
          </Link>
          <Link
            to="/distribution"
            className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors"
          >
            <Truck size={16} />
            Create Supply Order
          </Link>
        </div>
      </div>
    </div>
  );
}
