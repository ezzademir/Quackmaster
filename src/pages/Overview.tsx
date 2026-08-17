import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Package,
  ShoppingCart,
  Truck,
  FlaskConical,
  CircleDollarSign,
  Trash2,
  Plus,
  ChevronDown,
} from 'lucide-react';
import { Button, EmptyState, PageHeader, StatCard } from '../components/ui';
import { supabase } from '../utils/supabase';
import {
  aggregateFinishedGoodsHubTotals,
} from '../utils/hubInventoryMath';
import { useAuth } from '../utils/auth';
import { CloseDayChecklist } from '../components/CloseDayChecklist';
import { AlertsPanel, type AlertItem } from '../components/AlertsPanel';
import { STOCK_TAKE_OVERDUE_DAYS } from '../utils/closeDayChecks';
import { reconcileOutletStock, defaultReconcileRange } from '../utils/reconciliationService';

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

interface StockLotRow {
  id: string;
  product_batch_label: string;
  run_number: string;
  recipe_name: string;
  manufactured_at: string | null;
  hubQty: number;
  outletQty: number;
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
  const [stockLots, setStockLots] = useState<StockLotRow[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!newMenuRef.current?.contains(e.target as Node)) setNewOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

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
          { data: fgLotRows },
        ] = await Promise.all([
          supabase
            .from('hub_inventory')
            .select('quantity_on_hand, material:raw_material_id(cost_price, reorder_level, unit_of_measure, name)')
            .not('raw_material_id', 'is', null),
          supabase
            .from('hub_inventory')
            .select('product_batch, lot_id, available_quantity, quantity_on_hand, reserved_quantity')
            .is('raw_material_id', null),
          supabase
            .from('recipes')
            .select('id, name, batch_unit, target_yield_percentage, default_product_batch')
            .order('name'),
          supabase
            .from('outlet_inventory')
            .select('product_batch, lot_id, quantity_on_hand, reserved_quantity, available_quantity')
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
            .select('id, run_number, status, yield_percentage, created_at, actual_output, recipe:recipe_id(name), fg_lot:inventory_lots!production_run_id(product_batch_label)')
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
          supabase
            .from('inventory_lots')
            .select(
              'id, product_batch_label, manufactured_at, production_run_id, production_run:production_run_id(run_number, recipe_id, recipe:recipe_id(name))'
            )
            .not('production_run_id', 'is', null)
            .order('manufactured_at', { ascending: false }),
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

        const nextAlerts: AlertItem[] = [];
        if (lowItems.length > 0) {
          nextAlerts.push({
            id: 'low-stock',
            tone: 'amber',
            title: `${lowItems.length} low stock alert${lowItems.length === 1 ? '' : 's'}`,
            detail: 'Hub raw materials at or below reorder level.',
            to: '/inventory',
          });
        }
        if ((expiringLotsRows ?? []).length > 0) {
          nextAlerts.push({
            id: 'expiring-lots',
            tone: 'amber',
            title: `${(expiringLotsRows ?? []).length} lot(s) expiring within 14 days`,
            detail: 'Review Lots / Genealogy and outlet FIFO.',
            to: isAdmin ? '/genealogy' : '/inventory',
          });
        }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - STOCK_TAKE_OVERDUE_DAYS);
        const cutoffIso = cutoff.toISOString().slice(0, 10);
        const { data: stSessions } = await supabase
          .from('outlet_stock_take_sessions')
          .select('outlet_id, count_date, posted_at')
          .order('posted_at', { ascending: false })
          .limit(400);
        const lastSt = new Map<string, string>();
        for (const s of stSessions ?? []) {
          if (!lastSt.has(s.outlet_id)) lastSt.set(s.outlet_id, s.count_date);
        }
        let overdue = 0;
        for (const o of outlets ?? []) {
          const last = lastSt.get(o.id);
          if (!last || last < cutoffIso) overdue += 1;
        }
        if (overdue > 0) {
          nextAlerts.push({
            id: 'stock-take-overdue',
            tone: 'red',
            title: `${overdue} outlet(s) overdue for stock take`,
            detail: `No count in the last ${STOCK_TAKE_OVERDUE_DAYS} days.`,
            to: '/stock-take',
          });
        }

        if (isAdmin) {
          const range = defaultReconcileRange();
          const outletList = (outlets ?? []).slice(0, 12);
          let badVar = 0;
          await Promise.all(
            outletList.map(async (o) => {
              const recon = await reconcileOutletStock({
                outletId: o.id,
                from: range.start,
                to: range.end,
                includeRawMaterials: true,
              });
              if (recon.success && Math.abs(Number(recon.unexplained_variance ?? 0)) > 0.001) {
                badVar += 1;
              }
            })
          );
          if (badVar > 0) {
            nextAlerts.push({
              id: 'recon-variance',
              tone: 'red',
              title: `${badVar} outlet(s) with unexplained variance`,
              detail: 'Live on-hand differs from movement equation (last 30 days).',
              to: '/reconciliation',
            });
          }
        }

        setAlerts(nextAlerts);

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

        type FgLotEmbed = {
          id: string;
          product_batch_label: string;
          manufactured_at: string | null;
          production_run_id: string | null;
          production_run?: {
            run_number?: string;
            recipe_id?: string;
            recipe?: { name?: string } | null;
          } | null;
        };
        const fgLots = (fgLotRows ?? []) as FgLotEmbed[];
        const recipeOfLot = new Map<string, string>();
        for (const lot of fgLots) {
          const rid = lot.production_run?.recipe_id;
          if (rid) recipeOfLot.set(lot.id, rid);
        }

        const sumAvailByRecipe = (
          rows: Array<{
            lot_id?: string | null;
            product_batch?: string | null;
            quantity_on_hand?: number | null;
            reserved_quantity?: number | null;
            available_quantity?: number | null;
          }>,
          recipeId: string,
          sku: string
        ) => {
          let total = 0;
          for (const row of rows) {
            const rid = row.lot_id ? recipeOfLot.get(row.lot_id) : undefined;
            const batch = row.product_batch?.trim() ?? '';
            if (rid === recipeId || (!rid && sku && batch === sku)) {
              total += Number(
                row.available_quantity ??
                  Math.max(0, Number(row.quantity_on_hand ?? 0) - Number(row.reserved_quantity ?? 0))
              );
            }
          }
          return total;
        };

        const hubQtyByLot = new Map<string, number>();
        for (const row of hubProducts ?? []) {
          const lid = (row as { lot_id?: string | null }).lot_id;
          if (!lid) continue;
          const avail = Number(
            row.available_quantity ??
              Math.max(0, Number(row.quantity_on_hand ?? 0) - Number(row.reserved_quantity ?? 0))
          );
          hubQtyByLot.set(lid, (hubQtyByLot.get(lid) ?? 0) + avail);
        }
        const outletQtyByLot = new Map<string, number>();
        for (const row of outletInvAll ?? []) {
          const lid = (row as { lot_id?: string | null }).lot_id;
          if (!lid) continue;
          const onHand = Number(row.quantity_on_hand ?? 0);
          outletQtyByLot.set(lid, (outletQtyByLot.get(lid) ?? 0) + onHand);
        }

        setStockLots(
          fgLots.slice(0, 12).map((lot) => ({
            id: lot.id,
            product_batch_label: lot.product_batch_label,
            run_number: lot.production_run?.run_number ?? '—',
            recipe_name: lot.production_run?.recipe?.name ?? '—',
            manufactured_at: lot.manufactured_at,
            hubQty: hubQtyByLot.get(lot.id) ?? 0,
            outletQty: outletQtyByLot.get(lot.id) ?? 0,
          }))
        );

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
            const hubAvail = sumAvailByRecipe(hubProducts ?? [], rec.id, batchKey);
            const outletAvail = sumAvailByRecipe(outletInvAll ?? [], rec.id, batchKey);
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
          const lotRaw = (run as { fg_lot?: { product_batch_label?: string } | { product_batch_label?: string }[] | null }).fg_lot;
          const lot = Array.isArray(lotRaw) ? lotRaw[0] : lotRaw;
          const lotLabel = lot?.product_batch_label?.trim();
          const yRaw = run.yield_percentage;
          const yNum =
            yRaw != null && yRaw !== '' ? Number(yRaw) : NaN;
          const yieldLabel = Number.isFinite(yNum) ? `${yNum.toFixed(1)}` : '—';
          const qty = Number((run as { actual_output?: unknown }).actual_output);
          const qtyLabel = Number.isFinite(qty) ? `${qty}` : '';
          items.push({
            id: `run-${run.id}`,
            type: 'production',
            label: lotLabel || run.run_number,
            detail: `Production · ${run.run_number}${qtyLabel ? ` · ${qtyLabel}` : ''} · ${recipe?.name ?? 'Unknown recipe'} · Yield ${yieldLabel}%`,
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
  }, [isAdmin]);

  const activityIcon = {
    purchase: <ShoppingCart size={16} />,
    production: <FlaskConical size={16} />,
    supply: <Truck size={16} />,
    sales: <CircleDollarSign size={16} />,
    waste: <Trash2 size={16} />,
  };

  const activityColor = {
    purchase: 'bg-brand-100 text-brand-800',
    production: 'bg-stone-100 text-stone-600',
    supply: 'bg-stone-100 text-stone-600',
    sales: 'bg-brand-50 text-brand-700',
    waste: 'bg-red-50 text-red-600',
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
      <div className="flex h-96 items-center justify-center text-stone-400">
        Loading dashboard…
      </div>
    );
  }

  const newItems = [
    { to: '/procurement', label: 'Purchase order', icon: ShoppingCart },
    { to: '/production', label: 'Production run', icon: FlaskConical },
    { to: '/distribution', label: 'Supply order', icon: Truck },
    { to: '/sales', label: 'Sale', icon: CircleDollarSign },
    { to: '/waste', label: 'Waste', icon: Trash2 },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description="What needs action today, then a short snapshot of hub and outlets."
        actions={
          <div className="relative" ref={newMenuRef}>
            <Button type="button" onClick={() => setNewOpen((o) => !o)}>
              <Plus size={16} />
              New
              <ChevronDown size={14} />
            </Button>
            {newOpen && (
              <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
                {newItems.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setNewOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-stone-800 hover:bg-stone-50"
                  >
                    <item.icon size={16} className="text-stone-500" />
                    {item.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        }
      />

      <CloseDayChecklist />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-stone-900">Needs attention</h2>
        <AlertsPanel alerts={alerts} />
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
          <div className="panel">
            <div className="flex items-center justify-between border-b border-stone-100 px-6 py-4">
              <h3 className="font-semibold text-stone-900">Low stock</h3>
              <Link to="/inventory" className="text-xs font-medium text-brand-800 hover:underline">
                View all
              </Link>
            </div>
            <div className="divide-y divide-stone-50">
              {lowStock.length === 0 ? (
                <EmptyState title="All materials are sufficiently stocked." />
              ) : (
                lowStock.slice(0, 6).map((item) => (
                  <div key={item.id} className="flex items-center justify-between px-6 py-3.5">
                    <div>
                      <div className="text-sm font-medium text-stone-900">{item.name}</div>
                      <div className="text-xs text-stone-400">
                        Reorder at {item.reorder_level} {item.unit}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`text-sm font-semibold tabular-nums ${item.quantity === 0 ? 'text-red-600' : 'text-amber-700'}`}>
                        {item.quantity} {item.unit}
                      </div>
                      <div className={`text-xs ${item.quantity === 0 ? 'text-red-400' : 'text-amber-500'}`}>
                        {item.quantity === 0 ? 'Out of stock' : 'Low stock'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="panel p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-stone-900">Lots expiring soon</h3>
              {isAdmin ? (
                <Link to="/genealogy" className="text-xs font-medium text-brand-800 hover:underline">
                  Open lot trace
                </Link>
              ) : (
                <span className="text-xs text-stone-400">Full traceability in Lot trace</span>
              )}
            </div>
            <p className="mb-4 text-xs text-stone-500">Expiry within the next 14 days.</p>
            {expiringLots.length === 0 ? (
              <EmptyState title="No lots with expiry in this window." />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Batch</th>
                      <th>Expiry</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {expiringLots.map((lot) => (
                      <tr key={lot.id}>
                        <td className="font-medium">{lot.product_batch_label}</td>
                        <td className="tabular-nums">{lot.expiry_date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            icon: <Package size={20} />,
            label: 'Hub finished goods',
            value: (kpis?.hubProductStock ?? 0).toLocaleString(),
            sub: hubProductSub,
            to: '/inventory',
          },
          {
            icon: <CircleDollarSign size={20} />,
            label: 'Outlet sales (7d)',
            value: (kpis?.salesUnits7d ?? 0).toLocaleString(),
            sub: `${kpis?.salesJournals7d ?? 0} journals · units sold`,
            to: '/sales',
          },
          {
            icon: <Trash2 size={20} />,
            label: 'Waste (7d)',
            value: (kpis?.wasteUnits7d ?? 0).toLocaleString(),
            sub: `${kpis?.wasteEvents7d ?? 0} events · units`,
            to: '/waste',
          },
          {
            icon: <ShoppingCart size={20} />,
            label: 'Outstanding POs',
            value: kpis?.outstandingPOs ?? 0,
            sub: 'Awaiting delivery',
            to: '/procurement',
          },
        ].map((card) => (
          <Link key={card.label} to={card.to} className="group block">
            <StatCard icon={card.icon} tone="brand" label={card.label} value={card.value} sub={card.sub} />
          </Link>
        ))}
      </div>

      {recipeKpiRows.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-1 font-semibold text-gray-900">By recipe</h2>
          <p className="mb-4 text-xs text-gray-500">
            Hub and outlet ATP sum every printable lot for that recipe. SKU is the recipe default used on new
            production labels (
            <Link to="/production" className="text-blue-600 hover:underline">
              Production
            </Link>
            ). Yield is averaged over up to 30 latest completed runs. Cells use each recipe&apos;s batch unit.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-700">Recipe</th>
                  <th className="px-3 py-2 font-medium text-gray-700">SKU</th>
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
                        {(row.hubAvail ?? 0).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                        {(row.outletAvail ?? 0).toLocaleString()}
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
          <h2 className="font-semibold text-gray-900">Lots in stock</h2>
          <div className="flex items-center gap-3">
            <Link to="/production" className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline">
              Print from Production
            </Link>
            {isAdmin && (
              <Link to="/genealogy" className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline">
                Lot trace
              </Link>
            )}
          </div>
        </div>
        <p className="mb-4 text-xs text-gray-500">
          Ink-label packs with the lot code. Outlets see the same code on inventory and supply receipts.
        </p>
        {stockLots.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400">No production lots yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-700">Lot</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Run</th>
                  <th className="hidden sm:table-cell px-3 py-2 font-medium text-gray-700">Made</th>
                  <th className="px-3 py-2 font-medium text-gray-700 text-right">Hub</th>
                  <th className="px-3 py-2 font-medium text-gray-700 text-right">Outlets</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stockLots.map((lot) => (
                  <tr key={lot.id} className="hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs font-semibold text-gray-900">{lot.product_batch_label}</td>
                    <td className="px-3 py-2 text-gray-700">{lot.run_number}</td>
                    <td className="hidden sm:table-cell px-3 py-2 tabular-nums text-gray-600">
                      {lot.manufactured_at ? new Date(lot.manufactured_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-800">{lot.hubQty.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-800">{lot.outletQty.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="border-b border-stone-100 px-6 py-4">
          <h2 className="font-semibold text-stone-900">Recent activity</h2>
        </div>
        <div className="divide-y divide-stone-50">
          {activity.length === 0 ? (
            <EmptyState title="No activity yet" description="Create a PO, production run, supply order, or post outlet sales / waste." />
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
                    <span className="text-sm font-medium text-stone-900 truncate">{item.label}</span>
                    <span className="text-xs text-stone-400 flex-shrink-0">{timeAgo(item.time)}</span>
                  </div>
                  <p className="text-xs text-stone-500 truncate">{item.detail}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
