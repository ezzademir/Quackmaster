import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { supabase } from '../utils/supabase';
import type { Outlet } from '../types';
import {
  reconcileOutletStock,
  defaultReconcileRange,
  type ReconcileOutletStockResult,
} from '../utils/reconciliationService';
import { formatDateForInput } from '../utils/dateRange';
import { AlertsPanel, type AlertItem } from '../components/AlertsPanel';
import { Button, EmptyState, ListRow, PageHeader } from '../components/ui';

const COUNT_DUE_DAYS = 30;

interface OutletAuditRow {
  outlet: Outlet;
  liveOnHand: number;
  lastCountDate: string | null;
  lastCountVariance: number;
  inTransit: number;
  unexplainedVariance: number;
  countStatus: 'ok' | 'due' | 'overdue' | 'never';
  loading: boolean;
  error?: string;
}

function countStatusFromDate(countDate: string | null): OutletAuditRow['countStatus'] {
  if (!countDate) return 'never';
  const d = new Date(countDate + 'T12:00:00');
  const days = Math.floor((Date.now() - d.getTime()) / (86400000));
  if (days <= COUNT_DUE_DAYS) return 'ok';
  if (days <= COUNT_DUE_DAYS * 2) return 'due';
  return 'overdue';
}

function StatusBadge({ status }: { status: OutletAuditRow['countStatus'] }) {
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
        <CheckCircle2 size={12} /> OK
      </span>
    );
  }
  if (status === 'never') {
    return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">Never counted</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
      <AlertTriangle size={12} /> {status === 'overdue' ? 'Overdue' : 'Due'}
    </span>
  );
}

export function AuditDashboard() {
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [rows, setRows] = useState<OutletAuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => defaultReconcileRange(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: outletList, error: oErr } = await supabase.from('outlets').select('*').order('name');
      if (oErr) throw new Error(oErr.message);
      setOutlets(outletList ?? []);

      const initial: OutletAuditRow[] = (outletList ?? []).map((outlet) => ({
        outlet,
        liveOnHand: 0,
        lastCountDate: null,
        lastCountVariance: 0,
        inTransit: 0,
        unexplainedVariance: 0,
        countStatus: 'never' as const,
        loading: true,
      }));
      setRows(initial);

      const { data: liveInv } = await supabase
        .from('outlet_inventory')
        .select('outlet_id, quantity_on_hand');

      const liveByOutlet = new Map<string, number>();
      for (const row of liveInv ?? []) {
        const oid = row.outlet_id as string;
        liveByOutlet.set(oid, (liveByOutlet.get(oid) ?? 0) + Number(row.quantity_on_hand ?? 0));
      }

      const results = await Promise.all(
        (outletList ?? []).map(async (outlet) => {
          try {
            const recon = await reconcileOutletStock({
              outletId: outlet.id,
              from: range.start,
              to: range.end,
              includeRawMaterials: true,
            });
            if (!recon.success) {
              return { outlet, error: recon.error ?? 'failed', recon: null as ReconcileOutletStockResult | null };
            }
            return { outlet, error: undefined, recon };
          } catch (e) {
            return {
              outlet,
              error: e instanceof Error ? e.message : 'failed',
              recon: null as ReconcileOutletStockResult | null,
            };
          }
        })
      );

      setRows(
        results.map(({ outlet, error: rowErr, recon }) => {
          const lastTake = recon?.last_stock_take;
          const countDate =
            lastTake && typeof lastTake === 'object' && lastTake.count_date
              ? String(lastTake.count_date)
              : null;
          return {
            outlet,
            liveOnHand: liveByOutlet.get(outlet.id) ?? Number(recon?.live_on_hand ?? 0),
            lastCountDate: countDate,
            lastCountVariance: Number(
              lastTake && typeof lastTake === 'object' ? lastTake.total_variance ?? 0 : 0
            ),
            inTransit: Number(recon?.in_transit_supply ?? 0) + Number(recon?.in_transit_transfer ?? 0),
            unexplainedVariance: Number(recon?.unexplained_variance ?? 0),
            countStatus: countStatusFromDate(countDate),
            loading: false,
            error: rowErr,
          };
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit dashboard');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const problemCount = rows.filter((r) => Math.abs(r.unexplainedVariance) > 0.001 || r.countStatus === 'overdue' || r.countStatus === 'never').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Outlet Audit Dashboard"
        description="Cross-outlet stock integrity: live on-hand, last stock take, in-transit units, and unexplained variance (last 30 days)."
        actions={
          <Button variant="secondary" type="button" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      <p className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-2 text-sm text-stone-700">
        Period for variance: {formatDateForInput(range.start)} → {formatDateForInput(range.end)}.
        Drill down per outlet in{' '}
        <Link to="/reconciliation" className="font-medium text-teal-600 hover:underline">Stock Reconciliation</Link>.
      </p>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {!loading && problemCount > 0 && (
        <AlertsPanel
          title="Attention needed"
          alerts={
            rows
              .filter((r) => !r.loading && (Math.abs(r.unexplainedVariance) > 0.001 || r.countStatus !== 'ok'))
              .slice(0, 8)
              .map(
                (r): AlertItem => ({
                  id: `audit-${r.outlet.id}`,
                  tone: Math.abs(r.unexplainedVariance) > 0.001 || r.countStatus === 'overdue' || r.countStatus === 'never' ? 'red' : 'amber',
                  title: r.outlet.name,
                  detail:
                    Math.abs(r.unexplainedVariance) > 0.001
                      ? `Unexplained variance ${r.unexplainedVariance}`
                      : `Count status: ${r.countStatus}`,
                  to: `/reconciliation?outlet=${r.outlet.id}`,
                })
              )
          }
        />
      )}

      {outlets.length === 0 && !loading ? (
        <div className="panel py-2">
          <EmptyState
            title="No outlets configured"
            description="Add outlets in Distribution first."
          />
        </div>
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {loading && rows.length === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-stone-400">Loading audit data…</p>
            ) : (
              rows.map((row) => (
                <ListRow
                  key={row.outlet.id}
                  title={row.outlet.name}
                  meta={`${row.lastCountDate ?? '—'} · ${row.countStatus}`}
                  body={
                    <div className="space-y-1 text-xs tabular-nums text-stone-600">
                      <p>On-hand {row.liveOnHand.toLocaleString()}</p>
                      <p>Transit {row.inTransit.toLocaleString()}</p>
                      <p className={Math.abs(row.unexplainedVariance) > 0.001 ? 'font-semibold text-amber-700' : ''}>
                        Unexplained {row.loading ? '…' : row.unexplainedVariance.toLocaleString()}
                      </p>
                      {row.error ? <p className="text-red-600">{row.error}</p> : null}
                    </div>
                  }
                  aside={
                    <div className="flex flex-col items-end gap-1 text-xs">
                      <Link to={`/reconciliation?outlet=${row.outlet.id}`} className="font-medium text-teal-600 hover:underline">
                        Reconcile
                      </Link>
                      <Link to={`/stock-take?outlet=${row.outlet.id}`} className="font-medium text-teal-600 hover:underline">
                        Stock take
                      </Link>
                    </div>
                  }
                />
              ))
            )}
          </div>

          <div className="panel hidden overflow-x-auto md:block">
            <table className="data-table min-w-[800px]">
              <thead>
                <tr>
                  <th>Outlet</th>
                  <th className="text-right">Live on-hand</th>
                  <th>Last count</th>
                  <th className="text-right">Count variance</th>
                  <th className="text-right">In transit</th>
                  <th className="text-right">Unexplained (30d)</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-stone-400">Loading audit data…</td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.outlet.id}>
                      <td className="font-medium">{row.outlet.name}</td>
                      <td className="text-right tabular-nums">{row.liveOnHand.toLocaleString()}</td>
                      <td className="text-stone-600">{row.lastCountDate ?? '—'}</td>
                      <td className="text-right tabular-nums">{row.lastCountVariance.toLocaleString()}</td>
                      <td className="text-right tabular-nums">{row.inTransit.toLocaleString()}</td>
                      <td className={`text-right tabular-nums font-semibold ${Math.abs(row.unexplainedVariance) > 0.001 ? 'text-amber-700' : ''}`}>
                        {row.loading ? '…' : row.unexplainedVariance.toLocaleString()}
                      </td>
                      <td><StatusBadge status={row.countStatus} /></td>
                      <td>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          <Link
                            to={`/reconciliation?outlet=${row.outlet.id}`}
                            className="text-teal-600 hover:underline"
                          >
                            Reconcile
                          </Link>
                          <Link
                            to={`/stock-take?outlet=${row.outlet.id}`}
                            className="text-teal-600 hover:underline"
                          >
                            Stock take
                          </Link>
                        </div>
                        {row.error && <span className="mt-1 block text-xs text-red-600">{row.error}</span>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
