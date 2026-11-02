import { describe, expect, it } from 'vitest';
import {
  costingStats,
  emptyCostingCopy,
  entityChoices,
  entityCodeForProcurementTag,
  filterCostingRows,
  formatPct,
  formatRm,
  mergeDishCogs,
  sortDrift,
  type DishCogsRow,
  type DriftRow,
  type RecipeCostRow,
} from './costingDisplay';

const dish = (overrides: Partial<RecipeCostRow> = {}): RecipeCostRow => ({
  kind: 'dish',
  id: 'd1',
  entity_code: 'QT',
  name: 'Nasi Ayam',
  status: 'active',
  source_sheet: 'P- Nasi Ayam',
  selling_price_ex_sst_rm: '12.0000',
  line_count: 4,
  incomplete_lines: 0,
  cost_complete: true,
  food_cost_rm: '0.7249',
  known_cost_rm: '0.7249',
  ...overrides,
});

describe('costingDisplay', () => {
  it('formats money and leaves unknown costs blank', () => {
    expect(formatRm('0.7249', 4)).toBe('RM 0.7249');
    expect(formatRm(null)).toBe('—');
    expect(formatRm('')).toBe('—');
    expect(formatPct('20.5')).toBe('20.50%');
    expect(formatPct(null)).toBe('—');
  });

  it('maps procurement tags onto cost books and keeps an unknown tag as itself', () => {
    expect(entityCodeForProcurementTag('quackteow')).toBe('QT');
    expect(entityCodeForProcurementTag('merdeka_house')).toBe('MH');
    expect(entityCodeForProcurementTag('new_brand')).toBe('new_brand');
  });

  it('merges dine-in and takeaway COGS onto dishes and leaves a missing match blank', () => {
    const cogs: DishCogsRow[] = [
      { menu_item_id: 'd1', cogs_dine_in_pct: '20.00', cogs_takeaway_pct: '25.00', food_cost_pct: '18.00' },
    ];
    const rows = mergeDishCogs(
      [dish(), dish({ id: 'd2', kind: 'dish', name: 'Incomplete', cost_complete: false, food_cost_rm: null }), { ...dish(), id: 's1', kind: 'sub-recipe' }],
      cogs,
    );
    expect(rows.map((row) => row.name)).toEqual(['Nasi Ayam', 'Incomplete']);
    expect(rows[0].cogs_dine_in_pct).toBe('20.00');
    expect(rows[1].cogs_takeaway_pct).toBeNull();
    expect(rows[1].food_cost_rm).toBeNull();
  });

  it('filters by entity and name', () => {
    const rows = [dish(), dish({ id: 'd2', entity_code: 'MH', name: 'Laksa' })];
    expect(filterCostingRows(rows, 'MH', 'lak', (row) => row.entity_code, (row) => row.name)).toEqual([rows[1]]);
    expect(filterCostingRows(rows, 'all', '', (row) => row.entity_code, (row) => row.name)).toHaveLength(2);
  });

  it('offers the two cost books plus any extra code already on a row', () => {
    expect(entityChoices(['QT', 'MH', 'XX', null]).map((choice) => choice.value)).toEqual(['all', 'QT', 'MH', 'XX']);
  });

  it('sorts drift by the largest percentage move and counts only non-zero moves', () => {
    const drift: DriftRow[] = [
      {
        bom_line_id: 'a',
        entity_code: 'QT',
        parent_name: 'Nasi',
        parent_kind: 'dish',
        component_name: 'Rice',
        supplier_item: 'Beras',
        snapshot_cost_rm: '1',
        current_cost_rm: '1.02',
        drift_rm: '0.02',
        drift_pct: '2.00',
      },
      {
        bom_line_id: 'b',
        entity_code: 'QT',
        parent_name: 'Nasi',
        parent_kind: 'dish',
        component_name: 'Chicken',
        supplier_item: 'Ayam',
        snapshot_cost_rm: '1',
        current_cost_rm: '1.20',
        drift_rm: '0.20',
        drift_pct: '-12.00',
      },
      {
        bom_line_id: 'c',
        entity_code: 'MH',
        parent_name: 'Laksa',
        parent_kind: 'dish',
        component_name: 'Salt',
        supplier_item: 'Garam',
        snapshot_cost_rm: '1',
        current_cost_rm: '1',
        drift_rm: '0',
        drift_pct: '0',
      },
    ];
    expect(sortDrift(drift).map((row) => row.bom_line_id)).toEqual(['b', 'a', 'c']);
    expect(costingStats(mergeDishCogs([dish({ cost_complete: false })], []), drift, [])).toMatchObject({
      incomplete: 1,
      drift: 2,
      flags: 0,
    });
  });

  it('explains an empty catalogue and a filter that hides every row', () => {
    expect(emptyCostingCopy('dishes', 0, 0)?.title).toBe('No recipes loaded');
    expect(emptyCostingCopy('flags', 0, 0)?.title).toBe('No open price flags');
    expect(emptyCostingCopy('dishes', 3, 0)?.title).toBe('Nothing matches');
    expect(emptyCostingCopy('drift', 2, 1)).toBeNull();
  });
});
