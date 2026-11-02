import { describe, expect, it } from 'vitest';
import { countDeactivated, filterByActive, isUserActive } from './userActive';

const rows = [{ id: 'a', is_active: true }, { id: 'b', is_active: false }, { id: 'c' }, { id: 'd', is_active: null }];
describe('userActive', () => {
  it('missing/null flag = active', () => {
    expect(rows.map(isUserActive)).toEqual([true, false, true, true]);
  });
  it('hides deactivated by default; toggle shows all', () => {
    expect(filterByActive(rows, false).map((r) => r.id)).toEqual(['a', 'c', 'd']);
    expect(filterByActive(rows, true)).toHaveLength(4);
    expect(countDeactivated(rows)).toBe(1);
  });
});
