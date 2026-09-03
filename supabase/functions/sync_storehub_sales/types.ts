export interface ShStore {
  id: string;
  name?: string;
}

export interface ShProduct {
  id: string;
  name?: string;
  sku?: string;
  category?: string;
  isParentProduct?: boolean;
}

export interface ShItem {
  productId?: string;
  quantity?: number;
  itemType?: string;
  total?: number;
  subTotal?: number;
  tax?: number;
  taxCode?: string;
  discount?: number;
  unitPrice?: number;
  promotions?: ShPromo[];
}

export interface ShPayment {
  paymentMethod?: string;
  amount?: number;
}

export interface ShPromo {
  name?: string;
  id?: string;
  discountAmount?: number;
  amount?: number;
}

export interface ShTxn {
  refId?: string;
  invoiceNumber?: string;
  storeId?: string;
  registerId?: string;
  employeeId?: string;
  transactionType?: string;
  transactionTime?: string;
  total?: number;
  subTotal?: number;
  tax?: number;
  discount?: number;
  roundedAmount?: number;
  serviceCharge?: number;
  promotions?: ShPromo[];
  items?: ShItem[];
  payments?: ShPayment[];
  isCancelled?: boolean;
  channel?: string;
}

export interface ShEmployee {
  id?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
}

export interface ShStock {
  productId?: string;
  quantityOnHand?: number;
}

export type ReportId =
  | "sales_over_time"
  | "sales_by_product"
  | "sales_by_category"
  | "sales_by_sku"
  | "sales_by_payment"
  | "sales_by_channel"
  | "promotions"
  | "tax"
  | "employee"
  | "offline_txns"
  | "online_txns"
  | "returns"
  | "stock_value";

export type ViewBy = "day" | "week" | "month" | "hour";

export type DiffStatus =
  | "match"
  | "qty_mismatch"
  | "missing_in_dashboard"
  | "extra_in_dashboard"
  | "pos_only";

export interface ReportRow {
  key: string;
  label: string;
  posQty: number | null;
  posRm: number | null;
  dashQty: number | null;
  status: DiffStatus;
  detail?: string;
}

export interface ReportResult {
  report: string;
  from: string | null;
  to: string | null;
  viewBy?: ViewBy;
  snapshot?: boolean;
  posOnly: boolean;
  notice: string | null;
  error: string | null;
  columns: { key: string; label: string }[];
  rows: ReportRow[];
  totals: {
    posQty: number;
    posRm: number;
    dashQty: number;
    match: number;
    qty_mismatch: number;
    missing_in_dashboard: number;
    extra_in_dashboard: number;
    pos_only: number;
  };
}
