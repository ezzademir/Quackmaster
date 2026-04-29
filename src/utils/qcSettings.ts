import { supabase } from './supabase';
import type { YieldCriteria } from './qcValidation';

/** Matches migration defaults and former `getStandardQCCriteria('standard')` */
export const DEFAULT_QC_AUDIT_CRITERIA: YieldCriteria = {
  minYieldPercentage: 85,
  maxYieldPercentage: 110,
  allowableVariance: 5,
};

export async function fetchQCAuditCriteria(): Promise<YieldCriteria> {
  const { data, error } = await supabase
    .from('qc_audit_settings')
    .select('min_yield_percentage, max_yield_percentage, allowable_variance')
    .eq('id', 1)
    .maybeSingle();

  if (error || !data) {
    return DEFAULT_QC_AUDIT_CRITERIA;
  }

  return {
    minYieldPercentage: Number(data.min_yield_percentage),
    maxYieldPercentage: Number(data.max_yield_percentage),
    allowableVariance: Number(data.allowable_variance),
  };
}

export async function saveQCAuditCriteria(criteria: YieldCriteria): Promise<{ error: Error | null }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { error } = await supabase.from('qc_audit_settings').upsert(
    {
      id: 1,
      min_yield_percentage: criteria.minYieldPercentage,
      max_yield_percentage: criteria.maxYieldPercentage,
      allowable_variance: criteria.allowableVariance,
      updated_at: new Date().toISOString(),
      updated_by: session?.user?.id ?? null,
    },
    { onConflict: 'id' }
  );

  return { error: error ? new Error(error.message) : null };
}
