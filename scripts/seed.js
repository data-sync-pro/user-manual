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
    arr: 1200000, stage: 'Closed Won', status: 'won', submitted: '2025-11-12', paid: '2025-12-01',
    industry: 'Financial Services', orgType: 'Commercial', companySize: '10k+',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Adrian Cole', title: 'VP Data Engineering', email: 'adrian.cole@meridianglobal.com', phone: '+1-212-555-0198' },
  },
  {
    id: 'DR-2026-0188', customer: 'Northwind Logistics', domain: 'northwind.com',
    arr: 145000, stage: 'Negotiation', status: 'pending', submitted: '2026-06-02', track: 'Referral',
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
    arr: 78000, stage: 'Discovery', status: 'accepted', submitted: '2026-04-28', track: 'Referral',
    industry: 'Retail', orgType: 'Commercial', companySize: '500-1k',
    hqCountry: 'Canada', products: ['Data Sync Pro'],
    contact: { name: 'Sofia Marino', title: 'Operations Manager', email: 'sofia.marino@cedarretail.com', phone: '+1-416-555-0162' },
  },
  {
    id: 'DR-2026-0140', customer: 'Aurora Media', domain: 'auroramedia.tv',
    arr: 168000, stage: 'Closed Won', status: 'won', submitted: '2026-03-14', paid: '2026-04-02',
    industry: 'Media & Entertainment', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Theo Lambert', title: 'SVP Engineering', email: 'theo.lambert@auroramedia.tv', phone: '+1-323-555-0140' },
  },
  {
    id: 'DR-2026-0131', customer: 'Pinecrest Education', domain: 'pinecrest.edu',
    arr: 54000, stage: 'Closed Won', status: 'won', submitted: '2026-02-22', paid: '2026-02-28',
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

  // --- additional partner deals (20) — mixed status / track; won deals carry a paid date ---
  {
    id: 'DR-2025-0205', customer: 'Brightwave Telecom', domain: 'brightwave.com',
    arr: 240000, stage: 'Closed Won', status: 'won', submitted: '2025-09-18', paid: '2025-10-05', track: 'Solution',
    industry: 'Telecommunications', orgType: 'Commercial', companySize: '5k-10k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Lena Hoffmann', title: 'VP Network Engineering', email: 'lena.hoffmann@brightwave.com', phone: '+1-206-555-0205' },
  },
  {
    id: 'DR-2025-0212', customer: 'Summit Insurance', domain: 'summitins.com',
    arr: 175000, stage: 'Closed Won', status: 'won', submitted: '2025-10-02', paid: '2025-10-28', track: 'Referral',
    industry: 'Insurance', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Raymond Diaz', title: 'Director of Data', email: 'raymond.diaz@summitins.com', phone: '+1-480-555-0212' },
  },
  {
    id: 'DR-2025-0224', customer: 'Lakeside Biotech', domain: 'lakesidebio.com',
    arr: 410000, stage: 'Closed Won', status: 'won', submitted: '2025-10-21', paid: '2025-11-15', track: 'Solution',
    industry: 'Life Sciences', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Health Cloud Recipes'],
    contact: { name: 'Sandra Kim', title: 'Head of Research IT', email: 'sandra.kim@lakesidebio.com', phone: '+1-617-555-0224' },
  },
  {
    id: 'DR-2025-0231', customer: 'Granite Construction Co.', domain: 'graniteco.com',
    arr: 88000, stage: 'Closed Lost', status: 'lost', submitted: '2025-11-04', track: 'Solution',
    industry: 'Construction', orgType: 'Commercial', companySize: '500-1k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Owen Park', title: 'IT Manager', email: 'owen.park@graniteco.com', phone: '+1-303-555-0231' },
  },
  {
    id: 'DR-2025-0240', customer: 'Ironclad Security', domain: 'ironcladsec.io',
    arr: 132000, stage: 'Closed Won', status: 'won', submitted: '2025-11-19', paid: '2025-12-10', track: 'Referral',
    industry: 'Cybersecurity', orgType: 'Commercial', companySize: '250-500',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Maya Fischer', title: 'CISO', email: 'maya.fischer@ironcladsec.io', phone: '+1-415-555-0240' },
  },
  {
    id: 'DR-2025-0255', customer: 'Verdant Agriculture', domain: 'verdantag.com',
    arr: 67000, stage: 'Negotiation', status: 'accepted', submitted: '2025-12-08', track: 'Solution',
    industry: 'Agriculture', orgType: 'Commercial', companySize: '500-1k',
    hqCountry: 'Canada', products: ['Data Sync Pro'],
    contact: { name: 'Caleb Stone', title: 'Operations Director', email: 'caleb.stone@verdantag.com', phone: '+1-204-555-0255' },
  },
  {
    id: 'DR-2026-0205', customer: 'Coastal Freight', domain: 'coastalfreight.com',
    arr: 153000, stage: 'Closed Won', status: 'won', submitted: '2026-01-09', paid: '2026-02-02', track: 'Solution',
    industry: 'Logistics & Supply Chain', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Dana Brooks', title: 'VP Logistics', email: 'dana.brooks@coastalfreight.com', phone: '+1-904-555-0205' },
  },
  {
    id: 'DR-2026-0212', customer: 'Apex Robotics', domain: 'apexrobotics.ai',
    arr: 295000, stage: 'Proposal', status: 'accepted', submitted: '2026-01-22', track: 'Solution',
    industry: 'Robotics', orgType: 'Commercial', companySize: '250-500',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Victor Reyes', title: 'Head of Platform', email: 'victor.reyes@apexrobotics.ai', phone: '+1-650-555-0212' },
  },
  {
    id: 'DR-2026-0219', customer: 'Maple Financial Group', domain: 'maplefin.ca',
    arr: 380000, stage: 'Closed Won', status: 'won', submitted: '2026-02-05', paid: '2026-03-01', track: 'Referral',
    industry: 'Financial Services', orgType: 'Commercial', companySize: '10k+',
    hqCountry: 'Canada', products: ['Data Sync Pro', 'FSC Recipes'],
    contact: { name: 'Isabelle Tremblay', title: 'Head of Data Platform', email: 'isabelle.tremblay@maplefin.ca', phone: '+1-514-555-0219' },
  },
  {
    id: 'DR-2026-0226', customer: 'Solaris Energy', domain: 'solarisenergy.com',
    arr: 220000, stage: 'Negotiation', status: 'accepted', submitted: '2026-02-18', track: 'Solution',
    industry: 'Energy & Utilities', orgType: 'Commercial', companySize: '5k-10k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Nathan Cole', title: 'Director of IT', email: 'nathan.cole@solarisenergy.com', phone: '+1-602-555-0226' },
  },
  {
    id: 'DR-2026-0233', customer: 'Harborview Hospital', domain: 'harborview.org',
    arr: 145000, stage: 'Qualification', status: 'pending', submitted: '2026-03-03', track: 'Referral',
    industry: 'Healthcare', orgType: 'Nonprofit', companySize: '5k-10k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Health Cloud Recipes'],
    contact: { name: 'Grace Liu', title: 'CIO', email: 'grace.liu@harborview.org', phone: '+1-206-555-0233' },
  },
  {
    id: 'DR-2026-0240', customer: 'Quantum Analytics', domain: 'quantumanalytics.io',
    arr: 510000, stage: 'Closed Won', status: 'won', submitted: '2026-03-16', paid: '2026-04-10', track: 'Solution',
    industry: 'Analytics', orgType: 'Commercial', companySize: '250-500',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Elliot Vance', title: 'VP Data Engineering', email: 'elliot.vance@quantumanalytics.io', phone: '+1-415-555-0240' },
  },
  {
    id: 'DR-2026-0247', customer: 'Pioneer Manufacturing', domain: 'pioneermfg.com',
    arr: 98000, stage: 'Discovery', status: 'pending', submitted: '2026-03-29', track: 'Solution',
    industry: 'Manufacturing', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Holly Bennett', title: 'IT Lead', email: 'holly.bennett@pioneermfg.com', phone: '+1-313-555-0247' },
  },
  {
    id: 'DR-2026-0254', customer: 'Crestline Retail', domain: 'crestline.com',
    arr: 76000, stage: 'Closed Lost', status: 'lost', submitted: '2026-04-11', track: 'Referral',
    industry: 'Retail', orgType: 'Commercial', companySize: '500-1k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Seth Morgan', title: 'Operations Manager', email: 'seth.morgan@crestline.com', phone: '+1-214-555-0254' },
  },
  {
    id: 'DR-2026-0261', customer: 'Nimbus Cloud Services', domain: 'nimbuscloud.io',
    arr: 264000, stage: 'Proposal', status: 'accepted', submitted: '2026-04-24', track: 'Solution',
    industry: 'SaaS & Software', orgType: 'Commercial', companySize: '250-500',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Aria Patel', title: 'VP Engineering', email: 'aria.patel@nimbuscloud.io', phone: '+1-408-555-0261' },
  },
  {
    id: 'DR-2026-0268', customer: 'Atlas Logistics', domain: 'atlaslog.com',
    arr: 119000, stage: 'Closed Won', status: 'won', submitted: '2026-05-01', paid: '2026-05-22', track: 'Solution',
    industry: 'Logistics & Supply Chain', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Marco Bianchi', title: 'Head of Operations', email: 'marco.bianchi@atlaslog.com', phone: '+1-312-555-0268' },
  },
  {
    id: 'DR-2026-0275', customer: 'Beacon Education', domain: 'beacon.edu',
    arr: 52000, stage: 'Qualification', status: 'pending', submitted: '2026-05-12', track: 'Referral',
    industry: 'Education', orgType: 'Education', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro'],
    contact: { name: 'Tara Nguyen', title: 'Director of Information Systems', email: 'tara.nguyen@beacon.edu', phone: '+1-512-555-0275' },
  },
  {
    id: 'DR-2026-0282', customer: 'Titan Industrial', domain: 'titanind.com',
    arr: 340000, stage: 'Negotiation', status: 'accepted', submitted: '2026-05-20', track: 'Solution',
    industry: 'Industrial & Manufacturing', orgType: 'Commercial', companySize: '10k+',
    hqCountry: 'Germany', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Klaus Berger', title: 'Head of Data Platform', email: 'klaus.berger@titanind.com', phone: '+49-89-555-0282' },
  },
  {
    id: 'DR-2026-0289', customer: 'Riverstone Capital', domain: 'riverstonecap.com',
    arr: 187000, stage: 'Discovery', status: 'pending', submitted: '2026-06-03', track: 'Referral',
    industry: 'Financial Services', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'FSC Recipes'],
    contact: { name: 'Priscilla Adams', title: 'CTO', email: 'priscilla.adams@riverstonecap.com', phone: '+1-617-555-0289' },
  },
  {
    id: 'DR-2026-0296', customer: 'Evergreen Media', domain: 'evergreenmedia.tv',
    arr: 134000, stage: 'Proposal', status: 'accepted', submitted: '2026-06-12', track: 'Solution',
    industry: 'Media & Entertainment', orgType: 'Commercial', companySize: '1k-5k',
    hqCountry: 'United States', products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Jordan Wells', title: 'SVP Engineering', email: 'jordan.wells@evergreenmedia.tv', phone: '+1-323-555-0296' },
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
      track: d.track || 'Solution',
      products: d.products,
      contact: d.contact,
      hqCountry: d.hqCountry,
      industry: d.industry,
      companySize: d.companySize,
      orgType: d.orgType,
      engagement: 'Co-sell',
      origin: 'Partner sourced',
      submittedAt: dateToTimestamp(d.submitted),
      // Client payment date (won deals only) — drives the commission schedule.
      paidAt: d.paid ? dateToTimestamp(d.paid) : null,
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
