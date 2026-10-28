import { afterEach, describe, expect, it, vi } from 'vitest';
import { malaysiaCalendarDate } from './dateRange';
import PRODUCTION from '../pages/Production.tsx?raw';
import DISTRIBUTION from '../pages/Distribution.tsx?raw';
import STOCK_TAKE from '../components/outletStockTake/OutletStockTakeTab.tsx?raw';

/**
 * Production date, Distribution supply_date and stock take count_date must default to today in
 * Malaysia time. The old default `new Date().toISOString().split('T')[0]` is the UTC date, which
 * is yesterday for anything entered 00:00-08:00 MYT.
 */
const oldUtcDefault = () => new Date().toISOString().split('T')[0];

afterEach(() => {
  vi.useRealTimers();
});

describe('business-date defaults (00:00-08:00 MYT)', () => {
  const cases: Array<[string, string, string]> = [
    // [instant (UTC), expected MYT date, old UTC default]
    ['2026-10-18T16:00:00.000Z', '2026-10-19', '2026-10-18'], // 00:00 MYT
    ['2026-10-18T16:30:00.000Z', '2026-10-19', '2026-10-18'], // 00:30 MYT
    ['2026-10-18T23:59:59.999Z', '2026-10-19', '2026-10-18'], // 07:59:59 MYT
    ['2026-10-19T00:00:00.000Z', '2026-10-19', '2026-10-19'], // 08:00 MYT: both agree
    ['2026-10-18T15:59:59.999Z', '2026-10-18', '2026-10-18'], // 23:59:59 MYT previous day
    ['2026-12-31T16:30:00.000Z', '2027-01-01', '2026-12-31'], // year rollover at 00:30 MYT
  ];

  it.each(cases)('at %s the default is %s (old UTC default gave %s)', (instant, myt, utc) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    expect(malaysiaCalendarDate()).toBe(myt);
    expect(oldUtcDefault()).toBe(utc);
  });

  it.each([
    ['Production.tsx', PRODUCTION, 1],
    ['Distribution.tsx (FG + raw-material supply forms)', DISTRIBUTION, 2],
    ['OutletStockTakeTab.tsx', STOCK_TAKE, 1],
  ])('%s initialises its date state with malaysiaCalendarDate()', (_name, src, n) => {
    expect(src.match(/useState\(\(\) => malaysiaCalendarDate\(\)\)/g) ?? []).toHaveLength(n);
    expect(src).not.toMatch(/new Date\(\)\.toISOString\(\)\.(split\('T'\)\[0\]|slice\(0, 10\))/);
  });
});
