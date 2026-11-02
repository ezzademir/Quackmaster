/** Live bom cost from the supplier catalogue or a sub-recipe's own lines. Missing prices become 0 and carry a warning. */

export interface SupplierChoice {
  id: string;
  itemName: string;
  ingredientName: string;
  supplierName: string;
  packQty: number | null;
  packUnit: string | null;
  baseUnit: string;
  unitCostRm: number | null;
}

export interface SubRecipeChoice {
  id: string;
  name: string;
  servings: number | null;
  yieldNote: string | null;
  wastagePct: number;
}

export interface BomGraphLine {
  id?: string;
  qty: number | string | null;
  baseQty: number | string | null;
  status?: string;
  supplierItemId: string | null;
  componentSubRecipeId: string | null;
}

export interface BomCostCatalog {
  supplierItems: Map<string, SupplierChoice>;
  subRecipes: Map<string, SubRecipeChoice>;
  linesBySubRecipe: Map<string, BomGraphLine[]>;
}

export type BomLineKind = 'supplier' | 'sub-recipe' | 'unlinked' | 'conflict';

export interface BomLineCost {
  kind: BomLineKind;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  warning: string | null;
}

export function emptyBomCatalog(): BomCostCatalog {
  return {
    supplierItems: new Map(),
    subRecipes: new Map(),
    linesBySubRecipe: new Map(),
  };
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function lineQuantity(line: { qty: number | string | null; baseQty: number | string | null }): number | null {
  return asNumber(line.baseQty) ?? asNumber(line.qty);
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

export function supplierItemLabel(item: SupplierChoice): string {
  const name = item.ingredientName || item.itemName;
  const pack = item.packQty != null && item.packUnit ? `${trimNumber(item.packQty)} ${item.packUnit}` : item.baseUnit;
  const price = item.unitCostRm == null ? 'no price' : `RM ${item.unitCostRm.toFixed(4)}`;
  return `${name} — ${pack} (${price}) — ${item.supplierName}`;
}

export function subRecipeLabel(prep: SubRecipeChoice): string {
  const amount = prep.servings == null ? null : trimNumber(prep.servings);
  const yieldText = [amount, prep.yieldNote].filter((part) => part != null && part !== '').join(' ');
  return `${prep.name} (Yield: ${yieldText || '—'})`;
}

function result(kind: BomLineKind, quantity: number | null, unitCost: number, warning: string | null): BomLineCost {
  const amount = quantity ?? 0;
  const quantityWarning = quantity == null ? 'Quantity is missing.' : null;
  return {
    kind,
    quantity: amount,
    unitCost,
    lineTotal: quantity == null ? 0 : amount * unitCost,
    warning: warning ?? quantityWarning,
  };
}

function subRecipeUnitCost(
  id: string,
  catalog: BomCostCatalog,
  stack: ReadonlySet<string>,
): { unitCost: number; warning: string | null } {
  if (stack.has(id)) return { unitCost: 0, warning: 'This sub-recipe refers back to itself.' };
  const prep = catalog.subRecipes.get(id);
  if (!prep) return { unitCost: 0, warning: 'Sub-recipe is not in the catalogue.' };
  if (prep.servings == null || prep.servings <= 0) return { unitCost: 0, warning: 'Sub-recipe servings are missing.' };
  const children = (catalog.linesBySubRecipe.get(id) ?? []).filter((child) => (child.status ?? 'active') === 'active');
  if (children.length === 0) return { unitCost: 0, warning: 'This sub-recipe has no active lines.' };
  const next = new Set(stack);
  next.add(id);
  let sum = 0;
  let warning: string | null = null;
  for (const child of children) {
    const cost = resolveBomLineCost(child, catalog, next);
    sum += cost.lineTotal;
    if (warning == null && cost.warning) warning = cost.warning;
  }
  return { unitCost: (sum * (1 + prep.wastagePct / 100)) / prep.servings, warning };
}

type LineLink =
  | { kind: 'conflict' }
  | { kind: 'unlinked' }
  | { kind: 'supplier'; id: string }
  | { kind: 'sub-recipe'; id: string };

function lineLink(line: BomGraphLine): LineLink {
  if (line.supplierItemId && line.componentSubRecipeId) return { kind: 'conflict' };
  if (line.supplierItemId) return { kind: 'supplier', id: line.supplierItemId };
  if (line.componentSubRecipeId) return { kind: 'sub-recipe', id: line.componentSubRecipeId };
  return { kind: 'unlinked' };
}

export function resolveBomLineCost(
  line: BomGraphLine,
  catalog: BomCostCatalog,
  stack: ReadonlySet<string> = new Set(),
): BomLineCost {
  const quantity = lineQuantity(line);
  const link = lineLink(line);
  switch (link.kind) {
    case 'conflict':
      return result('conflict', quantity, 0, 'This line points at a supplier item and a sub-recipe.');
    case 'unlinked':
      return result('unlinked', quantity, 0, 'This line is not linked to a supplier item or a sub-recipe.');
    case 'supplier': {
      const item = catalog.supplierItems.get(link.id);
      if (!item) return result('supplier', quantity, 0, 'Supplier item is not in the catalogue.');
      if (item.unitCostRm == null) return result('supplier', quantity, 0, 'This supplier item has no unit cost.');
      return result('supplier', quantity, item.unitCostRm, null);
    }
    case 'sub-recipe': {
      const prep = subRecipeUnitCost(link.id, catalog, stack);
      return result('sub-recipe', quantity, prep.unitCost, prep.warning);
    }
    default: {
      const _exhaustive: never = link;
      return _exhaustive;
    }
  }
}
