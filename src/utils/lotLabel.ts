/** Mirrors public.format_fg_lot_label / fg_identifier_matches and the lot-first UI rule. */

export function isLegacyBatchCode(value: string | null | undefined): boolean {
  return /^BATCH-[0-9a-f-]+$/i.test((value ?? '').trim());
}

/** Postgres: p_sku || '-' || to_char(mfg, 'YYMMDD') || '-' || lpad(trailing digits, 4, '0') */
export function formatFgLotLabel(sku: string, mfg: Date | string, runNumber: string): string {
  const yymmdd = toYymmdd(mfg);
  const digits = (runNumber.match(/(\d+)$/) ?? [])[1];
  const run = digits ? digits.padStart(4, '0') : '0000';
  return `${sku}-${yymmdd}-${run}`;
}

function toYymmdd(mfg: Date | string): string {
  if (typeof mfg === 'string' && /^\d{4}-\d{2}-\d{2}/.test(mfg)) {
    const [y, m, d] = mfg.slice(0, 10).split('-');
    return `${y.slice(-2)}${m}${d}`;
  }
  const d = typeof mfg === 'string' ? new Date(mfg) : mfg;
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/** Postgres: trim(query) equals trim(product_batch) OR trim(lot_label) OR trim(recipe_sku). */
export function fgIdentifierMatches(
  productBatch: string | null | undefined,
  lotLabel: string | null | undefined,
  query: string | null | undefined,
  recipeSku?: string | null
): boolean {
  const q = (query ?? '').trim();
  if (q === '') return false;
  return (
    (productBatch ?? '').trim() === q ||
    (lotLabel ?? '').trim() === q ||
    (recipeSku ?? '').trim() === q
  );
}

type NestedRecipe = { default_product_batch?: string | null };
type NestedRun = {
  recipe?: NestedRecipe | NestedRecipe[] | null;
  recipes?: NestedRecipe | NestedRecipe[] | null;
};
type NestedLot = {
  product_batch_label?: string | null;
  production_run?: NestedRun | NestedRun[] | null;
  production_runs?: NestedRun | NestedRun[] | null;
};

export function nestedLotLabel(
  lot: NestedLot | NestedLot[] | null | undefined
): string | null {
  if (lot == null) return null;
  const obj = Array.isArray(lot) ? lot[0] : lot;
  const label = obj?.product_batch_label != null ? String(obj.product_batch_label).trim() : '';
  return label || null;
}

/** Recipe default_product_batch via lot → production_run → recipe (PostgREST embed). */
export function nestedRecipeSku(lot: unknown): string | null {
  if (lot == null) return null;
  const obj = (Array.isArray(lot) ? lot[0] : lot) as NestedLot | undefined;
  if (!obj) return null;
  const runRaw = obj.production_run ?? obj.production_runs;
  const run = Array.isArray(runRaw) ? runRaw[0] : runRaw;
  const recRaw = run?.recipe ?? run?.recipes;
  const rec = Array.isArray(recRaw) ? recRaw[0] : recRaw;
  const sku = rec?.default_product_batch != null ? String(rec.default_product_batch).trim() : '';
  return sku || null;
}
export function displayLotFirst(
  lotLabel: string | null | undefined,
  productBatch: string | null | undefined
): string {
  const lot = (lotLabel ?? '').trim();
  if (lot) return lot;
  return (productBatch ?? '').trim();
}

/** Never a BATCH- code. Prefers recipe SKU, then a non-legacy product_batch. */
export function skuForDisplay(
  lotLabel: string | null | undefined,
  productBatch: string | null | undefined,
  recipeSku?: string | null
): string | null {
  const sku = (recipeSku ?? '').trim() || (productBatch ?? '').trim();
  if (!sku || isLegacyBatchCode(sku)) return null;
  const lot = (lotLabel ?? '').trim();
  if (lot && sku === lot) return null;
  return sku;
}

/** SKU shown second when a distinct lot is already shown. */
export function displaySkuSecond(
  lotLabel: string | null | undefined,
  productBatch: string | null | undefined,
  recipeSku?: string | null
): string | null {
  const lot = (lotLabel ?? '').trim();
  if (!lot) return null;
  return skuForDisplay(lotLabel, productBatch, recipeSku);
}

export function formatLotWithSku(
  lotLabel: string | null | undefined,
  productBatch: string | null | undefined,
  recipeSku?: string | null
): string {
  const primary = displayLotFirst(lotLabel, productBatch);
  const sku = skuForDisplay(lotLabel, productBatch, recipeSku);
  if (!primary) return sku || '—';
  if (sku && sku !== primary) return `${primary} · ${sku}`;
  return primary;
}

export function voidConfirmMatches(
  typed: string,
  runNumber: string,
  lotCode?: string | null
): boolean {
  const t = typed.trim().toUpperCase();
  if (!t) return false;
  if (t === runNumber.trim().toUpperCase()) return true;
  const lot = (lotCode ?? '').trim();
  return lot !== '' && t === lot.toUpperCase();
}

/** Draft/cancelled delete may drop this run's hub FG only if it never left the hub. */
export function draftRunFgCanBeRemoved(flags: {
  reservedQty: number;
  outletQty: number;
}): boolean {
  return flags.reservedQty <= 0 && flags.outletQty <= 0;
}

export type VoidBlockReason = 'reserved' | 'outlet_stock' | 'supply_order' | 'sales' | 'waste';

/** Mirrors admin_void_production_run guards: blocked once the lot left the hub. */
export function voidBlockedIfSupplied(flags: {
  reservedQty: number;
  outletQty: number;
  supplyLineCount: number;
  salesLineCount: number;
  wasteLineCount: number;
}): VoidBlockReason | null {
  if (flags.reservedQty > 0) return 'reserved';
  if (flags.outletQty > 0) return 'outlet_stock';
  if (flags.supplyLineCount > 0) return 'supply_order';
  if (flags.salesLineCount > 0) return 'sales';
  if (flags.wasteLineCount > 0) return 'waste';
  return null;
}
