/**
 * Date, time and age formatting that gives identical output in the browser and on the
 * server. Built from Intl parts plus fixed month names, because locale month abbreviations
 * differ between ICU versions ("Sep" vs "Sept") and reports must not change between runs.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/** Parses a calendar date "YYYY-MM-DD", rejecting impossible dates such as 2025-02-30. */
export function parseISODate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function todayISO(timeZone: string, now = new Date()): string {
  const { year, month, day } = zonedParts(now, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Completed months of age on `at`, in the given time zone. Null if the birth date is invalid or later than `at`. */
export function ageInMonths(dateOfBirth: string, at: Date, timeZone: string): number | null {
  const dob = parseISODate(dateOfBirth);
  if (!dob) return null;
  const now = zonedParts(at, timeZone);
  let months = (now.year - dob.year) * 12 + (now.month - dob.month);
  if (now.day < dob.day) months -= 1;
  return months < 0 ? null : months;
}

export function formatAge(months: number | null | undefined, style: 'short' | 'long' = 'short'): string {
  if (months == null) return '—';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (style === 'short') return years === 0 ? `${rest} mo` : `${years} yr ${rest} mo`;
  const y = `${years} year${years === 1 ? '' : 's'}`;
  const m = `${rest} month${rest === 1 ? '' : 's'}`;
  if (years === 0) return m;
  if (rest === 0) return y;
  return `${y} ${m}`;
}

/** "2024-03-05" → "5 Mar 2024". Calendar dates carry no time zone, so none is applied. */
export function formatCalendarDate(value: string, style: 'short' | 'long' = 'short'): string {
  const parsed = parseISODate(value);
  if (!parsed) return value;
  const names = style === 'long' ? MONTHS_LONG : MONTHS;
  return `${parsed.day} ${names[parsed.month - 1]} ${parsed.year}`;
}

export function formatDate(value: string | Date, timeZone: string, style: 'short' | 'long' = 'short'): string {
  const { year, month, day } = zonedParts(new Date(value), timeZone);
  const names = style === 'long' ? MONTHS_LONG : MONTHS;
  return `${day} ${names[month - 1]} ${year}`;
}

export function formatTime(value: string | Date, timeZone: string): string {
  const { hour, minute } = zonedParts(new Date(value), timeZone);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

export function timeZoneLabel(timeZone: string, at = new Date()): string {
  if (timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta') return 'IST';
  const part = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

export function formatDateTime(value: string | Date, timeZone: string): string {
  return `${formatDate(value, timeZone)}, ${formatTime(value, timeZone)} ${timeZoneLabel(timeZone, new Date(value))}`;
}

export function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}
