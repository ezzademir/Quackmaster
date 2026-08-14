import type { Outlet, OutletTransfer, SupplyOrder } from '../../types';

export type DistributionTab = 'orders' | 'outlets' | 'transfers' | 'lots';

export type SOWithOutlet = SupplyOrder & { outlet?: Outlet };

export type OTWithOutlets = OutletTransfer & { from_outlet?: Outlet; to_outlet?: Outlet };

export interface HubLotLine {
  id: string;
  product_batch: string | null;
  available: number;
  last_updated?: string;
  expiry_date?: string | null;
  lot_label?: string | null;
}

export interface OutletStockRow {
  outletId: string;
  outletName: string;
  onHand: number;
  availableSellable: number;
  awaitingReceiptQty: number;
  pendingSupplyQty: number;
  currentOnHandSnapshot?: number;
}

export interface OutletLotRow {
  key: string;
  outletId: string;
  outletName: string;
  lotLabel: string | null;
  productBatch: string | null;
  onHand: number;
  available: number;
}
