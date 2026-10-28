import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatDateForInput, getLastMonth, getLastWeek, getThisMonth, getToday, getYesterday,
  isCalendarDateInRange, isDateInRange, mytRangeFromIso, rangeFromPeriodBucket,
} from './dateRange';

// Runs under any TZ (CI matrix: UTC, America/Los_Angeles, Asia/Kuala_Lumpur).
afterEach(() => vi.useRealTimers());
const at = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

describe(`MYT bounds independent of device TZ (device TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone})`, () => {
  it('mytRangeFromIso = 16:00Z prev day .. 15:59:59.999Z', () => {
    const r = mytRangeFromIso('2026-10-07', '2026-10-07');
    expect(r.start.toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-07T15:59:59.999Z');
  });
  it('00:30 MYT is "today"; 23:59:59 MYT yesterday is not', () => {
    at('2026-10-06T16:30:00Z'); // 7 Oct 00:30 MYT
    const t = getToday();
    expect(formatDateForInput(t.start)).toBe('2026-10-07');
    expect(isDateInRange(new Date('2026-10-07T00:30:00+08:00'), t)).toBe(true);
    expect(isDateInRange(new Date('2026-10-06T23:59:59+08:00'), t)).toBe(false);
    expect(isDateInRange(new Date('2026-10-06T23:59:59+08:00'), getYesterday())).toBe(true);
  });
  it('week / month boundaries', () => {
    at('2026-10-04T15:00:00Z'); // Sun 4 Oct 23:00 MYT
    const lw = getLastWeek();
    expect([formatDateForInput(lw.start), formatDateForInput(lw.end)]).toEqual(['2026-09-21', '2026-09-27']);
    at('2026-09-30T16:10:00Z'); // 1 Oct 00:10 MYT
    expect(formatDateForInput(getThisMonth().start)).toBe('2026-10-01');
    const lm = getLastMonth();
    expect([formatDateForInput(lm.start), formatDateForInput(lm.end)]).toEqual(['2026-09-01', '2026-09-30']);
  });
  it('calendar date strings and period buckets', () => {
    const r = mytRangeFromIso('2026-09-28', '2026-10-04');
    expect(isCalendarDateInRange('2026-09-28', r)).toBe(true);
    expect(isCalendarDateInRange('2026-10-04', r)).toBe(true);
    expect(isCalendarDateInRange('2026-10-05', r)).toBe(false);
    expect(isCalendarDateInRange('2026-09-27', r)).toBe(false);
    const w = rangeFromPeriodBucket('Week of 2026-09-28', 'week')!;
    expect(w.start.toISOString()).toBe('2026-09-27T16:00:00.000Z');
  });
  it('formatDateForInput renders the MYT day', () => {
    expect(formatDateForInput(new Date('2026-10-06T16:00:00Z'))).toBe('2026-10-07');
    expect(formatDateForInput(new Date('2026-10-06T15:59:59Z'))).toBe('2026-10-06');
  });
});
