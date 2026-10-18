import { describe, expect, it } from 'vitest';
import {
  hubRowAvailableQuantity,
  rawMaterialCoversConsumption,
  sumAvailableByRawMaterialId,
} from './hubInventoryMath';

describe('sumAvailableByRawMaterialId', () => {
  it('sums unreserved qty and ignores reserved stock', () => {
    const flour = 'rm-flour';
    const sugar = 'rm-sugar';
    const byId = sumAvailableByRawMaterialId([
      { raw_material_id: flour, quantity_on_hand: 10, reserved_quantity: 8, available_quantity: 2 },
      { raw_material_id: flour, quantity_on_hand: 4, reserved_quantity: 0, available_quantity: 4 },
      { raw_material_id: sugar, quantity_on_hand: 3, reserved_quantity: 1, available_quantity: 2 },
      { raw_material_id: null, quantity_on_hand: 99, reserved_quantity: 0, available_quantity: 99 },
    ]);
    expect(byId.get(flour)).toBe(6);
    expect(byId.get(sugar)).toBe(2);
    expect(byId.has('')).toBe(false);
  });

  it('falls back to on-hand minus reserved when available_quantity is missing', () => {
    const id = 'rm-1';
    const byId = sumAvailableByRawMaterialId([
      { raw_material_id: id, quantity_on_hand: 10, reserved_quantity: 8 },
    ]);
    expect(byId.get(id)).toBe(2);
    expect(hubRowAvailableQuantity(10, 8, null)).toBe(2);
  });
});

describe('rawMaterialCoversConsumption', () => {
  it('rejects consuming reserved-only leftover on-hand', () => {
    expect(rawMaterialCoversConsumption(2, 5)).toBe(false);
    expect(rawMaterialCoversConsumption(5, 5)).toBe(true);
    expect(rawMaterialCoversConsumption(10, 5)).toBe(true);
    expect(rawMaterialCoversConsumption(0, 0)).toBe(true);
    expect(rawMaterialCoversConsumption(2, -1)).toBe(false);
  });
});
