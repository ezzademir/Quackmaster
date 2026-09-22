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
  // P0 sales atomic (067)
  'fifo_alloc_internal_error',
  'fifo_line_alloc_failed',
  'outlet_inventory_row_missing_mid_post',
  'outlet_stock_missing_for_reversal',
  'insufficient_stock',
  'insufficient_available',
  'outlet_inventory_row_not_found',
  'replace_sales_journal_void_failed',
  'replace_sales_journal_repost_failed',
  'journal_not_found_or_not_posted',
  'admin_required',
  // P0 transfer RLS / RPC auth (067)
  'transfer_not_found',
  'invalid_status',
  'cannot_cancel_received',
  'already_cancelled',
  'cannot_fulfill_reserved',
  'outlet_inventory_not_found',
  'inventory_wrong_outlet',
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

export function salesJournalErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not_authenticated_or_inactive':
      return 'You must be an active staff member (or outlet supervisor) to post sales.';
    case 'insufficient_stock':
    case 'insufficient_available':
      return 'Not enough outlet stock available for this sale.';
    case 'fifo_alloc_internal_error':
    case 'fifo_line_alloc_failed':
      return 'Sale could not be allocated to stock rows (inventory changed mid-post). Retry after refreshing stock.';
    case 'outlet_inventory_row_missing_mid_post':
    case 'outlet_inventory_row_not_found':
      return 'An outlet inventory row disappeared mid-post. Refresh and try again.';
    case 'outlet_stock_missing_for_reversal':
      return 'Cannot void: outlet stock row for reversal is missing.';
    case 'admin_required':
      return 'Only an admin can void or replace this sales journal.';
    case 'replace_sales_journal_void_failed':
    case 'replace_sales_journal_repost_failed':
      return 'Sale was not updated. The original posted journal is unchanged.';
    case 'journal_not_found_or_not_posted':
      return 'This sale is no longer posted and cannot be edited.';
    default:
      return code ? `Could not complete sales journal (${code}).` : 'Could not complete sales journal.';
  }
}

export function outletTransferErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not_authenticated_or_inactive':
      return 'You must be active staff or admin to manage outlet transfers.';
    case 'transfer_not_found':
      return 'This outlet transfer no longer exists.';
    case 'invalid_status':
      return 'This transfer is not in a status that allows that action.';
    case 'cannot_cancel_received':
      return 'Received transfers cannot be cancelled.';
    case 'already_cancelled':
      return 'This transfer is already cancelled.';
    case 'cannot_fulfill_reserved':
      return 'Cannot dispatch: reserved source stock is no longer available.';
    case 'outlet_inventory_not_found':
    case 'inventory_wrong_outlet':
      return 'Transfer line inventory is missing or not on the source outlet.';
    case 'invalid_outlets':
      return 'Source and destination outlets are invalid.';
    case 'invalid_lines':
    case 'invalid_line':
      return 'Transfer lines are invalid.';
    default:
      return code ? `Could not complete outlet transfer (${code}).` : 'Could not complete outlet transfer.';
  }
}

