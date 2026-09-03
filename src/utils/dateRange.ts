export interface DateRange {
  start: Date;
  end: Date;
}

export function getToday(): DateRange {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function getYesterday(): DateRange {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function getThisWeek(): DateRange {
  const start = new Date();
  const day = start.getDay();
  const diff = start.getDate() - day;
  start.setDate(diff);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function getLastWeek(): DateRange {
  const start = new Date();
  const day = start.getDay();
  const diff = start.getDate() - day - 7;
  start.setDate(diff);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date();
  end.setDate(end.getDate() - day - 1);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function getLast7Days(): DateRange {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  
  const start = new Date();
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  
  return { start, end };
}

export function getThisMonth(): DateRange {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function getLastMonth(): DateRange {
  const start = new Date();
  start.setMonth(start.getMonth() - 1);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date();
  end.setDate(0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
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

/** Calendar date in Malaysia time — matches Distribution / POS business days. */
export function malaysiaCalendarDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
