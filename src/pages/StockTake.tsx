import { useEffect, useState } from 'react';
import type { Outlet } from '../types';
import { OutletStockTakeTab } from '../components/outletStockTake/OutletStockTakeTab';
import { useAuth } from '../utils/auth';
import { supabase } from '../utils/supabase';

export function StockTake() {
  const { isSupervisor, profile } = useAuth();
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr('');
      try {
        if (isSupervisor) {
          const oid = profile?.assigned_outlet_id;
          if (!oid) {
            if (!cancelled) {
              setErr(
                'No outlet is assigned to your account. Ask an admin to set your role and outlet under Users.'
              );
              setOutlets([]);
            }
            return;
          }
          const { data, error } = await supabase.from('outlets').select('*').eq('id', oid).maybeSingle();
          if (cancelled) return;
          if (error || !data) {
            setErr('Could not load your outlet.');
            setOutlets([]);
            return;
          }
          setOutlets([data as Outlet]);
          return;
        }

        const { data, error } = await supabase.from('outlets').select('*').order('name');
        if (cancelled) return;
        if (error) {
          setErr(error.message ?? 'Could not load outlets.');
          setOutlets([]);
          return;
        }
        setOutlets((data ?? []) as Outlet[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSupervisor, profile?.assigned_outlet_id]);

  if (loading) {
    return <div className="text-sm text-gray-500">Loading…</div>;
  }
  if (err) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{err}</div>;
  }
  if (outlets.length === 0) {
    return (
      <div className="rounded-lg border border-amber-100 bg-amber-50/80 p-4 text-sm text-amber-950">
        No outlets are available for stock take yet.
      </div>
    );
  }

  const lockedId = isSupervisor ? profile?.assigned_outlet_id ?? null : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Outlet stock take</h1>
        <p className="mt-1 text-sm text-gray-500">
          {isSupervisor
            ? `${outlets[0]?.name ?? 'Your outlet'} · count and post for your outlet only.`
            : 'Choose an outlet to load rows, count physical stock, and post adjustments.'}
        </p>
      </div>
      <OutletStockTakeTab outlets={outlets} lockedOutletId={lockedId} />
    </div>
  );
}
