import type { PriceSource } from './sourcing';

/**
 * Finished dish / POS item.
 * `sku` and `target_cost_percentage` are the recipe-book contract.
 * The live catalog stores the POS price on `selling_price_ex_sst_rm` and the
 * outlet group on `entity_code`, which this type exposes as `category`.
 */
export interface MenuItem {
  id: string;
  name: string;
  sku: string | null;
  selling_price: number;
  target_cost_percentage: number;
  category: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  entity_code: string;
  servings: number;
}

/** One recipe line. A line names either a purchased item or another prep. */
export interface BomLine {
  id: string;
  menu_item_id: string | null;
  sub_recipe_id: string | null;
  raw_material_id: string | null;
  component_sub_recipe_id: string | null;
  supplier_item_id: string | null;
  component_name: string;
  quantity: number;
  unit: string;
  notes: string | null;
  base_qty: number | null;
  line_cost_rm: number | null;
  entity_code: string;
}

/** Append-only price observation. Live rows use `source`; this is the app contract. */
export interface PriceHistoryRecord {
  id: string;
  supplier_item_id: string;
  pack_price: number;
  unit_cost: number;
  source_type: PriceSource | 'po_received';
  source_id: string | null;
  effective_date: string;
}

/** One material: preferred vendor, cheapest vendor, and the gap between them. */
export interface SourcingSuggestion {
  ingredient_id: string | null;
  raw_material_id: string | null;
  material_name: string;
  base_unit: string | null;
  preferred_supplier_item_id: string | null;
  preferred_supplier_id: string | null;
  preferred_supplier_name: string | null;
  preferred_unit_cost: number | null;
  preferred_pack_price: number | null;
  preferred_pack_description: string | null;
  preferred_otif_rate: number | null;
  preferred_fill_rate: number | null;
  lowest_supplier_item_id: string | null;
  lowest_supplier_id: string | null;
  lowest_supplier_name: string | null;
  lowest_unit_cost: number | null;
  lowest_pack_price: number | null;
  lowest_otif_rate: number | null;
  lowest_fill_rate: number | null;
  preferred_is_lowest: boolean;
  savings_percent: number | null;
  supplier_count: number;
}

export interface DishCogsLine {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  cost: number | null;
}

export interface DishCogs {
  menuItemId: string;
  foodCost: number | null;
  sellingPrice: number;
  foodCostPercent: number | null;
  incomplete: boolean;
  lines: DishCogsLine[];
}

export interface SubRecipeCost {
  id: string;
  name: string;
  entity_code: string;
  servings: number;
  is_active: boolean;
  batchCost: number | null;
  unitCost: number | null;
  incomplete: boolean;
}
