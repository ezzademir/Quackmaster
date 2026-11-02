import { describe, expect, it } from 'vitest';
import { lineWrite, recipeWrite, type LineFieldInput, type RecipeFieldInput } from './recipeEdit';

const dish = (overrides: Partial<RecipeFieldInput> = {}): RecipeFieldInput => ({
  kind: 'dish',
  name: 'Nasi Ayam',
  entity_code: 'MH',
  status: 'active',
  source_sheet: 'P- Nasi Ayam',
  selling_price: '13',
  wastage_pct: '5',
  servings: '1',
  packaging_rule: 'takeaway only',
  pkg_dine_in: '',
  pkg_takeaway: '0.40',
  yield_note: '',
  notes: '  kept  ',
  ...overrides,
});

const line = (overrides: Partial<LineFieldInput> = {}): LineFieldInput => ({
  entity_code: 'MH',
  component_name: 'Chicken',
  qty: '150',
  unit: 'GM',
  base_qty: '150',
  price_basis: 'list',
  line_cost: '0.5',
  cost_complete: true,
  shared_ingredient: false,
  status: 'active',
  source_sheet: 'P- Nasi Ayam',
  source_row: '4',
  issues: '',
  supplier_item_id: '',
  component_sub_recipe_id: '',
  ...overrides,
});

describe('recipeWrite', () => {
  it('writes every dish field and leaves unknown packaging blank', () => {
    const result = recipeWrite(dish());
    expect(result).toEqual({
      ok: true,
      table: 'menu_items',
      values: {
        name: 'Nasi Ayam',
        entity_code: 'MH',
        status: 'active',
        source_sheet: 'P- Nasi Ayam',
        selling_price_ex_sst_rm: 13,
        wastage_pct: 5,
        servings: 1,
        packaging_rule: 'takeaway only',
        pkg_dine_in_rm: null,
        pkg_takeaway_rm: 0.4,
        notes: 'kept',
      },
    });
  });

  it('writes a sub-recipe yield instead of packaging', () => {
    const result = recipeWrite(dish({ kind: 'sub-recipe', yield_note: '2005 GM / YIELD', selling_price: '' }));
    if (!result.ok || result.table !== 'sub_recipes') {
      throw new Error('expected a sub-recipe write');
    }
    expect(result.values.yield_note).toBe('2005 GM / YIELD');
    expect(result.values.selling_price_ex_sst_rm).toBeNull();
    expect(result.values).not.toHaveProperty('packaging_rule');
  });

  it('rejects a recipe with no servings', () => {
    const result = recipeWrite(dish({ servings: '0' }));
    expect(result).toEqual({ ok: false, error: 'Servings must be greater than zero.' });
  });
});

describe('lineWrite', () => {
  it('writes every line field', () => {
    const result = lineWrite(
      line({
        supplier_item_id: '00000000-0000-4000-8000-000000000001',
        issues: 'checked',
        shared_ingredient: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toMatchObject({
      component_name: 'Chicken',
      qty: 150,
      unit: 'GM',
      base_qty: 150,
      price_basis: 'list',
      line_cost_rm: 0.5,
      cost_complete: true,
      shared_ingredient: true,
      source_row: 4,
      issues: 'checked',
      supplier_item_id: '00000000-0000-4000-8000-000000000001',
      component_sub_recipe_id: null,
    });
  });

  it('keeps a pending line incomplete', () => {
    const result = lineWrite(line({ price_basis: 'pending', line_cost: '', cost_complete: true }));
    expect(result).toEqual({ ok: false, error: 'A pending line cannot be marked cost complete.' });
  });

  it('refuses a line that points at both a supplier item and a sub-recipe', () => {
    const result = lineWrite(
      line({
        supplier_item_id: '00000000-0000-4000-8000-000000000001',
        component_sub_recipe_id: '00000000-0000-4000-8000-000000000002',
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'A line can point at a supplier item or a sub-recipe, not both.',
    });
  });

  it('requires a cost before a line can be complete', () => {
    const result = lineWrite(line({ line_cost: ' ', cost_complete: true }));
    expect(result).toEqual({ ok: false, error: 'Enter a line cost before marking the line complete.' });
  });
});
