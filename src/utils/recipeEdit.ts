/** Turn recipe form text into the row an admin is allowed to save. Costs are never estimated here. */

export const RECIPE_STATUSES = ['active', 'inactive', 'KIV'] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

export const PRICE_BASES = ['list', 'pending', 'receipt'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

export interface RecipeFieldInput {
  kind: 'dish' | 'sub-recipe';
  name: string;
  entity_code: string;
  status: string;
  source_sheet: string;
  selling_price: string;
  wastage_pct: string;
  servings: string;
  packaging_rule: string;
  pkg_dine_in: string;
  pkg_takeaway: string;
  yield_note: string;
  notes: string;
}

export interface LineFieldInput {
  entity_code: string;
  component_name: string;
  qty: string;
  unit: string;
  base_qty: string;
  price_basis: string;
  line_cost: string;
  cost_complete: boolean;
  shared_ingredient: boolean;
  status: string;
  source_sheet: string;
  source_row: string;
  issues: string;
  supplier_item_id: string;
  component_sub_recipe_id: string;
}

export interface DishWrite {
  name: string;
  entity_code: string;
  status: RecipeStatus;
  source_sheet: string | null;
  selling_price_ex_sst_rm: number | null;
  wastage_pct: number;
  servings: number;
  packaging_rule: string | null;
  pkg_dine_in_rm: number | null;
  pkg_takeaway_rm: number | null;
  notes: string | null;
}

export interface SubRecipeWrite {
  name: string;
  entity_code: string;
  status: RecipeStatus;
  source_sheet: string | null;
  selling_price_ex_sst_rm: number | null;
  wastage_pct: number;
  servings: number;
  yield_note: string | null;
  notes: string | null;
}

export interface LineWrite {
  entity_code: string;
  component_name: string;
  qty: number | null;
  unit: string | null;
  base_qty: number | null;
  price_basis: PriceBasis;
  line_cost_rm: number | null;
  cost_complete: boolean;
  shared_ingredient: boolean;
  status: RecipeStatus;
  source_sheet: string | null;
  source_row: number | null;
  issues: string | null;
  supplier_item_id: string | null;
  component_sub_recipe_id: string | null;
}

export type RecipeWrite =
  | { ok: true; table: 'menu_items'; values: DishWrite }
  | { ok: true; table: 'sub_recipes'; values: SubRecipeWrite }
  | { ok: false; error: string };

export type LineWriteResult = { ok: true; values: LineWrite } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function blank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isStatus(value: string): value is RecipeStatus {
  return (RECIPE_STATUSES as readonly string[]).includes(value);
}

function isBasis(value: string): value is PriceBasis {
  return (PRICE_BASES as readonly string[]).includes(value);
}

function optionalNumber(raw: string, label: string, allowNegative = false): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, error: `${label} must be a number.` };
  if (!allowNegative && value < 0) return { ok: false, error: `${label} cannot be negative.` };
  return { ok: true, value };
}

function requiredNumber(raw: string, label: string, minimum: number): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = optionalNumber(raw, label);
  if (!parsed.ok) return parsed;
  if (parsed.value == null) return { ok: false, error: `${label} is required.` };
  if (parsed.value < minimum) {
    return { ok: false, error: minimum > 0 ? `${label} must be greater than zero.` : `${label} cannot be negative.` };
  }
  return { ok: true, value: parsed.value };
}

function optionalUuid(raw: string, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!UUID_RE.test(trimmed)) return { ok: false, error: `${label} must be left blank or be an existing id.` };
  return { ok: true, value: trimmed };
}

function optionalRow(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: 'Source row must be a whole number.' };
  return { ok: true, value: Number(trimmed) };
}

function sharedRecipe(input: RecipeFieldInput):
  | { ok: true; values: Pick<DishWrite, 'name' | 'entity_code' | 'status' | 'source_sheet' | 'selling_price_ex_sst_rm' | 'wastage_pct' | 'servings' | 'notes'> }
  | { ok: false; error: string } {
  const name = input.name.trim();
  const entity = input.entity_code.trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!entity) return { ok: false, error: 'Entity is required.' };
  if (!isStatus(input.status)) return { ok: false, error: 'Status must be active, inactive, or KIV.' };
  const price = optionalNumber(input.selling_price, 'Selling price');
  if (!price.ok) return price;
  const wastage = requiredNumber(input.wastage_pct, 'Wastage', 0);
  if (!wastage.ok) return wastage;
  const servings = requiredNumber(input.servings, 'Servings', 0.000001);
  if (!servings.ok) return servings;
  return {
    ok: true,
    values: {
      name,
      entity_code: entity,
      status: input.status,
      source_sheet: blank(input.source_sheet),
      selling_price_ex_sst_rm: price.value,
      wastage_pct: wastage.value,
      servings: servings.value,
      notes: blank(input.notes),
    },
  };
}

export function recipeWrite(input: RecipeFieldInput): RecipeWrite {
  const shared = sharedRecipe(input);
  if (!shared.ok) return shared;
  switch (input.kind) {
    case 'dish': {
      const dineIn = optionalNumber(input.pkg_dine_in, 'Dine-in packaging');
      if (!dineIn.ok) return dineIn;
      const takeaway = optionalNumber(input.pkg_takeaway, 'Takeaway packaging');
      if (!takeaway.ok) return takeaway;
      return {
        ok: true,
        table: 'menu_items',
        values: {
          ...shared.values,
          packaging_rule: blank(input.packaging_rule),
          pkg_dine_in_rm: dineIn.value,
          pkg_takeaway_rm: takeaway.value,
        },
      };
    }
    case 'sub-recipe':
      return {
        ok: true,
        table: 'sub_recipes',
        values: {
          ...shared.values,
          yield_note: blank(input.yield_note),
        },
      };
    default: {
      const _exhaustive: never = input.kind;
      return _exhaustive;
    }
  }
}

export function lineWrite(input: LineFieldInput): LineWriteResult {
  const name = input.component_name.trim();
  const entity = input.entity_code.trim();
  if (!name) return { ok: false, error: 'Component name is required.' };
  if (!entity) return { ok: false, error: 'Line entity is required.' };
  if (!isStatus(input.status)) return { ok: false, error: 'Line status must be active, inactive, or KIV.' };
  if (!isBasis(input.price_basis)) return { ok: false, error: 'Price basis must be list, pending, or receipt.' };
  const qty = optionalNumber(input.qty, 'Quantity');
  if (!qty.ok) return qty;
  const baseQty = optionalNumber(input.base_qty, 'Base quantity');
  if (!baseQty.ok) return baseQty;
  const cost = optionalNumber(input.line_cost, 'Line cost');
  if (!cost.ok) return cost;
  const sourceRow = optionalRow(input.source_row);
  if (!sourceRow.ok) return sourceRow;
  const supplier = optionalUuid(input.supplier_item_id, 'Supplier item');
  if (!supplier.ok) return supplier;
  const subRecipe = optionalUuid(input.component_sub_recipe_id, 'Component sub-recipe');
  if (!subRecipe.ok) return subRecipe;
  if (supplier.value && subRecipe.value) {
    return { ok: false, error: 'A line can point at a supplier item or a sub-recipe, not both.' };
  }
  if (input.cost_complete && input.price_basis === 'pending') {
    return { ok: false, error: 'A pending line cannot be marked cost complete.' };
  }
  if (input.cost_complete && cost.value == null) {
    return { ok: false, error: 'Enter a line cost before marking the line complete.' };
  }
  return {
    ok: true,
    values: {
      entity_code: entity,
      component_name: name,
      qty: qty.value,
      unit: blank(input.unit),
      base_qty: baseQty.value,
      price_basis: input.price_basis,
      line_cost_rm: cost.value,
      cost_complete: input.cost_complete,
      shared_ingredient: input.shared_ingredient,
      status: input.status,
      source_sheet: blank(input.source_sheet),
      source_row: sourceRow.value,
      issues: blank(input.issues),
      supplier_item_id: supplier.value,
      component_sub_recipe_id: subRecipe.value,
    },
  };
}

export function textField(value: number | string | null | undefined): string {
  if (value == null) return '';
  return String(value);
}
