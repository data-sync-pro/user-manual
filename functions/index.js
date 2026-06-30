/**
 * Sync registered deals into Salesforce (live).
 *
 * Trigger: a new deals/{dealId} document is created in Firestore.
 * Action:  upsert a matching record into Salesforce (idempotent, keyed by the
 *          deal id via a Salesforce External Id field), authenticated with the
 *          OAuth 2.0 JWT Bearer flow, then write the Salesforce Id back onto the
 *          deal document.
 *
 * Config (functions/.env locally, Secret Manager in production):
 *   SF_LOGIN_URL          https://login.salesforce.com (prod/dev) | https://test.salesforce.com (sandbox)
 *   SF_CLIENT_ID          Connected App Consumer Key
 *   SF_USERNAME           integration user's username
 *   SF_PRIVATE_KEY_FILE   path (relative to functions/) to the PEM private key  — OR —
 *   SF_PRIVATE_KEY        the PEM private key contents (\n-escaped)
 *   SF_OBJECT             Lead | Opportunity | Deal_Registration__c   (default Lead)
 *   SF_EXTERNAL_ID_FIELD  external-id field API name (default Deal_Registration_Id__c)
 *   SF_API_VERSION        default v60.0
 */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: 'us-central1', maxInstances: 5 });

const SF_OBJECT = process.env.SF_OBJECT || 'Lead';
const SF_EXTERNAL_ID_FIELD = process.env.SF_EXTERNAL_ID_FIELD || 'Deal_Registration_Id__c';
const SF_API_VERSION = process.env.SF_API_VERSION || 'v60.0';
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

function getPrivateKey() {
  if (process.env.SF_PRIVATE_KEY_FILE) {
    return fs.readFileSync(path.resolve(__dirname, process.env.SF_PRIVATE_KEY_FILE), 'utf8');
  }
  if (process.env.SF_PRIVATE_KEY) return process.env.SF_PRIVATE_KEY.replace(/\\n/g, '\n');
  throw new Error('Missing private key — set SF_PRIVATE_KEY_FILE or SF_PRIVATE_KEY.');
}

function assertConfigured() {
  const missing = ['SF_CLIENT_ID', 'SF_USERNAME'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error('Salesforce not configured — missing: ' + missing.join(', '));
}

// The partner's Salesforce Account Id (partners/{uid}.salesforceAccountId), or
// null. Ties portal partners to a SF Account for PartnerAccount-scoped sync.
async function partnerAccountId(uid) {
  if (!uid) return null;
  const snap = await db.collection('partners').doc(uid).get();
  return (snap.exists && snap.get('salesforceAccountId')) || null;
}

// Trim a value to a text field's max length; '' / null -> undefined (omit field).
function clip(value, max) {
  const v = value == null ? '' : String(value).trim();
  if (!v) return undefined;
  return max ? v.slice(0, max) : v;
}

// Normalize a bare domain into a URL field value (Salesforce URL fields want a
// scheme); '' -> undefined.
function toUrl(domain) {
  const v = clip(domain, 255);
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// Split a full name into { first, last } (last = everything after the first token).
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Map a deal document -> DealRegistration__c fields (API names per the org's
// schema). The External Id field (SF_EXTERNAL_ID_FIELD) is NOT included here —
// it travels in the upsert URL, not the body. Lookup fields (Customer/Partner
// Account & Contact, Opportunity) and ExpirationDate are left unset.
function mapDealToSObject(deal, dealId) {
  const contact = deal.contact || {};
  const orgs = Array.isArray(deal.orgs) ? deal.orgs : [];
  // Customer Salesforce orgs serialized as a JSON array string for
  // RequestedLicenseInfo__c, e.g.
  // [{"name":"o1","connections":5,"executables":200,"daily_batch":"20k"}].
  const orgsJson = JSON.stringify(
    orgs.map((o) => ({
      name: o.name || '',
      connections: Number(o.connections) || 0,
      executables: Number(o.executables) || 0,
      // Drop the " records" suffix: '20k records' -> '20k', '1M records' -> '1M'.
      daily_batch: String(o.batch || '').replace(/\s*records$/i, '').trim(),
    })),
  );
  // Prefer the explicit first/last fields; fall back to splitting a combined
  // name for legacy deals registered before the form captured them separately.
  const fallback = splitName(contact.name);
  const first = contact.firstName || fallback.first;
  const last = contact.lastName || fallback.last;

  return {
    Name: clip(deal.customer || dealId, 80), // "Deal Registration Name" (record label)
    Amount__c: deal.arr != null ? Number(deal.arr) : undefined,
    CustomerCompanyName__c: clip(deal.customer, 50),
    CustomerWebsite__c: toUrl(deal.domain),
    CustomerContactFirstName__c: clip(first, 20),
    CustomerContactLastName__c: clip(last, 20),
    CustomerContactTitle__c: clip(contact.title, 20),
    CustomerContactEmail__c: clip(contact.email, 80),
    // Dedicated fields (all Text(20)) — formerly crammed into RequestedLicenseInfo__c.
    Stage__c: clip(deal.stage, 20),
    CustomerCountry__c: clip(deal.hqCountry, 20),
    industry__c: clip(deal.industry, 20), // API name is lowercase in this org
    CustomerCompanySize__c: clip(deal.companySize, 20),
    CustomerOrgType__c: clip(deal.orgType, 20),
    Track__c: clip(deal.track), // picklist — value must exist (Solution / Referral)
    Status__c: clip(deal.status), // picklist — value must exist (pending/accepted/won/lost)
    // Customer Salesforce orgs as a JSON array string (parseable downstream).
    RequestedLicenseInfo__c: clip(orgsJson, 32768),
  };
}

// OAuth 2.0 JWT Bearer -> { access_token, instance_url }.
async function getAccessToken() {
  const jwt = require('jsonwebtoken');
  const assertion = jwt.sign(
    {
      iss: process.env.SF_CLIENT_ID, // Connected App Consumer Key
      sub: process.env.SF_USERNAME, // integration user
      aud: SF_LOGIN_URL, // login.salesforce.com (prod) / test.salesforce.com (sandbox)
      exp: Math.floor(Date.now() / 1000) + 180,
    },
    getPrivateKey(),
    { algorithm: 'RS256' },
  );

  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Salesforce token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Idempotent upsert by External Id: PATCH .../sobjects/<Object>/<ExternalIdField>/<dealId>.
async function upsertSalesforce(sobject, dealId) {
  const { access_token, instance_url } = await getAccessToken();
  const url = `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${SF_OBJECT}/${SF_EXTERNAL_ID_FIELD}/${encodeURIComponent(dealId)}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sobject),
  });
  if (res.status === 200 || res.status === 201) {
    const data = await res.json(); // { id, success, created }
    return { id: data.id, created: !!data.created };
  }
  if (res.status === 204) return { id: dealId, created: false }; // updated, no body
  throw new Error(`Salesforce upsert failed: ${res.status} ${await res.text()}`);
}

exports.syncDealToSalesforce = onDocumentCreated('deals/{dealId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const dealId = event.params.dealId;
  const deal = snap.data() || {};

  // Idempotency guard: never sync the same deal twice.
  if (deal.salesforceId) {
    logger.info(`deal ${dealId} already synced (${deal.salesforceId}) — skipping`);
    return;
  }

  try {
    assertConfigured();
    const sobject = mapDealToSObject(deal, dealId);
    // Attribute the deal to the partner's Salesforce Account so the
    // PartnerAccount-scoped reverse mirror can find it.
    const accountId = await partnerAccountId(deal.ownerUid);
    if (accountId) sobject.PartnerAccount__c = accountId;
    const result = await upsertSalesforce(sobject, dealId);
    await snap.ref.update({
      salesforceId: result.id,
      salesforceObject: SF_OBJECT,
      salesforceSyncedAt: FieldValue.serverTimestamp(),
      salesforceSyncError: FieldValue.delete(),
    });
    logger.info(`Synced deal ${dealId} -> ${SF_OBJECT} ${result.id}`);
  } catch (err) {
    logger.error(`Salesforce sync failed for deal ${dealId}: ${err.message}`);
    await snap.ref.update({ salesforceSyncError: err.message });
    throw err; // let Functions retry (if enabled)
  }
});

/* ============================ REVERSE SYNC ============================ */
/* Pull Salesforce-side edits (status, amount, …) back onto the deal docs.
 * Triggered by the dashboard on load; throttled per user so a rapid refresh
 * doesn't hammer Salesforce. The forward sync is onCreate only, so writing
 * these updates never re-triggers it (no loop). */

const PULL_THROTTLE_MS = 5 * 60 * 1000; // once per 5 minutes per user
const DEAL_STATUSES = ['pending', 'accepted', 'won', 'lost'];
const SF_PULL_FIELDS = [
  'Id', SF_EXTERNAL_ID_FIELD, 'Status__c', 'Amount__c', 'Track__c', 'Stage__c',
  'CustomerCompanyName__c', 'CustomerWebsite__c',
  'CustomerContactFirstName__c', 'CustomerContactLastName__c',
  'CustomerContactTitle__c', 'CustomerContactEmail__c',
  'CustomerCountry__c', 'industry__c', 'CustomerCompanySize__c', 'CustomerOrgType__c',
  'CreatedDate', 'LastModifiedDate',
];

const stripProto = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

// SF record -> a deal document (Salesforce is the source of truth). Used with
// set({merge:true}) so it CREATES the deal if missing and updates it otherwise,
// without clobbering portal-only fields it doesn't carry. `docId` is the
// resolved Firestore key — our external id when present, else the SF record Id
// (for deals created directly in Salesforce that don't carry a SourceSystemID).
function mapSObjectToDealDoc(r, uid, docId) {
  const doc = {
    id: docId || r[SF_EXTERNAL_ID_FIELD] || r.Id,
    ownerUid: uid,
    salesforceId: r.Id,
    salesforceLastModified: r.LastModifiedDate || null,
    salesforceSyncedFromAt: FieldValue.serverTimestamp(),
  };
  const status = String(r.Status__c || '').toLowerCase();
  if (DEAL_STATUSES.includes(status)) doc.status = status;
  if (r.Amount__c != null) doc.arr = Number(r.Amount__c);
  if (r.Track__c) doc.track = r.Track__c;
  if (r.Stage__c) doc.stage = r.Stage__c;
  if (r.CustomerCompanyName__c) doc.customer = r.CustomerCompanyName__c;
  if (r.CustomerWebsite__c) doc.domain = stripProto(r.CustomerWebsite__c);
  if (r.CustomerCountry__c) doc.hqCountry = r.CustomerCountry__c;
  if (r.industry__c) doc.industry = r.industry__c;
  if (r.CustomerCompanySize__c) doc.companySize = r.CustomerCompanySize__c;
  if (r.CustomerOrgType__c) doc.orgType = r.CustomerOrgType__c;

  const contact = {};
  if (r.CustomerContactFirstName__c) contact.firstName = r.CustomerContactFirstName__c;
  if (r.CustomerContactLastName__c) contact.lastName = r.CustomerContactLastName__c;
  if (r.CustomerContactFirstName__c || r.CustomerContactLastName__c) {
    contact.name = [r.CustomerContactFirstName__c, r.CustomerContactLastName__c].filter(Boolean).join(' ');
  }
  if (r.CustomerContactTitle__c) contact.title = r.CustomerContactTitle__c;
  if (r.CustomerContactEmail__c) contact.email = r.CustomerContactEmail__c;
  if (Object.keys(contact).length) doc.contact = contact;

  // submittedAt drives the dashboard's ordered query — seed it from SF CreatedDate
  // so deals created in Salesforce still show up after the mirror.
  if (r.CreatedDate) doc.submittedAt = Timestamp.fromDate(new Date(r.CreatedDate));
  return doc;
}

async function querySalesforce(soql) {
  const { access_token, instance_url } = await getAccessToken();
  const res = await fetch(`${instance_url}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) throw new Error(`Salesforce query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Callable: mirror this partner's Salesforce deals into Firestore (Salesforce is
// the source of truth). Scoped by PartnerAccount__c = the partner's SF Account;
// upsert-creates deals that exist in Salesforce but not yet locally. Throttled to
// once per PULL_THROTTLE_MS per user — the dashboard calls it on load.
exports.refreshFromSalesforce = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  // An explicit "Refresh from Salesforce" click bypasses the auto-throttle; the
  // automatic on-load pull does not (force omitted).
  const force = !!(request.data && request.data.force);

  // Throttle on the last SUCCESSFUL pull for this user.
  const metaRef = db.collection('syncMeta').doc(uid);
  const meta = await metaRef.get();
  const lastPull = meta.exists && meta.get('lastPullAt') ? meta.get('lastPullAt').toMillis() : 0;
  const since = Date.now() - lastPull;
  if (!force && since < PULL_THROTTLE_MS) {
    return { skipped: true, reason: 'throttled', nextInMs: PULL_THROTTLE_MS - since };
  }

  try {
    assertConfigured();
  } catch (e) {
    throw new HttpsError('failed-precondition', e.message);
  }

  const accountId = await partnerAccountId(uid);
  if (!accountId) {
    await metaRef.set({ lastPullAt: FieldValue.serverTimestamp() }, { merge: true });
    return { updated: 0, count: 0, reason: 'no-account' };
  }

  let updated = 0;
  try {
    // Mirror every deal linked to this partner's SF Account. Deals created
    // directly in Salesforce may not carry our external id (SourceSystemID) yet,
    // so we DON'T require it here — those key on the SF record Id below.
    const soql =
      `SELECT ${SF_PULL_FIELDS.join(', ')} FROM ${SF_OBJECT} ` +
      `WHERE PartnerAccount__c = '${String(accountId).replace(/'/g, "\\'")}'`;
    const data = await querySalesforce(soql); // up to 2000 rows/page; demo scale
    const batch = db.batch();
    let n = 0;
    for (const r of data.records || []) {
      // Prefer our external id; fall back to the SF record Id for Salesforce-
      // originated deals. Using a stable per-record key keeps repeat pulls
      // idempotent (set+merge overwrites the same doc, never duplicates it).
      const docId = r[SF_EXTERNAL_ID_FIELD] || r.Id;
      if (!docId) continue;
      batch.set(db.collection('deals').doc(docId), mapSObjectToDealDoc(r, uid, docId), { merge: true });
      n++;
    }
    if (n) await batch.commit();
    updated = n;
  } catch (err) {
    logger.error(`refreshFromSalesforce failed for ${uid}: ${err.message}`);
    throw new HttpsError('internal', err.message);
  }

  await metaRef.set({ lastPullAt: FieldValue.serverTimestamp() }, { merge: true });
  logger.info(`refreshFromSalesforce: mirrored ${updated} deal(s) for ${uid} (account ${accountId})`);
  return { updated, count: updated };
});
