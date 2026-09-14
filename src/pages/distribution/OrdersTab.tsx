import { ChevronRight, Trash2 } from 'lucide-react';
import { EmptyState, ListRow } from '../../components/ui';
import { formatSupplyCalendarDate, normalizeSOStatus, supplyOrderAllowsAdminHardDelete } from './helpers';
import { StatusBadge } from './StatusBadge';
import type { SOWithOutlet } from './types';

export function OrdersTab({
  orders,
  isAdmin,
  onManage,
  onDelete,
}: {
  orders: SOWithOutlet[];
  isAdmin: boolean;
  onManage: (so: SOWithOutlet) => void;
  onDelete: (so: SOWithOutlet) => void;
}) {
  if (orders.length === 0) {
    return (
      <div className="panel py-2">
        <EmptyState title="No supply orders yet" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 md:hidden">
        {orders.map((so) => (
          <ListRow
            key={so.id}
            title={so.supply_order_number}
            meta={`${so.outlet?.name ?? '—'} · ${formatSupplyCalendarDate(so.supply_date ?? so.dispatch_date)} · ${so.total_quantity} qty`}
            aside={<StatusBadge status={so.status} />}
            body={
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onManage(so)}
                  className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-stone-700"
                >
                  Manage <ChevronRight size={14} />
                </button>
                {isAdmin && supplyOrderAllowsAdminHardDelete(so.status) && (
                  <button
                    type="button"
                    onClick={() => void onDelete(so)}
                    className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700"
                  >
                    <Trash2 size={14} aria-hidden />
                    Delete
                  </button>
                )}
              </div>
            }
          />
        ))}
      </div>

      <div className="panel hidden overflow-x-auto md:block">
        <table className="data-table">
          <thead>
            <tr>
              <th>Order #</th>
              <th>Outlet</th>
              <th className="text-right">Qty</th>
              <th>Supply</th>
              <th className="hidden sm:table-cell">Dispatch</th>
              <th className="hidden md:table-cell">Received</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((so) => (
              <tr key={so.id}>
                <td className="font-medium">{so.supply_order_number}</td>
                <td>{so.outlet?.name ?? '—'}</td>
                <td className="text-right font-medium tabular-nums">{so.total_quantity}</td>
                <td className="whitespace-nowrap tabular-nums text-stone-500">
                  {formatSupplyCalendarDate(so.supply_date ?? so.dispatch_date)}
                </td>
                <td className="hidden whitespace-nowrap tabular-nums text-stone-500 sm:table-cell">
                  {['dispatched', 'received'].includes(normalizeSOStatus(so.status))
                    ? formatSupplyCalendarDate(so.dispatch_date)
                    : '—'}
                </td>
                <td className="hidden whitespace-nowrap tabular-nums text-stone-500 md:table-cell">
                  {so.received_date ? formatSupplyCalendarDate(so.received_date) : '—'}
                </td>
                <td>
                  <StatusBadge status={so.status} />
                </td>
                <td className="text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onManage(so)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-brand-800 hover:underline"
                    >
                      Manage <ChevronRight size={14} />
                    </button>
                    {isAdmin && supplyOrderAllowsAdminHardDelete(so.status) && (
                      <button
                        type="button"
                        onClick={() => void onDelete(so)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
                        title="Delete supply order (admin)"
                      >
                        <Trash2 size={14} aria-hidden />
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
