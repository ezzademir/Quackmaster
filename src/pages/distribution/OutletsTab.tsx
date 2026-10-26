import { CreditCard as Edit2, Trash2 } from 'lucide-react';
import type { Outlet } from '../../types';
import type { OutletStockRow } from './types';
import { EmptyState, ListRow } from '../../components/ui';

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
  if (outlets.length === 0) {
    return (
      <div className="panel py-2">
        <EmptyState title="No outlets added yet" />
      </div>
    );
  }

  return (
    <div className="ios-group">
      {outlets.map((outlet) => {
        const stock = outletStockById.get(outlet.id);
        const place = [outlet.city, outlet.country].filter(Boolean).join(', ');
        return (
          <ListRow
            key={outlet.id}
            title={outlet.name}
            meta={[outlet.location_code, place, outlet.manager_name].filter(Boolean).join(' · ')}
            body={
              <div className="space-y-2">
                <p className="text-[13px] text-stone-500">
                  On hand {(stock?.onHand ?? 0).toLocaleString()}
                  {(stock?.pendingSupplyQty ?? 0) > 0 ? ` · pending ${(stock?.pendingSupplyQty ?? 0).toLocaleString()}` : ''}
                  {(stock?.awaitingReceiptQty ?? 0) > 0
                    ? ` · awaiting receipt ${(stock?.awaitingReceiptQty ?? 0).toLocaleString()}`
                    : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(outlet)}
                    className="inline-flex min-h-11 items-center gap-1 rounded-full bg-stone-100 px-4 text-[15px] font-medium text-stone-800"
                  >
                    <Edit2 size={16} aria-hidden /> Edit
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => void onDelete(outlet.id)}
                      className="inline-flex min-h-11 items-center gap-1 rounded-full bg-red-50 px-4 text-[15px] font-medium text-red-700"
                    >
                      <Trash2 size={16} aria-hidden /> Delete
                    </button>
                  )}
                </div>
              </div>
            }
          />
        );
      })}
    </div>
  );
}
