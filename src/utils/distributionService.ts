/**
 * Distribution Workflow Service
 * Handles supply orders with inventory reservations and fulfillment
 */

import { supabase } from './supabase';
import { writeLedgerEntry } from './ledger';
import {
  checkInventoryAvailability,
  reserveInventory,
  releaseReservation,
} from './inventory';
import { retryWithBackoff } from './errorHandling';

export interface SupplyOrderItem {
  product_batch: string;
  hubInventoryId: string;
  quantity: number;
}

export interface SupplyOrderParams {
  outletId: string;
  /** Supply date from picker (persisted as supply_date; dispatch_date starts equal until dispatch) */
  supplyDate: string;
  items: SupplyOrderItem[];
  notes?: string;
}

export interface SupplyOrderCreationResult {
  success: boolean;
  supplyOrderId?: string;
  reservations: Array<{ item: SupplyOrderItem; reserved: boolean; error?: string }>;
  errors: string[];
}

/**
 * Create supply order with atomic reservation of inventory
 * Ensures all items are available before creating the order
 */
export async function createSupplyOrder(
  params: SupplyOrderParams
): Promise<SupplyOrderCreationResult> {
  const errors: string[] = [];
  const reservations: SupplyOrderCreationResult['reservations'] = [];

  try {
    for (const item of params.items) {
      const check = await checkInventoryAvailability(item.hubInventoryId, item.quantity);
      if (!check.canReserve) {
        errors.push(`Item ${item.product_batch}: ${check.message}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, reservations: [], errors };
    }

    const { data: supplyOrder, error: orderErr } = await retryWithBackoff(async () => await
      supabase
        .from('supply_orders')
        .insert({
          outlet_id: params.outletId,
          supply_order_number: generateSupplyOrderNumber(),
          supply_date: params.supplyDate,
          dispatch_date: params.supplyDate,
          status: 'pending',
          total_quantity: params.items.reduce((sum, item) => sum + item.quantity, 0),
          notes: params.notes || null,
        })
        .select('id')
        .single()
    );

    if (orderErr || !supplyOrder) {
      throw new Error(`Failed to create supply order: ${orderErr?.message}`);
    }

    for (const item of params.items) {
      try {
        const result = await retryWithBackoff(async () => await
          reserveInventory({
            hubInventoryId: item.hubInventoryId,
            quantity: item.quantity,
            referenceType: 'supply_order',
            referenceId: supplyOrder.id,
            reason: `Supply order to outlet ${params.outletId}`,
          })
        );

        if (result.success) {
          reservations.push({ item, reserved: true });
        } else {
          throw new Error(result.error || 'Unknown reservation error');
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        reservations.push({ item, reserved: false, error: errorMsg });
        errors.push(`Failed to reserve ${item.product_batch}: ${errorMsg}`);
      }
    }

    if (errors.length > 0) {
      for (const res of reservations) {
        if (res.reserved) {
          await releaseReservation(res.item.hubInventoryId, res.item.quantity, supplyOrder.id);
        }
      }
      await supabase.from('supply_orders').delete().eq('id', supplyOrder.id);
      return { success: false, reservations, errors };
    }

    const { error: linesErr } = await supabase.from('supply_order_lines').insert(
      params.items.map((item) => ({
        supply_order_id: supplyOrder.id,
        hub_inventory_id: item.hubInventoryId,
        product_batch: item.product_batch,
        quantity: item.quantity,
      }))
    );

    if (linesErr) {
      for (const res of reservations) {
        if (res.reserved) {
          await releaseReservation(res.item.hubInventoryId, res.item.quantity, supplyOrder.id);
        }
      }
      await supabase.from('supply_orders').delete().eq('id', supplyOrder.id);
      return {
        success: false,
        reservations,
        errors: [`Failed to save order lines: ${linesErr.message}`],
      };
    }

    const totalQty = params.items.reduce((sum, item) => sum + item.quantity, 0);
    await writeLedgerEntry({
      action: 'created',
      entityType: 'supply_order',
      entityId: supplyOrder.id,
      module: 'distribution',
      operation: 'insert',
      afterData: {
        outlet_id: params.outletId,
        status: 'pending',
        item_count: params.items.length,
        total_quantity: totalQty,
        notes: params.notes || null,
      },
      metadata: { entity_label: 'Supply order created', outlet_id: params.outletId },
    });

    return {
      success: true,
      supplyOrderId: supplyOrder.id,
      reservations,
      errors: [],
    };
  } catch (err) {
    return {
      success: false,
      reservations,
      errors: [...errors, err instanceof Error ? err.message : 'Unknown error'],
    };
  }
}

/**
 * Dispatch supply order — atomically fulfill hub reservations (goods leave hub).
 * Outlet on-hand is credited on receipt.
 */
export async function dispatchSupplyOrder(supplyOrderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('dispatch_supply_order', {
      p_supply_order_id: supplyOrderId,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    const payload = data as { success?: boolean; error?: string; status?: string } | null;
    if (payload?.success === false) {
      return {
        success: false,
        error: formatSupplyOrderRpcError(payload, 'dispatch'),
      };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to dispatch' };
  }
}

/**
 * Confirm receipt at outlet — credit outlet_inventory via atomic DB RPC.
 */
export async function confirmSupplyOrderReceipt(supplyOrderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('receive_supply_order', {
      p_supply_order_id: supplyOrderId,
      p_idempotency_key: crypto.randomUUID(),
    });

    if (error) {
      return { success: false, error: error.message };
    }

    const payload = data as { success?: boolean; error?: string } | null;
    if (payload && payload.success === false) {
      return { success: false, error: payload.error ?? 'receive_supply_order failed' };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to confirm receipt' };
  }
}

/**
 * Cancel a **pending** supply order: releases hub reservations, sets status to cancelled, writes ledger.
 * Inventory-safe only while still pending. For dispatched/received reversals, use `adminDeleteSupplyOrder` (RPC restores hub / outlet).
 */
export async function cancelSupplyOrder(
  supplyOrderId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('cancel_supply_order', {
      p_supply_order_id: supplyOrderId,
      p_reason: reason,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    const payload = data as { success?: boolean; error?: string; status?: string } | null;
    if (payload?.success === false) {
      return {
        success: false,
        error: formatSupplyOrderRpcError(payload, 'cancel'),
      };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to cancel' };
  }
}

function formatSupplyOrderRpcError(
  payload: { error?: string; status?: string },
  action: 'dispatch' | 'cancel'
): string {
  const status = String(payload.status ?? '').toLowerCase().trim();
  if (payload.error === 'supply_order_not_found') return 'Supply order not found';
  if (payload.error === 'not_authenticated_or_inactive') return 'You do not have permission to update this supply order';
  if (payload.error === 'supply_order_has_no_lines') return 'Supply order has no lines to dispatch';
  if (payload.error === 'invalid_status_for_dispatch') return `Cannot dispatch order with status: ${status || 'unknown'}`;
  if (payload.error === 'invalid_status_for_cancel') {
    if (status === 'received') {
      return 'Received orders cannot be cancelled this way. An administrator can use Delete order to reverse inventory.';
    }
    if (status === 'dispatched') {
      return 'Dispatched orders cannot be cancelled this way — hub stock was already fulfilled. An administrator can use Delete order to reverse the hub shipment.';
    }
    return `Cannot cancel supply order with status: ${status || 'unknown'}`;
  }
  if (payload.error === 'insufficient_reserved_quantity') {
    return `Supply order reservations changed before ${action}; reload and try again.`;
  }
  return payload.error ?? `Could not ${action} supply order`;
}

function generateSupplyOrderNumber(): string {
  const timestamp = Date.now().toString().slice(-8);
  return `SO-${timestamp}`;
}

/** Hard-delete a supply order (admin RPC). Releases reservations (pending), restores hub (dispatched/received), reduces outlet (received). Cancelled = delete row only. */
export async function adminDeleteSupplyOrder(options: {
  supplyOrderId: string;
  supplyOrderNumber: string;
  status: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('admin_delete_supply_order', {
      p_supply_order_id: options.supplyOrderId,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    await writeLedgerEntry({
      action: 'deleted',
      entityType: 'supply_order',
      entityId: options.supplyOrderId,
      module: 'distribution',
      operation: 'delete',
      beforeData: {
        supply_order_number: options.supplyOrderNumber,
        status: options.status,
      },
      metadata: { entity_label: options.supplyOrderNumber, prior_status: options.status },
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to delete supply order',
    };
  }
}

/** Hard-delete an outlet (admin RPC). Blocked while any supply_orders reference it. */
export async function adminDeleteOutlet(options: {
  outletId: string;
  outletName: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('admin_delete_outlet', {
      p_outlet_id: options.outletId,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    await writeLedgerEntry({
      action: 'deleted',
      entityType: 'outlet',
      entityId: options.outletId,
      module: 'distribution',
      operation: 'delete',
      beforeData: { name: options.outletName },
      metadata: { entity_label: options.outletName },
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to delete outlet',
    };
  }
}

// ---- Outlet transfers (outlet_inventory → outlet) ----

export interface OutletTransferLineInput {
  outletInventoryId: string;
  quantity: number;
}

export interface CreateOutletTransferParams {
  fromOutletId: string;
  toOutletId: string;
  lines: OutletTransferLineInput[];
  notes?: string;
}

type OutletTransferRpc = {
  success?: boolean;
  error?: string;
  outlet_transfer_id?: string;
  transfer_number?: string;
};

/** Two-step outlet transfer (pending reserves source → dispatched deducts source → received credits dest). */
export async function createOutletTransfer(params: CreateOutletTransferParams): Promise<{
  success: boolean;
  outletTransferId?: string;
  transferNumber?: string;
  error?: string;
}> {
  try {
    if (params.fromOutletId === params.toOutletId) {
      return { success: false, error: 'Source and destination outlet must differ' };
    }

    const { data, error } = await retryWithBackoff(async () =>
      supabase.rpc('create_outlet_transfer', {
        p_from_outlet_id: params.fromOutletId,
        p_lines: params.lines.map((l) => ({
          outlet_inventory_id: l.outletInventoryId,
          quantity: l.quantity,
        })),
        p_notes: params.notes ?? null,
        p_to_outlet_id: params.toOutletId,
      })
    );

    if (error) return { success: false, error: error.message };

    const r = data as OutletTransferRpc | null;
    if (!r?.success) return { success: false, error: r?.error ?? 'Failed to create outlet transfer' };

    return {
      success: true,
      outletTransferId: r.outlet_transfer_id,
      transferNumber: r.transfer_number,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create outlet transfer' };
  }
}

export async function dispatchOutletTransfer(transferId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await retryWithBackoff(async () =>
      supabase.rpc('dispatch_outlet_transfer', { p_transfer_id: transferId })
    );
    if (error) return { success: false, error: error.message };
    const r = data as OutletTransferRpc | null;
    if (!r?.success) return { success: false, error: r?.error ?? 'Dispatch failed' };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Dispatch failed' };
  }
}

export async function receiveOutletTransfer(transferId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await retryWithBackoff(async () =>
      supabase.rpc('receive_outlet_transfer', { p_transfer_id: transferId })
    );
    if (error) return { success: false, error: error.message };
    const r = data as OutletTransferRpc | null;
    if (!r?.success) return { success: false, error: r?.error ?? 'Receive failed' };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Receive failed' };
  }
}

/** Pending: releases reservation on source. Dispatched: restores quantity on source (goods never landed at destination). */
export async function cancelOutletTransfer(transferId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await retryWithBackoff(async () =>
      supabase.rpc('cancel_outlet_transfer', { p_transfer_id: transferId })
    );
    if (error) return { success: false, error: error.message };
    const r = data as OutletTransferRpc | null;
    if (!r?.success) return { success: false, error: r?.error ?? 'Cancel failed' };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Cancel failed' };
  }
}
