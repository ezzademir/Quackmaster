/**
 * Production Workflow Service
 * Handles production run completion with QC validation and inventory posting
 */

import { supabase } from './supabase';
import { writeLedgerEntry } from './ledger';
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
  lotLabel?: string;
  sku?: string;
  lotId?: string;
  expiryDate?: string | null;
  manufacturedAt?: string | null;
  runNumber?: string;
  finishedQuantity?: number;
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

    const skuHint = params.productBatch?.trim() || '';
    const { data: rpcData, error: rpcErr } = await retryWithBackoff(async () =>
      supabase.rpc('post_production_completion_inventory', {
        p_production_run_id: params.productionRunId,
        p_product_batch: skuHint,
        p_finished_quantity: params.actualOutput,
      })
    );

    if (rpcErr) {
      return {
        success: false,
        qcReport,
        message: 'Production inventory post failed',
        error: rpcErr.message,
        inventoryPosted: false,
      };
    }

    const rpcPayload = rpcData as {
      success?: boolean;
      error?: string;
      hub_inventory_id?: string;
      lot_id?: string;
      lot_label?: string;
      sku?: string;
      expiry_date?: string | null;
      manufactured_at?: string | null;
      run_number?: string;
      finished_quantity?: number;
    } | null;

    if (rpcPayload?.success === false) {
      return {
        success: false,
        qcReport,
        message: rpcPayload.error ?? 'Inventory post rejected',
        error: rpcPayload.error,
        inventoryPosted: false,
      };
    }

    await writeLedgerEntry({
      action: 'completed',
      entityType: 'production_run',
      entityId: params.productionRunId,
      module: 'production',
      operation: 'event',
      referenceId: params.productionRunId,
      afterData: {
        yield_percentage: qcResult.yieldPercentage,
        qc_status: qcResult.status,
        output_quantity: params.actualOutput,
        product_batch: rpcPayload?.sku ?? skuHint,
        lot_id: rpcPayload?.lot_id ?? null,
        lot_label: rpcPayload?.lot_label ?? null,
        hub_inventory_id: rpcPayload?.hub_inventory_id ?? null,
      },
      metadata: {
        entity_label: `Production completed · ${rpcPayload?.lot_label ?? rpcPayload?.sku ?? skuHint}`,
        summary: 'production_completed',
      },
    });

    return {
      success: true,
      qcReport,
      message: `Production completed successfully. ${qcResult.message}`,
      inventoryPosted: true,
      lotLabel: rpcPayload?.lot_label,
      sku: rpcPayload?.sku,
      lotId: rpcPayload?.lot_id,
      expiryDate: rpcPayload?.expiry_date ?? null,
      manufacturedAt: rpcPayload?.manufactured_at ?? null,
      runNumber: rpcPayload?.run_number,
      finishedQuantity: rpcPayload?.finished_quantity ?? params.actualOutput,
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
/** Permanently delete a production run (admin RPC). Reverses hub inventory when completed. */
export async function deleteProductionRun(options: {
  runId: string;
  runNumber: string;
  status: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('admin_delete_production_run', {
      p_run_id: options.runId,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    await writeLedgerEntry({
      action: 'deleted',
      entityType: 'production_run',
      entityId: options.runId,
      module: 'production',
      operation: 'delete',
      beforeData: { run_number: options.runNumber, status: options.status },
      metadata: { entity_label: options.runNumber, prior_status: options.status },
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to delete production run',
    };
  }
}

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
      afterData: { status: 'cancelled' },
      metadata: { entity_label: 'Production run rejected/cancelled', rejection_reason: reason },
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to reject production run',
    };
  }
}
