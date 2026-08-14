import { CreditCard as Edit2, MapPin, Trash2 } from 'lucide-react';
import type { Outlet } from '../../types';
import type { OutletStockRow } from './types';

export function OutletsTab({
  outlets,
  outletStockById,
  isAdmin,
  onEdit,
  onDelete,
}: {
  outlets: Outlet[];
  outletStockById: Map<string, OutletStockRow>;
  isAdmin: boolean;
  onEdit: (outlet: Outlet) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
      {outlets.length === 0 ? (
        <div className="sm:col-span-3 rounded-xl border-2 border-dashed border-gray-200 px-6 py-12 text-center text-gray-400">
          No outlets added yet
        </div>
      ) : (
        outlets.map((outlet) => {
          const stock = outletStockById.get(outlet.id);
          return (
            <div key={outlet.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-teal-200 transition-all">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-teal-100 p-2 text-teal-600"><MapPin size={18} /></div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{outlet.name}</h3>
                    <p className="text-xs text-gray-400">{outlet.location_code}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => onEdit(outlet)} className="p-1 text-gray-400 hover:text-blue-600 transition-colors"><Edit2 size={15} /></button>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => void onDelete(outlet.id)}
                      className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                      title="Delete outlet (admin)"
                    >
                      <Trash2 size={15} aria-hidden />
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/80 px-3 py-2 text-xs">
                <p className="font-semibold text-emerald-900">
                  Stock on hand:{' '}
                  <span className="tabular-nums">{(stock?.onHand ?? 0).toLocaleString()}</span>
                </p>
                {(stock?.pendingSupplyQty ?? 0) > 0 && (
                  <p className="mt-0.5 text-blue-800">
                    Pending orders (hub reserved):{' '}
                    <span className="font-semibold tabular-nums">
                      {(stock?.pendingSupplyQty ?? 0).toLocaleString()}
                    </span>
                  </p>
                )}
                {(stock?.awaitingReceiptQty ?? 0) > 0 && (
                  <p className="mt-0.5 text-amber-800">
                    Dispatched, awaiting receipt:{' '}
                    <span className="font-semibold tabular-nums">
                      {(stock?.awaitingReceiptQty ?? 0).toLocaleString()}
                    </span>{' '}
                    <span className="font-normal text-gray-600">(not in on hand yet)</span>
                  </p>
                )}
              </div>
              <div className="mt-4 space-y-1 text-xs text-gray-600">
                {outlet.city && <p>{outlet.city}{outlet.country ? `, ${outlet.country}` : ''}</p>}
                {outlet.address && <p className="text-gray-400 line-clamp-1">{outlet.address}</p>}
                {outlet.manager_name && (
                  <div className="mt-2 border-t border-gray-100 pt-2">
                    <p className="font-medium text-gray-700">{outlet.manager_name}</p>
                    {outlet.manager_phone && <p>{outlet.manager_phone}</p>}
                    {outlet.manager_email && <p className="text-gray-400">{outlet.manager_email}</p>}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
