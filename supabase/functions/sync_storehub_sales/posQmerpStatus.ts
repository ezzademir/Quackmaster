/** Qty compare epsilon used by SHPOS vs QMERP match chips. */
export const QTY_EPS = 0.0001;

export type PosQmerpDiffStatus =
  | "match"
  | "qty_mismatch"
  | "missing_in_dashboard"
  | "extra_in_dashboard";

export function qtyEq(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) < QTY_EPS;
}

/**
 * Match SHPOS sold to all posted Outlet Sales (StoreHub ingest + manual).
 * Manual journals close a gap: with ingest off they are the live write path,
 * and a StoreHub-only compare flags every keyed SKU as missing in QMERP.
 */
export function posVsQmerpSoldStatus(
  posQty: number,
  qmerpSoldQty: number,
): PosQmerpDiffStatus {
  if (qtyEq(posQty, qmerpSoldQty)) return "match";
  if (posQty > 0 && qmerpSoldQty === 0) return "missing_in_dashboard";
  if (posQty === 0 && qmerpSoldQty > 0) return "extra_in_dashboard";
  return "qty_mismatch";
}
