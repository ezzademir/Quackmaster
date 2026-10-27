import type { BomLine, DishCogs, MenuItem, SourcingSuggestion, SubRecipeCost } from '../types';
import { supabase } from './supabase';

const DEFAULT_TARGET_COST_PERCENTAGE = 30;

interface MenuItemRow {
  id: string;
  name: string;
  entity_code: string;
  status: string;
  selling_price_ex_sst_rm: number | string | null;
  servings: number | string | null;
  created_at: string;
  updated_at: string;
}

interface SubRecipeRow {
  id: string;
  name: string;
  entity_code: string;
  status: string;
  servings: number | string | null;
}

interface BomLineRow {
  id: string;
  menu_item_id: string | null;
  sub_recipe_id: string | null;
  component_sub_recipe_id: string | null;
  supplier_item_id: string | null;
  component_name: string;
  qty: number | string | null;
  unit: string | null;
  notes: string | null;
  base_qty: number | string | null;
  line_cost_rm: number | string | null;
  entity_code: string;
  status: string;
}

interface SupplierCostRow {
  id: string;
  unit_cost_rm: number | string | null;
  item_name: string;
  base_unit: string;
  status: string;
}

interface RawMaterialCostRow {
  id: string;
  weighted_avg_unit_cost: number | string | null;
  cost_price: number | string | null;
}

export interface CostingSnapshot {
  menuItems: MenuItem[];
  subRecipes: SubRecipeCost[];
  bomLines: BomLine[];
  unitCostBySupplierItem: Map<string, number>;
  wacByMaterial: Map<string, number>;
  supplierChoices: { id: string; name: string; unit: string; unitCost: number | null }[];
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapMenuItem(row: MenuItemRow): MenuItem {
  return {
    id: row.id,
    name: row.name,
    sku: null,
    selling_price: asNumber(row.selling_price_ex_sst_rm) ?? 0,
    target_cost_percentage: DEFAULT_TARGET_COST_PERCENTAGE,
    category: row.entity_code,
    is_active: row.status === 'active',
    created_at: row.created_at,
    updated_at: row.updated_at,
    entity_code: row.entity_code,
    servings: asNumber(row.servings) ?? 1,
  };
}

function mapBomLine(row: BomLineRow): BomLine {
  return {
    id: row.id,
    menu_item_id: row.menu_item_id,
    sub_recipe_id: row.sub_recipe_id,
    raw_material_id: null,
    component_sub_recipe_id: row.component_sub_recipe_id,
    supplier_item_id: row.supplier_item_id,
    component_name: row.component_name,
    quantity: asNumber(row.qty) ?? 0,
    unit: row.unit ?? '',
    notes: row.notes,
    base_qty: asNumber(row.base_qty),
    line_cost_rm: asNumber(row.line_cost_rm),
    entity_code: row.entity_code,
  };
}

function mapSuggestion(row: Record<string, unknown>): SourcingSuggestion {
  return {
    ingredient_id: (row.ingredient_id as string | null) ?? null,
    raw_material_id: (row.raw_material_id as string | null) ?? null,
    material_name: String(row.material_name ?? ''),
    base_unit: (row.base_unit as string | null) ?? null,
    preferred_supplier_item_id: (row.preferred_supplier_item_id as string | null) ?? null,
    preferred_supplier_id: (row.preferred_supplier_id as string | null) ?? null,
    preferred_supplier_name: (row.preferred_supplier_name as string | null) ?? null,
    preferred_unit_cost: asNumber(row.preferred_unit_cost as number | string | null),
    preferred_pack_price: asNumber(row.preferred_pack_price as number | string | null),
    preferred_pack_description: (row.preferred_pack_description as string | null) ?? null,
    preferred_otif_rate: asNumber(row.preferred_otif_rate as number | string | null),
    preferred_fill_rate: asNumber(row.preferred_fill_rate as number | string | null),
    lowest_supplier_item_id: (row.lowest_supplier_item_id as string | null) ?? null,
    lowest_supplier_id: (row.lowest_supplier_id as string | null) ?? null,
    lowest_supplier_name: (row.lowest_supplier_name as string | null) ?? null,
    lowest_unit_cost: asNumber(row.lowest_unit_cost as number | string | null),
    lowest_pack_price: asNumber(row.lowest_pack_price as number | string | null),
    lowest_otif_rate: asNumber(row.lowest_otif_rate as number | string | null),
    lowest_fill_rate: asNumber(row.lowest_fill_rate as number | string | null),
    preferred_is_lowest: Boolean(row.preferred_is_lowest),
    savings_percent: asNumber(row.savings_percent as number | string | null),
    supplier_count: asNumber(row.supplier_count as number | string | null) ?? 0,
  };
}

export async function fetchMenuItems() {
  const { data, error } = await supabase
    .from('menu_items')
    .select('id, name, entity_code, status, selling_price_ex_sst_rm, servings, created_at, updated_at')
    .order('name');

  return {
    data: ((data ?? []) as MenuItemRow[]).map(mapMenuItem),
    error,
  };
}

export async function fetchBomLines(menuItemId?: string, subRecipeId?: string) {
  let query = supabase
    .from('bom_lines')
    .select(
      'id, menu_item_id, sub_recipe_id, component_sub_recipe_id, supplier_item_id, component_name, qty, unit, notes, base_qty, line_cost_rm, entity_code, status',
    )
    .eq('status', 'active')
    .order('component_name');

  if (menuItemId) query = query.eq('menu_item_id', menuItemId);
  if (subRecipeId) query = query.eq('sub_recipe_id', subRecipeId);

  const { data, error } = await query;
  return {
    data: ((data ?? []) as BomLineRow[]).map(mapBomLine),
    error,
  };
}

async function fetchSubRecipes() {
  const { data, error } = await supabase
    .from('sub_recipes')
    .select('id, name, entity_code, status, servings')
    .order('name');
  return { data: (data ?? []) as SubRecipeRow[], error };
}

async function fetchSupplierCosts() {
  const { data, error } = await supabase
    .from('supplier_items')
    .select('id, unit_cost_rm, item_name, base_unit, status')
    .eq('status', 'active');
  return { data: (data ?? []) as SupplierCostRow[], error };
}

async function fetchRawMaterialCosts() {
  const { data, error } = await supabase
    .from('raw_materials')
    .select('id, weighted_avg_unit_cost, cost_price');
  return { data: (data ?? []) as RawMaterialCostRow[], error };
}

export async function loadCostingSnapshot(): Promise<{ data: CostingSnapshot | null; error: { message: string } | null }> {
  const [menuResult, prepResult, lineResult, supplierResult, materialResult] = await Promise.all([
    fetchMenuItems(),
    fetchSubRecipes(),
    fetchBomLines(),
    fetchSupplierCosts(),
    fetchRawMaterialCosts(),
  ]);

  const error = menuResult.error ?? prepResult.error ?? lineResult.error ?? supplierResult.error ?? materialResult.error;
  if (error) return { data: null, error };

  const unitCostBySupplierItem = new Map<string, number>();
  const wacByMaterial = new Map<string, number>();
  for (const item of supplierResult.data) {
    const cost = asNumber(item.unit_cost_rm);
    if (cost != null) unitCostBySupplierItem.set(item.id, cost);
  }
  for (const material of materialResult.data) {
    const cost = asNumber(material.weighted_avg_unit_cost) ?? asNumber(material.cost_price);
    if (cost != null) wacByMaterial.set(material.id, cost);
  }

  const bomLines = lineResult.data;
  const servingsByPrep = new Map(prepResult.data.map((prep) => [prep.id, asNumber(prep.servings) ?? 1]));
  const preps: SubRecipeCost[] = prepResult.data.map((prep) => {
    const cost = costParent(prep.id, 'sub_recipe', {
      bomLines,
      unitCostBySupplierItem,
      wacByMaterial,
      servingsByPrep,
    });
    const servings = asNumber(prep.servings) ?? 1;
    return {
      id: prep.id,
      name: prep.name,
      entity_code: prep.entity_code,
      servings,
      is_active: prep.status === 'active',
      batchCost: cost.total,
      unitCost: cost.total == null || servings <= 0 ? null : cost.total / servings,
      incomplete: cost.incomplete,
    };
  });

  return {
    data: {
      menuItems: menuResult.data,
      subRecipes: preps,
      bomLines,
      unitCostBySupplierItem,
      wacByMaterial,
      supplierChoices: supplierResult.data.map((item) => ({
        id: item.id,
        name: item.item_name,
        unit: item.base_unit,
        unitCost: asNumber(item.unit_cost_rm),
      })),
    },
    error: null,
  };
}

interface CostContext {
  bomLines: BomLine[];
  unitCostBySupplierItem: Map<string, number>;
  wacByMaterial: Map<string, number>;
  servingsByPrep: Map<string, number>;
}

function costParent(
  parentId: string,
  parentKind: 'menu_item' | 'sub_recipe',
  ctx: CostContext,
  stack: Set<string> = new Set(),
): { total: number | null; incomplete: boolean; lines: DishCogs['lines'] } {
  const lines = ctx.bomLines.filter((line) =>
    parentKind === 'menu_item' ? line.menu_item_id === parentId : line.sub_recipe_id === parentId,
  );
  const nextStack = new Set(stack);
  if (parentKind === 'sub_recipe') nextStack.add(parentId);

  let total = 0;
  let incomplete = false;
  const priced: DishCogs['lines'] = lines.map((line) => {
    const cost = costLine(line, ctx, nextStack);
    if (cost == null) incomplete = true;
    else total += cost;
    return {
      id: line.id,
      name: line.component_name,
      quantity: line.base_qty ?? line.quantity,
      unit: line.unit,
      cost,
    };
  });

  return { total: incomplete && total === 0 && lines.length > 0 ? null : total, incomplete, lines: priced };
}

function costLine(line: BomLine, ctx: CostContext, stack: Set<string>): number | null {
  if (line.supplier_item_id) {
    const unitCost = ctx.unitCostBySupplierItem.get(line.supplier_item_id);
    const qty = line.base_qty ?? line.quantity;
    if (unitCost == null || qty <= 0) return line.line_cost_rm;
    return unitCost * qty;
  }

  if (line.raw_material_id) {
    const unitCost = ctx.wacByMaterial.get(line.raw_material_id);
    if (unitCost == null) return null;
    return unitCost * line.quantity;
  }

  if (line.component_sub_recipe_id) {
    if (stack.has(line.component_sub_recipe_id)) return null;
    const batch = costParent(line.component_sub_recipe_id, 'sub_recipe', ctx, stack);
    if (batch.total == null) return null;
    const servings = ctx.servingsByPrep.get(line.component_sub_recipe_id) ?? 1;
    if (servings <= 0) return null;
    return batch.total * (line.quantity / servings);
  }

  return line.line_cost_rm;
}

export function dishCogsFromSnapshot(menuItem: MenuItem, snapshot: CostingSnapshot): DishCogs {
  const servingsByPrep = new Map(snapshot.subRecipes.map((prep) => [prep.id, prep.servings]));
  const cost = costParent(menuItem.id, 'menu_item', {
    bomLines: snapshot.bomLines,
    unitCostBySupplierItem: snapshot.unitCostBySupplierItem,
    wacByMaterial: snapshot.wacByMaterial,
    servingsByPrep,
  });
  const sellingPrice = menuItem.selling_price;
  const foodCostPercent =
    cost.total == null || sellingPrice <= 0 ? null : (cost.total / sellingPrice) * 100;

  return {
    menuItemId: menuItem.id,
    foodCost: cost.total,
    sellingPrice,
    foodCostPercent,
    incomplete: cost.incomplete,
    lines: cost.lines,
  };
}

/** Theoretical food cost for one dish, including nested prep batches. */
export async function calculateDishCogs(menuItemId: string): Promise<{ data: DishCogs | null; error: { message: string } | null }> {
  const snapshot = await loadCostingSnapshot();
  if (snapshot.error || !snapshot.data) return { data: null, error: snapshot.error };
  const menuItem = snapshot.data.menuItems.find((item) => item.id === menuItemId);
  if (!menuItem) return { data: null, error: { message: 'Dish not found' } };
  return { data: dishCogsFromSnapshot(menuItem, snapshot.data), error: null };
}

export async function fetchSourcingSuggestions(rawMaterialId?: string) {
  let query = supabase.from('v_ingredient_sourcing_suggestions').select('*').order('material_name');
  if (rawMaterialId) query = query.eq('raw_material_id', rawMaterialId);
  const { data, error } = await query;
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map(mapSuggestion),
    error,
  };
}

export async function addSupplierItemToBom(input: {
  entityCode: string;
  menuItemId?: string;
  subRecipeId?: string;
  supplierItemId: string;
  componentName: string;
  quantity: number;
  unit: string;
}) {
  return supabase.from('bom_lines').insert({
    entity_code: input.entityCode,
    menu_item_id: input.menuItemId ?? null,
    sub_recipe_id: input.subRecipeId ?? null,
    supplier_item_id: input.supplierItemId,
    component_name: input.componentName,
    qty: input.quantity,
    unit: input.unit,
    base_qty: input.quantity,
    price_basis: 'list',
    status: 'active',
  });
}

export async function updateBomLineQuantity(id: string, quantity: number) {
  return supabase.from('bom_lines').update({ qty: quantity, base_qty: quantity, updated_at: new Date().toISOString() }).eq('id', id);
}

export async function deleteBomLine(id: string) {
  return supabase.from('bom_lines').delete().eq('id', id);
}
