import { describe, expect, it } from 'vitest';
import {
  ancestorIds,
  attachAliases,
  aggregateLotLocations,
  collectAliasesByLotId,
  lotMatchesQuery,
  lotsMatchingQuery,
  remainingOnHand,
  resolveUniqueLotId,
  treeKeepIds,
  childrenByParent,
  type TraceLot,
} from './lotTrace';

function lot(partial: Partial<TraceLot> & Pick<TraceLot, 'id' | 'product_batch_label'>): TraceLot {
  return {
    expiry_date: null,
    manufactured_at: null,
    parent_lot_id: null,
    purchase_order_item_id: null,
    production_run_id: null,
    recipeSku: null,
    runNumber: null,
    aliases: [],
    ...partial,
  };
}

describe('lot search', () => {
  const lots: TraceLot[] = [
    lot({
      id: 'fg-1',
      product_batch_label: 'QUACKTEOW-260414-0007',
      recipeSku: 'KT',
      aliases: ['BATCH-1b5aaf29'],
      parent_lot_id: 'rm-1',
    }),
    lot({
      id: 'fg-2',
      product_batch_label: 'QUACKTEOW-260501-0008',
      recipeSku: 'KT',
    }),
    lot({ id: 'rm-1', product_batch_label: 'FLOUR-PO-12' }),
  ];

  it('matches ink lot, leftover BATCH alias, and recipe SKU', () => {
    expect(lotMatchesQuery(lots[0], '260414')).toBe(true);
    expect(lotMatchesQuery(lots[0], 'BATCH-1b5aaf29')).toBe(true);
    expect(lotMatchesQuery(lots[0], 'kt')).toBe(true);
    expect(lotMatchesQuery(lots[0], 'nope')).toBe(false);
  });

  it('auto-selects an exact lot label or unique BATCH alias', () => {
    expect(resolveUniqueLotId(lots, 'QUACKTEOW-260414-0007')).toBe('fg-1');
    expect(resolveUniqueLotId(lots, 'BATCH-1b5aaf29')).toBe('fg-1');
  });

  it('does not auto-select a recipe SKU that maps to several lots', () => {
    expect(resolveUniqueLotId(lots, 'KT')).toBe(null);
    expect(lotsMatchingQuery(lots, 'KT').map((l) => l.id)).toEqual(['fg-1', 'fg-2']);
  });

  it('auto-selects a partial when only one lot matches', () => {
    expect(resolveUniqueLotId(lots, '0008')).toBe('fg-2');
  });
});

describe('aliases from inventory', () => {
  it('collects distinct product_batch values per lot_id', () => {
    const aliases = collectAliasesByLotId([
      { lot_id: 'fg-1', product_batch: 'BATCH-aa' },
      { lot_id: 'fg-1', product_batch: 'BATCH-aa' },
      { lot_id: 'fg-1', product_batch: 'KT' },
      { lot_id: null, product_batch: 'orphan' },
    ]);
    expect(aliases.get('fg-1')).toEqual(['BATCH-aa', 'KT']);
    const attached = attachAliases([lot({ id: 'fg-1', product_batch_label: 'KT-260414-0007' })], aliases);
    expect(attached[0].aliases).toEqual(['BATCH-aa', 'KT']);
  });
});

describe('tree keep set', () => {
  it('keeps ancestors and descendants of matches', () => {
    const lots: TraceLot[] = [
      lot({ id: 'root', product_batch_label: 'RM' }),
      lot({ id: 'mid', product_batch_label: 'FG-A', parent_lot_id: 'root' }),
      lot({ id: 'leaf', product_batch_label: 'FG-B', parent_lot_id: 'mid' }),
    ];
    const children = childrenByParent(lots);
    expect(ancestorIds('leaf', lots)).toEqual(['mid', 'root']);
    const keep = treeKeepIds(lots, new Set(['mid']), children);
    expect([...keep].sort()).toEqual(['leaf', 'mid', 'root']);
  });
});

describe('location balances', () => {
  it('sums hub and groups outlets, keeping reserved lots with on-hand', () => {
    const map = aggregateLotLocations(
      [
        { lot_id: 'fg-1', quantity_on_hand: 10, reserved_quantity: 4, available_quantity: 6 },
        { lot_id: 'fg-1', quantity_on_hand: 2, reserved_quantity: 2, available_quantity: 0 },
      ],
      [
        {
          lot_id: 'fg-1',
          outlet_id: 'o2',
          outlet_name: 'Beta',
          quantity_on_hand: 0,
          reserved_quantity: 0,
          available_quantity: 0,
        },
        {
          lot_id: 'fg-1',
          outlet_id: 'o1',
          outlet_name: 'Alpha',
          quantity_on_hand: 5,
          reserved_quantity: 1,
          available_quantity: 4,
        },
      ]
    );
    const rows = map.get('fg-1') ?? [];
    expect(rows.map((r) => r.name)).toEqual(['Hub', 'Alpha', 'Beta']);
    expect(rows[0]).toMatchObject({ onHand: 12, reserved: 6, available: 6 });
    expect(rows[1]).toMatchObject({ name: 'Alpha', onHand: 5, available: 4 });
    expect(remainingOnHand(rows)).toBe(17);
  });
});
