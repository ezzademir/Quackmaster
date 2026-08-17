import { useState } from 'react';
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
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 text-sm font-semibold text-gray-900">Hub lots ready to supply</h3>
        <p className="mb-4 text-xs text-gray-500">Printable lot codes. Supply orders allocate these FEFO and the same code arrives at the outlet.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium text-gray-700">Lot</th>
                <th className="px-3 py-2 font-medium text-gray-700">SKU</th>
                <th className="px-3 py-2 font-medium text-gray-700 text-right">Available</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {hubReady.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-8 text-center text-gray-400">
                    {stockView === 'in_stock' && hubProductLines.length > 0
                      ? 'No in-stock hub lots. Switch to All lots for empty / audit.'
                      : 'No hub lots available'}
                  </td>
                </tr>
              ) : (
                hubReady.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 font-mono text-xs font-semibold text-gray-900">
                      {l.lot_label || l.product_batch || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {displaySkuSecond(l.lot_label, l.product_batch, l.recipe_sku) || '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-800">{l.available.toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="mb-1 text-sm font-semibold text-gray-900">Which lot is at which outlet</h3>
        <p className="mb-4 text-xs text-gray-500">Live finished-goods on hand, lot first. SKU is the sellable / PAR group.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium text-gray-700">Outlet</th>
                <th className="px-3 py-2 font-medium text-gray-700">Lot</th>
                <th className="px-3 py-2 font-medium text-gray-700 text-right">On hand</th>
                <th className="px-3 py-2 font-medium text-gray-700 text-right">Available</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {outletReady.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-gray-400">
                    {stockView === 'in_stock' && outletLots.length > 0
                      ? 'No in-stock outlet lots. Switch to All lots for empty / audit.'
                      : 'No finished-goods lots at outlets'}
                  </td>
                </tr>
              ) : (
                outletReady.map((row) => (
                  <tr key={row.key}>
                    <td className="px-3 py-2 text-gray-800">{row.outletName}</td>
                    <td className="px-3 py-2 font-mono text-xs font-semibold text-gray-900">
                      {formatLotWithSku(row.lotLabel, row.productBatch, row.recipeSku)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.onHand.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{row.available.toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
