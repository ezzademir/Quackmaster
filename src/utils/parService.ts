/**
 * PAR / reorder suggestions for outlets.
 * par_key convention: finished goods = product_batch string; raw materials = `rm:<uuid>`.
 */

import { supabase } from './supabase';
import { outletRowAvailableQuantity } from './hubInventoryMath';
import { isLegacyBatchCode, nestedRecipeSku } from './lotLabel';

export interface OutletParRow {
  id: string;
  outlet_id: string;
  par_key: string;
  target_qty: number;
  safety_stock: number;
  created_at?: string;
  updated_at?: string;
}

export interface ReorderSuggestion {
  par_key: string;
  label: string;
  kind: 'fg' | 'rm';
  target_qty: number;
  safety_stock: number;
  on_hand_available: number;
  suggested_qty: number;
}

export function parseParKey(parKey: string): { kind: 'fg' | 'rm'; idOrBatch: string } {
  if (parKey.startsWith('rm:')) return { kind: 'rm', idOrBatch: parKey.slice(3) };
  return { kind: 'fg', idOrBatch: parKey };
}

export async function listOutletPar(outletId: string): Promise<OutletParRow[]> {
  const { data, error } = await supabase
    .from('outlet_par')
    .select('*')
    .eq('outlet_id', outletId)
    .order('par_key');
  if (error) throw error;
  return (data ?? []) as OutletParRow[];
}

export async function upsertOutletPar(row: {
  outlet_id: string;
  par_key: string;
  target_qty: number;
  safety_stock: number;
  id?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const payload = {
    ...(row.id ? { id: row.id } : {}),
    outlet_id: row.outlet_id,
    par_key: row.par_key.trim(),
    target_qty: row.target_qty,
    safety_stock: row.safety_stock,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('outlet_par').upsert(payload);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteOutletPar(id: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('outlet_par').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function suggestReorder(outletId: string): Promise<ReorderSuggestion[]> {
  const pars = await listOutletPar(outletId);
  const { data: inv } = await supabase
    .from('outlet_inventory')
    .select(
      'product_batch, raw_material_id, quantity_on_hand, reserved_quantity, available_quantity, raw_materials(name), lot:inventory_lots(product_batch_label, production_run:production_run_id(recipe:recipe_id(default_product_batch)))'
    )
    .eq('outlet_id', outletId);

  const availByKey = new Map<string, number>();
  const labelByKey = new Map<string, string>();

  for (const row of inv ?? []) {
    const r = row as {
      product_batch?: string | null;
      raw_material_id?: string | null;
      quantity_on_hand?: number;
      reserved_quantity?: number;
      available_quantity?: number | null;
      raw_materials?: { name?: string } | null;
      lot?: unknown;
    };
    const avail = outletRowAvailableQuantity(
      Number(r.quantity_on_hand ?? 0),
      Number(r.reserved_quantity ?? 0),
      r.available_quantity
    );
    if (r.raw_material_id) {
      const k = `rm:${r.raw_material_id}`;
      availByKey.set(k, (availByKey.get(k) ?? 0) + avail);
      labelByKey.set(k, r.raw_materials?.name ?? k);
    } else {
      const batch = (r.product_batch ?? '').trim();
      const recipeSku = nestedRecipeSku(r.lot);
      const keys = new Set<string>();
      if (recipeSku) keys.add(recipeSku);
      if (batch && !isLegacyBatchCode(batch)) keys.add(batch);
      for (const k of keys) {
        availByKey.set(k, (availByKey.get(k) ?? 0) + avail);
        labelByKey.set(k, k);
      }
    }
  }

  const out: ReorderSuggestion[] = [];
  for (const p of pars) {
    const parsed = parseParKey(p.par_key);
    const key = parsed.kind === 'rm' ? `rm:${parsed.idOrBatch}` : parsed.idOrBatch;
    const onHand = availByKey.get(key) ?? availByKey.get(p.par_key) ?? 0;
    const need = Math.max(0, Number(p.target_qty) + Number(p.safety_stock) - onHand);
    out.push({
      par_key: p.par_key,
      label: labelByKey.get(key) ?? p.par_key,
      kind: parsed.kind,
      target_qty: Number(p.target_qty),
      safety_stock: Number(p.safety_stock),
      on_hand_available: onHand,
      suggested_qty: need,
    });
  }
  return out.sort((a, b) => b.suggested_qty - a.suggested_qty);
}
