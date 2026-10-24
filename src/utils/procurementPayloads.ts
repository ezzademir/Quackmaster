/** Insert payload builders that line the UI up with the 085 RLS / trigger rules (pure, unit-tested). */

export interface MyEntity {
  code: string;
  name: string;
  procurement_tag: string;
}

/** Procurement users may only create suppliers as 'pending' (085 WITH CHECK); an admin approves them later. */
export function supplierInsertPayload<T extends object>(form: T, isProcurement: boolean): T & { status?: 'pending' } {
  return isProcurement ? { ...form, status: 'pending' } : { ...form };
}

/** 085: procurement_has_entity(NULL) is false, so every procurement PO insert needs an entity_code. */
export function purchaseOrderInsertPayload<T extends object>(header: T, entityCode: string): T & { entity_code: string; status: 'draft' } {
  return { ...header, entity_code: entityCode, status: 'draft' };
}

/** Only suppliers an admin has approved can go on a PO (085 _supplier_is_active); hide the rest from the picker. */
export function poSelectableSuppliers<T extends { id: string; status?: string | null }>(suppliers: T[], currentSupplierId?: string): T[] {
  return suppliers.filter((s) => (s.status ?? 'active') === 'active' || s.id === currentSupplierId);
}

/** Entity to preselect: the only one the user has, otherwise none (they must choose). */
export function defaultEntityCode(entities: MyEntity[], current?: string | null): string {
  if (current && entities.some((e) => e.code === current)) return current;
  return entities.length === 1 ? entities[0].code : current ?? '';
}

/** po_receipt_records.quantity_uom CHECK list (085). Anything else is stored as 'unit'. */
const UOM_ALIASES: Record<string, string> = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gm: 'g', gram: 'g', grams: 'g',
  l: 'l', lt: 'l', ltr: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc',
  pack: 'pack', packs: 'pack', pkt: 'pack', packet: 'pack', packets: 'pack',
  unit: 'unit', units: 'unit',
};

export function normalizeUom(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const k = String(c ?? '').trim().toLowerCase();
    if (k && UOM_ALIASES[k]) return UOM_ALIASES[k];
  }
  return 'unit';
}
