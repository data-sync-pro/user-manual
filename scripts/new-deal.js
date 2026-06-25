/**
 * scripts/new-deal.js — create ONE fresh deal in the Firestore emulator to fire
 * the syncDealToSalesforce Cloud Function (onCreate only triggers on new docs).
 *
 * Run (with the emulators up):  npm run new-deal
 */
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-partner-portal' });

const db = admin.firestore();
const { Timestamp } = admin.firestore;

async function main() {
  // Unique id per run so each run is a genuine create.
  const id = 'DR-2026-' + String(Date.now()).slice(-4);
  const deal = {
    id,
    ownerUid: 'partner-demo',
    customer: 'Demo Sync Corp',
    domain: 'demosync.com',
    arr: 222000,
    stage: 'Negotiation',
    status: 'pending',
    track: 'Solution',
    products: ['Data Sync Pro', 'Pipeline Connect'],
    contact: { name: 'Jamie Rivera', title: 'VP Data', email: 'jamie.rivera@demosync.com', phone: '+1-555-0100' },
    hqCountry: 'United States',
    industry: 'SaaS & Software',
    companySize: '1k-5k',
    orgType: 'Enterprise Edition',
    successPlan: 'Standard',
    orgs: [{ name: 'Demo Sync Production', connections: 2, executables: 300, batch: '1M records' }],
    engagement: 'Co-sell',
    origin: 'Partner sourced',
    submittedAt: Timestamp.now(),
  };

  await db.collection('deals').doc(id).set(deal);
  console.log(`Created deals/${id} (${deal.customer}) — the Cloud Function should now sync it to Salesforce.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
