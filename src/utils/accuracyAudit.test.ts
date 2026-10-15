import { describe, it, expect } from 'vitest';
import { getToday, isDateInRange, mondayOfIso, lastDayOfMonthIso, addDaysIso, rangeFromPeriodBucket } from './dateRange';
import { hubRowAvailableQuantity, aggregateFinishedGoodsHubTotals } from './hubInventoryMath';

describe('MYT boundaries', () => {
  it('week/month helpers', () => {
    expect(mondayOfIso('2026-10-04')).toBe('2026-09-28'); // Sunday -> Monday
    expect(mondayOfIso('2026-09-28')).toBe('2026-09-28');
    expect(lastDayOfMonthIso('2028-02')).toBe('2028-02-29');
    expect(lastDayOfMonthIso('2026-12')).toBe('2026-12-31');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(rangeFromPeriodBucket('Week of 2026-09-28', 'week')).not.toBeNull();
  });
  it('timestamp at 00:30 MYT belongs to MYT today (fails if browser TZ != MYT)', () => {
    const r = getToday();
    const todayMyt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
    const ts = new Date(`${todayMyt}T00:30:00+08:00`);
    expect(isDateInRange(ts, r)).toBe(true);
  });
});
describe('hub math', () => {
  it('available clamps & sums', () => {
    expect(hubRowAvailableQuantity(10, 3, null)).toBe(7);
    expect(hubRowAvailableQuantity(2, 5, null)).toBe(0);
    expect(hubRowAvailableQuantity(10, 3, -1)).toBe(0);
    expect(aggregateFinishedGoodsHubTotals([{quantity_on_hand:5,reserved_quantity:6},{quantity_on_hand:4}])).toEqual({onHand:9,reserved:6,available:4});
  });
  it('float accumulation of currency (Procurement total)', () => {
    const total = [0.1,0.2].reduce((a,b)=>a+b,0);
    expect(total.toFixed(2)).toBe('0.30');
    expect(0.1+0.2).not.toBe(0.3); // raw float sum drifts; UI only rounds at display
  });
});
