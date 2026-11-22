import { describe, expect, it } from 'vitest';
import {
  canCompleteRunWithMaterials,
  isCurrentRecipeLoad,
  runMaterialsFromInventory,
  type RecipeMaterialIngredient,
} from './productionRecipeMaterials';

const chicken: RecipeMaterialIngredient = {
  raw_material_id: 'rm-chicken',
  quantity_required: 2,
  material_name: 'Chicken',
  unit: 'kg',
};
const rice: RecipeMaterialIngredient = {
  raw_material_id: 'rm-rice',
  quantity_required: 1,
  material_name: 'Rice',
  unit: 'kg',
};

describe('production recipe material load', () => {
  it('ignores a slower response from an earlier recipe selection', () => {
    expect(isCurrentRecipeLoad(1, 2)).toBe(false);
    expect(isCurrentRecipeLoad(2, 2)).toBe(true);
  });

  it('refuses to complete while materials are missing, loading, or failed', () => {
    expect(canCompleteRunWithMaterials('idle')).toBe(false);
    expect(canCompleteRunWithMaterials('loading')).toBe(false);
    expect(canCompleteRunWithMaterials('error')).toBe(false);
    expect(canCompleteRunWithMaterials('ready')).toBe(true);
  });

  it('builds lines only from the recipe that was loaded', () => {
    const lines = runMaterialsFromInventory([chicken, rice], [
      { raw_material_id: 'rm-chicken', quantity_on_hand: 4 },
      { raw_material_id: 'rm-rice', quantity_on_hand: 0.5 },
    ]);
    expect(lines.map((line) => line.raw_material_id)).toEqual(['rm-chicken', 'rm-rice']);
    expect(lines[0]).toMatchObject({ quantity_consumed: '2', required: 2, available_qty: 4 });
    expect(lines[1]).toMatchObject({ available_qty: 0.5, material_name: 'Rice' });
  });

  it('uses the last hub row when a material appears twice', () => {
    const lines = runMaterialsFromInventory([chicken], [
      { raw_material_id: 'rm-chicken', quantity_on_hand: 1 },
      { raw_material_id: 'rm-chicken', quantity_on_hand: 9 },
    ]);
    expect(lines[0].available_qty).toBe(9);
  });

  it('returns no lines for a recipe with no ingredients', () => {
    expect(runMaterialsFromInventory([], [{ raw_material_id: 'rm-chicken', quantity_on_hand: 4 }])).toEqual([]);
  });
});
