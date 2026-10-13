// Date/time/money helpers. All dates are plain 'YYYY-MM-DD' strings and all
// times are integer minutes since midnight, so nothing depends on the host
// timezone. Money is always integer cents.

export const TODAY = '2026-03-09'; // simulated "today" (a Monday)
export const NOW_MIN = 600; // simulated wall clock: 10:00

export function pad(n, width) {
  return String(n).padStart(width, '0');
}

function toUtc(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(toUtc(v)) &&
    new Date(toUtc(v)).toISOString().slice(0, 10) === v;
}

export function addDays(date, n) {
  return new Date(toUtc(date) + n * 86400000).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

export function dayOfWeek(date) {
  return new Date(toUtc(date)).getUTCDay(); // 0 = Sunday
}

export const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Accepts integer minutes or "HH:MM". Returns integer minutes or NaN. */
export function parseTime(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    if (/^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return NaN;
}

export function fmtTime(min) {
  if (min == null) return '';
  return `${pad(Math.floor(min / 60), 2)}:${pad(min % 60, 2)}`;
}

export function fmtMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${pad(abs % 100, 2)}`;
}

export function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
