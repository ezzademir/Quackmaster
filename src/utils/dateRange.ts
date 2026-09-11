export interface DateRange {
  start: Date;
  end: Date;
}

/** Calendar date in Malaysia time — matches Distribution / POS business days. */
export function malaysiaCalendarDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Parse YYYY-MM-DD as local calendar noon (avoids UTC midnight drift). */
export function parseIsoDateLocal(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function rangeFromIso(fromIso: string, toIso: string): DateRange {
  const start = parseIsoDateLocal(fromIso);
  start.setHours(0, 0, 0, 0);
  const end = parseIsoDateLocal(toIso);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/** Monday (ISO) of the Malaysia calendar week containing isoDate. */
export function mondayOfIso(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 Sun
  const back = dow === 0 ? 6 : dow - 1;
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function lastDayOfMonthIso(yearMonth: string): string {
  const [y, m] = yearMonth.slice(0, 7).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last of m
  return dt.toISOString().slice(0, 10);
}

export function getToday(): DateRange {
  const iso = malaysiaCalendarDate();
  return rangeFromIso(iso, iso);
}

export function getYesterday(): DateRange {
  const iso = addDaysIso(malaysiaCalendarDate(), -1);
  return rangeFromIso(iso, iso);
}

/** This week Mon–today (Malaysia calendar, ISO week). */
export function getThisWeek(): DateRange {
  const today = malaysiaCalendarDate();
  return rangeFromIso(mondayOfIso(today), today);
}

/** Previous full ISO week Mon–Sun (Malaysia calendar). */
export function getLastWeek(): DateRange {
  const today = malaysiaCalendarDate();
  const thisMon = mondayOfIso(today);
  const lastMon = addDaysIso(thisMon, -7);
  const lastSun = addDaysIso(thisMon, -1);
  return rangeFromIso(lastMon, lastSun);
}

/** Last 7 Malaysia calendar days including today. */
export function getLast7Days(): DateRange {
  const to = malaysiaCalendarDate();
  const from = addDaysIso(to, -6);
  return rangeFromIso(from, to);
}

export function getThisMonth(): DateRange {
  const today = malaysiaCalendarDate();
  const from = `${today.slice(0, 7)}-01`;
  return rangeFromIso(from, today);
}

export function getLastMonth(): DateRange {
  const today = malaysiaCalendarDate();
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return rangeFromIso(`${prev}-01`, lastDayOfMonthIso(prev));
}

export function isDateInRange(date: Date | string, range: DateRange): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d >= range.start && d <= range.end;
}

/** Calendar `date` / ISO date string compared at local noon to avoid UTC midnight drift */
function calendarDateAtNoon(value: string | undefined | null): string {
  if (value == null || value === '') return '';
  const t = String(value).trim();
  return t.includes('T') ? t : `${t}T12:00:00`;
}

export function isCalendarDateInRange(value: string | undefined | null, range: DateRange): boolean {
  const d = calendarDateAtNoon(value);
  if (!d) return false;
  return isDateInRange(d, range);
}

export function formatDateForInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse a sales_over_time / sales_by_* period bucket key into a day range.
 * Returns null for hour buckets or unrecognised keys.
 */
export function rangeFromPeriodBucket(
  key: string,
  viewBy: 'day' | 'week' | 'month' | 'hour' | string | undefined
): DateRange | null {
  // sales_by_* keys are "period · dim"
  const period = key.includes(' · ') ? key.slice(0, key.indexOf(' · ')) : key;
  if (viewBy === 'hour' || /\d{4}-\d{2}-\d{2} \d{2}:00/.test(period)) return null;

  const weekMatch = /^Week of (\d{4}-\d{2}-\d{2})$/.exec(period);
  if (weekMatch || viewBy === 'week') {
    const monday = weekMatch?.[1] ?? (period.startsWith('Week of ') ? period.slice(8, 18) : '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) return null;
    return rangeFromIso(monday, addDaysIso(monday, 6));
  }

  if (/^\d{4}-\d{2}$/.test(period) || viewBy === 'month') {
    const ym = period.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return null;
    return rangeFromIso(`${ym}-01`, lastDayOfMonthIso(ym));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    return rangeFromIso(period, period);
  }

  return null;
}
