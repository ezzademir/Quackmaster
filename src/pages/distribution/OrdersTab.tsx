import { ChevronRight, Trash2, Truck } from 'lucide-react';
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
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Order #</th>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Outlet</th>
            <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Qty</th>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Supply</th>
            <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Dispatch</th>
            <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Received</th>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
            <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {orders.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-6 py-12 text-center">
                <Truck className="mx-auto mb-3 text-gray-300" size={40} />
                <p className="text-gray-400">No supply orders yet</p>
              </td>
            </tr>
          ) : (
            orders.map((so) => (
              <tr key={so.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{so.supply_order_number}</td>
                <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{so.outlet?.name ?? '—'}</td>
                <td className="px-4 md:px-6 py-4 text-right font-semibold text-gray-900 text-xs sm:text-sm">{so.total_quantity}</td>
                <td className="px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">{formatSupplyCalendarDate(so.supply_date ?? so.dispatch_date)}</td>
                <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">
                  {['dispatched', 'received'].includes(normalizeSOStatus(so.status))
                    ? formatSupplyCalendarDate(so.dispatch_date)
                    : '—'}
                </td>
                <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">{so.received_date ? formatSupplyCalendarDate(so.received_date) : '—'}</td>
                <td className="px-4 md:px-6 py-4"><StatusBadge status={so.status} /></td>
                <td className="px-4 md:px-6 py-4">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onManage(so)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                    >
                      Manage <ChevronRight size={14} />
                    </button>
                    {isAdmin && supplyOrderAllowsAdminHardDelete(so.status) && (
                      <button
                        type="button"
                        onClick={() => void onDelete(so)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800"
                        title="Delete supply order (admin)"
                      >
                        <Trash2 size={14} aria-hidden />
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
