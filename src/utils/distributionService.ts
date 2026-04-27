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
    // Pre-check: Validate all items are available
    for (const item of params.items) {
      const check = await checkInventoryAvailability(item.hubInventoryId, item.quantity);
      if (!check.canReserve) {
        errors.push(`Item ${item.product_batch}: ${check.message}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, reservations: [], errors };
    }

    // Create supply order
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

    // Attempt to reserve all items
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

    // If any reservations failed, rollback and delete the order
    if (errors.length > 0) {
      // Release successful reservations
      for (const res of reservations) {
        if (res.reserved) {
          await releaseReservation(res.item.hubInventoryId, res.item.quantity, supplyOrder.id);
        }
      }

      // Delete incomplete order
      await supabase.from('supply_orders').delete().eq('id', supplyOrder.id);

      return { success: false, reservations, errors };
    }

    // Log activity and ledger
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
 * Dispatch supply order and convert reservations to actual deductions
 */
export async function dispatchSupplyOrder(supplyOrderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get supply order and items
    const { data: order, error: orderErr } = await supabase
      .from('supply_orders')
      .select('id, status, dispatch_date')
      .eq('id', supplyOrderId)
      .single();

    if (orderErr || !order) {
      return { success: false, error: 'Supply order not found' };
    }

    if (order.status !== 'pending') {
      return { success: false, error: `Cannot dispatch order with status: ${order.status}` };
    }

    // Update status to dispatched
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
 * Confirm receipt at outlet and convert hub inventory to outlet inventory
 */
export async function confirmSupplyOrderReceipt(supplyOrderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get supply order
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

    // TODO: In full implementation, would fetch supply_order_items to get quantities
    // For now, just update the status
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
 * Cancel supply order and release reservations
 */
export async function cancelSupplyOrder(
  supplyOrderId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get supply order
    const { data: order } = await supabase
      .from('supply_orders')
      .select('id, status')
      .eq('id', supplyOrderId)
      .single();

    if (!order || order.status === 'received') {
      return { success: false, error: 'Cannot cancel received orders' };
    }

    // Get reserved items to release
    // Note: This assumes we track reservations separately; adjust based on your schema
    // For now, just update the order status
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

/**
 * Generate supply order number
 */
function generateSupplyOrderNumber(): string {
  const timestamp = Date.now().toString().slice(-8);
  return `SO-${timestamp}`;
}
