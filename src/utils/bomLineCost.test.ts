import { describe, expect, it } from 'vitest';
import {
  emptyBomCatalog,
  resolveBomLineCost,
  subRecipeLabel,
  supplierItemLabel,
  type BomCostCatalog,
  type BomGraphLine,
  type SubRecipeChoice,
  type SupplierChoice,
} from './bomLineCost';

const oil: SupplierChoice = {
  id: 'oil',
  itemName: 'Cooking oil',
  ingredientName: 'Cooking oil',
  supplierName: 'Farm',
  packQty: 17000,
  packUnit: 'GM',
  baseUnit: 'g',
  unitCostRm: 2,
};

function catalog(lines: BomGraphLine[] = []): BomCostCatalog {
  const prep: SubRecipeChoice = {
    id: 'sambal',
    name: 'Sambal',
    servings: 2,
    yieldNote: '200 g',
    wastagePct: 0,
  };
  return {
    supplierItems: new Map([[oil.id, oil]]),
    subRecipes: new Map([[prep.id, prep]]),
    linesBySubRecipe: new Map([[prep.id, lines]]),
  };
}

const child = (overrides: Partial<BomGraphLine> = {}): BomGraphLine => ({
  id: 'child',
  qty: 4,
  baseQty: 4,
  status: 'active',
  supplierItemId: 'oil',
  componentSubRecipeId: null,
  ...overrides,
});

describe('catalogue labels', () => {
  it('formats a supplier item with its ingredient, pack, unit cost, and supplier', () => {
    expect(supplierItemLabel(oil)).toBe('Cooking oil — 17000 GM (RM 2.0000) — Farm');
  });

  it('formats a sub-recipe with its yield', () => {
    expect(subRecipeLabel(catalog().subRecipes.get('sambal')!)).toBe('Sambal (Yield: 2 200 g)');
  });
});

describe('resolveBomLineCost', () => {
  it('multiplies the line quantity by the supplier unit cost', () => {
    const cost = resolveBomLineCost(child(), catalog());
    expect(cost).toMatchObject({ kind: 'supplier', quantity: 4, unitCost: 2, lineTotal: 8, warning: null });
  });

  it('uses a zero unit cost without a warning', () => {
    const free = { ...oil, id: 'water', unitCostRm: 0 };
    const book = catalog();
    book.supplierItems.set(free.id, free);
    const cost = resolveBomLineCost(child({ supplierItemId: 'water' }), book);
    expect(cost).toMatchObject({ unitCost: 0, lineTotal: 0, warning: null });
  });

  it('warns and returns zero when the supplier price is missing', () => {
    const book = catalog();
    book.supplierItems.set(oil.id, { ...oil, unitCostRm: null });
    const cost = resolveBomLineCost(child(), book);
    expect(cost.lineTotal).toBe(0);
    expect(cost.warning).toBe('This supplier item has no unit cost.');
  });

  it('warns when the line is not linked', () => {
    const cost = resolveBomLineCost(child({ supplierItemId: null }), emptyBomCatalog());
    expect(cost).toMatchObject({ kind: 'unlinked', lineTotal: 0 });
    expect(cost.warning).toContain('not linked');
  });

  it('rolls a sub-recipe cost up from its own lines, then prices the parent quantity', () => {
    const book = catalog([child()]);
    const cost = resolveBomLineCost(
      { qty: 3, baseQty: 3, supplierItemId: null, componentSubRecipeId: 'sambal' },
      book,
    );
    expect(cost).toMatchObject({ kind: 'sub-recipe', unitCost: 4, lineTotal: 12, warning: null });
  });

  it('warns and returns zero when a sub-recipe refers back to itself', () => {
    const loop: BomGraphLine = {
      qty: 1,
      baseQty: 1,
      status: 'active',
      supplierItemId: null,
      componentSubRecipeId: 'sambal',
    };
    const cost = resolveBomLineCost(loop, catalog([loop]));
    expect(cost.lineTotal).toBe(0);
    expect(cost.warning).toBe('This sub-recipe refers back to itself.');
  });
});
