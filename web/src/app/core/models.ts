// Shared domain types for the Partner Portal.

export type DealStatus = 'pending' | 'accepted' | 'won' | 'lost';

// partners/{uid} document shape.
export interface Partner {
  name?: string;
  company?: string;
  track?: string;
  email?: string;
  role?: string;
  // SF Account this partner maps to (PartnerAccount__c) — scopes the mirror.
  salesforceAccountId?: string;
  createdAt?: unknown;
  // SF Contact this profile was auto-provisioned from. Absent on profiles created
  // by hand with scripts/bootstrap.js.
  salesforceContactId?: string;
  // 'partner-sync' when syncPartnersFromSalesforce provisioned this profile from a
  // converted partner Lead; absent when scripts/bootstrap.js created it.
  provisionedBy?: string;
  // Server-managed set-password-invite bookkeeping. Not rendered by the admin UI.
  inviteAttempts?: number;
  inviteSentAt?: unknown;
  // The SF Contact's email drifted away from the Auth login email. The sync refuses
  // to follow the change (account-takeover risk) and flags it for an admin instead.
  emailMismatch?: boolean;
  emailMismatchAt?: unknown;
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
  // Commission rate + tier name locked in server-side (by the Salesforce pull)
  // when the deal settled, so historical commission never drifts as later deals
  // move the trailing-tier window. undefined until settled, or for deals that
  // settled before locking existed — the dashboard falls back to the live
  // rolling rate for those.
  lockedRate?: number;
  lockedTier?: string;
}

// One deal's single installment landing on a given quarterly payout date.
export interface CommissionInstallment {
  dealId: string;
  customer: string;
  installment: number; // which of the 4 quarterly installments (1..4)
  amount: number; // this installment's commission (~1/4 of the deal's total; the last carries the rounding remainder)
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

// A partner profile plus its document id (uid) — admin partner list.
export interface PartnerRow extends Partner {
  uid: string;
}

// Minimal summary returned by AuthService.signIn(). Deliberately carries no
// token — auth state lives entirely in the Firebase SDK.
export interface LoginResult {
  partner: { name: string; track: string };
}
