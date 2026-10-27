/** Ingredient master used for purchasing and recipe costing. */
export type IngredientBaseUnit = 'g' | 'ml' | 'pc' | 'portion';

export type IngredientStatus = 'active' | 'inactive' | 'pending';

export interface Ingredient {
  id: string;
  name: string;
  base_unit: IngredientBaseUnit;
  raw_material_id: string | null;
  in_house: boolean;
  status: IngredientStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type SupplierItemStatus = 'active' | 'inactive' | 'pending';

export type PriceBasis = 'list' | 'pending' | 'receipt';

/** How a price_history row was recorded. */
export type PriceSource = 'seed' | 'list' | 'receipt' | 'manual' | 'invoice';

/**
 * One purchasable pack from one supplier.
 * unit_cost_rm is generated in the database as price_rm / pack_qty_base.
 */
export interface SupplierItem {
  id: string;
  supplier_id: string;
  ingredient_id: string | null;
  procurement_tag: string;
  shared_ingredient: boolean;
  item_name: string;
  pack_qty: number | null;
  pack_unit: string | null;
  base_unit: IngredientBaseUnit;
  pack_qty_base: number | null;
  price_rm: number | null;
  unit_cost_rm: number | null;
  price_basis: PriceBasis;
  payment_terms: string | null;
  delivery_day: string | null;
  status: SupplierItemStatus;
  is_preferred: boolean;
  source_list: string | null;
  source_line_no: number | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

/** One ingredient row from v_ingredient_sourcing_comparison. */
export interface SourcingComparison {
  ingredient_id: string;
  ingredient_name: string;
  base_unit: IngredientBaseUnit;
  /** g compares per kg, ml compares per l, pc and portion compare per unit. */
  canonical_unit: 'kg' | 'l' | 'pc' | 'portion';
  active_supplier_count: number;
  priced_supplier_count: number;
  primary_supplier_item_id: string | null;
  primary_supplier_id: string | null;
  primary_supplier_name: string | null;
  /** Cost in the ingredient base unit. */
  primary_unit_cost_rm: number | null;
  /** Cost in canonical_unit. */
  primary_normalized_unit_cost: number | null;
  primary_price_basis: PriceBasis | null;
  primary_updated_at: string | null;
  lowest_supplier_item_id: string | null;
  lowest_supplier_id: string | null;
  lowest_supplier_name: string | null;
  lowest_unit_cost_rm: number | null;
  lowest_normalized_unit_cost: number | null;
  primary_is_lowest: boolean;
  /** Primary minus lowest, in canonical_unit. Positive means the preferred vendor costs more. */
  savings_per_canonical_unit: number | null;
  savings_percent: number | null;
  last_price_effective_date: string | null;
  last_price_recorded_at: string | null;
  last_price_source: PriceSource | null;
  last_unit_cost_rm: number | null;
  previous_unit_cost_rm: number | null;
  last_price_shift_rm: number | null;
  last_price_shift_percent: number | null;
}
