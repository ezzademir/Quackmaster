import { useState } from 'react';
import { EmptyState, ListRow } from '../../components/ui';
import { StockViewToggle } from '../../components/StockViewToggle';
import { displaySkuSecond, formatLotWithSku } from '../../utils/lotLabel';
import { filterByStockView, type StockView } from '../../utils/stockView';
import type { HubLotLine, OutletLotRow } from './types';

export function LotsTab({
  hubProductLines,
  outletLots,
}: {
  hubProductLines: HubLotLine[];
  outletLots: OutletLotRow[];
}) {
  const [stockView, setStockView] = useState<StockView>('in_stock');
  const hubReady = filterByStockView(hubProductLines, stockView, (l) => l.onHand);
  const outletReady = filterByStockView(outletLots, stockView, (l) => l.onHand);

  return (
    <div className="space-y-6">
      <StockViewToggle value={stockView} onChange={setStockView} />
      <div className="panel p-5">
        <h3 className="mb-1 text-sm font-semibold text-stone-900">Hub lots ready to supply</h3>
        <p className="mb-4 text-xs text-stone-500">
          Printable lot codes. Supply orders allocate these FEFO and the same code arrives at the outlet.
        </p>
        {hubReady.length === 0 ? (
          <EmptyState
            title={
              stockView === 'in_stock' && hubProductLines.length > 0
                ? 'No in-stock hub lots. Switch to All lots for empty / audit.'
                : 'No hub lots available'
            }
          />
        ) : (
          <>
            <div className="space-y-2 md:hidden">
              {hubReady.map((l) => (
                <ListRow
                  key={l.id}
                  title={<span className="font-mono text-xs">{l.lot_label || l.product_batch || '—'}</span>}
                  meta={displaySkuSecond(l.lot_label, l.product_batch, l.recipe_sku) || '—'}
                  aside={<span className="tabular-nums text-sm font-medium">{l.available.toLocaleString()}</span>}
                />
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>SKU</th>
                    <th className="text-right">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {hubReady.map((l) => (
                    <tr key={l.id}>
                      <td className="font-mono text-xs font-semibold">{l.lot_label || l.product_batch || '—'}</td>
                      <td className="text-xs text-stone-600">
                        {displaySkuSecond(l.lot_label, l.product_batch, l.recipe_sku) || '—'}
                      </td>
                      <td className="text-right tabular-nums">{l.available.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="panel p-5">
        <h3 className="mb-1 text-sm font-semibold text-stone-900">Which lot is at which outlet</h3>
        <p className="mb-4 text-xs text-stone-500">Live finished-goods on hand, lot first. SKU is the sellable / PAR group.</p>
        {outletReady.length === 0 ? (
          <EmptyState
            title={
              stockView === 'in_stock' && outletLots.length > 0
                ? 'No in-stock outlet lots. Switch to All lots for empty / audit.'
                : 'No finished-goods lots at outlets'
            }
          />
        ) : (
          <>
            <div className="space-y-2 md:hidden">
              {outletReady.map((row) => (
                <ListRow
                  key={row.key}
                  title={row.outletName}
                  meta={<span className="font-mono">{formatLotWithSku(row.lotLabel, row.productBatch, row.recipeSku)}</span>}
                  body={
                    <div className="flex gap-4 text-xs tabular-nums">
                      <span>On hand {row.onHand.toLocaleString()}</span>
                      <span>Available {row.available.toLocaleString()}</span>
                    </div>
                  }
                />
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Outlet</th>
                    <th>Lot</th>
                    <th className="text-right">On hand</th>
                    <th className="text-right">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {outletReady.map((row) => (
                    <tr key={row.key}>
                      <td>{row.outletName}</td>
                      <td className="font-mono text-xs font-semibold">
                        {formatLotWithSku(row.lotLabel, row.productBatch, row.recipeSku)}
                      </td>
                      <td className="text-right tabular-nums">{row.onHand.toLocaleString()}</td>
                      <td className="text-right tabular-nums text-stone-700">{row.available.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
