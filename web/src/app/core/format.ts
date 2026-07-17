// Formatting + small animation helpers (ported from portal.js).
import { Timestamp } from '@angular/fire/firestore';

// Compact ARR label: $1.2M / $250K / $900.
export function formatArrShort(n: unknown): string {
  const v = Number(n) || 0;
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + 'M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + Math.round(v);
}

// Compact ARR split into { num, unit } so the unit (K/M/B) can be styled
// smaller/muted next to the figure. Trailing zeros are trimmed: 1.42M, 5M, 222K.
export function splitArrShort(n: unknown): { num: string; unit: string } {
  const v = Number(n) || 0;
  const trim = (x: number) => x.toFixed(2).replace(/\.?0+$/, '');
  if (v >= 1e9) return { num: '$' + trim(v / 1e9), unit: 'B' };
  if (v >= 1e6) return { num: '$' + trim(v / 1e6), unit: 'M' };
  if (v >= 1e3) return { num: '$' + Math.round(v / 1e3), unit: 'K' };
  return { num: '$' + Math.round(v), unit: '' };
}

// Grouped USD money: $1,234,567.
export const fmtMoney = (n: unknown): string =>
  '$' + (Number(n) || 0).toLocaleString('en-US');

// Format a Firestore Timestamp (or Date / millis / 'YYYY-MM-DD' string) as a
// 'YYYY-MM-DD' string. Local calendar day by default (true instants like
// submittedAt); pass utc=true for date-only fields stored at UTC midnight
// (paidAt) — local getters would render those a day early west of UTC.
export function tsToDateStr(ts: unknown, utc = false): string {
  if (!ts) return '';
  let d: Date;
  if (ts instanceof Timestamp) d = ts.toDate();
  else if (typeof (ts as { toDate?: () => Date }).toDate === 'function') d = (ts as { toDate: () => Date }).toDate();
  else if (ts instanceof Date) d = ts;
  else if (typeof ts === 'number') d = new Date(ts);
  else if (typeof ts === 'string') return ts.slice(0, 10);
  else if ((ts as { seconds?: number }).seconds != null) d = new Date((ts as { seconds: number }).seconds * 1000);
  else return '';
  if (isNaN(d.getTime())) return '';
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = String((utc ? d.getUTCMonth() : d.getMonth()) + 1).padStart(2, '0');
  const day = String(utc ? d.getUTCDate() : d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// rAF count-up. Calls onUpdate(value) with the in-progress number; honors
// reduced-motion (jumps straight to target). easeOutCubic for a snappy settle.
export function countUp(
  target: number,
  ms: number,
  onUpdate: (value: number) => void,
): void {
  target = Number(target) || 0;
  ms = ms || 1100;

  const reduce =
    typeof matchMedia !== 'undefined' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    onUpdate(target);
    return;
  }

  const start = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / ms);
    onUpdate(target * ease(p));
    if (p < 1) requestAnimationFrame(step);
    else onUpdate(target);
  };
  requestAnimationFrame(step);
}
