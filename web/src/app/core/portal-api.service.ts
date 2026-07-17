import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  Timestamp,
  collection,
  doc,
  query,
  where,
  orderBy,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  QueryDocumentSnapshot,
  DocumentData,
} from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { AuthService } from './auth.service';
import { tsToDateStr } from './format';
import { Announcement, Deal, DealStatus, Partner, PartnerRow } from './models';

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
    track: data['track'] || '',
    // paidAt is stored at UTC midnight — format in UTC so the day doesn't
    // shift for users west of UTC (a one-day shift can move a commission
    // payout across a quarter boundary).
    paidDate: tsToDateStr(data['paidAt'], true),
    // Locked-in commission rate/tier snapshotted by the pull at settlement.
    lockedRate: typeof data['lockedRate'] === 'number' ? data['lockedRate'] : undefined,
    lockedTier: data['lockedTier'] || undefined,
  };
}

// Generate a human-readable id like 'ER-2026-483920': dynamic year + 6 random
// digits (reports only — deal ids come from Salesforce). Collisions are rare
// at this size, and submit retries with a fresh id when one does happen
// (Firestore rules turn a colliding create into a denied update).
function genId(prefix: string): string {
  const n = String(Math.floor(100000 + Math.random() * 900000));
  return prefix + '-' + new Date().getFullYear() + '-' + n;
}

// Map the deal-registration form's verbose sales-stage labels to the canonical
// pipeline enum. Canonical values pass through unchanged — checked FIRST, since
// e.g. /discovery/i would otherwise rewrite the canonical 'Discovery'.
function canonicalStage(s: unknown): string {
  const str = String(s || '');
  const canon = ['Discovery', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
  if (canon.indexOf(str) >= 0) return str;
  if (/identified/i.test(str)) return 'Discovery';
  if (/discovery/i.test(str)) return 'Qualification';
  if (/demo/i.test(str)) return 'Proposal';
  if (/evaluation|poc/i.test(str)) return 'Proposal';
  if (/pricing|security/i.test(str)) return 'Negotiation';
  if (/verbal|commit/i.test(str)) return 'Negotiation';
  return 'Discovery';
}

// True for the FirebaseError a random-id collision produces: the write hits an
// existing doc, becomes an update, and partners may not update — so Firestore
// answers 'permission-denied'.
function isPermissionDenied(err: unknown): boolean {
  return (err as { code?: string })?.code === 'permission-denied';
}

@Injectable({ providedIn: 'root' })
export class PortalApiService {
  private db = inject(Firestore);
  private functions = inject(Functions);
  private authSvc = inject(AuthService);

  // Current user's deals, newest first.
  async getDeals(): Promise<Deal[]> {
    const user = this.authSvc.currentUser();
    return user ? this.getDealsForUid(user.uid) : [];
  }

  // A specific partner's deals, newest first (admin uses this to view a partner's
  // dashboard; rules permit admin to read any deal). Rejects on a failed read —
  // callers must be able to tell "no deals" from "couldn't load".
  async getDealsForUid(uid: string): Promise<Deal[]> {
    if (!uid) return [];
    const q = query(
      collection(this.db, 'deals'),
      where('ownerUid', '==', uid),
      orderBy('submittedAt', 'desc'),
    );
    const qs = await getDocs(q);
    return qs.docs.map(mapDealDoc);
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

  // Registers the deal Salesforce-first via the registerDeal callable: the
  // record is created in Salesforce (the source of truth) and its record Id
  // IS the deal id — nothing is generated locally. The function also writes
  // the deals/{sfId} mirror doc, so the dashboard sees it immediately.
  // `clientToken` is a stable per-submission idempotency key (reused across
  // retries) so a timed-out or retried submit converges on one SF record.
  async submitDeal(
    payload: Record<string, unknown>,
    clientToken?: string,
  ): Promise<{ id: string; status: 'pending' }> {
    const user = this.authSvc.currentUser();
    if (!user) throw new Error('You must be signed in to register a deal.');
    payload = payload || {};

    const arr =
      Number(String(payload['arr'] != null ? payload['arr'] : '').replace(/[^0-9.]/g, '')) || 0;
    // Leave stage empty when the form didn't capture one — don't invent 'Discovery'.
    const stage = payload['stage'] ? canonicalStage(payload['stage']) : '';
    const partner = this.authSvc.currentPartner();

    const products = Array.isArray(payload['products'])
      ? (payload['products'] as string[])
      : payload['products']
        ? [String(payload['products'])]
        : [];

    const dealData = {
      customer:
        (payload['customer'] as string) ||
        (payload['company'] as string) ||
        (payload['legalEntity'] as string) ||
        '',
      domain: (payload['domain'] as string) || '',
      arr,
      stage,
      // The deal's registered track wins; fall back to the partner's default.
      track: (payload['track'] as string) || (partner && partner.track) || '',
      products,
      contact: {
        firstName: (payload['contactFirstName'] as string) || '',
        lastName: (payload['contactLastName'] as string) || '',
        // Keep a combined name for display/back-compat (built from first+last).
        name:
          [payload['contactFirstName'], payload['contactLastName']]
            .filter(Boolean)
            .join(' ') ||
          (payload['contactName'] as string) ||
          (payload['name'] as string) ||
          '',
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
      // Legal attestations (arrays of ['confirmed'] from the wizard) -> booleans.
      affirmations: {
        affirmSelfReferral: !!(payload['affirmSelfReferral'] as unknown[])?.length,
        affirmEmployment: !!(payload['affirmEmployment'] as unknown[])?.length,
        affirmPipeline: !!(payload['affirmPipeline'] as unknown[])?.length,
        affirmConsent: !!(payload['affirmConsent'] as unknown[])?.length,
        affirmTruthful: !!(payload['affirmTruthful'] as unknown[])?.length,
      },
      clientToken: clientToken || '',
    };

    const call = httpsCallable<typeof dealData, { id: string; status: 'pending' }>(
      this.functions,
      'registerDeal',
    );
    try {
      const res = await call(dealData);
      return { id: res.data.id, status: 'pending' };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // Callable error codes arrive as 'functions/<code>'.
      if ((e.code || '').endsWith('permission-denied')) {
        throw new Error(
          "Your account isn't allowed to register deals. Please contact your partner manager.",
        );
      }
      // Server messages (account not linked, SF unavailable, …) are already
      // user-readable; 'internal' is the unhandled-exception fallback.
      const msg = e.message && e.message !== 'internal' ? e.message : '';
      throw new Error(msg || 'Could not register the deal. Please try again later.');
    }
  }

  // Writes a reports/{ER-YYYY-NNNNNN} doc for a user-reported error/issue.
  // Auto-attaches the reporter, the page they were on, and their user agent.
  async submitReport(input: {
    category?: string;
    message: string;
    page?: string;
  }): Promise<{ id: string }> {
    const message = String(input?.message || '').trim();
    if (!message) throw new Error('Please describe the issue before submitting.');

    const user = this.authSvc.currentUser();
    const partner = this.authSvc.currentPartner();
    const docData = {
      reporterUid: user?.uid || '',
      reporterEmail: partner?.email || user?.email || '',
      category: input.category || 'Other',
      message: message.slice(0, 5000),
      page: input.page || '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      status: 'open' as const,
      createdAt: serverTimestamp(),
    };
    // Same collision-retry as submitDeal (report updates are admin-only too).
    for (let attempt = 0; ; attempt++) {
      const id = genId('ER');
      try {
        await setDoc(doc(this.db, 'reports', id), { id, ...docData });
        return { id };
      } catch (err) {
        if (isPermissionDenied(err) && attempt < 2) continue;
        throw err;
      }
    }
  }

  // A single partner profile (admin viewing another partner's dashboard).
  async getPartner(uid: string): Promise<Partner | null> {
    if (!uid) return null;
    try {
      const snap = await getDoc(doc(this.db, 'partners', uid));
      return snap.exists() ? (snap.data() as Partner) : null;
    } catch (err) {
      console.warn('[PortalApi] getPartner failed:', (err as Error)?.message);
      return null;
    }
  }

  /* ---- ADMIN-only ---- */

  // All partner profiles (admin directory). Rejects on a failed read.
  async getAllPartners(): Promise<PartnerRow[]> {
    const qs = await getDocs(collection(this.db, 'partners'));
    return qs.docs.map((snap) => ({ uid: snap.id, ...(snap.data() as Partner) }));
  }

  // All deals across partners, newest first. Rejects on a failed read so the
  // admin console can show its error state instead of "0 deals".
  async getAllDeals(): Promise<Deal[]> {
    const q = query(collection(this.db, 'deals'), orderBy('submittedAt', 'desc'));
    const qs = await getDocs(q);
    return qs.docs.map(mapDealDoc);
  }

  // Record (or clear) the date the client paid. Stored as a Timestamp at UTC
  // midnight so it round-trips through tsToDateStr; '' clears it back to null.
  setDealPaidDate(dealId: string, ymd: string): Promise<void> {
    const paidAt = ymd ? Timestamp.fromDate(new Date(ymd.slice(0, 10) + 'T00:00:00Z')) : null;
    return updateDoc(doc(this.db, 'deals', dealId), { paidAt });
  }
}
