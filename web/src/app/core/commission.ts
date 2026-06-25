// Commission payout schedule.
//
// Each won deal's commission is paid in 4 equal quarterly installments. The
// FIRST installment lands on the quarterly commission-payout date that falls on
// or after 30 days from the day the client paid; the remaining three follow one
// quarter apart. Quarterly payout dates are the first day of each calendar
// quarter (Jan 1 / Apr 1 / Jul 1 / Oct 1).
import { CommissionInstallment, CommissionPayout, Deal } from './models';

// Number of quarterly installments a deal's commission is split into.
export const COMMISSION_INSTALLMENTS = 4;
// Days the commission is held after the client pays before it becomes eligible
// for the next quarterly payout date.
export const PAYOUT_HOLD_DAYS = 30;

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parse a 'YYYY-MM-DD' string as a UTC-midnight Date (null if invalid).
function parseUtc(ymd: string): Date | null {
  if (!ymd) return null;
  const d = new Date(ymd.slice(0, 10) + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

const isoUtc = (d: Date): string => d.toISOString().slice(0, 10);
const pad2 = (n: number): string => String(n).padStart(2, '0');

// Local calendar date as 'YYYY-MM-DD' — used to compare "today" against the
// (UTC-keyed) payout dates without timezone drift.
const localKey = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// First quarterly payout date (UTC) on or after `from`.
function firstPayoutOnOrAfter(from: Date): Date {
  const y = from.getUTCFullYear();
  const q = Math.floor(from.getUTCMonth() / 3); // 0..3
  const thisQuarter = Date.UTC(y, q * 3, 1);
  // `from` always sits within quarter q, so it can only precede the quarter
  // start when it lands exactly on it — in which case that payout still counts.
  if (from.getTime() <= thisQuarter) return new Date(thisQuarter);
  return new Date(Date.UTC(y, q * 3 + 3, 1)); // next quarter start (month overflow rolls the year)
}

// Same calendar day, n quarters later (UTC, snapped to the 1st of the quarter).
const addQuarters = (d: Date, n: number): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n * 3, 1));

const quarterLabel = (d: Date): string => `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
const dateLabel = (d: Date): string => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

/**
 * Build the aggregate quarterly commission-payout timeline across all won deals.
 *
 * @param deals  Partner deals (only `won` deals carry commission).
 * @param rateFn Resolves a deal's commission rate (e.g. the rolling tier rate).
 * @param today  Reference "now" used to mark payouts paid / next / scheduled.
 */
export function buildCommissionSchedule(
  deals: Deal[],
  rateFn: (deal: Deal) => number,
  today: Date,
): CommissionPayout[] {
  const byDate = new Map<string, CommissionInstallment[]>();

  (Array.isArray(deals) ? deals : [])
    .filter((d) => d.status === 'won')
    .forEach((d) => {
      // Schedule starts only once the client's payment date is recorded.
      const paid = parseUtc(d.paidDate);
      if (!paid) return;
      const perInstallment = Math.round(((Number(d.arr) || 0) * rateFn(d)) / COMMISSION_INSTALLMENTS);

      const eligible = new Date(paid.getTime() + PAYOUT_HOLD_DAYS * DAY_MS);
      let payout = firstPayoutOnOrAfter(eligible);
      for (let i = 0; i < COMMISSION_INSTALLMENTS; i++) {
        const key = isoUtc(payout);
        const items = byDate.get(key) || [];
        items.push({ dealId: d.id, customer: d.customer, installment: i + 1, amount: perInstallment });
        byDate.set(key, items);
        payout = addQuarters(payout, 1);
      }
    });

  const todayKey = localKey(today);
  const dates = [...byDate.keys()].sort();
  const nextKey = dates.find((k) => k >= todayKey); // soonest upcoming (due today counts)

  return dates.map((key) => {
    const d = parseUtc(key) as Date;
    const items = byDate.get(key)!;
    const status: CommissionPayout['status'] =
      key < todayKey ? 'paid' : key === nextKey ? 'next' : 'scheduled';
    return {
      date: key,
      quarter: quarterLabel(d),
      dateLabel: dateLabel(d),
      amount: items.reduce((s, it) => s + it.amount, 0),
      installments: items.length,
      status,
      items,
    };
  });
}
