import { describe, expect, it } from 'vitest';
import { defaultEntityCode, normalizeUom, poSelectableSuppliers, purchaseOrderInsertPayload, supplierInsertPayload } from './procurementPayloads';

describe('procurement UI payloads match the 085 rules', () => {
  it('suppliers created by procurement are pending; admin creates are left to the DB default (active)', () => {
    expect(supplierInsertPayload({ name: 'X' }, true)).toEqual({ name: 'X', status: 'pending' });
    expect(supplierInsertPayload({ name: 'X' }, false)).toEqual({ name: 'X' });
  });

  it('a PO insert always carries entity_code and starts as draft', () => {
    expect(purchaseOrderInsertPayload({ order_number: 'PO-1', supplier_id: 's' }, 'QT'))
      .toEqual({ order_number: 'PO-1', supplier_id: 's', entity_code: 'QT', status: 'draft' });
  });

  it('PO supplier picker hides non-active suppliers but keeps the one already on the PO', () => {
    const sup = [{ id: 'a', status: 'active' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'inactive' }, { id: 'd' }];
    expect(poSelectableSuppliers(sup).map((s) => s.id)).toEqual(['a', 'd']);
    expect(poSelectableSuppliers(sup, 'b').map((s) => s.id)).toEqual(['a', 'b', 'd']);
  });

  it('entity preselects only when unambiguous', () => {
    const one = [{ code: 'QT', name: 'Quackteow', procurement_tag: 'quackteow' }];
    const two = [...one, { code: 'MH', name: 'Merdeka House', procurement_tag: 'merdeka_house' }];
    expect(defaultEntityCode(one)).toBe('QT');
    expect(defaultEntityCode(two)).toBe('');
    expect(defaultEntityCode(two, 'MH')).toBe('MH');
    expect(defaultEntityCode(one, 'MH')).toBe('QT');
  });

  it('normalizeUom maps to the receipt CHECK list, first usable candidate wins, else unit', () => {
    expect(normalizeUom('KG')).toBe('kg');
    expect(normalizeUom(null, ' Litres ')).toBe('l');
    expect(normalizeUom('crate', 'pcs')).toBe('pc');
    expect(normalizeUom('crate')).toBe('unit');
    expect(normalizeUom(undefined, null)).toBe('unit');
  });
});
