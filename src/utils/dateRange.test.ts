import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  getLastWeek,
  getThisWeek,
  lastDayOfMonthIso,
  mondayOfIso,
  rangeFromPeriodBucket,
  formatDateForInput,
} from './dateRange';

describe('mondayOfIso', () => {
  it('returns Monday for mid-week and Sunday', () => {
    expect(mondayOfIso('2026-09-09')).toBe('2026-09-07'); // Tue
    expect(mondayOfIso('2026-09-07')).toBe('2026-09-07'); // Mon
    expect(mondayOfIso('2026-09-13')).toBe('2026-09-07'); // Sun
  });
});

describe('ISO week helpers used by PosCompare', () => {
  it('lastDayOfMonthIso', () => {
    expect(lastDayOfMonthIso('2026-09')).toBe('2026-09-30');
    expect(lastDayOfMonthIso('2026-02')).toBe('2026-02-28');
  });

  it('addDaysIso', () => {
    expect(addDaysIso('2026-09-07', 6)).toBe('2026-09-13');
  });

  it('getThisWeek / getLastWeek are Mon-based', () => {
    const thisWeek = getThisWeek();
    const lastWeek = getLastWeek();
    const thisStart = formatDateForInput(thisWeek.start);
    const lastStart = formatDateForInput(lastWeek.start);
    const lastEnd = formatDateForInput(lastWeek.end);
    expect(mondayOfIso(thisStart)).toBe(thisStart);
    expect(mondayOfIso(lastStart)).toBe(lastStart);
    expect(addDaysIso(lastStart, 6)).toBe(lastEnd);
  });
});

describe('rangeFromPeriodBucket', () => {
  it('parses week buckets', () => {
    const r = rangeFromPeriodBucket('Week of 2026-09-07', 'week');
    expect(r).not.toBeNull();
    expect(formatDateForInput(r!.start)).toBe('2026-09-07');
    expect(formatDateForInput(r!.end)).toBe('2026-09-13');
  });

  it('parses month buckets', () => {
    const r = rangeFromPeriodBucket('2026-09', 'month');
    expect(formatDateForInput(r!.start)).toBe('2026-09-01');
    expect(formatDateForInput(r!.end)).toBe('2026-09-30');
  });

  it('parses day and sales_by composite keys', () => {
    const day = rangeFromPeriodBucket('2026-09-10', 'day');
    expect(formatDateForInput(day!.start)).toBe('2026-09-10');
    const skuWeek = rangeFromPeriodBucket('Week of 2026-09-07 · QUACKTEOW', 'week');
    expect(formatDateForInput(skuWeek!.start)).toBe('2026-09-07');
    expect(formatDateForInput(skuWeek!.end)).toBe('2026-09-13');
  });

  it('rejects hour buckets', () => {
    expect(rangeFromPeriodBucket('2026-09-10 14:00', 'hour')).toBeNull();
  });
});
