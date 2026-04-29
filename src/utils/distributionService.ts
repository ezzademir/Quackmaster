/**
 * Distribution Workflow Service
 * Handles supply orders with inventory reservations and fulfillment
 */

import { supabase } from './supabase';
import { writeLedgerEntry } from './ledger';
import { logActivity } from './activityLog';
import {
  checkInventoryAvailability,
  reserveInventory,
  releaseReservation,
  fulfillReservation,
} from './inventory';
import { retryWithBackoff } from './errorHandling';

export interface SupplyOrderItem {
  product_batch: string;
  hubInventoryId: string;
  quantity: number;
}

export interface SupplyOrderParams {
  outletId: string;
  dispatchDate: string;
  items: SupplyOrderItem[];
  notes?: string;
}

export interface SupplyOrderCreationResult {
  success: boolean;
  supplyOrderId?: string;
  reservations: Array<{ item: SupplyOrderItem; reserved: boolean; error?: string }>;
  errors: string[];
}

/** Credit outlet_inventory after Hub confirms shipment delivered */
async function bumpOutletStock(
  outletId: string,
  productBatch: string,
  qty: number
): Promise<{ success: boolean; error?: string }> {
  const { data: existing, error: selErr } = await supabase
    .from('outlet_inventory')
    .select('id, quantity_on_hand, reserved_quantity')
    .eq('outlet_id', outletId)
    .eq('product_batch', productBatch)
    .maybeSingle();

  if (selErr) return { success: false, error: selErr.message };

  const iso = new Date().toISOString();

  if (existing) {
    const newQoh = Number(existing.quantity_on_hand) + qty;
    const reserved = Number(existing.reserved_quantity ?? 0);
    const { error } = await supabase
      .from('outlet_inventory')
      .update({
        quantity_on_hand: newQoh,
        available_quantity: newQoh - reserved,
        last_updated: iso,
        updated_at: iso,
      })
      .eq('id', existing.id);
    if (error) return { success: false, error: error.message };
  } else {
    const { error } = await supabase.from('outlet_inventory').insert({
      outlet_id: outletId,
      product_batch: productBatch,
      quantity_on_hand: qty,
      reserved_quantity: 0,
      available_quantity: qty,
      last_updated: iso,
      updated_at: iso,
    });
    if (error) return { success: false, error: error.message };
  }

  return { success: true };
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
          dispatch_date: params.dispatchDate,
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

    await logActivity({
      action: 'created',
      entityType: 'supply_order',
      entityId: supplyOrder.id,
      entityLabel: `Order to outlet`,
      details: {
        outlet_id: params.outletId,
        item_count: params.items.length,
        total_quantity: params.items.reduce((sum, item) => sum + item.quantity, 0),
      },
    });

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
      },
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
 * Dispatch supply order — fulfill hub reservations (goods leave Hub toward outlets)
 */
export async function dispatchSupplyOrder(supplyOrderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: order, error: orderErr } = await supabase
      .from('supply_orders')
      .select('id, status')
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
      .select('hub_inventory_id, quantity')
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

    await writeLedgerEntry({
      action: 'updated',
      entityType: 'supply_order',
      entityId: supplyOrderId,
      module: 'distribution',
      operation: 'update',
      afterData: { status: 'dispatched' },
    });

    await logActivity({
      action: 'dispatched',
      entityType: 'supply_order',
      entityId: supplyOrderId,
      entityLabel: `Supply Order Dispatched`,
      details: { dispatch_date: new Date().toISOString() },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to dispatch' };
  }
}

/**
 * Confirm receipt at outlet — credit outlet_inventory
 */
export async function confirmSupplyOrderReceipt(supplyOrderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: order, error: orderErr } = await supabase
      .from('supply_orders')
      .select('id, outlet_id, status')
      .eq('id', supplyOrderId)
      .single();

    if (orderErr || !order) {
      return { success: false, error: 'Supply order not found' };
    }

    if (order.status !== 'dispatched') {
      return { success: false, error: `Cannot receive order with status: ${order.status}` };
    }

    const { data: lines } = await supabase
      .from('supply_order_lines')
      .select('product_batch, quantity')
      .eq('supply_order_id', supplyOrderId);

    if (lines?.length) {
      for (const line of lines) {
        const bumped = await bumpOutletStock(
          order.outlet_id,
          line.product_batch,
          Number(line.quantity)
        );
        if (!bumped.success) {
          return { success: false, error: bumped.error ?? 'Failed to update outlet inventory' };
        }
      }
    }

    await retryWithBackoff(async () => await
      supabase
        .from('supply_orders')
        .update({ status: 'received', received_date: new Date().toISOString().split('T')[0] })
        .eq('id', supplyOrderId)
    );

    await writeLedgerEntry({
      action: 'updated',
      entityType: 'supply_order',
      entityId: supplyOrderId,
      module: 'distribution',
      operation: 'update',
      afterData: { status: 'received' },
    });

    await logActivity({
      action: 'received',
      entityType: 'supply_order',
      entityId: supplyOrderId,
      entityLabel: `Supply Order Received`,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to confirm receipt' };
  }
}

/**
 * Cancel pending supply order and release hub reservations
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

    if (!order || order.status === 'received') {
      return { success: false, error: 'Cannot cancel received orders' };
    }

    if (order.status === 'pending') {
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
      metadata: { cancellation_reason: reason },
    });

    await logActivity({
      action: 'cancelled',
      entityType: 'supply_order',
      entityId: supplyOrderId,
      entityLabel: `Supply Order Cancelled`,
      details: { reason },
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

/** Hard-delete a supply order (admin RPC). Pending orders release hub reservations first. */
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
    });

    await logActivity({
      action: 'deleted',
      entityType: 'supply_order',
      entityId: options.supplyOrderId,
      entityLabel: options.supplyOrderNumber,
      details: { status: options.status },
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to delete supply order',
    };
  }
}
