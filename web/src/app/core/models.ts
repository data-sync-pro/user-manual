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
}

export interface PipelineEntry {
  stage: string;
  arr: number;
  count: number;
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

// Minimal summary returned by AuthService.signIn().
export interface LoginResult {
  token: string;
  partner: { name: string; track: string };
}
