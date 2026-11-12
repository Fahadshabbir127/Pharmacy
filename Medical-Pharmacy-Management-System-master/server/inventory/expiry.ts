/**
 * Expiry dates (Phase 6, approved decisions D3 and D5).
 *
 *  D3: a batch is sellable up to AND INCLUDING its expiry date and blocked from the next day.
 *      A month-only expiry (e.g. "2027-10" or "10/2027") means the last day of that month.
 *  D5: a batch without an expiry date is sellable, but FEFO uses it after every dated batch,
 *      and it is reported as "no expiry".
 *
 * Dates are stored as 'YYYY-MM-DD' text so they compare correctly as strings.
 * "Today" is the host computer's local calendar date (the pharmacy's day).
 */

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based here
}

function validDate(y: number, m: number, d: number): boolean {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= lastDayOfMonth(y, m);
}

export interface NormalizedExpiry {
  /** 'YYYY-MM-DD', or null when there is no (recognizable) expiry */
  date: string | null;
  /** false when the text was not empty but could not be understood (kept in expiry_raw and reported) */
  recognized: boolean;
}

/**
 * Accepts only unambiguous formats:
 *   YYYY-MM-DD, YYYY/MM/DD   -> that day
 *   YYYY-MM, YYYY/MM         -> last day of the month
 *   MM/YYYY, MM-YYYY         -> last day of the month
 * Day-first/month-first forms like 05/10/2027 are ambiguous and are NOT guessed.
 */
export function normalizeExpiry(raw: unknown): NormalizedExpiry {
  if (raw === null || raw === undefined) return { date: null, recognized: true };
  const s = String(raw).trim();
  if (!s) return { date: null, recognized: true };
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDate(y, mo, d) ? { date: `${y}-${pad(mo)}-${pad(d)}`, recognized: true } : { date: null, recognized: false };
  }
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    return validDate(y, mo, 1) ? { date: `${y}-${pad(mo)}-${pad(lastDayOfMonth(y, mo))}`, recognized: true } : { date: null, recognized: false };
  }
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) {
    const [mo, y] = [Number(m[1]), Number(m[2])];
    return validDate(y, mo, 1) ? { date: `${y}-${pad(mo)}-${pad(lastDayOfMonth(y, mo))}`, recognized: true } : { date: null, recognized: false };
  }
  return { date: null, recognized: false };
}

/** Strict form used for new input (purchases, batches): a real calendar date or a month. Empty = no expiry. */
export interface ParsedDate { ok: boolean; date: string | null; error?: string }

export function parseExpiryInput(raw: unknown): ParsedDate {
  const n = normalizeExpiry(raw);
  if (!n.recognized) return { ok: false, date: null, error: `Expiry date "${String(raw)}" is not a valid date (use YYYY-MM-DD or YYYY-MM).` };
  return { ok: true, date: n.date };
}

/** Manufacturing date: optional, a full date. */
export function parseMfgInput(raw: unknown): ParsedDate {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { ok: true, date: null };
  const m = String(raw).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m || !validDate(Number(m[1]), Number(m[2]), Number(m[3]))) return { ok: false, date: null, error: `Manufacturing date "${String(raw)}" is not a valid date (use YYYY-MM-DD).` };
  return { ok: true, date: `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` };
}

/**
 * The pharmacy's current date. PHARMACY_TEST_TODAY (YYYY-MM-DD) exists ONLY for automated tests
 * (time travel to check expiry rules); the backend logs a warning at startup whenever it is set.
 */
export function today(now: Date = new Date()): string {
  const override = process.env.PHARMACY_TEST_TODAY;
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** D3: expired only AFTER the expiry date. */
export function isExpired(expiry: string | null | undefined, on: string): boolean {
  return !!expiry && expiry < on;
}

export type BatchStatus = 'EMPTY' | 'EXPIRED' | 'EXPIRING_SOON' | 'NO_EXPIRY' | 'OK';

export function batchStatus(expiry: string | null | undefined, qtyOnHand: number, on: string, soonDays = 90): BatchStatus {
  if (qtyOnHand <= 0) return 'EMPTY';
  if (!expiry) return 'NO_EXPIRY';
  if (isExpired(expiry, on)) return 'EXPIRED';
  if (expiry <= addDays(on, soonDays)) return 'EXPIRING_SOON';
  return 'OK';
}
