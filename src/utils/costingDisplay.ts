/** Display helpers for the admin costing screen. Costs stay blank when unknown; nothing is estimated. */

export type CostingTab = 'dishes' | 'recipes' | 'drift' | 'flags';

export interface RecipeCostRow {
  kind: 'dish' | 'sub-recipe';
  id: string;
  entity_code: string;
  name: string;
  status: string;
  source_sheet: string | null;
  selling_price_ex_sst_rm: number | string | null;
  line_count: number | string | null;
  incomplete_lines: number | string | null;
  cost_complete: boolean;
  food_cost_rm: number | string | null;
  known_cost_rm: number | string | null;
}

export interface DishCogsRow {
  menu_item_id: string;
  cogs_dine_in_pct: number | string | null;
  cogs_takeaway_pct: number | string | null;
  food_cost_pct: number | string | null;
}

export interface DishRow extends RecipeCostRow {
  cogs_dine_in_pct: number | string | null;
  cogs_takeaway_pct: number | string | null;
  food_cost_pct: number | string | null;
}

export interface DriftRow {
  bom_line_id: string;
  entity_code: string;
  parent_name: string;
  parent_kind: string;
  component_name: string;
  supplier_item: string | null;
  snapshot_cost_rm: number | string | null;
  current_cost_rm: number | string | null;
  drift_rm: number | string | null;
  drift_pct: number | string | null;
}

export interface PriceFlagRow {
  id: number | string;
  item_name: string;
  procurement_tag: string;
  price_rm: number | string;
  unit_cost_rm: number | string | null;
  previous_unit_cost_rm: number | string | null;
  pct_change: number | string | null;
  source: string;
  entered_at: string;
  note: string | null;
}

export interface BomLineRow {
  id: string;
  component_name: string;
  qty: number | string | null;
  unit: string | null;
  base_qty: number | string | null;
  line_cost_rm: number | string | null;
  cost_complete: boolean;
  price_basis: string;
  status: string;
  issues: string | null;
  shared_ingredient: boolean;
  entity_code?: string | null;
  source_sheet?: string | null;
  source_row?: number | string | null;
  supplier_item_id?: string | null;
  component_sub_recipe_id?: string | null;
}

export interface RecipeParent {
  wastage_pct: number | string | null;
  servings: number | string | null;
  notes: string | null;
  yield_note: string | null;
  packaging_rule: string | null;
  pkg_dine_in_rm: number | string | null;
  pkg_takeaway_rm: number | string | null;
}

const ENTITY_LABEL: Record<string, string> = {
  QT: 'Quackteow',
  MH: 'Merdeka House',
};

export function entityLabel(code: string): string {
  return ENTITY_LABEL[code] ?? code;
}

/** Procurement tags on supplier items, mapped onto the cost-book codes the screen filters by. */
export function entityCodeForProcurementTag(tag: string): string {
  if (tag === 'quackteow') return 'QT';
  if (tag === 'merdeka_house') return 'MH';
  return tag;
}

export function formatRm(value: number | string | null | undefined, digits = 2): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatPct(value: number | string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}%`;
}

export function formatQty(value: number | string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-MY', { maximumFractionDigits: 4 });
}

export function mergeDishCogs(recipes: RecipeCostRow[], cogs: DishCogsRow[]): DishRow[] {
  const byId = new Map(cogs.map((row) => [row.menu_item_id, row]));
  return recipes
    .filter((row) => row.kind === 'dish')
    .map((row) => {
      const match = byId.get(row.id);
      return {
        ...row,
        cogs_dine_in_pct: match?.cogs_dine_in_pct ?? null,
        cogs_takeaway_pct: match?.cogs_takeaway_pct ?? null,
        food_cost_pct: match?.food_cost_pct ?? null,
      };
    });
}

export function filterCostingRows<T>(
  rows: T[],
  entity: string,
  query: string,
  entityOf: (row: T) => string | null,
  textOf: (row: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (entity !== 'all' && entityOf(row) !== entity) return false;
    if (!q) return true;
    return textOf(row).toLowerCase().includes(q);
  });
}

export function entityChoices(codes: Array<string | null>): { value: string; label: string }[] {
  const extras = [...new Set(codes.filter((code): code is string => Boolean(code) && code !== 'QT' && code !== 'MH'))].sort();
  return [
    { value: 'all', label: 'All entities' },
    { value: 'QT', label: 'Quackteow' },
    { value: 'MH', label: 'Merdeka House' },
    ...extras.map((code) => ({ value: code, label: entityLabel(code) })),
  ];
}

export function sortDrift(rows: DriftRow[]): DriftRow[] {
  return [...rows].sort(
    (a, b) => Math.abs(Number(b.drift_pct) || 0) - Math.abs(Number(a.drift_pct) || 0),
  );
}

export function costingStats(dishes: DishRow[], drift: DriftRow[], flags: PriceFlagRow[]) {
  const complete = dishes.filter((row) => row.cost_complete).length;
  return {
    dishes: dishes.length,
    complete,
    incomplete: dishes.length - complete,
    drift: drift.filter((row) => Number(row.drift_rm) !== 0).length,
    flags: flags.length,
  };
}

export function emptyCostingCopy(
  tab: CostingTab,
  loadedCount: number,
  visibleCount: number,
): { title: string; description: string } | null {
  if (visibleCount > 0) return null;
  if (loadedCount > 0) {
    return { title: 'Nothing matches', description: 'Try another entity or clear the search.' };
  }
  switch (tab) {
    case 'dishes':
    case 'recipes':
      return {
        title: 'No recipes loaded',
        description:
          'The costing tables are empty. Food cost appears here after the reviewed catalogue is applied. Unknown lines stay blank.',
      };
    case 'drift':
      return {
        title: 'No cost drift',
        description: 'Drift compares a saved recipe line with the supplier’s current price. Nothing to compare until recipes and prices are loaded.',
      };
    case 'flags':
      return {
        title: 'No open price flags',
        description: 'A price more than 5% above the previous price for the same item shows up here for an admin to accept or query.',
      };
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}
