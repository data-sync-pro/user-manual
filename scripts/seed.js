/**
 * scripts/seed.js — Partner Portal demo seed (CommonJS, firebase-admin).
 *
 * Seeds the Firebase Emulator Suite (Auth + Firestore) with demo data:
 *   - 2 auth users (partner + admin), the admin carrying { admin: true } custom claims
 *   - partners/{uid} profile docs
 *   - ~8 deals owned by the partner (mirrors the prior portal.js MOCK set)
 *   - 4 announcements
 *
 * Idempotent: existing demo auth users are deleted by uid first (not-found ignored),
 * and all Firestore docs are upserted with set().
 *
 * Run (after the emulators are up):  npm run seed
 *
 * IMPORTANT: the emulator host env vars MUST be set BEFORE initializeApp so the
 * admin SDK talks to the local emulator instead of a live project.
 */

// --- Point the admin SDK at the EMULATOR (must precede initializeApp) -------
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-partner-portal' });

const auth = admin.auth();
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

// --- Demo users -------------------------------------------------------------
const PARTNER_UID = 'partner-demo';
const ADMIN_UID = 'admin-demo';

const USERS = [
  {
    uid: PARTNER_UID,
    email: 'partner@demo.test',
    password: 'demo1234',
    displayName: 'Acme Solutions',
    claims: null,
  },
  {
    uid: ADMIN_UID,
    email: 'admin@demo.test',
    password: 'admin1234',
    displayName: 'Portal Admin',
    claims: { admin: true },
  },
];

// --- partners/{uid} docs ----------------------------------------------------
const PARTNERS = [
  {
    uid: PARTNER_UID,
    data: {
      name: 'Acme Solutions',
      company: 'Acme Solutions',
      track: 'Solution',
      email: 'partner@demo.test',
      role: 'partner',
      createdAt: FieldValue.serverTimestamp(),
    },
  },
  {
    uid: ADMIN_UID,
    data: {
      name: 'Portal Admin',
      company: 'Data Sync Pro',
      track: 'Solution',
      email: 'admin@demo.test',
      role: 'admin',
      createdAt: FieldValue.serverTimestamp(),
    },
  },
];

// --- deals (mirror the prior portal.js MOCK set) ----------------------------
// id / customer / domain / arr / stage / status / submitted date are authoritative.
// Remaining §C fields (products, contact, hqCountry, industry, …) are sample data.
const DEALS = [
  {
    id: 'DR-2025-0098', customer: 'Meridian Global', domain: 'meridianglobal.com',
    arr: 1200000, stage: 'Closed Won', status: 'won', submitted: '2025-11-12',
    industry: 'Financial Services', orgType: 'Commercial', companySize: '10k+',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Adrian Cole', title: 'VP Data Engineering', email: 'adrian.cole@meridianglobal.com', phone: '+1-212-555-0198' },
  },
  {
    id: 'DR-2026-0188', customer: 'Northwind Logistics', domain: 'northwind.com',
    arr: 145000, stage: 'Negotiation', status: 'pending', submitted: '2026-06-02',
    industry: 'Logistics & Supply Chain', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Marcus Reed', title: 'VP Operations', email: 'marcus.reed@northwind.com', phone: '+1-312-555-0142' },
  },
  {
    id: 'DR-2026-0190', customer: 'Helio Manufacturing', domain: 'heliomfg.com',
    arr: 92000, stage: 'Qualification', status: 'pending', submitted: '2026-06-05',
    industry: 'Manufacturing', orgType: 'Commercial', companySize: '500-1k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Priya Nair', title: 'Director of IT', email: 'priya.nair@heliomfg.com', phone: '+1-414-555-0188' },
  },
  {
    id: 'DR-2026-0175', customer: 'Bristol Health Group', domain: 'bristolhealth.org',
    arr: 210000, stage: 'Proposal', status: 'accepted', submitted: '2026-05-18',
    industry: 'Healthcare', orgType: 'Nonprofit', companySize: '5k-10k',
    hqCountry: 'United Kingdom', products: ['Data Sync Pro', 'Health Cloud Recipes'],
    contact: { name: 'Eleanor Voss', title: 'CIO', email: 'eleanor.voss@bristolhealth.org', phone: '+44-117-555-0173' },
  },
  {
    id: 'DR-2026-0169', customer: 'Vanta Financial', domain: 'vantafin.com',
    arr: 320000, stage: 'Negotiation', status: 'accepted', submitted: '2026-05-09',
    industry: 'Financial Services', orgType: 'Commercial', companySize: '10k+',
    hqCountry: 'United States', products: ['Data Sync Pro', 'FSC Recipes', 'Pipeline Connect'],
    contact: { name: 'Daniel Okafor', title: 'Head of Data Platform', email: 'daniel.okafor@vantafin.com', phone: '+1-212-555-0109' },
  },
  {
    id: 'DR-2026-0162', customer: 'Cedar Retail Co.', domain: 'cedarretail.com',
    arr: 78000, stage: 'Discovery', status: 'accepted', submitted: '2026-04-28',
    industry: 'Retail', orgType: 'Commercial', companySize: '500-1k',
    hqCountry: 'Canada', products: ['Data Sync Pro'],
    contact: { name: 'Sofia Marino', title: 'Operations Manager', email: 'sofia.marino@cedarretail.com', phone: '+1-416-555-0162' },
  },
  {
    id: 'DR-2026-0140', customer: 'Aurora Media', domain: 'auroramedia.tv',
    arr: 168000, stage: 'Closed Won', status: 'won', submitted: '2026-03-14',
    industry: 'Media & Entertainment', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Theo Lambert', title: 'SVP Engineering', email: 'theo.lambert@auroramedia.tv', phone: '+1-323-555-0140' },
  },
  {
    id: 'DR-2026-0131', customer: 'Pinecrest Education', domain: 'pinecrest.edu',
    arr: 54000, stage: 'Closed Won', status: 'won', submitted: '2026-02-22',
    industry: 'Education', orgType: 'Education', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Hannah Brooks', title: 'Director of Information Systems', email: 'hannah.brooks@pinecrest.edu', phone: '+1-617-555-0131' },
  },
  {
    id: 'DR-2026-0118', customer: 'Tidewater Energy', domain: 'tidewater-en.com',
    arr: 96000, stage: 'Closed Lost', status: 'lost', submitted: '2026-01-30',
    industry: 'Energy & Utilities', orgType: 'Commercial', companySize: '5k-10k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Grant Whitfield', title: 'IT Procurement Lead', email: 'grant.whitfield@tidewater-en.com', phone: '+1-713-555-0118' },
  },
];

// --- announcements (mirror the prior portal.js MOCK set) --------------------
const ANNOUNCEMENTS = [
  {
    date: '2026-06-12',
    title: 'Q3 partner incentive live',
    body: 'Earn an extra 3% loyalty bonus on every Solution-track deal registered before September 30.',
  },
  {
    date: '2026-06-04',
    title: 'New deployment templates shipped',
    body: 'Ten new pre-built sync recipes for Health Cloud and Financial Services Cloud are now in the template library.',
  },
  {
    date: '2026-05-21',
    title: 'Updated Partner Hand Book v4',
    body: 'Refreshed co-sell motion, commission schedule (Exhibit A.1), and conflict-of-interest affirmations.',
  },
  {
    date: '2026-05-08',
    title: 'Certification window open',
    body: 'Book your Data Sync Pro Technical Specialist exam — partners with 2+ certs unlock Gold tier rates.',
  },
];

// --- helpers ----------------------------------------------------------------

/** Convert a 'YYYY-MM-DD' string into a Firestore Timestamp (UTC midnight). */
function dateToTimestamp(ymd) {
  return Timestamp.fromDate(new Date(`${ymd}T00:00:00Z`));
}

/** Delete an auth user by uid, ignoring "user not found" (idempotency). */
async function deleteUserIfExists(uid) {
  try {
    await auth.deleteUser(uid);
    return true;
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') return false;
    throw err;
  }
}

/** Create (or recreate) an auth user, applying custom claims when provided. */
async function upsertAuthUser(u) {
  await deleteUserIfExists(u.uid);
  await auth.createUser({
    uid: u.uid,
    email: u.email,
    password: u.password,
    displayName: u.displayName,
    emailVerified: true,
  });
  if (u.claims) {
    await auth.setCustomUserClaims(u.uid, u.claims);
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  console.log('Seeding demo-partner-portal (emulator)…');
  console.log(`  Firestore: ${process.env.FIRESTORE_EMULATOR_HOST}`);
  console.log(`  Auth:      ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);

  // 1) Auth users (delete-then-create for idempotency)
  for (const u of USERS) {
    await upsertAuthUser(u);
    console.log(`  • auth user ${u.uid} (${u.email})${u.claims ? ' [admin]' : ''}`);
  }

  // 2) partners/{uid} docs (upsert)
  for (const p of PARTNERS) {
    await db.collection('partners').doc(p.uid).set(p.data);
    console.log(`  • partners/${p.uid} (role: ${p.data.role})`);
  }

  // 3) deals/{id} docs (upsert)
  for (const d of DEALS) {
    const doc = {
      id: d.id,
      ownerUid: PARTNER_UID,
      customer: d.customer,
      domain: d.domain,
      arr: d.arr,
      stage: d.stage,
      status: d.status,
      track: 'Solution',
      products: d.products,
      contact: d.contact,
      hqCountry: d.hqCountry,
      industry: d.industry,
      companySize: d.companySize,
      orgType: d.orgType,
      engagement: 'Co-sell',
      origin: 'Partner sourced',
      submittedAt: dateToTimestamp(d.submitted),
    };
    await db.collection('deals').doc(d.id).set(doc);
    console.log(`  • deals/${d.id} (${d.customer}, ${d.status})`);
  }

  // 4) announcements (upsert; deterministic id derived from date for idempotency)
  for (const a of ANNOUNCEMENTS) {
    const docId = `ann-${a.date}`;
    await db.collection('announcements').doc(docId).set({
      date: a.date,
      title: a.title,
      body: a.body,
      createdAt: dateToTimestamp(a.date),
    });
    console.log(`  • announcements/${docId} (${a.title})`);
  }

  // --- summary -------------------------------------------------------------
  console.log('\nSeed complete.');
  console.log(`  Auth users:    ${USERS.length}`);
  console.log(`  Partner docs:  ${PARTNERS.length}`);
  console.log(`  Deals:         ${DEALS.length} (owner ${PARTNER_UID})`);
  console.log(`  Announcements: ${ANNOUNCEMENTS.length}`);
  console.log('\nDemo logins:');
  console.log('  partner@demo.test / demo1234  (Acme Solutions)');
  console.log('  admin@demo.test   / admin1234 (Portal Admin, admin)');

  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
