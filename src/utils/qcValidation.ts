/**
 * Quality Control & Yield Validation
 * Ensures production meets acceptance criteria
 */

export interface YieldCriteria {
  minYieldPercentage: number;
  maxYieldPercentage: number;
  allowableVariance: number; // % deviation from target
}

export interface QCCheckResult {
  passed: boolean;
  yieldPercentage: number;
  status: 'acceptable' | 'warning' | 'rejected';
  message: string;
  recommendations: string[];
}

export interface ProductionQCData {
  plannedOutput: number;
  actualOutput: number;
  targetYield: number;
  recipe: {
    id: string;
    name: string;
    target_yield_percentage?: number;
  };
}

/**
 * Calculate yield percentage
 */
export function calculateYield(plannedOutput: number, actualOutput: number): number {
  if (plannedOutput === 0) return 0;
  return (actualOutput / plannedOutput) * 100;
}

/**
 * Calculate variance from target
 */
export function calculateVariance(actual: number, target: number): number {
  if (target === 0) return 0;
  return Math.abs((actual - target) / target) * 100;
}

/**
 * Evaluate production against QC criteria
 */
export function evaluateProductionQC(data: ProductionQCData, criteria: YieldCriteria): QCCheckResult {
  const yieldPercentage = calculateYield(data.plannedOutput, data.actualOutput);
  const targetYield = data.recipe.target_yield_percentage || data.targetYield;
  const variance = calculateVariance(yieldPercentage, targetYield);

  const recommendations: string[] = [];
  let status: 'acceptable' | 'warning' | 'rejected' = 'acceptable';

  // Check if yield is within acceptable range
  if (yieldPercentage < criteria.minYieldPercentage) {
    recommendations.push(
      `Yield ${yieldPercentage.toFixed(2)}% is below minimum ${criteria.minYieldPercentage}%`
    );
    status = 'rejected';
  } else if (yieldPercentage > criteria.maxYieldPercentage) {
    recommendations.push(`Yield ${yieldPercentage.toFixed(2)}% exceeds maximum ${criteria.maxYieldPercentage}%`);
    status = 'rejected';
  }

  // Check variance from target
  if (variance > criteria.allowableVariance) {
    recommendations.push(
      `Variance ${variance.toFixed(2)}% exceeds allowable ${criteria.allowableVariance}%`
    );
    if (status !== 'rejected') {
      status = 'warning';
    }
  }

  return {
    passed: status !== 'rejected',
    yieldPercentage,
    status,
    message:
      status === 'rejected'
        ? `Production rejected. ${recommendations.join('; ')}`
        : status === 'warning'
          ? `Production needs review. ${recommendations.join('; ')}`
          : `Production accepted. Yield: ${yieldPercentage.toFixed(2)}%`,
    recommendations,
  };
}

/**
 * Determine actions based on QC status
 */
export interface QCAction {
  canPostToInventory: boolean;
  requiresReview: boolean;
  requiresApproval: boolean;
  nextSteps: string[];
}

export function determineQCActions(qcResult: QCCheckResult, isAdmin: boolean): QCAction {
  const nextSteps: string[] = [];

  switch (qcResult.status) {
    case 'acceptable':
      return {
        canPostToInventory: true,
        requiresReview: false,
        requiresApproval: false,
        nextSteps: ['Post to hub inventory', 'Create ledger entry'],
      };

    case 'warning':
      nextSteps.push('Review QC metrics before posting');
      if (!isAdmin) {
        nextSteps.push('Request admin approval');
      }
      return {
        canPostToInventory: isAdmin,
        requiresReview: true,
        requiresApproval: !isAdmin,
        nextSteps,
      };

    case 'rejected':
      nextSteps.push('Investigate root cause');
      nextSteps.push('Review production logs');
      nextSteps.push('Determine rework or scrap');
      return {
        canPostToInventory: false,
        requiresReview: true,
        requiresApproval: true,
        nextSteps,
      };
  }
}

/**
 * Built-in presets when no DB row exists (tests / offline). Production loads thresholds from `qc_audit_settings` via `fetchQCAuditCriteria`.
 */
export function getStandardQCCriteria(productType: string): YieldCriteria {
  const criteria: Record<string, YieldCriteria> = {
    'standard': { minYieldPercentage: 85, maxYieldPercentage: 110, allowableVariance: 5 },
    'premium': { minYieldPercentage: 90, maxYieldPercentage: 105, allowableVariance: 3 },
    'bulk': { minYieldPercentage: 80, maxYieldPercentage: 115, allowableVariance: 8 },
  };

  return criteria[productType] || criteria['standard'];
}

/**
 * Quality trend analysis for multiple batches
 */
export interface BatchQCHistory {
  batchId: string;
  yieldPercentage: number;
  timestamp: string;
  status: 'acceptable' | 'warning' | 'rejected';
}

export interface QCTrendAnalysis {
  averageYield: number;
  minYield: number;
  maxYield: number;
  standardDeviation: number;
  rejectionRate: number;
  trend: 'improving' | 'stable' | 'declining';
  alerts: string[];
}

export function analyzeQCTrend(history: BatchQCHistory[]): QCTrendAnalysis {
  if (history.length === 0) {
    return {
      averageYield: 0,
      minYield: 0,
      maxYield: 0,
      standardDeviation: 0,
      rejectionRate: 0,
      trend: 'stable',
      alerts: [],
    };
  }

  const yields = history.map((h) => h.yieldPercentage);
  const averageYield = yields.reduce((a, b) => a + b, 0) / yields.length;
  const minYield = Math.min(...yields);
  const maxYield = Math.max(...yields);

  // Calculate standard deviation
  const variance = yields.reduce((sum, y) => sum + Math.pow(y - averageYield, 2), 0) / yields.length;
  const standardDeviation = Math.sqrt(variance);

  // Calculate rejection rate
  const rejectionRate = (history.filter((h) => h.status === 'rejected').length / history.length) * 100;

  // Determine trend (simple: compare first half vs second half)
  const midpoint = Math.floor(history.length / 2);
  const firstHalfAvg = yields.slice(0, midpoint).reduce((a, b) => a + b, 0) / midpoint;
  const secondHalfAvg = yields.slice(midpoint).reduce((a, b) => a + b, 0) / (history.length - midpoint);
  const trend: 'improving' | 'stable' | 'declining' =
    secondHalfAvg > firstHalfAvg + 2 ? 'improving' : secondHalfAvg < firstHalfAvg - 2 ? 'declining' : 'stable';

  // Generate alerts
  const alerts: string[] = [];
  if (rejectionRate > 10) {
    alerts.push(`High rejection rate: ${rejectionRate.toFixed(1)}%`);
  }
  if (standardDeviation > 10) {
    alerts.push(`High yield variability (σ=${standardDeviation.toFixed(1)})`);
  }
  if (trend === 'declining') {
    alerts.push('Quality trending downward - investigate process');
  }

  return {
    averageYield,
    minYield,
    maxYield,
    standardDeviation,
    rejectionRate,
    trend,
    alerts,
  };
}

/**
 * Generate QC report for production run
 */
export interface QCReport {
  productionRunId: string;
  timestamp: string;
  qcResult: QCCheckResult;
  actions: QCAction;
  approvalRequired: boolean;
  approvedBy?: string;
  approvedAt?: string;
}

export function createQCReport(
  productionRunId: string,
  qcResult: QCCheckResult,
  actions: QCAction
): QCReport {
  return {
    productionRunId,
    timestamp: new Date().toISOString(),
    qcResult,
    actions,
    approvalRequired: actions.requiresApproval,
  };
}
