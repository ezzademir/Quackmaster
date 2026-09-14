import { ChevronRight } from 'lucide-react';
import { EmptyState, ListRow } from '../../components/ui';
import { formatSupplyCalendarDate } from './helpers';
import { StatusBadge } from './StatusBadge';
import type { OTWithOutlets } from './types';

export function TransfersTab({
  transfers,
  onManage,
}: {
  transfers: OTWithOutlets[];
  onManage: (tx: OTWithOutlets) => void;
}) {
  if (transfers.length === 0) {
    return (
      <div className="panel py-2">
        <EmptyState title="No outlet transfers yet" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 md:hidden">
        {transfers.map((tx) => (
          <ListRow
            key={tx.id}
            title={tx.transfer_number}
            meta={`${tx.from_outlet?.name ?? '—'} → ${tx.to_outlet?.name ?? '—'} · ${Number(tx.total_quantity).toLocaleString()} qty`}
            aside={<StatusBadge status={tx.status} />}
            body={
              <button
                type="button"
                onClick={() => onManage(tx)}
                className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-stone-700"
              >
                Manage <ChevronRight size={14} />
              </button>
            }
          />
        ))}
      </div>

      <div className="panel hidden overflow-x-auto md:block">
        <table className="data-table">
          <thead>
            <tr>
              <th>Transfer #</th>
              <th>From</th>
              <th>To</th>
              <th className="text-right">Qty</th>
              <th className="hidden sm:table-cell">Dispatch</th>
              <th className="hidden md:table-cell">Received</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((tx) => (
              <tr key={tx.id}>
                <td className="font-medium">{tx.transfer_number}</td>
                <td>{tx.from_outlet?.name ?? '—'}</td>
                <td>{tx.to_outlet?.name ?? '—'}</td>
                <td className="text-right font-medium tabular-nums">{Number(tx.total_quantity).toLocaleString()}</td>
                <td className="hidden whitespace-nowrap tabular-nums text-stone-500 sm:table-cell">
                  {tx.dispatch_date ? formatSupplyCalendarDate(tx.dispatch_date) : '—'}
                </td>
                <td className="hidden whitespace-nowrap tabular-nums text-stone-500 md:table-cell">
                  {tx.received_date ? formatSupplyCalendarDate(tx.received_date) : '—'}
                </td>
                <td>
                  <StatusBadge status={tx.status} />
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    onClick={() => onManage(tx)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand-800 hover:underline"
                  >
                    Manage <ChevronRight size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
