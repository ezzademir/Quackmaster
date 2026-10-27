import type { PriceSource, SourcingComparison } from '../types';
import { supabase } from './supabase';

export interface InvoicePriceUpdateInput {
  supplierItemId: string;
  packPrice: number;
  packSizeBase: number;
  sourceType: Extract<PriceSource, 'receipt' | 'invoice' | 'manual' | 'list'>;
  sourceId?: string | null;
  effectiveDate?: string | null;
}

/** Preferred vendor versus the lowest normalized unit cost, one row per active ingredient. */
export async function fetchIngredientSourcingComparison() {
  const { data, error } = await supabase
    .from('v_ingredient_sourcing_comparison')
    .select('*')
    .order('savings_per_canonical_unit', { ascending: false, nullsFirst: false });

  return {
    data: (data ?? null) as SourcingComparison[] | null,
    error,
  };
}

/**
 * Record a pack price and refresh supplier_items.price_rm.
 * The database derives unit_cost_rm and appends price_history.
 */
export async function recordInvoicePriceUpdate(input: InvoicePriceUpdateInput) {
  return supabase.rpc('record_invoice_price_update', {
    p_supplier_item_id: input.supplierItemId,
    p_pack_price: input.packPrice,
    p_pack_size_base: input.packSizeBase,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId ?? null,
    p_effective_date: input.effectiveDate ?? null,
  });
}
