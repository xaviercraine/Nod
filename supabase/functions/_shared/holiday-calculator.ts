// ============================================
// NOD — _shared/holiday-calculator.ts
// Ontario statutory holidays with algorithmic computation for floating holidays.
// Used by unsubscribe deadline calculator (10 business days excluding
// weekends + statutory holidays).
//
// Holidays:
//   New Year's Day (Jan 1)
//   Family Day (3rd Monday of February)
//   Good Friday (Easter algorithm)
//   Victoria Day (Monday before May 25)
//   Canada Day (July 1, or July 2 if July 1 is Sunday)
//   Civic Holiday (1st Monday of August)
//   Labour Day (1st Monday of September)
//   Thanksgiving (2nd Monday of October)
//   Christmas Day (Dec 25)
//   Boxing Day (Dec 26)
// ============================================

/**
 * Compute Easter Sunday for a given year using the Anonymous Gregorian algorithm.
 * Returns a Date object (UTC) for Easter Sunday.
 */
function computeEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Find the Nth occurrence of a given weekday in a month.
 * weekday: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): Date {
  // Start at the 1st of the month
  const first = new Date(Date.UTC(year, month, 1));
  const firstDay = first.getUTCDay();

  // Days until the first occurrence of the target weekday
  let offset = weekday - firstDay;
  if (offset < 0) offset += 7;

  // The nth occurrence
  const day = 1 + offset + (n - 1) * 7;

  return new Date(Date.UTC(year, month, day));
}

/**
 * Find the Monday on or before a given date.
 */
function mondayOnOrBefore(date: Date): Date {
  const day = date.getUTCDay(); // 0=Sun, 1=Mon
  const diff = day === 0 ? 6 : day - 1; // days back to Monday
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() - diff);
  return result;
}

/**
 * Get all Ontario statutory holidays for a given year.
 * Returns an array of Date objects (UTC, time set to 00:00:00).
 */
export function getOntarioHolidays(year: number): Date[] {
  const holidays: Date[] = [];

  // New Year's Day — January 1
  holidays.push(new Date(Date.UTC(year, 0, 1)));

  // Family Day — 3rd Monday of February
  holidays.push(nthWeekdayOfMonth(year, 1, 1, 3));

  // Good Friday — 2 days before Easter Sunday
  const easter = computeEasterSunday(year);
  const goodFriday = new Date(easter.getTime());
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  holidays.push(goodFriday);

  // Victoria Day — Monday before May 25
  const may25 = new Date(Date.UTC(year, 4, 25));
  holidays.push(mondayOnOrBefore(may25));

  // Canada Day — July 1 (or July 2 if July 1 is Sunday)
  const july1 = new Date(Date.UTC(year, 6, 1));
  if (july1.getUTCDay() === 0) {
    holidays.push(new Date(Date.UTC(year, 6, 2)));
  } else {
    holidays.push(july1);
  }

  // Civic Holiday — 1st Monday of August
  holidays.push(nthWeekdayOfMonth(year, 7, 1, 1));

  // Labour Day — 1st Monday of September
  holidays.push(nthWeekdayOfMonth(year, 8, 1, 1));

  // Thanksgiving — 2nd Monday of October
  holidays.push(nthWeekdayOfMonth(year, 9, 1, 2));

  // Christmas Day — December 25
  holidays.push(new Date(Date.UTC(year, 11, 25)));

  // Boxing Day — December 26
  holidays.push(new Date(Date.UTC(year, 11, 26)));

  return holidays;
}

/**
 * Format a Date as YYYY-MM-DD string (UTC).
 */
function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Check if a given date (YYYY-MM-DD or Date object) is an Ontario statutory holiday.
 */
export function isOntarioHoliday(date: Date | string): boolean {
  const d = typeof date === "string" ? new Date(date + "T00:00:00Z") : date;
  const year = d.getUTCFullYear();
  const holidays = getOntarioHolidays(year);
  const target = formatDate(d);

  return holidays.some((h) => formatDate(h) === target);
}

/**
 * Check if a given date is a business day (not a weekend, not a statutory holiday).
 */
export function isBusinessDay(date: Date): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false; // Weekend
  return !isOntarioHoliday(date);
}

/**
 * Add N business days to a start date, excluding weekends and Ontario statutory holidays.
 * Used for the 10-business-day unsubscribe deadline calculation.
 */
export function addBusinessDays(startDate: Date, days: number): Date {
  const current = new Date(startDate.getTime());
  let remaining = days;

  while (remaining > 0) {
    current.setUTCDate(current.getUTCDate() + 1);
    if (isBusinessDay(current)) {
      remaining--;
    }
  }

  return current;
}
