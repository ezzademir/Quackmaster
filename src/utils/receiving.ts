/**
 * Receiving helpers (pure, unit-tested). record_po_delivery / receive_po_shipment (081) treat
 * quantity_received as the new CUMULATIVE total for the line, and the DB refuses any reduction.
 * The Receiving screen asks for "quantity in this delivery" and converts it here.
 */

export interface ReceivingLineInput {
  id: string;
  quantity_received: number | null;
  /** unit of measure sent with the receipt: the PO line's own unit as-is, else the normalised catalogue unit (see receivingUom) */
  uom?: string;
}

export interface ReceivingDraft {
  /** quantity that arrived in THIS delivery (typed) */
  qty?: string;
  price?: string;
}

/** numeric(14,4) in the DB: round the sum so 5.1 + 0.2 does not become 5.300000000000001. */
export function cumulativeReceived(existing: number | null | undefined, delivered: number): number {
  return Math.round(((Number(existing) || 0) + delivered) * 1e4) / 1e4;
}

export interface DeliveryLine {
  purchase_order_item_id: string;
  quantity_received: number;
  expected_previous_received: number;
  quantity_uom?: string;
  invoice_unit_price?: number;
}

/** Lines with a positive typed delivery quantity -> record_po_delivery payload (cumulative totals). */
export function buildDeliveryLines(items: ReceivingLineInput[], drafts: Record<string, ReceivingDraft | undefined>): DeliveryLine[] {
  const out: DeliveryLine[] = [];
  for (const item of items) {
    const d = drafts[item.id];
    const delivered = Number(d?.qty);
    if (!(delivered > 0) || !Number.isFinite(delivered)) continue;
    const existing = Number(item.quantity_received) || 0;
    const line: DeliveryLine = {
      purchase_order_item_id: item.id,
      quantity_received: cumulativeReceived(existing, delivered),
      expected_previous_received: existing,
      ...(item.uom ? { quantity_uom: item.uom } : {}),
    };
    const price = d?.price;
    if (price !== undefined && price.trim() !== '' && Number.isFinite(Number(price)) && Number(price) >= 0) {
      line.invoice_unit_price = Number(price);
    }
    out.push(line);
  }
  return out;
}

export function receivingErrorMessage(res: { error?: string; message?: string; current_received?: number } | null, fallback: string): string {
  if (!res?.error) return fallback;
  switch (res.error) {
    case 'cannot_reduce_received':
      return `Received quantity cannot go down (already ${res.current_received}). Ask an admin to adjust the receipt.`;
    case 'stale_received_quantity':
      return 'Another delivery was recorded on this line while you were typing. The list has been reloaded; enter this delivery again.';
    case 'over_tolerance_needs_admin_reason':
      return 'That is more than the over-receipt tolerance allows. An admin must record it with a reason.';
    case 'do_or_invoice_required':
      return 'Enter a DO number or invoice number.';
    case 'duplicate_line':
      return 'A line appears twice in this delivery.';
    default:
      return res.message ?? res.error;
  }
}
