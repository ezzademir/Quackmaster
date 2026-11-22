/**
 * Materials shown on New Production Run, and the gate that decides whether
 * Complete may post stock.
 *
 * Completion reads the materials currently in the form. Those lines have to
 * belong to the recipe selected right now, and the inventory request for that
 * selection has to have finished. Otherwise the run credits finished goods
 * while deducting another recipe's raw materials, or none at all.
 */

export type RecipeMaterialsLoad = 'idle' | 'loading' | 'ready' | 'error';

export interface RecipeMaterialIngredient {
  raw_material_id: string;
  quantity_required: number;
  material_name: string;
  unit: string;
}

export interface HubOnHandRow {
  raw_material_id: string;
  quantity_on_hand: number;
}

export interface RunMaterialLine {
  raw_material_id: string;
  quantity_consumed: string;
  required: number;
  material_name: string;
  unit: string;
  available_qty: number;
}

/** True only for the latest recipe selection. A slower earlier response must not apply. */
export function isCurrentRecipeLoad(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

/** Complete posts whatever is in the form. Only a finished load for the current recipe is safe. */
export function canCompleteRunWithMaterials(load: RecipeMaterialsLoad): boolean {
  return load === 'ready';
}

/**
 * One line per recipe ingredient. If several hub rows share a material, the last
 * row in the query wins — the same rule the form used before this helper.
 */
export function runMaterialsFromInventory(
  ingredients: RecipeMaterialIngredient[],
  rows: HubOnHandRow[],
): RunMaterialLine[] {
  const availableQuantities = new Map(
    rows.map((item) => [item.raw_material_id, item.quantity_on_hand]),
  );
  return ingredients.map((ing) => ({
    raw_material_id: ing.raw_material_id,
    quantity_consumed: ing.quantity_required.toString(),
    required: ing.quantity_required,
    material_name: ing.material_name,
    unit: ing.unit,
    available_qty: availableQuantities.get(ing.raw_material_id) ?? 0,
  }));
}
