/**
 * Production Workflow Service
 * Handles production run completion with QC validation and inventory posting
 */

import { supabase } from './supabase';
import { writeLedgerEntry } from './ledger';
import { logActivity } from './activityLog';
import {
  evaluateProductionQC,
  determineQCActions,
  createQCReport,
  type QCReport,
} from './qcValidation';
import { fetchQCAuditCriteria } from './qcSettings';
import { retryWithBackoff } from './errorHandling';

export interface ProductionCompletionParams {
  productionRunId: string;
  recipeId: string;
  plannedOutput: number;
  actualOutput: number;
  targetYield: number;
  productBatch?: string;
  notes?: string;
  isAdmin: boolean;
}

export interface ProductionCompletionResult {
  success: boolean;
  qcReport?: QCReport;
  message: string;
  error?: string;
  inventoryPosted?: boolean;
}

/**
 * Complete production run with full validation and inventory posting
 */
export async function completeProductionRun(
  params: ProductionCompletionParams
): Promise<ProductionCompletionResult> {
  try {
    // Get recipe details for QC validation
    const { data: recipe, error: recipeErr } = await supabase
      .from('recipes')
      .select('id, name, target_yield_percentage')
      .eq('id', params.recipeId)
      .single();

    if (recipeErr || !recipe) {
      return {
        success: false,
        message: 'Failed to load recipe details',
        error: recipeErr?.message || 'Recipe not found',
      };
    }

    // Perform QC evaluation using admin-configured thresholds (fallback if row missing)
    const qcCriteria = await fetchQCAuditCriteria();
    const qcResult = evaluateProductionQC(
      {
        plannedOutput: params.plannedOutput,
        actualOutput: params.actualOutput,
        targetYield: params.targetYield,
        recipe,
      },
      qcCriteria
    );

    // Determine allowed actions based on QC result
    const qcActions = determineQCActions(qcResult, params.isAdmin);

    // Create QC report for audit trail
    const qcReport = createQCReport(params.productionRunId, qcResult, qcActions);

    await retryWithBackoff(async () =>
      supabase
        .from('production_runs')
        .update({ yield_percentage: qcResult.yieldPercentage })
        .eq('id', params.productionRunId)
    );

    // Log QC results to ledger
    await writeLedgerEntry({
      action: 'completed',
      entityType: 'production_run',
      entityId: params.productionRunId,
      module: 'production',
      operation: 'event',
      metadata: {
        qc_status: qcResult.status,
        yield_percentage: qcResult.yieldPercentage,
        recommendations: qcResult.recommendations,
      },
    });

    // If QC fails (rejected), don't post to inventory
    if (!qcResult.passed) {
      return {
        success: false,
        qcReport,
        message: `Production rejected. ${qcResult.message}`,
        error: qcResult.message,
        inventoryPosted: false,
      };
    }

    // If QC warning and non-admin, require approval
    if (qcResult.status === 'warning' && !params.isAdmin) {
      return {
        success: true,
        qcReport,
        message: qcResult.message,
        inventoryPosted: false,
      };
    }

    // Update production run status
    await retryWithBackoff(async () => await
      supabase.from('production_runs').update({ status: 'completed' }).eq('id', params.productionRunId)
    );

    // Create product batch in hub inventory
    const batchId = params.productBatch || `BATCH-${Date.now()}`;
    const { data: hubBatch, error: batchErr } = await retryWithBackoff(async () => await
      supabase
        .from('hub_inventory')
        .insert({
          product_batch: batchId,
          quantity_on_hand: params.actualOutput,
          reserved_quantity: 0,
          available_quantity: params.actualOutput,
          last_updated: new Date().toISOString(),
        })
        .select('id')
        .single()
    );

    if (batchErr || !hubBatch) {
      throw new Error(`Failed to create inventory batch: ${batchErr?.message}`);
    }

    // Log inventory posting
    await writeLedgerEntry({
      action: 'created',
      entityType: 'hub_inventory',
      entityId: hubBatch.id,
      module: 'production',
      operation: 'insert',
      afterData: {
        product_batch: batchId,
        quantity_on_hand: params.actualOutput,
        available_quantity: params.actualOutput,
      },
      referenceId: params.productionRunId,
      metadata: {
        qc_status: qcResult.status,
        yield_percentage: qcResult.yieldPercentage,
      },
    });

    // Deduct consumed materials from inventory
    const { data: materials, error: materialsErr } = await supabase
      .from('production_run_materials')
      .select('raw_material_id, quantity_consumed')
      .eq('production_run_id', params.productionRunId);

    if (materialsErr) {
      throw new Error(`Failed to load consumed materials: ${materialsErr.message}`);
    }

    // Update hub inventory for each consumed material
    for (const material of materials ?? []) {
      const { data: existing } = await supabase
        .from('hub_inventory')
        .select('id, quantity_on_hand, reserved_quantity')
        .eq('raw_material_id', material.raw_material_id)
        .maybeSingle();

      if (existing) {
        const newQty = Math.max(0, existing.quantity_on_hand - material.quantity_consumed);
        const newAvailable = newQty - (existing.reserved_quantity || 0);

        await retryWithBackoff(async () => await
          supabase
            .from('hub_inventory')
            .update({
              quantity_on_hand: newQty,
              available_quantity: newAvailable,
              last_updated: new Date().toISOString(),
            })
            .eq('id', existing.id)
        );

        await writeLedgerEntry({
          action: 'updated',
          entityType: 'hub_inventory',
          entityId: existing.id,
          module: 'production',
          operation: 'update',
          beforeData: {
            quantity_on_hand: existing.quantity_on_hand,
            available_quantity: existing.quantity_on_hand - (existing.reserved_quantity || 0),
          },
          afterData: {
            quantity_on_hand: newQty,
            available_quantity: newAvailable,
          },
          deltaData: { quantity_consumed: material.quantity_consumed },
          referenceId: params.productionRunId,
        });
      }
    }

    // Log activity
    await logActivity({
      action: 'completed',
      entityType: 'production_run',
      entityId: params.productionRunId,
      entityLabel: `Batch ${batchId}`,
      details: {
        yield_percentage: qcResult.yieldPercentage,
        qc_status: qcResult.status,
        output_quantity: params.actualOutput,
      },
    });

    return {
      success: true,
      qcReport,
      message: `Production completed successfully. ${qcResult.message}`,
      inventoryPosted: true,
    };
  } catch (err) {
    return {
      success: false,
      message: 'Production completion failed',
      error: err instanceof Error ? err.message : 'Unknown error',
      inventoryPosted: false,
    };
  }
}

/**
 * Reject production run (manual override by QC inspector)
 */
export async function rejectProductionRun(
  productionRunId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await retryWithBackoff(async () => await
      supabase.from('production_runs').update({ status: 'cancelled' }).eq('id', productionRunId)
    );

    await writeLedgerEntry({
      action: 'cancelled',
      entityType: 'production_run',
      entityId: productionRunId,
      module: 'production',
      operation: 'update',
      metadata: { rejection_reason: reason },
    });

    await logActivity({
      action: 'cancelled',
      entityType: 'production_run',
      entityId: productionRunId,
      entityLabel: productionRunId,
      details: { reason },
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to reject production run',
    };
  }
}
