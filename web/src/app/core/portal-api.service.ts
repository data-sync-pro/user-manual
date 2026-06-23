import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  query,
  where,
  orderBy,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  QueryDocumentSnapshot,
  DocumentData,
} from '@angular/fire/firestore';
import { AuthService } from './auth.service';
import { tsToDateStr } from './format';
import {
  Announcement,
  Deal,
  DealStatus,
  Kpis,
  PipelineEntry,
} from './models';

/* Commission model (gold tier · Solution track default):
 * 27% of won ARR + 3% loyalty. YTD = commission on closed-won deals. */
const COMMISSION_RATE = 0.27;
const LOYALTY_RATE = 0.03;

// Derive KPI figures from the deals array (identical math to portal.js).
export function deriveKpis(deals: Deal[]): Kpis {
  deals = Array.isArray(deals) ? deals : [];
  const total = deals.length;
  const accepted = deals.filter((d) => d.status === 'accepted').length;
  const pipelineArr = deals
    .filter((d) => d.status === 'pending' || d.status === 'accepted')
    .reduce((s, d) => s + (Number(d.arr) || 0), 0);
  const wonArr = deals
    .filter((d) => d.status === 'won')
    .reduce((s, d) => s + (Number(d.arr) || 0), 0);
  const commissionYtd = Math.round(wonArr * (COMMISSION_RATE + LOYALTY_RATE));
  return { deals: total, accepted, pipelineArr, commissionYtd };
}

// Derive ARR + count grouped by sales stage (open + recently closed-won).
export function derivePipeline(deals: Deal[]): PipelineEntry[] {
  deals = Array.isArray(deals) ? deals : [];
  const order = ['Discovery', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won'];
  const byStage: Record<string, PipelineEntry> = {};
  deals.forEach((d) => {
    if (d.status === 'lost') return;
    if (!byStage[d.stage]) byStage[d.stage] = { stage: d.stage, arr: 0, count: 0 };
    byStage[d.stage].arr += Number(d.arr) || 0;
    byStage[d.stage].count += 1;
  });
  return order.filter((s) => byStage[s]).map((s) => byStage[s]);
}

// Map a Firestore deal doc -> the dashboard/admin row shape.
function mapDealDoc(snap: QueryDocumentSnapshot<DocumentData>): Deal {
  const data = snap.data() || {};
  return {
    id: data['id'] || snap.id,
    ownerUid: data['ownerUid'] || '',
    customer: data['customer'] || '',
    domain: data['domain'] || '',
    arr: Number(data['arr']) || 0,
    stage: data['stage'] || '',
    status: (data['status'] || 'pending') as DealStatus,
    submitted: tsToDateStr(data['submittedAt']),
  };
}

// Generate a human deal id 'DR-2026-NNNN' (random 4-digit).
function genDealId(): string {
  const n = String(Math.floor(1000 + Math.random() * 9000));
  return 'DR-2026-' + n;
}

// Map the deal-registration form's verbose sales-stage labels to the canonical
// pipeline enum so new deals group into the dashboard chart.
function canonicalStage(s: unknown): string {
  const str = String(s || '');
  if (/identified/i.test(str)) return 'Discovery';
  if (/discovery/i.test(str)) return 'Qualification';
  if (/demo/i.test(str)) return 'Proposal';
  if (/evaluation|poc/i.test(str)) return 'Proposal';
  if (/pricing|security/i.test(str)) return 'Negotiation';
  if (/verbal|commit/i.test(str)) return 'Negotiation';
  const canon = ['Discovery', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
  return canon.indexOf(str) >= 0 ? str : 'Discovery';
}

@Injectable({ providedIn: 'root' })
export class PortalApiService {
  private db = inject(Firestore);
  private authSvc = inject(AuthService);

  // Current user's deals, newest first.
  async getDeals(): Promise<Deal[]> {
    const user = this.authSvc.currentUser();
    if (!user) return [];
    try {
      const q = query(
        collection(this.db, 'deals'),
        where('ownerUid', '==', user.uid),
        orderBy('submittedAt', 'desc'),
      );
      const qs = await getDocs(q);
      return qs.docs.map(mapDealDoc);
    } catch (err) {
      console.warn('[PortalApi] getDeals failed:', (err as Error)?.message);
      return [];
    }
  }

  async getKpis(): Promise<Kpis> {
    return deriveKpis(await this.getDeals());
  }

  async getPipeline(): Promise<PipelineEntry[]> {
    return derivePipeline(await this.getDeals());
  }

  async getAnnouncements(): Promise<Announcement[]> {
    try {
      const q = query(collection(this.db, 'announcements'), orderBy('date', 'desc'));
      const qs = await getDocs(q);
      return qs.docs.map((snap) => {
        const a = snap.data() || {};
        return { date: a['date'] || '', title: a['title'] || '', body: a['body'] || '' };
      });
    } catch (err) {
      console.warn('[PortalApi] getAnnouncements failed:', (err as Error)?.message);
      return [];
    }
  }

  // Writes a deals/{DR-2026-NNNN} doc owned by the current user.
  async submitDeal(payload: Record<string, unknown>): Promise<{ id: string; status: 'pending' }> {
    const user = this.authSvc.currentUser();
    if (!user) throw new Error('You must be signed in to register a deal.');
    payload = payload || {};

    const id = genDealId();
    const arr =
      Number(String(payload['arr'] != null ? payload['arr'] : '').replace(/[^0-9.]/g, '')) || 0;
    const stage = canonicalStage(payload['stage']);
    const partner = this.authSvc.currentPartner();

    const products = Array.isArray(payload['products'])
      ? (payload['products'] as string[])
      : payload['products']
        ? [String(payload['products'])]
        : [];

    const docData = {
      id,
      ownerUid: user.uid,
      customer:
        (payload['customer'] as string) ||
        (payload['company'] as string) ||
        (payload['legalEntity'] as string) ||
        '',
      domain: (payload['domain'] as string) || '',
      arr,
      stage,
      status: 'pending' as const,
      track: (partner && partner.track) || (payload['track'] as string) || '',
      products,
      contact: {
        name: (payload['contactName'] as string) || (payload['name'] as string) || '',
        title: (payload['contactTitle'] as string) || (payload['title'] as string) || '',
        email:
          (payload['email'] as string) ||
          (payload['contactEmail'] as string) ||
          (payload['workEmail'] as string) ||
          '',
        phone: (payload['phone'] as string) || (payload['contactPhone'] as string) || '',
      },
      hqCountry: (payload['hqCountry'] as string) || (payload['country'] as string) || '',
      industry: (payload['industry'] as string) || '',
      companySize: (payload['companySize'] as string) || (payload['size'] as string) || '',
      orgType: (payload['orgType'] as string) || '',
      successPlan: (payload['successPlan'] as string) || '',
      orgs: Array.isArray(payload['orgs']) ? payload['orgs'] : [],
      engagement: (payload['engagement'] as string) || (payload['context'] as string) || '',
      origin: (payload['origin'] as string) || '',
      payload,
      submittedAt: serverTimestamp(),
    };

    await setDoc(doc(this.db, 'deals', id), docData);
    return { id, status: 'pending' };
  }

  /* ---- ADMIN-only ---- */

  // All deals across partners, newest first.
  async getAllDeals(): Promise<Deal[]> {
    try {
      const q = query(collection(this.db, 'deals'), orderBy('submittedAt', 'desc'));
      const qs = await getDocs(q);
      return qs.docs.map(mapDealDoc);
    } catch (err) {
      console.warn('[PortalApi] getAllDeals failed:', (err as Error)?.message);
      return [];
    }
  }

  updateDealStatus(dealId: string, status: DealStatus): Promise<void> {
    return updateDoc(doc(this.db, 'deals', dealId), { status });
  }
}
