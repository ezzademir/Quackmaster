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
  CircleDollarSign,
  Trash2,
} from 'lucide-react';
import { supabase } from '../utils/supabase';
import {
  aggregateFinishedGoodsHubTotals,
  sumAvailableByProductBatch,
} from '../utils/hubInventoryMath';
import { useAuth } from '../utils/auth';

function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface KPIs {
  rawMaterialValue: number;
  hubProductStock: number;
  outstandingPOs: number;
  avgYield: number | null;
  lowStockCount: number;
  totalOutlets: number;
  salesUnits7d: number;
  salesJournals7d: number;
  wasteUnits7d: number;
  wasteEvents7d: number;
}

interface ActivityItem {
  id: string;
  type: 'purchase' | 'production' | 'supply' | 'sales' | 'waste';
  label: string;
  detail: string;
  time: string;
}

interface ExpiringLotRow {
  id: string;
  product_batch_label: string;
  expiry_date: string;
}

interface LowStockItem {
  id: string;
  name: string;
  quantity: number;
  reorder_level: number;
  unit: string;
}

interface RecipeKpiRow {
  id: string;
  name: string;
  batch_unit: string | null;
  target_yield_percentage: number;
  default_product_batch: string | null;
  hubAvail: number | null;
  outletAvail: number | null;
  avgYieldRec: number | null;
}

export function Overview() {
  const { isAdmin } = useAuth();
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [recipeKpiRows, setRecipeKpiRows] = useState<RecipeKpiRow[]>([]);
  const [hubProductStockMixedUom, setHubProductStockMixedUom] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);
  const [expiringLots, setExpiringLots] = useState<ExpiringLotRow[]>([]);
  const [loading, setLoading] = useState(true);

  const hubProductSub = hubProductStockMixedUom
    ? 'ATP total — recipes use different batch units (see By recipe below)'
    : 'Units ready to dispatch';

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const today = new Date();
        const rollingStart = new Date(today);
        rollingStart.setDate(rollingStart.getDate() - 7);
        const rollingStartIso = localISODate(rollingStart);
        const expiryHorizon = new Date(today);
        expiryHorizon.setDate(expiryHorizon.getDate() + 14);
        const todayIso = localISODate(today);
        const expiryHorizonIso = localISODate(expiryHorizon);

        const [
          { data: hubRaw },
          { data: hubProducts },
          { data: recipeList },
          { data: outletInvAll },
          { data: yieldRuns },
          { data: openPOs },
          { data: runs },
          { data: outlets },
          { data: pos },
          { data: prodRuns },
          { data: supplies },
          { data: salesJournalsKpi },
          { data: wasteEventsKpi },
          { data: salesActivityRows },
          { data: wasteActivityRows },
          { data: expiringLotsRows },
        ] = await Promise.all([
          supabase
            .from('hub_inventory')
            .select('quantity_on_hand, material:raw_material_id(cost_price, reorder_level, unit_of_measure, name)')
            .not('raw_material_id', 'is', null),
          supabase
            .from('hub_inventory')
            .select('product_batch, available_quantity, quantity_on_hand, reserved_quantity')
            .is('raw_material_id', null),
          supabase
            .from('recipes')
            .select('id, name, batch_unit, target_yield_percentage, default_product_batch')
            .order('name'),
          supabase
            .from('outlet_inventory')
            .select('product_batch, quantity_on_hand, reserved_quantity, available_quantity')
            .is('raw_material_id', null),
          supabase
            .from('production_runs')
            .select('recipe_id, yield_percentage')
            .eq('status', 'completed')
            .order('production_date', { ascending: false })
            .limit(400),
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
          supabase
            .from('sales_journals')
            .select('id')
            .eq('status', 'posted')
            .gte('business_date', rollingStartIso),
          supabase
            .from('waste_events')
            .select('id')
            .eq('status', 'posted')
            .gte('waste_date', rollingStartIso),
          supabase
            .from('sales_journals')
            .select('id, business_date, created_at, notes, outlet:outlet_id(name)')
            .eq('status', 'posted')
            .order('created_at', { ascending: false })
            .limit(10),
          supabase
            .from('waste_events')
            .select('id, location_kind, waste_date, created_at, notes, outlet:outlet_id(name)')
            .eq('status', 'posted')
            .order('created_at', { ascending: false })
            .limit(10),
          supabase
            .from('inventory_lots')
            .select('id, product_batch_label, expiry_date')
            .not('expiry_date', 'is', null)
            .gte('expiry_date', todayIso)
            .lte('expiry_date', expiryHorizonIso)
            .order('expiry_date', { ascending: true })
            .limit(8),
        ]);

        const sjIds = (salesJournalsKpi ?? []).map((r) => r.id);
        const weIds = (wasteEventsKpi ?? []).map((r) => r.id);

        const [saleLinesResult, wasteLinesResult] = await Promise.all([
          sjIds.length > 0
            ? supabase.from('sales_journal_lines').select('quantity_sold').in('sales_journal_id', sjIds)
            : Promise.resolve({ data: [] as { quantity_sold: unknown }[] }),
          weIds.length > 0
            ? supabase.from('waste_lines').select('quantity').in('waste_event_id', weIds)
            : Promise.resolve({ data: [] as { quantity: unknown }[] }),
        ]);

        const salesUnits7d = (saleLinesResult.data ?? []).reduce(
          (acc, row) => acc + Number(row.quantity_sold ?? 0),
          0
        );
        const wasteUnits7d = (wasteLinesResult.data ?? []).reduce(
          (acc, row) => acc + Number(row.quantity ?? 0),
          0
        );
        const salesJournals7d = sjIds.length;
        const wasteEvents7d = weIds.length;

        setExpiringLots((expiringLotsRows ?? []) as ExpiringLotRow[]);

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
          salesUnits7d,
          salesJournals7d,
          wasteUnits7d,
          wasteEvents7d,
        });

        const hubByBatch = sumAvailableByProductBatch(hubProducts ?? []);
        const outletByBatch = sumAvailableByProductBatch(outletInvAll ?? []);

        const yieldMap = new Map<string, number[]>();
        for (const yr of yieldRuns ?? []) {
          const rid = (yr as { recipe_id?: string | null }).recipe_id;
          if (!rid) continue;
          const y = Number((yr as { yield_percentage?: unknown }).yield_percentage);
          if (!Number.isFinite(y)) continue;
          let bucket = yieldMap.get(rid);
          if (!bucket) {
            bucket = [];
            yieldMap.set(rid, bucket);
          }
          if (bucket.length < 30) bucket.push(y);
        }

        const rlist = (recipeList ?? []) as Array<{
          id: string;
          name: string;
          batch_unit: string | null;
          target_yield_percentage?: unknown;
          default_product_batch: string | null;
        }>;

        const distinctBatchUnits = new Set<string>();
        for (const rec of rlist) {
          const u = String(rec.batch_unit ?? '').trim();
          if (u) distinctBatchUnits.add(u);
        }
        setHubProductStockMixedUom(distinctBatchUnits.size > 1);

        setRecipeKpiRows(
          rlist.map((rec) => {
            const batchKey = rec.default_product_batch?.trim() ?? '';
            const hubAvail = batchKey ? (hubByBatch.get(batchKey) ?? 0) : null;
            const outletAvail = batchKey ? (outletByBatch.get(batchKey) ?? 0) : null;
            const ys = yieldMap.get(rec.id) ?? [];
            const avgYieldRec = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
            const tgtRaw = rec.target_yield_percentage;
            const tgtNum = tgtRaw != null && tgtRaw !== '' ? Number(tgtRaw) : 100;
            return {
              id: rec.id,
              name: rec.name,
              batch_unit: rec.batch_unit,
              target_yield_percentage: Number.isFinite(tgtNum) ? tgtNum : 100,
              default_product_batch: rec.default_product_batch,
              hubAvail,
              outletAvail,
              avgYieldRec,
            };
          })
        );

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
        for (const sj of salesActivityRows ?? []) {
          const outlet = sj.outlet as { name?: string } | null;
          const noteHint =
            sj.notes && String(sj.notes).trim() ? String(sj.notes).trim().slice(0, 80) : 'Posted';
          items.push({
            id: `sj-${sj.id}`,
            type: 'sales',
            label: `Outlet sales · ${sj.business_date}`,
            detail: `${outlet?.name ?? 'Outlet'} · ${noteHint}`,
            time: sj.created_at,
          });
        }
        for (const we of wasteActivityRows ?? []) {
          const outlet = we.outlet as { name?: string } | null;
          const locLabel =
            we.location_kind === 'hub' ? 'Hub' : outlet?.name ?? 'Outlet';
          const noteHint =
            we.notes && String(we.notes).trim() ? String(we.notes).trim().slice(0, 80) : 'Posted';
          items.push({
            id: `we-${we.id}`,
            type: 'waste',
            label: `Waste · ${we.waste_date}`,
            detail: `${we.location_kind === 'hub' ? 'Hub' : 'Outlet'} · ${locLabel} · ${noteHint}`,
            time: we.created_at,
          });
        }
        items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
        setActivity(items.slice(0, 12));
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
    sales: <CircleDollarSign size={16} />,
    waste: <Trash2 size={16} />,
  };

  const activityColor = {
    purchase: 'bg-blue-100 text-blue-600',
    production: 'bg-emerald-100 text-emerald-600',
    supply: 'bg-teal-100 text-teal-600',
    sales: 'bg-violet-100 text-violet-600',
    waste: 'bg-orange-100 text-orange-600',
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
          <Link
            to="/sales"
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 transition-colors"
          >
            <CircleDollarSign size={16} />
            Record outlet sales
          </Link>
          <Link
            to="/waste"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors"
          >
            <Trash2 size={16} />
            Post waste
          </Link>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
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
            sub: hubProductSub,
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
          {
            icon: <CircleDollarSign size={20} />,
            color: 'bg-violet-50 text-violet-600',
            label: 'Outlet sales (7d)',
            value: (kpis?.salesUnits7d ?? 0).toLocaleString(),
            sub: `${kpis?.salesJournals7d ?? 0} journals · units sold`,
            to: '/sales',
          },
          {
            icon: <Trash2 size={20} />,
            color: 'bg-orange-50 text-orange-600',
            label: 'Waste (7d)',
            value: (kpis?.wasteUnits7d ?? 0).toLocaleString(),
            sub: `${kpis?.wasteEvents7d ?? 0} events · units`,
            to: '/waste',
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

      {recipeKpiRows.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-1 font-semibold text-gray-900">By recipe</h2>
          <p className="mb-4 text-xs text-gray-500">
            Hub and outlet columns use{' '}
            <span className="font-medium text-gray-700">default product batch</span> when set on the recipe (
            <Link to="/production" className="text-blue-600 hover:underline">
              Production
            </Link>
            ). Yield is averaged over up to 30 latest completed runs per recipe. Cells use each recipe&apos;s batch
            unit.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-700">Recipe</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Default batch</th>
                  <th className="px-3 py-2 font-medium text-gray-700 text-right">Hub ATP</th>
                  <th className="px-3 py-2 font-medium text-gray-700 text-right">Outlet ATP</th>
                  <th className="px-3 py-2 font-medium text-gray-700 text-right">Avg yield</th>
                  <th className="px-3 py-2 font-medium text-gray-700 text-right">Target %</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Unit</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recipeKpiRows.map((row) => {
                  const batch = row.default_product_batch?.trim();
                  return (
                    <tr key={row.id} className="hover:bg-gray-50/80">
                      <td className="px-3 py-2 font-medium text-gray-900">{row.name}</td>
                      <td className="px-3 py-2 text-gray-700">{batch || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                        {batch != null && batch !== '' ? (row.hubAvail ?? 0).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                        {batch != null && batch !== '' ? (row.outletAvail ?? 0).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                        {row.avgYieldRec != null && Number.isFinite(row.avgYieldRec)
                          ? `${row.avgYieldRec.toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                        {row.target_yield_percentage.toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-gray-600">{row.batch_unit?.trim() || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Lots expiring soon</h2>
          {isAdmin ? (
            <Link to="/genealogy" className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline">
              Open Lots
            </Link>
          ) : (
            <span className="text-xs text-gray-400">Full traceability in Lots (admins)</span>
          )}
        </div>
        <p className="mb-4 text-xs text-gray-500">Expiry within the next 14 days.</p>
        {expiringLots.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400">No lots with expiry in this window.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-700">Batch</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Expiry</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {expiringLots.map((lot) => (
                  <tr key={lot.id}>
                    <td className="px-3 py-2 font-medium text-gray-900">{lot.product_batch_label}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-700">{lot.expiry_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
        {/* Recent Activity */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="font-semibold text-gray-900">Recent Activity</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {activity.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-gray-400">
                No activity yet — create a PO, production run, supply order, or post outlet sales / waste.
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
    </div>
  );
}
