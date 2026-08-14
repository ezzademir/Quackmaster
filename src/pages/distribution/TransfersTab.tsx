import { ArrowLeftRight, ChevronRight } from 'lucide-react';
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
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Transfer #</th>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">From</th>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">To</th>
            <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Qty</th>
            <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Dispatch</th>
            <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Received</th>
            <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
            <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {transfers.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-6 py-12 text-center">
                <ArrowLeftRight className="mx-auto mb-3 text-gray-300" size={40} />
                <p className="text-gray-400">No outlet transfers yet</p>
              </td>
            </tr>
          ) : (
            transfers.map((tx) => (
              <tr key={tx.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{tx.transfer_number}</td>
                <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{tx.from_outlet?.name ?? '—'}</td>
                <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{tx.to_outlet?.name ?? '—'}</td>
                <td className="px-4 md:px-6 py-4 text-right font-semibold text-gray-900 text-xs sm:text-sm">
                  {Number(tx.total_quantity).toLocaleString()}
                </td>
                <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">
                  {tx.dispatch_date ? formatSupplyCalendarDate(tx.dispatch_date) : '—'}
                </td>
                <td className="hidden md:table-cell px-4 md:px-6 py-4 text-gray-500 text-xs tabular-nums whitespace-nowrap">
                  {tx.received_date ? formatSupplyCalendarDate(tx.received_date) : '—'}
                </td>
                <td className="px-4 md:px-6 py-4">
                  <StatusBadge status={tx.status} />
                </td>
                <td className="px-4 md:px-6 py-4">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onManage(tx)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                    >
                      Manage <ChevronRight size={14} />
                    </button>
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
