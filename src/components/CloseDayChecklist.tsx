/**
 * Close-the-day checklist — pending receives, transfers, overdue stock takes.
 */

import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ClipboardCheck, AlertTriangle } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { STOCK_TAKE_OVERDUE_DAYS } from '../utils/closeDayChecks';

export interface CloseDayItem {
  id: string;
  severity: 'warn' | 'info';
  title: string;
  detail: string;
  to: string;
}

interface Props {
  outletId?: string | null;
  /** When true, only show items for this outlet (supervisor). */
  singleOutlet?: boolean;
  compact?: boolean;
}

export function CloseDayChecklist({ outletId, singleOutlet, compact }: Props) {
  const [items, setItems] = useState<CloseDayItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const next = await loadCloseDayItems(outletId ?? undefined, !!singleOutlet);
        if (!cancelled) setItems(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [outletId, singleOutlet]);

  if (loading) {
    return <p className="text-sm text-gray-400">Checking day-close items…</p>;
  }
  if (items.length === 0) {
    return (
      <div
        className={`rounded-xl border border-emerald-200 bg-emerald-50/80 ${compact ? 'p-3' : 'p-4'} text-sm text-emerald-900`}
      >
        <span className="inline-flex items-center gap-2 font-semibold">
          <ClipboardCheck size={16} /> Day close looks clear
        </span>
        <p className="mt-1 text-xs text-emerald-800">No pending receives, in-transit transfers, or overdue stock takes.</p>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-amber-200 bg-amber-50/60 ${compact ? 'p-3' : 'p-5'} shadow-sm`}>
      <h2 className={`flex items-center gap-2 font-semibold text-amber-950 ${compact ? 'text-sm' : 'text-base'}`}>
        <AlertTriangle size={18} className="text-amber-700" />
        Close the day
      </h2>
      <p className="mt-1 text-xs text-amber-900/80">Resolve these before leaving so the next count stays trustworthy.</p>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li key={it.id}>
            <Link
              to={it.to}
              className="flex flex-col rounded-lg border border-amber-200/80 bg-white px-3 py-2.5 hover:border-amber-400 transition-colors"
            >
              <span className="text-sm font-medium text-gray-900">{it.title}</span>
              <span className="text-xs text-gray-500">{it.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function loadCloseDayItems(outletId: string | undefined, singleOutlet: boolean): Promise<CloseDayItem[]> {
  const items: CloseDayItem[] = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STOCK_TAKE_OVERDUE_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  let supplyQ = supabase
    .from('supply_orders')
    .select('id, outlet_id, status, total_quantity, outlet:outlet_id(name)')
    .eq('status', 'dispatched');
  if (outletId) supplyQ = supplyQ.eq('outlet_id', outletId);
  const { data: supplies } = await supplyQ.limit(50);

  for (const so of supplies ?? []) {
    const name = (so as { outlet?: { name?: string } | null }).outlet?.name ?? 'Outlet';
    items.push({
      id: `supply-${so.id}`,
      severity: 'warn',
      title: `Receive supply — ${name}`,
      detail: `Dispatched order awaiting receipt (${Number((so as { total_quantity?: number }).total_quantity ?? 0)} units).`,
      to: '/distribution',
    });
  }

  let transferQ = supabase
    .from('outlet_transfers')
    .select('id, from_outlet_id, to_outlet_id, status, total_quantity')
    .eq('status', 'dispatched');
  if (outletId) {
    transferQ = transferQ.or(`from_outlet_id.eq.${outletId},to_outlet_id.eq.${outletId}`);
  }
  const { data: transfers } = await transferQ.limit(50);
  for (const ot of transfers ?? []) {
    items.push({
      id: `xfer-${ot.id}`,
      severity: 'warn',
      title: 'Complete outlet transfer',
      detail: `Transfer in transit (${Number((ot as { total_quantity?: number }).total_quantity ?? 0)} units) — dispatch or receive.`,
      to: '/distribution',
    });
  }

  const { data: outlets } = outletId
    ? await supabase.from('outlets').select('id, name').eq('id', outletId)
    : await supabase.from('outlets').select('id, name').order('name');

  const { data: sessions } = await supabase
    .from('outlet_stock_take_sessions')
    .select('outlet_id, count_date, posted_at')
    .order('posted_at', { ascending: false })
    .limit(500);

  const lastByOutlet = new Map<string, string>();
  for (const s of sessions ?? []) {
    const oid = (s as { outlet_id: string }).outlet_id;
    if (!lastByOutlet.has(oid)) {
      lastByOutlet.set(oid, (s as { count_date: string }).count_date);
    }
  }

  for (const o of outlets ?? []) {
    const last = lastByOutlet.get(o.id);
    if (!last || last < cutoffIso) {
      items.push({
        id: `st-${o.id}`,
        severity: 'warn',
        title: `Stock take overdue — ${o.name}`,
        detail: last
          ? `Last count ${last} (over ${STOCK_TAKE_OVERDUE_DAYS} days).`
          : `No stock take recorded in the last ${STOCK_TAKE_OVERDUE_DAYS} days.`,
        to: singleOutlet || outletId ? `/stock-take?outlet=${o.id}` : `/stock-take?outlet=${o.id}`,
      });
    }
  }

  return items;
}
