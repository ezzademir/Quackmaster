import type { BlindCountSheetLine } from '../../utils/outletStockTakeService';
import { displayLotFirst, displaySkuSecond } from '../../utils/lotLabel';

/** One row of the count sheet as shown to the counter. */
export type BlindCountRow = {
  id: string;
  isIngredient: boolean;
  item_label: string;
  item_detail: string;
  expiry_date: string | null;
  countedStr: string;
  remark: string;
};

export function parseCount(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Sheet lines -> empty count rows (never pre-filled). Finished goods first, server FEFO order kept. */
export function sheetToCountRows(lines: BlindCountSheetLine[]): BlindCountRow[] {
  const rows = lines.map((l) => {
    const isIngredient = !!l.raw_material_id;
    const lot = (l.lot_label ?? '').trim();
    const pb = (l.product_batch ?? '').trim();
    const item_label = isIngredient
      ? [l.item_name?.trim() || 'Ingredient', l.unit_of_measure?.trim()].filter(Boolean).join(' · ')
      : displayLotFirst(lot, pb) || 'Finished good';
    const sku = isIngredient ? '' : displaySkuSecond(lot, pb, l.recipe_sku);
    const item_detail = [sku ? `SKU: ${sku}` : '', l.run_number ? `Run ${l.run_number}` : ''].filter(Boolean).join(' · ');
    return {
      id: l.outlet_inventory_id,
      isIngredient,
      item_label,
      item_detail,
      expiry_date: l.expiry_date,
      countedStr: '',
      remark: '',
    } satisfies BlindCountRow;
  });
  return [...rows.filter((r) => !r.isIngredient), ...rows.filter((r) => r.isIngredient)];
}
