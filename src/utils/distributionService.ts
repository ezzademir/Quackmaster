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
  fulfillReservation,
} from './inventory';
import { retryWithBackoff } from './errorHandling';

export interface SupplyOrderItem {
  /** Finished-goods batch label; null for raw-material hub lines. */
  product_batch: string | null;
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
        errors.push(`Item ${item.product_batch ?? 'raw material'}: ${check.message}`);
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
        errors.push(`Failed to reserve ${item.product_batch ?? 'raw material'}: ${errorMsg}`);
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
        product_batch: item.product_batch ?? null,
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
 * Dispatch supply order — fulfill hub reservations (goods leave hub). Outlet on-hand is credited on receipt.
 */
export async function dispatchSupplyOrder(supplyOrderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: order, error: orderErr } = await supabase
      .from('supply_orders')
      .select('id, status, outlet_id')
      .eq('id', supplyOrderId)
      .single();

    if (orderErr || !order) {
      return { success: false, error: 'Supply order not found' };
    }

    if (order.status !== 'pending') {
      return { success: false, error: `Cannot dispatch order with status: ${order.status}` };
    }

    const { data: lines } = await supabase
      .from('supply_order_lines')
      .select('hub_inventory_id, quantity, product_batch')
      .eq('supply_order_id', supplyOrderId);

    if (lines?.length) {
      for (const line of lines) {
        const result = await fulfillReservation(
          line.hub_inventory_id,
          Number(line.quantity),
          supplyOrderId
        );
        if (!result.success) {
          return { success: false, error: result.error ?? 'Failed to fulfill hub reservation' };
        }
      }
    }

    await retryWithBackoff(async () => await
      supabase
        .from('supply_orders')
        .update({ status: 'dispatched', dispatch_date: new Date().toISOString().split('T')[0] })
        .eq('id', supplyOrderId)
    );

    const dispatchDate = new Date().toISOString().split('T')[0];
    await writeLedgerEntry({
      action: 'dispatched',
      entityType: 'supply_order',
      entityId: supplyOrderId,
      module: 'distribution',
      operation: 'update',
      afterData: { status: 'dispatched', dispatch_date: dispatchDate },
      metadata: { entity_label: 'Supply order dispatched' },
    });

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
    const { data: order } = await supabase
      .from('supply_orders')
      .select('id, status')
      .eq('id', supplyOrderId)
      .single();

    if (!order) {
      return { success: false, error: 'Supply order not found' };
    }

    const st = String(order.status ?? '').toLowerCase().trim();
    if (st === 'cancelled') {
      return { success: true };
    }
    if (st !== 'pending') {
      if (st === 'received') {
        return {
          success: false,
          error:
            'Received orders cannot be cancelled this way. An administrator can use Delete order to reverse inventory.',
        };
      }
      if (st === 'dispatched') {
        return {
          success: false,
          error:
            'Dispatched orders cannot be cancelled this way — hub stock was already fulfilled. An administrator can use Delete order to reverse the hub shipment.',
        };
      }
      return { success: false, error: `Cannot cancel supply order with status “${st}”.` };
    }

    const { data: lines } = await supabase
      .from('supply_order_lines')
      .select('hub_inventory_id, quantity')
      .eq('supply_order_id', supplyOrderId);

    if (lines?.length) {
      for (const line of lines) {
        const result = await releaseReservation(
          line.hub_inventory_id,
          Number(line.quantity),
          supplyOrderId
        );
        if (!result.success) {
          return { success: false, error: result.error ?? 'Failed to release reservation' };
        }
      }
    }

    await retryWithBackoff(async () => await
      supabase.from('supply_orders').update({ status: 'cancelled' }).eq('id', supplyOrderId)
    );

    await writeLedgerEntry({
      action: 'cancelled',
      entityType: 'supply_order',
      entityId: supplyOrderId,
      module: 'distribution',
      operation: 'update',
      afterData: { status: 'cancelled' },
      metadata: { entity_label: 'Supply order cancelled', cancellation_reason: reason },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to cancel' };
  }
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
