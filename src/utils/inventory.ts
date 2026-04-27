/**
 * Inventory Reservation System
 * Ensures concurrent orders don't cause overselling
 */

import { supabase } from './supabase';

export interface ReservationParams {
  hubInventoryId: string;
  quantity: number;
  referenceType: 'supply_order' | 'production_run' | 'adjustment';
  referenceId: string;
  reason?: string;
}

export interface ReservationCheckResult {
  canReserve: boolean;
  availableQuantity: number;
  requestedQuantity: number;
  message: string;
}

/**
 * Check if inventory can be reserved without overselling
 * This performs a read-only check before attempting reservation
 */
export async function checkInventoryAvailability(
  hubInventoryId: string,
  requestedQuantity: number
): Promise<ReservationCheckResult> {
  const { data: inventory, error } = await supabase
    .from('hub_inventory')
    .select('quantity_on_hand, reserved_quantity')
    .eq('id', hubInventoryId)
    .single();

  if (error) {
    return {
      canReserve: false,
      availableQuantity: 0,
      requestedQuantity,
      message: `Failed to check inventory: ${error.message}`,
    };
  }

  if (!inventory) {
    return {
      canReserve: false,
      availableQuantity: 0,
      requestedQuantity,
      message: 'Inventory record not found',
    };
  }

  const reserved = inventory.reserved_quantity || 0;
  const available = inventory.quantity_on_hand - reserved;

  if (available < requestedQuantity) {
    return {
      canReserve: false,
      availableQuantity: available,
      requestedQuantity,
      message: `Insufficient inventory. Available: ${available}, Requested: ${requestedQuantity}`,
    };
  }

  return {
    canReserve: true,
    availableQuantity: available,
    requestedQuantity,
    message: 'Reservation approved',
  };
}

/**
 * Reserve inventory for a supply order or operation
 * Atomically updates reserved_quantity to lock inventory
 */
export async function reserveInventory(params: ReservationParams): Promise<{ success: boolean; error?: string }> {
  try {
    // First, check availability
    const check = await checkInventoryAvailability(params.hubInventoryId, params.quantity);
    if (!check.canReserve) {
      return { success: false, error: check.message };
    }

    // Atomically update: increment reserved_quantity
    const { error } = await supabase.rpc('reserve_inventory', {
      p_hub_inventory_id: params.hubInventoryId,
      p_quantity: params.quantity,
      p_reference_type: params.referenceType,
      p_reference_id: params.referenceId,
      p_reason: params.reason || `Reservation for ${params.referenceType}`,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Release a reservation when an order is cancelled
 */
export async function releaseReservation(
  hubInventoryId: string,
  quantity: number,
  referenceId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('release_inventory_reservation', {
      p_hub_inventory_id: hubInventoryId,
      p_quantity: quantity,
      p_reference_id: referenceId,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Convert reservation to actual deduction when order is fulfilled
 */
export async function fulfillReservation(
  hubInventoryId: string,
  quantity: number,
  referenceId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('fulfill_inventory_reservation', {
      p_hub_inventory_id: hubInventoryId,
      p_quantity: quantity,
      p_reference_id: referenceId,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Get current inventory status including reservations
 */
export async function getInventoryStatus(hubInventoryId: string) {
  const { data, error } = await supabase
    .from('hub_inventory')
    .select(
      `
      id,
      quantity_on_hand,
      reserved_quantity,
      raw_material_id,
      product_batch,
      last_updated
    `
    )
    .eq('id', hubInventoryId)
    .single();

  if (error) {
    return null;
  }

  const reserved = data?.reserved_quantity || 0;
  const available = (data?.quantity_on_hand || 0) - reserved;

  return {
    ...data,
    available_quantity: available,
    utilization_percentage: data?.quantity_on_hand
      ? Math.round(((data.quantity_on_hand - available) / data.quantity_on_hand) * 100)
      : 0,
  };
}

/**
 * Batch check availability for multiple inventory items
 * Useful for validating entire supply orders before creating
 */
export async function batchCheckInventoryAvailability(
  items: Array<{ hubInventoryId: string; quantity: number }>
): Promise<{ allAvailable: boolean; results: ReservationCheckResult[] }> {
  const results = await Promise.all(
    items.map((item) => checkInventoryAvailability(item.hubInventoryId, item.quantity))
  );

  return {
    allAvailable: results.every((r) => r.canReserve),
    results,
  };
}
