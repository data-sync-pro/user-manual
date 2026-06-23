// SubmissionLimiter — double-submit / casual-abuse guard.
// LIMITS, NOT SECURITY (localStorage; incognito bypasses).
// Rolling window: MAX submissions per browser per WINDOW_MS.
// Ported verbatim from portal.js.

const KEY = 'portal.submitTs.v1';
export const MAX = 5;
export const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const read = (): number[] => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((n) => typeof n === 'number') : [];
  } catch {
    return [];
  }
};

const write = (arr: number[]): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
};

const recent = (): number[] => {
  const cutoff = Date.now() - WINDOW_MS;
  return read().filter((ts) => ts >= cutoff);
};

export const SubmissionLimiter = {
  MAX,
  WINDOW_MS,
  remaining(): number {
    return Math.max(0, MAX - recent().length);
  },
  isBlocked(): boolean {
    return this.remaining() <= 0;
  },
  msUntilReset(): number {
    const r = recent();
    if (r.length < MAX) return 0;
    return Math.max(0, Math.min(...r) + WINDOW_MS - Date.now());
  },
  resetLabel(): string {
    const ms = this.msUntilReset();
    if (ms <= 0) return 'shortly';
    const hours = Math.ceil(ms / (60 * 60 * 1000));
    if (hours >= 2) return 'in about ' + hours + ' hours';
    const minutes = Math.max(1, Math.ceil(ms / (60 * 1000)));
    return 'in about ' + minutes + ' minute' + (minutes === 1 ? '' : 's');
  },
  record(): void {
    write(recent().concat(Date.now()));
  },
};
