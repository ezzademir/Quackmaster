import { hubRowAvailableQuantity } from './hubInventoryMath';
import { nestedRecipeSku } from './lotLabel';

export type TraceLot = {
  id: string;
  product_batch_label: string;
  expiry_date: string | null;
  manufactured_at: string | null;
  parent_lot_id: string | null;
  purchase_order_item_id: string | null;
  production_run_id: string | null;
  recipeSku: string | null;
  runNumber: string | null;
  aliases: string[];
};

export type LotLocation = {
  key: string;
  kind: 'hub' | 'outlet';
  name: string;
  onHand: number;
  reserved: number;
  available: number;
};

export type InvQtyRow = {
  lot_id: string | null | undefined;
  product_batch?: string | null;
  quantity_on_hand?: number | null;
  reserved_quantity?: number | null;
  available_quantity?: number | null;
};

export type OutletInvQtyRow = InvQtyRow & {
  outlet_id?: string | null;
  outlet_name?: string | null;
};

export function escapeIlike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function runNumberFromEmbed(run: unknown): string | null {
  if (run == null) return null;
  const obj = (Array.isArray(run) ? run[0] : run) as { run_number?: string | null } | undefined;
  const n = obj?.run_number != null ? String(obj.run_number).trim() : '';
  return n || null;
}

export function mapInventoryLotRow(row: Record<string, unknown>): TraceLot {
  const run = row.production_run ?? row.production_runs;
  return {
    id: String(row.id),
    product_batch_label: String(row.product_batch_label ?? '').trim(),
    expiry_date: (row.expiry_date as string | null) ?? null,
    manufactured_at: (row.manufactured_at as string | null) ?? null,
    parent_lot_id: row.parent_lot_id ? String(row.parent_lot_id) : null,
    purchase_order_item_id: row.purchase_order_item_id ? String(row.purchase_order_item_id) : null,
    production_run_id: row.production_run_id ? String(row.production_run_id) : null,
    recipeSku: nestedRecipeSku({ production_run: run }),
    runNumber: runNumberFromEmbed(run),
    aliases: [],
  };
}

export function collectAliasesByLotId(rows: Array<{ lot_id?: string | null; product_batch?: string | null }>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const row of rows) {
    const id = row.lot_id ? String(row.lot_id) : '';
    const pb = (row.product_batch ?? '').trim();
    if (!id || !pb) continue;
    const arr = m.get(id) ?? [];
    if (!arr.includes(pb)) arr.push(pb);
    m.set(id, arr);
  }
  return m;
}

export function attachAliases(lots: TraceLot[], aliases: Map<string, string[]>): TraceLot[] {
  return lots.map((lot) => {
    const extra = aliases.get(lot.id) ?? [];
    const merged = [...lot.aliases];
    for (const a of extra) {
      if (a && a !== lot.product_batch_label && !merged.includes(a)) merged.push(a);
    }
    return { ...lot, aliases: merged };
  });
}

export function lotMatchesQuery(lot: TraceLot, query: string): boolean {
  const n = query.trim().toLowerCase();
  if (!n) return false;
  if (lot.product_batch_label.toLowerCase().includes(n)) return true;
  if ((lot.recipeSku ?? '').toLowerCase().includes(n)) return true;
  if ((lot.runNumber ?? '').toLowerCase().includes(n)) return true;
  return lot.aliases.some((a) => a.toLowerCase().includes(n));
}

export function lotsMatchingQuery(lots: TraceLot[], query: string): TraceLot[] {
  const n = query.trim();
  if (!n) return [];
  return lots.filter((lot) => lotMatchesQuery(lot, n));
}

/**
 * Unique hit for auto-select. Exact lot label or BATCH alias wins.
 * An exact recipe SKU with more than one lot is not unique (show the list).
 */
export function resolveUniqueLotId(lots: TraceLot[], query: string): string | null {
  const n = query.trim().toLowerCase();
  if (!n) return null;
  const exactLabel = lots.filter((l) => l.product_batch_label.toLowerCase() === n);
  if (exactLabel.length === 1) return exactLabel[0].id;
  const exactAlias = lots.filter((l) => l.aliases.some((a) => a.toLowerCase() === n));
  if (exactAlias.length === 1) return exactAlias[0].id;
  const exactSku = lots.filter((l) => (l.recipeSku ?? '').toLowerCase() === n);
  if (exactSku.length === 1) return exactSku[0].id;
  if (exactSku.length > 1) return null;
  const partial = lotsMatchingQuery(lots, query);
  if (partial.length === 1) return partial[0].id;
  return null;
}

export function childrenByParent(lots: TraceLot[]): Map<string, TraceLot[]> {
  const m = new Map<string, TraceLot[]>();
  for (const lot of lots) {
    if (!lot.parent_lot_id) continue;
    const arr = m.get(lot.parent_lot_id) ?? [];
    arr.push(lot);
    m.set(lot.parent_lot_id, arr);
  }
  return m;
}

export function rootLots(lots: TraceLot[]): TraceLot[] {
  const ids = new Set(lots.map((l) => l.id));
  return lots.filter((l) => !l.parent_lot_id || !ids.has(l.parent_lot_id));
}

export function ancestorIds(lotId: string, lots: TraceLot[]): string[] {
  const byId = new Map(lots.map((l) => [l.id, l] as const));
  const out: string[] = [];
  let cur = byId.get(lotId);
  const seen = new Set<string>();
  while (cur?.parent_lot_id && !seen.has(cur.parent_lot_id)) {
    seen.add(cur.parent_lot_id);
    out.push(cur.parent_lot_id);
    cur = byId.get(cur.parent_lot_id);
  }
  return out;
}

export function descendantIds(lotId: string, childrenOf: Map<string, TraceLot[]>): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const child of childrenOf.get(id) ?? []) {
      out.push(child.id);
      walk(child.id);
    }
  };
  walk(lotId);
  return out;
}

/** Matches plus ancestors (for the tree) and descendants (keep the subtree). */
export function treeKeepIds(lots: TraceLot[], matchIds: Set<string>, childrenOf: Map<string, TraceLot[]>): Set<string> {
  const keep = new Set(matchIds);
  for (const id of matchIds) {
    for (const a of ancestorIds(id, lots)) keep.add(a);
    for (const d of descendantIds(id, childrenOf)) keep.add(d);
  }
  return keep;
}

export function mergeLots(existing: TraceLot[], incoming: TraceLot[]): TraceLot[] {
  const m = new Map(existing.map((l) => [l.id, l] as const));
  for (const lot of incoming) {
    const prev = m.get(lot.id);
    if (!prev) {
      m.set(lot.id, lot);
      continue;
    }
    const aliases = [...prev.aliases];
    for (const a of lot.aliases) {
      if (a && !aliases.includes(a)) aliases.push(a);
    }
    m.set(lot.id, {
      ...prev,
      ...lot,
      aliases,
      recipeSku: lot.recipeSku || prev.recipeSku,
      runNumber: lot.runNumber || prev.runNumber,
    });
  }
  return Array.from(m.values());
}

export function missingParentIds(lots: TraceLot[]): string[] {
  const ids = new Set(lots.map((l) => l.id));
  const missing: string[] = [];
  for (const lot of lots) {
    if (lot.parent_lot_id && !ids.has(lot.parent_lot_id) && !missing.includes(lot.parent_lot_id)) {
      missing.push(lot.parent_lot_id);
    }
  }
  return missing;
}

function addQty(
  acc: { onHand: number; reserved: number; available: number },
  row: InvQtyRow
): void {
  const onHand = Number(row.quantity_on_hand ?? 0);
  const reserved = Number(row.reserved_quantity ?? 0);
  acc.onHand += onHand;
  acc.reserved += reserved;
  acc.available += hubRowAvailableQuantity(onHand, reserved, row.available_quantity);
}

export function aggregateLotLocations(hub: InvQtyRow[], outlets: OutletInvQtyRow[]): Map<string, LotLocation[]> {
  const hubByLot = new Map<string, { onHand: number; reserved: number; available: number }>();
  for (const row of hub) {
    const id = row.lot_id ? String(row.lot_id) : '';
    if (!id) continue;
    const acc = hubByLot.get(id) ?? { onHand: 0, reserved: 0, available: 0 };
    addQty(acc, row);
    hubByLot.set(id, acc);
  }

  type OutletAcc = { name: string; onHand: number; reserved: number; available: number };
  const outletByLot = new Map<string, Map<string, OutletAcc>>();
  for (const row of outlets) {
    const lotId = row.lot_id ? String(row.lot_id) : '';
    const oid = row.outlet_id ? String(row.outlet_id) : '';
    if (!lotId || !oid) continue;
    let byOutlet = outletByLot.get(lotId);
    if (!byOutlet) {
      byOutlet = new Map();
      outletByLot.set(lotId, byOutlet);
    }
    const acc = byOutlet.get(oid) ?? {
      name: (row.outlet_name ?? '').trim() || 'Outlet',
      onHand: 0,
      reserved: 0,
      available: 0,
    };
    addQty(acc, row);
    if ((row.outlet_name ?? '').trim()) acc.name = String(row.outlet_name).trim();
    byOutlet.set(oid, acc);
  }

  const lotIds = new Set([...hubByLot.keys(), ...outletByLot.keys()]);
  const result = new Map<string, LotLocation[]>();
  for (const lotId of lotIds) {
    const rows: LotLocation[] = [];
    const hubAcc = hubByLot.get(lotId);
    if (hubAcc) {
      rows.push({
        key: `hub:${lotId}`,
        kind: 'hub',
        name: 'Hub',
        onHand: hubAcc.onHand,
        reserved: hubAcc.reserved,
        available: hubAcc.available,
      });
    }
    const outletsAcc = outletByLot.get(lotId);
    if (outletsAcc) {
      const sorted = Array.from(outletsAcc.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
      for (const [oid, acc] of sorted) {
        rows.push({
          key: `outlet:${oid}`,
          kind: 'outlet',
          name: acc.name,
          onHand: acc.onHand,
          reserved: acc.reserved,
          available: acc.available,
        });
      }
    }
    result.set(lotId, rows);
  }
  return result;
}

export function remainingOnHand(locations: LotLocation[]): number {
  return locations.reduce((sum, row) => sum + row.onHand, 0);
}
