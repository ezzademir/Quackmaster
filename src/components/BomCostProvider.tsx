import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  emptyBomCatalog,
  lineQuantity,
  resolveBomLineCost,
  type BomCostCatalog,
  type BomGraphLine,
  type BomLineCost,
  type SubRecipeChoice,
  type SupplierChoice,
} from '../utils/bomLineCost';
import { supabase } from '../utils/supabase';

interface ItemRow {
  id: string;
  item_name: string;
  pack_qty: number | string | null;
  pack_unit: string | null;
  base_unit: string;
  unit_cost_rm: number | string | null;
  ingredients: { name: string } | { name: string }[] | null;
  suppliers: { name: string } | { name: string }[] | null;
}

interface PrepRow {
  id: string;
  name: string;
  servings: number | string | null;
  yield_note: string | null;
  wastage_pct: number | string | null;
}

interface GraphRow {
  id: string;
  sub_recipe_id: string | null;
  qty: number | string | null;
  base_qty: number | string | null;
  status: string;
  supplier_item_id: string | null;
  component_sub_recipe_id: string | null;
}

export interface BomCostLine {
  id?: string;
  qty: number | string | null;
  base_qty?: number | string | null;
  status?: string;
  supplier_item_id?: string | null;
  component_sub_recipe_id?: string | null;
}

interface BomCatalogState {
  catalog: BomCostCatalog;
  loading: boolean;
  error: string | null;
}

const BomCatalogContext = createContext<BomCatalogState | null>(null);

function asNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function embeddedName(value: { name: string } | { name: string }[] | null | undefined): string {
  if (Array.isArray(value)) return value[0]?.name ?? '';
  return value?.name ?? '';
}

function asRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export function graphLine(line: BomCostLine): BomGraphLine {
  return {
    id: line.id,
    qty: line.qty,
    baseQty: line.base_qty ?? null,
    status: line.status,
    supplierItemId: line.supplier_item_id ?? null,
    componentSubRecipeId: line.component_sub_recipe_id ?? null,
  };
}

/** Supplier items with their ingredient and supplier, every prep, and the prep lines used to roll costs up. */
export async function loadBomCatalog(client: typeof supabase): Promise<BomCostCatalog> {
  const [items, preps, lines] = await Promise.all([
    client
      .from('supplier_items')
      .select('id, item_name, pack_qty, pack_unit, base_unit, unit_cost_rm, ingredients(name), suppliers(name)')
      .order('item_name'),
    client.from('sub_recipes').select('id, name, servings, yield_note, wastage_pct').order('name'),
    client.from('bom_lines').select('id, sub_recipe_id, qty, base_qty, status, supplier_item_id, component_sub_recipe_id').order('component_name'),
  ]);
  const failure = items.error ?? preps.error ?? lines.error;
  if (failure) throw new Error(failure.message);

  const supplierItems = new Map<string, SupplierChoice>();
  for (const row of asRows<ItemRow>(items.data)) {
    supplierItems.set(row.id, {
      id: row.id,
      itemName: row.item_name,
      ingredientName: embeddedName(row.ingredients) || row.item_name,
      supplierName: embeddedName(row.suppliers),
      packQty: asNumber(row.pack_qty),
      packUnit: row.pack_unit,
      baseUnit: row.base_unit,
      unitCostRm: asNumber(row.unit_cost_rm),
    });
  }

  const subRecipes = new Map<string, SubRecipeChoice>();
  for (const row of asRows<PrepRow>(preps.data)) {
    subRecipes.set(row.id, {
      id: row.id,
      name: row.name,
      servings: asNumber(row.servings),
      yieldNote: row.yield_note,
      wastagePct: asNumber(row.wastage_pct) ?? 0,
    });
  }

  const linesBySubRecipe = new Map<string, BomGraphLine[]>();
  for (const row of asRows<GraphRow>(lines.data)) {
    if (!row.sub_recipe_id) continue;
    const group = linesBySubRecipe.get(row.sub_recipe_id) ?? [];
    group.push(graphLine({ ...row, id: row.id }));
    linesBySubRecipe.set(row.sub_recipe_id, group);
  }

  return { supplierItems, subRecipes, linesBySubRecipe };
}

export function BomCostProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<BomCostCatalog>(emptyBomCatalog);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadBomCatalog(supabase).then(
      (next) => {
        if (cancelled) return;
        setCatalog(next);
        setLoading(false);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : 'Could not load the catalogue.');
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ catalog, loading, error }), [catalog, loading, error]);
  return <BomCatalogContext.Provider value={value}>{children}</BomCatalogContext.Provider>;
}

export function useBomCatalog(): BomCatalogState {
  const value = useContext(BomCatalogContext);
  if (!value) throw new Error('useBomCatalog must be used inside BomCostProvider');
  return value;
}

export function useBomLineCost(line: BomCostLine): BomLineCost {
  const state = useContext(BomCatalogContext);
  const supplierItemId = line.supplier_item_id ?? null;
  const componentSubRecipeId = line.component_sub_recipe_id ?? null;
  const baseQty = line.base_qty ?? null;
  return useMemo(() => {
    const graph = graphLine({
      id: line.id,
      qty: line.qty,
      base_qty: baseQty,
      status: line.status,
      supplier_item_id: supplierItemId,
      component_sub_recipe_id: componentSubRecipeId,
    });
    if (!state || state.loading) {
      return {
        kind: 'unlinked',
        quantity: lineQuantity(graph) ?? 0,
        unitCost: 0,
        lineTotal: 0,
        warning: 'Costs are still loading.',
      };
    }
    return resolveBomLineCost(graph, state.catalog);
  }, [state, line.id, line.qty, line.status, baseQty, supplierItemId, componentSubRecipeId]);
}
