/**
 * Inventory Adjustment Workflow
 * Handles discrepancies, damage, loss, and inventory corrections
 */

import { supabase } from './supabase';
import { writeLedgerEntry } from './ledger';
import { validateInventoryAdjustment } from './validation';
import { retryWithBackoff } from './errorHandling';

export type AdjustmentType = 'addition' | 'deduction';
export type AdjustmentReason =
  | 'stock_count_variance'
  | 'damage'
  | 'expiry'
  | 'theft'
  | 'quality_issue'
  | 'recount'
  | 'supplier_return'
  | 'other';

export interface InventoryAdjustmentParams {
  hubInventoryId: string;
  adjustmentType: AdjustmentType;
  adjustedQuantity: number;
  adjustmentReason: AdjustmentReason;
  notes?: string;
  requiresApproval?: boolean;
}

export interface AdjustmentApprovalParams {
  adjustmentId: string;
  approved: boolean;
  reviewNotes?: string;
  reviewedBy: string;
}

export interface AdjustmentRecord {
  id: string;
  hub_inventory_id: string;
  adjustment_type: AdjustmentType;
  adjusted_quantity: number;
  adjustment_reason: AdjustmentReason;
  status: 'pending' | 'approved' | 'rejected';
  notes?: string;
  created_by: string;
  created_at: string;
  reviewed_by?: string;
  reviewed_at?: string;
  review_notes?: string;
  applied_at?: string | null;
}

/**
 * Create inventory adjustment (draft status if requires approval)
 */
export async function createInventoryAdjustment(
  params: InventoryAdjustmentParams
): Promise<{ success: boolean; adjustmentId?: string; error?: string }> {
  try {
    // Validate input
    const validation = validateInventoryAdjustment({
      adjustment_type: params.adjustmentType,
      adjusted_quantity: params.adjustedQuantity,
      adjustment_reason: params.adjustmentReason,
    });

    if (!validation.isValid) {
      return {
        success: false,
        error: validation.errors.map((e) => e.message).join('; '),
      };
    }

    // Get current inventory state
    const { data: inventory, error: invErr } = await supabase
      .from('hub_inventory')
      .select('id, quantity_on_hand, reserved_quantity')
      .eq('id', params.hubInventoryId)
      .single();

    if (invErr || !inventory) {
      return { success: false, error: 'Inventory record not found' };
    }

    // For deductions, verify sufficient quantity available
    if (params.adjustmentType === 'deduction') {
      const available = inventory.quantity_on_hand - (inventory.reserved_quantity || 0);
      if (available < params.adjustedQuantity) {
        return {
          success: false,
          error: `Insufficient available quantity. Available: ${available}, Requested: ${params.adjustedQuantity}`,
        };
      }
    }

    // Get current user
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return { success: false, error: 'Not authenticated' };
    }

    // Determine status based on requiresApproval
    const status = params.requiresApproval ? 'pending' : 'approved';

    // Create adjustment record
    const { data: adjustment, error: adjErr } = await retryWithBackoff(async () => await
      supabase
        .from('inventory_adjustments')
        .insert({
          hub_inventory_id: params.hubInventoryId,
          adjustment_type: params.adjustmentType,
          adjusted_quantity: params.adjustedQuantity,
          adjustment_reason: params.adjustmentReason,
          status,
          notes: params.notes || null,
          created_by: session.user.id,
        })
        .select('id')
        .single()
    );

    if (adjErr || !adjustment) {
      return { success: false, error: `Failed to create adjustment: ${adjErr?.message}` };
    }

    // If no approval needed, apply immediately
    if (!params.requiresApproval) {
      await applyInventoryAdjustment(adjustment.id);
    }

    await writeLedgerEntry({
      action: 'created',
      entityType: 'inventory_adjustment',
      entityId: adjustment.id,
      module: 'inventory',
      operation: 'insert',
      referenceId: params.hubInventoryId,
      afterData: {
        adjustment_type: params.adjustmentType,
        adjusted_quantity: params.adjustedQuantity,
        adjustment_reason: params.adjustmentReason,
        status,
        hub_inventory_id: params.hubInventoryId,
        notes: params.notes ?? null,
      },
      metadata: {
        entity_label: `${params.adjustmentType} adjustment (${params.adjustmentReason})`,
      },
    });

    return { success: true, adjustmentId: adjustment.id };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create adjustment',
    };
  }
}

/**
 * Apply (approve and execute) inventory adjustment
 */
export async function applyInventoryAdjustment(
  adjustmentId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: rpcResult, error: rpcErr } = await retryWithBackoff(async () =>
      supabase.rpc('apply_inventory_adjustment', { p_adjustment_id: adjustmentId })
    );

    if (rpcErr) {
      return { success: false, error: rpcErr.message };
    }

    const payload = rpcResult as { success?: boolean; error?: string; pending_requires_admin?: boolean } | null;
    if (payload && payload.success === false) {
      return { success: false, error: payload.error ?? 'apply_inventory_adjustment failed' };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to apply adjustment',
    };
  }
}

/**
 * Reject inventory adjustment
 */
export async function rejectInventoryAdjustment(
  adjustmentId: string,
  rejectionReason: string,
  rejectedBy: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await retryWithBackoff(async () => await
      supabase
        .from('inventory_adjustments')
        .update({
          status: 'rejected',
          reviewed_by: rejectedBy,
          reviewed_at: new Date().toISOString(),
          review_notes: rejectionReason,
        })
        .eq('id', adjustmentId)
    );

    await writeLedgerEntry({
      action: 'cancelled',
      entityType: 'inventory_adjustment',
      entityId: adjustmentId,
      module: 'inventory',
      operation: 'update',
      afterData: { status: 'rejected' },
      metadata: {
        entity_label: 'Adjustment rejected',
        rejection_reason: rejectionReason,
      },
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to reject adjustment',
    };
  }
}

/**
 * Get pending adjustments for approval
 */
export async function getPendingAdjustments(): Promise<AdjustmentRecord[]> {
  try {
    const { data, error } = await supabase
      .from('inventory_adjustments')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch pending adjustments:', error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('Error fetching adjustments:', err);
    return [];
  }
}

/**
 * Get adjustment history for a specific inventory item
 */
export async function getAdjustmentHistory(hubInventoryId: string): Promise<AdjustmentRecord[]> {
  try {
    const { data, error } = await supabase
      .from('inventory_adjustments')
      .select('*')
      .eq('hub_inventory_id', hubInventoryId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch adjustment history:', error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('Error fetching history:', err);
    return [];
  }
}

/**
 * Get adjustment statistics for analysis
 */
export async function getAdjustmentStats(days: number = 30): Promise<{
  totalAdjustments: number;
  byReason: Record<AdjustmentReason, number>;
  byType: Record<AdjustmentType, number>;
  totalQuantityAdjusted: number;
}> {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('inventory_adjustments')
      .select('adjustment_type, adjustment_reason, adjusted_quantity')
      .gte('created_at', since)
      .eq('status', 'approved');

    if (error) {
      console.error('Failed to fetch stats:', error);
      return {
        totalAdjustments: 0,
        byReason: {} as Record<AdjustmentReason, number>,
        byType: {} as Record<AdjustmentType, number>,
        totalQuantityAdjusted: 0,
      };
    }

    const byReason: Record<AdjustmentReason, number> = {} as Record<AdjustmentReason, number>;
    const byType: Record<AdjustmentType, number> = {} as Record<AdjustmentType, number>;
    let totalQuantity = 0;

    for (const record of data || []) {
      const reason = record.adjustment_reason as AdjustmentReason;
      const type = record.adjustment_type as AdjustmentType;
      byReason[reason] = (byReason[reason] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
      totalQuantity += record.adjusted_quantity;
    }

    return {
      totalAdjustments: data?.length || 0,
      byReason,
      byType,
      totalQuantityAdjusted: totalQuantity,
    };
  } catch (err) {
    console.error('Error calculating stats:', err);
    return {
      totalAdjustments: 0,
      byReason: {} as Record<AdjustmentReason, number>,
      byType: {} as Record<AdjustmentType, number>,
      totalQuantityAdjusted: 0,
    };
  }
}
