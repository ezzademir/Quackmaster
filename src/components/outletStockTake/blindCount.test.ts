import { describe, expect, it } from 'vitest';
import { parseCount, sheetToCountRows } from './blindCount';
import TAB from './OutletStockTakeTab.tsx?raw';
import SERVICE from '../../utils/outletStockTakeService.ts?raw';
import SALES from '../../pages/Sales.tsx?raw';
import WASTE from '../../pages/Waste.tsx?raw';

const sheet = [
  {
    outlet_inventory_id: 'rm-1', raw_material_id: 'rm', product_batch: null, lot_id: null, lot_label: null,
    recipe_sku: null, expiry_date: null, run_number: null, item_name: 'Flour', unit_of_measure: 'kg',
  },
  {
    outlet_inventory_id: 'fg-1', raw_material_id: null, product_batch: 'KT', lot_id: 'l1', lot_label: 'KT-261018-0112',
    recipe_sku: 'KT', expiry_date: '2026-10-25', run_number: 'RUN-0112', item_name: null, unit_of_measure: null,
  },
];

describe('blind count sheet (client)', () => {
  it('rows are never pre-filled and carry no system quantity / variance', () => {
    const rows = sheetToCountRows(sheet);
    expect(rows.map((r) => r.id)).toEqual(['fg-1', 'rm-1']); // finished goods first
    expect(rows.every((r) => r.countedStr === '')).toBe(true);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['countedStr', 'expiry_date', 'id', 'isIngredient', 'item_detail', 'item_label', 'remark']);
    }
    expect(rows[0].item_detail).toContain('Run RUN-0112');
    expect(rows[1].item_label).toBe('Flour · kg');
  });

  it('a blank count is not a zero: every line must be entered explicitly', () => {
    expect(parseCount('')).toBeNull();
    expect(parseCount('  ')).toBeNull();
    expect(parseCount('0')).toBe(0);
    expect(parseCount('-1')).toBeNull();
    expect(parseCount('3.5')).toBe(3.5);
  });

  it('the stock take screen loads its lines only from the blind-count RPCs, never from outlet_inventory', () => {
    expect(TAB).not.toMatch(/from\('outlet_inventory'\)/);
    expect(TAB).not.toMatch(/fetchOutletInventoryRowsForStockTake|quantity_on_hand|reserved_quantity|available_quantity/);
    expect(TAB).not.toMatch(/countedStr:\s*String\(/); // no pre-fill from system qty
    expect(TAB).toMatch(/startBlindStockTake/);
    expect(SERVICE).toMatch(/'start_outlet_stock_take'/);
    expect(SERVICE).toMatch(/'submit_outlet_stock_take'/);
  });

  it('variance is only rendered from the admin-only submit result', () => {
    expect(TAB).toMatch(/if \(res\.lines && isAdmin\)/);
    expect(TAB).toMatch(/isAdmin && posted \?/); // CSV (with variance) only for admins
  });

  it('Sales and Waste fall back to the identity-only batch RPC while a count hides outlet stock', () => {
    expect(SERVICE).toMatch(/'get_outlet_sale_batches'/);
    for (const src of [SALES, WASTE]) expect(src).toMatch(/getOutletSaleBatches\(/);
    expect(SALES).toMatch(/quantity_on_hand: null/); // no available qty shown during a count
  });

  it('the count screen tells staff to post sales before opening a count', () => {
    expect(TAB).toContain('Post all sales up to the count start time before opening a count.');
  });
});
