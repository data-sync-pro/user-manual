// Partner commission tiers — set by the trailing-12-month referred ARR
// (sum of Closed-won ARR over the last year). Each tier carries two rates; the
// partner's track (Solution vs Referral) picks which one applies.

export interface Tier {
  name: string;
  min: number; // inclusive floor of trailing-12mo referred ARR for this tier
  referral: number; // referral-track commission rate
  solution: number; // solution-track commission rate
}

// Ordered low → high. Thresholds: Registered $0–250k, Silver $250k–1M,
// Gold $1M–5M, Platinum $5M+.
export const TIERS: Tier[] = [
  { name: 'Registered', min: 0, referral: 0.15, solution: 0.2 },
  { name: 'Silver', min: 250_000, referral: 0.18, solution: 0.23 },
  { name: 'Gold', min: 1_000_000, referral: 0.22, solution: 0.27 },
  { name: 'Platinum', min: 5_000_000, referral: 0.25, solution: 0.3 },
];

// Highest tier whose floor the trailing ARR has reached.
export function tierFor(trailingArr: number): Tier {
  let current = TIERS[0];
  for (const tier of TIERS) {
    if (trailingArr >= tier.min) current = tier;
  }
  return current;
}

// The next tier up, or null if already at the top.
export function nextTier(t: Tier): Tier | null {
  const i = TIERS.indexOf(t);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

// Commission rate for a tier given the partner's track. Solution track earns
// the higher rate; anything else falls back to the referral rate.
export function rateFor(t: Tier, track: string | undefined): number {
  return /solution/i.test(track || '') ? t.solution : t.referral;
}
