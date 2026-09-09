/**
 * Pack 2 atomic RPCs may fail either via soft jsonb `{ success:false, error }`
 * (pre-write validation) or via RAISE EXCEPTION (post-write abort). PostgREST
 * surfaces RAISE as `error.message` that includes the exception text.
 */

const KNOWN_ATOMIC_RPC_CODES = [
  'not_authenticated',
  'not_authenticated_or_inactive',
  'invalid_quantity_received',
  'invalid_lines',
  'invalid_po_id',
  'invalid_finished_quantity',
  'invalid_run_status',
  'invalid_status_for_receive',
  'po_item_not_found',
  'po_mismatch',
  'po_not_found',
  'received_exceeds_ordered',
  'cannot_reduce_missing_hub_row',
  'hub_below_reserved',
  'insufficient_hub_quantity',
  'cannot_cancel_missing_hub_row',
  'missing_raw_material',
  'raw_material_hub_row_missing',
  'insufficient_raw_material',
  'production_run_not_found',
  'recipe_not_found',
  'supply_order_not_found',
  'hub_inventory_missing',
  'hub_inventory_invalid_fg',
] as const;

export type AtomicRpcErrorCode = (typeof KNOWN_ATOMIC_RPC_CODES)[number];

/** Prefer an explicit soft-return code; else scan a PostgREST exception message. */
export function extractAtomicRpcErrorCode(
  softError: string | null | undefined,
  exceptionMessage?: string | null
): string | undefined {
  const soft = softError?.trim();
  if (soft) return soft;

  const msg = exceptionMessage?.trim();
  if (!msg) return undefined;

  // Exact match first (RAISE EXCEPTION 'code').
  for (const code of KNOWN_ATOMIC_RPC_CODES) {
    if (msg === code) return code;
  }
  // PostgREST often wraps: `CODE` or `ERROR: code` / trailing detail.
  for (const code of KNOWN_ATOMIC_RPC_CODES) {
    if (msg.includes(code)) return code;
  }
  return msg;
}

export function cancelPurchaseOrderErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not_authenticated':
      return 'You must be signed in to cancel a purchase order.';
    case 'insufficient_hub_quantity':
      return 'Cannot cancel: hub no longer holds enough quantity to undo receipts (inventory may have been used). Reduce usage or reverse manually before deleting.';
    case 'hub_below_reserved':
      return 'Cannot cancel: reversing receipts would drop hub stock below reserved quantity.';
    case 'cannot_cancel_missing_hub_row':
      return 'Cannot cancel: hub inventory row is missing for a received material.';
    case 'po_not_found':
      return 'This purchase order no longer exists.';
    default:
      return code ? `Could not cancel purchase order (${code}).` : 'Could not cancel purchase order.';
  }
}
