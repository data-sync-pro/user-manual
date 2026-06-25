// Shared domain types for the Partner Portal.

export type DealStatus = 'pending' | 'accepted' | 'won' | 'lost';

// partners/{uid} document shape.
export interface Partner {
  name?: string;
  company?: string;
  track?: string;
  email?: string;
  role?: string;
  createdAt?: unknown;
}

// Row shape used by the dashboard + admin tables (mapped from deals/{id}).
export interface Deal {
  id: string;
  ownerUid: string;
  customer: string;
  domain: string;
  arr: number;
  stage: string;
  status: DealStatus;
  submitted: string;
  // Commission track: 'Solution' (delivery, higher rate) or 'Referral'
  // (introduction only). Picks which of the tier's two rates applies.
  track: string;
  // Date the client paid ('YYYY-MM-DD'); '' until recorded. Drives the
  // commission schedule — the first quarterly payout lands 30 days after this.
  paidDate: string;
}

export interface PipelineEntry {
  stage: string;
  arr: number;
  count: number;
}

// One deal's single installment landing on a given quarterly payout date.
export interface CommissionInstallment {
  dealId: string;
  customer: string;
  installment: number; // which of the 4 quarterly installments (1..4)
  amount: number; // this installment's commission (25% of the deal's total)
}

// One quarterly payout in the dashboard commission-schedule timeline.
// Commission is paid in 4 installments, one per quarter; the first lands on the
// quarterly payout date ≥ 30 days after the client paid.
export interface CommissionPayout {
  date: string; // 'YYYY-MM-DD' quarterly payout date
  quarter: string; // 'Q3 2026'
  dateLabel: string; // 'Jul 1, 2026'
  amount: number; // total commission paid on this date across all deals
  installments: number; // number of per-deal installments rolled into this date
  status: 'paid' | 'next' | 'scheduled';
  items: CommissionInstallment[]; // per-deal breakdown of this payout
}

export interface Kpis {
  deals: number;
  accepted: number;
  pipelineArr: number;
  commissionYtd: number;
}

export interface Announcement {
  date: string;
  title: string;
  body: string;
}

// reports/{ER-2026-NNNN} — a user-submitted error/issue report.
export interface ErrorReport {
  id: string;
  reporterUid: string;
  reporterEmail: string;
  category: string;
  message: string;
  page: string; // path/hash where the issue was found
  status: 'open' | 'resolved';
  createdAt?: unknown;
}

// Minimal summary returned by AuthService.signIn().
export interface LoginResult {
  token: string;
  partner: { name: string; track: string };
}
