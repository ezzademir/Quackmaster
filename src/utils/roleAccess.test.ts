import { describe, expect, it } from 'vitest';
import { homePathForRole, isPathAllowedForRole, navForRole, PROCUREMENT_NAV } from './roleAccess';

describe('roleAccess', () => {
  it('procurement gets the cut-down nav only', () => {
    expect(navForRole('procurement')?.map((n) => n.label)).toEqual(['Purchase orders', 'Receiving', 'Bills', 'Suppliers']);
    expect(navForRole(' Procurement ')).toBe(PROCUREMENT_NAV);
    expect(homePathForRole('procurement')).toBe('/procurement');
  });

  it('procurement cannot reach costing, sales, stock, POS compare or users', () => {
    for (const p of ['/', '/sales', '/pos-compare', '/inventory', '/stock-take', '/production', '/users', '/ledger', '/settings', '/genealogy', '/audit', '/reconciliation', '/waste', '/distribution', '/costing']) {
      expect(isPathAllowedForRole('procurement', p), p).toBe(false);
    }
    for (const p of ['/procurement', '/procurement/x', '/receiving', '/bills', '/suppliers', '/required-password-reset']) {
      expect(isPathAllowedForRole('procurement', p), p).toBe(true);
    }
    expect(isPathAllowedForRole('procurement', '/procurementx')).toBe(false);
  });

  it('supervisor behaviour unchanged; admin/staff unrestricted', () => {
    expect(isPathAllowedForRole('supervisor', '/sales')).toBe(true);
    expect(isPathAllowedForRole('supervisor', '/procurement')).toBe(false);
    expect(homePathForRole('supervisor')).toBe('/stock-take');
    expect(navForRole('admin')).toBeNull();
    expect(navForRole('staff')).toBeNull();
    expect(isPathAllowedForRole('staff', '/bills')).toBe(true);
  });
});
